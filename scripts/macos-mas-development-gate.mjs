import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import {
  archiveMasGateSessionTransaction,
  assertMasGateSessionReady,
  beginMasGateSessionTransaction,
  readMasGateSessionStatus,
  restoreMasGateSessionTransaction,
} from "./lib/macos-mas-gate-session-transaction.mjs";
import {
  acquireMasGateLock,
  masGateLockPath,
} from "./lib/macos-mas-gate-lock.mjs";
import { macAppStoreInstallationContract } from "./lib/macos-app-store-package-contract.mjs";
import { acceptedMacOSPackagePaths } from "./lib/macos-package-contract.mjs";
import {
  packageTransactionPaths,
  replacePackageBundle,
  restorePackageTransaction,
} from "./lib/macos-package-transaction.mjs";

export const MAS_GATE_COORDINATOR_SCHEMA = "MAS_GATE_COORDINATOR v1";
export const MAS_GATE_HOST_HANDOFF_SCHEMA = "MAS_GATE_HOST_HANDOFF v1";
export const MAS_GATE_HOST_HANDOFF_FILENAME = "host-handoff.json";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);

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
  const supervisorEntrypoint = path.join(packageRoot, "vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js");
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
      supervisorEntrypoint,
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
 * Inspect the exact MAS process topology and canonical endpoints. Matching is
 * path-aware and token-aware; a command substring is never treated as proof
 * of ownership or absence.
 */
export async function inspectMasLiveState(context, dependencies = {}) {
  context = assertMasDevelopmentContext(context);
  const rows = await (dependencies.processRows ?? readProcessRows)();
  assertProcessRows(rows);
  const ownedProcesses = rows.filter((row) => processRowIsOwned(row, context));
  const listenerPorts = exactListenerPorts(context);
  const listeners = await (dependencies.listeners ?? inspectListeners)(listenerPorts, context);
  const sockets = await (dependencies.sockets ?? inspectCanonicalSockets)(context);
  assertEvidenceList(listeners, "listener");
  assertEvidenceList(sockets, "socket");
  const openHandles = await (dependencies.openHandles ?? inspectOpenHandles)(ownedProcesses.map((row) => row.pid), context);
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
    if (!row || typeof row !== "object" || !Number.isInteger(row.pid) || row.pid < 1 ||
        !Number.isInteger(row.ppid) || row.ppid < 0 || typeof row.executablePath !== "string" ||
        !row.executablePath || !path.isAbsolute(row.executablePath) || !Array.isArray(row.arguments) ||
        row.arguments.length === 0 || row.arguments.some((argument) => typeof argument !== "string" || !argument)) {
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
  bundlePath,
  requiredFreeBytes,
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  context = assertMasDevelopmentContext(context);
  const source = canonicalAbsolute(bundlePath, "MAS development bundle");
  if (requiredFreeBytes === undefined) throw coordinatorError("install requires an explicit --required-free-bytes input; it is advisory preflight only, not a reservation or peak-use guarantee");
  const lease = await acquireMasGateLock({ parentPath: context.parentPath });
  let session;
  try {
    session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes, lockLease: lease, dependencies }),
    });
    await assertMasGateSessionReady(session, masGateRuntimeOptions(context, { lockLease: lease, dependencies }));
    const inspectBundle = dependencies.inspectBundle ?? ((target) => inspectHostBundle(target, {
      runtimeRoot: context.runtimeRoot,
      containerSupportRoot: context.parentPath,
    }));
    const packageTransaction = await replacePackageBundle({
      source,
      target: context.bundlePath,
      identityPath: context.identityPath,
      ownerToken: session.ownerToken,
      runId: session.runId,
      inspect: inspectBundle,
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
    throw coordinatorError(`MAS development installation stopped before host launch: ${describe(error)}`, error);
  } finally {
    await lease.release();
  }
}

export async function launchMasDevelopmentGate({
  context = masDevelopmentRuntimeContext(),
  dependencies = {},
} = {}) {
  context = assertMasDevelopmentContext(context);
  const lease = await acquireMasGateLock({ parentPath: context.parentPath });
  let released = false;
  try {
    const status = await readMasGateSessionStatus({ ...masGateRuntimeOptions(context, { dependencies }), lockLease: lease });
    if (status.status !== "active" || status.phase !== "ready") {
      throw coordinatorError(`MAS launch requires one active ready transaction; observed ${status.status}/${status.phase ?? "none"}`);
    }
    const handoff = await readHostHandoff(status, context);
    const launch = dependencies.launch ?? (async () => {
      await execFileAsync("open", ["-g", "-a", context.bundlePath]);
    });
    await lease.release();
    released = true;
    await launch({ context, status, handoff });
    const claimed = dependencies.waitForHandoff
      ? await dependencies.waitForHandoff({ context, status, handoff })
      : await waitForMasHostHandoffClaim(context, status);
    validateMasHostHandoff(claimed, {
      context,
      session: await readSessionJournal(path.join(status.activePath, "transaction.json")),
      state: "claimed",
    });
    return { coordinator: MAS_GATE_COORDINATOR_SCHEMA, status: "launch-claimed", runId: status.runId, handoff: claimed };
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw coordinatorError(`MAS launch stopped before host handoff: ${describe(error)}`, error);
  } finally {
    if (!released) await lease.release();
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
  const stop = dependencies.stop ?? (async () => {
    const script = path.join(context.packageRoot, "scripts/stop-macos-host.mjs");
    const node = context.packagePaths.nodePath;
    const environment = {
      ...process.env,
      MEETLESS_RUNTIME_ROOT: context.runtimeRoot,
      MEETLESS_LISTEN: context.contract.listen,
      MEETLESS_MAS_COORDINATOR_AUTHORITY: MAS_GATE_COORDINATOR_SCHEMA,
    };
    delete environment.MEETLESS_RENDERER_ORIGIN;
    delete environment.MEETLESS_EXPORT_ROOT;
    await execFileAsync(node, [script], {
      cwd: context.packageRoot,
      env: environment,
    });
  });
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
        const packageLease = await acquireMasGateLock({ parentPath: context.parentPath });
        try {
          const status = await readMasGateSessionStatus(masGateRuntimeOptions(context, { dependencies, lockLease: packageLease }));
          if (status.status !== "active" && status.status !== "recovery-required") {
            return { status: "nothing-to-restore", observation: stopped.observation };
          }
          sessionJournalPath = status.journalPath;
          session = await readSessionJournal(sessionJournalPath);
          if (typeof session.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session.runId)) {
            throw coordinatorError("MAS session journal run ID is invalid; preserve every root and do not derive package paths");
          }
          const packageJournalPath = packageTransactionPaths(context.bundlePath, session.runId).journal;
          if (await pathExists(packageJournalPath)) {
            const packageInfo = await lstat(packageJournalPath);
            if (packageInfo.isSymbolicLink() || !packageInfo.isFile() || packageInfo.uid !== currentUid() || packageInfo.nlink !== 1 || (packageInfo.mode & 0o7777) !== 0o600) {
              throw coordinatorError("MAS package transaction journal is not one secure regular file");
            }
            let packageTransaction;
            try {
              packageTransaction = JSON.parse(await readFile(packageJournalPath, "utf8"));
            } catch (error) {
              throw coordinatorError(`MAS package transaction journal is malformed: ${describe(error)}`, error);
            }
            await restorePackageTransaction(packageTransaction, {
              ownerToken: session.ownerToken,
              target: context.bundlePath,
              identityPath: context.identityPath,
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
    return JSON.parse(await readFile(journalPath, "utf8"));
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

async function readHostHandoff(status, context) {
  return readHostHandoffFile(
    status.activePath,
    status.journalPath,
    context,
    "available",
  );
}

async function readHostHandoffFile(activePath, journalPath, context, state) {
  const target = path.join(activePath, MAS_GATE_HOST_HANDOFF_FILENAME);
  const info = await lstat(target).catch((error) => { throw coordinatorError(`MAS host handoff is unavailable: ${describe(error)}`, error); });
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) {
    throw coordinatorError("MAS host handoff is not one secure regular file");
  }
  let handoff;
  try { handoff = JSON.parse(await readFile(target, "utf8")); } catch (error) { throw coordinatorError("MAS host handoff is malformed", error); }
  const session = await readSessionJournal(journalPath);
  return validateMasHostHandoff(handoff, { context, session, state });
}

async function waitForMasHostHandoffClaim(context, status) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readHostHandoffFile(
        status.activePath,
        path.join(status.activePath, "transaction.json"),
        context,
        "claimed",
      );
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw coordinatorError(
    `LaunchServices did not produce a claimed MAS host handoff within 5 seconds: ${describe(lastError)}`,
    lastError,
  );
}

export function validateMasHostHandoff(handoff, { context, session, state = "available" } = {}) {
  context = assertMasDevelopmentContext(context);
  assertHandoffSessionBinding(context, session);
  if (state !== "available" && state !== "claimed") throw coordinatorError("MAS host handoff state is unknown");
  const expectedRelativeIdentity = context.identityRelativePath;
  const valid = handoff && typeof handoff === "object" && !Array.isArray(handoff) &&
    handoff.schema === MAS_GATE_HOST_HANDOFF_SCHEMA && handoff.version === 1 && handoff.state === state &&
    handoff.ownerToken === session.ownerToken && handoff.runId === session.runId && handoff.phase === "ready" &&
    handoff.canonicalRuntimeRoot === context.runtimeRoot && handoff.parentPath === context.parentPath &&
    handoff.activePath === context.activePath && handoff.activePath === session.activePath && handoff.freshRootIdentity &&
    JSON.stringify(handoff.freshRootIdentity) === JSON.stringify(session.freshRootIdentity) &&
    handoff.identityRelativePath === expectedRelativeIdentity && handoff.identityPath === context.identityPath &&
    handoff.bundlePath === context.bundlePath && handoff.bundleRealPath === context.bundlePath &&
    handoff.executablePath === context.executablePath && handoff.bundleIdentifier === context.contract.bundleIdentifier &&
    typeof handoff.designatedRequirement === "string" && handoff.designatedRequirement.length > 0 &&
    typeof handoff.cdHash === "string" && /^[a-f0-9]{40}$/u.test(handoff.cdHash) &&
    typeof handoff.binarySha256 === "string" && /^[a-f0-9]{64}$/u.test(handoff.binarySha256) &&
    isNonNegativeInteger(handoff.binaryDevice) && isNonNegativeInteger(handoff.binaryInode) &&
    Number.isSafeInteger(handoff.binarySize) && handoff.binarySize > 0 &&
    (state === "available" ? handoff.claimedByPid === null && handoff.claimedAt === null :
      Number.isInteger(handoff.claimedByPid) && handoff.claimedByPid > 1 && typeof handoff.claimedAt === "string" && handoff.claimedAt.length > 0);
  if (!valid) throw coordinatorError("MAS host handoff is not bound to the active session, exact MAS root, and installed bundle");
  return handoff;
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

async function readProcessRows() {
  const output = (await execFileAsync("ps", ["-axo", "pid=,ppid=,command="])).stdout;
  const rows = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) throw coordinatorError("MAS process inspection returned an unparsable process row");
    const command = match[3];
    const tokens = command.trim().split(/\s+/u);
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command, executablePath: tokens[0], arguments: tokens });
  }
  return rows;
}

function processRowIsOwned(row, context) {
  if (!row || !Number.isInteger(row.pid) || row.pid <= 1 || !Number.isInteger(row.ppid) ||
      typeof row.executablePath !== "string" || !Array.isArray(row.arguments)) return false;
  const exactPaths = Object.values(context.packagePaths).concat(Object.values(context.runtimePaths), [context.runtimeRoot, context.bundlePath]);
  if (exactPaths.some((candidate) => pathTokenMatches(row.executablePath, candidate) || row.arguments.some((token) => pathTokenMatches(token, candidate)))) return true;
  const host = row.executablePath === context.executablePath && row.ppid === 1;
  const desktop = row.ppid > 1 && row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "desktop"]);
  const supervisor = row.executablePath === context.packagePaths.nodePath &&
    exactArguments(row.arguments, [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "daemon"]);
  const worker = row.arguments.some((token) => token === context.packagePaths.supervisorEntrypoint);
  const plugin = row.arguments.some((token) => token === context.packagePaths.pluginPath);
  const capture = row.executablePath === context.packagePaths.captureHelperPath;
  return host || desktop || supervisor || worker || plugin || capture;
}

function pathTokenMatches(value, candidate) {
  return value === candidate || value.startsWith(`${candidate}/`) || value.startsWith(`${candidate}=`);
}

function exactArguments(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function inspectListeners(ports) {
  const listeners = [];
  for (const port of ports) {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") continue;
    if (result.status !== 0) throw new Error(`lsof listener inspection exited ${result.status}: ${result.stderr?.trim() ?? ""}`);
    if (result.stdout.trim()) listeners.push({ port, output: result.stdout.trim() });
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

async function inspectOpenHandles(pids, context) {
  const root = await lstat(context.runtimeRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return [];
  const result = spawnSync("lsof", ["-nP", "+D", context.runtimeRoot, "-Fpcn"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return [];
  if (result.status !== 0) throw new Error(`lsof runtime-root handle inspection exited ${result.status}: ${result.stderr?.trim() ?? ""}`);
  return result.stdout.trim() ? [{ path: context.runtimeRoot, output: result.stdout.trim(), inspectedPids: pids }] : [];
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

function coordinatorError(reason, cause) {
  const error = new Error(`MAS-GATE-CLEANUP-001: repository-authorized MAS development coordinator failed closed. Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: leave every root intact; run MAS gate status/recovery. Reason: ${reason}`);
  error.code = "MAS-GATE-CLEANUP-001";
  if (cause) error.cause = cause;
  return error;
}

function describe(error) { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main() {
  const [command = "status", ...arguments_] = process.argv.slice(2);
  const context = masDevelopmentRuntimeContext();
  if (command === "help" || command === "--help") {
    process.stdout.write("Usage: node scripts/macos-mas-development-gate.mjs <status|begin|install|launch|stop|restore|recover> [--bundle=/absolute/Meetless.app] [--required-free-bytes=N]\n");
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await readMasGateSessionStatus(masGateRuntimeOptions(context)), null, 2)}\n`);
    return;
  }
  if (command === "begin") {
    const requiredFreeBytes = readRequiredFreeBytes(arguments_);
    if (requiredFreeBytes === undefined) throw coordinatorError("begin requires --required-free-bytes=N; no budget default is selected");
    const result = await beginMasGateSessionTransaction(masGateRuntimeOptions(context, { requiredFreeBytes }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "install") {
    const bundlePath = readRequiredPath(arguments_, "--bundle=");
    const requiredFreeBytes = readRequiredFreeBytes(arguments_);
    process.stdout.write(`${JSON.stringify(await installMasDevelopmentGate({ bundlePath, requiredFreeBytes, context }), null, 2)}\n`);
    return;
  }
  if (command === "launch") {
    process.stdout.write(`${JSON.stringify(await launchMasDevelopmentGate({ context }), null, 2)}\n`);
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
