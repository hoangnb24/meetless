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
  assertMasGateMutationLease,
  masGateLockPath,
  writeMasGateLockMetadata,
  withMasGateLock,
} from "./macos-mas-gate-lock.mjs";
import { assertMasGateArtifactBinding } from "./mas-gate-artifact-binding.mjs";

export const MAS_GATE_SESSION_TRANSACTION_SCHEMA = "MAS_GATE_SESSION_TRANSACTION v2";
export const MAS_GATE_SESSION_TRANSACTION_VERSION = 2;
export const MAS_GATE_RUNTIME_ROOT_ATTESTATION_SCHEMA = "MAS_GATE_RUNTIME_ROOT_ATTESTATION v1";
export const MAS_GATE_SESSION_INDEX_SCHEMA = "MAS_GATE_SESSION_INDEX v1";
export const MAS_GATE_SESSION_INDEX_VERSION = 1;
export const MAS_GATE_SESSION_INDEX_INTENT_SCHEMA = "MAS_GATE_SESSION_INDEX_INTENT v1";
export const MAS_GATE_SESSION_INDEX_INTENT_VERSION = 1;
export const MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY = "MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY_ATTEMPT_13 v1";
export const MAS_GATE_CLEANUP_DIAGNOSTIC_CODE = "MAS-GATE-CLEANUP-001";
export const MAS_GATE_CLEANUP_DIAGNOSTIC =
  `${MAS_GATE_CLEANUP_DIAGNOSTIC_CODE}: repository-authorized MAS gate cleanup owns only the ` +
  "runtime-root-only transaction boundary. Authority: " +
  "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and " +
  "docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: leave the " +
  "canonical, quarantine, and retained runtime roots intact; run the MAS gate " +
  "session status/recovery command before any further gate attempt.";

export const MAS_GATE_SESSION_PHASES = Object.freeze([
  "construction-intent",
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
  "index-initialize",
  "index-initialize-published",
  "index-intent",
  "index-intent-journaled",
  "index-published",
  "index-intent-committed",
  "construction-intent-journaled",
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
export const MAS_GATE_SESSION_INDEX_BASENAME = ".meetless-mas-gate-session.index";
export const MAS_GATE_SESSION_INDEX_INTENT_BASENAME = ".meetless-mas-gate-session.index-intent";
const ACTIVE_BUILDING_SUFFIX = ".active-building";
const ACTIVE_INTENT_SUFFIX = ".active-intent";
const JOURNAL_BASENAME = "transaction.json";
const QUARANTINE_PREFIX = ".meetless-mas-gate-session.";
const QUARANTINE_SUFFIX = ".quarantine";
const FRESH_RETAINED_SUFFIX = ".fresh-retained";
const ARCHIVE_SUFFIX = ".archived";
const OWNER_TOKEN_BYTES = 32;
const POSIX_MODE_MASK = 0o7777;
const MAX_SESSION_INDEX_ENTRIES = 256;
const MAX_FIXED_RECORD_BYTES = 1024 * 1024;
const STATUS_SNAPSHOT_ATTEMPTS = 2;
const STATUS_SNAPSHOT_INCONSISTENT_CODE = "MAS-GATE-STATUS-INCONSISTENT";

/**
 * Establish the fixed locator for the first coordinator install. This seam
 * deliberately cannot acquire a lock or infer artifact validation: callers
 * must present the live native lease and the frozen binding returned by the
 * complete MAS artifact validator. The final publication is exclusive, so a
 * destination collision is never replaced.
 */
export async function initializeMasGateSessionIndex({
  installAuthorization,
  validatedArtifactBinding,
  lockLease,
  ...options
} = {}) {
  try {
    if (installAuthorization !== MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY) {
      throw failClosed("fixed MAS session index initialization requires the coordinator install authorization");
    }
    if (!validatedArtifactBinding || !Object.isFrozen(validatedArtifactBinding)) {
      throw failClosed("fixed MAS session index initialization requires the complete immutable MAS artifact binding");
    }
    try {
      assertMasGateArtifactBinding(validatedArtifactBinding);
    } catch (error) {
      throw failClosed("fixed MAS session index initialization requires a complete MAS artifact binding", error);
    }
    assertMasGateMutationLease(lockLease);
    await lockLease.assertHeld();
    const lockedOptions = { ...options, lockLease };
    const context = await validateContext(options, "index initialization");
    const paths = fixedTransactionPaths(context);
    const [indexInfo, intentInfo, activeInfo] = await Promise.all([
      inspectedPath(paths.indexPath),
      inspectedPath(paths.indexIntentPath),
      inspectedPath(paths.activePath),
    ]);
    if (indexInfo) {
      const index = await readSessionIndex(paths.indexPath, context);
      if (activeInfo) {
        throw failClosed("cannot initialize the fixed MAS session index while fixed active-slot evidence exists; run exact status/recovery reconciliation");
      }
      if (intentInfo) {
        const intent = await readSessionIndexIntent(paths.indexIntentPath, context, lockedOptions);
        if (!intent || intent.state !== "committed" || !sameSessionIndex(index, intent.after)) {
          throw failClosed("cannot initialize the fixed MAS session index while its intent is pending or disagrees with the exact index; run exact status/recovery reconciliation");
        }
      }
      await lockLease.assertHeld();
      return { status: "existing", index };
    }
    if (intentInfo || activeInfo) {
      throw failClosed("cannot initialize the fixed MAS session index while fixed index-intent or active-slot evidence exists; run exact status/recovery reconciliation");
    }

    const index = emptySessionIndex(context);
    await maybeFault(lockedOptions, null, "index-initialize", "before initial fixed session index publication");
    await publishInitialSessionIndex(context, index, lockedOptions);
    await maybeFault(lockedOptions, null, "index-initialize-published", "after initial fixed session index publication");
    await lockLease.assertHeld();
    const published = await readSessionIndex(paths.indexPath, context);
    if (!published || !sameSessionIndex(published, index)) {
      throw failClosed("initial fixed MAS session index publication did not re-read as its exact durable result");
    }
    return { status: "initialized", index: published };
  } catch (error) {
    throw asCleanupError("could not initialize the fixed MAS session index", error);
  }
}

/**
 * Begin the one active MAS runtime-root transaction for a contract-derived
 * root. The returned value is plain data; the adapter is used only at the
 * process-ownership edge and is never written into the journal.
 */
export async function beginMasGateSessionTransaction(options = {}) {
  try {
    const parentPath = parentPathHint(options);
    return await withMasGateLock({ ...options, parentPath }, async (lockLease) => {
      const lockedOptions = { ...options, lockLease };
      const context = await validateContext(options, "begin");
      await assertNoLiveOwnedRuntime(lockedOptions, context, "before runtime quarantine");
      const space = await inspectFreeSpace(context.parentPath, options.requiredFreeBytes);
      const prior = await inspectPriorRoot(context);
      const runId = normalizeRunId(options.runId ?? randomUUID());
      const ownerToken = randomBytes(OWNER_TOKEN_BYTES).toString("base64url");
      const paths = transactionPaths(context, runId);
      const locatorState = await readSessionLocatorState(context, options);
      if (locatorState.pendingIntent) {
        throw failClosed("the fixed MAS session index intent is pending; recover the exact indexed transaction before beginning a new session");
      }
      const index = locatorState.index;

      await assertAbsent(paths.activePath, "active transaction slot");
      await assertAbsent(paths.constructionPath, "active transaction construction slot");
      await assertAbsent(paths.constructionIntentPath, "active transaction construction intent");
      await assertAbsent(paths.quarantinePath, "runtime quarantine");
      await assertAbsent(paths.freshRetainedPath, "fresh retained runtime");
      await assertAbsent(paths.archivePath, "archived transaction slot");
      const building = await findBuildingTransactions(context, options, index.entries);
      const intents = await findConstructionIntents(context, options, index.entries);
      const archived = await findArchivedTransactions(context, options, index.entries);
      const archivedRunIds = new Set(archived.map((candidate) => candidate.runId));
      if (building.length > 0 || intents.some((candidate) => !archivedRunIds.has(candidate.runId))) {
        throw failClosed("an incomplete active transaction construction requires recovery before a new session can begin");
      }
      if (archived.some((candidate) => candidate.phase !== "archived")) {
        throw failClosed("an incomplete retained transaction requires recovery before a new active session can begin");
      }
      await assertSiblingArtifactTopology(context, options, null, locatorState);

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
        constructionIntentPath: paths.constructionIntentPath,
        constructionIntent: paths.constructionIntentPath,
        journalPath: paths.constructionIntentPath,
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
        phase: "construction-intent",
        phaseHistory: ["construction-intent"],
      };

      const nextIndex = appendSessionIndexEntry(index, context, runId);
      const indexIntent = createSessionIndexIntent(
        context,
        "register",
        index,
        nextIndex,
        transaction,
      );
      await publishSessionIndexIntent(context, indexIntent, transaction, lockedOptions);
      await publishSessionIndex(context, nextIndex, transaction, lockedOptions);
      await writeJournal(transaction, lockedOptions);
      await commitSessionIndexIntent(context, indexIntent, transaction, lockedOptions);
      await maybeFault(lockedOptions, transaction, "construction-intent-journaled", "after construction intent publication");
      throwInjectedFsError(lockedOptions, "mkdir-active");
      await mkdir(paths.constructionPath, { recursive: false, mode: 0o700 });
      await syncDirectory(context.parentPath);
      await assertOwnedSecureDirectory(paths.constructionPath, "active transaction construction slot", context.parentDevice);
      await maybeFault(lockedOptions, transaction, "active-mkdir", "after active construction directory creation");
      transaction.journalPath = path.join(paths.constructionPath, JOURNAL_BASENAME);
      await transition(transaction, "prepared", lockedOptions);
      await maybeFault(lockedOptions, transaction, "active-journal-published", "after construction journal publication");
      await promoteActiveConstruction(transaction, lockedOptions, context);
      await maybeFault(lockedOptions, transaction, "prepared", "after active lock and journal");
      await advancePreparation(transaction, lockedOptions, context);
      await assertReady(transaction, lockedOptions, context);
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
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async (lockLease) => {
      const lockedOptions = { ...options, lockLease };
      const transaction = await loadTransaction(transactionOrJournal, lockedOptions);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "recover");
      assertTransaction(transaction, context, lockedOptions);
      const locatorState = await readSessionLocatorState(context, lockedOptions);
      await assertSiblingArtifactTopology(context, lockedOptions, transaction, locatorState);
      await assertNoLiveOwnedRuntime(lockedOptions, context, "before runtime recovery");

      if (phaseRank(transaction.phase) < phaseRank("ready")) {
        await advancePreparation(transaction, lockedOptions, context);
      }
      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
        return transaction;
      }
      if (phaseRank(transaction.phase) < phaseRank("restored")) {
        await restoreInternal(transaction, lockedOptions, context);
      }
      if (transaction.phase === "archive-intent") {
        await completeArchive(transaction, lockedOptions, context);
      }
      if (transaction.phase === "restored") await assertRestoredState(transaction, context);
      if (transaction.phase === "archived") await assertArchivedState(transaction, context);
      await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
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
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async (lockLease) => {
      const lockedOptions = { ...options, lockLease };
      const transaction = await loadTransaction(transactionOrJournal, lockedOptions);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "restore");
      assertTransaction(transaction, context, lockedOptions);
      const locatorState = await readSessionLocatorState(context, lockedOptions);
      await assertSiblingArtifactTopology(context, lockedOptions, transaction, locatorState);
      await assertNoLiveOwnedRuntime(lockedOptions, context, "before runtime restore");

      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
        return transaction;
      }
      if (transaction.phase === "archive-intent") {
        await completeArchive(transaction, lockedOptions, context);
        await assertArchivedState(transaction, context);
        return transaction;
      }
      if (phaseRank(transaction.phase) < phaseRank("ready")) {
        await advancePreparation(transaction, lockedOptions, context);
      }
      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        return transaction;
      }
      if (phaseRank(transaction.phase) < phaseRank("restored")) {
        await restoreInternal(transaction, lockedOptions, context);
      }
      await assertRestoredState(transaction, context);
      await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
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
    return await withMasGateLock({ ...options, parentPath: parentPathHint(options) }, async (lockLease) => {
      const lockedOptions = { ...options, lockLease };
      const transaction = await loadTransaction(transactionOrJournal, lockedOptions);
      const context = await validateContext({
        ...options,
        runtimeRoot: transaction.canonicalRuntimeRoot,
        contractRuntimeRoot: options.contractRuntimeRoot ?? options.contract?.runtimeRoot,
        runtimeRootParent: options.runtimeRootParent ?? options.contractRuntimeParent ?? options.contract?.parent,
        identityPath: options.identityPath ?? options.contract?.identityPath,
        identityRelativePath: options.identityRelativePath ?? options.contract?.identityRelativePath,
        activePath: options.activePath,
      }, "archive");
      assertTransaction(transaction, context, lockedOptions);
      const locatorState = await readSessionLocatorState(context, lockedOptions);
      await assertSiblingArtifactTopology(context, lockedOptions, transaction, locatorState);
      if (transaction.phase === "archived") {
        await assertArchivedState(transaction, context);
        await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
        return transaction;
      }
      if (transaction.phase !== "restored" && transaction.phase !== "archive-intent") {
        throw failClosed(`cannot archive a session in phase ${transaction.phase}`);
      }
      await assertRestoredRoots(transaction, context);
      await completeArchive(transaction, lockedOptions, context);
      if (transaction.phase === "archived") await assertArchivedState(transaction, context);
      await finalizePendingSessionIndexIntent(context, transaction, lockedOptions);
      return transaction;
    });
  } catch (error) {
    throw asCleanupError("could not archive the completed runtime-root transaction", error);
  }
}

/**
 * Read-only status for the fixed active slot. Archived sessions are reported,
 * never cleaned, so a caller can decide which retained evidence to inspect.
 * Without a supplied lease this path never acquires or prepares one; it uses
 * a bounded optimistic fixed-record snapshot and retries only on observed
 * fixed-record drift. A supplied lease is used only for serialized reads.
 */
export async function readMasGateSessionStatus(options = {}) {
  try {
    const parentPath = parentPathHint(options);
    if (options.lockLease) {
      return await withMasGateLock({ ...options, parentPath }, async () => readMasGateSessionStatusSnapshot(options));
    }
    let lastError;
    for (let attempt = 0; attempt < STATUS_SNAPSHOT_ATTEMPTS; attempt += 1) {
      try {
        return await readMasGateSessionStatusSnapshot(options);
      } catch (error) {
        lastError = error;
        if (!isCode(error, STATUS_SNAPSHOT_INCONSISTENT_CODE) || attempt + 1 >= STATUS_SNAPSHOT_ATTEMPTS) throw error;
      }
    }
    throw lastError;
  } catch (error) {
    throw asCleanupError("could not read runtime-root preservation status", error);
  }
}

async function readMasGateSessionStatusSnapshot(options) {
  const context = await validateContext(options, "status");
  const before = await fixedStatusSnapshot(context);
  const status = await readMasGateSessionStatusBody(context, options);
  const after = await fixedStatusSnapshot(context);
  if (!sameFixedStatusSnapshot(before, after)) {
    const error = failClosed("fixed MAS status records changed during the read; retry the read-only status command");
    error.code = STATUS_SNAPSHOT_INCONSISTENT_CODE;
    throw error;
  }
  return status;
}

async function readMasGateSessionStatusBody(context, options) {
  const paths = fixedTransactionPaths(context);
  const locatorState = await readSessionLocatorState(context, options, { allowUninitialized: true });
  if (locatorState.uninitialized) {
    return {
      status: "uninitialized",
      state: "absent-safe",
      runtimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: paths.activePath,
      indexPath: paths.indexPath,
      indexIntentPath: paths.indexIntentPath,
      archived: [],
      stateScope: "runtime-root-only",
    };
  }
  const entries = locatorState.entries;
  const building = await findBuildingTransactions(context, options, entries, locatorState.pendingIntent?.transaction);
  const intents = await findConstructionIntents(context, options, entries);
  const archived = await findArchivedTransactions(context, options, entries);
  const archivedRunIds = new Set(archived.map((candidate) => candidate.runId));
  await assertSiblingArtifactTopology(context, options, null, locatorState);
  const activeInfo = await inspectedPath(paths.activePath);
  if (activeInfo !== null) {
    if (building.length > 0) {
      throw failClosed("both the fixed active transaction slot and an active construction root are present; preserve every byte and resolve the ambiguity");
    }
    if (!activeInfo.isDirectory() || activeInfo.isSymbolicLink()) {
      throw failClosed("the fixed active transaction slot is not one owned directory");
    }
    await assertOwnedSecureDirectory(paths.activePath, "active transaction slot", context.parentDevice);
    const journalInfo = await inspectedPath(paths.journalPath);
    if (!journalInfo) throw failClosed("the fixed active transaction slot has no durable journal");
    await assertJournalFile(paths.journalPath, "active transaction journal");
    const transaction = await loadTransaction(paths.journalPath, options);
    assertTransaction(transaction, context, options);
    if (locatorState.index && !locatorState.index.entries.some((entry) => entry.runId === transaction.runId)) {
      throw failClosed("the fixed active transaction has no exact registered session locator; preserve every byte and run reconciliation");
    }
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

  const pendingIntent = intents.find((candidate) => !archivedRunIds.has(candidate.runId));
  if (pendingIntent) {
    return {
      status: "recovery-required",
      phase: pendingIntent.phase,
      journalPath: pendingIntent.journalPath,
      activePath: paths.activePath,
      constructionPath: pendingIntent.constructionPath,
      quarantinePath: pendingIntent.quarantinePath,
      freshRetainedPath: pendingIntent.freshRetainedPath,
      archivePath: pendingIntent.archivePath,
      runId: pendingIntent.runId,
      stateScope: pendingIntent.stateScope,
    };
  }

  if (locatorState.pendingIntent) {
    const transaction = locatorState.pendingIntent.transaction;
    return {
      status: "recovery-required",
      phase: transaction.phase,
      journalPath: paths.indexIntentPath,
      activePath: paths.activePath,
      constructionPath: transaction.constructionPath,
      quarantinePath: transaction.quarantinePath,
      freshRetainedPath: transaction.freshRetainedPath,
      archivePath: transaction.archivePath,
      runId: transaction.runId,
      stateScope: transaction.stateScope,
      archived: archived.map((candidate) => ({
        phase: candidate.phase,
        journalPath: candidate.journalPath,
        freshRetainedPath: candidate.freshRetainedPath,
        archivePath: candidate.archivePath,
        runId: candidate.runId,
        stateScope: candidate.stateScope,
      })),
    };
  }

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
    constructionIntentPath: path.join(context.parentPath, `${QUARANTINE_PREFIX}${runId}${ACTIVE_INTENT_SUFFIX}`),
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
    indexPath: path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME),
    indexIntentPath: path.join(context.parentPath, MAS_GATE_SESSION_INDEX_INTENT_BASENAME),
  };
}

async function fixedStatusSnapshot(context) {
  const paths = fixedTransactionPaths(context);
  const snapshot = {};
  for (const [label, candidate] of [
    ["index", paths.indexPath],
    ["indexIntent", paths.indexIntentPath],
    ["active", paths.activePath],
  ]) {
    const info = await inspectedPath(candidate);
    snapshot[label] = info ? {
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      nlink: info.nlink,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    } : null;
  }
  return snapshot;
}

function sameFixedStatusSnapshot(left, right) {
  return stableJson(left) === stableJson(right);
}

function emptySessionIndex(context) {
  const paths = fixedTransactionPaths(context);
  return {
    schema: MAS_GATE_SESSION_INDEX_SCHEMA,
    version: MAS_GATE_SESSION_INDEX_VERSION,
    runtimeRoot: context.runtimeRoot,
    parentPath: context.parentPath,
    activePath: paths.activePath,
    indexPath: paths.indexPath,
    indexIntentPath: paths.indexIntentPath,
    entries: [],
  };
}

function sessionIndexEntry(context, runId) {
  const paths = transactionPaths(context, normalizeRunId(runId));
  return {
    runId: normalizeRunId(runId),
    activePath: paths.activePath,
    constructionPath: paths.constructionPath,
    constructionIntentPath: paths.constructionIntentPath,
    quarantinePath: paths.quarantinePath,
    freshRetainedPath: paths.freshRetainedPath,
    archivePath: paths.archivePath,
  };
}

function appendSessionIndexEntry(index, context, runId) {
  if (index.entries.length >= MAX_SESSION_INDEX_ENTRIES) {
    throw failClosed(`fixed MAS session index capacity ${MAX_SESSION_INDEX_ENTRIES} is exhausted; retain every indexed session and reconcile before another begin`);
  }
  if (index.entries.some((entry) => entry.runId === runId)) {
    throw failClosed("fixed MAS session index already contains the requested run ID");
  }
  return {
    ...index,
    entries: [...index.entries, sessionIndexEntry(context, runId)],
  };
}

function createSessionIndexIntent(
  context,
  operation,
  before,
  after,
  transaction,
  { sourcePath = null, destinationPath = null } = {},
) {
  if (operation !== "register" && operation !== "archive") {
    throw failClosed("fixed MAS session index intent has an unknown operation");
  }
  return {
    schema: MAS_GATE_SESSION_INDEX_INTENT_SCHEMA,
    version: MAS_GATE_SESSION_INDEX_INTENT_VERSION,
    state: "pending",
    operation,
    runtimeRoot: context.runtimeRoot,
    parentPath: context.parentPath,
    indexPath: fixedTransactionPaths(context).indexPath,
    sourcePath,
    destinationPath,
    before,
    after,
    transaction: JSON.parse(JSON.stringify(transaction)),
  };
}

async function readSessionLocatorState(context, options, { allowUninitialized = false } = {}) {
  const paths = fixedTransactionPaths(context);
  const index = await readSessionIndex(paths.indexPath, context);
  if (!index) {
    const [intentInfo, activeInfo] = await Promise.all([
      inspectedPath(paths.indexIntentPath),
      inspectedPath(paths.activePath),
    ]);
    if (intentInfo || activeInfo) {
      throw failClosed("the fixed MAS session index is missing while fixed index-intent or active-slot evidence exists; preserve every byte and run exact reconciliation");
    }
    if (allowUninitialized) {
      return {
        index: null,
        pendingIntent: null,
        entries: [],
        uninitialized: true,
      };
    }
    throw failClosed("the fixed MAS session index is missing; an unregistered legacy v2 construction cannot be safely discovered without parent enumeration; preserve every byte and run manual reconciliation");
  }
  const intent = await readSessionIndexIntent(paths.indexIntentPath, context, options);
  if (!intent) {
    return {
      index,
      pendingIntent: null,
      entries: index?.entries ?? [],
    };
  }

  if (intent.state === "committed") {
    if (!index || !sameSessionIndex(index, intent.after)) {
      throw failClosed("fixed MAS session index intent is marked committed but the fixed index is not its exact durable result");
    }
    return {
      index,
      pendingIntent: null,
      entries: index.entries,
    };
  }

  if (index && !sameSessionIndex(index, intent.before) && !sameSessionIndex(index, intent.after)) {
    throw failClosed("fixed MAS session index and its durable intent disagree; preserve every sibling and recover the exact transaction");
  }
  return {
    index,
    pendingIntent: intent,
    entries: intent.after.entries,
  };
}

async function readSessionIndex(indexPath, context) {
  const value = await readFixedJsonRecord(indexPath, "MAS session index", context);
  if (value === null) return null;
  assertSessionIndex(value, context, "MAS session index");
  return value;
}

async function readSessionIndexIntent(intentPath, context, options) {
  const value = await readFixedJsonRecord(intentPath, "MAS session index intent", context);
  if (value === null) return null;
  assertExactKeys(value, [
    "after",
    "before",
    "destinationPath",
    "indexPath",
    "operation",
    "parentPath",
    "runtimeRoot",
    "schema",
    "sourcePath",
    "state",
    "transaction",
    "version",
  ], "MAS session index intent");
  if (value.schema !== MAS_GATE_SESSION_INDEX_INTENT_SCHEMA || value.version !== MAS_GATE_SESSION_INDEX_INTENT_VERSION) {
    throw failClosed("MAS session index intent schema or version is invalid");
  }
  if (value.state !== "pending" && value.state !== "committed") {
    throw failClosed("MAS session index intent state is invalid");
  }
  if (value.operation !== "register" && value.operation !== "archive") {
    throw failClosed("MAS session index intent operation is invalid");
  }
  const paths = fixedTransactionPaths(context);
  if (value.runtimeRoot !== context.runtimeRoot || value.parentPath !== context.parentPath || value.indexPath !== paths.indexPath) {
    throw failClosed("MAS session index intent is bound to a different runtime context");
  }
  if (value.sourcePath !== null && value.sourcePath !== paths.activePath) {
    throw failClosed("MAS session index intent source path is not the fixed active slot");
  }
  if (value.destinationPath !== null) canonicalAbsolute(value.destinationPath, "MAS session index intent destination path");
  if (!value.before) throw failClosed("MAS session index intent lacks its prior index state");
  assertSessionIndex(value.before, context, "MAS session index intent prior index");
  assertSessionIndex(value.after, context, "MAS session index intent result index");
  if (!value.transaction || typeof value.transaction !== "object" || Array.isArray(value.transaction)) {
    throw failClosed("MAS session index intent lacks its transaction binding");
  }
  assertTransaction(value.transaction, context, options);
  if (value.operation === "register" && (value.sourcePath !== null || value.destinationPath !== null)) {
    throw failClosed("MAS registration index intent carries an unexpected move path");
  }
  if (value.operation === "archive") {
    if (value.sourcePath !== paths.activePath || value.destinationPath !== value.transaction.archivePath) {
      throw failClosed("MAS archive index intent is not bound to the exact active-to-archive move");
    }
  }
  return value;
}

async function readFixedJsonRecord(recordPath, label, context) {
  const info = await inspectedPath(recordPath);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 ||
      (info.mode & POSIX_MODE_MASK) !== 0o600 || info.dev !== Number(context.parentDevice) || info.size > MAX_FIXED_RECORD_BYTES) {
    throw failClosed(`${label} is not one bounded secure same-device regular file`);
  }
  try {
    return JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    throw failClosed(`${label} is malformed or unreadable`, error);
  }
}

async function writeFixedJsonRecord(recordPath, value, context) {
  const existing = await inspectedPath(recordPath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== currentUid() ||
      existing.nlink !== 1 || (existing.mode & POSIX_MODE_MASK) !== 0o600 || existing.dev !== Number(context.parentDevice))) {
    throw failClosed(`fixed MAS record destination is not one secure same-device regular file: ${recordPath}`);
  }
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    const temporaryInfo = await lstat(temporaryPath);
    if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile() || temporaryInfo.uid !== currentUid() ||
        temporaryInfo.nlink !== 1 || (temporaryInfo.mode & POSIX_MODE_MASK) !== 0o600 || temporaryInfo.dev !== Number(context.parentDevice) ||
        temporaryInfo.size > MAX_FIXED_RECORD_BYTES) {
      throw failClosed("temporary fixed MAS record is not one bounded secure regular file");
    }
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(context.parentPath);
    await rename(temporaryPath, recordPath);
    await syncDirectory(context.parentPath);
  } catch (error) {
    if (isCode(error, "EXDEV") || isCode(error, "EBUSY") || isCode(error, "EPERM") || isCode(error, "ENOSPC")) {
      throw failClosed(`fixed MAS record publication failed with ${error.code}; leave every sibling intact`, error);
    }
    throw error;
  } finally {
    const leftover = await inspectedPath(temporaryPath);
    if (leftover) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function publishInitialSessionIndex(context, index, options) {
  const recordPath = fixedTransactionPaths(context).indexPath;
  if (await inspectedPath(recordPath)) {
    throw failClosed(`initial fixed MAS session index destination already exists; preserve it and run exact reconciliation: ${recordPath}`);
  }
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    const temporaryInfo = await lstat(temporaryPath);
    if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile() || temporaryInfo.uid !== currentUid() ||
        temporaryInfo.nlink !== 1 || (temporaryInfo.mode & POSIX_MODE_MASK) !== 0o600 || temporaryInfo.dev !== Number(context.parentDevice) ||
        temporaryInfo.size > MAX_FIXED_RECORD_BYTES) {
      throw failClosed("temporary initial MAS session index is not one bounded secure same-device regular file");
    }
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(context.parentPath);
    await renameWithDurability(
      temporaryPath,
      recordPath,
      context.parentPath,
      "initial fixed MAS session index publication",
      options,
    );
  } catch (error) {
    if (isCode(error, "EXDEV") || isCode(error, "EBUSY") || isCode(error, "EPERM") || isCode(error, "ENOSPC")) {
      throw failClosed(`initial fixed MAS session index publication failed with ${error.code}; leave every sibling intact`, error);
    }
    throw error;
  } finally {
    const leftover = await inspectedPath(temporaryPath);
    if (leftover) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function publishSessionIndexIntent(context, intent, transaction, options) {
  await maybeFault(options, transaction, "index-intent", "before fixed session index intent publication");
  await writeFixedJsonRecord(fixedTransactionPaths(context).indexIntentPath, intent, context);
  await maybeFault(options, transaction, "index-intent-journaled", "after fixed session index intent publication");
}

async function publishSessionIndex(context, index, transaction, options) {
  await writeFixedJsonRecord(fixedTransactionPaths(context).indexPath, index, context);
  await maybeFault(options, transaction, "index-published", "after fixed session index publication");
}

async function commitSessionIndexIntent(context, intent, transaction, options) {
  if (!intent) return;
  const committed = { ...intent, state: "committed" };
  await writeFixedJsonRecord(fixedTransactionPaths(context).indexIntentPath, committed, context);
  await maybeFault(options, transaction, "index-intent-committed", "after fixed session index intent acknowledgement");
}

async function finalizePendingSessionIndexIntent(context, transaction, options) {
  const intent = await readSessionIndexIntent(fixedTransactionPaths(context).indexIntentPath, context, options);
  if (!intent || intent.state === "committed") return;
  if (intent.transaction.runId !== transaction.runId) {
    throw failClosed("pending fixed MAS session index intent belongs to a different transaction");
  }
  if (intent.operation === "register") {
    if (!(await hasLocatedTransactionJournal(transaction, context))) {
      throw failClosed("cannot acknowledge the MAS session index before an exact v2 transaction journal is durable");
    }
    await publishSessionIndex(context, intent.after, transaction, options);
  } else {
    const source = await inspectedPath(intent.sourcePath);
    const destination = await inspectedPath(intent.destinationPath);
    if (source && destination) throw failClosed("archive index intent has both source and destination; preserve every byte");
    if (!destination) throw failClosed("archive index intent has not reached its exact destination");
    await publishSessionIndex(context, intent.after, transaction, options);
  }
  await commitSessionIndexIntent(context, intent, transaction, options);
}

async function hasLocatedTransactionJournal(transaction, context) {
  for (const candidate of [
    path.join(transaction.activePath, JOURNAL_BASENAME),
    path.join(transaction.constructionPath, JOURNAL_BASENAME),
    transaction.constructionIntentPath,
    transaction.archivePath ? path.join(transaction.archivePath, JOURNAL_BASENAME) : null,
  ]) {
    if (candidate && await inspectedPath(candidate)) return true;
  }
  return false;
}

async function locatedTransactionJournalPath(transaction, context) {
  const activeJournal = path.join(transaction.activePath, JOURNAL_BASENAME);
  const constructionJournal = path.join(transaction.constructionPath, JOURNAL_BASENAME);
  const archiveJournal = transaction.archivePath ? path.join(transaction.archivePath, JOURNAL_BASENAME) : null;
  const candidates = transaction.phase === "archived" || transaction.phase === "archive-intent"
    ? [archiveJournal, activeJournal, constructionJournal, transaction.constructionIntentPath]
    : [activeJournal, constructionJournal, transaction.constructionIntentPath, archiveJournal];
  const filteredCandidates = candidates.filter(Boolean);
  const present = [];
  for (const candidate of filteredCandidates) if (await inspectedPath(candidate)) present.push(candidate);
  if (present.includes(activeJournal) && present.includes(archiveJournal)) {
    throw failClosed("located MAS transaction has both active and archived journals");
  }
  return present[0] ?? transaction.constructionIntentPath;
}

function assertSessionIndex(index, context, label) {
  if (!index || typeof index !== "object" || Array.isArray(index)) throw failClosed(`${label} is missing`);
  assertExactKeys(index, ["activePath", "entries", "indexIntentPath", "indexPath", "parentPath", "runtimeRoot", "schema", "version"], label);
  if (index.schema !== MAS_GATE_SESSION_INDEX_SCHEMA || index.version !== MAS_GATE_SESSION_INDEX_VERSION) {
    throw failClosed(`${label} schema or version is invalid`);
  }
  const paths = fixedTransactionPaths(context);
  if (index.runtimeRoot !== context.runtimeRoot || index.parentPath !== context.parentPath ||
      index.activePath !== paths.activePath || index.indexPath !== paths.indexPath || index.indexIntentPath !== paths.indexIntentPath) {
    throw failClosed(`${label} is not bound to the exact fixed MAS context`);
  }
  if (!Array.isArray(index.entries) || index.entries.length > MAX_SESSION_INDEX_ENTRIES) {
    throw failClosed(`${label} entries are missing or exceed their bound`);
  }
  const runIds = new Set();
  for (const entry of index.entries) {
    assertExactKeys(entry, ["activePath", "archivePath", "constructionIntentPath", "constructionPath", "freshRetainedPath", "quarantinePath", "runId"], `${label} entry`);
    const expected = sessionIndexEntry(context, entry.runId);
    if (runIds.has(entry.runId)) throw failClosed(`${label} contains a duplicate run ID`);
    runIds.add(entry.runId);
    if (JSON.stringify(entry) !== JSON.stringify(expected)) throw failClosed(`${label} entry is not the exact run-derived locator`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failClosed(`${label} is not one object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw failClosed(`${label} has unexpected or missing fields`);
  }
}

function sameSessionIndex(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

async function promoteActiveConstruction(transaction, options, context) {
  const inspectedActive = await inspectedPath(transaction.activePath);
  const construction = await inspectedPath(transaction.constructionPath);
  if (inspectedActive && construction) throw failClosed("both the fixed active transaction slot and its construction root are present");
  if (inspectedActive) {
    if (inspectedActive.isSymbolicLink() || !inspectedActive.isDirectory()) throw failClosed("fixed active transaction slot is not one secure directory");
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
  await reconcileConstructionIntent(transaction, options, context);
  if (phaseRank(transaction.phase) >= phaseRank("ready")) return;
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

/**
 * The parent-side construction intent is the durable identity for the one
 * physical window between construction mkdir and the first directory journal.
 * Recovery may create the missing construction directory, or journal an
 * existing empty one.  Any unexpected byte in that unjournaled directory is
 * retained and makes the transaction ambiguous; it is never adopted or
 * removed.
 */
async function reconcileConstructionIntent(transaction, options, context) {
  if (transaction.phase !== "construction-intent") return;
  const construction = await inspectedPath(transaction.constructionPath);
  const active = await inspectedPath(transaction.activePath);
  if (active && construction) {
    throw failClosed("both the fixed active transaction slot and its construction root are present; preserve every byte");
  }
  if (active) {
    await assertOwnedSecureDirectory(transaction.activePath, "active transaction slot", context.parentDevice);
    const activeJournalPath = path.join(transaction.activePath, JOURNAL_BASENAME);
    await assertJournalFile(activeJournalPath, "active transaction journal");
    const durable = await loadTransaction(activeJournalPath, options);
    if (durable.ownerToken !== transaction.ownerToken || durable.runId !== transaction.runId) {
      throw failClosed("fixed active transaction journal identity differs from its durable construction intent; preserve every byte");
    }
    assertTransaction(durable, context, options);
    Object.assign(transaction, durable);
    return;
  }
  const expectedArchivePath = transactionPaths(context, transaction.runId).archivePath;
  const archived = await inspectedPath(expectedArchivePath);
  if (archived) {
    await assertOwnedSecureDirectory(expectedArchivePath, "archived transaction slot", context.parentDevice);
    const archivedJournalPath = path.join(expectedArchivePath, JOURNAL_BASENAME);
    await assertJournalFile(archivedJournalPath, "archived transaction journal");
    const durable = await loadTransaction(archivedJournalPath, options);
    if (durable.ownerToken !== transaction.ownerToken || durable.runId !== transaction.runId) {
      throw failClosed("archived transaction journal identity differs from its durable construction intent; preserve every byte");
    }
    assertTransaction(durable, context, options);
    Object.assign(transaction, durable);
    return;
  }
  if (!construction) {
    throwInjectedFsError(options, "mkdir-active");
    await mkdir(transaction.constructionPath, { recursive: false, mode: 0o700 });
    await syncDirectory(context.parentPath);
    await assertOwnedSecureDirectory(transaction.constructionPath, "active transaction construction slot", context.parentDevice);
  } else if (construction.isSymbolicLink() || !construction.isDirectory()) {
    throw failClosed("active transaction construction slot is not one secure directory; preserve every byte");
  } else {
    await assertOwnedSecureDirectory(transaction.constructionPath, "active transaction construction slot", context.parentDevice);
  }

  const constructionJournalPath = path.join(transaction.constructionPath, JOURNAL_BASENAME);
  const constructionJournal = await inspectedPath(constructionJournalPath);
  if (constructionJournal) {
    await assertJournalFile(constructionJournalPath, "construction transaction journal");
    const durable = await loadTransaction(constructionJournalPath, options);
    if (durable.ownerToken !== transaction.ownerToken || durable.runId !== transaction.runId ||
        durable.constructionPath !== transaction.constructionPath ||
        durable.constructionIntentPath !== transaction.constructionIntentPath) {
      throw failClosed("construction journal identity differs from its durable construction intent; preserve every byte");
    }
    Object.assign(transaction, durable);
    return;
  }

  const names = await readdir(transaction.constructionPath);
  if (names.length > 0) {
    throw failClosed("unjournaled construction contains unexpected bytes; preserve every byte and resolve the exact transaction manually");
  }
  transaction.journalPath = constructionJournalPath;
  await transition(transaction, "prepared", options);
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
  const locatorState = await readSessionLocatorState(context, options);
  let indexIntent = null;
  if (locatorState.index) {
    if (!locatorState.index.entries.some((entry) => entry.runId === transaction.runId)) {
      throw failClosed("the completed MAS transaction has no exact registered session locator; preserve every byte and run reconciliation");
    }
    indexIntent = createSessionIndexIntent(
      context,
      "archive",
      locatorState.index,
      locatorState.index,
      transaction,
      { sourcePath: transaction.activePath, destinationPath: transaction.archivePath },
    );
    await publishSessionIndexIntent(context, indexIntent, transaction, options);
  }
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
  if (indexIntent) await publishSessionIndex(context, locatorState.index, transaction, options);
  if (transaction.phase !== "archived") await transition(transaction, "archived", options);
  if (indexIntent) await commitSessionIndexIntent(context, indexIntent, transaction, options);
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
  if (!(await inspectedPath(journalPath))) {
    const fallback = constructionIntentFallback(journalPath);
    if (fallback && await inspectedPath(fallback)) journalPath = fallback;
  }
  await assertJournalFile(journalPath, "transaction journal");
  let decoded;
  try {
    decoded = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    throw failClosed("transaction journal is malformed or unreadable", error);
  }
  if (path.basename(journalPath) === MAS_GATE_SESSION_INDEX_INTENT_BASENAME) {
    if (decoded?.schema !== MAS_GATE_SESSION_INDEX_INTENT_SCHEMA || decoded?.version !== MAS_GATE_SESSION_INDEX_INTENT_VERSION ||
        !decoded.transaction || typeof decoded.transaction !== "object" || Array.isArray(decoded.transaction)) {
      throw failClosed("fixed MAS session index intent does not contain one recoverable v2 transaction");
    }
    const transaction = decoded.transaction;
    const locatedJournalPath = await locatedTransactionJournalPath(transaction, {
      parentPath: path.dirname(journalPath),
    });
    transaction.journalPath = locatedJournalPath;
    return transaction;
  }
  decoded.journalPath = journalPath;
  return decoded;
}

function constructionIntentFallback(journalPath) {
  if (path.basename(journalPath) !== JOURNAL_BASENAME) return null;
  const constructionName = path.basename(path.dirname(journalPath));
  if (!constructionName.startsWith(QUARANTINE_PREFIX) || !constructionName.endsWith(ACTIVE_BUILDING_SUFFIX)) return null;
  const runId = constructionName.slice(QUARANTINE_PREFIX.length, -ACTIVE_BUILDING_SUFFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) return null;
  return path.join(path.dirname(path.dirname(journalPath)), `${QUARANTINE_PREFIX}${runId}${ACTIVE_INTENT_SUFFIX}`);
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
  if (transaction.constructionIntentPath !== expected.constructionIntentPath || transaction.constructionIntent !== expected.constructionIntentPath) {
    throw failClosed("transaction construction intent path is not the exact run-derived sibling");
  }
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
    transaction.constructionIntentPath,
    path.join(transaction.activePath, JOURNAL_BASENAME),
    path.join(transaction.constructionPath, JOURNAL_BASENAME),
    ...(transaction.archivePath ? [path.join(transaction.archivePath, JOURNAL_BASENAME)] : []),
  ]);
  if (!validJournalPaths.has(transaction.journalPath)) throw failClosed("transaction journal path is not the construction, active, or archived journal");

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
  const operation = renameOperationFor(label);
  const lease = options.lockLease;
  try {
    await assertNoSymlinkPath(source, label);
    await assertAbsent(target, label);
    if (typeof options.beforeRename === "function") {
      await options.beforeRename({
        label,
        source,
        target,
        transaction: transaction ? journalSummary(transaction) : null,
      });
    }
    throwInjectedFsError(options, operation);
    if (!lease || typeof lease.assertHeld !== "function" || typeof lease.renameNoReplace !== "function") {
      throw failClosed(`${label} requires the live native mutation-session lease; no protected move was attempted`);
    }
    await lease.assertHeld();
    await lease.renameNoReplace(source, target, {
      pathClass: "runtime-sibling",
      onMutationApplied: (message) => options.afterRenameSyscall?.({
        label,
        source,
        target,
        transaction: transaction ? journalSummary(transaction) : null,
        message,
      }),
    });
    await syncDirectory(parentPath);
    if (transaction) await maybeFault(options, transaction, operation, `after ${label}`);
  } catch (error) {
    const state = await inspectMoveState(source, target);
    if (state.source && state.target) {
      throw failClosed(`${label} left both source and destination present; preserve every byte and recover only after resolving the ambiguity`, error);
    }
    if (!state.source && !state.target) {
      throw failClosed(`${label} left neither source nor destination present; preserve every remaining byte and recover only after resolving the ambiguity`, error);
    }
    if (!state.source && state.target && !isCode(error, "EEXIST")) {
      throw failClosed(`${label} applied before its acknowledgement; inspect the durable journal and destination before continuing`, error);
    }
    if (isCode(error, "EXDEV")) throw failClosed(`${label} failed with EXDEV; no copy fallback is allowed`, error);
    if (isCode(error, "EBUSY") || isCode(error, "EPERM") || isCode(error, "ENOSPC")) {
      throw failClosed(`${label} failed with ${error.code}; every remaining byte is retained`, error);
    }
    throw error;
  }
}

async function inspectMoveState(source, target) {
  const [sourceInfo, targetInfo] = await Promise.all([inspectedPath(source), inspectedPath(target)]);
  return { source: sourceInfo !== null, target: targetInfo !== null };
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
  if (parentPath === transaction.parentPath) await assertCanonicalParent(parentPath);
  else await assertOwnedSecureDirectory(parentPath, "transaction journal parent");
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
    transaction.constructionIntentPath,
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
  const callbackMatch = typeof options.faultInjector === "function"
    ? await options.faultInjector({
      point,
      phase: transaction?.phase ?? point,
      transaction: transaction ? journalSummary(transaction) : null,
    })
    : false;
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

async function assertSiblingArtifactTopology(context, options, transaction = null, suppliedLocatorState = null) {
  const locatorState = suppliedLocatorState ?? await readSessionLocatorState(context, options);
  const entries = [...locatorState.entries];
  if (transaction && !entries.some((entry) => entry.runId === transaction.runId)) {
    entries.push(sessionIndexEntry(context, transaction.runId));
  }
  const intents = await findConstructionIntents(context, options, entries);
  const archived = await findArchivedTransactions(context, options, entries);
  const building = await findBuildingTransactions(context, options, entries, locatorState.pendingIntent?.transaction);
  const located = new Map();
  for (const candidate of [...intents, ...archived, ...building]) located.set(candidate.runId, candidate);
  if (transaction) located.set(transaction.runId, transaction);
  const activeInfo = await inspectedPath(context.activePath);
  if (activeInfo) {
    await assertOwnedSecureDirectory(context.activePath, "active transaction slot", context.parentDevice);
    const activeJournalPath = path.join(context.activePath, JOURNAL_BASENAME);
    await assertJournalFile(activeJournalPath, "active transaction journal");
    const activeTransaction = await loadTransaction(activeJournalPath, options);
    assertTransaction(activeTransaction, context, options);
    if (await inspectedPath(activeTransaction.archivePath ?? path.join(context.parentPath, `${QUARANTINE_PREFIX}${activeTransaction.runId}${ARCHIVE_SUFFIX}`))) {
      throw failClosed("both active and archived transaction slots are present for one registered MAS session; preserve every byte");
    }
    located.set(activeTransaction.runId, activeTransaction);
    if (locatorState.index && !locatorState.index.entries.some((entry) => entry.runId === activeTransaction.runId)) {
      throw failClosed("the fixed active transaction has no exact registered session locator; preserve every byte and run reconciliation");
    }
  }

  for (const entry of entries) {
    const candidate = located.get(entry.runId);
    const artifacts = [
      [entry.constructionPath, "active transaction construction slot"],
      [entry.constructionIntentPath, "active transaction construction intent"],
      [entry.quarantinePath, "runtime quarantine"],
      [entry.freshRetainedPath, "fresh retained runtime"],
      [entry.archivePath, "archived transaction slot"],
    ];
    const present = [];
    for (const [artifact, label] of artifacts) {
      const info = await inspectedPath(artifact);
      if (!info) continue;
      present.push(artifact);
      if (artifact === entry.constructionIntentPath) {
        await assertJournalFile(artifact, label);
      } else if (artifact === entry.constructionPath || artifact === entry.archivePath) {
        await assertOwnedSecureDirectory(artifact, label, context.parentDevice);
      } else if (artifact === entry.quarantinePath) {
        await assertOpaqueRuntimeDirectory(artifact, label, context.parentDevice);
      } else if (artifact === entry.freshRetainedPath) {
        await assertFreshRetainedDirectory(artifact, label, context.parentDevice);
      }
    }
    if (present.length === 0 && !(locatorState.pendingIntent?.transaction?.runId === entry.runId)) {
      throw failClosed(`registered MAS session locator ${entry.runId} has no exact v2 transaction artifact`);
    }
    if (!candidate && !(locatorState.pendingIntent?.transaction?.runId === entry.runId)) {
      throw failClosed(`registered MAS session locator ${entry.runId} has no complete v2 journal binding`);
    }
    if (candidate) {
      assertTransaction(candidate, context, options);
      if (await inspectedPath(candidate.quarantinePath)) {
        if (!candidate.priorExists) throw failClosed("registered MAS quarantine exists for a recorded prior absence");
        await assertOpaqueRuntimeDirectory(candidate.quarantinePath, "registered quarantine prior root", context.parentDevice);
      }
      if (await inspectedPath(candidate.freshRetainedPath)) {
        await assertFreshRetainedDirectory(candidate.freshRetainedPath, "registered fresh retained root", context.parentDevice);
      }
    }
  }
}

async function assertOpaqueRuntimeDirectory(candidate, label, expectedDevice) {
  const info = await lstat(candidate).catch((error) => {
    if (isCode(error, "ENOENT")) throw failClosed(`${label} is missing`);
    throw error;
  });
  if (info.isSymbolicLink()) throw failClosed(`${label} is a symlink`);
  if (!info.isDirectory() || info.uid !== currentUid() ||
      (expectedDevice !== undefined && info.dev !== expectedDevice)) {
    throw failClosed(`${label} is not one owned same-device runtime directory`);
  }
  return info;
}

async function assertFreshRetainedDirectory(candidate, label, expectedDevice) {
  const info = await assertOpaqueRuntimeDirectory(candidate, label, expectedDevice);
  if ((info.mode & POSIX_MODE_MASK) !== 0o700) {
    throw failClosed(`${label} does not have the exact secure retained-root mode`);
  }
  return info;
}

async function findArchivedTransactions(context, options, entries = []) {
  const transactions = [];
  for (const entry of entries) {
    const archivePath = entry.archivePath;
    if (!(await inspectedPath(archivePath))) continue;
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

async function findConstructionIntents(context, options, entries = []) {
  const transactions = [];
  for (const entry of entries) {
    const intentPath = entry.constructionIntentPath;
    if (!(await inspectedPath(intentPath))) continue;
    const info = await lstat(intentPath);
    if (info.isSymbolicLink() || !info.isFile() || info.dev !== context.parentDevice) {
      throw failClosed("an active transaction construction intent is not one same-device regular file");
    }
    await assertJournalFile(intentPath, "construction intent journal");
    const transaction = await loadTransaction(intentPath, options);
    transaction.journalPath = intentPath;
    assertTransaction(transaction, context, options);
    if (transaction.phase !== "construction-intent" || transaction.constructionIntentPath !== intentPath) {
      throw failClosed("construction intent journal is not bound to its exact pre-publication phase and sibling");
    }
    transactions.push(transaction);
  }
  return transactions;
}

async function findBuildingTransactions(context, options, entries = [], fallbackTransaction = null) {
  const intents = await findConstructionIntents(context, options, entries);
  const transactions = [];
  for (const entry of entries) {
    const constructionPath = entry.constructionPath;
    if (!(await inspectedPath(constructionPath))) continue;
    const info = await lstat(constructionPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw failClosed("an active transaction construction path is a symlink or non-directory");
    }
    await assertOwnedSecureDirectory(constructionPath, "active transaction construction slot", context.parentDevice);
    const journalPath = path.join(constructionPath, JOURNAL_BASENAME);
    const constructionJournal = await inspectedPath(journalPath);
    let transaction;
    if (!constructionJournal) {
      transaction = intents.find((candidate) => candidate.constructionPath === constructionPath) ??
        (fallbackTransaction?.constructionPath === constructionPath ? fallbackTransaction : null);
      if (!transaction) throw failClosed("unjournaled active construction has no durable construction intent; preserve every byte and run status/recovery");
    } else {
      await assertJournalFile(journalPath, "construction transaction journal");
      transaction = await loadTransaction(journalPath, options);
      transaction.journalPath = journalPath;
      assertTransaction(transaction, context, options);
      if (!intents.some((candidate) => candidate.runId === transaction.runId)) {
        throw failClosed("construction journal has no matching durable construction intent; preserve every byte");
      }
    }
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
