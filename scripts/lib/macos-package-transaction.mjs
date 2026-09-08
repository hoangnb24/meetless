import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireMasGateLock, assertMasGateMutationLease, masGateLockPath } from "./macos-mas-gate-lock.mjs";
import { assertMasGateArtifactBinding, freezeMasGateArtifactBinding } from "./mas-gate-artifact-binding.mjs";
import { assertMacOSPackageParent } from "./macos-package-parent-policy.mjs";

export const PACKAGE_TRANSACTION_SCHEMA = "MAS_PACKAGE_TRANSACTION v4";
export const PACKAGE_TRANSACTION_VERSION = 4;
const MAS_GATE_CLEANUP_DIAGNOSTIC_CODE = "MAS-GATE-CLEANUP-001";
const APPLE_RECEIPT_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
const APPLE_RECEIPT_NEXT_ACTION = "restore the exact signed package and rerun MAS artifact validation";
const APPLE_RECEIPT_LAYOUTS = Object.freeze([
  Object.freeze({
    id: "mas-helpers",
    relativePath: Object.freeze([
      "Contents", "Helpers", "Electron.app", "Contents", "_MASReceipt", "receipt",
    ]),
    directoryRelativePath: Object.freeze([
      "Contents", "Helpers", "Electron.app", "Contents", "_MASReceipt",
    ]),
  }),
  Object.freeze({
    id: "legacy-resources",
    relativePath: Object.freeze([
      "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app", "Contents", "_MASReceipt", "receipt",
    ]),
    directoryRelativePath: Object.freeze([
      "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app", "Contents", "_MASReceipt",
    ]),
  }),
]);
const APPLE_RECEIPT_RELATIVE_PATH = APPLE_RECEIPT_LAYOUTS[0].relativePath;
const APPLE_RECEIPT_DIRECTORY_RELATIVE_PATH = APPLE_RECEIPT_LAYOUTS[0].directoryRelativePath;
const APPLE_RECEIPT_RULE = `the fingerprint exception applies only to one regular file at ${APPLE_RECEIPT_RELATIVE_PATH.join("/")}; historical journals may attest ${APPLE_RECEIPT_LAYOUTS[1].relativePath.join("/")}`;
const APPLE_RECEIPT_RETENTION_RULE = "a rollback cleanup may retain only the exact remaining receipt-bearing disposable tree; receipt bytes are opaque and never read, hashed, or individually mutated";
// MAS_PACKAGE_TRANSACTION v4 remains the coordinator contract. Package
// retention is an explicit versioned nested extension. Legacy v3 receipt
// records are normalized into the retained-package set without being dropped;
// the legacy scalar remains as a compatibility alias for the first record.
const RETAINED_RECEIPT_SCHEMA = "MAS_PACKAGE_RECEIPT_RETENTION v3";
const RETAINED_RECEIPT_VERSION = 3;
const LEGACY_RETAINED_PACKAGE_SCHEMA = "MAS_PACKAGE_DISPOSABLE_RETENTION v1";
const LEGACY_RETAINED_PACKAGE_VERSION = 1;
const LEGACY_RETAINED_PACKAGE_SCHEMA_V2 = "MAS_PACKAGE_DISPOSABLE_RETENTION v2";
const LEGACY_RETAINED_PACKAGE_VERSION_V2 = 2;
const RETAINED_PACKAGE_SCHEMA = "MAS_PACKAGE_DISPOSABLE_RETENTION v3";
const RETAINED_PACKAGE_VERSION = 3;
const RETAINED_PACKAGE_SET_SCHEMA = "MAS_PACKAGE_DISPOSABLE_RETENTION_SET v1";
const RETAINED_PACKAGE_SET_VERSION = 1;
const MAX_RETAINED_PACKAGE_DISPOSABLES = 4;
const RETENTION_INVENTORY_SCHEMA = "MAS_PACKAGE_RECEIPT_INVENTORY v2";
const RETENTION_INVENTORY_VERSION = 2;
const STABLE_ORDINARY_ATTESTATION_SCHEMA = "MAS_PACKAGE_STABLE_ORDINARY_ATTESTATION v1";
const STABLE_ORDINARY_ATTESTATION_VERSION = 1;
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
    cleanupReceiptObserved: false,
    retainedCleanup: null,
    retainedPackageDisposables: emptyRetainedPackageDisposables(),
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
      await assertNoReceiptBearingFinalizationCleanup(transaction, lockedOptions.filesystem);
      await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package", transaction.candidateIdentity, lockedOptions.filesystem);
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

export async function fingerprintPath(root, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const rootInfo = await packageLstat(evidenceFilesystem, root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return null;
  const entries = [];
  await inspectAppleReceiptBoundary(root, evidenceFilesystem);
  await fingerprintVisit(root, root, entries, evidenceFilesystem);
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
    filesystem: record.filesystem,
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
    filesystem: record.filesystem,
  });
  return packageProofResult(record, {
    status: "recoverable",
    state: record.transaction.state,
    currentIdentityBytes: physicalState.identityBytes,
    currentIdentityFingerprint: physicalState.identityFingerprint,
    currentIdentity: physicalState.identity,
    publishedHostIdentity: physicalState.identityDocument,
    retainedPackageUpgrades: physicalState.retainedPackageUpgrades,
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
  const physicalJournalInfo = await packageLstat(adapter, physicalPaths.journal).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!physicalJournalInfo) {
    if (!allowMissing) {
      throw new Error(`package proof journal is missing at the fixed target/run-derived path ${logicalPaths.journal}`);
    }
    const identityInfo = await packageLstat(adapter, physicalIdentityPath).catch((error) => {
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
      const residue = await packageLstat(adapter, candidate).catch((error) => {
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
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
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
    filesystem: adapter,
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
  if (filesystem === undefined) {
    return {
      resolvePath: (candidate) => candidate,
      lstat: (candidate) => lstat(candidate),
      beforeDisposableRemoval: null,
      beforePackageRetentionAttestation: null,
      beforePendingRetainedInspection: null,
      afterPackageRetentionRecordWrite: null,
      afterPackageRetentionUpgradeWrite: null,
    };
  }
  if (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem) ||
      typeof filesystem.resolvePath !== "function" ||
      Object.keys(filesystem).some((name) => !["resolvePath", "lstat", "beforeDisposableRemoval", "beforePackageRetentionAttestation", "beforePendingRetainedInspection", "afterPackageRetentionRecordWrite", "afterPackageRetentionUpgradeWrite"].includes(name)) ||
      (filesystem.lstat !== undefined && typeof filesystem.lstat !== "function") ||
      (filesystem.beforeDisposableRemoval !== undefined && typeof filesystem.beforeDisposableRemoval !== "function") ||
      (filesystem.beforePackageRetentionAttestation !== undefined && typeof filesystem.beforePackageRetentionAttestation !== "function") ||
      (filesystem.beforePendingRetainedInspection !== undefined && typeof filesystem.beforePendingRetainedInspection !== "function") ||
      (filesystem.afterPackageRetentionRecordWrite !== undefined && typeof filesystem.afterPackageRetentionRecordWrite !== "function") ||
      (filesystem.afterPackageRetentionUpgradeWrite !== undefined && typeof filesystem.afterPackageRetentionUpgradeWrite !== "function")) {
    throw new Error("package proof filesystem must expose resolvePath and optional low-level retention evidence seams");
  }
  return {
    resolvePath: filesystem.resolvePath,
    lstat: filesystem.lstat ?? ((candidate) => lstat(candidate)),
    beforeDisposableRemoval: filesystem.beforeDisposableRemoval ?? null,
    beforePackageRetentionAttestation: filesystem.beforePackageRetentionAttestation ?? null,
    beforePendingRetainedInspection: filesystem.beforePendingRetainedInspection ?? null,
    afterPackageRetentionRecordWrite: filesystem.afterPackageRetentionRecordWrite ?? null,
    afterPackageRetentionUpgradeWrite: filesystem.afterPackageRetentionUpgradeWrite ?? null,
  };
}

async function packageLstat(filesystem, candidate) {
  return filesystem.lstat(candidate);
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
  const evidenceFilesystem = options.filesystem;
  await reconcileRetainedPackageUpgrades(transaction, evidenceFilesystem);
  await reconcilePendingCleanup(transaction, lockLease, evidenceFilesystem);
  await reconcileIdentityTemporary(transaction, lockLease, evidenceFilesystem);
  if (transaction.state !== "restoring" && transaction.state !== "target-displaced" &&
      transaction.state !== "target-restored" && transaction.state !== "target-removed" &&
      transaction.state !== "identity-restored") {
    await transition(transaction, "restoring", faultAt);
  }

  const expectedPrior = transaction.previous.targetExists ? transaction.previous.targetFingerprint : null;
  const expectedCandidate = transaction.candidateFingerprint ?? transaction.sourceFingerprint;
  const targetFingerprint = await fingerprintPath(transaction.target, evidenceFilesystem);
  const targetIdentity = await packagePathIdentity(transaction.target, evidenceFilesystem);
  const displacedFingerprint = await fingerprintPath(transaction.paths.displaced, evidenceFilesystem);
  const displacedIdentity = await packagePathIdentity(transaction.paths.displaced, evidenceFilesystem);
  const backupFingerprint = await fingerprintPath(transaction.paths.backup, evidenceFilesystem);
  const backupIdentity = await packagePathIdentity(transaction.paths.backup, evidenceFilesystem);
  const candidateIdentity = transaction.candidateIdentity ?? transaction.stagingIdentity;
  const priorIdentity = transaction.previous.targetIdentity;

  if (displacedFingerprint !== null && displacedFingerprint !== expectedCandidate) {
    throw new Error("refusing package recovery; displaced artifact ownership fingerprint changed");
  }
  if (displacedFingerprint !== null && !samePackageIdentity(displacedIdentity, candidateIdentity)) {
    throw new Error("refusing package recovery; displaced artifact identity changed or is an unowned collision");
  }
  if (targetFingerprint !== null && targetFingerprint !== expectedPrior && targetFingerprint !== expectedCandidate) {
    throw new Error(packageFingerprintBoundaryDiagnostic("refusing package recovery; canonical target changed outside the package transaction"));
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
    const stagingIdentity = await packagePathIdentity(transaction.paths.staging, evidenceFilesystem);
    if (stagingIdentity !== null && !samePackageIdentity(stagingIdentity, transaction.stagingIdentity)) {
      throw new Error("refusing package recovery; package staging identity changed outside the transaction");
    }
  }

  if (expectedPrior !== null) {
    if (targetFingerprint === expectedCandidate) {
      if (displacedFingerprint !== null) throw new Error("refusing package recovery; two candidate artifacts are present");
      await moveOwnedPath(transaction, transaction.target, transaction.paths.displaced, expectedCandidate, "installed package", lockLease, candidateIdentity, evidenceFilesystem);
      await transition(transaction, "target-displaced", faultAt);
    }
    const currentTarget = await fingerprintPath(transaction.target, evidenceFilesystem);
    if (currentTarget === null) {
      const currentBackup = await fingerprintPath(transaction.paths.backup, evidenceFilesystem);
      if (currentBackup !== expectedPrior) {
        throw new Error("refusing package recovery; prior package backup is missing or changed");
      }
      await assertOwnedPath(transaction.paths.backup, expectedPrior, "prior package backup", priorIdentity, evidenceFilesystem);
      await lockLease.renameNoReplace(transaction.paths.backup, transaction.target, packageRenameOptions(transaction.target));
      await assertOwnedPath(transaction.target, expectedPrior, "restored prior package", priorIdentity, evidenceFilesystem);
      await transition(transaction, "target-restored", faultAt);
    } else if (currentTarget === expectedPrior) {
      if (backupFingerprint !== null) {
        if (backupFingerprint !== expectedPrior) throw new Error("refusing package recovery; backup ownership fingerprint changed");
        await removeOwnedPath(transaction, transaction.paths.backup, expectedPrior, "prior package backup", lockLease, priorIdentity, evidenceFilesystem);
      }
      if (transaction.state === "target-displaced") await transition(transaction, "target-restored", faultAt);
    } else {
      throw new Error("refusing package recovery; canonical target is neither the prior nor candidate package");
    }
  } else {
    if (targetFingerprint === expectedCandidate) {
      await removeOwnedPath(transaction, transaction.target, expectedCandidate, "installed package", lockLease, candidateIdentity, evidenceFilesystem);
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
    await removeOwnedPath(transaction, transaction.paths.displaced, expectedCandidate, "displaced package", lockLease, candidateIdentity, evidenceFilesystem);
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction, transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging", lockLease, transaction.stagingIdentity, evidenceFilesystem);
  }
  await restoreIdentity(transaction, lockLease, evidenceFilesystem);
  if (transaction.state !== "identity-restored") await transition(transaction, "identity-restored", faultAt);
  if (transaction.retainedPackageDisposables.records.length === 0) await removeJournal(transaction);
}

async function finishFinalization(transaction, options = {}) {
  const { faultAt, lockLease } = options;
  const evidenceFilesystem = options.filesystem;
  await assertNoReceiptBearingFinalizationCleanup(transaction, evidenceFilesystem);
  await reconcilePendingCleanup(transaction, lockLease, evidenceFilesystem);
  await reconcileIdentityTemporary(transaction, lockLease, evidenceFilesystem);
  await assertNoReceiptBearingFinalizationCleanup(transaction, evidenceFilesystem);
  await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package", transaction.candidateIdentity, evidenceFilesystem);
  await assertIdentityState(transaction, transaction.nextIdentityFingerprint);
  if (await exists(transaction.paths.backup)) {
    await removeOwnedPath(transaction, transaction.paths.backup, transaction.backupFingerprint, "prior package backup", lockLease, transaction.backupIdentity ?? transaction.previous.targetIdentity, evidenceFilesystem);
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction, transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging", lockLease, transaction.stagingIdentity, evidenceFilesystem);
  }
  if (await exists(transaction.paths.displaced)) {
    await removeOwnedPath(transaction, transaction.paths.displaced, transaction.candidateFingerprint, "displaced package", lockLease, transaction.candidateIdentity, evidenceFilesystem);
  }
  if (transaction.state !== "finalized") await transition(transaction, "finalized", faultAt);
  await removeJournal(transaction);
}

async function assertNoReceiptBearingFinalizationCleanup(transaction, filesystem = undefined) {
  if (isPackageRollbackState(transaction.state)) return;
  const candidates = [
    [transaction.paths.backup, "prior package backup"],
    [transaction.paths.staging, "package staging"],
    [transaction.paths.displaced, "displaced package"],
  ];
  if (transaction.cleanupPath !== null) candidates.push([transaction.cleanupPath, "pending package cleanup disposable"]);
  if (transaction.cleanupSource !== null) candidates.push([transaction.cleanupSource, "pending package cleanup source"]);
  if (transaction.identityTemporaryPath !== null) candidates.push([transaction.identityTemporaryPath, "package identity temporary"]);
  for (const retained of transaction.retainedPackageDisposables.records) {
    candidates.push([retained.path, "retained package cleanup disposable"]);
  }
  for (const [candidate, label] of candidates) {
    if (!(await exists(candidate))) continue;
    const boundary = await inspectAppleReceiptBoundary(candidate, filesystem);
    if (boundary.kind === "invalid") throw boundary.error;
    if (boundary.kind === "valid") {
      throw packageCleanupError(`finalization found receipt-bearing ${label}; finalization refuses before mutation`);
    }
  }
}

async function restoreIdentity(transaction, lockLease, filesystem = undefined) {
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
    const currentIdentity = await packagePathIdentity(transaction.identityPath, filesystem);
    if (transaction.artifactBinding && !sameRecoveryPublishedIdentity(currentIdentity, transaction.identityPublishedIdentity)) {
      throw new Error("refusing to restore package identity; published ownership metadata changed beyond the authorized inode republication");
    }
    const expectedIdentity = currentIdentity;
    if (!expectedIdentity) {
      throw new Error("refusing to restore package identity; published ownership identity is missing");
    }
    await removeOwnedPath(transaction, transaction.identityPath, await fingerprintPath(transaction.identityPath, filesystem), "package identity", lockLease, expectedIdentity, filesystem);
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
  filesystem,
} = {}) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
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
  if (await packagePathIdentity(packageIdentityTemporaryPath(transaction.identityPath, transaction.runId), evidenceFilesystem) !== null) {
    throw new Error("package identity authorization has a temporary or collision identity at the exact run-derived path");
  }
  if (await packagePathIdentity(transaction.paths.staging, evidenceFilesystem) !== null || await packagePathIdentity(transaction.paths.displaced, evidenceFilesystem) !== null) {
    throw new Error("package identity authorization has a staging or displaced package collision");
  }
  const backupFingerprint = await fingerprintPath(transaction.paths.backup, evidenceFilesystem);
  if (transaction.previous.targetExists) {
    assertExactPackageIdentity(transaction.previous.targetIdentity, "package identity authorization prior package identity", "directory");
    assertExactPackageIdentity(transaction.backupIdentity, "package identity authorization backup identity", "directory");
    if (backupFingerprint !== transaction.previous.targetFingerprint ||
      !samePackageIdentity(await packagePathIdentity(transaction.paths.backup, evidenceFilesystem), transaction.previous.targetIdentity) ||
        transaction.backupFingerprint !== transaction.previous.targetFingerprint) {
      throw new Error(packageFingerprintBoundaryDiagnostic("package identity authorization prior-package backup is missing or changed"));
    }
  } else if (backupFingerprint !== null) {
    throw new Error("package identity authorization has a prior-package backup collision for a fresh target");
  }

  const candidateFingerprint = await fingerprintPath(transaction.target, evidenceFilesystem);
  if (candidateFingerprint !== transaction.candidateFingerprint) {
    throw new Error(packageFingerprintBoundaryDiagnostic("package identity authorization candidate package fingerprint changed"));
  }
  const candidateIdentity = await packagePathIdentity(transaction.target, evidenceFilesystem);
  if (!samePackageIdentity(candidateIdentity, transaction.candidateIdentity)) {
    throw new Error("package identity authorization candidate package identity changed");
  }
  const bytes = await readIdentityBytes(transaction.identityPath, "package identity authorization current identity", evidenceFilesystem);
  if (bytes === null) throw new Error("package identity authorization published identity is missing");
  if (!Buffer.isBuffer(bytes) || Buffer.compare(bytes, transaction.nextIdentityBytes) !== 0 || digest(bytes) !== transaction.nextIdentityFingerprint) {
    throw new Error("package identity authorization current bytes do not exactly match nextIdentityBytes and digest");
  }
  const metadata = await packagePathIdentity(transaction.identityPath, evidenceFilesystem);
  if (!samePackageIdentity(metadata, transaction.identityPublishedIdentity)) {
    throw new Error("package identity authorization current file metadata does not exactly match identityPublishedIdentity");
  }
  return { bytes, digest: transaction.nextIdentityFingerprint, metadata, document: identityDocument };
}

async function assertAuthorizedRecoverablePackageState(transaction, {
  expectedArtifactBinding,
  runtimeRootPath,
  filesystem,
} = {}) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
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
  const target = await packagePathSnapshot(transaction.target, evidenceFilesystem);
  const staging = await packagePathSnapshot(transaction.paths.staging, evidenceFilesystem);
  const backup = await packagePathSnapshot(transaction.paths.backup, evidenceFilesystem);
  const displaced = await packagePathSnapshot(transaction.paths.displaced, evidenceFilesystem);
  const identity = await identitySnapshot(transaction.identityPath, evidenceFilesystem);
  const temporary = await packagePathSnapshot(packageIdentityTemporaryPath(transaction.identityPath, transaction.runId), evidenceFilesystem);

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
      throw new Error(packageFingerprintBoundaryDiagnostic(`package recovery ${state} staging artifact is missing or changed`));
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
    throw new Error(packageFingerprintBoundaryDiagnostic(`package recovery ${state} candidate package is missing or changed`));
  }

  const backupExpected = transaction.previous.targetExists &&
    ["target-backed-up", "candidate-installed", "identity-published", "committed", "target-displaced"].includes(state);
  const backupAllowedInFlight = transaction.previous.targetExists && state === "restoring" &&
    (target.fingerprint === null || target.fingerprint === candidateFingerprint);
  if (backupExpected || backupAllowedInFlight) {
    if (backup.fingerprint !== priorFingerprint || !samePackageIdentity(backup.identity, priorIdentity) ||
        transaction.backupFingerprint !== priorFingerprint) {
      throw new Error(packageFingerprintBoundaryDiagnostic(`package recovery ${state} prior package backup is missing or changed`));
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
    throw new Error(packageFingerprintBoundaryDiagnostic(`package recovery ${state} prior package target is missing or changed`));
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
      throw new Error(packageFingerprintBoundaryDiagnostic(`package recovery ${state} displaced candidate is missing or changed`));
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
  const cleanupState = await assertRecoveryCleanupState(transaction, state, evidenceFilesystem);
  return {
    identityBytes: identity.bytes,
    identityFingerprint: identity.fingerprint,
    identity: identity.identity,
    identityDocument,
    retainedPackageUpgrades: cleanupState.retainedPackageUpgrades,
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

async function packagePathSnapshot(candidate, filesystem = undefined) {
  return {
    fingerprint: await fingerprintPath(candidate, filesystem),
    identity: await packagePathIdentity(candidate, filesystem),
  };
}

async function identitySnapshot(candidate, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const info = await packageLstat(evidenceFilesystem, candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { bytes: null, fingerprint: null, identity: null };
  const identity = packageIdentityOf(info);
  if (!info.isFile() || info.isSymbolicLink()) {
    return { bytes: null, fingerprint: await fingerprintPath(candidate, evidenceFilesystem), identity };
  }
  const bytes = await readFile(candidate);
  return {
    bytes,
    fingerprint: digest(bytes),
    identity,
  };
}

async function readIdentityBytes(candidate, label, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const info = await packageLstat(evidenceFilesystem, candidate).catch((error) => {
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

async function assertRecoveryCleanupState(transaction, state, filesystem = undefined) {
  try {
    return await assertRecoveryCleanupStateUnchecked(transaction, state, filesystem);
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw packageCleanupError(`package recovery ${state} cleanup validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertRecoveryCleanupStateUnchecked(transaction, state, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const retainedRecords = transaction.retainedPackageDisposables.records;
  const retainedPackageUpgrades = [];
  if (retainedRecords.length > 0) {
    if (!isPackageRollbackState(state)) {
      throw packageCleanupError(`package recovery ${state} contains retained package evidence outside rollback`);
    }
    for (const [index, retained] of retainedRecords.entries()) {
      const inspection = await inspectRetainedPackageCleanup(transaction, retained, evidenceFilesystem, `package recovery retained package ${index}`);
      if (inspection.upgrade !== null) retainedPackageUpgrades.push(inspection.upgrade.description);
    }
  }

  const cleanupKind = assertCleanupIntentStructure(transaction, `package recovery ${state}`);
  const pending = retainedRecords.find((record) => record.path === transaction.cleanupPath && record.source === transaction.cleanupSource);
  await assertNoUnexpectedCleanupCollisions(
    transaction,
    state,
    retainedRecords,
    cleanupKind === null ? null : transaction.cleanupPath,
    evidenceFilesystem,
  );
  if (cleanupKind === null) {
    return { retainedPackageDisposables: transaction.retainedPackageDisposables, retainedPackageUpgrades };
  }

  if (pending) {
    if (cleanupKind !== "package") {
      throw packageCleanupError(`package recovery ${state} retained package evidence is not bound to a package path`);
    }
    const source = await packagePathSnapshot(transaction.cleanupSource, evidenceFilesystem);
    const disposable = await packagePathSnapshot(transaction.cleanupPath, evidenceFilesystem);
    if (source.fingerprint !== null || disposable.fingerprint === null ||
        transaction.cleanupFingerprint !== (pending.packageFingerprint ?? pending.candidateFingerprint) ||
        !samePackageDirectoryBinding(transaction.cleanupIdentity, pending.rootIdentity) ||
        !samePackageDirectoryBinding(disposable.identity, pending.rootIdentity)) {
      throw packageCleanupError(`package recovery ${state} retained package evidence does not match its durable disposable`);
    }
    return { retainedPackageDisposables: transaction.retainedPackageDisposables, retainedPackageUpgrades };
  }

  const temporaryCleanupInFlight = state === "candidate-installed" &&
    transaction.identityTemporaryPath !== null && transaction.cleanupSource === transaction.identityTemporaryPath;
  if (!["restoring", "target-displaced", "target-restored", "target-removed", "identity-restored"].includes(state) &&
      !temporaryCleanupInFlight) {
    throw packageCleanupError(`package recovery ${state} contains cleanup intent before rollback`);
  }
  const cleanupLabel = cleanupLabelForSource(transaction, transaction.cleanupSource);
  const source = await packagePathSnapshot(transaction.cleanupSource, evidenceFilesystem);
  const disposable = await packagePathSnapshot(transaction.cleanupPath, evidenceFilesystem);
  if (source.fingerprint !== null && disposable.fingerprint !== null) {
    throw packageCleanupError(`package recovery ${state} cleanup source and disposable are both present`);
  }
  if (source.fingerprint !== null && (source.fingerprint !== transaction.cleanupFingerprint ||
      !samePackageIdentity(source.identity, transaction.cleanupIdentity))) {
    throw packageCleanupError(`package recovery ${state} cleanup source ownership changed`);
  }
  if (source.fingerprint === null && disposable.fingerprint !== null) {
    if (cleanupKind === "package") {
      await inspectPackageCleanupResidue(transaction, {
        path: transaction.cleanupPath,
        source: transaction.cleanupSource,
        label: cleanupLabel,
        packageFingerprint: transaction.cleanupFingerprint,
        rootIdentity: transaction.cleanupIdentity,
      }, evidenceFilesystem, { sourceRoot: transaction.source, buildRecord: false });
      return { retainedPackageDisposables: transaction.retainedPackageDisposables, retainedPackageUpgrades };
    }
  }
  if (disposable.fingerprint !== null && (disposable.fingerprint !== transaction.cleanupFingerprint ||
      !samePackageIdentity(disposable.identity, transaction.cleanupIdentity))) {
    throw packageCleanupError(`package recovery ${state} cleanup disposable ownership changed`);
  }
  if (source.fingerprint === null && disposable.fingerprint === null) {
    throw packageCleanupError(`package recovery ${state} cleanup source and disposable are both missing`);
  }
  return { retainedPackageDisposables: transaction.retainedPackageDisposables, retainedPackageUpgrades };
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

async function assertOwnedPath(candidate, expectedFingerprint, label, expectedIdentity = null, filesystem = undefined) {
  const actual = await fingerprintPath(candidate, filesystem);
  if (actual !== expectedFingerprint) throw new Error(`refusing to modify ${label}; ownership fingerprint changed`);
  if (expectedIdentity !== null && !samePackageIdentity(await packagePathIdentity(candidate, filesystem), expectedIdentity)) {
    throw new Error(`refusing to modify ${label}; ownership identity changed`);
  }
}

async function packagePathIdentity(candidate, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const info = await packageLstat(evidenceFilesystem, candidate).catch((error) => {
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

function samePackageDirectoryBinding(actual, expected) {
  return Boolean(actual && expected) && ["type", "mode", "uid", "gid", "dev", "ino"].every((field) => actual[field] === expected[field]);
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

async function removeOwnedPath(transaction, candidate, expectedFingerprint, label = "transaction path", lease, expectedIdentity = null, filesystem = undefined) {
  if (!lease || typeof lease.renameNoReplace !== "function") throw new Error(`cannot remove ${label} without the live native mutation-session lease`);
  if (!expectedIdentity) throw new Error(`cannot remove ${label} without its durable ownership identity`);
  if (!(await exists(candidate))) return;
  const sourceReceiptBoundary = await inspectAppleReceiptBoundary(candidate, filesystem);
  if (sourceReceiptBoundary.kind === "invalid") throw sourceReceiptBoundary.error;
  const receiptObserved = sourceReceiptBoundary.kind === "valid";
  if (receiptObserved && !isPackageRollbackState(transaction.state)) {
    throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
  }
  if (receiptObserved) {
    await inspectReceiptCleanupResidue(transaction, {
      path: candidate,
      source: candidate,
      label,
      packageFingerprint: expectedFingerprint,
      rootIdentity: expectedIdentity,
    }, filesystem, { sourceRoot: transaction.source, buildRecord: false });
  }
  await assertOwnedPath(candidate, expectedFingerprint, label, expectedIdentity, filesystem);
  const disposable = cleanupPathFor(transaction, candidate, label);
  const existingDisposable = await fingerprintPath(disposable, filesystem);
  if (existingDisposable !== null) {
    throw new Error(`refusing to remove ${label}; disposable cleanup path already exists`);
  }
  transaction.cleanupPath = disposable;
  transaction.cleanupSource = candidate;
  transaction.cleanupFingerprint = expectedFingerprint;
  transaction.cleanupIdentity = expectedIdentity;
  transaction.cleanupReceiptObserved = receiptObserved;
  await writeJournal(transaction);
  if (await exists(candidate)) {
    await lease.renameNoReplace(candidate, disposable, protectedRenameOptions(transaction, candidate, disposable));
  }
  let disposableReceiptBoundary = await inspectAppleReceiptBoundary(disposable, filesystem);
  if (disposableReceiptBoundary.kind === "invalid") throw disposableReceiptBoundary.error;
  if (receiptObserved && disposableReceiptBoundary.kind !== "valid") {
    throw packageCleanupError("receipt-bearing cleanup boundary disappeared or changed after the owned rename; refusing deletion");
  }
  await assertOwnedPath(disposable, expectedFingerprint, `${label} disposable`, expectedIdentity, filesystem);
  disposableReceiptBoundary = await inspectAppleReceiptBoundary(disposable, filesystem);
  if (disposableReceiptBoundary.kind === "invalid") throw disposableReceiptBoundary.error;
  if (isPackageRollbackState(transaction.state) && isPackageTransactionPath(transaction, candidate)) {
    await retainPackageCleanup(transaction, {
      path: disposable,
      source: candidate,
      label,
      packageFingerprint: expectedFingerprint,
      rootIdentity: expectedIdentity,
    }, filesystem);
    return;
  }
  if (disposableReceiptBoundary.kind === "valid") {
    if (!isPackageRollbackState(transaction.state)) {
      throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
    }
    await retainReceiptCleanup(transaction, {
      path: disposable,
      source: candidate,
      label,
      packageFingerprint: expectedFingerprint,
      rootIdentity: expectedIdentity,
    }, filesystem);
    return;
  }
  if (receiptObserved) {
    throw packageCleanupError("receipt-bearing cleanup boundary disappeared or changed before deletion");
  }
  await filesystem?.beforeDisposableRemoval?.(disposable);
  const cleanupResult = await removeDisposableTreeWithoutRecursiveRm(disposable, filesystem);
  if (cleanupResult.receiptBoundary.kind === "valid") {
    transaction.cleanupReceiptObserved = true;
    await writeJournal(transaction);
    if (!isPackageRollbackState(transaction.state)) {
      throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
    }
    await retainReceiptCleanup(transaction, {
      path: disposable,
      source: candidate,
      label,
      packageFingerprint: expectedFingerprint,
      rootIdentity: expectedIdentity,
    }, filesystem);
    return;
  }
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
  transaction.cleanupReceiptObserved = false;
  await writeJournal(transaction);
}

async function moveOwnedPath(transaction, source, destination, expectedFingerprint, label, lease, expectedIdentity = null, filesystem = undefined) {
  if (!lease || typeof lease.renameNoReplace !== "function") throw new Error(`cannot move ${label} without the live native mutation-session lease`);
  if (!expectedIdentity) throw new Error(`cannot move ${label} without its durable ownership identity`);
  await assertOwnedPath(source, expectedFingerprint, label, expectedIdentity, filesystem);
  if (await exists(destination)) throw new Error(`refusing to move ${label}; destination already exists`);
  await lease.renameNoReplace(source, destination, protectedRenameOptions(transaction, source, destination));
  await assertOwnedPath(destination, expectedFingerprint, `moved ${label}`, expectedIdentity, filesystem);
}

async function reconcileRetainedPackageUpgrades(transaction, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  if (transaction.retainedPackageDisposables.records.length === 0) return;
  const upgrades = [];
  for (const [index, retained] of transaction.retainedPackageDisposables.records.entries()) {
    const inspection = await inspectRetainedPackageCleanup(
      transaction,
      retained,
      evidenceFilesystem,
      `package recovery retained package ${index}`,
    );
    if (inspection.upgrade !== null) upgrades.push(inspection.upgrade);
  }
  if (upgrades.length === 0) return;
  await applyRetainedPackageUpgrades(transaction, upgrades, evidenceFilesystem);
}

async function applyRetainedPackageUpgrades(transaction, upgrades, filesystem) {
  if (upgrades.length === 0) return;
  const applied = [];
  for (const upgrade of upgrades) {
    const index = transaction.retainedPackageDisposables.records.findIndex((record) =>
      record.source === upgrade.record.source && record.path === upgrade.record.path);
    if (index < 0) throw packageCleanupError("package recovery retained receipt upgrade lost its exact journal record");
    const previous = transaction.retainedPackageDisposables.records[index];
    transaction.retainedPackageDisposables.records[index] = upgrade.record;
    if (transaction.retainedCleanup !== null &&
        Buffer.compare(serializeSortedJson(transaction.retainedCleanup), serializeSortedJson(previous)) === 0) {
      transaction.retainedCleanup = upgrade.record;
    }
    applied.push(upgrade.record);
  }
  await writeJournal(transaction);
  await filesystem?.afterPackageRetentionUpgradeWrite?.(applied);
}

async function reconcilePendingCleanup(transaction, lease, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  if (!transaction.cleanupPath) return;
  if (!transaction.cleanupSource || !transaction.cleanupFingerprint || !transaction.cleanupIdentity) {
    throw new Error("refusing package recovery; cleanup intent is incomplete");
  }
  const packageCleanup = isPackageRollbackState(transaction.state) &&
    isPackageTransactionPath(transaction, transaction.cleanupSource);
  const pendingRetained = transaction.retainedPackageDisposables.records.find((record) =>
    record.source === transaction.cleanupSource && record.path === transaction.cleanupPath);
  if (pendingRetained) {
    if (!packageCleanup) throw packageCleanupError("retained package provenance is attached to a non-package cleanup intent");
    await evidenceFilesystem.beforePendingRetainedInspection?.(pendingRetained);
    const inspection = await inspectRetainedPackageCleanup(transaction, pendingRetained, evidenceFilesystem, "package recovery pending retained package");
    if (inspection.upgrade !== null) {
      await applyRetainedPackageUpgrades(transaction, [inspection.upgrade], evidenceFilesystem);
    }
    const appliedPendingRetained = transaction.retainedPackageDisposables.records.find((record) =>
      record.source === transaction.cleanupSource && record.path === transaction.cleanupPath);
    if (!appliedPendingRetained) throw packageCleanupError("package recovery pending retained package lost its exact journal record");
    const pendingSource = await packagePathSnapshot(transaction.cleanupSource, evidenceFilesystem);
    const pendingDisposable = await packagePathSnapshot(transaction.cleanupPath, evidenceFilesystem);
    if (pendingSource.fingerprint !== null || pendingDisposable.fingerprint === null ||
        transaction.cleanupFingerprint !== (appliedPendingRetained.packageFingerprint ?? appliedPendingRetained.candidateFingerprint) ||
        !samePackageDirectoryBinding(transaction.cleanupIdentity, appliedPendingRetained.rootIdentity) ||
        !samePackageDirectoryBinding(pendingDisposable.identity, appliedPendingRetained.rootIdentity)) {
      throw packageCleanupError("package recovery pending retained package is not at its journaled disposable path");
    }
    clearCleanupIntent(transaction, transaction.cleanupSource === transaction.identityTemporaryPath && transaction.identityTemporaryPath !== null);
    await writeJournal(transaction);
    return;
  }
  const sourceFingerprint = await fingerprintPath(transaction.cleanupSource, evidenceFilesystem);
  const sourceIdentity = await packagePathIdentity(transaction.cleanupSource, evidenceFilesystem);
  let disposableFingerprint = await fingerprintPath(transaction.cleanupPath, evidenceFilesystem);
  let disposableIdentity = await packagePathIdentity(transaction.cleanupPath, evidenceFilesystem);
  if (sourceFingerprint !== null && disposableFingerprint !== null) {
    throw new Error("refusing package recovery; cleanup source and disposable are both present");
  }
  if (sourceFingerprint !== null && sourceFingerprint !== transaction.cleanupFingerprint) {
    throw new Error("refusing package recovery; cleanup source ownership fingerprint changed");
  }
  if (sourceIdentity !== null && !samePackageIdentity(sourceIdentity, transaction.cleanupIdentity)) {
    throw new Error("refusing package recovery; cleanup source ownership identity changed");
  }
  if (sourceFingerprint === null && disposableFingerprint === null) {
    throw new Error("refusing package recovery; cleanup source and disposable are both missing");
  }
  const identityTemporaryCleanup = transaction.cleanupSource === transaction.identityTemporaryPath &&
    transaction.identityTemporaryPath !== null;
  const sourceReceiptBoundary = sourceFingerprint === null
    ? { kind: "absent" }
    : await inspectAppleReceiptBoundary(transaction.cleanupSource, evidenceFilesystem);
  if (sourceReceiptBoundary.kind === "invalid") throw sourceReceiptBoundary.error;
  if (transaction.cleanupReceiptObserved && sourceFingerprint !== null && sourceReceiptBoundary.kind !== "valid") {
    throw packageCleanupError("receipt-bearing cleanup boundary disappeared or changed before recovery resumed; refusing deletion");
  }
  if (sourceReceiptBoundary.kind === "valid" && !isPackageRollbackState(transaction.state)) {
    throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
  }
  if (sourceReceiptBoundary.kind === "valid") {
    if (!transaction.cleanupReceiptObserved) {
      transaction.cleanupReceiptObserved = true;
      await writeJournal(transaction);
    }
    await inspectReceiptCleanupResidue(transaction, {
      path: transaction.cleanupSource,
      source: transaction.cleanupSource,
      label: cleanupLabelForSource(transaction, transaction.cleanupSource),
      packageFingerprint: transaction.cleanupFingerprint,
      rootIdentity: transaction.cleanupIdentity,
    }, evidenceFilesystem, { sourceRoot: transaction.source, buildRecord: false });
  }
  if (sourceFingerprint !== null) {
    await lease.renameNoReplace(
      transaction.cleanupSource,
      transaction.cleanupPath,
      protectedRenameOptions(transaction, transaction.cleanupSource, transaction.cleanupPath),
    );
  }
  disposableFingerprint = await fingerprintPath(transaction.cleanupPath, evidenceFilesystem);
  disposableIdentity = await packagePathIdentity(transaction.cleanupPath, evidenceFilesystem);
  let disposableReceiptBoundary = await inspectAppleReceiptBoundary(transaction.cleanupPath, evidenceFilesystem);
  if (disposableReceiptBoundary.kind === "invalid") throw disposableReceiptBoundary.error;
  if (disposableReceiptBoundary.kind === "valid" && !transaction.cleanupReceiptObserved) {
    transaction.cleanupReceiptObserved = true;
    await writeJournal(transaction);
  }
  if (disposableReceiptBoundary.kind === "valid") {
    if (!isPackageRollbackState(transaction.state)) {
      throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
    }
    await retainReceiptCleanup(transaction, {
      path: transaction.cleanupPath,
      source: transaction.cleanupSource,
      label: cleanupLabelForSource(transaction, transaction.cleanupSource),
      packageFingerprint: transaction.cleanupFingerprint,
      rootIdentity: transaction.cleanupIdentity,
    }, evidenceFilesystem, identityTemporaryCleanup);
    return;
  }
  if (transaction.cleanupReceiptObserved) {
    throw packageCleanupError("receipt-bearing cleanup boundary disappeared or changed before deletion resumed");
  }
  if (disposableFingerprint !== null && disposableFingerprint !== transaction.cleanupFingerprint) {
    throw new Error("refusing package recovery; cleanup disposable ownership fingerprint changed");
  }
  if (disposableIdentity !== null && !samePackageIdentity(disposableIdentity, transaction.cleanupIdentity)) {
    throw new Error("refusing package recovery; cleanup disposable ownership identity changed");
  }
  await assertOwnedPath(transaction.cleanupPath, transaction.cleanupFingerprint, "cleanup disposable", transaction.cleanupIdentity, evidenceFilesystem);
  disposableReceiptBoundary = await inspectAppleReceiptBoundary(transaction.cleanupPath, evidenceFilesystem);
  if (disposableReceiptBoundary.kind === "invalid") throw disposableReceiptBoundary.error;
  if (disposableReceiptBoundary.kind === "valid") {
    transaction.cleanupReceiptObserved = true;
    await writeJournal(transaction);
    if (!isPackageRollbackState(transaction.state)) {
      throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
    }
    await retainReceiptCleanup(transaction, {
      path: transaction.cleanupPath,
      source: transaction.cleanupSource,
      label: cleanupLabelForSource(transaction, transaction.cleanupSource),
      packageFingerprint: transaction.cleanupFingerprint,
      rootIdentity: transaction.cleanupIdentity,
    }, evidenceFilesystem, identityTemporaryCleanup);
    return;
  }
  if (packageCleanup) {
    await retainPackageCleanup(transaction, {
      path: transaction.cleanupPath,
      source: transaction.cleanupSource,
      label: cleanupLabelForSource(transaction, transaction.cleanupSource),
      packageFingerprint: transaction.cleanupFingerprint,
      rootIdentity: transaction.cleanupIdentity,
    }, evidenceFilesystem, identityTemporaryCleanup);
    return;
  }
  await evidenceFilesystem.beforeDisposableRemoval?.(transaction.cleanupPath);
  const cleanupResult = await removeDisposableTreeWithoutRecursiveRm(transaction.cleanupPath, evidenceFilesystem);
  if (cleanupResult.receiptBoundary.kind === "valid") {
    transaction.cleanupReceiptObserved = true;
    await writeJournal(transaction);
    if (!isPackageRollbackState(transaction.state)) {
      throw packageCleanupError(`receipt-bearing cleanup is not authorized during ${transaction.state}; finalization must not delete it`);
    }
    await retainReceiptCleanup(transaction, {
      path: transaction.cleanupPath,
      source: transaction.cleanupSource,
      label: cleanupLabelForSource(transaction, transaction.cleanupSource),
      packageFingerprint: transaction.cleanupFingerprint,
      rootIdentity: transaction.cleanupIdentity,
    }, evidenceFilesystem, identityTemporaryCleanup);
    return;
  }
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
  transaction.cleanupReceiptObserved = false;
  if (identityTemporaryCleanup) {
    transaction.identityTemporaryPath = null;
    transaction.identityTemporaryFingerprint = null;
    transaction.identityTemporaryIdentity = null;
  }
  await writeJournal(transaction);
}

async function removeDisposableTreeWithoutRecursiveRm(root, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const rootInfo = await packageLstat(evidenceFilesystem, root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) throw packageCleanupError(`receipt-safe cleanup disposable root disappeared before deletion: ${root}`);
  if (!rootInfo.isDirectory()) {
    const boundary = await inspectAppleReceiptBoundary(root, evidenceFilesystem);
    if (boundary.kind === "invalid") throw boundary.error;
    if (boundary.kind === "valid") return { receiptBoundary: boundary };
    if (!rootInfo.isFile() && !rootInfo.isSymbolicLink()) {
      throw packageCleanupError(`receipt-safe cleanup cannot remove unsupported disposable root ${root}`);
    }
    await unlink(root);
    return { receiptBoundary: { kind: "absent" } };
  }
  const snapshot = await collectReceiptRetentionSnapshot(root, filesystem, { requireReceipt: false });
  if (snapshot.receiptChain !== null || snapshot.receipt !== null) {
    return { receiptBoundary: { kind: "valid" } };
  }
  const entries = [...snapshot.inventory.entries].sort((left, right) => {
    const leftDepth = left.relative.split("/").length;
    const rightDepth = right.relative.split("/").length;
    return rightDepth - leftDepth || right.relative.localeCompare(left.relative);
  });
  for (const entry of entries) {
    const candidate = path.join(root, ...entry.relative.split("/"));
    try {
      if (entry.identity.type === "directory") {
        await rmdir(candidate);
      } else {
        await unlink(candidate);
      }
    } catch (error) {
      const boundary = await inspectAppleReceiptBoundary(root, filesystem);
      if (boundary.kind === "invalid") throw boundary.error;
      if (boundary.kind === "valid") return { receiptBoundary: boundary };
      throw packageCleanupError(`receipt-safe cleanup could not remove the journaled ordinary ${entry.identity.type} ${candidate}: ${error?.code ?? String(error)}`);
    }
  }
  try {
    await rmdir(root);
  } catch (error) {
    const boundary = await inspectAppleReceiptBoundary(root, filesystem);
    if (boundary.kind === "invalid") throw boundary.error;
    if (boundary.kind === "valid") return { receiptBoundary: boundary };
    throw packageCleanupError(`receipt-safe cleanup could not remove the empty disposable root ${root}: ${error?.code ?? String(error)}`);
  }
  return { receiptBoundary: { kind: "absent" } };
}

async function retainPackageCleanup(transaction, {
  path: cleanupPath,
  source,
  label,
  packageFingerprint,
  rootIdentity,
} = {}, filesystem = undefined, identityTemporaryCleanup = false) {
  if (!isPackageRollbackState(transaction.state)) {
    throw packageCleanupError(`package cleanup retention is not authorized during ${transaction.state}`);
  }
  if (!isPackageTransactionPath(transaction, source)) {
    throw packageCleanupError(`package cleanup retention source is not one transaction-owned application package path`);
  }
  await filesystem?.beforePackageRetentionAttestation?.(cleanupPath);
  const retained = await inspectPackageCleanupResidue(transaction, {
    path: cleanupPath,
    source,
    label,
    packageFingerprint,
    rootIdentity,
  }, filesystem, { sourceRoot: transaction.source });
  const records = transaction.retainedPackageDisposables.records;
  if (records.some((record) => record.path === retained.path || record.source === retained.source)) {
    throw packageCleanupError("package cleanup retention would overwrite an existing retained package record");
  }
  if (records.length >= MAX_RETAINED_PACKAGE_DISPOSABLES) {
    throw packageCleanupError("package cleanup retention exceeds the bounded retained package record set");
  }
  records.push(retained);
  if (transaction.retainedCleanup === null) transaction.retainedCleanup = retained;
  // The first write durably records the post-rename provenance while the
  // cleanup intent still points at the moved tree. Only after that fsync may
  // recovery clear the intent; a crash between these writes is recoverable
  // without deleting the package tree.
  await writeJournal(transaction);
  await filesystem?.afterPackageRetentionRecordWrite?.(retained);
  clearCleanupIntent(transaction, identityTemporaryCleanup);
  await writeJournal(transaction);
}

async function retainReceiptCleanup(transaction, details, filesystem = undefined, identityTemporaryCleanup = false) {
  return retainPackageCleanup(transaction, details, filesystem, identityTemporaryCleanup);
}

function clearCleanupIntent(transaction, identityTemporaryCleanup = false) {
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
  transaction.cleanupReceiptObserved = false;
  if (identityTemporaryCleanup) {
    transaction.identityTemporaryPath = null;
    transaction.identityTemporaryFingerprint = null;
    transaction.identityTemporaryIdentity = null;
  }
}

function cleanupPathFor(transaction, candidate, label) {
  const suffix = createHash("sha256").update(`${candidate}\0${label}`).digest("hex").slice(0, 16);
  return `${candidate}.m7-cleanup-${transaction.runId}-${suffix}`;
}

function cleanupLabelForSource(transaction, source) {
  return source === transaction.target ? "installed package"
    : source === transaction.identityPath ? "package identity"
      : source === transaction.paths.staging ? "package staging"
        : source === transaction.paths.backup ? "prior package backup"
          : source === transaction.paths.displaced ? "displaced package"
            : source === transaction.identityTemporaryPath ? "package identity temporary"
              : null;
}

function packageRoleForSource(transaction, source) {
  if ([transaction.target, transaction.paths.staging, transaction.paths.displaced].includes(source)) return "candidate";
  if (source === transaction.paths.backup) return "prior";
  return null;
}

function packageFingerprintForSource(transaction, source) {
  const role = packageRoleForSource(transaction, source);
  if (role === "candidate") return transaction.candidateFingerprint;
  if (role === "prior" && transaction.previous.targetExists) return transaction.previous.targetFingerprint;
  return null;
}

function isPackageTransactionPath(transaction, candidate) {
  return [transaction.target, transaction.paths.staging, transaction.paths.backup, transaction.paths.displaced].includes(candidate);
}

function cleanupSourceKindForTransaction(transaction, source) {
  if (isPackageTransactionPath(transaction, source)) return "package";
  if (source === transaction.identityPath || source === transaction.identityTemporaryPath) return "identity";
  return null;
}

function assertCleanupIntentStructure(transaction, label) {
  const fields = [transaction.cleanupPath, transaction.cleanupSource, transaction.cleanupFingerprint, transaction.cleanupIdentity];
  if (fields.every((value) => value === null)) return null;
  if (fields.some((value) => value === null)) {
    throw packageCleanupError(`${label} cleanup intent is incomplete`);
  }
  assertCanonicalPackagePath(transaction.cleanupPath, `${label} cleanup path`);
  assertCanonicalPackagePath(transaction.cleanupSource, `${label} cleanup source`);
  if (!/^[a-f0-9]{64}$/u.test(transaction.cleanupFingerprint)) {
    throw packageCleanupError(`${label} cleanup ownership fingerprint is invalid`);
  }
  const cleanupKind = cleanupSourceKindForTransaction(transaction, transaction.cleanupSource);
  if (cleanupKind === null) {
    throw packageCleanupError(`${label} cleanup source is outside the transaction-owned path set`);
  }
  const expectedIdentityType = cleanupKind === "package" ? "directory" : "file";
  try {
    assertExactPackageIdentity(transaction.cleanupIdentity, `${label} cleanup identity`, expectedIdentityType);
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw packageCleanupError(`${label} cleanup ownership is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cleanupLabel = cleanupLabelForSource(transaction, transaction.cleanupSource);
  if (!cleanupLabel || transaction.cleanupPath !== cleanupPathFor(transaction, transaction.cleanupSource, cleanupLabel)) {
    throw packageCleanupError(`${label} cleanup path is not the exact deterministic sibling of its source`);
  }
  return cleanupKind;
}

function cleanupSlotsForTransaction(transaction) {
  const slots = [
    [transaction.target, "installed package"],
    [transaction.identityPath, "package identity"],
    [transaction.paths.staging, "package staging"],
    [transaction.paths.backup, "prior package backup"],
    [transaction.paths.displaced, "displaced package"],
  ];
  slots.push([
    transaction.identityTemporaryPath ?? packageIdentityTemporaryPath(transaction.identityPath, transaction.runId),
    "package identity temporary",
  ]);
  return slots.map(([source, label]) => ({
    source,
    label,
    path: cleanupPathFor(transaction, source, label),
  }));
}

async function assertNoUnexpectedCleanupCollisions(transaction, state, retainedRecords, pendingCleanupPath, filesystem) {
  const allowedPaths = new Set([
    ...retainedRecords.map((record) => record.path),
    ...(pendingCleanupPath === null ? [] : [pendingCleanupPath]),
  ]);
  const seen = new Set();
  for (const slot of cleanupSlotsForTransaction(transaction)) {
    if (seen.has(slot.path) || allowedPaths.has(slot.path)) continue;
    seen.add(slot.path);
    if (await packagePathIdentity(slot.path, filesystem) !== null) {
      throw packageCleanupError(
        `package recovery ${state} has an unexpected cleanup collision for ${slot.label} at ${slot.path}; ` +
          "only validated retained paths and the exact current pending intent may exist",
      );
    }
  }
}

function isPackageRollbackState(state) {
  return ["restoring", "target-displaced", "target-restored", "target-removed", "identity-restored"].includes(state);
}

function emptyRetainedPackageDisposables() {
  return {
    schema: RETAINED_PACKAGE_SET_SCHEMA,
    version: RETAINED_PACKAGE_SET_VERSION,
    records: [],
  };
}

function assertRetainedPackageDisposablesShape(transaction, label) {
  try {
    assertExactObjectKeys(transaction.retainedPackageDisposables, ["schema", "version", "records"], label);
    if (transaction.retainedPackageDisposables.schema !== RETAINED_PACKAGE_SET_SCHEMA ||
        transaction.retainedPackageDisposables.version !== RETAINED_PACKAGE_SET_VERSION ||
        !Array.isArray(transaction.retainedPackageDisposables.records) ||
        transaction.retainedPackageDisposables.records.length > MAX_RETAINED_PACKAGE_DISPOSABLES) {
      throw packageCleanupError(`${label} is not one bounded versioned retained-package set`);
    }
    const seenSources = new Set();
    const seenPaths = new Set();
    transaction.retainedPackageDisposables.records.forEach((record, index) => {
      assertRetainedPackageRecordShape(transaction, record, `${label} record ${index}`);
      if (seenSources.has(record.source) || seenPaths.has(record.path)) {
        throw packageCleanupError(`${label} contains duplicate retained package source or path`);
      }
      seenSources.add(record.source);
      seenPaths.add(record.path);
    });
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw packageCleanupError(`${label} is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRetainedReceiptCleanupShape(transaction, retained, label) {
  try {
    assertRetainedPackageRecordShape(transaction, retained, label);
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw packageCleanupError(`${label} is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRetainedPackageRecordShape(transaction, retained, label) {
  if (!isPackageRollbackState(transaction.state)) throw packageCleanupError(`${label} is present outside the package rollback state set`);
  const legacyReceiptRecord = retained.schema === RETAINED_RECEIPT_SCHEMA && retained.version === RETAINED_RECEIPT_VERSION;
  const legacyPackageRecord = retained.schema === LEGACY_RETAINED_PACKAGE_SCHEMA && retained.version === LEGACY_RETAINED_PACKAGE_VERSION;
  const legacyPackageRecordV2 = retained.schema === LEGACY_RETAINED_PACKAGE_SCHEMA_V2 && retained.version === LEGACY_RETAINED_PACKAGE_VERSION_V2;
  const packageRecord = retained.schema === RETAINED_PACKAGE_SCHEMA && retained.version === RETAINED_PACKAGE_VERSION;
  if (!legacyReceiptRecord && !legacyPackageRecord && !legacyPackageRecordV2 && !packageRecord) {
    throw packageCleanupError(`${label} has an unsupported retained-package record schema`);
  }
  if (legacyReceiptRecord || legacyPackageRecord || legacyPackageRecordV2) {
    assertExactObjectKeys(retained, [
      "schema", "version", "source", "path", "label", "candidateFingerprint", "rootIdentity", "journalRootIdentity", "inventory", "receiptChain", "receipt",
    ], label);
    if (typeof retained.source !== "string" || typeof retained.path !== "string" ||
        typeof retained.label !== "string" || retained.candidateFingerprint !== transaction.candidateFingerprint ||
        packageRoleForSource(transaction, retained.source) !== "candidate") {
      throw packageCleanupError(`${label} is legacy candidate-only provenance and cannot attest a prior package`);
    }
  } else {
    assertExactObjectKeys(retained, [
      "schema", "version", "source", "path", "label", "packageRole", "packageFingerprint", "rootIdentity", "journalRootIdentity", "inventory", "stableAttestation", "receiptChain", "receipt",
    ], label);
    const expectedRole = packageRoleForSource(transaction, retained.source);
    const expectedFingerprint = packageFingerprintForSource(transaction, retained.source);
    if (typeof retained.source !== "string" || typeof retained.path !== "string" ||
        typeof retained.label !== "string" || retained.packageRole !== expectedRole ||
        retained.packageFingerprint !== expectedFingerprint) {
      throw packageCleanupError(`${label} is not bound to the exact transaction package role and fingerprint`);
    }
  }
  assertCanonicalPackagePath(retained.source, `${label} source`);
  assertCanonicalPackagePath(retained.path, `${label} path`);
  const expectedLabel = cleanupLabelForSource(transaction, retained.source);
  if (!expectedLabel || retained.label !== expectedLabel ||
      retained.path !== cleanupPathFor(transaction, retained.source, expectedLabel)) {
    throw packageCleanupError(`${label} path or source is outside the exact journal-bound cleanup slot`);
  }
  assertExactPackageIdentity(retained.rootIdentity, `${label} root identity`, "directory");
  assertExactPackageIdentity(retained.journalRootIdentity, `${label} journal root identity`, "directory");
  if (!samePackageDirectoryBinding(retained.rootIdentity, retained.journalRootIdentity)) {
    throw packageCleanupError(`${label} root identity is no longer bound to the journaled disposable root`);
  }
  assertRetentionInventoryAttestationShape(retained.inventory, `${label} inventory`);
  if (packageRecord) {
    assertStableOrdinaryAttestationShape(retained.stableAttestation, `${label} stable ordinary attestation`);
  }

  if (retained.receiptChain === null || retained.receipt === null) {
    if ((!packageRecord && !legacyPackageRecord && !legacyPackageRecordV2) || retained.receiptChain !== null || retained.receipt !== null) {
      throw packageCleanupError(`${label} receipt provenance is incomplete`);
    }
    return;
  }
  const receiptLayout = receiptLayoutForRelative(retained.receipt.relative);
  if (!receiptLayout) {
    throw packageCleanupError(`${label} receipt path is outside the exact accepted Apple-managed boundary`);
  }
  const expectedChain = receiptLayout.directoryRelativePath.map((_segment, index) =>
    receiptLayout.directoryRelativePath.slice(0, index + 1).join("/"));
  if (!Array.isArray(retained.receiptChain) || retained.receiptChain.length !== expectedChain.length) {
    throw packageCleanupError(`${label} receipt directory chain is incomplete`);
  }
  retained.receiptChain.forEach((entry, index) => {
    assertExactObjectKeys(entry, ["relative", "identity"], `${label} receipt directory entry`);
    if (entry.relative !== expectedChain[index]) throw packageCleanupError(`${label} contains an unexpected receipt directory path`);
    assertExactPackageIdentity(entry.identity, `${label} receipt directory ${entry.relative}`, "directory");
  });
  assertExactObjectKeys(retained.receipt, ["relative", "identity"], `${label} receipt`);
  assertExactPackageIdentity(retained.receipt.identity, `${label} receipt identity`, "file");
  if (retained.receipt.identity.nlink !== 1) throw packageCleanupError(`${label} receipt leaf has a hard-link collision`);
}

function assertRetentionInventoryAttestationShape(inventory, label) {
  assertExactObjectKeys(inventory, ["schema", "version", "digest", "entryCount"], label);
  if (inventory.schema !== RETENTION_INVENTORY_SCHEMA || inventory.version !== RETENTION_INVENTORY_VERSION ||
      typeof inventory.digest !== "string" || !/^[a-f0-9]{64}$/u.test(inventory.digest) ||
      !Number.isSafeInteger(inventory.entryCount) || inventory.entryCount < 0) {
    throw packageCleanupError(`${label} is not one compact versioned inventory attestation`);
  }
}

function assertStableOrdinaryAttestationShape(attestation, label) {
  assertExactObjectKeys(attestation, ["schema", "version", "digest", "entryCount"], label);
  if (attestation.schema !== STABLE_ORDINARY_ATTESTATION_SCHEMA || attestation.version !== STABLE_ORDINARY_ATTESTATION_VERSION ||
      typeof attestation.digest !== "string" || !/^[a-f0-9]{64}$/u.test(attestation.digest) ||
      !Number.isSafeInteger(attestation.entryCount) || attestation.entryCount < 0) {
    throw packageCleanupError(`${label} is not one stable ordinary-tree attestation`);
  }
}

function stableOrdinaryAttestationForInventory(inventory) {
  const entries = inventory.entries.map((entry) => {
    const identity = entry.identity;
    const normalized = {
      relative: entry.relative,
      type: identity.type,
      mode: identity.mode,
      uid: identity.uid,
      gid: identity.gid,
      dev: identity.dev,
      ino: identity.ino,
      content: entry.content,
    };
    if (identity.type === "file" || identity.type === "symlink") {
      normalized.nlink = identity.nlink;
      normalized.size = identity.size;
    }
    return normalized;
  });
  return {
    schema: STABLE_ORDINARY_ATTESTATION_SCHEMA,
    version: STABLE_ORDINARY_ATTESTATION_VERSION,
    digest: digest(Buffer.from(JSON.stringify(entries))),
    entryCount: entries.length,
  };
}

function sameStableOrdinaryAttestation(actual, expected) {
  return actual.schema === expected.schema && actual.version === expected.version &&
    actual.digest === expected.digest && actual.entryCount === expected.entryCount;
}

function assertRetentionInventorySnapshotShape(inventory, label) {
  assertExactObjectKeys(inventory, ["schema", "version", "digest", "entries"], label);
  if (inventory.schema !== RETENTION_INVENTORY_SCHEMA || inventory.version !== RETENTION_INVENTORY_VERSION ||
      typeof inventory.digest !== "string" || !/^[a-f0-9]{64}$/u.test(inventory.digest) || !Array.isArray(inventory.entries)) {
    throw packageCleanupError(`${label} is not one complete versioned inventory`);
  }
  const normalized = [];
  let previousRelative = null;
  for (const entry of inventory.entries) {
    assertExactObjectKeys(entry, ["relative", "identity", "content"], `${label} entry`);
    if (typeof entry.relative !== "string" || entry.relative === "." ||
        (previousRelative !== null && entry.relative.localeCompare(previousRelative) <= 0)) {
      throw packageCleanupError(`${label} paths are not unique and sorted`);
    }
    previousRelative = entry.relative;
    if (!entry.identity || typeof entry.identity !== "object" || Array.isArray(entry.identity) ||
        !["directory", "file", "symlink"].includes(entry.identity.type)) {
      throw packageCleanupError(`${label} contains an unsupported special entry`);
    }
    assertExactPackageIdentity(entry.identity, `${label} ${entry.relative} identity`, entry.identity.type);
    if (!entry.content || typeof entry.content !== "object" || Array.isArray(entry.content)) {
      throw packageCleanupError(`${label} ${entry.relative} content record is malformed`);
    }
    if (entry.identity.type === "directory") {
      assertExactObjectKeys(entry.content, ["kind"], `${label} ${entry.relative} directory content`);
      if (entry.content.kind !== "directory") throw packageCleanupError(`${label} ${entry.relative} directory content is malformed`);
    } else if (entry.identity.type === "file") {
      assertExactObjectKeys(entry.content, ["kind", "size", "sha256"], `${label} ${entry.relative} file content`);
      if (entry.content.kind !== "file" || !Number.isSafeInteger(entry.content.size) || entry.content.size < 0 ||
          typeof entry.content.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.content.sha256)) {
        throw packageCleanupError(`${label} ${entry.relative} file content is malformed`);
      }
    } else {
      assertExactObjectKeys(entry.content, ["kind", "target", "sha256"], `${label} ${entry.relative} symlink content`);
      if (entry.content.kind !== "symlink" || typeof entry.content.target !== "string" ||
          typeof entry.content.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.content.sha256)) {
        throw packageCleanupError(`${label} ${entry.relative} symlink content is malformed`);
      }
    }
    normalized.push(normalizeRetentionInventoryEntry(entry));
  }
  if (digest(Buffer.from(JSON.stringify(normalized))) !== inventory.digest) {
    throw packageCleanupError(`${label} digest does not match its complete retained inventory`);
  }
}

function normalizeRetentionInventoryEntry(entry) {
  return {
    relative: entry.relative,
    identity: entry.identity,
    content: entry.content,
  };
}

async function inspectRetainedPackageCleanup(transaction, retained, filesystem = undefined, label = "package recovery retained package") {
  assertRetainedPackageRecordShape(transaction, retained, label);
  const actualSnapshot = await inspectPackageCleanupResidue(transaction, {
    path: retained.path,
    source: retained.source,
    label: retained.label,
    packageFingerprint: retained.packageFingerprint ?? retained.candidateFingerprint,
    rootIdentity: retained.rootIdentity,
  }, filesystem, { sourceRoot: null, journalRootIdentity: retained.journalRootIdentity, buildRecord: false });
  const actual = retainedPackageRecordFromSnapshot(transaction, {
    source: retained.source,
    path: retained.path,
    label: retained.label,
    packageFingerprint: retained.packageFingerprint ?? retained.candidateFingerprint,
    rootIdentity: actualSnapshot.rootIdentity,
    journalRootIdentity: retained.journalRootIdentity,
  }, actualSnapshot, retained.schema);
  if (sameRetainedPackageRecord(actual, retained)) {
    return { record: retained, upgrade: null };
  }
  const upgrade = inspectMonotonicReceiptUpgrade(transaction, retained, actualSnapshot, label);
  if (upgrade === null) {
    throw packageCleanupError("package recovery retained receipt provenance no longer matches the untouched disposable tree");
  }
  return { record: retained, upgrade };
}

function sameRetainedPackageRecord(actual, expected) {
  const bindingOnly = (record) => ({
    ...record,
    rootIdentity: Object.fromEntries(["type", "mode", "uid", "gid", "dev", "ino"].map((field) => [field, record.rootIdentity[field]])),
  });
  return Buffer.compare(serializeSortedJson(bindingOnly(actual)), serializeSortedJson(bindingOnly(expected))) === 0;
}

async function inspectRetainedReceiptCleanup(transaction, retained, filesystem = undefined) {
  return inspectRetainedPackageCleanup(transaction, retained, filesystem, "package recovery retained cleanup");
}

function retainedPackageRecordFromSnapshot(transaction, {
  source,
  path: cleanupPath,
  label,
  packageFingerprint,
  rootIdentity,
  journalRootIdentity,
} = {}, snapshot, recordSchema = RETAINED_PACKAGE_SCHEMA) {
  const role = packageRoleForSource(transaction, source);
  if (recordSchema === RETAINED_RECEIPT_SCHEMA || recordSchema === LEGACY_RETAINED_PACKAGE_SCHEMA || recordSchema === LEGACY_RETAINED_PACKAGE_SCHEMA_V2) {
    return {
      schema: recordSchema,
      version: recordSchema === RETAINED_RECEIPT_SCHEMA ? RETAINED_RECEIPT_VERSION
        : recordSchema === LEGACY_RETAINED_PACKAGE_SCHEMA_V2 ? LEGACY_RETAINED_PACKAGE_VERSION_V2
          : LEGACY_RETAINED_PACKAGE_VERSION,
      source,
      path: cleanupPath,
      label,
      candidateFingerprint: packageFingerprint,
      rootIdentity,
      journalRootIdentity,
      inventory: {
        schema: RETENTION_INVENTORY_SCHEMA,
        version: RETENTION_INVENTORY_VERSION,
        digest: snapshot.inventory.digest,
        entryCount: snapshot.inventory.entries.length,
      },
      receiptChain: snapshot.receiptChain,
      receipt: snapshot.receipt,
    };
  }
  return {
    schema: RETAINED_PACKAGE_SCHEMA,
    version: RETAINED_PACKAGE_VERSION,
    source,
    path: cleanupPath,
    label,
    packageRole: role,
    packageFingerprint,
    rootIdentity,
    journalRootIdentity,
    inventory: {
      schema: RETENTION_INVENTORY_SCHEMA,
      version: RETENTION_INVENTORY_VERSION,
      digest: snapshot.inventory.digest,
      entryCount: snapshot.inventory.entries.length,
    },
    stableAttestation: stableOrdinaryAttestationForInventory(snapshot.inventory),
    receiptChain: snapshot.receiptChain,
    receipt: snapshot.receipt,
  };
}

function inspectMonotonicReceiptUpgrade(transaction, retained, actualSnapshot, label) {
  const isStableRecord = retained.schema === RETAINED_PACKAGE_SCHEMA && retained.version === RETAINED_PACKAGE_VERSION;
  if (!isStableRecord || retained.receiptChain !== null || retained.receipt !== null ||
      actualSnapshot.receiptChain === null || actualSnapshot.receipt === null) {
    return null;
  }
  const actualStable = stableOrdinaryAttestationForInventory(actualSnapshot.inventory);
  if (retained.inventory.entryCount !== actualStable.entryCount || !sameStableOrdinaryAttestation(actualStable, retained.stableAttestation)) {
    throw packageCleanupError(`${label} cannot perform the monotonic receipt provenance upgrade because the stable ordinary attestation changed`);
  }
  const upgraded = retainedPackageRecordFromSnapshot(transaction, {
    source: retained.source,
    path: retained.path,
    label: retained.label,
    packageFingerprint: retained.packageFingerprint,
    rootIdentity: actualSnapshot.rootIdentity,
    journalRootIdentity: retained.journalRootIdentity,
  }, actualSnapshot, RETAINED_PACKAGE_SCHEMA);
  assertRetainedPackageRecordShape(transaction, upgraded, `${label} monotonic receipt upgrade`);
  return {
    record: upgraded,
    description: {
      source: retained.source,
      path: retained.path,
      label: retained.label,
      packageRole: retained.packageRole,
      packageFingerprint: retained.packageFingerprint,
      fromSchema: retained.schema,
      fromVersion: retained.version,
      toSchema: upgraded.schema,
      toVersion: upgraded.version,
      inventory: upgraded.inventory,
      stableAttestation: upgraded.stableAttestation,
      rootIdentity: upgraded.rootIdentity,
      journalRootIdentity: upgraded.journalRootIdentity,
      receiptChain: upgraded.receiptChain,
      receipt: upgraded.receipt,
    },
  };
}

async function inspectPackageCleanupResidue(transaction, {
  path: cleanupPath,
  source,
  label,
  packageFingerprint,
  candidateFingerprint,
  rootIdentity,
} = {}, filesystem = undefined, {
  sourceRoot = transaction.source,
  buildRecord = true,
  journalRootIdentity = rootIdentity,
  recordSchema = RETAINED_PACKAGE_SCHEMA,
} = {}) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const expectedPackageRole = packageRoleForSource(transaction, source);
  const expectedPackageFingerprint = packageFingerprintForSource(transaction, source);
  const observedPackageFingerprint = packageFingerprint ?? candidateFingerprint;
  if (!expectedPackageRole || observedPackageFingerprint !== expectedPackageFingerprint) {
    throw packageCleanupError("package cleanup is not bound to the exact transaction package role and fingerprint");
  }
  const rootInfo = await packageLstat(evidenceFilesystem, cleanupPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw packageCleanupError(`package cleanup root metadata is unavailable: ${error?.code ?? String(error)}`);
  });
  if (!rootInfo) throw packageCleanupError("package cleanup disposable root is missing");
  const actualRootIdentity = packageIdentityOf(rootInfo);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !samePackageDirectoryBinding(actualRootIdentity, rootIdentity)) {
    throw packageCleanupError("package cleanup disposable root has changed type, ownership, or identity");
  }
  const actual = {
    ...(await collectReceiptRetentionSnapshot(cleanupPath, evidenceFilesystem, { requireReceipt: false })),
    rootIdentity: actualRootIdentity,
  };
  const actualFingerprint = await fingerprintPath(cleanupPath, evidenceFilesystem);
  if (expectedPackageRole === "candidate" && sourceRoot !== null) {
    const sourceInfo = await packageLstat(evidenceFilesystem, sourceRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw packageCleanupError(`artifact-bound package source metadata is unavailable: ${error?.code ?? String(error)}`);
    });
    if (sourceInfo) {
      const sourceFingerprint = await fingerprintPath(sourceRoot, evidenceFilesystem);
      if (sourceFingerprint !== observedPackageFingerprint && actual.receiptChain !== null) {
        throw packageCleanupError("artifact-bound package source fingerprint is not the exact candidate fingerprint");
      }
      if (sourceFingerprint === observedPackageFingerprint) {
        const sourceSnapshot = await collectReceiptRetentionSnapshot(sourceRoot, evidenceFilesystem, { requireReceipt: false });
        if (sourceSnapshot.receiptChain === null && actual.receiptChain === null) {
          assertRetentionInventoryExact(sourceSnapshot.inventory, actual.inventory, "package cleanup");
        } else {
          assertRetentionSubset(sourceSnapshot.inventory, actual.inventory, "package cleanup");
          assertReceiptChainBinding(sourceSnapshot.receiptChain, actual.receiptChain, "package cleanup");
        }
      }
    } else if (actual.receiptChain !== null) {
      throw packageCleanupError("artifact-bound package source is missing; no unchanged-subset proof is available");
    }
  }
  if (actual.receiptChain === null || expectedPackageRole === "prior") {
    if (actualFingerprint !== observedPackageFingerprint) {
      throw packageCleanupError("package cleanup fingerprint no longer matches its transaction-owned package");
    }
  }
  if (!buildRecord) return actual;
  const retained = retainedPackageRecordFromSnapshot(transaction, {
    source,
    path: cleanupPath,
    label,
    packageFingerprint: observedPackageFingerprint,
    rootIdentity: actualRootIdentity,
    journalRootIdentity,
  }, actual, recordSchema);
  assertRetainedPackageRecordShape(transaction, retained, "package cleanup provenance");
  return retained;
}

async function inspectReceiptCleanupResidue(transaction, details, filesystem = undefined, options = {}) {
  const actual = await inspectPackageCleanupResidue(transaction, details, filesystem, options);
  if (options.requireReceipt === false || actual.receiptChain !== null) return actual;
  throw packageCleanupError("receipt-bearing cleanup does not contain the exact Apple receipt boundary");
}

function assertRetentionInventoryExact(sourceInventory, retainedInventory, label) {
  if (sourceInventory.entries.length !== retainedInventory.entries.length) {
    throw packageCleanupError(`${label} full ordinary inventory is incomplete or contains an added path`);
  }
  for (let index = 0; index < sourceInventory.entries.length; index += 1) {
    const source = sourceInventory.entries[index];
    const retained = retainedInventory.entries[index];
    if (source.relative !== retained.relative || source.identity.type !== retained.identity.type ||
        source.identity.mode !== retained.identity.mode || JSON.stringify(source.content) !== JSON.stringify(retained.content)) {
      throw packageCleanupError(`${label} full ordinary inventory changed path, type, mode, bytes, or symlink target`);
    }
  }
}

function assertRetentionSubset(sourceInventory, retainedInventory, label) {
  const sourceByPath = new Map(sourceInventory.entries.map((entry) => [entry.relative, entry]));
  for (const retained of retainedInventory.entries) {
    const source = sourceByPath.get(retained.relative);
    if (!source) throw packageCleanupError(`${label} contains an added ordinary path ${retained.relative}`);
    if (source.identity.type !== retained.identity.type) {
      throw packageCleanupError(`${label} ordinary path ${retained.relative} changed type`);
    }
    const fieldsToCompare = ["mode"];
    if (fieldsToCompare.some((field) => source.identity[field] !== retained.identity[field])) {
      throw packageCleanupError(`${label} ordinary path ${retained.relative} changed copy-stable mode`);
    }
    if (JSON.stringify(source.content) !== JSON.stringify(retained.content)) {
      throw packageCleanupError(`${label} ordinary path ${retained.relative} changed bytes or symlink target`);
    }
  }
}

function assertReceiptChainBinding(sourceChain, retainedChain, label) {
  if (sourceChain === null) return;
  if (retainedChain === null) {
    throw packageCleanupError(`${label} Apple receipt directory chain disappeared`);
  }
  for (let index = 0; index < retainedChain.length; index += 1) {
    const source = sourceChain[index];
    const retained = retainedChain[index];
    if (!source || source.relative !== retained.relative || source.identity.type !== "directory" ||
        source.identity.mode !== retained.identity.mode) {
      throw packageCleanupError(`${label} Apple receipt directory chain changed path, type, or copy-stable mode`);
    }
  }
}

async function collectReceiptRetentionSnapshot(root, filesystem = undefined, { requireReceipt = true } = {}) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const entries = [];
  let receiptChain = null;
  let receipt = null;
  let receiptLayout = null;

  async function visit(candidate) {
    const info = await packageLstat(evidenceFilesystem, candidate).catch((error) => {
      throw packageCleanupError(`receipt-bearing cleanup metadata is unavailable at ${candidate}: ${error?.code ?? String(error)}`);
    });
    const relative = path.relative(root, candidate).split(path.sep).join("/") || ".";
    const boundary = classifyAppleReceiptBoundary(root, candidate);
    if (boundary?.kind === "invalid") throw appleReceiptBoundaryError(boundary.path, boundary.reason);
    if (boundary?.kind === "directory") {
      if (receiptLayout !== null) {
        throw appleReceiptBoundaryError(candidate, "the package contains both the fixed MAS and historical Apple receipt boundaries");
      }
      receiptLayout = boundary.layout;
      if (relative !== receiptLayout.directoryRelativePath.join("/")) {
        throw appleReceiptBoundaryError(candidate, "the Apple receipt path is outside the exact accepted nested Electron app boundary");
      }
      const validated = await validateAppleReceiptDirectory(candidate, boundary.path, evidenceFilesystem);
      receiptChain = [];
      for (let index = 0; index < receiptLayout.directoryRelativePath.length; index += 1) {
        const chainRelative = receiptLayout.directoryRelativePath.slice(0, index + 1).join("/");
        const chainInfo = await packageLstat(evidenceFilesystem, path.join(root, ...receiptLayout.directoryRelativePath.slice(0, index + 1)));
        if (chainInfo.isSymbolicLink() || !chainInfo.isDirectory()) {
          throw packageCleanupError(`receipt-bearing cleanup path ${chainRelative} is not one non-symlink directory`);
        }
        receiptChain.push({ relative: chainRelative, identity: packageIdentityOf(chainInfo) });
      }
      receipt = {
        relative: receiptLayout.relativePath.join("/"),
        identity: validated.receiptIdentity,
      };
      return;
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(candidate);
      entries.push({
        relative,
        identity: packageIdentityOf(info),
        content: { kind: "symlink", target, sha256: digest(Buffer.from(target)) },
      });
      return;
    }
    if (info.isFile()) {
      const bytes = await readFile(candidate);
      entries.push({
        relative,
        identity: packageIdentityOf(info),
        content: { kind: "file", size: bytes.byteLength, sha256: digest(bytes) },
      });
      return;
    }
    if (!info.isDirectory()) throw packageCleanupError(`receipt-bearing cleanup contains unsupported special entry ${candidate}`);
    if (relative !== ".") {
      entries.push({ relative, identity: packageIdentityOf(info), content: { kind: "directory" } });
    }
    const names = (await readdir(candidate)).sort();
    for (const name of names) await visit(path.join(candidate, name));
  }

  await visit(root);
  if (requireReceipt && (!receiptChain || !receipt)) {
    throw packageCleanupError("receipt-bearing cleanup does not contain the exact Apple receipt boundary");
  }
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  const inventory = {
    schema: RETENTION_INVENTORY_SCHEMA,
    version: RETENTION_INVENTORY_VERSION,
    digest: digest(Buffer.from(JSON.stringify(entries.map(normalizeRetentionInventoryEntry)))),
    entries,
  };
  assertRetentionInventorySnapshotShape(inventory, "receipt-bearing cleanup inventory");
  return { inventory, receiptChain, receipt };
}

function packageIdentityTemporaryPath(identityPath, runId) {
  return `${identityPath}.m7.${runId}.identity.tmp`;
}

async function reconcileIdentityTemporary(transaction, lease, filesystem = undefined) {
  if (transaction.identityTemporaryPath === null) {
    if (transaction.identityTemporaryFingerprint !== null) {
      throw new Error("refusing package recovery; identity temporary fingerprint has no temporary path");
    }
    return;
  }
  if (typeof transaction.identityTemporaryFingerprint !== "string") {
    throw new Error("refusing package recovery; identity temporary construction intent is incomplete");
  }
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  const temporaryFingerprint = await fingerprintPath(transaction.identityTemporaryPath, evidenceFilesystem);
  const temporaryIdentity = await packagePathIdentity(transaction.identityTemporaryPath, evidenceFilesystem);
  const identityFingerprint = await fingerprintPath(transaction.identityPath, evidenceFilesystem);
  const identityIdentity = await packagePathIdentity(transaction.identityPath, evidenceFilesystem);
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
    await removeOwnedPath(transaction, transaction.identityTemporaryPath, temporaryFingerprint, "package identity temporary", lease, transaction.identityTemporaryIdentity, evidenceFilesystem);
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
  await syncDirectory(path.dirname(transaction.paths.journal));
}

async function transition(transaction, state, faultAt) {
  transaction.state = state;
  await writeJournal(transaction);
  if (faultAt === state) throw new Error(`injected package transaction interruption at ${state}`);
}

async function writeJournal(transaction) {
  const bytes = Buffer.from(`${JSON.stringify(transaction, replacer, 2)}\n`);
  const temporary = `${transaction.paths.journal}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = await open(temporary, "wx", 0o600);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await rename(temporary, transaction.paths.journal);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(path.dirname(transaction.paths.journal));
}

async function syncDirectory(directoryPath) {
  const descriptor = await open(directoryPath, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
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
  if (!("cleanupReceiptObserved" in transaction)) transaction.cleanupReceiptObserved = false;
  if (!("retainedCleanup" in transaction)) transaction.retainedCleanup = null;
  if (!("retainedPackageDisposables" in transaction)) {
    transaction.retainedPackageDisposables = {
      schema: RETAINED_PACKAGE_SET_SCHEMA,
      version: RETAINED_PACKAGE_SET_VERSION,
      records: transaction.retainedCleanup === null ? [] : [transaction.retainedCleanup],
    };
  }
  if (transaction.retainedCleanup === null && transaction.retainedPackageDisposables?.records?.length > 0) {
    transaction.retainedCleanup = transaction.retainedPackageDisposables.records[0];
  }
  if (typeof transaction.cleanupReceiptObserved !== "boolean") {
    throw new Error("package transaction cleanup receipt observation marker is invalid");
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
  assertRetainedPackageDisposablesShape(transaction, "package transaction retained package disposables");
  const retainedRecords = transaction.retainedPackageDisposables.records;
  if (transaction.retainedCleanup !== null) {
    if (!retainedRecords.some((record) => Buffer.compare(serializeSortedJson(record), serializeSortedJson(transaction.retainedCleanup)) === 0)) {
      throw packageCleanupError("package transaction legacy retained cleanup is not represented in the retained package set");
    }
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
  const cleanupKind = assertCleanupIntentStructure(transaction, "package transaction");
  const pendingRetainedRecord = cleanupKind !== null
    ? retainedRecords.find((record) => record.path === transaction.cleanupPath && record.source === transaction.cleanupSource)
    : null;
  if (pendingRetainedRecord !== null && pendingRetainedRecord !== undefined &&
      ((pendingRetainedRecord.packageFingerprint ?? pendingRetainedRecord.candidateFingerprint) !== transaction.cleanupFingerprint ||
       !samePackageDirectoryBinding(pendingRetainedRecord.rootIdentity, transaction.cleanupIdentity))) {
    throw packageCleanupError("package transaction retained package provenance does not match pending cleanup ownership");
  }
  if (transaction.cleanupReceiptObserved && cleanupFields.every((value) => value === null)) {
    throw packageCleanupError("package transaction receipt observation marker has no pending cleanup intent");
  }
}

function normalizeTransaction(transaction) {
  if (transaction && typeof transaction === "object") {
    if (!("cleanupReceiptObserved" in transaction)) transaction.cleanupReceiptObserved = false;
    if (!("retainedCleanup" in transaction)) transaction.retainedCleanup = null;
    if (!("retainedPackageDisposables" in transaction)) {
      transaction.retainedPackageDisposables = {
        schema: RETAINED_PACKAGE_SET_SCHEMA,
        version: RETAINED_PACKAGE_SET_VERSION,
        records: transaction.retainedCleanup === null ? [] : [transaction.retainedCleanup],
      };
    }
    if (transaction.retainedCleanup === null && transaction.retainedPackageDisposables?.records?.length > 0) {
      transaction.retainedCleanup = transaction.retainedPackageDisposables.records[0];
    }
  }
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

async function fingerprintVisit(root, candidate, entries, filesystem) {
  const receiptBoundary = classifyAppleReceiptBoundary(root, candidate);
  if (receiptBoundary?.kind === "invalid") {
    throw appleReceiptBoundaryError(receiptBoundary.path, receiptBoundary.reason);
  }
  if (receiptBoundary?.kind === "directory") {
    await validateAppleReceiptDirectory(candidate, receiptBoundary.path, filesystem);
    return;
  }
  const inspected = await packageLstat(filesystem, candidate);
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
  for (const name of (await readdir(candidate)).sort()) await fingerprintVisit(root, path.join(candidate, name), entries, filesystem);
}

async function inspectAppleReceiptBoundary(root, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  let found = null;
  async function visit(candidate) {
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    const boundary = classifyAppleReceiptBoundary(root, candidate);
    if (boundary?.kind === "invalid") throw appleReceiptBoundaryError(boundary.path, boundary.reason);
    if (boundary?.kind === "directory") {
      if (relative !== boundary.layout.directoryRelativePath.join("/")) {
        throw appleReceiptBoundaryError(candidate, "the receipt path is outside the exact accepted nested Electron app boundary");
      }
      const validated = await validateAppleReceiptDirectory(candidate, boundary.path, evidenceFilesystem);
      if (found !== null) {
        throw appleReceiptBoundaryError(candidate, "the package contains both the fixed MAS and historical Apple receipt boundaries");
      }
      found = { kind: "valid", path: candidate, layout: boundary.layout, ...validated };
      return;
    }
    const info = await packageLstat(evidenceFilesystem, candidate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
    for (const name of (await readdir(candidate)).sort()) await visit(path.join(candidate, name));
  }
  const rootInfo = await packageLstat(evidenceFilesystem, root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return { kind: "absent" };
  await visit(root);
  return found ?? { kind: "absent" };
}

function classifyAppleReceiptBoundary(root, candidate) {
  const relative = path.relative(root, candidate);
  const segments = relative ? relative.split(path.sep) : [];
  const receiptDirectoryIndex = segments.indexOf("_MASReceipt");
  if (receiptDirectoryIndex < 0) return null;

  const boundaryPath = path.join(root, ...segments.slice(0, receiptDirectoryIndex + 1));
  for (const layout of APPLE_RECEIPT_LAYOUTS) {
    const isExpectedDirectory = segments.length === layout.directoryRelativePath.length &&
      segments.every((segment, index) => segment === layout.directoryRelativePath[index]);
    const isExpectedReceipt = segments.length === layout.relativePath.length &&
      segments.every((segment, index) => segment === layout.relativePath[index]);
    if (isExpectedDirectory || isExpectedReceipt) {
      return { kind: "directory", path: path.join(root, ...layout.directoryRelativePath), layout };
    }
  }
  return { kind: "invalid", path: boundaryPath, reason: "the receipt path is outside the exact accepted nested Electron app boundary" };
}

function receiptLayoutForRelative(relative) {
  return APPLE_RECEIPT_LAYOUTS.find((layout) => layout.relativePath.join("/") === relative) ?? null;
}

async function validateAppleReceiptDirectory(candidate, boundaryPath, filesystem = undefined) {
  const evidenceFilesystem = filesystem ?? normalizePackageFilesystem();
  let directoryInfo;
  try {
    directoryInfo = await packageLstat(evidenceFilesystem, candidate);
  } catch (_error) {
    throw appleReceiptBoundaryError(boundaryPath, "the Apple receipt directory disappeared while it was being fingerprinted");
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw appleReceiptBoundaryError(boundaryPath, "_MASReceipt must be one non-symlink directory");
  }

  let names;
  try {
    names = (await readdir(candidate)).sort();
  } catch (_error) {
    throw appleReceiptBoundaryError(boundaryPath, "the Apple receipt directory could not be enumerated without following a changed boundary");
  }
  if (names.length !== 1 || names[0] !== "receipt") {
    throw appleReceiptBoundaryError(boundaryPath, "_MASReceipt must contain exactly one regular receipt leaf and no sibling or nested entry");
  }

  const receiptPath = path.join(candidate, "receipt");
  let receiptInfo;
  try {
    receiptInfo = await packageLstat(evidenceFilesystem, receiptPath);
  } catch (_error) {
    throw appleReceiptBoundaryError(receiptPath, "the Apple receipt leaf disappeared while it was being fingerprinted");
  }
  if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.nlink !== 1) {
    throw appleReceiptBoundaryError(receiptPath, "the Apple receipt leaf must be one regular non-symlink file with no hard-link collision");
  }
  return {
    directoryIdentity: packageIdentityOf(directoryInfo),
    receiptIdentity: packageIdentityOf(receiptInfo),
  };
}

function appleReceiptBoundaryError(candidate, reason) {
  const error = new Error(
    `package fingerprint rejected Apple-managed receipt boundary ${candidate}: ${reason}. ` +
      `Authority: ${APPLE_RECEIPT_AUTHORITY}; ${APPLE_RECEIPT_RULE}. ` +
      `Next action: ${APPLE_RECEIPT_NEXT_ACTION}; for interrupted rollback, leave the receipt-bearing disposable tree intact and run MAS gate status/recovery.`,
  );
  error.code = MAS_GATE_CLEANUP_DIAGNOSTIC_CODE;
  return error;
}

function packageCleanupError(reason) {
  const error = new Error(
    `${MAS_GATE_CLEANUP_DIAGNOSTIC_CODE}: package rollback retained-residue validation failed. ` +
      `Authority: ${APPLE_RECEIPT_AUTHORITY}; ${APPLE_RECEIPT_RETENTION_RULE}. ` +
      "Next action: leave /Applications, the receipt-bearing disposable tree, and its journal intact; run MAS gate status/recovery. " +
      `Reason: ${reason}`,
  );
  error.code = MAS_GATE_CLEANUP_DIAGNOSTIC_CODE;
  return error;
}

function packageFingerprintBoundaryDiagnostic(reason) {
  return `${reason} outside the exact Apple-managed receipt boundary. Authority: ${APPLE_RECEIPT_AUTHORITY}; ${APPLE_RECEIPT_RULE}. Next action: ${APPLE_RECEIPT_NEXT_ACTION}.`;
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
