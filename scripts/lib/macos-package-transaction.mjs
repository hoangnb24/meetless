import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireMasGateLock, assertMasGateMutationLease, masGateLockPath } from "./macos-mas-gate-lock.mjs";
import { assertMasGateArtifactBinding, freezeMasGateArtifactBinding } from "./mas-gate-artifact-binding.mjs";
import { assertMacOSPackageParent } from "./macos-package-parent-policy.mjs";

export const PACKAGE_TRANSACTION_SCHEMA = "MAS_PACKAGE_TRANSACTION v4";
export const PACKAGE_TRANSACTION_VERSION = 4;
export const PACKAGE_TRANSACTION_RECOVERABLE_STATES = Object.freeze([
  "prepared",
  "staged",
  "target-backed-up",
  "candidate-installed",
  "identity-published",
  "committed",
  "restoring",
  "target-displaced",
  "target-restored",
  "target-removed",
  "identity-restored",
]);

export function newPackageTransactionId() {
  return `${Date.now()}-${process.pid}-${randomUUID().slice(0, 12)}`;
}

export function packageTransactionPaths(target, runId) {
  const parent = path.dirname(target);
  return {
    staging: path.join(parent, `.Meetless.app.m7.${runId}.installing`),
    backup: path.join(parent, `.Meetless.app.m7.${runId}.backup`),
    displaced: path.join(parent, `.Meetless.app.m7.${runId}.displaced`),
    journal: path.join(parent, `.Meetless.app.m7.${runId}.transaction.json`),
  };
}

async function withPackageMutationLease(input, options, operation) {
  const target = input?.target ?? options?.target;
  const supplied = input?.lockLease ?? options?.lockLease;
  if (!target || typeof target !== "string") throw new Error("package mutation requires one canonical target before acquiring its lock");
  assertCanonicalPackagePath(target, "package mutation target");
  const lockParentPath = options?.lockParentPath ?? path.dirname(target);
  assertCanonicalPackagePath(lockParentPath, "package mutation lock parent");
  const packageParentPath = path.dirname(target);
  await assertMacOSPackageParent(packageParentPath);
  const expectedLockPath = masGateLockPath(lockParentPath);
  if (supplied) {
    assertMasGateMutationLease(supplied);
    if (supplied.lockPath !== expectedLockPath) {
      throw new Error("package mutation supplied a native mutation-session lease for a different lock parent");
    }
    if (supplied.packageParentPath !== packageParentPath) {
      throw new Error("package mutation supplied a native mutation-session lease for a different package parent");
    }
    await supplied.assertHeld();
    return operation(supplied);
  }
  const lease = await acquireMasGateLock({
    parentPath: lockParentPath,
    packageParentPath,
  });
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

export async function replacePackageBundle(input) {
  return withPackageMutationLease(input, input, (lockLease) => replacePackageBundleWithLease({ ...input, lockLease }));
}

async function replacePackageBundleWithLease(input) {
  const { source, target, identityPath, ownerToken, runId, inspect, faultAt } = input;
  assertRequiredInput({ source, target, identityPath, ownerToken, runId, inspect });
  assertCanonicalPackagePath(source, "package source");
  assertCanonicalPackagePath(target, "package target");
  assertCanonicalPackagePath(identityPath, "package identity path");
  const runtimeRootPath = runtimeRootPathFor(input);
  await input.lockLease.bindRuntimeRoot(runtimeRootPath);
  const artifactBinding = input.artifactBinding ? freezeMasGateArtifactBinding(input.artifactBinding) : null;
  if (artifactBinding) {
    assertMasGateArtifactBinding(artifactBinding, { bundlePath: source });
    await assertArtifactBindingCurrent(artifactBinding, source);
  }
  const paths = packageTransactionPaths(target, runId);
  const identityTemporaryPath = packageIdentityTemporaryPath(identityPath, runId);
  for (const candidate of Object.values(paths)) {
    if (await exists(candidate)) throw new Error(`package transaction path already exists: ${candidate}`);
  }
  if (await exists(identityTemporaryPath)) {
    throw new Error(`package transaction identity temporary path already exists: ${identityTemporaryPath}`);
  }
  const sourceFingerprint = await fingerprintPath(source);
  if (!sourceFingerprint) throw new Error(`package transaction source is missing: ${source}`);
  await assertMacOSPackageParent(path.dirname(target));
  if (artifactBinding && sourceFingerprint !== artifactBinding.bundleFingerprint) {
    throw new Error("package transaction source fingerprint differs from the validated MAS artifact binding");
  }
  const previousTargetFingerprint = await fingerprintPath(target);
  const previousTargetIdentity = await packagePathIdentity(target);
  const previous = {
    targetExists: previousTargetIdentity !== null,
    targetFingerprint: previousTargetFingerprint,
    targetIdentity: previousTargetIdentity,
    identityBytes: await readBytes(identityPath),
  };
  if (previous.targetExists !== Boolean(previous.targetFingerprint)) {
    throw new Error(`package transaction target existence changed while it was inspected: ${target}`);
  }
  if (artifactBinding && previous.identityBytes !== null) {
    throw new Error("MAS package identity appeared in the fresh runtime before installation; refusing to replace it");
  }
  const transaction = {
    schema: PACKAGE_TRANSACTION_SCHEMA,
    version: PACKAGE_TRANSACTION_VERSION,
    ownerToken,
    runId,
    source,
    target,
    identityPath,
    paths,
    previous,
    sourceFingerprint,
    candidateFingerprint: sourceFingerprint,
    stagingIdentity: null,
    candidateIdentity: null,
    backupIdentity: null,
    identityPublishedIdentity: null,
    artifactBinding,
    cleanupPath: null,
    cleanupSource: null,
    cleanupFingerprint: null,
    cleanupIdentity: null,
    identityTemporaryPath: null,
    identityTemporaryFingerprint: null,
    identityTemporaryIdentity: null,
    state: "prepared",
  };
  await writeJournal(transaction);
  if (faultAt === "prepared") throw new Error("injected package transaction interruption at prepared");

  await assertArtifactBindingStillCurrent(artifactBinding, source);
  await cp(source, paths.staging, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  const stagedFingerprint = await fingerprintPath(paths.staging);
  if (stagedFingerprint !== sourceFingerprint) {
    throw new Error("package staging fingerprint differs from the source snapshot; recovery will fail closed");
  }
  transaction.stagingIdentity = await packagePathIdentity(paths.staging);
  if (!transaction.stagingIdentity) {
    throw new Error("package staging root disappeared before its identity was journaled; recovery will fail closed");
  }
  transaction.stagingFingerprint = stagedFingerprint;
  await inspectStagedPackage(inspect, paths.staging);
  await transition(transaction, "staged", faultAt);

  await assertArtifactBindingStillCurrent(artifactBinding, source);
  if (await fingerprintPath(target) !== previous.targetFingerprint) {
    throw new Error("package transaction target changed after its prior snapshot; refusing to move the existing app");
  }
  if (previous.targetExists) {
    await assertOwnedPath(target, previous.targetFingerprint, "prior package target", previous.targetIdentity);
    await assertArtifactBindingStillCurrent(artifactBinding, source);
    await input.beforeRename?.({
      label: "package prior-target backup rename",
      source: target,
      destination: paths.backup,
    });
    await input.lockLease.renameNoReplace(target, paths.backup, {
      pathClass: "package-sibling",
      authorizedParentPath: path.dirname(target),
      onMutationApplied: (message) => input.afterRenameSyscall?.({
        label: "package prior-target backup rename",
        source: target,
        destination: paths.backup,
        message,
      }),
    });
    transaction.backupFingerprint = await fingerprintPath(paths.backup);
    if (transaction.backupFingerprint !== previous.targetFingerprint) {
      throw new Error("package backup fingerprint differs from the prior target; recovery will fail closed");
    }
    transaction.backupIdentity = await packagePathIdentity(paths.backup);
    if (!samePackageIdentity(transaction.backupIdentity, previous.targetIdentity)) {
      throw new Error("package backup identity differs from the prior target; recovery will fail closed");
    }
  }
  await transition(transaction, "target-backed-up", faultAt);

  await assertArtifactBindingStillCurrent(artifactBinding, source);
  await input.beforeRename?.({
    label: "package staging install rename",
    source: paths.staging,
    destination: target,
  });
  await input.lockLease.renameNoReplace(paths.staging, target, {
    pathClass: "package-sibling",
    authorizedParentPath: path.dirname(target),
    onMutationApplied: (message) => input.afterRenameSyscall?.({
      label: "package staging install rename",
      source: paths.staging,
      destination: target,
      message,
    }),
  });
  const candidateFingerprint = await fingerprintPath(target);
  if (candidateFingerprint !== transaction.stagingFingerprint) {
    throw new Error("installed package fingerprint differs from the source snapshot; recovery will fail closed");
  }
  transaction.candidateIdentity = await packagePathIdentity(target);
  if (!samePackageIdentity(transaction.candidateIdentity, transaction.stagingIdentity)) {
    throw new Error("installed package identity differs from validated staging; recovery will fail closed");
  }
  transaction.candidateFingerprint = candidateFingerprint;
  await transition(transaction, "candidate-installed", faultAt);

  const inspected = await inspect(target);
  if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)) {
    throw new Error("installed package validation did not return one plain identity");
  }
  transaction.nextIdentityBytes = serializeSortedJson(inspected);
  transaction.nextIdentityFingerprint = digest(transaction.nextIdentityBytes);
  if (artifactBinding && previous.identityBytes === null) {
    transaction.identityTemporaryPath = identityTemporaryPath;
    transaction.identityTemporaryFingerprint = fingerprintFileBytes(transaction.nextIdentityBytes);
    await writeJournal(transaction);
    await writeBytesAtomic(identityPath, transaction.nextIdentityBytes, {
      lease: input.lockLease,
      noReplace: true,
      temporaryPath: identityTemporaryPath,
      retainTemporaryOnError: true,
      onTemporaryReady: async (temporary) => {
        if (await fingerprintPath(temporary) !== transaction.identityTemporaryFingerprint) {
          throw new Error("package identity temporary fingerprint differs from the journaled construction intent");
        }
        transaction.identityTemporaryIdentity = await packagePathIdentity(temporary);
        if (!transaction.identityTemporaryIdentity) {
          throw new Error("package identity temporary disappeared before publication");
        }
        await writeJournal(transaction);
      },
      onMutationApplied: (message) => input.afterRenameSyscall?.({
        label: "package identity publication rename",
        source: identityTemporaryPath,
        destination: identityPath,
        message,
      }),
      beforeMutation: () => input.beforeRename?.({
        label: "package identity publication rename",
        source: identityTemporaryPath,
        destination: identityPath,
      }),
      pathClass: "runtime-child",
      authorizedRootPath: runtimeRootPath,
    });
    const publishedIdentity = await packagePathIdentity(identityPath);
    if (!samePackageIdentity(publishedIdentity, transaction.identityTemporaryIdentity)) {
      throw new Error("published package identity differs from the transaction-owned temporary identity; recovery will fail closed");
    }
    transaction.identityPublishedIdentity = publishedIdentity;
    transaction.identityTemporaryPath = null;
    transaction.identityTemporaryFingerprint = null;
    transaction.identityTemporaryIdentity = null;
  } else {
    await writeJournal(transaction);
    await writeBytesAtomic(identityPath, transaction.nextIdentityBytes, { lease: input.lockLease, noReplace: false });
  }
  await transition(transaction, "identity-published", faultAt);
  await transition(transaction, "committed", faultAt);
  return transaction;
}

export async function recoverPackageTransaction(transactionOrJournal, options = {}) {
  let transaction = await loadTransaction(transactionOrJournal);
  assertTransaction(transaction, options);
  if (options.requireRecoveryProof === true) {
    transaction = await requireAuthorizedRecoveryTransaction(transaction, options);
  }
  return withPackageMutationLease(transaction, options, async (lockLease) => {
    const lockedOptions = { ...options, lockLease };
    await preparePackageMutationLease(transaction, lockedOptions, lockLease);
    if (lockedOptions.requireRecoveryProof === true) {
      transaction = await requireAuthorizedRecoveryTransaction(transaction, lockedOptions);
    }
    if (transaction.state === "finalizing" || transaction.state === "finalized") {
      await finishFinalization(transaction, lockedOptions);
    } else {
      await restoreToPrevious(transaction, lockedOptions);
    }
    return transaction.previous;
  });
}

export async function restorePackageTransaction(transaction, options = {}) {
  assertTransaction(transaction, options);
  if (options.requireRecoveryProof === true) {
    transaction = await requireAuthorizedRecoveryTransaction(transaction, options);
  }
  return withPackageMutationLease(transaction, options, async (lockLease) => {
    const lockedOptions = { ...options, lockLease };
    await preparePackageMutationLease(transaction, lockedOptions, lockLease);
    if (lockedOptions.requireRecoveryProof === true) {
      transaction = await requireAuthorizedRecoveryTransaction(transaction, lockedOptions);
    }
    if (!PACKAGE_TRANSACTION_RECOVERABLE_STATES.includes(transaction.state)) {
      throw new Error(`cannot restore a package transaction in state ${transaction.state}`);
    }
    await restoreToPrevious(transaction, lockedOptions);
    return transaction;
  });
}

export async function finalizePackageTransaction(transaction, options = {}) {
  assertTransaction(transaction, options);
  return withPackageMutationLease(transaction, options, async (lockLease) => {
    const lockedOptions = { ...options, lockLease };
    await preparePackageMutationLease(transaction, lockedOptions, lockLease);
    if (transaction.state !== "committed" && transaction.state !== "finalizing" && transaction.state !== "finalized") {
      throw new Error(`cannot finalize a package transaction in state ${transaction.state}`);
    }
    if (transaction.state === "committed") {
      await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package", transaction.candidateIdentity);
      await assertIdentityState(transaction, transaction.nextIdentityFingerprint);
      await transition(transaction, "finalizing", lockedOptions.faultAt);
    }
    await finishFinalization(transaction, lockedOptions);
    return transaction;
  });
}

async function preparePackageMutationLease(transaction, options, lockLease) {
  // withPackageMutationLease has already acquired and validated this exact
  // package lease. Prove host absence before the native helper opens its
  // runtime-root descriptor, then reassert the lease immediately afterward.
  if (options.assertNoLiveHost) await options.assertNoLiveHost();
  await lockLease.bindRuntimeRoot(runtimeRootPathFor(transaction, options));
  await lockLease.assertHeld();
}

export async function fingerprintPath(root) {
  if (!(await exists(root))) return null;
  const entries = [];
  await fingerprintVisit(root, root, entries);
  return digest(Buffer.from(JSON.stringify(entries.sort((left, right) => left.relative.localeCompare(right.relative)))));
}

export async function readBytes(candidate) {
  return readFile(candidate).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Prove the one committed MAS package identity that a coordinator may
 * authorize after the runtime transaction has crossed its fresh-root write
 * boundary. This is deliberately read-only: the package journal and the
 * published identity are the only authority consulted here, and every path is
 * derived from the exact package target and runtime run ID.
 */
export async function readPackageTransactionProof(options = {}) {
  const record = await readPackageTransactionRecord(options);
  if (record.status === "absent") return record;
  const identity = await assertAuthorizedPublishedIdentity(record.transaction, {
    expectedArtifactBinding: options.expectedArtifactBinding,
    runtimeRootPath: record.physicalRuntimeRootPath,
  });
  return packageProofResult(record, {
    status: "committed",
    currentIdentityBytes: identity.bytes,
    currentIdentityFingerprint: identity.digest,
    currentIdentity: identity.metadata,
    publishedHostIdentity: identity.document,
  });
}

/**
 * Prove that the fixed package journal describes one known, physically
 * recoverable interruption. Unlike the launch proof this accepts the package
 * rollback states, but it still binds the exact owner, run, target, identity,
 * artifact, and on-disk state before a caller can request mutation.
 */
export async function readPackageRecoveryProof(options = {}) {
  const record = await readPackageTransactionRecord(options);
  if (record.status === "absent") return record;
  const physicalState = await assertAuthorizedRecoverablePackageState(record.transaction, {
    expectedArtifactBinding: options.expectedArtifactBinding,
    runtimeRootPath: record.physicalRuntimeRootPath,
  });
  return packageProofResult(record, {
    status: "recoverable",
    state: record.transaction.state,
    currentIdentityBytes: physicalState.identityBytes,
    currentIdentityFingerprint: physicalState.identityFingerprint,
    currentIdentity: physicalState.identity,
    publishedHostIdentity: physicalState.identityDocument,
  });
}

async function readPackageTransactionRecord({
  target,
  identityPath,
  runId,
  ownerToken,
  runtimeRootPath,
  journalPath,
  allowMissing = false,
  filesystem,
} = {}) {
  assertCanonicalPackagePath(target, "package proof target");
  assertCanonicalPackagePath(identityPath, "package proof identity path");
  assertCanonicalPackagePath(runtimeRootPath, "package proof runtime root");
  if (typeof runId !== "string" || !/^[-A-Za-z0-9]+$/u.test(runId)) {
    throw new Error("package proof run ID is invalid");
  }
  if (typeof ownerToken !== "string" || !ownerToken) {
    throw new Error("package proof owner token is required");
  }
  if (typeof allowMissing !== "boolean") throw new Error("package proof allowMissing must be boolean");
  const adapter = normalizePackageFilesystem(filesystem);
  const logicalPaths = packageTransactionPaths(target, runId);
  if (journalPath !== undefined) {
    assertCanonicalPackagePath(journalPath, "package proof journal path");
    if (journalPath !== logicalPaths.journal) throw new Error("package proof journal path is not the fixed target/run-derived package journal");
  }
  const physicalTarget = resolvePackagePath(adapter, target, "package proof target");
  const physicalTargetParent = resolvePackagePath(adapter, path.dirname(target), "package proof package parent");
  if (physicalTargetParent !== path.dirname(physicalTarget)) {
    throw new Error("package proof filesystem mapping changed the fixed package target parent");
  }
  const physicalIdentityPath = resolvePackagePath(adapter, identityPath, "package proof identity path");
  const physicalRuntimeRootPath = resolvePackagePath(adapter, runtimeRootPath, "package proof runtime root");
  const physicalPaths = packageTransactionPaths(physicalTarget, runId);
  assertPackagePathMapping(adapter, logicalPaths, physicalPaths);
  if (resolvePackagePath(adapter, packageIdentityTemporaryPath(identityPath, runId), "package proof identity temporary") !== packageIdentityTemporaryPath(physicalIdentityPath, runId)) {
    throw new Error("package proof filesystem mapping changed the fixed identity temporary target/run path");
  }
  const physicalJournalInfo = await lstat(physicalPaths.journal).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!physicalJournalInfo) {
    if (!allowMissing) {
      throw new Error(`package proof journal is missing at the fixed target/run-derived path ${logicalPaths.journal}`);
    }
    const identityInfo = await lstat(physicalIdentityPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (identityInfo) {
      throw new Error("package proof journal is missing while the package identity path is present");
    }
    for (const [candidate, label] of [
      [physicalPaths.staging, "package staging"],
      [physicalPaths.backup, "prior package backup"],
      [physicalPaths.displaced, "displaced package"],
      [packageIdentityTemporaryPath(physicalIdentityPath, runId), "package identity temporary"],
    ]) {
      const residue = await lstat(candidate).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (residue) {
        throw new Error(`package proof journal is missing while ${label} is present at a fixed target/run-derived path`);
      }
    }
    return { status: "absent", journalPath: logicalPaths.journal };
  }
  if (physicalJournalInfo.isSymbolicLink() || !physicalJournalInfo.isFile() || physicalJournalInfo.uid !== currentUid() || physicalJournalInfo.nlink !== 1 || (physicalJournalInfo.mode & 0o7777) !== 0o600) {
    throw new Error("package proof journal is not one secure regular file");
  }
  try {
    await assertMacOSPackageParent(path.dirname(physicalTarget));
  } catch (error) {
    throw new Error(`package proof package parent is not authorized: ${error instanceof Error ? error.message : String(error)}`);
  }

  let transaction;
  try {
    transaction = normalizeTransaction(JSON.parse(await readFile(physicalPaths.journal, "utf8")));
  } catch (error) {
    throw new Error(`package proof journal is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (transaction.runId !== runId) {
    throw new Error("package proof journal run ID does not equal the exact target/run-derived path run ID");
  }
  assertTransaction(transaction, {
    ownerToken,
    target: physicalTarget,
    identityPath: physicalIdentityPath,
    requireArtifactBinding: true,
  });
  return {
    status: "present",
    transaction,
    logicalPaths,
    physicalRuntimeRootPath,
    logicalTarget: target,
    logicalIdentityPath: identityPath,
  };
}

function packageProofResult(record, values) {
  const transaction = record.transaction;
  return {
    ...values,
    journalPath: record.logicalPaths.journal,
    ownerToken: transaction.ownerToken,
    runId: transaction.runId,
    target: record.logicalTarget,
    identityPath: record.logicalIdentityPath,
    artifactBinding: transaction.artifactBinding,
    candidateFingerprint: transaction.candidateFingerprint,
    candidateIdentity: transaction.candidateIdentity,
    nextIdentityFingerprint: transaction.nextIdentityFingerprint,
    identityPublishedIdentity: transaction.identityPublishedIdentity,
    transaction,
  };
}

function normalizePackageFilesystem(filesystem) {
  if (filesystem === undefined) return { resolvePath: (candidate) => candidate };
  if (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem) ||
      typeof filesystem.resolvePath !== "function" || Object.keys(filesystem).some((name) => name !== "resolvePath")) {
    throw new Error("package proof filesystem must expose only one low-level resolvePath adapter");
  }
  return filesystem;
}

function resolvePackagePath(filesystem, candidate, label) {
  const resolved = filesystem.resolvePath(candidate);
  if (typeof resolved !== "string") throw new Error(`${label} resolver did not return one absolute path`);
  assertCanonicalPackagePath(resolved, `${label} resolved path`);
  return resolved;
}

function assertPackagePathMapping(filesystem, logicalPaths, physicalPaths) {
  for (const name of Object.keys(logicalPaths)) {
    if (resolvePackagePath(filesystem, logicalPaths[name], `package proof ${name}`) !== physicalPaths[name]) {
      throw new Error(`package proof filesystem mapping changed the fixed ${name} target/run path`);
    }
  }
}

async function loadTransaction(transactionOrJournal) {
  if (typeof transactionOrJournal !== "string") return normalizeTransaction(transactionOrJournal);
  return normalizeTransaction(JSON.parse(await readFile(transactionOrJournal, "utf8")));
}

async function restoreToPrevious(transaction, options = {}) {
  const { faultAt, lockLease } = options;
  await reconcilePendingCleanup(transaction, lockLease);
  await reconcileIdentityTemporary(transaction, lockLease);
  if (transaction.state !== "restoring" && transaction.state !== "target-displaced" &&
      transaction.state !== "target-restored" && transaction.state !== "target-removed" &&
      transaction.state !== "identity-restored") {
    await transition(transaction, "restoring", faultAt);
  }

  const expectedPrior = transaction.previous.targetExists ? transaction.previous.targetFingerprint : null;
  const expectedCandidate = transaction.candidateFingerprint ?? transaction.sourceFingerprint;
  const targetFingerprint = await fingerprintPath(transaction.target);
  const targetIdentity = await packagePathIdentity(transaction.target);
  const displacedFingerprint = await fingerprintPath(transaction.paths.displaced);
  const displacedIdentity = await packagePathIdentity(transaction.paths.displaced);
  const backupFingerprint = await fingerprintPath(transaction.paths.backup);
  const backupIdentity = await packagePathIdentity(transaction.paths.backup);
  const candidateIdentity = transaction.candidateIdentity ?? transaction.stagingIdentity;
  const priorIdentity = transaction.previous.targetIdentity;

  if (displacedFingerprint !== null && displacedFingerprint !== expectedCandidate) {
    throw new Error("refusing package recovery; displaced artifact ownership fingerprint changed");
  }
  if (displacedFingerprint !== null && !samePackageIdentity(displacedIdentity, candidateIdentity)) {
    throw new Error("refusing package recovery; displaced artifact identity changed or is an unowned collision");
  }
  if (targetFingerprint !== null && targetFingerprint !== expectedPrior && targetFingerprint !== expectedCandidate) {
    throw new Error("refusing package recovery; canonical target changed outside the package transaction");
  }
  if (targetFingerprint === expectedPrior && !samePackageIdentity(targetIdentity, priorIdentity)) {
    throw new Error("refusing package recovery; canonical target is an unowned prior-content collision");
  }
  if (targetFingerprint === expectedCandidate && !samePackageIdentity(targetIdentity, candidateIdentity)) {
    throw new Error("refusing package recovery; canonical target is an unowned candidate-content collision");
  }
  if (backupFingerprint !== null && expectedPrior !== null && !samePackageIdentity(backupIdentity, priorIdentity)) {
    throw new Error("refusing package recovery; package backup is an unowned prior-content collision");
  }
  if (transaction.stagingFingerprint !== undefined && transaction.stagingFingerprint !== null) {
    const stagingIdentity = await packagePathIdentity(transaction.paths.staging);
    if (stagingIdentity !== null && !samePackageIdentity(stagingIdentity, transaction.stagingIdentity)) {
      throw new Error("refusing package recovery; package staging identity changed outside the transaction");
    }
  }

  if (expectedPrior !== null) {
    if (targetFingerprint === expectedCandidate) {
      if (displacedFingerprint !== null) throw new Error("refusing package recovery; two candidate artifacts are present");
      await moveOwnedPath(transaction, transaction.target, transaction.paths.displaced, expectedCandidate, "installed package", lockLease, candidateIdentity);
      await transition(transaction, "target-displaced", faultAt);
    }
    const currentTarget = await fingerprintPath(transaction.target);
    if (currentTarget === null) {
      const currentBackup = await fingerprintPath(transaction.paths.backup);
      if (currentBackup !== expectedPrior) {
        throw new Error("refusing package recovery; prior package backup is missing or changed");
      }
      await assertOwnedPath(transaction.paths.backup, expectedPrior, "prior package backup", priorIdentity);
      await lockLease.renameNoReplace(transaction.paths.backup, transaction.target, packageRenameOptions(transaction.target));
      await assertOwnedPath(transaction.target, expectedPrior, "restored prior package", priorIdentity);
      await transition(transaction, "target-restored", faultAt);
    } else if (currentTarget === expectedPrior) {
      if (backupFingerprint !== null) {
        if (backupFingerprint !== expectedPrior) throw new Error("refusing package recovery; backup ownership fingerprint changed");
        await removeOwnedPath(transaction, transaction.paths.backup, expectedPrior, "prior package backup", lockLease, priorIdentity);
      }
      if (transaction.state === "target-displaced") await transition(transaction, "target-restored", faultAt);
    } else {
      throw new Error("refusing package recovery; canonical target is neither the prior nor candidate package");
    }
  } else {
    if (targetFingerprint === expectedCandidate) {
      await removeOwnedPath(transaction, transaction.target, expectedCandidate, "installed package", lockLease, candidateIdentity);
    } else if (targetFingerprint !== null) {
      throw new Error("refusing package recovery; a package appeared where no prior target was recorded");
    }
    if (await exists(transaction.paths.backup)) {
      throw new Error("refusing package recovery; unexpected prior-package backup exists");
    }
    if (transaction.state !== "target-removed" && transaction.state !== "identity-restored") {
      await transition(transaction, "target-removed", faultAt);
    }
  }

  if (await exists(transaction.paths.displaced)) {
    await removeOwnedPath(transaction, transaction.paths.displaced, expectedCandidate, "displaced package", lockLease, candidateIdentity);
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction, transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging", lockLease, transaction.stagingIdentity);
  }
  await restoreIdentity(transaction, lockLease);
  if (transaction.state !== "identity-restored") await transition(transaction, "identity-restored", faultAt);
  await removeJournal(transaction);
}

async function finishFinalization(transaction, options = {}) {
  const { faultAt, lockLease } = options;
  await reconcilePendingCleanup(transaction, lockLease);
  await reconcileIdentityTemporary(transaction, lockLease);
  await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package", transaction.candidateIdentity);
  await assertIdentityState(transaction, transaction.nextIdentityFingerprint);
  if (await exists(transaction.paths.backup)) {
    await removeOwnedPath(transaction, transaction.paths.backup, transaction.backupFingerprint, "prior package backup", lockLease, transaction.backupIdentity ?? transaction.previous.targetIdentity);
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction, transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging", lockLease, transaction.stagingIdentity);
  }
  if (await exists(transaction.paths.displaced)) {
    await removeOwnedPath(transaction, transaction.paths.displaced, transaction.candidateFingerprint, "displaced package", lockLease, transaction.candidateIdentity);
  }
  if (transaction.state !== "finalized") await transition(transaction, "finalized", faultAt);
  await removeJournal(transaction);
}

async function restoreIdentity(transaction, lockLease) {
  const previousBytes = transaction.previous.identityBytes;
  const current = await readBytes(transaction.identityPath);
  const currentDigest = digest(current);
  const previousDigest = digest(previousBytes);
  const nextDigest = transaction.nextIdentityFingerprint ?? digest(transaction.nextIdentityBytes);
  if (currentDigest !== previousDigest && currentDigest !== nextDigest) {
    throw new Error(`refusing to restore host identity changed outside package transaction ${transaction.identityPath}`);
  }
  if (currentDigest === previousDigest) return;
  if (previousBytes === null) {
    const currentIdentity = await packagePathIdentity(transaction.identityPath);
    if (transaction.artifactBinding && !sameRecoveryPublishedIdentity(currentIdentity, transaction.identityPublishedIdentity)) {
      throw new Error("refusing to restore package identity; published ownership metadata changed beyond the authorized inode republication");
    }
    const expectedIdentity = currentIdentity;
    if (!expectedIdentity) {
      throw new Error("refusing to restore package identity; published ownership identity is missing");
    }
    await removeOwnedPath(transaction, transaction.identityPath, await fingerprintPath(transaction.identityPath), "package identity", lockLease, expectedIdentity);
  } else {
    await writeBytesAtomic(transaction.identityPath, previousBytes, { lease: lockLease, noReplace: false });
  }
}

async function requireAuthorizedRecoveryTransaction(transaction, options) {
  const proof = await readPackageRecoveryProof({
    target: transaction.target,
    identityPath: transaction.identityPath,
    runId: transaction.runId,
    ownerToken: options.ownerToken ?? transaction.ownerToken,
    expectedArtifactBinding: options.expectedArtifactBinding,
    runtimeRootPath: runtimeRootPathFor(transaction, options),
    allowMissing: false,
    filesystem: options.filesystem,
  });
  if (proof.status !== "recoverable" || !proof.transaction) {
    throw new Error("package recovery authorization did not return one recoverable package transaction");
  }
  return proof.transaction;
}

async function assertAuthorizedPublishedIdentity(transaction, {
  expectedArtifactBinding,
  runtimeRootPath,
} = {}) {
  if (transaction.state !== "committed") {
    throw new Error(`package identity authorization requires committed package state; observed ${transaction.state}`);
  }
  if (!Object.prototype.hasOwnProperty.call(transaction.previous, "identityBytes") || transaction.previous.identityBytes !== null) {
    throw new Error("package identity authorization requires null previous.identityBytes for a fresh-root install");
  }
  let artifactBinding;
  try {
    artifactBinding = assertMasGateArtifactBinding(transaction.artifactBinding, { bundlePath: transaction.source });
  } catch (error) {
    throw new Error(`package identity authorization artifact binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (transaction.sourceFingerprint !== artifactBinding.bundleFingerprint || transaction.candidateFingerprint !== artifactBinding.bundleFingerprint) {
    throw new Error("package identity authorization artifact binding does not match the exact candidate fingerprint");
  }
  if (expectedArtifactBinding !== undefined) {
    assertMasGateArtifactBinding(expectedArtifactBinding, { bundlePath: transaction.source });
    if (!sameArtifactBinding(artifactBinding, expectedArtifactBinding)) {
      throw new Error("package identity authorization artifact binding differs from the authorized artifact");
    }
  }

  assertExactPackageIdentity(transaction.candidateIdentity, "package identity authorization candidate identity", "directory");
  assertExactPackageIdentity(transaction.identityPublishedIdentity, "package identity authorization published identity", "file");
  if (!Buffer.isBuffer(transaction.nextIdentityBytes)) {
    throw new Error("package identity authorization next identity bytes are not one durable byte value");
  }
  if (transaction.nextIdentityFingerprint !== digest(transaction.nextIdentityBytes) || !/^[a-f0-9]{64}$/u.test(transaction.nextIdentityFingerprint ?? "")) {
    throw new Error("package identity authorization next identity bytes and digest are inconsistent");
  }
  const identityDocument = decodeStrictPublishedHostIdentity(transaction.nextIdentityBytes, "package identity authorization");
  if (transaction.identityTemporaryPath !== null || transaction.identityTemporaryFingerprint !== null || transaction.identityTemporaryIdentity !== null) {
    throw new Error("package identity authorization retains a temporary or collision identity");
  }
  if (transaction.cleanupPath !== null || transaction.cleanupSource !== null || transaction.cleanupFingerprint !== null || transaction.cleanupIdentity !== null) {
    throw new Error("package identity authorization has pending package cleanup intent");
  }
  if (runtimeRootPath === undefined) {
    throw new Error("package identity authorization requires the exact runtime root");
  }
  assertCanonicalPackagePath(runtimeRootPath, "package proof runtime root");
  if (!pathInside(runtimeRootPath, transaction.identityPath)) {
    throw new Error("package identity authorization identity path is outside the exact runtime root");
  }
  await assertNoSymlinkAncestors(transaction.identityPath, runtimeRootPath);
  await assertNoSymlinkAncestors(transaction.target, path.dirname(transaction.target));
  if (await packagePathIdentity(packageIdentityTemporaryPath(transaction.identityPath, transaction.runId)) !== null) {
    throw new Error("package identity authorization has a temporary or collision identity at the exact run-derived path");
  }
  if (await packagePathIdentity(transaction.paths.staging) !== null || await packagePathIdentity(transaction.paths.displaced) !== null) {
    throw new Error("package identity authorization has a staging or displaced package collision");
  }
  const backupFingerprint = await fingerprintPath(transaction.paths.backup);
  if (transaction.previous.targetExists) {
    assertExactPackageIdentity(transaction.previous.targetIdentity, "package identity authorization prior package identity", "directory");
    assertExactPackageIdentity(transaction.backupIdentity, "package identity authorization backup identity", "directory");
    if (backupFingerprint !== transaction.previous.targetFingerprint ||
        !samePackageIdentity(await packagePathIdentity(transaction.paths.backup), transaction.previous.targetIdentity) ||
        transaction.backupFingerprint !== transaction.previous.targetFingerprint) {
      throw new Error("package identity authorization prior-package backup is missing or changed");
    }
  } else if (backupFingerprint !== null) {
    throw new Error("package identity authorization has a prior-package backup collision for a fresh target");
  }

  const candidateFingerprint = await fingerprintPath(transaction.target);
  if (candidateFingerprint !== transaction.candidateFingerprint) {
    throw new Error("package identity authorization candidate package fingerprint changed");
  }
  const candidateIdentity = await packagePathIdentity(transaction.target);
  if (!samePackageIdentity(candidateIdentity, transaction.candidateIdentity)) {
    throw new Error("package identity authorization candidate package identity changed");
  }
  const bytes = await readIdentityBytes(transaction.identityPath, "package identity authorization current identity");
  if (bytes === null) throw new Error("package identity authorization published identity is missing");
  if (!Buffer.isBuffer(bytes) || Buffer.compare(bytes, transaction.nextIdentityBytes) !== 0 || digest(bytes) !== transaction.nextIdentityFingerprint) {
    throw new Error("package identity authorization current bytes do not exactly match nextIdentityBytes and digest");
  }
  const metadata = await packagePathIdentity(transaction.identityPath);
  if (!samePackageIdentity(metadata, transaction.identityPublishedIdentity)) {
    throw new Error("package identity authorization current file metadata does not exactly match identityPublishedIdentity");
  }
  return { bytes, digest: transaction.nextIdentityFingerprint, metadata, document: identityDocument };
}

async function assertAuthorizedRecoverablePackageState(transaction, {
  expectedArtifactBinding,
  runtimeRootPath,
} = {}) {
  if (!PACKAGE_TRANSACTION_RECOVERABLE_STATES.includes(transaction.state)) {
    throw new Error(`package recovery authorization rejects unknown or non-rollback state ${String(transaction.state)}`);
  }
  assertFreshRootPackageBinding(transaction, expectedArtifactBinding);
  assertCanonicalPackagePath(runtimeRootPath, "package recovery runtime root");
  if (!pathInside(runtimeRootPath, transaction.identityPath)) {
    throw new Error("package recovery authorization identity path is outside the exact runtime root");
  }
  await assertNoSymlinkAncestors(transaction.identityPath, runtimeRootPath);
  await assertNoSymlinkAncestors(transaction.target, path.dirname(transaction.target));

  const state = transaction.state;
  const priorFingerprint = transaction.previous.targetExists ? transaction.previous.targetFingerprint : null;
  const priorIdentity = transaction.previous.targetIdentity;
  const candidateFingerprint = transaction.candidateFingerprint;
  const candidateIdentity = transaction.candidateIdentity;
  const stagingFingerprint = transaction.stagingFingerprint ?? transaction.sourceFingerprint;
  const stagingIdentity = transaction.stagingIdentity;
  const target = await packagePathSnapshot(transaction.target);
  const staging = await packagePathSnapshot(transaction.paths.staging);
  const backup = await packagePathSnapshot(transaction.paths.backup);
  const displaced = await packagePathSnapshot(transaction.paths.displaced);
  const identity = await identitySnapshot(transaction.identityPath);
  const temporary = await packagePathSnapshot(packageIdentityTemporaryPath(transaction.identityPath, transaction.runId));

  assertRecoveryJournalIdentityShape(transaction, state);
  const identityDocument = transaction.nextIdentityBytes === undefined
    ? null
    : decodeStrictPublishedHostIdentity(transaction.nextIdentityBytes, `package recovery ${state}`);
  if (transaction.stagingIdentity !== null) {
    assertExactPackageIdentity(transaction.stagingIdentity, "package recovery staging identity", "directory");
    if (transaction.stagingFingerprint !== candidateFingerprint) {
      throw new Error(`package recovery ${state} staging fingerprint is not bound to the candidate`);
    }
  }
  if (transaction.candidateIdentity !== null) {
    assertExactPackageIdentity(transaction.candidateIdentity, "package recovery candidate identity", "directory");
  }
  if (transaction.backupIdentity !== null) {
    assertExactPackageIdentity(transaction.backupIdentity, "package recovery backup identity", "directory");
    if (!transaction.previous.targetExists || transaction.backupFingerprint !== priorFingerprint) {
      throw new Error(`package recovery ${state} backup fingerprint is not bound to the prior package`);
    }
  }
  if (transaction.identityPublishedIdentity !== null) {
    assertExactPackageIdentity(transaction.identityPublishedIdentity, "package recovery published identity", "file");
  }
  if (transaction.previous.targetExists) {
    assertExactPackageIdentity(priorIdentity, "package recovery prior target identity", "directory");
  } else if (priorIdentity !== null) {
    throw new Error("package recovery prior target identity exists for a fresh package target");
  }
  if (transaction.previous.identityBytes !== null) {
    throw new Error("package recovery authorization requires null previous.identityBytes for the fresh-root install");
  }

  const candidateIdentityRequired = ["candidate-installed", "identity-published", "committed", "target-displaced"].includes(state);
  const candidateTargetRequired = ["candidate-installed", "identity-published", "committed"].includes(state);
  const identityPublishedRequired = ["identity-published", "committed"].includes(state);
  const preCandidate = ["prepared", "staged", "target-backed-up"].includes(state);
  if (preCandidate && candidateIdentity !== null) {
    throw new Error(`package recovery ${state} journal contains a candidate identity before candidate installation`);
  }
  if (candidateIdentityRequired) {
    assertExactPackageIdentity(candidateIdentity, "package recovery candidate identity", "directory");
  } else if (candidateIdentity !== null) {
    assertExactPackageIdentity(candidateIdentity, "package recovery candidate identity", "directory");
  }
  if (stagingFingerprint !== null && typeof stagingFingerprint !== "string") {
    throw new Error("package recovery staging fingerprint is invalid");
  }

  const stagingExpected = ["staged", "target-backed-up"].includes(state);
  const stagingAllowedInFlight = ["restoring", "target-restored", "target-removed"].includes(state);
  if (stagingExpected || (stagingAllowedInFlight && staging.fingerprint !== null)) {
    if (transaction.stagingFingerprint !== candidateFingerprint || stagingFingerprint !== candidateFingerprint ||
        !staging.fingerprint || staging.fingerprint !== stagingFingerprint) {
      throw new Error(`package recovery ${state} staging artifact is missing or changed`);
    }
    assertExactPackageIdentity(stagingIdentity, "package recovery staging identity", "directory");
    if (!samePackageIdentity(staging.identity, stagingIdentity)) {
      throw new Error(`package recovery ${state} staging artifact identity changed or is a symlink collision`);
    }
  } else if (staging.fingerprint !== null) {
    throw new Error(`package recovery ${state} has an unexpected staging artifact or collision`);
  }

  if (candidateTargetRequired && (!target.fingerprint || target.fingerprint !== candidateFingerprint ||
      !samePackageIdentity(target.identity, candidateIdentity))) {
    throw new Error(`package recovery ${state} candidate package is missing or changed`);
  }

  const backupExpected = transaction.previous.targetExists &&
    ["target-backed-up", "candidate-installed", "identity-published", "committed", "target-displaced"].includes(state);
  const backupAllowedInFlight = transaction.previous.targetExists && state === "restoring" &&
    (target.fingerprint === null || target.fingerprint === candidateFingerprint);
  if (backupExpected || backupAllowedInFlight) {
    if (backup.fingerprint !== priorFingerprint || !samePackageIdentity(backup.identity, priorIdentity) ||
        transaction.backupFingerprint !== priorFingerprint) {
      throw new Error(`package recovery ${state} prior package backup is missing or changed`);
    }
    assertExactPackageIdentity(transaction.backupIdentity, "package recovery backup identity", "directory");
  } else if (backup.fingerprint !== null) {
    throw new Error(`package recovery ${state} has an unexpected prior-package backup or collision`);
  }

  if (!transaction.previous.targetExists && backup.fingerprint !== null) {
    throw new Error(`package recovery ${state} has a prior-package backup for a fresh package target`);
  }
  if (transaction.previous.targetExists && state === "target-backed-up" && target.fingerprint !== null) {
    throw new Error("package recovery target-backed-up state still has a canonical target");
  }
  if (transaction.previous.targetExists && ["prepared", "staged"].includes(state) &&
      (!target.fingerprint || target.fingerprint !== priorFingerprint || !samePackageIdentity(target.identity, priorIdentity))) {
    throw new Error(`package recovery ${state} prior package target is missing or changed`);
  }
  if (!transaction.previous.targetExists && ["prepared", "staged", "target-backed-up"].includes(state) && target.fingerprint !== null) {
    throw new Error(`package recovery ${state} has a package target where prior absence was recorded`);
  }

  if (state === "restoring") {
    const targetIsPrior = transaction.previous.targetExists && target.fingerprint === priorFingerprint &&
      samePackageIdentity(target.identity, priorIdentity);
    const targetIsCandidate = target.fingerprint === candidateFingerprint &&
      samePackageIdentity(target.identity, candidateIdentity);
    const targetIsAbsent = target.fingerprint === null;
    if (!targetIsPrior && !targetIsCandidate && !targetIsAbsent) {
      throw new Error("package recovery restoring state has an impossible canonical target");
    }
    if (transaction.previous.targetExists) {
      if (targetIsCandidate && backup.fingerprint !== priorFingerprint) {
        throw new Error("package recovery restoring state lost the prior package backup before candidate displacement");
      }
      if (targetIsCandidate && (staging.fingerprint !== null || displaced.fingerprint !== null)) {
        throw new Error("package recovery restoring state has duplicate candidate artifacts");
      }
      if (targetIsAbsent && backup.fingerprint !== priorFingerprint) {
        throw new Error("package recovery restoring state has no exact prior package backup");
      }
      if (targetIsPrior && backup.fingerprint !== null) {
        throw new Error("package recovery restoring state has both the prior target and its backup");
      }
    } else if (backup.fingerprint !== null || targetIsPrior) {
      throw new Error("package recovery restoring state contradicts the recorded prior target absence");
    }
  }

  if (state === "prepared" && (staging.fingerprint !== null || backup.fingerprint !== null || displaced.fingerprint !== null)) {
    throw new Error("package recovery prepared state contains an unexpected transaction artifact");
  }
  if (["prepared", "staged", "target-backed-up"].includes(state) && displaced.fingerprint !== null) {
    throw new Error(`package recovery ${state} has an unexpected displaced candidate or collision`);
  }
  if (state === "candidate-installed" && displaced.fingerprint !== null) {
    throw new Error("package recovery candidate-installed state has an unexpected displaced candidate or collision");
  }
  if (["identity-published", "committed"].includes(state) && displaced.fingerprint !== null) {
    throw new Error(`package recovery ${state} has an unexpected displaced candidate or collision`);
  }
  if (displaced.fingerprint !== null) {
    if (candidateIdentity === null) {
      throw new Error(`package recovery ${state} displaced candidate lacks its journaled identity`);
    }
    if (displaced.fingerprint !== candidateFingerprint || !samePackageIdentity(displaced.identity, candidateIdentity)) {
      throw new Error(`package recovery ${state} displaced candidate is missing or changed`);
    }
  }

  if (state === "target-displaced") {
    if (!transaction.previous.targetExists || target.fingerprint !== null || displaced.fingerprint !== candidateFingerprint || backup.fingerprint !== priorFingerprint) {
      throw new Error("package recovery target-displaced state is not the exact post-displacement shape");
    }
  }
  if (state === "target-restored") {
    if (!transaction.previous.targetExists || target.fingerprint !== priorFingerprint ||
        !samePackageIdentity(target.identity, priorIdentity) || backup.fingerprint !== null ||
        (staging.fingerprint !== null && displaced.fingerprint !== null)) {
      throw new Error("package recovery target-restored state is not the exact prior-target shape");
    }
  }
  if (state === "target-removed") {
    if (transaction.previous.targetExists || target.fingerprint !== null || backup.fingerprint !== null) {
      throw new Error("package recovery target-removed state is impossible for the recorded prior target");
    }
    if (staging.fingerprint !== null && displaced.fingerprint !== null) {
      throw new Error("package recovery target-removed state contains two candidate artifacts");
    }
  }
  if (state === "identity-restored") {
    const expectedTarget = transaction.previous.targetExists ? priorFingerprint : null;
    if (target.fingerprint !== expectedTarget ||
        (expectedTarget !== null && !samePackageIdentity(target.identity, priorIdentity)) ||
        staging.fingerprint !== null || backup.fingerprint !== null || displaced.fingerprint !== null || temporary.fingerprint !== null) {
      throw new Error("package recovery identity-restored state is not fully reconciled");
    }
  }

  if (["restoring", "target-displaced", "target-restored", "target-removed", "identity-restored"].includes(state)) {
    if (staging.fingerprint !== null && displaced.fingerprint !== null) {
      throw new Error(`package recovery ${state} contains both staging and displaced candidates`);
    }
  }

  const identityExpected = identityPublishedRequired ||
    (["restoring", "target-displaced", "target-restored", "target-removed"].includes(state) && identity.fingerprint !== null);
  const temporaryPublicationInFlight = transaction.identityTemporaryPath !== null;
  if (temporaryPublicationInFlight && identity.fingerprint !== null) {
    assertTemporaryIdentityDestination(transaction, identity, "package recovery in-flight identity");
  } else if (identityPublishedRequired) {
    assertPublishedIdentitySnapshot(transaction, identity, "package recovery published identity");
  } else if (state === "identity-restored") {
    if (identity.fingerprint !== null) throw new Error("package recovery identity-restored state still has a published identity");
  } else if (identityExpected) {
    assertPublishedIdentitySnapshot(transaction, identity, "package recovery in-flight identity");
  } else if (identity.fingerprint !== null) {
    throw new Error(`package recovery ${state} has an unexpected identity or collision`);
  }
  if (state === "candidate-installed" && transaction.identityPublishedIdentity !== null && identity.fingerprint === null) {
    throw new Error("package recovery candidate-installed state lost its published identity");
  }

  assertRecoveryIdentityTemporaryState(transaction, temporary, identity, state);
  await assertRecoveryCleanupState(transaction, state);
  return {
    identityBytes: identity.bytes,
    identityFingerprint: identity.fingerprint,
    identity: identity.identity,
    identityDocument,
  };
}

function assertFreshRootPackageBinding(transaction, expectedArtifactBinding) {
  if (!Object.prototype.hasOwnProperty.call(transaction.previous, "identityBytes") || transaction.previous.identityBytes !== null) {
    throw new Error("package recovery authorization requires null previous.identityBytes for a fresh-root install");
  }
  let artifactBinding;
  try {
    artifactBinding = assertMasGateArtifactBinding(transaction.artifactBinding, { bundlePath: transaction.source });
  } catch (error) {
    throw new Error(`package recovery authorization artifact binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (transaction.sourceFingerprint !== artifactBinding.bundleFingerprint || transaction.candidateFingerprint !== artifactBinding.bundleFingerprint) {
    throw new Error("package recovery authorization artifact binding does not match the exact candidate fingerprint");
  }
  if (expectedArtifactBinding !== undefined) {
    assertMasGateArtifactBinding(expectedArtifactBinding, { bundlePath: transaction.source });
    if (!sameArtifactBinding(artifactBinding, expectedArtifactBinding)) {
      throw new Error("package recovery authorization artifact binding differs from the authorized artifact");
    }
  }
}

function assertRecoveryJournalIdentityShape(transaction, state) {
  const nextIdentityFieldsPresent = transaction.nextIdentityBytes !== undefined || transaction.nextIdentityFingerprint !== undefined;
  if (nextIdentityFieldsPresent &&
      (!Buffer.isBuffer(transaction.nextIdentityBytes) ||
       typeof transaction.nextIdentityFingerprint !== "string" ||
       !/^[a-f0-9]{64}$/u.test(transaction.nextIdentityFingerprint) ||
       transaction.nextIdentityFingerprint !== digest(transaction.nextIdentityBytes))) {
    throw new Error(`package recovery ${state} next identity bytes and digest are inconsistent`);
  }

  if (["prepared", "staged", "target-backed-up"].includes(state) &&
      (nextIdentityFieldsPresent || transaction.identityPublishedIdentity !== null ||
       transaction.identityTemporaryPath !== null || transaction.identityTemporaryFingerprint !== null ||
       transaction.identityTemporaryIdentity !== null)) {
    throw new Error(`package recovery ${state} contains identity publication data before candidate installation`);
  }
  if (state === "prepared" &&
      ((transaction.stagingFingerprint !== undefined && transaction.stagingFingerprint !== null) ||
       transaction.stagingIdentity !== null ||
       (transaction.backupFingerprint !== undefined && transaction.backupFingerprint !== null) ||
       transaction.backupIdentity !== null)) {
    throw new Error("package recovery prepared state contains journaled package artifacts");
  }
  if (state === "candidate-installed" && nextIdentityFieldsPresent &&
      transaction.identityTemporaryPath === null && transaction.identityPublishedIdentity === null) {
    throw new Error("package recovery candidate-installed state has identity bytes without a publication intent");
  }
}

async function packagePathSnapshot(candidate) {
  return {
    fingerprint: await fingerprintPath(candidate),
    identity: await packagePathIdentity(candidate),
  };
}

async function identitySnapshot(candidate) {
  const info = await lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { bytes: null, fingerprint: null, identity: null };
  const identity = packageIdentityOf(info);
  if (!info.isFile() || info.isSymbolicLink()) {
    return { bytes: null, fingerprint: await fingerprintPath(candidate), identity };
  }
  const bytes = await readFile(candidate);
  return {
    bytes,
    fingerprint: digest(bytes),
    identity,
  };
}

async function readIdentityBytes(candidate, label) {
  const info = await lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} metadata does not exactly match one regular file`);
  return readFile(candidate);
}

function assertPublishedIdentitySnapshot(transaction, snapshot, label) {
  if (!Buffer.isBuffer(transaction.nextIdentityBytes) ||
      transaction.nextIdentityFingerprint !== digest(transaction.nextIdentityBytes) ||
      !/^[a-f0-9]{64}$/u.test(transaction.nextIdentityFingerprint ?? "")) {
    throw new Error(`${label} next identity bytes and digest are inconsistent`);
  }
  assertExactPackageIdentity(transaction.identityPublishedIdentity, `${label} ownership identity`, "file");
  if (snapshot.bytes === null || Buffer.compare(snapshot.bytes, transaction.nextIdentityBytes) !== 0 ||
      snapshot.fingerprint !== transaction.nextIdentityFingerprint ||
      !sameRecoveryPublishedIdentity(snapshot.identity, transaction.identityPublishedIdentity)) {
    throw new Error(`${label} bytes, digest, or metadata do not match the package transaction`);
  }
}

function decodeStrictPublishedHostIdentity(bytes, label) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} published host identity is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertExactObjectKeys(value, [
    "binaryDevice", "binaryInode", "binarySha256", "binarySize", "bundleIdentifier", "bundlePath",
    "bundleRealPath", "cdHash", "configuration", "designatedRequirement", "executablePath", "version",
  ], `${label} published host identity`);
  const configurationKeys = [
    "captureHelperPath", "endpointPolicy", "endpointWorkingDirectory", "identityPath", "listen", "nodePath",
    "recordingEndpointName", "rendererOrigin", "repositoryRoot", "runtimeCliPath", "runtimeRoot",
    "transcriptionEndpointName", "transcriptionSocket", "transcriptionStaging",
  ];
  if (!value.configuration || typeof value.configuration !== "object" || Array.isArray(value.configuration)) {
    throw new Error(`${label} published host identity configuration is not one object`);
  }
  const actualConfigurationKeys = Object.keys(value.configuration).sort();
  const allowedConfigurationKeys = new Set(configurationKeys);
  const requiredConfigurationKeys = [
    "identityPath", "listen", "nodePath", "rendererOrigin", "repositoryRoot", "runtimeCliPath", "runtimeRoot",
    "transcriptionSocket", "transcriptionStaging",
  ];
  if (actualConfigurationKeys.some((key) => !allowedConfigurationKeys.has(key)) ||
      requiredConfigurationKeys.some((key) => !Object.prototype.hasOwnProperty.call(value.configuration, key))) {
    throw new Error(`${label} published host identity configuration contains unexpected or missing keys`);
  }
  if (value.version !== 1 || value.bundleIdentifier !== "com.meetless.app" ||
      !isNonEmptyString(value.bundlePath) || !isNonEmptyString(value.bundleRealPath) ||
      !isNonEmptyString(value.executablePath) || !isNonEmptyString(value.designatedRequirement) ||
      typeof value.cdHash !== "string" || !/^[a-f0-9]{40}$/u.test(value.cdHash) ||
      typeof value.binarySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.binarySha256) ||
      !isNonNegativeSafeInteger(value.binaryDevice) || !isNonNegativeSafeInteger(value.binaryInode) ||
      !Number.isSafeInteger(value.binarySize) || value.binarySize <= 0 ||
      requiredConfigurationKeys.some((key) => !isNonEmptyString(value.configuration[key])) ||
      !/^https?:\/\//u.test(value.configuration.rendererOrigin)) {
    throw new Error(`${label} published host identity contains an invalid strict value`);
  }
  for (const key of configurationKeys.filter((key) => !requiredConfigurationKeys.includes(key))) {
    if (Object.prototype.hasOwnProperty.call(value.configuration, key) && !isNonEmptyString(value.configuration[key])) {
      throw new Error(`${label} published host identity configuration contains an invalid ${key}`);
    }
  }
  return value;
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not one object`);
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpected.length || actualKeys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} contains unexpected or missing keys`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertTemporaryIdentityDestination(transaction, snapshot, label) {
  if (!Buffer.isBuffer(transaction.nextIdentityBytes) ||
      transaction.nextIdentityFingerprint !== digest(transaction.nextIdentityBytes) ||
      !/^[a-f0-9]{64}$/u.test(transaction.nextIdentityFingerprint ?? "")) {
    throw new Error(`${label} next identity bytes and digest are inconsistent`);
  }
  assertExactPackageIdentity(transaction.identityTemporaryIdentity, `${label} temporary ownership identity`, "file");
  if (snapshot.bytes === null || Buffer.compare(snapshot.bytes, transaction.nextIdentityBytes) !== 0 ||
      snapshot.fingerprint !== transaction.nextIdentityFingerprint ||
      !samePackageIdentity(snapshot.identity, transaction.identityTemporaryIdentity)) {
    throw new Error(`${label} does not exactly match the journaled temporary publication`);
  }
}

function assertRecoveryIdentityTemporaryState(transaction, temporary, identity, state) {
  const expectedTemporaryPath = packageIdentityTemporaryPath(transaction.identityPath, transaction.runId);
  if (transaction.identityTemporaryPath === null) {
    if (transaction.identityTemporaryFingerprint !== null || transaction.identityTemporaryIdentity !== null || temporary.fingerprint !== null) {
      throw new Error(`package recovery ${state} has an unjournaled identity temporary or collision`);
    }
    return;
  }
  if (transaction.identityTemporaryPath !== expectedTemporaryPath) {
    throw new Error("package recovery identity temporary path is not the exact run-derived path");
  }
  if (state !== "candidate-installed" && state !== "restoring") {
    throw new Error(`package recovery ${state} contains an impossible identity temporary`);
  }
  if (!Buffer.isBuffer(transaction.nextIdentityBytes) ||
      transaction.identityTemporaryFingerprint !== fingerprintFileBytes(transaction.nextIdentityBytes)) {
    throw new Error("package recovery identity temporary bytes are not bound to nextIdentityBytes");
  }
  assertExactPackageIdentity(transaction.identityTemporaryIdentity, "package recovery identity temporary identity", "file");
  if (temporary.fingerprint !== null) {
    if (temporary.fingerprint !== transaction.identityTemporaryFingerprint ||
        !samePackageIdentity(temporary.identity, transaction.identityTemporaryIdentity) || identity.fingerprint !== null) {
      throw new Error("package recovery identity temporary is changed, colliding, or published twice");
    }
  } else if (identity.fingerprint === null &&
      !(transaction.cleanupSource === transaction.identityTemporaryPath && transaction.cleanupPath !== null)) {
    throw new Error("package recovery identity temporary and destination are both missing or unowned");
  } else if (identity.fingerprint !== null && !samePackageIdentity(identity.identity, transaction.identityTemporaryIdentity)) {
    throw new Error("package recovery identity temporary and destination are both missing or unowned");
  }
}

async function assertRecoveryCleanupState(transaction, state) {
  const fields = [transaction.cleanupPath, transaction.cleanupSource, transaction.cleanupFingerprint, transaction.cleanupIdentity];
  if (fields.every((value) => value === null)) {
    for (const [candidate, label] of [
      [transaction.target, "installed package"],
      [transaction.identityPath, "package identity"],
      [transaction.paths.staging, "package staging"],
      [transaction.paths.backup, "prior package backup"],
      [transaction.paths.displaced, "displaced package"],
    ]) {
      const cleanupPath = cleanupPathFor(transaction, candidate, label);
      if ((await packagePathSnapshot(cleanupPath)).fingerprint !== null) {
        throw new Error(`package recovery ${state} has an unjournaled cleanup collision for ${label}`);
      }
    }
    return;
  }
  if (fields.some((value) => value === null)) {
    throw new Error(`package recovery ${state} cleanup intent is incomplete`);
  }
  const temporaryCleanupInFlight = state === "candidate-installed" &&
    transaction.identityTemporaryPath !== null && transaction.cleanupSource === transaction.identityTemporaryPath;
  if (!["restoring", "target-displaced", "target-restored", "target-removed", "identity-restored"].includes(state) &&
      !temporaryCleanupInFlight) {
    throw new Error(`package recovery ${state} contains cleanup intent before rollback`);
  }
  assertCanonicalPackagePath(transaction.cleanupPath, "package recovery cleanup path");
  assertCanonicalPackagePath(transaction.cleanupSource, "package recovery cleanup source");
  if (!transaction.cleanupIdentity || !["directory", "file"].includes(transaction.cleanupIdentity.type) ||
      !/^[a-f0-9]{64}$/u.test(transaction.cleanupFingerprint)) {
    throw new Error(`package recovery ${state} cleanup ownership is invalid`);
  }
  assertExactPackageIdentity(transaction.cleanupIdentity, "package recovery cleanup identity", transaction.cleanupIdentity.type);
  const allowedSources = new Set([
    transaction.target,
    transaction.identityPath,
    transaction.paths.staging,
    transaction.paths.backup,
    transaction.paths.displaced,
    transaction.identityTemporaryPath,
  ].filter((candidate) => typeof candidate === "string"));
  if (!allowedSources.has(transaction.cleanupSource)) throw new Error("package recovery cleanup source is outside the transaction-owned path set");
  const cleanupPrefix = `${transaction.cleanupSource}.m7-cleanup-${transaction.runId}-`;
  if (!transaction.cleanupPath.startsWith(cleanupPrefix) || !/^[a-f0-9]{16}$/u.test(transaction.cleanupPath.slice(cleanupPrefix.length))) {
    throw new Error("package recovery cleanup path is not the deterministic sibling of its source");
  }
  const source = await packagePathSnapshot(transaction.cleanupSource);
  const disposable = await packagePathSnapshot(transaction.cleanupPath);
  if (source.fingerprint !== null && disposable.fingerprint !== null) {
    throw new Error(`package recovery ${state} cleanup source and disposable are both present`);
  }
  if (source.fingerprint !== null && (source.fingerprint !== transaction.cleanupFingerprint ||
      !samePackageIdentity(source.identity, transaction.cleanupIdentity))) {
    throw new Error(`package recovery ${state} cleanup source ownership changed`);
  }
  if (disposable.fingerprint !== null && (disposable.fingerprint !== transaction.cleanupFingerprint ||
      !samePackageIdentity(disposable.identity, transaction.cleanupIdentity))) {
    throw new Error(`package recovery ${state} cleanup disposable ownership changed`);
  }
  if (source.fingerprint === null && disposable.fingerprint === null) {
    throw new Error(`package recovery ${state} cleanup source and disposable are both missing`);
  }
}

function assertExactPackageIdentity(identity, label, expectedType) {
  validateOptionalPackageIdentity(identity, label);
  if (!identity || identity.type !== expectedType) throw new Error(`${label} is not the exact expected ${expectedType} identity`);
  const expectedKeys = ["dev", "gid", "ino", "mode", "nlink", "size", "type", "uid"];
  const actualKeys = Object.keys(identity).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} contains unexpected or missing metadata`);
  }
}

function sameArtifactBinding(actual, expected) {
  const fields = [
    "schema",
    "version",
    "manifestPath",
    "manifestSha256",
    "bundlePath",
    "bundleFingerprint",
    "artifactDigest",
    "candidateSnapshotDigest",
    "packageInputDigest",
    "artifactInputDigest",
    "licenseDigest",
    "signatureDigest",
    "publicSdkKeySha256",
  ];
  return fields.every((field) => actual[field] === expected[field]);
}

function pathInside(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

async function assertNoSymlinkAncestors(candidate, root) {
  let current = path.dirname(candidate);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("package identity authorization path contains a symlink ancestor");
    if (current === root) return;
    if (!pathInside(root, current)) throw new Error("package identity authorization path escaped the exact runtime root");
    current = path.dirname(current);
  }
}

async function assertIdentityState(transaction, expectedDigest) {
  const current = await readBytes(transaction.identityPath);
  if (digest(current) !== expectedDigest) {
    throw new Error(`refusing to modify host identity changed outside package transaction ${transaction.identityPath}`);
  }
}

async function assertOwnedPath(candidate, expectedFingerprint, label, expectedIdentity = null) {
  const actual = await fingerprintPath(candidate);
  if (actual !== expectedFingerprint) throw new Error(`refusing to modify ${label}; ownership fingerprint changed`);
  if (expectedIdentity !== null && !samePackageIdentity(await packagePathIdentity(candidate), expectedIdentity)) {
    throw new Error(`refusing to modify ${label}; ownership identity changed`);
  }
}

async function packagePathIdentity(candidate) {
  const info = await lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return info ? packageIdentityOf(info) : null;
}

function packageIdentityOf(info) {
  return {
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special",
    mode: Number(info.mode),
    uid: Number(info.uid),
    gid: Number(info.gid),
    dev: Number(info.dev),
    ino: Number(info.ino),
    nlink: Number(info.nlink),
    size: Number(info.size),
  };
}

function samePackageIdentity(actual, expected) {
  return Boolean(actual && expected) && ["type", "mode", "uid", "gid", "dev", "ino", "nlink", "size"].every((field) => actual[field] === expected[field]);
}

function sameRecoveryPublishedIdentity(actual, expected) {
  return Boolean(actual && expected) && ["type", "mode", "uid", "gid", "dev", "nlink", "size"].every((field) => actual[field] === expected[field]);
}

function validateOptionalPackageIdentity(identity, label) {
  if (identity === null) return;
  if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      !["directory", "file", "symlink", "special"].includes(identity.type)) {
    throw new Error(`${label} is invalid`);
  }
  for (const field of ["mode", "uid", "gid", "dev", "ino", "nlink", "size"]) {
    if (!Number.isSafeInteger(identity[field]) || identity[field] < 0) throw new Error(`${label} has an invalid ${field}`);
  }
}

async function removeOwnedPath(transaction, candidate, expectedFingerprint, label = "transaction path", lease, expectedIdentity = null) {
  if (!lease || typeof lease.renameNoReplace !== "function") throw new Error(`cannot remove ${label} without the live native mutation-session lease`);
  if (!expectedIdentity) throw new Error(`cannot remove ${label} without its durable ownership identity`);
  if (!(await exists(candidate))) return;
  await assertOwnedPath(candidate, expectedFingerprint, label, expectedIdentity);
  const disposable = cleanupPathFor(transaction, candidate, label);
  const existingDisposable = await fingerprintPath(disposable);
  if (existingDisposable !== null) {
    throw new Error(`refusing to remove ${label}; disposable cleanup path already exists`);
  }
  transaction.cleanupPath = disposable;
  transaction.cleanupSource = candidate;
  transaction.cleanupFingerprint = expectedFingerprint;
  transaction.cleanupIdentity = expectedIdentity;
  await writeJournal(transaction);
  if (await exists(candidate)) {
    await lease.renameNoReplace(candidate, disposable, protectedRenameOptions(transaction, candidate, disposable));
  }
  await assertOwnedPath(disposable, expectedFingerprint, `${label} disposable`, expectedIdentity);
  await rm(disposable, { recursive: true, force: true });
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
  await writeJournal(transaction);
}

async function moveOwnedPath(transaction, source, destination, expectedFingerprint, label, lease, expectedIdentity = null) {
  if (!lease || typeof lease.renameNoReplace !== "function") throw new Error(`cannot move ${label} without the live native mutation-session lease`);
  if (!expectedIdentity) throw new Error(`cannot move ${label} without its durable ownership identity`);
  await assertOwnedPath(source, expectedFingerprint, label, expectedIdentity);
  if (await exists(destination)) throw new Error(`refusing to move ${label}; destination already exists`);
  await lease.renameNoReplace(source, destination, protectedRenameOptions(transaction, source, destination));
  await assertOwnedPath(destination, expectedFingerprint, `moved ${label}`, expectedIdentity);
}

async function reconcilePendingCleanup(transaction, lease) {
  if (!transaction.cleanupPath) return;
  if (!transaction.cleanupSource || !transaction.cleanupFingerprint || !transaction.cleanupIdentity) {
    throw new Error("refusing package recovery; cleanup intent is incomplete");
  }
  const sourceFingerprint = await fingerprintPath(transaction.cleanupSource);
  const sourceIdentity = await packagePathIdentity(transaction.cleanupSource);
  const disposableFingerprint = await fingerprintPath(transaction.cleanupPath);
  const disposableIdentity = await packagePathIdentity(transaction.cleanupPath);
  if (sourceFingerprint !== null && disposableFingerprint !== null) {
    throw new Error("refusing package recovery; cleanup source and disposable are both present");
  }
  if (sourceFingerprint !== null && sourceFingerprint !== transaction.cleanupFingerprint) {
    throw new Error("refusing package recovery; cleanup source ownership fingerprint changed");
  }
  if (sourceIdentity !== null && !samePackageIdentity(sourceIdentity, transaction.cleanupIdentity)) {
    throw new Error("refusing package recovery; cleanup source ownership identity changed");
  }
  if (disposableFingerprint !== null && disposableFingerprint !== transaction.cleanupFingerprint) {
    throw new Error("refusing package recovery; cleanup disposable ownership fingerprint changed");
  }
  if (disposableIdentity !== null && !samePackageIdentity(disposableIdentity, transaction.cleanupIdentity)) {
    throw new Error("refusing package recovery; cleanup disposable ownership identity changed");
  }
  if (sourceFingerprint === null && disposableFingerprint === null) {
    throw new Error("refusing package recovery; cleanup source and disposable are both missing");
  }
  if (sourceFingerprint !== null) {
    await lease.renameNoReplace(
      transaction.cleanupSource,
      transaction.cleanupPath,
      protectedRenameOptions(transaction, transaction.cleanupSource, transaction.cleanupPath),
    );
  }
  await assertOwnedPath(transaction.cleanupPath, transaction.cleanupFingerprint, "cleanup disposable", transaction.cleanupIdentity);
  await rm(transaction.cleanupPath, { recursive: true, force: true });
  const identityTemporaryCleanup = transaction.cleanupSource === transaction.identityTemporaryPath &&
    transaction.identityTemporaryPath !== null;
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
  if (identityTemporaryCleanup) {
    transaction.identityTemporaryPath = null;
    transaction.identityTemporaryFingerprint = null;
    transaction.identityTemporaryIdentity = null;
  }
  await writeJournal(transaction);
}

function cleanupPathFor(transaction, candidate, label) {
  const suffix = createHash("sha256").update(`${candidate}\0${label}`).digest("hex").slice(0, 16);
  return `${candidate}.m7-cleanup-${transaction.runId}-${suffix}`;
}

function packageIdentityTemporaryPath(identityPath, runId) {
  return `${identityPath}.m7.${runId}.identity.tmp`;
}

async function reconcileIdentityTemporary(transaction, lease) {
  if (transaction.identityTemporaryPath === null) {
    if (transaction.identityTemporaryFingerprint !== null) {
      throw new Error("refusing package recovery; identity temporary fingerprint has no temporary path");
    }
    return;
  }
  if (typeof transaction.identityTemporaryFingerprint !== "string") {
    throw new Error("refusing package recovery; identity temporary construction intent is incomplete");
  }
  const temporaryFingerprint = await fingerprintPath(transaction.identityTemporaryPath);
  const temporaryIdentity = await packagePathIdentity(transaction.identityTemporaryPath);
  const identityFingerprint = await fingerprintPath(transaction.identityPath);
  const identityIdentity = await packagePathIdentity(transaction.identityPath);
  if (temporaryFingerprint !== null && temporaryFingerprint !== transaction.identityTemporaryFingerprint) {
    throw new Error("refusing package recovery; identity temporary ownership fingerprint changed");
  }
  if (temporaryFingerprint !== null && identityFingerprint !== null) {
    throw new Error("refusing package recovery; identity temporary and destination are both present");
  }
  if (temporaryFingerprint !== null && !transaction.identityTemporaryIdentity) {
    throw new Error("refusing package recovery; identity temporary ownership identity is not durably journaled");
  }
  if (temporaryIdentity !== null && !samePackageIdentity(temporaryIdentity, transaction.identityTemporaryIdentity)) {
    throw new Error("refusing package recovery; identity temporary ownership identity changed");
  }
  if (temporaryFingerprint !== null) {
    await removeOwnedPath(transaction, transaction.identityTemporaryPath, temporaryFingerprint, "package identity temporary", lease, transaction.identityTemporaryIdentity);
  } else if (identityFingerprint !== null) {
    if (!samePackageIdentity(identityIdentity, transaction.identityTemporaryIdentity)) {
      throw new Error("refusing package recovery; identity destination is an unowned same-content collision");
    }
    transaction.identityPublishedIdentity = identityIdentity;
  } else {
    throw new Error("refusing package recovery; identity temporary and destination are both missing");
  }
  transaction.identityTemporaryPath = null;
  transaction.identityTemporaryFingerprint = null;
  transaction.identityTemporaryIdentity = null;
  await writeJournal(transaction);
}

async function removeJournal(transaction) {
  if (!(await exists(transaction.paths.journal))) return;
  const onDisk = normalizeTransaction(JSON.parse(await readFile(transaction.paths.journal, "utf8")));
  assertTransaction(onDisk, { ownerToken: transaction.ownerToken, target: transaction.target, identityPath: transaction.identityPath });
  if (onDisk.runId !== transaction.runId || onDisk.state !== transaction.state) {
    throw new Error("refusing to remove a package transaction journal with a changed owner or state");
  }
  await rm(transaction.paths.journal, { force: true });
}

async function transition(transaction, state, faultAt) {
  transaction.state = state;
  await writeJournal(transaction);
  if (faultAt === state) throw new Error(`injected package transaction interruption at ${state}`);
}

async function writeJournal(transaction) {
  const bytes = Buffer.from(`${JSON.stringify(transaction, replacer, 2)}\n`);
  const temporary = `${transaction.paths.journal}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, transaction.paths.journal);
}

function assertRequiredInput(input) {
  for (const [name, value] of Object.entries(input)) {
    if (!value) throw new Error(`package transaction ${name} is required`);
  }
}

function assertTransaction(transaction, options = {}) {
  if (!transaction || transaction.schema !== PACKAGE_TRANSACTION_SCHEMA || transaction.version !== PACKAGE_TRANSACTION_VERSION || typeof transaction.ownerToken !== "string") {
    throw new Error("invalid package transaction journal");
  }
  if (!/^[-A-Za-z0-9]+$/u.test(transaction.runId ?? "")) throw new Error("invalid package transaction run ID");
  if (options.ownerToken !== undefined && transaction.ownerToken !== options.ownerToken) {
    throw new Error("package transaction owner token mismatch");
  }
  if (options.target !== undefined && path.resolve(transaction.target) !== path.resolve(options.target)) {
    throw new Error("package transaction target is not the fixed canonical target");
  }
  if (options.identityPath !== undefined && path.resolve(transaction.identityPath) !== path.resolve(options.identityPath)) {
    throw new Error("package transaction identity path is not the fixed canonical identity");
  }
  assertCanonicalPackagePath(transaction.source, "package transaction source");
  assertCanonicalPackagePath(transaction.target, "package transaction target");
  assertCanonicalPackagePath(transaction.identityPath, "package transaction identity path");
  const expectedPaths = packageTransactionPaths(transaction.target, transaction.runId);
  for (const name of Object.keys(expectedPaths)) {
    if (transaction.paths?.[name] !== expectedPaths[name]) throw new Error(`package transaction ${name} path is not canonical`);
  }
  if (!transaction.previous || typeof transaction.previous.targetExists !== "boolean") {
    throw new Error("package transaction prior target record is missing");
  }
  validateOptionalPackageIdentity(transaction.previous.targetIdentity, "package transaction prior target identity");
  if (transaction.previous.targetExists !== (transaction.previous.targetFingerprint !== null) ||
      transaction.previous.targetExists !== (transaction.previous.targetIdentity !== null)) {
    throw new Error("package transaction prior target content and identity records are inconsistent");
  }
  for (const [field, label] of [
    ["stagingIdentity", "package transaction staging identity"],
    ["candidateIdentity", "package transaction candidate identity"],
    ["backupIdentity", "package transaction backup identity"],
    ["identityPublishedIdentity", "package transaction published identity"],
    ["cleanupIdentity", "package transaction cleanup identity"],
    ["identityTemporaryIdentity", "package transaction identity temporary identity"],
  ]) {
    if (!(field in transaction)) throw new Error(`${label} is missing`);
    validateOptionalPackageIdentity(transaction[field], label);
  }
  for (const [field, label] of [
    ["sourceFingerprint", "package transaction source fingerprint"],
    ["candidateFingerprint", "package transaction candidate fingerprint"],
  ]) {
    const value = transaction[field];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  }
  if (transaction.previous.targetFingerprint !== null &&
      (typeof transaction.previous.targetFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(transaction.previous.targetFingerprint))) {
    throw new Error("package transaction prior target fingerprint is invalid");
  }
  for (const [field, label] of [
    ["stagingFingerprint", "package transaction staging fingerprint"],
    ["backupFingerprint", "package transaction backup fingerprint"],
  ]) {
    const value = transaction[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) {
      throw new Error(`${label} is invalid`);
    }
  }
  if ((transaction.stagingFingerprint !== undefined && transaction.stagingFingerprint !== null) !== (transaction.stagingIdentity !== null)) {
    throw new Error("package transaction staging fingerprint and identity records are inconsistent");
  }
  if ((transaction.backupFingerprint !== undefined && transaction.backupFingerprint !== null) !== (transaction.backupIdentity !== null)) {
    throw new Error("package transaction backup fingerprint and identity records are inconsistent");
  }
  if ((transaction.identityTemporaryFingerprint !== null) !== (transaction.identityTemporaryIdentity !== null)) {
    throw new Error("package transaction identity temporary fingerprint and identity records are inconsistent");
  }
  if (transaction.identityPublishedIdentity !== null && transaction.identityPublishedIdentity.type !== "file") {
    throw new Error("package transaction published identity must be one regular file");
  }
  if (transaction.identityPublishedIdentity !== null && transaction.identityTemporaryIdentity !== null) {
    throw new Error("package transaction published and temporary identity records are inconsistent");
  }
  transaction.previous.identityBytes = reviveBuffer(transaction.previous.identityBytes);
  transaction.nextIdentityBytes = reviveBuffer(transaction.nextIdentityBytes);
  if (transaction.identityTemporaryPath === null && transaction.identityTemporaryFingerprint !== null) {
    throw new Error("package transaction identity temporary fingerprint has no path");
  }
  if (transaction.identityTemporaryPath !== null) {
    const expectedTemporaryPath = packageIdentityTemporaryPath(transaction.identityPath, transaction.runId);
    if (transaction.identityTemporaryPath !== expectedTemporaryPath) {
      throw new Error("package transaction identity temporary path is not canonical");
    }
    assertCanonicalPackagePath(transaction.identityTemporaryPath, "package transaction identity temporary path");
    if (transaction.identityTemporaryFingerprint !== null && !/^[a-f0-9]{64}$/u.test(transaction.identityTemporaryFingerprint)) {
      throw new Error("package transaction identity temporary fingerprint is invalid");
    }
  }
  if (transaction.artifactBinding !== null && transaction.artifactBinding !== undefined) {
    assertMasGateArtifactBinding(transaction.artifactBinding, { bundlePath: transaction.source });
  } else if (options.requireArtifactBinding === true) {
    throw new Error("MAS package transaction artifact binding is required");
  }
  const cleanupFields = [transaction.cleanupPath, transaction.cleanupSource, transaction.cleanupFingerprint, transaction.cleanupIdentity];
  if (cleanupFields.some((value) => value !== null) && cleanupFields.some((value) => value === null)) {
    throw new Error("package transaction cleanup intent is malformed");
  }
  if (transaction.cleanupPath !== null) {
    assertCanonicalPackagePath(transaction.cleanupPath, "package transaction cleanup path");
    assertCanonicalPackagePath(transaction.cleanupSource, "package transaction cleanup source");
    if (!/^[a-f0-9]{64}$/u.test(transaction.cleanupFingerprint)) throw new Error("package transaction cleanup fingerprint is invalid");
    const allowedSources = new Set([
      transaction.target,
      transaction.identityPath,
      transaction.paths.staging,
      transaction.paths.backup,
      transaction.paths.displaced,
      transaction.identityTemporaryPath,
    ].filter((candidate) => typeof candidate === "string"));
    if (!allowedSources.has(transaction.cleanupSource)) {
      throw new Error("package transaction cleanup source is outside the transaction-owned path set");
    }
    const cleanupPrefix = `${transaction.cleanupSource}.m7-cleanup-${transaction.runId}-`;
    if (!transaction.cleanupPath.startsWith(cleanupPrefix) ||
        !/^[a-f0-9]{16}$/u.test(transaction.cleanupPath.slice(cleanupPrefix.length))) {
      throw new Error("package transaction cleanup path is not the deterministic sibling of its source");
    }
  }
}

function normalizeTransaction(transaction) {
  assertTransaction(transaction);
  return transaction;
}

function replacer(_key, value) {
  if (Buffer.isBuffer(value)) return { type: "Buffer", data: value.toString("base64") };
  if (value?.type === "Buffer" && Array.isArray(value.data)) {
    return { type: "Buffer", data: Buffer.from(value.data).toString("base64") };
  }
  return value;
}

function reviveBuffer(value) {
  if (value?.type !== "Buffer") return value;
  if (typeof value.data === "string") return Buffer.from(value.data, "base64");
  if (Array.isArray(value.data)) return Buffer.from(value.data);
  return value;
}

async function fingerprintVisit(root, candidate, entries) {
  const inspected = await lstat(candidate);
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (inspected.isSymbolicLink()) {
    const target = await readlink(candidate);
    entries.push({ relative, type: "symlink", target, sha256: digest(Buffer.from(target)) });
    return;
  }
  if (inspected.isFile()) {
    const bytes = await readFile(candidate);
    entries.push({ relative, type: "file", size: bytes.byteLength, sha256: digest(bytes) });
    return;
  }
  if (!inspected.isDirectory()) return;
  for (const name of (await readdir(candidate)).sort()) await fingerprintVisit(root, path.join(candidate, name), entries);
}

async function writeBytesAtomic(filePath, bytes, {
  lease = null,
  noReplace = false,
  temporaryPath = null,
  retainTemporaryOnError = false,
  onTemporaryReady = null,
  onMutationApplied = null,
  beforeMutation = null,
  pathClass = null,
  authorizedParentPath = undefined,
  authorizedRootPath = undefined,
} = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath ?? `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  const handle = await open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  try {
    if (onTemporaryReady) await onTemporaryReady(temporary);
    if (noReplace) {
      if (!lease || typeof lease.renameNoReplace !== "function") throw new Error("no-replace identity publication requires the live native mutation-session lease");
      if (beforeMutation) await beforeMutation();
      await lease.renameNoReplace(temporary, filePath, {
        pathClass,
        authorizedParentPath,
        authorizedRootPath,
        onMutationApplied,
      });
    } else {
      await rename(temporary, filePath);
    }
  } catch (error) {
    if (!retainTemporaryOnError) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function inspectStagedPackage(inspect, stagingPath) {
  const inspected = await inspect(stagingPath);
  if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)) {
    throw new Error("staged package validation did not return one plain identity");
  }
  return inspected;
}

async function assertArtifactBindingStillCurrent(binding, source) {
  if (!binding) return;
  await assertArtifactBindingCurrent(binding, source);
}

async function assertArtifactBindingCurrent(binding, source) {
  assertMasGateArtifactBinding(binding, { bundlePath: source });
  const manifestBytes = await readFile(binding.manifestPath).catch((error) => {
    throw new Error(`validated MAS manifest is unavailable before package mutation: ${error.message}`);
  });
  if (digest(manifestBytes) !== binding.manifestSha256) {
    throw new Error("validated MAS manifest changed before package mutation");
  }
  const sourceFingerprint = await fingerprintPath(source);
  if (sourceFingerprint !== binding.bundleFingerprint) {
    throw new Error("validated MAS artifact source changed before package mutation");
  }
}

function assertCanonicalPackagePath(candidate, label) {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate || candidate.includes("\0")) {
    throw new Error(`${label} must be one exact canonical absolute path`);
  }
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function digest(bytes) {
  return bytes === null || bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("package identity authorization requires process UID support");
  return process.getuid();
}

function fingerprintFileBytes(bytes) {
  return digest(Buffer.from(JSON.stringify([{
    relative: "",
    type: "file",
    size: bytes.byteLength,
    sha256: digest(bytes),
  }])));
}

function runtimeRootPathFor(value, options = {}) {
  const candidate = value?.runtimeRootPath ?? options.runtimeRootPath ?? path.dirname(value?.identityPath ?? "");
  assertCanonicalPackagePath(candidate, "package transaction runtime root");
  return candidate;
}

function packageRenameOptions(target) {
  return {
    pathClass: "package-sibling",
    authorizedParentPath: path.dirname(target),
  };
}

function protectedRenameOptions(transaction, source, destination) {
  const packageParentPath = path.dirname(transaction.target);
  if (path.dirname(source) === packageParentPath && path.dirname(destination) === packageParentPath) {
    return packageRenameOptions(transaction.target);
  }
  const runtimeRootPath = path.dirname(transaction.identityPath);
  if (path.dirname(source) === runtimeRootPath && path.dirname(destination) === runtimeRootPath) {
    return {
      pathClass: "runtime-child",
      authorizedRootPath: runtimeRootPath,
    };
  }
  throw new Error("package protected move is outside the authorized package/runtime path classes");
}

export function serializeSortedJson(value) {
  const encoded = writeFoundationJsonValue(value, 0, "root");
  if (encoded === undefined) throw new Error("cannot serialize package identity as JSON");
  return Buffer.from(`${encoded}\n`);
}

function writeFoundationJsonValue(value, indent, context) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const values = value.map((entry, index) =>
      writeFoundationJsonValue(entry, indent + 2, `${context}[${index}]`) ?? "null",
    );
    const childIndent = " ".repeat(indent + 2);
    const currentIndent = " ".repeat(indent);
    return values.length === 0
      ? `[\n\n${currentIndent}]`
      : `[\n${values.map((entry) => `${childIndent}${entry}`).join(",\n")}\n${currentIndent}]`;
  }
  if (typeof value === "string") return writeFoundationJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`cannot serialize package identity value at ${context}`);
    return encoded;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") throw new Error(`cannot serialize package identity value at ${context}`);

  const entries = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = writeFoundationJsonValue(value[key], indent + 2, `${context}.${key}`);
    if (encoded !== undefined) entries.push([key, encoded]);
  }
  const childIndent = " ".repeat(indent + 2);
  const currentIndent = " ".repeat(indent);
  return entries.length === 0
    ? `{\n\n${currentIndent}}`
    : `{\n${entries.map(([key, encoded]) => `${childIndent}${writeFoundationJsonString(key)} : ${encoded}`).join(",\n")}\n${currentIndent}}`;
}

function writeFoundationJsonString(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("cannot serialize package identity string");
  let result = "";
  for (const character of encoded) result += character === "/" ? "\\/" : character;
  return result;
}
