import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import plist from "plist";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import { inspectNativeArgumentVector } from "../packages/runtime/dist/readiness.js";
import { enumeratePackageEntries, inspectMachO, inspectPackageMachOEntries } from "./lib/macos-package-inventory.mjs";
import {
  validateLicenseInventoryCoverage,
  validateLicenseInventoryDocument,
  validateMacOSLoadPathClosure,
  validateManifestDocument,
  validateNoticeEvidence,
  validatePackageSymlinkClosure,
  validateResolutionEvidencePaths,
  verifyIndividualMachOSignatures,
} from "./validate-macos-package.mjs";
import { validateMacOSPackageInputDocument } from "./lib/macos-package-inputs.mjs";
import {
  MACOS_APP_STORE_CONTRACT,
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
  validateEntitlementKeys,
  validateMacAppStoreEntitlementClosure,
} from "./lib/macos-app-store-contract.mjs";
import {
  validateMacAppStorePackageContract,
  validateMacAppStorePackagedHostConfiguration,
  validateMacAppStorePackagedMarker,
} from "./lib/macos-app-store-package-contract.mjs";
import {
  MACOS_APP_STORE_DEVELOPMENT_AUTHORITY,
  MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES,
  R5_APP_STORE_BUNDLE_ID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
  R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
  R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME,
  R5_APP_STORE_DEVELOPMENT_DEVICE_UDID,
  R5_APP_STORE_TEAM_ID,
  R5_REVENUECAT_INFO_PLIST_KEY,
  classifyMacAppStoreDevelopmentMachO,
  parseMacAppStoreDevelopmentEntitlementResult,
  parseUnsignedCodesignProfileDiagnostic,
  resolveMacAppStoreDevelopmentEmbeddedProfilePath,
  validateMacAppStoreDevelopmentInfo,
  validateR5DevelopmentElectronFileOutput,
  validateR5DevelopmentElectronInfo,
  validateR5DevelopmentProfile,
  validateR5DevelopmentSignature,
  validateRevenueCatPublicSdkKey,
} from "./lib/macos-app-store-development.mjs";
import {
  assertMasGateArtifactBinding,
  freezeMasGateArtifactBinding,
} from "./lib/mas-gate-artifact-binding.mjs";
import {
  MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
  MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY,
  archiveMasGateSessionTransaction,
  assertMasGateSessionReady,
  beginMasGateSessionTransaction,
  MAS_GATE_SESSION_INDEX_INTENT_SCHEMA,
  MAS_GATE_SESSION_INDEX_INTENT_VERSION,
  initializeMasGateSessionIndex,
  readMasGateSessionStatus as readRuntimeMasGateSessionStatus,
  restoreMasGateSessionTransaction,
} from "./lib/macos-mas-gate-session-transaction.mjs";
import {
  acquireMasGateLock,
  isMasGateMutationHolderDeath,
  masGateLockPath,
} from "./lib/macos-mas-gate-lock.mjs";
import { macAppStoreInstallationContract } from "./lib/macos-app-store-package-contract.mjs";
import { acceptedMacOSPackagePaths } from "./lib/macos-package-contract.mjs";
import {
  fingerprintPath,
  packageTransactionPaths,
  readPackageRecoveryProof,
  readPackageTransactionProof,
  replacePackageBundle,
  restorePackageTransaction,
} from "./lib/macos-package-transaction.mjs";

export const MAS_GATE_COORDINATOR_SCHEMA = "MAS_GATE_COORDINATOR v1";
export const MAS_GATE_HOST_HANDOFF_SCHEMA = "MAS_GATE_HOST_HANDOFF v1";
export const MAS_GATE_HOST_HANDOFF_FILENAME = "host-handoff.json";
export const MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA = "MAS_GATE_LAUNCH_DIAGNOSTIC v1";
export const MAS_GATE_LAUNCH_FAILURE_CATEGORIES = Object.freeze({
  UNKNOWN: "unknown",
  LOCK_FAILED: "lock-failed",
  PREFLIGHT_STATUS: "preflight-status",
  PACKAGE_PROOF: "package-proof",
  HANDOFF_READ: "handoff-read",
  OPEN_FAILED: "open-failed",
  HANDOFF_CLAIM_TIMEOUT: "handoff-claim-timeout",
  CLAIMED_HANDOFF_INVALID: "claimed-handoff-invalid",
});
export const MAS_GATE_HANDOFF_PREDICATE_GROUPS = Object.freeze({
  SCHEMA: "schema",
  SESSION: "session",
  ROOT: "root",
  PACKAGE_PROOF: "package-proof",
  INSTALLED_IDENTITY: "installed-identity",
  CLAIM_STATE: "claim-state",
});
export const MAS_GATE_LAUNCH_LAST_CAUSES = Object.freeze({
  UNKNOWN: "unknown",
  HANDOFF_READ: "handoff-read",
  CLAIMED_HANDOFF_INVALID: "claimed-handoff-invalid",
});

export { readRuntimeMasGateSessionStatus };

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export const MAS_LSOF_MAX_BUFFER_BYTES = 256 * 1024;
export const MAS_LSOF_PURPOSES = Object.freeze({
  LISTENER: "listener",
  OPEN_HANDLES: "open-handles",
});

const MAS_LSOF_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});
const MAS_LSOF_MAX_FIELD_BYTES = 16 * 1024;
const MAS_LSOF_MAX_RECORDS = 4096;
const MAS_LSOF_POLICIES = Object.freeze({
  [MAS_LSOF_PURPOSES.LISTENER]: Object.freeze({
    label: "exact listener",
    allowedFields: ["p", "c", "f", "t"],
    requiredFields: ["c", "t"],
  }),
  [MAS_LSOF_PURPOSES.OPEN_HANDLES]: Object.freeze({
    label: "runtime-root open-handle",
    allowedFields: ["p", "c", "f", "n"],
    requiredFields: ["c", "n"],
  }),
});

/**
 * Project the accepted MAS contract into the one runtime-root transaction
 * context. This function deliberately compares the MAS root with the direct
 * DMG root so a direct package proof cannot accidentally become MAS evidence.
 */
export function masDevelopmentRuntimeContext({ userHome = homedir(), contract = macAppStoreInstallationContract() } = {}) {
  const canonicalHome = canonicalAbsolute(userHome, "MAS user home");
  const acceptedMas = macAppStoreInstallationContract();
  if (JSON.stringify(contract) !== JSON.stringify(acceptedMas)) {
    throw new Error("MAS gate coordinator requires the exact macAppStoreInstallationContract() authority");
  }
  const direct = acceptedMacOSPackagePaths(canonicalHome);
  const runtimeRoot = path.resolve(canonicalHome, ...contract.userSupportRelativePath.split("/"));
  const parentPath = path.dirname(runtimeRoot);
  const identityPath = path.join(runtimeRoot, contract.identityRelativePath);
  if (runtimeRoot === direct.runtimeRoot || identityPath === direct.identityPath) {
    throw new Error("MAS gate contract resolved to the direct-DMG writable root; refusing to claim MAS state");
  }
  if (contract.userSupportRelativePath === path.relative(canonicalHome, direct.runtimeRoot)) {
    throw new Error("MAS gate contract uses the direct-DMG support path");
  }
  const runtime = contract.runtime;
  const packageRoot = path.join(contract.installPath, contract.package.rootRelativeToBundle);
  const bundlePath = contract.installPath;
  const executablePath = path.join(bundlePath, contract.host.executableRelativeToBundle);
  const nodePath = path.join(packageRoot, "runtime/node");
  const runtimeCliPath = path.join(packageRoot, "packages/runtime/dist/cli.js");
  const daemonWorkerPath = path.join(packageRoot, "vendor/paseo/packages/server/dist/server/server/daemon-worker.js");
  const pluginPath = path.join(packageRoot, "vendor/paseo/packages/server/dist/server/server/plugins/plugin-process.js");
  const captureHelperPath = path.join(packageRoot, contract.package.resources.captureHelper);
  return {
    schema: MAS_GATE_COORDINATOR_SCHEMA,
    userHome: canonicalHome,
    contract,
    directRuntimeRoot: direct.runtimeRoot,
    runtimeRoot,
    parentPath,
    lockPath: masGateLockPath(parentPath),
    activePath: path.join(parentPath, ".meetless-mas-gate-session.active"),
    identityRelativePath: contract.identityRelativePath,
    identityPath,
    bundlePath,
    executablePath,
    packageRoot,
    packagePaths: {
      bundlePath,
      executablePath,
      packageRoot,
      nodePath,
      runtimeCliPath,
      daemonWorkerPath,
      pluginPath,
      captureHelperPath,
      markerPath: path.join(packageRoot, contract.package.markerFilename),
      contractPath: path.join(packageRoot, contract.package.contractFilename),
      hostConfigPath: path.join(bundlePath, contract.package.hostConfigRelativeToBundle),
    },
    runtimePaths: {
      paseoHome: path.join(runtimeRoot, runtime.paseoHomeRelativePath),
      electronUserData: path.join(runtimeRoot, runtime.electronUserDataRelativePath),
      meetingStore: path.join(runtimeRoot, runtime.meetingStoreRelativePath),
      logs: path.join(runtimeRoot, runtime.logsRelativePath),
      daemonLog: path.join(runtimeRoot, runtime.daemonLogRelativePath),
      manifest: path.join(runtimeRoot, runtime.manifestRelativePath),
      recordingSocket: path.join(runtimeRoot, runtime.recordingSocketRelativePath),
      transcriptionSocket: path.join(runtimeRoot, runtime.transcriptionSocketRelativePath),
      transcriptionStaging: path.join(runtimeRoot, runtime.transcriptionStagingRelativePath),
    },
    stateScope: "runtime-root-only",
  };
}

function masGatePackageLockOptions(context, dependencies = {}) {
  const packageParentPath = resolvePackageFilesystemPath(path.dirname(context.bundlePath), dependencies?.packageFilesystem);
  return {
    parentPath: context.parentPath,
    packageParentPath,
  };
}

function resolvePackageFilesystemPath(candidate, filesystem) {
  if (filesystem === undefined) return candidate;
  if (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem) ||
      typeof filesystem.resolvePath !== "function" || Object.keys(filesystem).some((name) => name !== "resolvePath")) {
    throw coordinatorError("MAS package filesystem must expose only one low-level resolvePath adapter");
  }
  const resolved = filesystem.resolvePath(candidate);
  if (typeof resolved !== "string" || !path.isAbsolute(resolved) || path.resolve(resolved) !== resolved || resolved.includes("\0")) {
    throw coordinatorError("MAS package filesystem resolvePath must return one exact canonical absolute path");
  }
  return resolved;
}

function assertMasDevelopmentContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw coordinatorError("MAS coordinator context is missing");
  }
  const expected = masDevelopmentRuntimeContext({ userHome: context.userHome });
  if (JSON.stringify(context) !== JSON.stringify(expected)) {
    throw coordinatorError("MAS coordinator context is not the exact contract-derived app-container context");
  }
  return expected;
}

export function masGateRuntimeOptions(context, { requiredFreeBytes, dependencies = {}, ...overrides } = {}) {
  context = assertMasDevelopmentContext(context);
  if ("assertNoLiveOwnedRuntime" in overrides || "hasLiveOwnedRuntime" in overrides ||
      "runtimeRoot" in overrides || "contractRuntimeRoot" in overrides || "identityPath" in overrides ||
      "identityRelativePath" in overrides || "runtimeRootParent" in overrides || "activePath" in overrides) {
    throw coordinatorError("MAS transaction paths and live-state authority cannot be overridden by a coordinator caller");
  }
  return {
    runtimeRoot: context.runtimeRoot,
    contractRuntimeRoot: context.runtimeRoot,
    runtimeRootParent: context.parentPath,
    activePath: context.activePath,
    identityRelativePath: context.identityRelativePath,
    identityPath: context.identityPath,
    ...(requiredFreeBytes === undefined ? {} : { requiredFreeBytes }),
    assertNoLiveOwnedRuntime: async () => inspectMasLiveState(context, dependencies),
    ...overrides,
  };
}

/**
 * The transaction boundary accepts only this explicit, complete absent
 * observation. Any live, malformed, unknown, or inspection-error result is
 * intentionally rejected by the transaction module.
 */
export function masLiveAbsentObservation(context) {
  context = assertMasDevelopmentContext(context);
  return {
    status: "absent",
    runtimeRoot: context.runtimeRoot,
    parentPath: context.parentPath,
    stateScope: "runtime-root-only",
    processes: [],
    listeners: [],
    sockets: [],
    openHandles: [],
  };
}

/**
 * Compose the runtime transaction status with the package transaction's
 * post-install authorization. The runtime transaction remains the owner of
 * fresh-root readiness and deliberately rejects a published identity; only
 * this coordinator can add the package-owned proof for the post-install
 * state.
 */
export async function readMasDevelopmentGateStatus({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
  lockLease,
} = {}) {
  const composed = await readMasDevelopmentGateStatusWithProof({ context, dependencies, lockLease });
  return composed.status;
}

/**
 * Keep the historical coordinator export used by the session CLI, while
 * routing that CLI through the same package-aware status composition. Older
 * callers pass masGateRuntimeOptions(context) rather than a coordinator
 * context, so recover the contract-derived home from its exact runtime root.
 */
export async function readMasGateSessionStatus(options = {}) {
  const context = options.context ?? contextFromMasGateRuntimeOptions(options);
  return readMasDevelopmentGateStatus({
    context,
    dependencies: options.dependencies ?? {},
    lockLease: options.lockLease,
  });
}

function contextFromMasGateRuntimeOptions(options) {
  if (options?.runtimeRoot === undefined) return masDevelopmentRuntimeContext();
  const contract = macAppStoreInstallationContract();
  const runtimeSuffix = path.join(path.sep, ...contract.userSupportRelativePath.split("/"));
  if (typeof options.runtimeRoot !== "string" || !options.runtimeRoot.endsWith(runtimeSuffix)) {
    throw coordinatorError("MAS status runtime options are not bound to the exact app-container contract root");
  }
  const userHome = options.runtimeRoot.slice(0, -runtimeSuffix.length) || path.sep;
  return masDevelopmentRuntimeContext({ userHome });
}

async function readMasDevelopmentGateStatusWithProof({ context, dependencies = {}, lockLease } = {}) {
  context = assertMasDevelopmentContext(context);
  const runtimeOptions = masGateRuntimeOptions(
    context,
    lockLease ? { dependencies, lockLease } : { dependencies },
  );
  let runtimeStatus;
  let session = null;
  let postInstallIdentityObserved = false;
  try {
    runtimeStatus = await readRuntimeMasGateSessionStatus(runtimeOptions);
  } catch (error) {
    if (!isFreshIdentityPresenceFailure(error)) throw error;
    postInstallIdentityObserved = true;
    session = await readSessionJournal(path.join(context.activePath, "transaction.json"));
    if (session.phase !== "ready") {
      throw coordinatorError("post-install identity was present while the runtime transaction was not ready", error);
    }
    assertHandoffSessionBinding(context, session);
    runtimeStatus = postInstallRuntimeStatus(context, session);
  }

  if (runtimeStatus.status !== "active" && runtimeStatus.status !== "recovery-required") {
    await assertIdentityAbsentWithoutRuntimeTransaction(context, runtimeStatus);
    return {
      status: {
        ...runtimeStatus,
        package: { status: "not-applicable" },
      },
      packageRecoveryProof: null,
      session: null,
    };
  }
  if (!session) session = await readSessionJournal(runtimeStatus.journalPath);
  if (session.runId !== runtimeStatus.runId) {
    throw coordinatorError("runtime status and its session journal have different run IDs");
  }
  const packageRecoveryProof = await readPackageRecoveryProofForSession({
    context,
    session,
    dependencies,
    allowMissing: !postInstallIdentityObserved,
  });
  return {
    status: {
      ...runtimeStatus,
      package: packageProofSummary(packageRecoveryProof),
    },
    packageRecoveryProof: packageRecoveryProof.status === "recoverable" ? packageRecoveryProof : null,
    session,
  };
}

async function readPackageRecoveryProofForSession({ context, session, dependencies = {}, allowMissing = false } = {}) {
  if (!session || typeof session !== "object" || typeof session.runId !== "string" || typeof session.ownerToken !== "string") {
    throw coordinatorError("package identity authorization has no exact runtime session owner and run");
  }
  const journalPath = packageTransactionPaths(context.bundlePath, session.runId).journal;
  let proof;
  try {
    proof = await readPackageRecoveryProof({
      target: context.bundlePath,
      identityPath: context.identityPath,
      runId: session.runId,
      ownerToken: session.ownerToken,
      runtimeRootPath: context.runtimeRoot,
      journalPath,
      allowMissing,
      filesystem: dependencies.packageFilesystem,
    });
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw coordinatorError(`package recovery authorization failed before coordinator use: ${describe(error)}`, error);
  }
  assertPackageProofComposition(proof, context, session, journalPath);
  return proof;
}

async function readPackageLaunchProofForSession({ context, session, dependencies = {} } = {}) {
  if (!session || typeof session !== "object" || typeof session.runId !== "string" || typeof session.ownerToken !== "string") {
    throw coordinatorError("package identity authorization has no exact runtime session owner and run");
  }
  const journalPath = packageTransactionPaths(context.bundlePath, session.runId).journal;
  let proof;
  try {
    proof = await readPackageTransactionProof({
      target: context.bundlePath,
      identityPath: context.identityPath,
      runId: session.runId,
      ownerToken: session.ownerToken,
      runtimeRootPath: context.runtimeRoot,
      journalPath,
      filesystem: dependencies.packageFilesystem,
    });
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw coordinatorError(`package launch authorization failed before coordinator use: ${describe(error)}`, error);
  }
  assertPackageProofComposition(proof, context, session, journalPath);
  return proof;
}

function assertPackageProofComposition(proof, context, session, journalPath) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || proof.journalPath !== journalPath) {
    throw coordinatorError("package identity authorization returned a proof at the wrong fixed journal path");
  }
  if (proof.status === "absent") return;
  if ((proof.status !== "committed" && proof.status !== "recoverable") || proof.ownerToken !== session.ownerToken || proof.runId !== session.runId ||
      proof.target !== context.bundlePath || proof.identityPath !== context.identityPath ||
      !proof.transaction || typeof proof.transaction !== "object" || Array.isArray(proof.transaction)) {
    throw coordinatorError("package identity authorization is not bound to the exact package, owner, run, and identity path");
  }
}

function packageProofSummary(proof) {
  if (proof.status === "absent") return { status: "absent", journalPath: proof.journalPath };
  return {
    status: proof.state === "committed" ? "committed" : "recovery-required",
    state: proof.state,
    journalPath: proof.journalPath,
    ownerToken: proof.ownerToken,
    runId: proof.runId,
    target: proof.target,
    identityPath: proof.identityPath,
    artifactBinding: proof.artifactBinding,
    candidateFingerprint: proof.candidateFingerprint,
    candidateIdentity: proof.candidateIdentity,
    nextIdentityFingerprint: proof.nextIdentityFingerprint,
    identityPublishedIdentity: proof.identityPublishedIdentity,
    currentIdentityFingerprint: proof.currentIdentityFingerprint,
    currentIdentity: proof.currentIdentity,
  };
}

function postInstallRuntimeStatus(context, session) {
  return {
    status: "active",
    phase: session.phase,
    journalPath: path.join(context.activePath, "transaction.json"),
    activePath: context.activePath,
    quarantinePath: session.quarantinePath,
    freshRetainedPath: session.freshRetainedPath,
    archivePath: session.archivePath,
    runId: session.runId,
    stateScope: session.stateScope,
  };
}

async function assertIdentityAbsentWithoutRuntimeTransaction(context, runtimeStatus) {
  const identityInfo = await lstat(context.identityPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw coordinatorError(`package identity presence could not be checked for ${runtimeStatus.status} runtime status: ${describe(error)}`, error);
  });
  if (identityInfo) {
    throw coordinatorError(`package identity is present without an active runtime transaction (${runtimeStatus.status}); preserve every root`);
  }
}

function isFreshIdentityPresenceFailure(error) {
  return error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE &&
    /identity path is not absent in the fresh canonical runtime root/u.test(error.message ?? "");
}

/**
 * Inspect the exact MAS process topology and canonical endpoints. Matching is
 * path-aware and token-aware; a command substring is never treated as proof
 * of ownership or absence.
 */
export async function inspectMasLiveState(context, dependencies = {}) {
  context = assertMasDevelopmentContext(context);
  const rows = await (dependencies.processRows ?? (() => readProcessRows(context)))();
  assertProcessRows(rows);
  const ownedProcesses = rows.filter((row) => processRowIsOwned(row, context));
  const listenerPorts = exactListenerPorts(context);
  const listeners = dependencies.listeners
    ? await dependencies.listeners(listenerPorts, context)
    : await inspectListeners(listenerPorts, context, dependencies);
  const sockets = await (dependencies.sockets ?? inspectCanonicalSockets)(context);
  assertEvidenceList(listeners, "listener");
  assertEvidenceList(sockets, "socket");
  const openHandles = dependencies.openHandles
    ? await dependencies.openHandles(ownedProcesses.map((row) => row.pid), context)
    : await inspectOpenHandles(ownedProcesses.map((row) => row.pid), context, dependencies);
  assertEvidenceList(openHandles, "open-handle");
  if (ownedProcesses.length > 0 || listeners.length > 0 || sockets.length > 0 || openHandles.length > 0) {
    return {
      status: "live",
      runtimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      stateScope: "runtime-root-only",
      processes: ownedProcesses,
      listeners,
      sockets,
      openHandles,
    };
  }
  return masLiveAbsentObservation(context);
}

function assertProcessRows(rows) {
  if (!Array.isArray(rows)) throw coordinatorError("MAS process inspection did not return a complete process list");
  for (const row of rows) {
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.pid) || row.pid < 1 ||
        !Number.isSafeInteger(row.ppid) || row.ppid < 0 || typeof row.executablePath !== "string" ||
        !row.executablePath || !path.isAbsolute(row.executablePath) || !Array.isArray(row.arguments) ||
        row.arguments.length === 0 || row.arguments.some((argument) => typeof argument !== "string")) {
      throw coordinatorError("MAS process inspection returned malformed process evidence");
    }
  }
}

function assertEvidenceList(value, label) {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw coordinatorError(`MAS ${label} inspection returned malformed evidence`);
  }
}

/**
 * Install a MAS-development bundle while the gate owns the stable sibling
 * lock, then publish a one-use host handoff bound to the fresh root and the
 * installed bundle identity. The package transaction remains the owner of
 * /Applications and identity bytes.
 */
export async function installMasDevelopmentGate({
  manifestPath,
  bundlePath,
  requiredFreeBytes,
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  context = assertMasDevelopmentContext(context);
  const manifest = canonicalAbsolute(manifestPath, "MAS development manifest");
  const source = canonicalAbsolute(bundlePath, "MAS development bundle");
  const validation = await validateMasDevelopmentInstallArtifact({
    manifestPath: manifest,
    bundlePath: source,
    context,
    dependencies,
  });
  if (requiredFreeBytes === undefined) throw coordinatorError("install requires an explicit --required-free-bytes input; it is advisory preflight only, not a reservation or peak-use guarantee");
  let lease = await acquireMasGateLock(masGatePackageLockOptions(context));
  let session;
  let packageTransaction;
  try {
    await initializeMasGateSessionIndex({
      ...masGateRuntimeOptions(context, { dependencies, lockLease: lease }),
      installAuthorization: MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY,
      validatedArtifactBinding: validation.artifactBinding,
      lockLease: lease,
    });
    session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes, lockLease: lease, dependencies }),
    });
    await assertMasGateSessionReady(session, masGateRuntimeOptions(context, { lockLease: lease, dependencies }));
    await lease.bindRuntimeRoot(context.runtimeRoot);
    const inspectBundle = dependencies.inspectBundle ?? ((target) => inspectHostBundle(target, {
      runtimeRoot: context.runtimeRoot,
      containerSupportRoot: context.parentPath,
    }));
    const replace = dependencies.replacePackageBundle ?? replacePackageBundle;
    packageTransaction = await replace({
      source,
      target: context.bundlePath,
      identityPath: context.identityPath,
      ownerToken: session.ownerToken,
      runId: session.runId,
      inspect: inspectBundle,
      artifactBinding: validation.artifactBinding,
      lockParentPath: context.parentPath,
      runtimeRootPath: context.runtimeRoot,
      lockLease: lease,
    });
    const installed = await inspectBundle(context.bundlePath);
    await writeHostHandoff(context, session, installed);
    return {
      coordinator: MAS_GATE_COORDINATOR_SCHEMA,
      status: "installed",
      session,
      packageTransaction,
      installed,
      handoffPath: hostHandoffPath(session),
    };
  } catch (error) {
    let packageRollbackError = null;
    let runtimeRestoreError = null;
    try {
      try {
        await lease.assertHeld();
      } catch (leaseError) {
        if (!isMasGateMutationHolderDeath(leaseError)) throw leaseError;
        // A native holder can die after a protected syscall and before its
        // acknowledgement. Reacquire the same stable sibling lock before
        // inspecting or rolling back either transaction.
        await lease.release();
        lease = await acquireMasGateLock(masGatePackageLockOptions(context));
      }
      let candidatePackageTransaction = packageTransaction;
      const packageJournalPath = session?.runId ? packageTransactionPaths(context.bundlePath, session.runId).journal : null;
      if (!candidatePackageTransaction && session?.runId && await pathExists(packageJournalPath)) {
        candidatePackageTransaction = JSON.parse(await readFile(packageJournalPath, "utf8"));
      }
      if (candidatePackageTransaction) {
        await restorePackageTransaction(candidatePackageTransaction, {
          ownerToken: session?.ownerToken,
          target: context.bundlePath,
          identityPath: context.identityPath,
          requireArtifactBinding: true,
          requireRecoveryProof: true,
          expectedArtifactBinding: validation.artifactBinding,
          lockParentPath: context.parentPath,
          runtimeRootPath: context.runtimeRoot,
          lockLease: lease,
        });
      }
    } catch (rollbackError) {
      packageRollbackError = rollbackError;
    }
    if (!packageRollbackError) {
      try {
        let runtimeJournalPath = null;
        if (session?.runId) runtimeJournalPath = path.join(context.activePath, "transaction.json");
        else {
          const status = await readRuntimeMasGateSessionStatus(masGateRuntimeOptions(context, { dependencies, lockLease: lease }));
          runtimeJournalPath = status.journalPath ?? null;
        }
        if (runtimeJournalPath && await pathExists(runtimeJournalPath)) {
          const restored = await restoreMasGateSessionTransaction(
            runtimeJournalPath,
            masGateRuntimeOptions(context, { dependencies, lockLease: lease }),
          );
          await archiveMasGateSessionTransaction(
            restored,
            masGateRuntimeOptions(context, { dependencies, lockLease: lease }),
          );
        }
      } catch (restoreError) {
        runtimeRestoreError = restoreError;
      }
    }
    const cleanup = [packageRollbackError, runtimeRestoreError].filter(Boolean).map((failure) => describe(failure)).join("; ");
    const suffix = cleanup ? `; automatic package-first cleanup failed closed: ${cleanup}` : "; package rollback preceded runtime-root restore";
    throw coordinatorError(`MAS development installation stopped before host launch: ${describe(error)}${suffix}`, error);
  } finally {
    await lease.release();
  }
}

export async function launchMasDevelopmentGate({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  let lease = null;
  let released = false;
  let failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PREFLIGHT_STATUS;
  try {
    context = assertMasDevelopmentContext(context);
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.LOCK_FAILED;
    lease = await acquireMasGateLock({ parentPath: context.parentPath });
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PREFLIGHT_STATUS;
    const composed = await readMasDevelopmentGateStatusWithProof({ context, dependencies, lockLease: lease });
    const status = composed.status;
    if (status.status !== "active" || status.phase !== "ready") {
      throw coordinatorError(`MAS launch requires one active ready transaction; observed ${status.status}/${status.phase ?? "none"}`);
    }
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PACKAGE_PROOF;
    if (!composed.packageRecoveryProof) {
      throw coordinatorError("MAS launch requires one committed package transaction with an authorized published identity");
    }
    const packageLaunchProof = await readPackageLaunchProofForSession({
      context,
      session: composed.session,
      dependencies,
    });
    if (packageLaunchProof.status !== "committed") {
      throw coordinatorError("MAS launch requires the package transaction's committed-only authorization proof");
    }
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ;
    const handoff = await readHostHandoff(status, context, packageLaunchProof);
    const launch = dependencies.launch ?? (async () => {
      await execFileAsync("open", ["-g", "-a", context.bundlePath]);
    });
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.LOCK_FAILED;
    await lease.release();
    released = true;
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.OPEN_FAILED;
    await launch({ context, status, handoff });
    failureCategory = dependencies.waitForHandoff
      ? MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN
      : MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT;
    const claimed = dependencies.waitForHandoff
      ? await dependencies.waitForHandoff({ context, status, handoff })
      : await waitForMasHostHandoffClaim(context, status, packageLaunchProof);
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ;
    const claimedSession = await readSessionJournal(path.join(status.activePath, "transaction.json"));
    failureCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID;
    validateMasHostHandoff(claimed, {
      context,
      session: claimedSession,
      state: "claimed",
      packageProof: packageLaunchProof,
    });
    return { coordinator: MAS_GATE_COORDINATOR_SCHEMA, status: "launch-claimed", runId: status.runId, handoff: claimed };
  } catch (error) {
    const diagnostic = readMasLaunchDiagnostic(error);
    if (error?.code === "MAS-GATE-CLEANUP-001") {
      if (!diagnostic || diagnostic.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN) {
        attachMasLaunchDiagnostic(error, { category: failureCategory });
      }
      throw error;
    }
    throw coordinatorError(
      `MAS launch stopped before host handoff: ${describe(error)}`,
      error,
      diagnostic ?? { category: failureCategory },
    );
  } finally {
    if (!released && lease) {
      try {
        await lease.release();
      } catch (error) {
        if (error?.code === "MAS-GATE-CLEANUP-001") {
          if (!readMasLaunchDiagnostic(error)) {
            attachMasLaunchDiagnostic(error, { category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.LOCK_FAILED });
          }
          throw error;
        }
        throw coordinatorError("MAS launch lock release failed", error, {
          category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.LOCK_FAILED,
        });
      }
    }
  }
}

/**
 * Stop/absence proof is a separate coordinator operation. It never infers
 * absence from a missing marker or from a command substring.
 */
export async function stopMasDevelopmentGate({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  context = assertMasDevelopmentContext(context);
  let before;
  try {
    before = await inspectMasLiveState(context, dependencies);
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS stop could not establish the initial live-state observation: ${describe(error)}`, error);
  }
  if (before.status === "absent") {
    const lease = await acquireMasGateLock({ parentPath: context.parentPath });
    try {
      const confirmed = await inspectMasLiveState(context, dependencies);
      if (confirmed.status !== "absent") {
        throw coordinatorError("MAS stop observed a runtime after its initial absence result; preserve every root and retry only after recovery");
      }
      return { coordinator: MAS_GATE_COORDINATOR_SCHEMA, status: "already-stopped", observation: confirmed };
    } finally {
      await lease.release();
    }
  }
  if (before.status !== "live") throw coordinatorError("MAS stop received an unknown live-state result");
  const stop = dependencies.stop ?? ((input) => stopOwnedMasHost(input, dependencies));
  try {
    await stop({ context, observation: before });
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS stop command failed before absence proof: ${describe(error)}`, error);
  }
  const lease = await acquireMasGateLock({ parentPath: context.parentPath });
  try {
    const after = await inspectMasLiveState(context, dependencies);
    if (after.status !== "absent") throw coordinatorError("MAS stop did not produce an explicit absent process/socket/listener observation");
    return { coordinator: MAS_GATE_COORDINATOR_SCHEMA, status: "stopped", observation: after };
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS stop did not reach an explicit absence boundary: ${describe(error)}`, error);
  } finally {
    await lease.release();
  }
}

async function stopOwnedMasHost({ context, observation }, dependencies) {
  const hosts = observation.processes.filter((row) => isExactMasHostRow(row, context));
  if (hosts.length !== 1) {
    throw coordinatorError(
      `MAS coordinator stop requires exactly one exact LaunchServices host process; observed ${hosts.length}`,
    );
  }
  const pid = hosts[0].pid;
  const stopProcess = dependencies.stopProcess ?? ((targetPid) => process.kill(targetPid, "SIGTERM"));
  await stopProcess(pid, { context, observation, signal: "SIGTERM" });
  const waitForExit = dependencies.waitForProcessExit ?? ((targetPid) => waitForProcessExit(targetPid));
  await waitForExit(pid, { context, observation });
}

function isExactMasHostRow(row, context) {
  return row?.pid > 1 && row.ppid === 1 && row.executablePath === context.executablePath &&
    exactArguments(row.arguments, [context.executablePath]);
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw coordinatorError(`cannot prove exit of owned MAS host PID ${pid}`, error);
    }
    await delay(100);
  }
  throw coordinatorError(`timed out waiting for owned MAS host PID ${pid} to exit`);
}

const ARTIFACT_VALIDATION_ADAPTER_NAMES = new Set([
  "readSecureFile",
  "assertSecureFile",
  "assertSecureDirectory",
  "runMacOSCommand",
  "enumeratePackageEntries",
  "inspectPackageMachOEntries",
  "inspectMachO",
]);

function normalizeArtifactValidationAdapters(value) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coordinatorError("MAS artifact validation adapters must be one plain object");
  }
  for (const [name, adapter] of Object.entries(value)) {
    if (!ARTIFACT_VALIDATION_ADAPTER_NAMES.has(name) || typeof adapter !== "function") {
      throw coordinatorError(`MAS artifact validation adapter ${name} is not an allowed low-level function`);
    }
  }
  return Object.freeze({ ...value });
}

export async function validateMasDevelopmentInstallArtifact({ manifestPath, bundlePath, context, dependencies }) {
  const adapters = normalizeArtifactValidationAdapters(dependencies?.artifactValidationAdapters);
  const readArtifactFile = adapters.readSecureFile ?? readSecureFile;
  let manifest;
  let manifestBytes;
  let proofRoot;
  try {
    manifestBytes = await readArtifactFile(manifestPath, "MAS development manifest");
    manifest = parseJsonObject(manifestBytes, "MAS development manifest");
    proofRoot = assertMasDevelopmentManifestBinding(manifest, manifestPath, bundlePath);
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw coordinatorError(`MAS artifact manifest validation failed before runtime/package mutation: ${describe(error)}`, error);
  }

  try {
    return await validateMasDevelopmentArtifact({
      manifestPath,
      bundlePath,
      manifest,
      manifestBytes,
      proofRoot,
      expectedPublicSdkKey: resolveExpectedRevenueCatPublicSdkKey(dependencies),
      adapters,
    });
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) throw error;
    throw coordinatorError(`full MAS artifact validation failed before runtime/package mutation: ${describe(error)}`, error);
  }
}

/**
 * This is the production install preflight.  It reuses the repository's
 * versioned MAS validators at the artifact boundary and performs the same
 * read-only bundle/signature/Mach-O checks used when the development artifact
 * is produced. Low-level readers and owner-tool command output may be made
 * deterministic for fixture tests, but no caller can supply a validation
 * result or artifact binding.
 */
async function validateMasDevelopmentArtifact({ manifestPath, bundlePath, manifest, manifestBytes, proofRoot, expectedPublicSdkKey, adapters = {} }) {
  const readArtifactFile = adapters.readSecureFile ?? readSecureFile;
  const secureDirectory = adapters.assertSecureDirectory ?? assertSecureDirectory;
  const secureFile = adapters.assertSecureFile ?? assertSecureFile;
  const runOwnerCommand = adapters.runMacOSCommand ?? runMacOSCommand;
  const enumerateEntries = adapters.enumeratePackageEntries ?? enumeratePackageEntries;
  const inspectMachOEntriesEvidence = adapters.inspectPackageMachOEntries ?? inspectPackageMachOEntries;
  const inspectMachOEvidence = adapters.inspectMachO ?? inspectMachO;
  validateMasManifestDocument(manifest);
  const directCompositionPath = path.resolve(proofRoot, manifest.directComposition.path);
  const directCompositionBytes = await readArtifactFile(directCompositionPath, "retained direct composition manifest");
  if (sha256(directCompositionBytes) !== manifest.directComposition.sha256) {
    throw new Error("retained direct composition manifest bytes do not match the MAS manifest");
  }
  let directComposition;
  try {
    directComposition = JSON.parse(directCompositionBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`retained direct composition manifest is malformed: ${describe(error)}`);
  }
  validateManifestDocument(directComposition);
  if (directComposition.artifactDigest !== manifest.directComposition.artifactDigest) {
    throw new Error("MAS manifest is not bound to the retained direct composition artifact digest");
  }
  validateMacOSPackageInputDocument(directComposition.packageInputs, directComposition.candidateSnapshot);
  const bundleInfo = await secureDirectory(bundlePath, "MAS development bundle");
  const bundleRealPath = await realpath(bundlePath);
  if (bundleRealPath !== bundlePath) throw new Error("MAS development bundle root resolves through a symlink");
  const contentsPath = path.join(bundlePath, "Contents");
  const packageRoot = path.join(contentsPath, "Resources", "meetless");
  const outerExecutablePath = path.join(contentsPath, "MacOS", "MeetlessHost");
  const nestedElectronAppPath = path.join(packageRoot, "runtime", "electron", "Electron.app");
  const nestedElectronExecutablePath = path.join(nestedElectronAppPath, "Contents", "MacOS", "Electron");
  const packageContractPath = path.join(packageRoot, "installation-contract.json");
  const packageMarkerPath = path.join(packageRoot, "meetless-package.json");
  const hostConfigPath = path.join(contentsPath, "Resources", "host-config.json");

  const outerInfo = parsePlistDocument(await readArtifactFile(path.join(contentsPath, "Info.plist"), "signed outer Info.plist"), "signed outer Info.plist");
  validateMacAppStoreDevelopmentInfo(outerInfo, { publicSdkKey: expectedPublicSdkKey });
  if (outerInfo[R5_REVENUECAT_INFO_PLIST_KEY] !== expectedPublicSdkKey) {
    throw new Error("signed outer Info.plist RevenueCat public SDK key differs from the expected authority");
  }
  if (manifest.revenueCatPublicSdkKeyEmbedded !== true) throw new Error("MAS manifest does not attest the public RevenueCat SDK key in the outer Info.plist");

  const contractBytes = await readArtifactFile(packageContractPath, "packaged MAS installation contract");
  const contract = parseJsonObject(contractBytes, "packaged MAS installation contract");
  const contractSha256 = sha256(contractBytes);
  validateMacAppStorePackageContract(contract);
  const marker = parseJsonObject(await readArtifactFile(packageMarkerPath, "packaged MAS marker"), "packaged MAS marker");
  validateMacAppStorePackagedMarker(marker, { contractSha256 });
  if (marker.paseoCommit !== directComposition.candidateSnapshot?.paseoCommit) {
    throw new Error("packaged MAS marker is not bound to the pinned direct composition commit");
  }
  const hostConfiguration = parseJsonObject(await readArtifactFile(hostConfigPath, "packaged MAS host configuration"), "packaged MAS host configuration");
  validateMacAppStorePackagedHostConfiguration(hostConfiguration, { contractSha256 });
  const packagedContract = {
    schema: contract.schema,
    runtimeRootRelativePath: contract.userSupportRelativePath,
    recordingExportsRelativePath: contract.recordingExportsRelativePath,
    contractSha256,
    markerTarget: marker.target,
    hostRuntimeRootRelativePath: hostConfiguration.runtimeRootRelativeToUserHome,
  };
  if (JSON.stringify(manifest.packagedContract) !== JSON.stringify(packagedContract)) {
    throw new Error("MAS manifest packaged-contract evidence differs from the signed package files");
  }

  const inventoryPath = path.resolve(bundlePath, directComposition.licenseInventory.path);
  const inventoryBytes = await readArtifactFile(inventoryPath, "packaged MAS license inventory");
  if (sha256(inventoryBytes) !== directComposition.licenseInventory.sha256) {
    throw new Error("packaged MAS license inventory bytes differ from the validated direct composition");
  }
  const inventory = parseJsonObject(inventoryBytes, "packaged MAS license inventory");
  validateLicenseInventoryDocument(inventory, { repositoryRoot });
  validateLicenseInventoryCoverage(
    inventory,
    directComposition.entries,
    directComposition.licenseInventory,
    directComposition.macho,
    { repositoryRoot, bundlePath },
  );
  await validateNoticeEvidence(inventory, bundlePath, repositoryRoot);
  await validateResolutionEvidencePaths(inventory, repositoryRoot);

  await runOwnerCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const outerSignature = validateR5DevelopmentSignature(
    await readCodesignDisplay(bundlePath, runOwnerCommand),
    "Meetless.app",
  );
  if (manifest.signature.bundleIdentifier !== outerSignature.identifier ||
      manifest.signature.teamId !== outerSignature.teamId ||
      manifest.signature.identity !== outerSignature.identity ||
      manifest.signature.signature !== outerSignature.signature ||
      manifest.signature.cdHash !== outerSignature.cdHash) {
    throw new Error("MAS manifest outer signature evidence differs from the signed bundle");
  }
  const parentEntitlements = await readCodesignEntitlementsForGate(
    bundlePath,
    MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT,
    "signed parent app",
    outerExecutablePath,
    runOwnerCommand,
  );

  const profilePath = resolveMacAppStoreDevelopmentEmbeddedProfilePath(bundlePath);
  await secureFile(profilePath, "embedded development provisioning profile", { mode: 0o400 });
  if (path.basename(profilePath) === R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME) {
    throw new Error("embedded development provisioning profile has the mutable selected-profile filename");
  }
  const profileBytes = await readArtifactFile(profilePath, "embedded development provisioning profile");
  const profile = validateR5DevelopmentProfile(
    parsePlistDocument((await runOwnerCommand("security", ["cms", "-D", "-i", profilePath])).stdout, "embedded development provisioning profile"),
  );
  if (profile.Name !== R5_APP_STORE_DEVELOPMENT_PROFILE_NAME || profile.UUID !== R5_APP_STORE_DEVELOPMENT_PROFILE_UUID ||
      (profile.ExpirationDate instanceof Date ? profile.ExpirationDate.toISOString() : new Date(profile.ExpirationDate).toISOString()) !== manifest.provisioningProfile.expirationDate ||
      sha256(profileBytes) !== manifest.provisioningProfile.sha256 ||
      JSON.stringify(profile.ProvisionedDevices ?? []) !== JSON.stringify([R5_APP_STORE_DEVELOPMENT_DEVICE_UDID])) {
    throw new Error("embedded development provisioning profile differs from the exact MAS manifest evidence");
  }
  await assertUnsignedCodesignProfile(profilePath, runOwnerCommand);

  const entries = await enumerateEntries(bundlePath);
  await validatePackageSymlinkClosure(bundlePath, entries);
  const machoEntries = await inspectMachOEntriesEvidence(bundlePath, entries, { ownerMode: true });
  if (sha256(Buffer.from(JSON.stringify(entries))) !== manifest.artifact.sha256 ||
      entries.length !== manifest.artifact.entryCount || machoEntries.length !== manifest.artifact.machoEntryCount) {
    throw new Error("MAS manifest artifact inventory differs from the signed bundle");
  }
  await verifyIndividualMachOSignatures(machoEntries, bundlePath, { ownerMode: true });
  const outerMachOEntry = machoEntries.find((entry) => entry.path === "Contents/MacOS/MeetlessHost");
  if (!outerMachOEntry) throw new Error("signed MAS package is missing the outer MeetlessHost Mach-O");
  const outerPolicy = classifyMacAppStoreDevelopmentMachO(outerMachOEntry, { outerMachOPath: "Contents/MacOS/MeetlessHost" });
  validateThinArm64MachO(outerMachOEntry, "outer MeetlessHost");
  validateR5DevelopmentSignature(await readCodesignDisplay(outerExecutablePath, runOwnerCommand), "outer MeetlessHost", { expectedBundleIdentifier: null });
  validateMachOEntitlementsForGate(
    await readCodesignEntitlementsForGate(outerExecutablePath, outerPolicy.entitlementPolicy, "outer MeetlessHost", outerExecutablePath, runOwnerCommand),
    outerPolicy,
    "outer MeetlessHost",
  );

  const nestedSignatures = [];
  let childEntitlements = null;
  const nestedElectronRelativePath = path.relative(bundlePath, nestedElectronExecutablePath).split(path.sep).join("/");
  const electronEntry = machoEntries.find((entry) => entry.path === nestedElectronRelativePath);
  if (!electronEntry) throw new Error("signed MAS package is missing the MAS Electron executable");
  validateThinArm64MachO(electronEntry, "MAS Electron");
  validateR5DevelopmentElectronFileOutput((await runOwnerCommand("file", [nestedElectronExecutablePath])).stdout);
  validateR5DevelopmentElectronInfo(parsePlistDocument(await readArtifactFile(path.join(nestedElectronAppPath, "Contents", "Info.plist"), "signed Electron MAS Info.plist"), "signed Electron MAS Info.plist"));
  for (const entry of machoEntries.filter((candidate) => candidate.path !== outerMachOEntry.path)) {
    const absolute = path.resolve(bundlePath, entry.path);
    const policy = classifyMacAppStoreDevelopmentMachO(entry, { outerMachOPath: outerMachOEntry.path });
    validateThinArm64MachO(entry, entry.path);
    const signature = validateR5DevelopmentSignature(await readCodesignDisplay(absolute, runOwnerCommand), entry.path, { expectedBundleIdentifier: null });
    const entitlements = await readCodesignEntitlementsForGate(absolute, policy.entitlementPolicy, entry.path, absolute, runOwnerCommand);
    validateMachOEntitlementsForGate(entitlements, policy, entry.path);
    if (policy.entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD) {
      if (childEntitlements !== null && JSON.stringify(childEntitlements) !== JSON.stringify(entitlements)) {
        throw new Error("signed child Mach-O entitlements are not one exact inherited policy");
      }
      childEntitlements = entitlements;
    }
    nestedSignatures.push({
      path: entry.path,
      identifier: signature.identifier,
      teamId: signature.teamId,
      identity: signature.identity,
      cdHash: signature.cdHash,
      architecture: entry.machOArchitecture,
      fileType: entry.machOFileType,
      entitlementKeys: entitlements ? Object.keys(entitlements).sort() : [],
    });
  }
  if (manifest.signature.nestedMachOCount !== nestedSignatures.length ||
      JSON.stringify(manifest.signature.nestedMachO) !== JSON.stringify(nestedSignatures)) {
    throw new Error("MAS manifest nested signature evidence differs from the signed Mach-O closure");
  }
  if (JSON.stringify(manifest.entitlements?.parentKeys ?? []) !== JSON.stringify(Object.keys(parentEntitlements).sort()) ||
      JSON.stringify(manifest.entitlements?.childKeys ?? []) !== JSON.stringify(MACOS_APP_STORE_CHILD_ENTITLEMENTS) ||
      manifest.entitlements?.applicationGroup !== `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`) {
    throw new Error("MAS manifest entitlement evidence differs from the signed parent/child policy");
  }
  validateMacAppStoreEntitlementClosure(parentEntitlements, childEntitlements, {
    teamId: R5_APP_STORE_TEAM_ID,
    applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
  });
  if (JSON.stringify(manifest.electron) !== JSON.stringify({
    version: "41.2.0",
    platform: "mas",
    arch: "arm64",
    archiveName: "electron-v41.2.0-mas-arm64.zip",
    executable: nestedElectronRelativePath,
    architecture: "arm64",
    thin: true,
  })) {
    throw new Error("MAS manifest Electron evidence differs from the signed MAS Electron bundle");
  }
  if (manifest.externalGates?.launch !== "not-run" || manifest.externalGates?.purchase !== "not-run" || manifest.externalGates?.distribution !== "not-claimed") {
    throw new Error("MAS manifest contains an unaccepted external gate claim");
  }
  const inspectedMachO = [];
  for (const entry of machoEntries) {
    const absolute = path.resolve(bundlePath, entry.path);
    const inspected = await inspectMachOEvidence(absolute, { ownerMode: true });
    if (!inspected) throw new Error(`signed MAS Mach-O disappeared from the validated inventory: ${entry.path}`);
    inspectedMachO.push({ relative: entry.path, binary: absolute, fileOutput: entry.fileOutput, ...inspected });
  }
  await validateMacOSLoadPathClosure(inspectedMachO, bundlePath, new Set(entries.map((entry) => entry.path)));
  const bundleFingerprint = await fingerprintPath(bundlePath);
  if (!bundleFingerprint) throw new Error("validated MAS bundle disappeared before binding");
  const binding = freezeMasGateArtifactBinding({
    schema: "MAS_GATE_ARTIFACT_BINDING v1",
    version: 1,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    bundlePath,
    bundleFingerprint,
    artifactDigest: manifest.artifact.sha256,
    candidateSnapshotDigest: directComposition.candidateSnapshot.digest,
    packageInputDigest: directComposition.packageInputs.digest,
    artifactInputDigest: directComposition.packageInputs.artifactInput.digest,
    licenseDigest: directComposition.licenseInventory.sha256,
    signatureDigest: sha256(Buffer.from(JSON.stringify(manifest.signature))),
    publicSdkKeySha256: sha256(Buffer.from(expectedPublicSdkKey)),
  });
  return {
    status: "passed",
    authority: MACOS_APP_STORE_DEVELOPMENT_AUTHORITY,
    manifestPath,
    bundlePath,
    bundleDevice: bundleInfo.dev,
    artifactBinding: binding,
  };
}

function assertMasDevelopmentManifestBinding(manifest, manifestPath, bundlePath) {
  const manifestDirectory = path.dirname(manifestPath);
  if (path.basename(manifestPath) !== "app-store-development-manifest.json" ||
      path.basename(manifestDirectory) !== "macos" || path.basename(path.dirname(manifestDirectory)) !== "release") {
    throw coordinatorError("MAS install requires the exact release/macos/app-store-development-manifest.json authority path");
  }
  const proofRoot = path.dirname(path.dirname(manifestDirectory));
  if (manifest?.bundlePath !== "release/macos/Meetless.app" ||
      path.resolve(proofRoot, manifest.bundlePath) !== bundlePath ||
      manifest?.directComposition?.path !== "release/macos/composition-manifest.direct.json") {
    throw coordinatorError("MAS manifest bundle or direct-composition path is not the exact proof-root binding");
  }
  return proofRoot;
}

function resolveExpectedRevenueCatPublicSdkKey(dependencies = {}) {
  const candidate = dependencies.expectedRevenueCatPublicSdkKey ?? process.env.MEETLESS_REVENUECAT_PUBLIC_SDK_KEY;
  try {
    return validateRevenueCatPublicSdkKey(candidate);
  } catch (error) {
    throw new Error(`expected RevenueCat public SDK key authority is unavailable or malformed: ${error instanceof Error ? error.message.replace(/MEETLESS_REVENUECAT_PUBLIC_SDK_KEY/gu, "expected public SDK key") : "invalid value"}`);
  }
}

function validateMasManifestDocument(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.schema !== "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1" ||
      manifest.authority !== MACOS_APP_STORE_DEVELOPMENT_AUTHORITY ||
      manifest.target !== MACOS_APP_STORE_CONTRACT.target ||
      manifest.bundleIdentifier !== R5_APP_STORE_BUNDLE_ID ||
      manifest.teamId !== R5_APP_STORE_TEAM_ID ||
      manifest.signingIdentity !== R5_APP_STORE_DEVELOPMENT_IDENTITY ||
      manifest.revenueCatPublicSdkKeyEmbedded !== true) {
    throw new Error("MAS manifest schema, authority, bundle, team, signer, or public-key evidence is not exact");
  }
  if (!manifest.provisioningProfile || manifest.provisioningProfile.name !== R5_APP_STORE_DEVELOPMENT_PROFILE_NAME ||
      manifest.provisioningProfile.uuid !== R5_APP_STORE_DEVELOPMENT_PROFILE_UUID ||
      !/^[a-f0-9]{64}$/u.test(manifest.provisioningProfile.sha256 ?? "") ||
      JSON.stringify(manifest.provisioningProfile.provisionedDevices ?? []) !== JSON.stringify([R5_APP_STORE_DEVELOPMENT_DEVICE_UDID]) ||
      typeof manifest.provisioningProfile.expirationDate !== "string") {
    throw new Error("MAS manifest provisioning-profile evidence is not exact");
  }
  if (!manifest.signature || manifest.signature.verified !== true ||
      manifest.signature.bundleIdentifier !== R5_APP_STORE_BUNDLE_ID ||
      manifest.signature.teamId !== R5_APP_STORE_TEAM_ID ||
      manifest.signature.identity !== R5_APP_STORE_DEVELOPMENT_IDENTITY ||
      !/^[a-f0-9]{40}$/u.test(manifest.signature.cdHash ?? "") ||
      !Number.isSafeInteger(manifest.signature.nestedMachOCount) || !Array.isArray(manifest.signature.nestedMachO)) {
    throw new Error("MAS manifest bundle-signature evidence is not exact");
  }
  if (!manifest.entitlements || !Array.isArray(manifest.entitlements.parentKeys) ||
      !Array.isArray(manifest.entitlements.childKeys) ||
      manifest.entitlements.applicationGroup !== `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`) {
    throw new Error("MAS manifest parent/child entitlement policy evidence is missing");
  }
  if (!manifest.electron || manifest.electron.version !== MACOS_APP_STORE_CONTRACT.electron.version ||
      manifest.electron.platform !== MACOS_APP_STORE_CONTRACT.electron.platform || manifest.electron.arch !== MACOS_APP_STORE_CONTRACT.electron.arch ||
      manifest.electron.archiveName !== MACOS_APP_STORE_CONTRACT.electron.archiveName || manifest.electron.architecture !== "arm64" ||
      manifest.electron.thin !== true || typeof manifest.electron.executable !== "string") {
    throw new Error("MAS manifest Electron/Mach-O evidence is not exact");
  }
  if (!manifest.artifact || !/^[a-f0-9]{64}$/u.test(manifest.artifact.sha256 ?? "") ||
      !Number.isSafeInteger(manifest.artifact.entryCount) || manifest.artifact.entryCount < 1 ||
      !Number.isSafeInteger(manifest.artifact.machoEntryCount) || manifest.artifact.machoEntryCount < 1) {
    throw new Error("MAS manifest artifact inventory evidence is missing");
  }
  if (!manifest.packagedContract || !manifest.directComposition ||
      !/^[a-f0-9]{64}$/u.test(manifest.directComposition.sha256 ?? "") ||
      typeof manifest.directComposition.artifactDigest !== "string" || !manifest.directComposition.artifactDigest) {
    throw new Error("MAS manifest packaged-contract or pinned direct-composition evidence is missing");
  }
  if (manifest.externalGates?.launch !== "not-run" || manifest.externalGates?.purchase !== "not-run" || manifest.externalGates?.distribution !== "not-claimed") {
    throw new Error("MAS manifest external gate status is not the closed authority value");
  }
  return manifest;
}

async function assertSecureDirectory(target, label) {
  const info = await lstat(target).catch((error) => {
    throw new Error(`${label} is unavailable: ${describe(error)}`);
  });
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid()) {
    throw new Error(`${label} is not one owned non-symlink directory`);
  }
  return info;
}

async function assertSecureFile(target, label, { mode = null } = {}) {
  const info = await lstat(target).catch((error) => {
    throw new Error(`${label} is unavailable: ${describe(error)}`);
  });
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 ||
      (mode !== null && (info.mode & 0o7777) !== mode)) {
    throw new Error(`${label} is not one owned regular non-symlink file with the exact required mode`);
  }
  return info;
}

async function readSecureFile(target, label, options = {}) {
  await assertSecureFile(target, label, options);
  return readFile(target);
}

async function readSecureJson(target, label) {
  const bytes = await readSecureFile(target, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is malformed JSON: ${describe(error)}`);
  }
}

function parseJsonObject(bytes, label) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected one object");
    return value;
  } catch (error) {
    throw new Error(`${label} is malformed JSON: ${describe(error)}`);
  }
}

function parsePlistDocument(bytes, label) {
  try {
    const source = Buffer.from(bytes).toString("utf8");
    const xmlStart = source.indexOf("<?xml");
    const plistStart = source.indexOf("<plist");
    const start = xmlStart >= 0 && (plistStart < 0 || xmlStart < plistStart) ? xmlStart : plistStart;
    const end = source.indexOf("</plist>", start);
    if (start < 0 || end < 0) throw new Error("no complete plist document");
    return plist.parse(source.slice(start, end + "</plist>".length));
  } catch (error) {
    throw new Error(`${label} is malformed plist XML: ${describe(error)}`);
  }
}

async function runMacOSCommand(command, arguments_) {
  const commandPath = {
    codesign: "/usr/bin/codesign",
    file: "/usr/bin/file",
    security: "/usr/bin/security",
  }[command];
  if (!commandPath) throw new Error(`MAS artifact validator has no owner-tool path for ${command}`);
  return execFileAsync(commandPath, arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  });
}

async function readCodesignDisplay(target, runCommand = runMacOSCommand) {
  const result = await runCommand("codesign", ["--display", "--verbose=4", target]);
  return `${result.stdout}\n${result.stderr}`;
}

async function readCodesignEntitlementsForGate(target, entitlementPolicy, label, expectedExecutablePath = target, runCommand = runMacOSCommand) {
  let result;
  try {
    const commandResult = await runCommand("codesign", ["--display", "--entitlements", ":-", target]);
    result = { exitCode: 0, stdout: commandResult.stdout, stderr: commandResult.stderr };
  } catch (error) {
    result = {
      exitCode: Number.isInteger(error?.code) ? error.code : Number(error?.code),
      stdout: error?.stdout,
      stderr: error?.stderr,
    };
  }
  const parsed = parseMacAppStoreDevelopmentEntitlementResult(result, {
    entitlementPolicy,
    executablePath: expectedExecutablePath,
    label,
  });
  return parsed.kind === "absent" ? null : parsePlistDocument(parsed.plist, `${label} signed entitlements`);
}

async function assertUnsignedCodesignProfile(profilePath, runCommand = runMacOSCommand) {
  try {
    const result = await runCommand("codesign", ["--display", "--verbose=2", profilePath]);
    return parseUnsignedCodesignProfileDiagnostic({ exitCode: 0, stdout: result.stdout, stderr: result.stderr }, "embedded development provisioning profile");
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : Number(error?.code);
    if (Number.isInteger(exitCode)) {
      return parseUnsignedCodesignProfileDiagnostic({ exitCode, stdout: error?.stdout, stderr: error?.stderr }, "embedded development provisioning profile");
    }
    throw error;
  }
}

function validateThinArm64MachO(entry, label) {
  if (entry?.machOArchitecture !== "arm64" || entry?.machOSlices?.length !== 1 ||
      /universal|x86_64|i386|arm64e/iu.test(entry.fileOutput ?? "")) {
    throw new Error(`${label} is not one thin arm64 Mach-O`);
  }
}

function validateMachOEntitlementsForGate(entitlements, policy, label) {
  if (policy.entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE) {
    if (entitlements !== null) throw new Error(`${label} must not contain entitlements`);
    return;
  }
  if (entitlements === null) throw new Error(`${label} is missing its required entitlements`);
  validateEntitlementKeys(
    entitlements,
    policy.expectedEntitlementKeys,
    label,
    policy.entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
      ? { applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}` }
      : undefined,
  );
}

/**
 * Prove stop/absence, roll back package identity/bundle, then reacquire the
 * gate lock for runtime-root detach/restore/archive. Fresh bytes remain in the
 * retained session evidence root.
 */
export async function restoreMasDevelopmentGate({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  context = assertMasDevelopmentContext(context);
  let session = null;
  let sessionJournalPath = null;
  let result;
  try {
    result = await restoreInRequiredOrder({
      stop: () => stopMasDevelopmentGate({ context, dependencies }),
      rollbackPackage: async (stopped) => {
        // Stop proof releases the host lease before returning. Reacquire the
        // same sibling lock for package mutation so a new native host cannot
        // claim an available handoff between absence proof and rollback.
        const packageLease = await acquireMasGateLock(masGatePackageLockOptions(context, dependencies));
        try {
          const composed = await readMasDevelopmentGateStatusWithProof({ context, dependencies, lockLease: packageLease });
          const status = composed.status;
          if (status.status !== "active" && status.status !== "recovery-required") {
            return { status: "nothing-to-restore", observation: stopped.observation };
          }
          sessionJournalPath = status.journalPath;
          session = composed.session;
          if (typeof session.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session.runId)) {
            throw coordinatorError("MAS session journal run ID is invalid; preserve every root and do not derive package paths");
          }
          if (composed.packageRecoveryProof) {
            const packageTransaction = composed.packageRecoveryProof.transaction;
            await restorePackageTransaction(packageTransaction, {
              ownerToken: packageTransaction.ownerToken,
              target: packageTransaction.target,
              identityPath: packageTransaction.identityPath,
              requireArtifactBinding: true,
              requireRecoveryProof: true,
              expectedArtifactBinding: packageTransaction.artifactBinding,
              lockParentPath: context.parentPath,
              runtimeRootPath: context.runtimeRoot,
              lockLease: packageLease,
              assertNoLiveHost: async () => {
                const observation = await inspectMasLiveState(context, dependencies);
                if (observation.status !== "absent") throw coordinatorError("package rollback requires explicit MAS process absence");
              },
            });
          }
          return { status: "ready-for-runtime-restore" };
        } finally {
          await packageLease.release();
        }
      },
      reacquireGateLock: () => acquireMasGateLock({ parentPath: context.parentPath }),
      runtimeRestore: async (lease) => {
        if (!sessionJournalPath) throw coordinatorError("MAS restore has no durable session journal path after package rollback");
        const onDisk = await readSessionJournal(sessionJournalPath);
        if (!session || onDisk.ownerToken !== session.ownerToken || onDisk.runId !== session.runId) {
          throw coordinatorError("MAS session journal owner or run changed during package rollback; preserve every root");
        }
        return restoreMasGateSessionTransaction(
          sessionJournalPath,
          masGateRuntimeOptions(context, { lockLease: lease, dependencies }),
        );
      },
      archiveSession: (restored, lease) => archiveMasGateSessionTransaction(
        restored,
        masGateRuntimeOptions(context, { lockLease: lease, dependencies }),
      ),
    });
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS restore stopped before prior-root recovery: ${describe(error)}`, error);
  }
  if (result.status === "nothing-to-restore") {
    return { coordinator: MAS_GATE_COORDINATOR_SCHEMA, ...result };
  }
  return {
    coordinator: MAS_GATE_COORDINATOR_SCHEMA,
    status: "restored",
    stop: result.stop,
    session: result.archived,
    packageRollbackBeforeRuntimeRestore: true,
  };
}

export async function restoreInRequiredOrder({
  stop,
  rollbackPackage,
  reacquireGateLock,
  runtimeRestore,
  archiveSession,
} = {}) {
  for (const [name, operation] of Object.entries({ stop, rollbackPackage, reacquireGateLock, runtimeRestore, archiveSession })) {
    if (typeof operation !== "function") throw coordinatorError(`MAS restore ordering operation ${name} is missing`);
  }
  const stopResult = await stop();
  const rollbackResult = await rollbackPackage(stopResult);
  if (rollbackResult?.status === "nothing-to-restore") {
    return { status: "nothing-to-restore", stop: stopResult, observation: rollbackResult.observation };
  }
  const lease = await reacquireGateLock();
  if (!lease || typeof lease.release !== "function") throw coordinatorError("MAS restore ordering did not reacquire a releasable gate lock");
  try {
    const restored = await runtimeRestore(lease);
    const archived = await archiveSession(restored, lease);
    return { status: "restored", stop: stopResult, restored, archived };
  } finally {
    await lease.release();
  }
}

export async function recoverMasDevelopmentGate({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  return restoreMasDevelopmentGate({ context, dependencies });
}

async function readSessionJournal(journalPath) {
  try {
    const info = await lstat(journalPath);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) {
      throw coordinatorError("MAS session journal is not one secure regular file");
    }
    const decoded = JSON.parse(await readFile(journalPath, "utf8"));
    if (decoded?.schema === MAS_GATE_SESSION_INDEX_INTENT_SCHEMA && decoded.version === MAS_GATE_SESSION_INDEX_INTENT_VERSION &&
        decoded.transaction && typeof decoded.transaction === "object" && !Array.isArray(decoded.transaction)) {
      return decoded.transaction;
    }
    return decoded;
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS session journal is unavailable or malformed: ${describe(error)}`, error);
  }
}

export function createMasHostHandoff(context, session, installed) {
  context = assertMasDevelopmentContext(context);
  assertHandoffSessionBinding(context, session);
  if (session.phase !== "ready") {
    throw coordinatorError("MAS host handoff requires a ready runtime-root-only session");
  }
  if (!installed || installed.bundleIdentifier !== context.contract.bundleIdentifier ||
      installed.bundlePath !== context.bundlePath || installed.bundleRealPath !== context.bundlePath ||
      installed.executablePath !== context.executablePath ||
      typeof installed.designatedRequirement !== "string" || !installed.designatedRequirement ||
      typeof installed.cdHash !== "string" || !/^[a-f0-9]{40}$/u.test(installed.cdHash) ||
      typeof installed.binarySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(installed.binarySha256) ||
      !isNonNegativeInteger(installed.binaryDevice) || !isNonNegativeInteger(installed.binaryInode) ||
      !Number.isSafeInteger(installed.binarySize) || installed.binarySize <= 0) {
    throw coordinatorError("installed bundle identity is not the exact MAS contract identity");
  }
  return {
    schema: MAS_GATE_HOST_HANDOFF_SCHEMA,
    version: 1,
    ownerToken: session.ownerToken,
    runId: session.runId,
    state: "available",
    phase: "ready",
    canonicalRuntimeRoot: session.canonicalRuntimeRoot,
    parentPath: session.parentPath,
    activePath: session.activePath,
    freshRootIdentity: session.freshRootIdentity,
    identityRelativePath: session.identityRelativePath,
    identityPath: session.identityPath,
    bundlePath: installed.bundlePath,
    bundleRealPath: installed.bundleRealPath,
    executablePath: installed.executablePath,
    bundleIdentifier: installed.bundleIdentifier,
    designatedRequirement: installed.designatedRequirement,
    cdHash: installed.cdHash,
    binarySha256: installed.binarySha256,
    binaryDevice: installed.binaryDevice,
    binaryInode: installed.binaryInode,
    binarySize: installed.binarySize,
    claimedByPid: null,
    claimedAt: null,
  };
}

async function writeHostHandoff(context, session, installed) {
  const handoff = createMasHostHandoff(context, session, installed);
  const target = hostHandoffPath(session);
  const parent = await lstat(path.dirname(target)).catch((error) => { throw coordinatorError("MAS host handoff parent is unavailable", error); });
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== currentUid() || (parent.mode & 0o7777) !== 0o700) {
    throw coordinatorError("MAS host handoff parent is not one secure active transaction directory");
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeDurableJson(temporary, target, handoff);
}

async function readHostHandoff(status, context, packageProof) {
  return readHostHandoffFile(
    status.activePath,
    status.journalPath,
    context,
    "available",
    packageProof,
  );
}

async function readHostHandoffFile(activePath, journalPath, context, state, packageProof) {
  const target = path.join(activePath, MAS_GATE_HOST_HANDOFF_FILENAME);
  const info = await lstat(target).catch((error) => {
    throw coordinatorError(`MAS host handoff is unavailable: ${describe(error)}`, error, {
      category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
    });
  });
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) {
    throw coordinatorError("MAS host handoff is not one secure regular file", undefined, {
      category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
    });
  }
  let handoff;
  try {
    handoff = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw coordinatorError("MAS host handoff is malformed", error, {
      category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
    });
  }
  let session;
  try {
    session = await readSessionJournal(journalPath);
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") {
      attachMasLaunchDiagnostic(error, { category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ });
      throw error;
    }
    throw coordinatorError("MAS host handoff session is unavailable", error, {
      category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
    });
  }
  try {
    return validateMasHostHandoff(handoff, { context, session, state, packageProof });
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") {
      attachMasLaunchDiagnostic(error, {
        category: state === "claimed"
          ? MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID
          : MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
      });
      throw error;
    }
    throw coordinatorError("MAS host handoff validation failed", error, {
      category: state === "claimed"
        ? MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID
        : MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
    });
  }
}

async function waitForMasHostHandoffClaim(context, status, packageProof) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readHostHandoffFile(
        status.activePath,
        path.join(status.activePath, "transaction.json"),
        context,
        "claimed",
        packageProof,
      );
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  const lastDiagnostic = readMasLaunchDiagnostic(lastError);
  const lastCause = lastDiagnostic?.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ ||
    lastDiagnostic?.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID
    ? lastDiagnostic.category
    : MAS_GATE_LAUNCH_LAST_CAUSES.UNKNOWN;
  const lastPredicateGroup = lastDiagnostic?.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ ||
    lastDiagnostic?.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID
    ? lastDiagnostic.predicateGroup
    : undefined;
  throw coordinatorError(
    `LaunchServices did not produce a claimed MAS host handoff within 5 seconds: ${describe(lastError)}`,
    lastError,
    {
      category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT,
      lastCause,
      lastPredicateGroup,
    },
  );
}

export function validateMasHostHandoff(handoff, { context, session, state = "available", packageProof } = {}) {
  context = assertMasDevelopmentContext(context);
  try {
    assertHandoffSessionBinding(context, session);
  } catch (error) {
    if (error?.code === MAS_GATE_CLEANUP_DIAGNOSTIC_CODE) {
      attachMasLaunchDiagnostic(error, { predicateGroup: MAS_GATE_HANDOFF_PREDICATE_GROUPS.SESSION });
    }
    throw error;
  }
  if (state !== "available" && state !== "claimed") {
    throw coordinatorError("MAS host handoff state is unknown", undefined, {
      predicateGroup: MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE,
    });
  }
  const predicateGroup = masHostHandoffPredicateGroup({ handoff, context, session, state, packageProof });
  if (predicateGroup) {
    throw coordinatorError("MAS host handoff is not bound to the active session, exact MAS root, and installed bundle", undefined, {
      predicateGroup,
    });
  }
  return handoff;
}

function masHostHandoffPredicateGroup({ handoff, context, session, state, packageProof }) {
  const expectedKeys = [
    "activePath", "binaryDevice", "binaryInode", "binarySha256", "binarySize", "bundleIdentifier", "bundlePath",
    "bundleRealPath", "canonicalRuntimeRoot", "cdHash", "claimedAt", "claimedByPid", "designatedRequirement",
    "executablePath", "freshRootIdentity", "identityPath", "identityRelativePath", "ownerToken", "parentPath",
    "phase", "runId", "schema", "state", "version",
  ];
  const expectedRootIdentityKeys = ["dev", "gid", "ino", "mode", "nlink", "size", "type", "uid"];
  const packageIdentity = packageProof?.publishedHostIdentity;
  const expectedRelativeIdentity = context.identityRelativePath;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff) ||
      !hasExactKeys(handoff, expectedKeys) || !hasExactKeys(handoff.freshRootIdentity, expectedRootIdentityKeys)) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.SCHEMA;
  }
  if (!packageProof || packageProof.status !== "committed" || packageProof.transaction?.state !== "committed" ||
      packageProof.ownerToken !== session.ownerToken || packageProof.runId !== session.runId ||
      packageProof.target !== context.bundlePath || packageProof.identityPath !== context.identityPath ||
      packageProof.candidateFingerprint !== packageProof.artifactBinding?.bundleFingerprint) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.PACKAGE_PROOF;
  }
  if (!packageIdentity || typeof packageIdentity !== "object" || Array.isArray(packageIdentity)) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.INSTALLED_IDENTITY;
  }
  if (handoff.schema !== MAS_GATE_HOST_HANDOFF_SCHEMA || handoff.version !== 1) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.SCHEMA;
  }
  if (handoff.state !== state) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE;
  }
  if (handoff.ownerToken !== session.ownerToken || handoff.runId !== session.runId || handoff.phase !== "ready") {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.SESSION;
  }
  if (handoff.canonicalRuntimeRoot !== context.runtimeRoot || handoff.parentPath !== context.parentPath ||
      handoff.activePath !== context.activePath || handoff.activePath !== session.activePath ||
      !handoff.freshRootIdentity || !recursivelyEqual(handoff.freshRootIdentity, session.freshRootIdentity) ||
      handoff.identityRelativePath !== expectedRelativeIdentity || handoff.identityPath !== context.identityPath) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.ROOT;
  }
  if (handoff.bundlePath !== context.bundlePath || handoff.bundleRealPath !== context.bundlePath ||
      handoff.executablePath !== context.executablePath || handoff.bundleIdentifier !== context.contract.bundleIdentifier ||
      handoff.bundlePath !== packageIdentity.bundlePath || handoff.bundleRealPath !== packageIdentity.bundleRealPath ||
      handoff.executablePath !== packageIdentity.executablePath || handoff.bundleIdentifier !== packageIdentity.bundleIdentifier ||
      handoff.designatedRequirement !== packageIdentity.designatedRequirement || handoff.cdHash !== packageIdentity.cdHash ||
      handoff.binarySha256 !== packageIdentity.binarySha256 || handoff.binaryDevice !== packageIdentity.binaryDevice ||
      handoff.binaryInode !== packageIdentity.binaryInode || handoff.binarySize !== packageIdentity.binarySize ||
      typeof handoff.designatedRequirement !== "string" || handoff.designatedRequirement.length === 0 ||
      typeof handoff.cdHash !== "string" || !/^[a-f0-9]{40}$/u.test(handoff.cdHash) ||
      typeof handoff.binarySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(handoff.binarySha256) ||
      !isNonNegativeInteger(handoff.binaryDevice) || !isNonNegativeInteger(handoff.binaryInode) ||
      !Number.isSafeInteger(handoff.binarySize) || handoff.binarySize <= 0) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.INSTALLED_IDENTITY;
  }
  if (state === "available"
    ? handoff.claimedByPid !== null || handoff.claimedAt !== null
    : !Number.isInteger(handoff.claimedByPid) || handoff.claimedByPid <= 1 || typeof handoff.claimedAt !== "string" || handoff.claimedAt.length === 0) {
    return MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE;
  }
  return null;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function recursivelyEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => recursivelyEqual(value, right[index]));
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && recursivelyEqual(left[key], right[key]));
}

function assertHandoffSessionBinding(context, session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw coordinatorError("MAS host handoff session is missing");
  }
  if (session.stateScope !== "runtime-root-only" ||
      typeof session.ownerToken !== "string" || !/^[A-Za-z0-9_-]{40,80}$/u.test(session.ownerToken) ||
      typeof session.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session.runId) ||
      session.canonicalRuntimeRoot !== context.runtimeRoot ||
      session.parentPath !== context.parentPath ||
      session.activePath !== context.activePath ||
      session.identityRelativePath !== context.identityRelativePath ||
      session.identityPath !== context.identityPath ||
      !session.freshRootIdentity || typeof session.freshRootIdentity !== "object") {
    throw coordinatorError("MAS host handoff session is not bound to the exact MAS transaction context");
  }
}

function hostHandoffPath(session) {
  return path.join(session.activePath, MAS_GATE_HOST_HANDOFF_FILENAME);
}

async function writeDurableJson(temporary, target, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(temporary));
  const targetInfo = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (targetInfo) throw coordinatorError("MAS host handoff target already exists; preserve it and run gate recovery");
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

async function readProcessRows(context) {
  const output = (await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  })).stdout;
  const rows = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw coordinatorError("MAS process inspection returned an unparsable process row");
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const commandName = match[3].trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !candidateProcessNames(context).has(path.basename(commandName))) continue;
    const executablePath = await inspectProcessExecutable(pid);
    const arguments_ = await inspectNativeArgumentVector(pid);
    rows.push({ pid, ppid, executablePath, arguments: arguments_ });
  }
  return rows;
}

function processRowIsOwned(row, context) {
  if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 1 || !Number.isSafeInteger(row.ppid) ||
      typeof row.executablePath !== "string" || !Array.isArray(row.arguments)) return false;
  const exactPaths = Object.values(context.packagePaths).concat(Object.values(context.runtimePaths), [context.runtimeRoot, context.bundlePath]);
  if (exactPaths.some((candidate) => pathTokenMatches(row.executablePath, candidate) || row.arguments.some((token) => pathTokenMatches(token, candidate)))) return true;
  const host = row.executablePath === context.executablePath && row.ppid === 1 &&
    exactArguments(row.arguments, [context.executablePath]);
  const desktop = row.ppid > 1 && row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "desktop"]);
  const supervisor = row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "daemon"]);
  const worker = row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.daemonWorkerPath, "daemon"]);
  const plugin = row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.pluginPath]);
  const capture = row.executablePath === context.packagePaths.captureHelperPath &&
    exactArguments(row.arguments, [context.packagePaths.captureHelperPath]);
  return host || desktop || supervisor || worker || plugin || capture;
}

function candidateProcessNames(context) {
  return new Set([
    path.basename(context.executablePath),
    path.basename(context.packagePaths.nodePath),
    path.basename(context.packagePaths.captureHelperPath),
    "Paseo Supervisor",
    "Paseo Daemon",
  ]);
}

async function inspectProcessExecutable(pid) {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
    maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) {
    throw coordinatorError(`MAS process executable inspection failed for PID ${pid}`,
      result.error ?? new Error(`lsof exited ${result.status}`));
  }
  const lines = String(result.stdout ?? "").split("\n");
  const textIndex = lines.indexOf("ftxt");
  const executable = textIndex >= 0 ? lines[textIndex + 1] : undefined;
  if (!executable?.startsWith("n/") || executable.length <= 2) {
    throw coordinatorError(`MAS process executable inspection returned malformed evidence for PID ${pid}`);
  }
  return executable.slice(1);
}

function pathTokenMatches(value, candidate) {
  return value === candidate || value.startsWith(`${candidate}/`) || value.startsWith(`${candidate}=`);
}

function exactArguments(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export async function inspectListeners(ports, _context, dependencies = {}) {
  const listeners = [];
  for (const port of ports) {
    const result = await runMasLsof(
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"],
      MAS_LSOF_PURPOSES.LISTENER,
      dependencies,
    );
    if (result.status === "live") listeners.push({ port, records: result.records });
  }
  return listeners;
}

async function inspectCanonicalSockets(context) {
  const sockets = [];
  for (const socketPath of [context.runtimePaths.recordingSocket, context.runtimePaths.transcriptionSocket]) {
    const info = await lstat(socketPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info) sockets.push({ path: socketPath, type: info.isSocket?.() ? "socket" : "unexpected" });
  }
  return sockets;
}

export async function inspectOpenHandles(pids, context, dependencies = {}) {
  const root = await lstat(context.runtimeRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return [];
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw coordinatorError("MAS runtime-root +D lsof inspection requires one non-symlink directory before invocation");
  }
  const result = await runMasLsof(
    ["-nP", "+D", context.runtimeRoot, "-Fpcn"],
    MAS_LSOF_PURPOSES.OPEN_HANDLES,
    dependencies,
  );
  return result.status === "live"
    ? [{ path: context.runtimeRoot, records: result.records, inspectedPids: pids }]
    : [];
}

/**
 * Apply the one strict spawnSync result policy shared by exact listener and
 * runtime-root +D inspections. A status-1 no-match result is absence only
 * when both present streams have exactly zero bytes; bounded purpose-specific
 * records with exactly empty stderr are live evidence. No trimming or
 * semantic output normalization is allowed at this boundary.
 */
export function classifyMasLsofResult(result, purpose) {
  const policy = MAS_LSOF_POLICIES[purpose];
  if (!policy) throw coordinatorError("MAS lsof classifier received an unsupported fixed inspection purpose");

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    const stdout = projectMasLsofStream(readMasLsofProperty(result, "stdout"));
    const stderr = projectMasLsofStream(readMasLsofProperty(result, "stderr"));
    rejectMasLsofResult(result, purpose, `result is not one spawnSync result object; ${formatMasLsofDiagnostic(result, purpose, stdout, stderr)}`);
  }
  const error = readMasLsofProperty(result, "error");
  const status = readMasLsofProperty(result, "status");
  const signal = readMasLsofProperty(result, "signal");
  const stdout = projectMasLsofStream(readMasLsofProperty(result, "stdout"));
  const stderr = projectMasLsofStream(readMasLsofProperty(result, "stderr"));
  const diagnostic = formatMasLsofDiagnostic(result, purpose, stdout, stderr);
  if (!stdout.valid || !stderr.valid) {
    rejectMasLsofResult(result, purpose, `stdout and stderr must be present strings or Buffers; ${diagnostic}`);
  }
  if (stdout.byteLength > MAS_LSOF_MAX_BUFFER_BYTES || stderr.byteLength > MAS_LSOF_MAX_BUFFER_BYTES) {
    rejectMasLsofResult(result, purpose, `stream exceeds maxBuffer ${MAS_LSOF_MAX_BUFFER_BYTES} bytes; ${diagnostic}`);
  }
  if (error !== undefined) {
    rejectMasLsofResult(result, purpose, `spawnSync returned an error; ${diagnostic}`);
  }
  if (signal !== null) {
    rejectMasLsofResult(result, purpose, `spawnSync signal must be exactly null; ${diagnostic}`);
  }
  if (status === 1) {
    if (stdout.byteLength === 0 && stderr.byteLength === 0) return { status: "absent", records: [] };
    if (stderr.byteLength !== 0) {
      rejectMasLsofResult(result, purpose, `status 1 is not an exact empty no-match result because stderr is non-empty; ${diagnostic}`);
    }
    if (stdout.byteLength === 0) {
      rejectMasLsofResult(result, purpose, `status 1 is not an exact empty no-match result because stdout is empty but stderr is not; ${diagnostic}`);
    }
    return parseMasLsofLiveRecords(stdout, policy, result, purpose, diagnostic, 1);
  }
  if (status !== 0) {
    rejectMasLsofResult(result, purpose, `status must be exactly 0 or the exact no-match status 1; ${diagnostic}`);
  }
  if (stderr.byteLength !== 0) {
    rejectMasLsofResult(result, purpose, `status 0 carried diagnostic stderr; ${diagnostic}`);
  }
  if (stdout.byteLength === 0) {
    rejectMasLsofResult(result, purpose, `status 0 carried no lsof records; ${diagnostic}`);
  }

  return parseMasLsofLiveRecords(stdout, policy, result, purpose, diagnostic, 0);
}

function parseMasLsofLiveRecords(stdout, policy, result, purpose, diagnostic, status) {
  let records;
  try {
    records = parseMasLsofRecords(stdout.bytes, policy);
  } catch (error) {
    rejectMasLsofResult(result, purpose, `status ${status} carried malformed lsof records (${error.message}); ${diagnostic}`);
  }
  return { status: "live", records };
}

async function runMasLsof(arguments_, purpose, dependencies = {}) {
  const invoke = dependencies.invokeLsof ?? spawnSync;
  if (typeof invoke !== "function") throw coordinatorError("MAS lsof invocation adapter must be one low-level function");
  let result;
  try {
    result = await invoke("/usr/sbin/lsof", arguments_, {
      encoding: "utf8",
      maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
      env: MAS_LSOF_ENV,
    });
  } catch (error) {
    result = { error, status: null, signal: null, stdout: undefined, stderr: undefined };
  }
  return classifyMasLsofResult(result, purpose);
}

function parseMasLsofRecords(bytes, policy) {
  let output;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid UTF-8 output");
  }
  if (!output.endsWith("\n")) throw new Error("records are missing the final newline");
  if (output.includes("\0")) throw new Error("records contain a NUL byte");

  const records = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    if (current.command === null) throw new Error("record is missing command field c");
    for (const field of policy.requiredFields) {
      if (field === "c" && current.command === null) throw new Error("record is missing command field c");
      if (field === "n" && current.names.length === 0) throw new Error("record is missing name field n");
      if (field === "t" && current.types.length === 0) throw new Error("record is missing type field t");
    }
    if (records.length >= MAS_LSOF_MAX_RECORDS) throw new Error("record count exceeds the bounded limit");
    const record = { pid: current.pid, command: current.command };
    if (current.files.length > 0) record.fileDescriptors = current.files;
    if (current.names.length > 0) record.paths = current.names;
    if (current.types.length > 0) record.types = current.types;
    records.push(record);
    current = null;
  };

  for (const line of output.slice(0, -1).split("\n")) {
    if (line.length < 2) throw new Error("record field is empty");
    const code = line[0];
    const value = line.slice(1);
    if (!policy.allowedFields.includes(code)) throw new Error("record contains an unexpected field");
    if (Buffer.byteLength(value, "utf8") > MAS_LSOF_MAX_FIELD_BYTES) throw new Error("record field exceeds the bounded limit");
    if (code === "p") {
      finish();
      if (!/^[1-9]\d*$/u.test(value)) throw new Error("process field p is not a positive decimal PID");
      const pid = Number(value);
      if (!Number.isSafeInteger(pid)) throw new Error("process field p exceeds the safe PID range");
      current = { pid, command: null, files: [], names: [], types: [] };
      continue;
    }
    if (!current) throw new Error("record field appeared before process field p");
    if (!/\S/u.test(value)) throw new Error("record field value is empty or whitespace");
    if (code === "c") {
      if (current.command !== null) throw new Error("record contains duplicate command field c");
      current.command = value;
    } else if (code === "f") {
      current.files.push(value);
    } else if (code === "n") {
      current.names.push(value);
    } else if (code === "t") {
      current.types.push(value);
    }
  }
  finish();
  if (records.length === 0) throw new Error("no complete lsof records");
  return records;
}

function rejectMasLsofResult(result, purpose, reason) {
  throw coordinatorError(`MAS ${MAS_LSOF_POLICIES[purpose].label} lsof result rejected: ${reason}`);
}

function projectMasLsofStream(output) {
  if (Buffer.isBuffer(output)) {
    return { valid: true, state: "present", type: "buffer", byteLength: output.byteLength, bytes: output };
  }
  if (typeof output === "string") {
    return { valid: true, state: "present", type: "string", byteLength: Buffer.byteLength(output, "utf8"), bytes: Buffer.from(output, "utf8") };
  }
  if (output === null) return { valid: false, state: "absent", type: "null", byteLength: 0, bytes: null };
  if (output === undefined) return { valid: false, state: "absent", type: "undefined", byteLength: 0, bytes: null };
  return { valid: false, state: "present", type: typeof output, byteLength: 0, bytes: null };
}

function formatMasLsofDiagnostic(result, purpose, stdout, stderr) {
  return [
    `purpose=${purpose}`,
    `error=${formatMasLsofError(readMasLsofProperty(result, "error"))}`,
    `status=${formatMasLsofScalar(readMasLsofProperty(result, "status"))}`,
    `signal=${formatMasLsofScalar(readMasLsofProperty(result, "signal"))}`,
    `stdout={state=${stdout.state},type=${stdout.type},byteLength=${stdout.byteLength}}`,
    `stderr={state=${stderr.state},type=${stderr.type},byteLength=${stderr.byteLength}}`,
  ].join(" ");
}

function formatMasLsofError(error) {
  if (error === undefined) return "<undefined>";
  if (error === null) return "<null>";
  if (typeof error !== "object" && typeof error !== "function") return `<${typeof error}>`;
  return ["name", "code", "errno", "syscall"]
    .map((field) => `${field}=${formatMasLsofScalar(readMasLsofProperty(error, field))}`)
    .join(",");
}

function formatMasLsofScalar(value) {
  if (value === undefined) return "<undefined>";
  if (value === null) return "<null>";
  if (typeof value === "string") {
    const bounded = value.length > 96 ? `${value.slice(0, 93)}...` : value;
    return JSON.stringify(bounded);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `<${typeof value}>`;
}

function readMasLsofProperty(value, property) {
  if (value === null || value === undefined) return undefined;
  try { return value[property]; } catch { return undefined; }
}

function exactListenerPorts(context) {
  const listenPort = Number(String(context.contract.listen).slice(String(context.contract.listen).lastIndexOf(":") + 1));
  const rendererPort = Number(new URL(context.contract.rendererOrigin).port);
  if (![listenPort, rendererPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw coordinatorError("MAS contract listener ports are invalid");
  }
  return [...new Set([listenPort, rendererPort])];
}

async function pathExists(candidate) {
  try { await lstat(candidate); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw coordinatorError(`${label} must be one exact canonical absolute path`);
  }
  return value;
}

function currentUid() {
  if (typeof process.getuid !== "function") throw coordinatorError("MAS coordinator requires process UID support");
  return process.getuid();
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const MAS_GATE_LAUNCH_DIAGNOSTIC_PROPERTY = "masLaunchDiagnostic";
const MAS_GATE_LAUNCH_FAILURE_CATEGORY_VALUES = new Set(Object.values(MAS_GATE_LAUNCH_FAILURE_CATEGORIES));
const MAS_GATE_HANDOFF_PREDICATE_GROUP_VALUES = new Set(Object.values(MAS_GATE_HANDOFF_PREDICATE_GROUPS));
const MAS_GATE_LAUNCH_LAST_CAUSE_VALUES = new Set(Object.values(MAS_GATE_LAUNCH_LAST_CAUSES));

export function serializeMasDevelopmentGateFailure(error, fallbackCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN) {
  const existing = readMasLaunchDiagnostic(error);
  const category = existing?.category ?? (
    MAS_GATE_LAUNCH_FAILURE_CATEGORY_VALUES.has(fallbackCategory)
      ? fallbackCategory
      : MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN
  );
  const diagnostic = {
    schema: MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
    category,
  };
  if (existing?.predicateGroup) diagnostic.predicateGroup = existing.predicateGroup;
  if (category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT) {
    diagnostic.lastCause = existing?.lastCause ?? MAS_GATE_LAUNCH_LAST_CAUSES.UNKNOWN;
    if (existing?.lastPredicateGroup) diagnostic.lastPredicateGroup = existing.lastPredicateGroup;
  }
  return {
    coordinator: MAS_GATE_COORDINATOR_SCHEMA,
    status: "failed",
    diagnostic,
  };
}

function attachMasLaunchDiagnostic(error, { category, lastCause, predicateGroup, lastPredicateGroup } = {}) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  const existing = readMasLaunchDiagnostic(error);
  const normalizedCategory = MAS_GATE_LAUNCH_FAILURE_CATEGORY_VALUES.has(category)
    ? category
    : MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN;
  const diagnostic = { category: normalizedCategory };
  const normalizedPredicateGroup = MAS_GATE_HANDOFF_PREDICATE_GROUP_VALUES.has(predicateGroup)
    ? predicateGroup
    : existing?.predicateGroup;
  if (normalizedPredicateGroup) diagnostic.predicateGroup = normalizedPredicateGroup;
  if (normalizedCategory === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT) {
    diagnostic.lastCause = MAS_GATE_LAUNCH_LAST_CAUSE_VALUES.has(lastCause)
      ? lastCause
      : existing?.lastCause ?? MAS_GATE_LAUNCH_LAST_CAUSES.UNKNOWN;
    const normalizedLastPredicateGroup = MAS_GATE_HANDOFF_PREDICATE_GROUP_VALUES.has(lastPredicateGroup)
      ? lastPredicateGroup
      : existing?.lastPredicateGroup;
    if (normalizedLastPredicateGroup) diagnostic.lastPredicateGroup = normalizedLastPredicateGroup;
  }
  Object.defineProperty(error, MAS_GATE_LAUNCH_DIAGNOSTIC_PROPERTY, {
    configurable: true,
    enumerable: false,
    value: Object.freeze(diagnostic),
  });
  return error;
}

function readMasLaunchDiagnostic(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  let candidate;
  try { candidate = error[MAS_GATE_LAUNCH_DIAGNOSTIC_PROPERTY]; } catch { return null; }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      !MAS_GATE_LAUNCH_FAILURE_CATEGORY_VALUES.has(candidate.category)) return null;
  const diagnostic = { category: candidate.category };
  if (MAS_GATE_HANDOFF_PREDICATE_GROUP_VALUES.has(candidate.predicateGroup)) {
    diagnostic.predicateGroup = candidate.predicateGroup;
  }
  if (candidate.category === MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT) {
    diagnostic.lastCause = MAS_GATE_LAUNCH_LAST_CAUSE_VALUES.has(candidate.lastCause)
      ? candidate.lastCause
      : MAS_GATE_LAUNCH_LAST_CAUSES.UNKNOWN;
    if (MAS_GATE_HANDOFF_PREDICATE_GROUP_VALUES.has(candidate.lastPredicateGroup)) {
      diagnostic.lastPredicateGroup = candidate.lastPredicateGroup;
    }
  }
  return Object.freeze(diagnostic);
}

function coordinatorError(reason, cause, diagnostic) {
  const error = new Error(`MAS-GATE-CLEANUP-001: repository-authorized MAS development coordinator failed closed. Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: leave every root intact; run MAS gate status/recovery. Reason: ${reason}`);
  error.code = "MAS-GATE-CLEANUP-001";
  if (cause) error.cause = cause;
  if (diagnostic) attachMasLaunchDiagnostic(error, diagnostic);
  return error;
}

function describe(error) { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main() {
  const [command = "status", ...arguments_] = process.argv.slice(2);
  if (command === "launch") {
    try {
      const context = masDevelopmentRuntimeContext();
      process.stdout.write(`${JSON.stringify(await launchMasDevelopmentGate({ context }), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify(serializeMasDevelopmentGateFailure(error, MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PREFLIGHT_STATUS), null, 2)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const context = masDevelopmentRuntimeContext();
  if (command === "help" || command === "--help") {
    process.stdout.write("Usage: node scripts/macos-mas-development-gate.mjs <status|install|launch|stop|restore|recover> [--manifest=/proof/release/macos/app-store-development-manifest.json] [--bundle=/proof/release/macos/Meetless.app] [--required-free-bytes=N]\n");
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await readMasDevelopmentGateStatus({ context }), null, 2)}\n`);
    return;
  }
  if (command === "install") {
    const manifestPath = readRequiredPath(arguments_, "--manifest=");
    const bundlePath = readRequiredPath(arguments_, "--bundle=");
    const requiredFreeBytes = readRequiredFreeBytes(arguments_);
    process.stdout.write(`${JSON.stringify(await installMasDevelopmentGate({ manifestPath, bundlePath, requiredFreeBytes, context }), null, 2)}\n`);
    return;
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopMasDevelopmentGate({ context }), null, 2)}\n`);
    return;
  }
  if (command === "restore" || command === "recover") {
    process.stdout.write(`${JSON.stringify(await restoreMasDevelopmentGate({ context }), null, 2)}\n`);
    return;
  }
  throw coordinatorError(`unknown MAS coordinator command: ${command}`);
}

function readRequiredPath(arguments_, prefix) {
  const argument = arguments_.find((value) => value.startsWith(prefix));
  if (!argument) throw coordinatorError(`${prefix.slice(0, -1)} is required for this MAS coordinator command`);
  return canonicalAbsolute(argument.slice(prefix.length), "MAS coordinator path");
}

function readRequiredFreeBytes(arguments_) {
  const argument = arguments_.find((value) => value.startsWith("--required-free-bytes="));
  if (!argument) return undefined;
  const value = Number(argument.slice("--required-free-bytes=".length));
  if (!Number.isSafeInteger(value) || value <= 0) throw coordinatorError("--required-free-bytes must be an explicit positive integer");
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await main();
