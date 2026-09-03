import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  masGateLockPath,
  writeMasGateLockMetadata,
  withMasGateLock,
} from "./macos-mas-gate-lock.mjs";

export const MAS_GATE_SESSION_TRANSACTION_SCHEMA = "MAS_GATE_SESSION_TRANSACTION v1";
export const MAS_GATE_SESSION_TRANSACTION_VERSION = 1;
export const MAS_GATE_RUNTIME_ROOT_ATTESTATION_SCHEMA = "MAS_GATE_RUNTIME_ROOT_ATTESTATION v1";
export const MAS_GATE_CLEANUP_DIAGNOSTIC_CODE = "MAS-GATE-CLEANUP-001";
export const MAS_GATE_CLEANUP_DIAGNOSTIC =
  `${MAS_GATE_CLEANUP_DIAGNOSTIC_CODE}: repository-authorized MAS gate cleanup owns only the ` +
  "runtime-root-only transaction boundary. Authority: " +
  "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and " +
  "docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: leave the " +
  "canonical, quarantine, and retained runtime roots intact; run the MAS gate " +
  "session status/recovery command before any further gate attempt.";

export const MAS_GATE_SESSION_PHASES = Object.freeze([
  "prepared",
  "quarantine-intent",
  "quarantined",
  "fresh-intent",
  "fresh-created",
  "ready",
  "detach-intent",
  "fresh-retained",
  "restore-intent",
  "restored",
  "archive-intent",
  "archived",
]);

export const MAS_GATE_SESSION_FAULT_POINTS = Object.freeze([
  "active-mkdir",
  "active-journal-published",
  "rename-active-publish",
  "fresh-mkdir",
  "fresh-identity-journaled",
  "rename-quarantine",
  "rename-fresh-retained",
  "rename-prior-restore",
  "rename-archive",
  "journal-published",
  "prepared",
  "quarantine-intent",
  "quarantined",
  "fresh-intent",
  "fresh-created",
  "ready",
  "detach-intent",
  "fresh-retained",
  "restore-intent",
  "restored",
  "archive-intent",
  "archive-renamed",
  "archived",
]);

const ACTIVE_BASENAME = ".meetless-mas-gate-session.active";
const ACTIVE_BUILDING_SUFFIX = ".active-building";
const JOURNAL_BASENAME = "transaction.json";
const QUARANTINE_PREFIX = ".meetless-mas-gate-session.";
const QUARANTINE_SUFFIX = ".quarantine";
const FRESH_RETAINED_SUFFIX = ".fresh-retained";
const ARCHIVE_SUFFIX = ".archived";
const OWNER_TOKEN_BYTES = 32;
const POSIX_MODE_MASK = 0o7777;

/**
 * Begin the one active MAS runtime-root transaction for a contract-derived
 * root. The returned value is plain data; the adapter is used only at the
 * process-ownership edge and is never written into the journal.
 */
export async function beginMasGateSessionTransaction(options = {}) {
  try {
    const parentPath = parentPathHint(options);
    return await withMasGateLock({ ...options, parentPath }, async (lockLease) => {
      const context = await validateContext(options, "begin");
      await assertNoLiveOwnedRuntime(options, context, "before runtime quarantine");
      const space = await inspectFreeSpace(context.parentPath, options.requiredFreeBytes);
      const prior = await inspectPriorRoot(context);
      const runId = normalizeRunId(options.runId ?? randomUUID());
      const ownerToken = randomBytes(OWNER_TOKEN_BYTES).toString("base64url");
      const paths = transactionPaths(context, runId);

      await assertAbsent(paths.activePath, "active transaction slot");
      await assertAbsent(paths.constructionPath, "active transaction construction slot");
      await assertAbsent(paths.quarantinePath, "runtime quarantine");
      await assertAbsent(paths.freshRetainedPath, "fresh retained runtime");
      await assertAbsent(paths.archivePath, "archived transaction slot");
      const building = await findBuildingTransactions(context, options);
      if (building.length > 0) throw failClosed("an incomplete active transaction construction requires recovery before a new session can begin");
      const archived = await findArchivedTransactions(context, options);
      if (archived.some((candidate) => candidate.phase !== "archived")) {
        throw failClosed("an incomplete retained transaction requires recovery before a new active session can begin");
      }
      await assertSiblingArtifactTopology(context, options);

      const transaction = {
        schema: MAS_GATE_SESSION_TRANSACTION_SCHEMA,
        version: MAS_GATE_SESSION_TRANSACTION_VERSION,
        ownerToken,
        runId,
        canonicalRuntimeRoot: context.runtimeRoot,
        runtimeRoot: context.runtimeRoot,
        canonicalPath: context.runtimeRoot,
        parentPath: context.parentPath,
        parent: context.parentPath,
        lockPath: masGateLockPath(context.parentPath),
        activePath: paths.activePath,
        active: paths.activePath,
        constructionPath: paths.constructionPath,
        quarantinePath: paths.quarantinePath,
        quarantine: paths.quarantinePath,
        freshRetainedPath: paths.freshRetainedPath,
        freshRetained: paths.freshRetainedPath,
        archivePath: null,
        journalPath: path.join(paths.constructionPath, JOURNAL_BASENAME),
        identityRelativePath: context.identityRelativePath,
        identityPath: context.identityPath,
        identity: {
          relativePath: context.identityRelativePath,
          path: context.identityPath,
        },
        priorExists: prior.exists,
        priorRootIdentity: prior.exists ? prior.rootIdentity : null,
        priorAggregateAttestation: prior.exists ? prior.aggregateAttestation : null,
        prior: {
          exists: prior.exists,
          rootIdentity: prior.exists ? prior.rootIdentity : null,
          aggregateAttestation: prior.exists ? prior.aggregateAttestation : null,
        },
        freshRootIdentity: null,
        freshRetainedRootIdentity: null,
        requiredFreeBytes: space.requiredFreeBytes,
        observedFreeBytes: space.observedFreeBytes,
        stateScope: "runtime-root-only",
        phase: "prepared",
        phaseHistory: ["prepared"],
      };

      throwInjectedFsError(options, "mkdir-active");
      await mkdir(paths.constructionPath, { recursive: false, mode: 0o700 });
      await syncDirectory(context.parentPath);
      await assertOwnedSecureDirectory(paths.constructionPath, "active transaction construction slot", context.parentDevice);
      await maybeFault(options, transaction, "active-mkdir", "after active construction directory creation");
      await writeJournal(transaction, options);
      await maybeFault(options, transaction, "active-journal-published", "after construction journal publication");
      await promoteActiveConstruction(transaction, options, context);
      await maybeFault(options, transaction, "prepared", "after active lock and journal");
      await advancePreparation(transaction, options, context);
      await assertReady(transaction, options, context);
      await writeMasGateLockMetadata(lockLease, {
        role: "gate",
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        canonicalRuntimeRoot: transaction.canonicalRuntimeRoot,
        phase: transaction.phase,
      });
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not begin the runtime-root preservation transaction", error);
  }
}

/**
 * Recover one transaction after an interruption. Recovery never removes a
 * runtime path and is safe to repeat after a completed restore or archive.
 */
export async function recoverMasGateSessionTransaction(transactionOrJournal, options = {}) {
  try {
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async () => {
      const transaction = await loadTransaction(transactionOrJournal, options);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "recover");
      assertTransaction(transaction, context, options);
      await assertSiblingArtifactTopology(context, options, transaction);
      await assertNoLiveOwnedRuntime(options, context, "before runtime recovery");

      if (phaseRank(transaction.phase) < phaseRank("ready")) {
        await advancePreparation(transaction, options, context);
      }
      if (phaseRank(transaction.phase) < phaseRank("restored")) {
        await restoreInternal(transaction, options, context);
      }
      if (transaction.phase === "archive-intent") {
        await completeArchive(transaction, options, context);
      }
      if (transaction.phase === "restored") await assertRestoredState(transaction, context);
      if (transaction.phase === "archived") await assertArchivedState(transaction, context);
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not recover the runtime-root preservation transaction", error);
  }
}

/**
 * Restore the exact prior root or prior absence, retaining the fresh run root.
 * Package rollback must be completed by the caller before invoking this seam.
 */
export async function restoreMasGateSessionTransaction(transactionOrJournal, options = {}) {
  try {
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async () => {
      const transaction = await loadTransaction(transactionOrJournal, options);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "restore");
      assertTransaction(transaction, context, options);
      await assertSiblingArtifactTopology(context, options, transaction);
      await assertNoLiveOwnedRuntime(options, context, "before runtime restore");

      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        return transaction;
      }
      if (transaction.phase === "archive-intent") {
        await completeArchive(transaction, options, context);
        await assertArchivedState(transaction, context);
        return transaction;
      }
      if (phaseRank(transaction.phase) < phaseRank("ready")) {
        await advancePreparation(transaction, options, context);
      }
      if (phaseRank(transaction.phase) < phaseRank("restored")) {
        await restoreInternal(transaction, options, context);
      }
      await assertRestoredState(transaction, context);
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not restore the prior runtime root", error);
  }
}

/**
 * Archive a restored session by renaming its active slot to a retained unique
 * sibling. No retained root or journal is deleted.
 */
export async function archiveMasGateSessionTransaction(transactionOrJournal, options = {}) {
  try {
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async () => {
      const transaction = await loadTransaction(transactionOrJournal, options);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "archive");
      assertTransaction(transaction, context, options);
      await assertSiblingArtifactTopology(context, options, transaction);
      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        return transaction;
      }
      if (transaction.phase !== "restored" && transaction.phase !== "archive-intent") {
        throw failClosed(`cannot archive a session in phase ${transaction.phase}`);
      }
      await assertRestoredRoots(transaction, context);
      await completeArchive(transaction, options, context);
      if (transaction.phase === "archived") await assertArchivedState(transaction, context);
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not archive the completed runtime-root transaction", error);
  }
}

/**
 * Read-only status for the fixed active slot. Archived sessions are reported,
 * never cleaned, so a caller can decide which retained evidence to inspect.
 */
export async function readMasGateSessionStatus(options = {}) {
  try {
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async () => {
      const context = await validateContext(options, "status");
      const paths = fixedTransactionPaths(context);
      const building = await findBuildingTransactions(context, options);
      const archived = await findArchivedTransactions(context, options);
      const activeInfo = await inspectedPath(paths.activePath);
      if (activeInfo !== null) {
        if (building.length > 0) throw failClosed("both the fixed active transaction slot and an active construction root are present; preserve every byte and resolve the ambiguity");
        if (!activeInfo.isDirectory() || activeInfo.isSymbolicLink()) {
          throw failClosed("the fixed active transaction slot is not one owned directory");
        }
        await assertOwnedSecureDirectory(paths.activePath, "active transaction slot", context.parentDevice);
        const journalInfo = await inspectedPath(paths.journalPath);
        if (!journalInfo) throw failClosed("the fixed active transaction slot has no durable journal");
        await assertJournalFile(paths.journalPath, "active transaction journal");
        const transaction = await loadTransaction(paths.journalPath, options);
        assertTransaction(transaction, context, options);
        await assertSiblingArtifactTopology(context, options, transaction);
        if (transaction.phase === "archived") throw failClosed("an archived transaction journal remained in the fixed active slot");
        if (transaction.phase === "ready") await assertReadyRoot(transaction, context);
        if (transaction.phase === "restored") await assertRestoredState(transaction, context);
        if (transaction.phase === "archive-intent") await assertRestoredRoots(transaction, context);
        return {
          status: transaction.phase === "archived" ? "archived" : "active",
          phase: transaction.phase,
          journalPath: paths.journalPath,
          activePath: transaction.activePath,
          quarantinePath: transaction.quarantinePath,
          freshRetainedPath: transaction.freshRetainedPath,
          archivePath: transaction.archivePath,
          runId: transaction.runId,
          stateScope: transaction.stateScope,
        };
      }

      if (building.length > 1) throw failClosed("multiple active transaction construction roots are present; retain every root and recover only after resolving the ambiguity");
      if (building.length === 1) {
        const transaction = building[0];
        await assertSiblingArtifactTopology(context, options, transaction);
        return {
          status: "recovery-required",
          phase: transaction.phase,
          journalPath: transaction.journalPath,
          activePath: paths.activePath,
          constructionPath: transaction.constructionPath,
          quarantinePath: transaction.quarantinePath,
          freshRetainedPath: transaction.freshRetainedPath,
          archivePath: transaction.archivePath,
          runId: transaction.runId,
          stateScope: transaction.stateScope,
        };
      }

      await assertSiblingArtifactTopology(context, options);
      for (const transaction of archived) {
        if (transaction.phase === "archived") await assertArchivedState(transaction, context);
        if (transaction.phase === "archive-intent") await assertRestoredRoots(transaction, context);
      }
      const recovery = archived.find((transaction) => transaction.phase !== "archived");
      return {
        status: recovery ? "recovery-required" : archived.length > 0 ? "archived" : "absent",
        phase: recovery?.phase,
        journalPath: recovery?.journalPath,
        activePath: paths.activePath,
        archived: archived.map((transaction) => ({
          phase: transaction.phase,
          journalPath: transaction.journalPath,
          freshRetainedPath: transaction.freshRetainedPath,
          archivePath: transaction.archivePath,
          runId: transaction.runId,
          stateScope: transaction.stateScope,
        })),
      };
    });
  } catch (error) {
    throw asCleanupError("could not read runtime-root preservation status", error);
  }
}

/**
 * Assert that a caller is still at the safe pre-write boundary. This is kept
 * separate so package composition can prove that the identity path is absent
 * immediately before it writes the package transaction.
 */
export async function assertMasGateSessionReady(transactionOrJournal, options = {}) {
  try {
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async () => {
      const transaction = await loadTransaction(transactionOrJournal, options);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "ready");
      assertTransaction(transaction, context, options);
      await assertSiblingArtifactTopology(context, options, transaction);
      if (transaction.phase !== "ready") throw failClosed(`runtime transaction is not ready for writes: ${transaction.phase}`);
      await assertNoLiveOwnedRuntime(options, context, "before package/runtime write");
      await assertReadyRoot(transaction, context);
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not prove the runtime-root write boundary", error);
  }
}

/**
 * Return an aggregate attestation without exposing child names or inventories.
 */
export async function attestMasGateRuntimeRoot(runtimeRoot, options = {}) {
  try {
    const root = canonicalAbsolute(runtimeRoot, "runtime root");
    assertWholeRuntimeRoot(root, "attestation");
    return (await attestRoot(root, {
      expectedDevice: options.expectedDevice,
      requireOwnerUid: options.requireOwnerUid ?? false,
    })).aggregateAttestation;
  } catch (error) {
    throw asCleanupError("could not attest the runtime root", error);
  }
}

function transactionPaths(context, runId) {
  const fixed = fixedTransactionPaths(context);
  return {
    ...fixed,
    constructionPath: path.join(context.parentPath, `${QUARANTINE_PREFIX}${runId}${ACTIVE_BUILDING_SUFFIX}`),
    quarantinePath: path.join(context.parentPath, `${QUARANTINE_PREFIX}${runId}${QUARANTINE_SUFFIX}`),
    freshRetainedPath: path.join(context.parentPath, `${QUARANTINE_PREFIX}${runId}${FRESH_RETAINED_SUFFIX}`),
    archivePath: path.join(context.parentPath, `${QUARANTINE_PREFIX}${runId}${ARCHIVE_SUFFIX}`),
  };
}

function fixedTransactionPaths(context) {
  const activePath = context.activePath;
  return {
    activePath,
    journalPath: path.join(activePath, JOURNAL_BASENAME),
  };
}

async function promoteActiveConstruction(transaction, options, context) {
  const active = await inspectedPath(transaction.activePath);
  const construction = await inspectedPath(transaction.constructionPath);
  if (active && construction) throw failClosed("both the fixed active transaction slot and its construction root are present");
  if (active) {
    if (active.isSymbolicLink() || !active.isDirectory()) throw failClosed("fixed active transaction slot is not one secure directory");
    await assertOwnedSecureDirectory(transaction.activePath, "active transaction slot", context.parentDevice);
    transaction.journalPath = path.join(transaction.activePath, JOURNAL_BASENAME);
    await assertJournalFile(transaction.journalPath, "active transaction journal");
    return;
  }
  if (!construction) throw failClosed("active transaction construction root disappeared before publication");
  if (construction.isSymbolicLink() || !construction.isDirectory()) throw failClosed("active transaction construction root is not one secure directory");
  await assertJournalFile(path.join(transaction.constructionPath, JOURNAL_BASENAME), "construction transaction journal");
  await renameWithDurability(
    transaction.constructionPath,
    transaction.activePath,
    context.parentPath,
    "active transaction publish rename",
    options,
    transaction,
  );
  transaction.journalPath = path.join(transaction.activePath, JOURNAL_BASENAME);
  await assertOwnedSecureDirectory(transaction.activePath, "active transaction slot", context.parentDevice);
  await writeJournal(transaction, options);
}

function parentPathHint(options) {
  const value = options?.runtimeRootParent ?? options?.contractRuntimeParent ??
    options?.contract?.parent ?? (typeof options?.contractRuntimeRoot === "string" ? path.dirname(options.contractRuntimeRoot) : null) ??
    (typeof options?.runtimeRoot === "string" ? path.dirname(options.runtimeRoot) : null);
  if (typeof value !== "string") throw failClosed("runtime-root parent is required before acquiring the MAS gate lock");
  return value;
}

async function validateContext(options, operation) {
  const runtimeRoot = canonicalAbsolute(options.runtimeRoot, "runtime root");
  const contractRuntimeRoot = canonicalAbsolute(
    options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
    "contract-derived runtime root",
  );
  if (runtimeRoot !== contractRuntimeRoot) {
    throw failClosed(`${operation} runtime root is not the exact contract-derived runtime root`);
  }
  assertWholeRuntimeRoot(runtimeRoot, operation);

  const parentPath = canonicalAbsolute(
    options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent ?? path.dirname(contractRuntimeRoot),
    "runtime root parent",
  );
  if (parentPath !== path.dirname(runtimeRoot)) {
    throw failClosed(`${operation} runtime root parent is not the exact parent of the contract-derived root`);
  }
  await assertCanonicalParent(parentPath);

  const identityRelativePath = normalizeIdentityRelativePath(
    options.identityRelativePath ?? options.contract?.identityRelativePath,
  );
  const identityPath = canonicalAbsolute(options.identityPath, "identity path");
  if (identityPath !== path.join(runtimeRoot, identityRelativePath)) {
    throw failClosed(`${operation} identity path is not bound to the exact runtime root and relative identity path`);
  }
  if (options.contract?.identityPath !== undefined && canonicalAbsolute(options.contract.identityPath, "contract identity path") !== identityPath) {
    throw failClosed(`${operation} identity path differs from the contract-derived identity path`);
  }

  const activePath = canonicalAbsolute(options.activePath ?? path.join(parentPath, ACTIVE_BASENAME), "active transaction path");
  if (activePath !== path.join(parentPath, ACTIVE_BASENAME)) {
    throw failClosed(`${operation} active transaction path is not the fixed sibling lock location`);
  }
  for (const [label, candidate] of [
    ["active transaction path", activePath],
    ["identity path", identityPath],
  ]) {
    if (pathInside(candidate, runtimeRoot) && label === "active transaction path") {
      throw failClosed(`${label} aliases the movable runtime root`);
    }
  }

  const existingRoot = await inspectedPath(runtimeRoot);
  if (existingRoot?.isSymbolicLink()) throw failClosed("canonical runtime root is a symlink");
  if (existingRoot && !existingRoot.isDirectory()) throw failClosed("canonical runtime root is not a directory");
  if (existingRoot && existingRoot.dev !== (await lstat(parentPath)).dev) {
    throw failClosed("canonical runtime root and its parent are on different devices");
  }
  if (existingRoot) await assertNoSymlinkAncestors(identityPath, runtimeRoot);

  return {
    runtimeRoot,
    parentPath,
    parentDevice: integerValue((await lstat(parentPath)).dev),
    identityRelativePath,
    identityPath,
    activePath,
    operation,
  };
}

function assertWholeRuntimeRoot(runtimeRoot, operation) {
  if (path.basename(runtimeRoot) === "paseo-home") {
    throw failClosed(`${operation} requires the whole runtime root; paseo-home is a child subtree and is not a transaction root`);
  }
}

async function assertCanonicalParent(parentPath) {
  const parent = await lstat(parentPath).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`runtime root parent does not exist: ${parentPath}`);
    throw error;
  });
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw failClosed("runtime root parent is not a real directory");
  if (parent.uid !== currentUid()) throw failClosed("runtime root parent owner does not match the current run owner");
  if ((parent.mode & 0o022) !== 0) throw failClosed("runtime root parent is writable by a group or other user");
  const resolvedParent = await realpath(parentPath);
  if (resolvedParent !== parentPath) throw failClosed("runtime root parent is a path alias through a symlink");
  return parent;
}

async function inspectFreeSpace(parentPath, requiredInput) {
  const requiredFreeBytes = normalizePositiveBytes(requiredInput);
  const result = await statfs(parentPath, { bigint: true });
  const observedBigInt = BigInt(result.bavail) * BigInt(result.bsize);
  if (observedBigInt < BigInt(requiredFreeBytes)) {
    throw failClosed(
      `required free space ${requiredFreeBytes} bytes exceeds observed available space ${formatBytes(observedBigInt)} bytes`,
    );
  }
  return {
    requiredFreeBytes,
    observedFreeBytes: formatBytes(observedBigInt),
  };
}

async function inspectPriorRoot(context) {
  const inspected = await inspectedPath(context.runtimeRoot);
  if (!inspected) {
    return { exists: false, rootIdentity: null, aggregateAttestation: null };
  }
  if (inspected.isSymbolicLink()) throw failClosed("canonical runtime root is a symlink");
  if (!inspected.isDirectory()) throw failClosed("canonical runtime root is a special or non-directory file");
  if (inspected.uid !== currentUid()) throw failClosed("canonical runtime root owner does not match the current run owner");
  const prior = await attestRoot(context.runtimeRoot, {
    expectedDevice: inspected.dev,
    requireOwnerUid: false,
  });
  const identityInfo = await inspectedPath(context.identityPath);
  if (identityInfo?.isSymbolicLink()) throw failClosed("identity path is a symlink inside the prior runtime root");
  if (identityInfo && !identityInfo.isFile()) throw failClosed("identity path is not one regular file in the prior runtime root");
  return {
    exists: true,
    rootIdentity: prior.rootIdentity,
    aggregateAttestation: prior.aggregateAttestation,
  };
}

async function advancePreparation(transaction, options, context) {
  assertTransaction(transaction, context, options);
  await promoteActiveConstruction(transaction, options, context);
  assertTransaction(transaction, context, options);

  if (phaseRank(transaction.phase) < phaseRank("quarantined")) {
    if (transaction.phase === "prepared") await transition(transaction, "quarantine-intent", options);
    await reconcileQuarantine(transaction, context, options);
    await transition(transaction, "quarantined", options);
  }

  if (phaseRank(transaction.phase) < phaseRank("fresh-created")) {
    if (transaction.phase === "quarantined") await transition(transaction, "fresh-intent", options);
    await reconcileFreshCreation(transaction, context, options);
    await transition(transaction, "fresh-created", options);
  }

  if (transaction.phase === "fresh-created") {
    await reconcileFreshCreation(transaction, context, options);
    await transition(transaction, "ready", options);
  }
}

async function reconcileQuarantine(transaction, context, options) {
  const canonical = await inspectedPath(context.runtimeRoot);
  const quarantine = await inspectedPath(transaction.quarantinePath);
  if (transaction.priorExists) {
    if (canonical && quarantine) throw failClosed("both canonical and quarantine prior roots are present");
    if (!canonical && !quarantine) throw failClosed("neither canonical nor quarantine prior root is present");
    if (quarantine) {
      await assertAttestation(transaction.quarantinePath, transaction.priorAggregateAttestation, "quarantine prior root");
      return;
    }
    await assertAttestation(context.runtimeRoot, transaction.priorAggregateAttestation, "canonical prior root");
    await renameWithDurability(context.runtimeRoot, transaction.quarantinePath, context.parentPath, "runtime quarantine rename", options, transaction);
    if (await inspectedPath(context.runtimeRoot)) throw failClosed("canonical runtime root remained after quarantine rename");
    await assertAttestation(transaction.quarantinePath, transaction.priorAggregateAttestation, "quarantine prior root");
    return;
  }

  if (canonical || quarantine) {
    throw failClosed("an unexpected runtime root appeared while prior absence was recorded");
  }
}

async function reconcileFreshCreation(transaction, context, options) {
  const canonical = await inspectedPath(context.runtimeRoot);
  let freshIdentityJournaled = false;
  if (canonical) {
    if (canonical.isSymbolicLink() || !canonical.isDirectory()) throw failClosed("fresh canonical runtime root is not one directory");
    if (!transaction.freshRootIdentity) {
      assertFreshCanonicalDirectory(canonical, context);
      transaction.freshRootIdentity = identityOf(canonical);
      freshIdentityJournaled = true;
    }
    assertRootIdentity(canonical, transaction.freshRootIdentity, "fresh canonical runtime root");
  } else {
    if (transaction.freshRootIdentity) throw failClosed("fresh canonical runtime root disappeared after its identity was journaled");
    throwInjectedFsError(options, "mkdir-fresh");
    await mkdir(context.runtimeRoot, { recursive: false, mode: 0o700 });
    await syncDirectory(context.parentPath);
    await maybeFault(options, transaction, "fresh-mkdir", "after fresh canonical runtime-root directory creation");
    const fresh = await lstat(context.runtimeRoot);
    assertFreshCanonicalDirectory(fresh, context);
    transaction.freshRootIdentity = identityOf(fresh);
    freshIdentityJournaled = true;
  }

  if (freshIdentityJournaled) {
    await writeJournal(transaction, options);
    await maybeFault(options, transaction, "fresh-identity-journaled", "after the fresh root identity was durably journaled");
  }

  if (await inspectedPath(transaction.quarantinePath) !== null && !transaction.priorExists) {
    throw failClosed("unexpected quarantine root exists for a recorded prior absence");
  }
  if (await inspectedPath(transaction.freshRetainedPath) !== null) {
    throw failClosed("fresh retained root appeared before the fresh canonical root was detached");
  }
  if (await inspectedPath(context.identityPath) !== null) {
    throw failClosed("identity path was not absent in the fresh canonical runtime root");
  }
  const freshNames = await readdir(context.runtimeRoot);
  if (freshNames.length > 0) {
    throw failClosed("unexpected state appeared in the fresh runtime root before the write boundary");
  }
  assertRootIdentity(await lstat(context.runtimeRoot), transaction.freshRootIdentity, "fresh canonical runtime root");
}

function assertFreshCanonicalDirectory(info, context) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw failClosed("fresh canonical runtime root is not one directory");
  if (info.uid !== currentUid() || (info.mode & POSIX_MODE_MASK) !== 0o700) {
    throw failClosed("fresh canonical runtime root does not have exact run ownership and mode");
  }
  if (info.dev !== context.parentDevice) throw failClosed("fresh canonical runtime root is on a different device");
}

async function assertReady(transaction, options, context) {
  if (transaction.phase !== "ready") throw failClosed(`runtime transaction is not ready: ${transaction.phase}`);
  await assertNoLiveOwnedRuntime(options, context, "at the runtime-root write boundary");
  await assertReadyRoot(transaction, context);
}

async function assertReadyRoot(transaction, context) {
  if (transaction.phase !== "ready") throw failClosed(`runtime transaction is not ready: ${transaction.phase}`);
  const canonical = await lstat(context.runtimeRoot).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed("fresh canonical runtime root is missing at the write boundary");
    throw error;
  });
  if (canonical.isSymbolicLink() || !canonical.isDirectory()) throw failClosed("fresh canonical runtime root is not one directory at the write boundary");
  assertRootIdentity(canonical, transaction.freshRootIdentity, "fresh canonical runtime root");
  if (await inspectedPath(context.identityPath) !== null) throw failClosed("identity path is not absent in the fresh canonical runtime root");
  if (transaction.priorExists) {
    await assertAttestation(transaction.quarantinePath, transaction.priorAggregateAttestation, "quarantine prior root");
  } else if (await inspectedPath(transaction.quarantinePath) !== null) {
    throw failClosed("unexpected quarantine root exists at the ready boundary");
  }
}

async function assertRestoredState(transaction, context) {
  await assertOwnedSecureDirectory(transaction.activePath, "active transaction slot", context.parentDevice);
  if (await inspectedPath(transaction.constructionPath)) throw failClosed("active transaction construction root remained after publication");
  await assertJournalFile(transaction.journalPath, "active transaction journal");
  await assertRestoredRoots(transaction, context);
}

async function assertArchivedState(transaction, context) {
  await assertRestoredRoots(transaction, context);
  if (await inspectedPath(transaction.activePath)) throw failClosed("fixed active transaction slot remained after archive");
  if (await inspectedPath(transaction.constructionPath)) throw failClosed("active transaction construction root remained after archive");
  await assertOwnedSecureDirectory(transaction.archivePath, "archived transaction slot", context.parentDevice);
  await assertJournalFile(transaction.journalPath, "archived transaction journal");
}

async function assertRestoredRoots(transaction, context) {
  const canonical = await inspectedPath(context.runtimeRoot);
  const quarantine = await inspectedPath(transaction.quarantinePath);
  if (transaction.priorExists) {
    if (!canonical && !quarantine) throw failClosed("neither restored canonical nor quarantine prior root is present");
    if (canonical && quarantine) throw failClosed("both restored canonical and quarantine prior roots are present");
    if (!canonical) throw failClosed("restored canonical prior root is missing");
    await assertAttestation(context.runtimeRoot, transaction.priorAggregateAttestation, "restored canonical prior root");
  } else if (canonical || quarantine) {
    throw failClosed("an unexpected root appeared after restoring recorded prior absence");
  }

  const retained = await inspectedPath(transaction.freshRetainedPath);
  if (!retained) throw failClosed("retained fresh runtime root is missing after restore");
  assertFreshRetainedRoot(retained, transaction, context.parentDevice);
  if (transaction.freshRetainedRootIdentity && !sameIdentity(identityOf(retained), transaction.freshRetainedRootIdentity)) {
    throw failClosed("retained fresh runtime root identity changed outside the transaction");
  }
}

async function restoreInternal(transaction, options, context) {
  if (phaseRank(transaction.phase) < phaseRank("detach-intent")) {
    await assertIdentityAbsentBeforeRestore(transaction, context);
    await assertNoLiveOwnedRuntime(options, context, "before fresh-root detach");
    await transition(transaction, "detach-intent", options);
  }
  if (phaseRank(transaction.phase) < phaseRank("fresh-retained")) {
    await reconcileFreshDetach(transaction, context, options);
    await transition(transaction, "fresh-retained", options);
  }
  if (phaseRank(transaction.phase) < phaseRank("restore-intent")) {
    await assertNoLiveOwnedRuntime(options, context, "before prior-root restore");
    await transition(transaction, "restore-intent", options);
  }
  if (phaseRank(transaction.phase) < phaseRank("restored")) {
    await reconcilePriorRestore(transaction, options, context);
    await transition(transaction, "restored", options);
  }
}

async function assertIdentityAbsentBeforeRestore(transaction, context) {
  await assertNoSymlinkAncestors(context.identityPath, context.runtimeRoot);
  if (await inspectedPath(context.identityPath) !== null) {
    throw failClosed(
      `package identity remains in the fresh runtime for session ${transaction.runId}; complete package rollback before runtime restore`,
    );
  }
}

async function reconcileFreshDetach(transaction, context, options) {
  const canonical = await inspectedPath(context.runtimeRoot);
  const retained = await inspectedPath(transaction.freshRetainedPath);
  if (canonical && retained) throw failClosed("both fresh canonical and fresh retained runtime roots are present");
  if (!canonical && !retained) throw failClosed("neither fresh canonical nor fresh retained runtime root is present");
  if (retained) {
    assertFreshRetainedRoot(retained, transaction, context.parentDevice);
    transaction.freshRetainedRootIdentity = identityOf(retained);
    return;
  }
  if (canonical.isSymbolicLink() || !canonical.isDirectory()) throw failClosed("fresh canonical runtime root is not one directory");
  assertRootIdentity(canonical, transaction.freshRootIdentity, "fresh canonical runtime root before detach");
  await renameWithDurability(context.runtimeRoot, transaction.freshRetainedPath, context.parentPath, "fresh runtime detach rename", options, transaction);
  if (await inspectedPath(context.runtimeRoot)) throw failClosed("fresh canonical runtime root remained after detach");
  const moved = await lstat(transaction.freshRetainedPath);
  assertFreshRetainedRoot(moved, transaction, context.parentDevice);
  transaction.freshRetainedRootIdentity = identityOf(moved);
}

async function reconcilePriorRestore(transaction, options, context) {
  await assertNoLiveOwnedRuntime(options, context, "before checking prior-root restore");
  const canonical = await inspectedPath(context.runtimeRoot);
  const quarantine = await inspectedPath(transaction.quarantinePath);
  if (transaction.priorExists) {
    if (canonical && quarantine) throw failClosed("both restored canonical and quarantine prior roots are present");
    if (!canonical && !quarantine) throw failClosed("neither restored canonical nor quarantine prior root is present");
    if (canonical) {
      await assertAttestation(context.runtimeRoot, transaction.priorAggregateAttestation, "restored canonical prior root");
      return;
    }
    await assertAttestation(transaction.quarantinePath, transaction.priorAggregateAttestation, "quarantine prior root");
    await renameWithDurability(transaction.quarantinePath, context.runtimeRoot, context.parentPath, "prior runtime restore rename", options, transaction);
    await assertAttestation(context.runtimeRoot, transaction.priorAggregateAttestation, "restored canonical prior root");
    return;
  }

  if (canonical || quarantine) throw failClosed("an unexpected root appeared while restoring recorded prior absence");
}

async function completeArchive(transaction, options, context) {
  if (transaction.phase === "archived") {
    const archive = await lstat(transaction.archivePath).catch((error) => {
      if (isCode(error, "ENOENT")) throw failClosed("archived transaction slot is missing");
      throw error;
    });
    if (archive.isSymbolicLink() || !archive.isDirectory()) throw failClosed("archived transaction slot is not one directory");
    if (await inspectedPath(transaction.activePath)) throw failClosed("fixed active transaction slot remained after archive");
    return;
  }

  if (transaction.phase !== "restored" && transaction.phase !== "archive-intent") {
    throw failClosed(`cannot complete archive in phase ${transaction.phase}`);
  }
  await assertRestoredRoots(transaction, context);
  await assertNoLiveOwnedRuntime(options, context, "before archiving the restored session");
  if (!transaction.archivePath) {
    transaction.archivePath = path.join(context.parentPath, `${QUARANTINE_PREFIX}${transaction.runId}${ARCHIVE_SUFFIX}`);
    await assertAbsent(transaction.archivePath, "archived transaction slot");
  }

  if (transaction.phase === "restored") await transition(transaction, "archive-intent", options);
  const active = await lstat(transaction.activePath).catch((error) => {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  });
  const archive = await inspectedPath(transaction.archivePath);
  if (active && archive) throw failClosed("both active and archived transaction slots are present");
  if (!active && !archive) throw failClosed("neither active nor archived transaction slot is present");
  if (active) {
    if (active.isSymbolicLink() || !active.isDirectory()) throw failClosed("active transaction slot is not one directory");
    await assertOwnedSecureDirectory(transaction.activePath, "active transaction slot", context.parentDevice);
    await renameWithDurability(transaction.activePath, transaction.archivePath, context.parentPath, "completed session archive rename", options, transaction);
    if (await inspectedPath(transaction.activePath)) throw failClosed("fixed active transaction slot remained after archive rename");
    await maybeFault(options, transaction, "archive-renamed", "after completed session archive rename");
  } else {
    if (archive.isSymbolicLink() || !archive.isDirectory()) throw failClosed("archived transaction slot is not one directory");
  }

  transaction.journalPath = path.join(transaction.archivePath, JOURNAL_BASENAME);
  await assertOwnedSecureDirectory(transaction.archivePath, "archived transaction slot", context.parentDevice);
  if (transaction.phase !== "archived") await transition(transaction, "archived", options);
}

async function loadTransaction(transactionOrJournal, options) {
  let journalPath;
  if (typeof transactionOrJournal === "string") {
    journalPath = canonicalAbsolute(transactionOrJournal, "transaction journal path");
  } else {
    if (!transactionOrJournal || typeof transactionOrJournal !== "object") throw failClosed("transaction journal data is missing");
    journalPath = transactionOrJournal.journalPath ?? path.join(transactionOrJournal.activePath ?? "", JOURNAL_BASENAME);
  }
  journalPath = canonicalAbsolute(journalPath, "transaction journal path");
  await assertJournalFile(journalPath, "transaction journal");
  let decoded;
  try {
    decoded = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    throw failClosed("transaction journal is malformed or unreadable", error);
  }
  decoded.journalPath = journalPath;
  return decoded;
}

function assertTransaction(transaction, context, options = {}) {
  if (!transaction || transaction.schema !== MAS_GATE_SESSION_TRANSACTION_SCHEMA || transaction.version !== MAS_GATE_SESSION_TRANSACTION_VERSION) {
    throw failClosed("transaction journal schema or version is invalid");
  }
  if (typeof transaction.ownerToken !== "string" || !/^[A-Za-z0-9_-]{40,80}$/u.test(transaction.ownerToken)) {
    throw failClosed("transaction journal owner token is invalid");
  }
  if (options.ownerToken !== undefined && transaction.ownerToken !== options.ownerToken) throw failClosed("transaction owner token mismatch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(transaction.runId ?? "")) throw failClosed("transaction run ID is invalid");
  if (transaction.stateScope !== "runtime-root-only") throw failClosed("transaction state scope is not runtime-root-only");
  if (transaction.canonicalRuntimeRoot !== context.runtimeRoot || transaction.runtimeRoot !== context.runtimeRoot) {
    throw failClosed("transaction canonical runtime root differs from the contract-derived root");
  }
  if (transaction.canonicalPath !== context.runtimeRoot) throw failClosed("transaction canonical path is not exact");
  if (transaction.parentPath !== context.parentPath) throw failClosed("transaction parent path differs from the contract-derived parent");
  if (transaction.parent !== context.parentPath) throw failClosed("transaction parent record is not exact");
  if (transaction.lockPath !== masGateLockPath(context.parentPath) || pathInside(transaction.lockPath, context.runtimeRoot)) {
    throw failClosed("transaction lock path is not the exact stable sibling lock");
  }
  if (transaction.activePath !== context.activePath) throw failClosed("transaction active path differs from the fixed active slot");
  if (transaction.active !== context.activePath) throw failClosed("transaction active record is not exact");
  const expected = transactionPaths(context, transaction.runId);
  if (transaction.constructionPath !== expected.constructionPath) throw failClosed("transaction construction path is not the exact run-derived sibling");
  if (transaction.quarantinePath !== expected.quarantinePath || transaction.freshRetainedPath !== expected.freshRetainedPath) {
    throw failClosed("transaction quarantine or retained path is not the exact run-derived sibling");
  }
  if (transaction.quarantine !== expected.quarantinePath || transaction.freshRetained !== expected.freshRetainedPath) {
    throw failClosed("transaction quarantine or retained path record is not exact");
  }
  if (transaction.archivePath !== null && transaction.archivePath !== expected.archivePath) {
    throw failClosed("transaction archive path is not the exact run-derived sibling");
  }
  if (transaction.identityRelativePath !== context.identityRelativePath || transaction.identityPath !== context.identityPath) {
    throw failClosed("transaction identity binding differs from the contract-derived path");
  }
  if (transaction.identity?.relativePath !== context.identityRelativePath || transaction.identity?.path !== context.identityPath) {
    throw failClosed("transaction identity record is not exact");
  }
  const validJournalPaths = new Set([
    path.join(transaction.activePath, JOURNAL_BASENAME),
    path.join(transaction.constructionPath, JOURNAL_BASENAME),
    ...(transaction.archivePath ? [path.join(transaction.archivePath, JOURNAL_BASENAME)] : []),
  ]);
  if (!validJournalPaths.has(transaction.journalPath)) throw failClosed("transaction journal path is not the active or archived journal");

  validatePhaseHistory(transaction);
  if (typeof transaction.priorExists !== "boolean") throw failClosed("transaction prior existence is missing");
  if (transaction.priorExists !== (transaction.priorAggregateAttestation !== null)) throw failClosed("transaction prior attestation presence is inconsistent");
  if (transaction.priorExists) validateAggregateAttestation(transaction.priorAggregateAttestation, "prior runtime attestation");
  if (transaction.priorExists !== (transaction.priorRootIdentity !== null)) throw failClosed("transaction prior root identity presence is inconsistent");
  if (transaction.priorRootIdentity) validateIdentity(transaction.priorRootIdentity, "prior root identity");
  if (!transaction.prior || transaction.prior.exists !== transaction.priorExists ||
      (transaction.priorExists && (!sameIdentity(transaction.prior.rootIdentity, transaction.priorRootIdentity) ||
        !sameAggregate(transaction.prior.aggregateAttestation, transaction.priorAggregateAttestation))) ||
      (!transaction.priorExists && (transaction.prior.rootIdentity !== null || transaction.prior.aggregateAttestation !== null))) {
    throw failClosed("transaction prior-state record is not exact");
  }
  if (transaction.freshRootIdentity !== null) validateIdentity(transaction.freshRootIdentity, "fresh root identity");
  if (transaction.freshRetainedRootIdentity !== null) validateIdentity(transaction.freshRetainedRootIdentity, "fresh retained root identity");
  if (!isPositiveByteValue(transaction.requiredFreeBytes) || !isPositiveByteValue(transaction.observedFreeBytes)) {
    throw failClosed("transaction free-space record is invalid");
  }
  if (BigInt(transaction.observedFreeBytes) < BigInt(transaction.requiredFreeBytes)) throw failClosed("transaction observed free space is below its required free-space input");

  const rank = phaseRank(transaction.phase);
  if (rank >= phaseRank("fresh-created") && transaction.freshRootIdentity === null) throw failClosed("fresh-root phase lacks its durable root identity");
  if (rank >= phaseRank("fresh-retained") && transaction.freshRetainedRootIdentity === null) throw failClosed("fresh-retained phase lacks its durable root identity");
  if (rank >= phaseRank("archive-intent") && transaction.archivePath === null) throw failClosed("archive phase lacks its durable archive path");
}

function validatePhaseHistory(transaction) {
  if (!Array.isArray(transaction.phaseHistory) || transaction.phaseHistory.length === 0) throw failClosed("transaction phase history is missing");
  let previous = -1;
  for (const phase of transaction.phaseHistory) {
    const rank = phaseRank(phase);
    if (rank <= previous) throw failClosed("transaction journal phase history is non-monotonic");
    previous = rank;
  }
  if (transaction.phaseHistory.at(-1) !== transaction.phase) throw failClosed("transaction current phase does not match its phase history");
}

function validateIdentity(identity, label) {
  if (!identity || typeof identity !== "object") throw failClosed(`${label} is missing`);
  for (const field of ["dev", "ino", "mode", "uid", "gid", "nlink", "size"]) {
    if (!isNonNegativeIntegerValue(identity[field])) throw failClosed(`${label} has an invalid ${field}`);
  }
  if (identity.type !== "directory") throw failClosed(`${label} is not a directory identity`);
}

function validateAggregateAttestation(attestation, label) {
  if (!attestation || attestation.schema !== MAS_GATE_RUNTIME_ROOT_ATTESTATION_SCHEMA || !/^[a-f0-9]{64}$/u.test(attestation.digest ?? "")) {
    throw failClosed(`${label} schema or digest is invalid`);
  }
  for (const field of ["entryCount", "fileCount", "directoryCount", "symlinkCount", "hardlinkGroupCount", "byteCount"]) {
    if (!isNonNegativeIntegerValue(attestation[field])) throw failClosed(`${label} has an invalid ${field}`);
  }
  if (!attestation.root || attestation.root.type !== "directory") throw failClosed(`${label} lacks its root identity`);
  validateIdentity(attestation.root, `${label} root identity`);
}

async function assertAttestation(root, expected, label) {
  if (!expected) throw failClosed(`${label} expected attestation is missing`);
  const actual = await attestRoot(root, { expectedDevice: expected.root.dev, requireOwnerUid: false });
  if (!sameAggregate(actual.aggregateAttestation, expected)) throw failClosed(`${label} attestation changed; preserving every remaining byte`);
  return actual;
}

function sameAggregate(actual, expected) {
  return actual.schema === expected.schema &&
    actual.digest === expected.digest &&
    actual.entryCount === expected.entryCount &&
    actual.fileCount === expected.fileCount &&
    actual.directoryCount === expected.directoryCount &&
    actual.symlinkCount === expected.symlinkCount &&
    actual.hardlinkGroupCount === expected.hardlinkGroupCount &&
    actual.byteCount === expected.byteCount &&
    sameIdentity(actual.root, expected.root);
}

function assertFreshRetainedRoot(info, transaction, expectedDevice) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw failClosed("fresh retained runtime root is not one directory");
  assertRootIdentity(info, transaction.freshRootIdentity, "fresh retained runtime root");
  if (info.uid !== currentUid() || (info.mode & POSIX_MODE_MASK) !== 0o700 || (expectedDevice !== undefined && info.dev !== expectedDevice)) {
    throw failClosed("fresh retained runtime root ownership, mode, or device changed");
  }
}

function assertRootIdentity(actual, expected, label) {
  if (!expected || actual.isSymbolicLink() || !actual.isDirectory()) throw failClosed(`${label} is not one directory`);
  const identity = identityOf(actual);
  for (const field of ["dev", "ino", "mode", "uid", "gid"]) {
    if (identity[field] !== expected[field]) throw failClosed(`${label} ${field} changed outside the transaction`);
  }
}

function sameIdentity(actual, expected) {
  return ["type", "dev", "ino", "mode", "uid", "gid", "nlink", "size"].every((field) => actual[field] === expected[field]);
}

function assertStableIdentity(before, after, label) {
  if (!sameIdentity(identityOf(after), identityOf(before))) {
    throw failClosed(`${label} changed while it was being attested`);
  }
}

function identityOf(info) {
  return {
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special",
    mode: integerValue(info.mode),
    uid: integerValue(info.uid),
    gid: integerValue(info.gid),
    dev: integerValue(info.dev),
    ino: integerValue(info.ino),
    nlink: integerValue(info.nlink),
    size: integerValue(info.size),
  };
}

async function attestRoot(root, options = {}) {
  const rootInfo = await lstat(root).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`runtime root is missing: ${root}`);
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw failClosed("runtime root is a symlink, special file, or non-directory");
  const ownerUid = currentUid();
  if (options.requireOwnerUid && rootInfo.uid !== ownerUid) throw failClosed("runtime root owner does not match the current run owner");
  const expectedDevice = options.expectedDevice ?? rootInfo.dev;
  if (rootInfo.dev !== expectedDevice) throw failClosed("runtime root device does not match the transaction device");

  const entries = [];
  await visitRoot(root, root, rootInfo.dev, entries);
  const stableRoot = await lstat(root);
  assertStableIdentity(rootInfo, stableRoot, "runtime root");
  const filesByInode = new Map();
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const key = `${entry.dev}:${entry.ino}`;
    const group = filesByInode.get(key) ?? [];
    group.push(entry);
    filesByInode.set(key, group);
  }
  const orderedGroups = [...filesByInode.entries()].sort(([left], [right]) => left.localeCompare(right));
  const groupIds = new Map(orderedGroups.map(([key], index) => [key, index]));
  for (const [key, group] of orderedGroups) {
    const nlink = group[0].nlink;
    if (nlink !== group.length) {
      throw failClosed("runtime root contains a regular file hard-linked outside the quarantined subtree");
    }
    for (const entry of group) entry.hardlinkGroup = groupIds.get(key);
  }
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  const digestInput = entries.map((entry) => ({ ...entry }));
  const aggregate = {
    schema: MAS_GATE_RUNTIME_ROOT_ATTESTATION_SCHEMA,
    digest: sha256(Buffer.from(JSON.stringify({ root: identityOf(stableRoot), entries: digestInput }))),
    entryCount: entries.length,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    directoryCount: entries.filter((entry) => entry.type === "directory").length,
    symlinkCount: entries.filter((entry) => entry.type === "symlink").length,
    hardlinkGroupCount: orderedGroups.length,
    byteCount: entries.filter((entry) => entry.type === "file").reduce((sum, entry) => sum + BigInt(entry.size), 0n).toString(),
    root: identityOf(stableRoot),
  };
  return { rootIdentity: identityOf(stableRoot), aggregateAttestation: aggregate };
}

async function visitRoot(root, candidate, expectedDevice, entries) {
  const info = await lstat(candidate);
  if (info.dev !== expectedDevice) throw failClosed("runtime root contains a nested device change");
  const relative = path.relative(root, candidate).split(path.sep).join("/") || ".";
  if (info.isSymbolicLink()) {
    const target = await readlink(candidate);
    entries.push({
      relative,
      type: "symlink",
      mode: integerValue(info.mode),
      uid: integerValue(info.uid),
      gid: integerValue(info.gid),
      dev: integerValue(info.dev),
      ino: integerValue(info.ino),
      nlink: integerValue(info.nlink),
      size: integerValue(info.size),
      target,
    });
    const after = await lstat(candidate);
    assertStableIdentity(info, after, `runtime symlink ${relative}`);
    if (target !== await readlink(candidate)) throw failClosed(`runtime symlink ${relative} changed while it was being attested`);
    return;
  }
  if (info.isFile()) {
    const file = await hashStableFile(candidate, info);
    entries.push({
      relative,
      type: "file",
      mode: integerValue(info.mode),
      uid: integerValue(info.uid),
      gid: integerValue(info.gid),
      dev: integerValue(info.dev),
      ino: integerValue(info.ino),
      nlink: integerValue(info.nlink),
      size: integerValue(info.size),
      sha256: file.sha256,
      bytes: file.bytes,
    });
    return;
  }
  if (!info.isDirectory()) throw failClosed("runtime root contains a special file");
  entries.push({
    relative,
    type: "directory",
    mode: integerValue(info.mode),
    uid: integerValue(info.uid),
    gid: integerValue(info.gid),
    dev: integerValue(info.dev),
    ino: integerValue(info.ino),
    nlink: integerValue(info.nlink),
    size: integerValue(info.size),
  });
  const names = await readdir(candidate);
  names.sort();
  for (const name of names) await visitRoot(root, path.join(candidate, name), expectedDevice, entries);
  const afterNames = await readdir(candidate);
  afterNames.sort();
  if (JSON.stringify(afterNames) !== JSON.stringify(names)) {
    throw failClosed(`runtime directory ${relative} changed while it was being attested`);
  }
  const after = await lstat(candidate);
  assertStableIdentity(info, after, `runtime directory ${relative}`);
}

async function hashStableFile(candidate, before) {
  const hash = createHash("sha256");
  let bytes = 0n;
  const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
      bytes += BigInt(chunk.byteLength);
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(candidate);
  for (const field of ["dev", "ino", "mode", "uid", "gid", "nlink", "size"]) {
    if (before[field] !== after[field]) throw failClosed(`runtime file changed while it was being attested: ${field}`);
  }
  if (bytes !== BigInt(before.size)) throw failClosed("runtime file byte count changed while it was being attested");
  return { sha256: hash.digest("hex"), bytes: bytes.toString() };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function renameWithDurability(source, target, parentPath, label, options = {}, transaction = null) {
  try {
    await assertNoSymlinkPath(source, label);
    await assertAbsent(target, label);
    throwInjectedFsError(options, renameOperationFor(label));
    await rename(source, target);
    await syncDirectory(parentPath);
    if (transaction) await maybeFault(options, transaction, renameOperationFor(label), `after ${label}`);
  } catch (error) {
    if (isCode(error, "EXDEV")) throw failClosed(`${label} failed with EXDEV; no copy fallback is allowed`, error);
    if (isCode(error, "EBUSY") || isCode(error, "EPERM") || isCode(error, "ENOSPC")) {
      throw failClosed(`${label} failed with ${error.code}; every remaining byte is retained`, error);
    }
    throw error;
  }
}

async function transition(transaction, nextPhase, options) {
  if (phaseRank(nextPhase) <= phaseRank(transaction.phase)) throw failClosed("transaction phase transition is not monotonic");
  transaction.phase = nextPhase;
  transaction.phaseHistory.push(nextPhase);
  await writeJournal(transaction, options);
  await maybeFault(options, transaction, nextPhase, `after journal phase ${nextPhase}`);
}

async function writeJournal(transaction, options = {}) {
  assertJournalPathShape(transaction);
  throwInjectedFsError(options, "journal-write");
  const journalPath = transaction.journalPath;
  const parentPath = path.dirname(journalPath);
  await assertOwnedSecureDirectory(parentPath, "transaction journal parent");
  const bytes = Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`);
  const temporaryPath = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    const temporaryInfo = await lstat(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || temporaryInfo.uid !== currentUid() || temporaryInfo.nlink !== 1 || (temporaryInfo.mode & POSIX_MODE_MASK) !== 0o600) {
      throw failClosed("temporary transaction journal is not one secure regular file");
    }
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(parentPath);
    await assertJournalTargetSafe(journalPath);
    throwInjectedFsError(options, "journal-publish");
    await rename(temporaryPath, journalPath);
    await syncDirectory(parentPath);
    await maybeFault(options, transaction, "journal-published", "after durable journal publication");
  } catch (error) {
    if (isCode(error, "EXDEV") || isCode(error, "EBUSY") || isCode(error, "EPERM") || isCode(error, "ENOSPC")) {
      throw failClosed(`durable journal transition failed with ${error.code}; leave all roots intact`, error);
    }
    throw error;
  } finally {
    const leftover = await inspectedPath(temporaryPath);
    if (leftover) await unlink(temporaryPath).catch(() => undefined);
  }
}

function assertJournalPathShape(transaction) {
  if (!transaction.journalPath || !path.isAbsolute(transaction.journalPath)) throw failClosed("transaction journal path is missing");
  const allowed = [
    path.join(transaction.activePath, JOURNAL_BASENAME),
    path.join(transaction.constructionPath, JOURNAL_BASENAME),
    ...(transaction.archivePath ? [path.join(transaction.archivePath, JOURNAL_BASENAME)] : []),
  ];
  if (!allowed.includes(transaction.journalPath)) throw failClosed("transaction journal path is not canonical");
}

async function assertJournalTargetSafe(journalPath) {
  const info = await inspectedPath(journalPath);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 || (info.mode & POSIX_MODE_MASK) !== 0o600) {
    throw failClosed("transaction journal target is not one secure regular file");
  }
}

async function assertJournalFile(journalPath, label) {
  const info = await lstat(journalPath).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`${label} is missing`);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 || (info.mode & POSIX_MODE_MASK) !== 0o600) {
    throw failClosed(`${label} is not one secure regular file`);
  }
}

async function maybeFault(options, transaction, point, description) {
  const requested = options.faultAt;
  const matches = requested === point || requested === `after-${point}` || requested === `after:${point}`;
  const callbackMatch = typeof options.faultInjector === "function" ? await options.faultInjector({ point, phase: transaction.phase, transaction: journalSummary(transaction) }) : false;
  if (!matches && !callbackMatch) return;
  if (options.faultAction === "hard-exit" || options.hardExitOnFault === true) {
    process.kill(process.pid, "SIGKILL");
  }
  throw new Error(`injected MAS gate session interruption at ${point}: ${description}`);
}

function throwInjectedFsError(options, operation) {
  const requested = options?.faultErrorAt;
  if (requested !== operation && requested !== `after-${operation}` && requested !== `after:${operation}`) return;
  const code = options?.faultErrorCode;
  if (!["EXDEV", "EBUSY", "EPERM", "ENOSPC"].includes(code)) {
    throw failClosed(`fault injection for ${operation} requires one of EXDEV, EBUSY, EPERM, or ENOSPC`);
  }
  const error = new Error(`injected ${code} at ${operation}`);
  error.code = code;
  error.syscall = operation;
  throw error;
}

async function assertNoLiveOwnedRuntime(options, context, stage) {
  const adapter = options.assertNoLiveOwnedRuntime ?? options.hasLiveOwnedRuntime;
  if (typeof adapter !== "function") throw failClosed("no injected live-owned-runtime adapter was supplied");
  let result;
  try {
    result = await adapter({
      runtimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      stage,
      stateScope: "runtime-root-only",
    });
  } catch (error) {
    throw failClosed(`live-owned-runtime validation failed at ${stage}`, error);
  }
  if (!isValidatedAbsentObservation(result, context)) {
    if (result?.status === "live" || result === true || result?.live === true || result?.ownedRuntimeLive === true) {
      throw failClosed(`a live owned runtime was observed at ${stage}; refusing to move any root`);
    }
    throw failClosed(`live-owned-runtime validation was not an explicit absent result at ${stage}`);
  }
}

function isValidatedAbsentObservation(result, context) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const expectedKeys = ["status", "runtimeRoot", "parentPath", "stateScope", "processes", "listeners", "sockets", "openHandles"].sort();
  const actualKeys = Object.keys(result).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return result.status === "absent" &&
    result.runtimeRoot === context.runtimeRoot &&
    result.parentPath === context.parentPath &&
    result.stateScope === "runtime-root-only" &&
    Array.isArray(result.processes) && result.processes.length === 0 &&
    Array.isArray(result.listeners) && result.listeners.length === 0 &&
    Array.isArray(result.sockets) && result.sockets.length === 0 &&
    Array.isArray(result.openHandles) && result.openHandles.length === 0;
}

async function assertAbsent(candidate, label) {
  const info = await inspectedPath(candidate);
  if (info) throw failClosed(`${label} already exists: ${candidate}`);
}

async function assertNoSymlinkPath(candidate, label) {
  const info = await lstat(candidate).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`${label} source is missing`);
    throw error;
  });
  if (info.isSymbolicLink()) throw failClosed(`${label} source is a symlink`);
}

async function assertNoSymlinkAncestors(candidate, root) {
  let current = path.dirname(candidate);
  while (pathInside(current, root) && current !== root) {
    const info = await inspectedPath(current);
    if (!info) break;
    if (info.isSymbolicLink()) throw failClosed(`path alias through a symlink at ${current}`);
    if (!info.isDirectory()) throw failClosed(`path ancestor is not a directory at ${current}`);
    current = path.dirname(current);
  }
}

async function assertOwnedSecureDirectory(candidate, label, expectedDevice) {
  const info = await lstat(candidate).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`${label} is missing`);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid() || (info.mode & POSIX_MODE_MASK) !== 0o700 || (expectedDevice !== undefined && info.dev !== expectedDevice)) {
    throw failClosed(`${label} is not one secure directory owned by the current run`);
  }
  return info;
}

async function assertSiblingArtifactTopology(context, options, transaction = null) {
  const archiveOptions = { ...options };
  delete archiveOptions.ownerToken;
  const archived = await findArchivedTransactions(context, archiveOptions);
  const allowedNames = new Set([path.basename(context.activePath)]);
  for (const candidate of archived) {
    for (const artifact of [
      candidate.constructionPath,
      candidate.quarantinePath,
      candidate.freshRetainedPath,
      candidate.archivePath,
    ]) {
      if (artifact) allowedNames.add(path.basename(artifact));
    }
  }
  if (transaction) {
    for (const candidate of [
      transaction.constructionPath,
      transaction.quarantinePath,
      transaction.freshRetainedPath,
      transaction.archivePath,
    ]) {
      if (candidate) allowedNames.add(path.basename(candidate));
    }
  }
  const archivedNames = new Set(archived.map((candidate) => path.basename(candidate.archivePath)));
  const names = await readdir(context.parentPath);
  for (const name of names.filter((candidate) => candidate.startsWith(QUARANTINE_PREFIX))) {
    if (name.endsWith(ARCHIVE_SUFFIX)) {
      if (!archivedNames.has(name)) {
        throw failClosed(`unexpected archived MAS transaction artifact ${path.join(context.parentPath, name)}; preserve every byte and recover only the exact transaction`);
      }
      continue;
    }
    if (!allowedNames.has(name)) {
      throw failClosed(`unexpected MAS transaction artifact ${path.join(context.parentPath, name)}; preserve every byte and recover only the exact transaction`);
    }
  }
}

async function findArchivedTransactions(context, options) {
  const names = await readdir(context.parentPath);
  const matches = names.filter((name) => name.startsWith(QUARANTINE_PREFIX) && name.endsWith(ARCHIVE_SUFFIX));
  const transactions = [];
  for (const name of matches.sort()) {
    const archivePath = path.join(context.parentPath, name);
    const info = await lstat(archivePath);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failClosed("an archived transaction path is a symlink or non-directory");
    await assertOwnedSecureDirectory(archivePath, "archived transaction slot", context.parentDevice);
    const journalPath = path.join(archivePath, JOURNAL_BASENAME);
    await assertJournalFile(journalPath, "archived transaction journal");
    const transaction = await loadTransaction(journalPath, options);
    transaction.journalPath = journalPath;
    assertTransaction(transaction, context, options);
    transactions.push(transaction);
  }
  return transactions;
}

async function findBuildingTransactions(context, options) {
  const names = await readdir(context.parentPath);
  const matches = names.filter((name) => name.startsWith(QUARANTINE_PREFIX) && name.endsWith(ACTIVE_BUILDING_SUFFIX));
  const transactions = [];
  for (const name of matches.sort()) {
    const constructionPath = path.join(context.parentPath, name);
    const info = await lstat(constructionPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw failClosed("an active transaction construction path is a symlink or non-directory");
    }
    await assertOwnedSecureDirectory(constructionPath, "active transaction construction slot", context.parentDevice);
    const journalPath = path.join(constructionPath, JOURNAL_BASENAME);
    await assertJournalFile(journalPath, "construction transaction journal");
    const transaction = await loadTransaction(journalPath, options);
    transaction.journalPath = journalPath;
    assertTransaction(transaction, context, options);
    if (transaction.constructionPath !== constructionPath) throw failClosed("active construction journal path does not match its exact sibling");
    transactions.push(transaction);
  }
  return transactions;
}

async function inspectedPath(candidate) {
  return lstat(candidate).catch((error) => {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  });
}

function journalSummary(transaction) {
  return {
    schema: transaction.schema,
    version: transaction.version,
    runId: transaction.runId,
    phase: transaction.phase,
    stateScope: transaction.stateScope,
  };
}

function phaseRank(phase) {
  const rank = MAS_GATE_SESSION_PHASES.indexOf(phase);
  if (rank < 0) throw failClosed(`unknown MAS gate session phase: ${String(phase)}`);
  return rank;
}

function normalizeRunId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw failClosed("run ID must be a short canonical random-safe token");
  }
  return value;
}

function normalizeIdentityRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || path.normalize(value) !== value || value === "." || value.startsWith(`..${path.sep}`) || value === "..") {
    throw failClosed("identity relative path is not a normalized non-empty relative path");
  }
  return value;
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || value.includes("\0") || path.resolve(value) !== value) {
    throw failClosed(`${label} must be one exact canonical absolute path`);
  }
  return value;
}

function normalizePositiveBytes(value) {
  if ((typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") || String(value).trim() === "") {
    throw failClosed("requiredFreeBytes must be an explicit positive integer");
  }
  let normalized;
  try {
    normalized = BigInt(value);
  } catch {
    throw failClosed("requiredFreeBytes must be an explicit positive integer");
  }
  if (normalized <= 0n || (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0))) {
    throw failClosed("requiredFreeBytes must be an explicit positive integer");
  }
  return formatBytes(normalized);
}

function isPositiveByteValue(value) {
  try {
    return BigInt(value) > 0n && (typeof value !== "number" || Number.isSafeInteger(value));
  } catch {
    return false;
  }
}

function isNonNegativeIntegerValue(value) {
  try {
    return BigInt(value) >= 0n && (typeof value !== "number" || Number.isSafeInteger(value));
  } catch {
    return false;
  }
}

function integerValue(value) {
  if (typeof value !== "bigint") return value;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function formatBytes(value) {
  const big = BigInt(value);
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

function pathInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function currentUid() {
  if (typeof process.getuid !== "function") throw failClosed("runtime transaction ownership requires process UID support");
  return process.getuid();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

function renameOperationFor(label) {
  if (label.includes("active transaction")) return "rename-active-publish";
  if (label.includes("quarantine")) return "rename-quarantine";
  if (label.includes("detach")) return "rename-fresh-retained";
  if (label.includes("restore")) return "rename-prior-restore";
  if (label.includes("archive")) return "rename-archive";
  return `rename:${label}`;
}

function failClosed(reason, cause) {
  const error = new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: ${reason}${cause?.code ? ` (${cause.code})` : ""}`);
  error.code = MAS_GATE_CLEANUP_DIAGNOSTIC_CODE;
  if (cause) error.cause = cause;
  return error;
}

function asCleanupError(prefix, error) {
  if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return failClosed(`${prefix}: ${reason}`, error);
}
