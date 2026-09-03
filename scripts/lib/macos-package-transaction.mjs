import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireMasGateLock, assertMasGateMutationLease, masGateLockPath } from "./macos-mas-gate-lock.mjs";
import { assertMasGateArtifactBinding, freezeMasGateArtifactBinding } from "./mas-gate-artifact-binding.mjs";

export const PACKAGE_TRANSACTION_SCHEMA = "MAS_PACKAGE_TRANSACTION v4";
export const PACKAGE_TRANSACTION_VERSION = 4;

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
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
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
  await assertPackageParent(path.dirname(target));
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
  const transaction = await loadTransaction(transactionOrJournal);
  assertTransaction(transaction, options);
  return withPackageMutationLease(transaction, options, async (lockLease) => {
    const lockedOptions = { ...options, lockLease };
    await lockLease.bindRuntimeRoot(runtimeRootPathFor(transaction, options));
    if (lockedOptions.assertNoLiveHost) await lockedOptions.assertNoLiveHost();
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
  return withPackageMutationLease(transaction, options, async (lockLease) => {
    const lockedOptions = { ...options, lockLease };
    await lockLease.bindRuntimeRoot(runtimeRootPathFor(transaction, options));
    if (lockedOptions.assertNoLiveHost) await lockedOptions.assertNoLiveHost();
    if (transaction.state !== "prepared" && transaction.state !== "staged" && transaction.state !== "target-backed-up" &&
        transaction.state !== "candidate-installed" && transaction.state !== "identity-published" && transaction.state !== "committed" && transaction.state !== "restoring" &&
        transaction.state !== "target-displaced" && transaction.state !== "target-restored" &&
        transaction.state !== "target-removed" && transaction.state !== "identity-restored") {
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
    await lockLease.bindRuntimeRoot(runtimeRootPathFor(transaction, options));
    if (lockedOptions.assertNoLiveHost) await lockedOptions.assertNoLiveHost();
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
    const expectedIdentity = transaction.artifactBinding
      ? transaction.identityPublishedIdentity
      : await packagePathIdentity(transaction.identityPath);
    if (!expectedIdentity) {
      throw new Error("refusing to restore package identity; published ownership identity is missing");
    }
    await removeOwnedPath(transaction, transaction.identityPath, await fingerprintPath(transaction.identityPath), "package identity", lockLease, expectedIdentity);
  } else {
    await writeBytesAtomic(transaction.identityPath, previousBytes, { lease: lockLease, noReplace: false });
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
  transaction.cleanupPath = null;
  transaction.cleanupSource = null;
  transaction.cleanupFingerprint = null;
  transaction.cleanupIdentity = null;
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

async function assertPackageParent(parentPath) {
  const info = await lstat(parentPath).catch((error) => {
    throw new Error(`package target parent is unavailable: ${error.message}`);
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("package target parent is not one real directory");
}

function assertCanonicalPackagePath(candidate, label) {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate || candidate.includes("\0")) {
    throw new Error(`${label} must be one exact canonical absolute path`);
  }
}

async function exists(candidate) {
  return (await lstat(candidate).catch(() => null)) !== null;
}

function digest(bytes) {
  return bytes === null || bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
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
