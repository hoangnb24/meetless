import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync as pathExists, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateMacOSPackage } from "./validate-macos-package.mjs";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import {
  fingerprintPath,
  newPackageTransactionId,
  packageTransactionPaths,
  readBytes,
  recoverPackageTransaction,
  replacePackageBundle,
  restorePackageTransaction,
} from "./lib/macos-package-transaction.mjs";
import { MACOS_PACKAGE_RENDERER_ORIGIN, acceptedMacOSPackagePaths } from "./lib/macos-package-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.argv[2] ?? path.join(repositoryRoot, "release/macos/composition-manifest.json"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const releaseRoot = path.dirname(manifestPath);
const candidateBundle = path.resolve(releaseRoot, manifest.bundlePath);
const packagePaths = acceptedMacOSPackagePaths();
const canonicalBundle = packagePaths.canonicalBundlePath;
const canonicalPackageRoot = path.join(canonicalBundle, "Contents", "Resources", "meetless");
const runtimeRoot = packagePaths.runtimeRoot;
const identityPath = packagePaths.identityPath;
const proofLockPath = "/private/tmp/meetless-m7-package-proof.lock";
const proofLockMarker = "MEETLESS_M7_PACKAGE_PROOF_LOCK_HELD";
const proofOwnerPrefix = "MEETLESS_M7_PACKAGE_PROOF_v1:";
const proofRunId = randomUUID();
const proofOwner = `${proofOwnerPrefix}${proofRunId}`;
const packageRuntimeOwnerPath = path.join(runtimeRoot, "package-proof-owner.json");

const lockHeld = await acquireProofLock();
if (lockHeld) await main();

async function acquireProofLock() {
  if (process.env[proofLockMarker] === proofLockPath) {
    await writeFile(
      proofLockPath,
      `${JSON.stringify({ role: "package-proof", runId: proofRunId, ownerToken: proofOwner, pid: process.pid })}\n`,
      { mode: 0o600 },
    );
    return true;
  }
  const locked = spawnSync("/usr/bin/lockf", [
    "-t", "0", "-k", proofLockPath,
    process.execPath, ...process.argv.slice(1),
  ], {
    stdio: "inherit",
    env: { ...process.env, [proofLockMarker]: proofLockPath },
  });
  if (locked.error) throw locked.error;
  if (locked.status === 75) {
    throw new Error(`Package proof kernel lock is held at ${proofLockPath}; do not run a second package proof`);
  }
  if (locked.status !== 0) process.exit(locked.status ?? 1);
  return false;
}

async function main() {
  assertNoActiveRecordingOrCapture();
  assertNoExactHost(canonicalBundle);
  assertNoUnrelatedHost(canonicalBundle);
  await recoverStaleProofTransactions();
  const validation = await validateMacOSPackage(manifestPath, {
    repositoryRoot,
    signingMode: "local-ad-hoc",
    signingIdentity: "-",
  });
  const packageConfiguration = await readPackageHostConfiguration();
  assertPortAvailable(packageConfiguration.listen, "daemon");
  assertPortAvailable(packageConfiguration.rendererOrigin, "renderer");

  const defaultPaths = [
    path.join(repositoryRoot, ".meetless-runtime", "meeting-store"),
    path.join(homedir(), "Documents", "meetings"),
  ];
  const defaultBefore = await snapshotPaths(defaultPaths);
  const previousBundleFingerprint = await fingerprintPath(canonicalBundle);
  const previousIdentity = await readBytes(identityPath);
  let transaction = null;
  let launchAttempted = false;
  let primaryError = null;
  let cleanupError = null;
  let stopSucceeded = false;
  let runtimePrepared = false;
  let defaultAfter = null;
  let topology = null;
  let readiness = null;
  let rendererProof = null;
  let sentinelBefore = null;
  let sentinelAfter = null;
  let installed = null;
  try {
    await prepareProofRuntime();
    runtimePrepared = true;
    await proveTransactionRecovery();

    const replacementRunId = newPackageTransactionId();
    try {
      transaction = await replacePackageBundle({
        source: candidateBundle,
        target: canonicalBundle,
        identityPath,
        ownerToken: proofOwner,
        runId: replacementRunId,
        inspect: inspectHostBundle,
      });
    } catch (error) {
      const journalPath = packageTransactionPaths(canonicalBundle, replacementRunId).journal;
      if (pathExists(journalPath)) transaction = JSON.parse(await readFile(journalPath, "utf8"));
      throw error;
    }
    installed = await inspectHostBundle(canonicalBundle);
    if (installed.bundleIdentifier !== "com.meetless.app") throw new Error("installed package host identity drifted");
    if (installed.configuration.rendererOrigin !== packageConfiguration.rendererOrigin) {
      throw new Error("installed host renderer origin differs from the candidate host configuration");
    }
    sentinelBefore = await seedIsolatedProofState();

    const packageNode = path.join(canonicalPackageRoot, "runtime", "node");
    const launchScript = path.join(canonicalPackageRoot, "scripts", "launch-macos-host.mjs");
    launchAttempted = true;
    await execFileAsync(packageNode, [launchScript], {
      cwd: canonicalPackageRoot,
      env: packageEnvironment(packageConfiguration),
      maxBuffer: 8 * 1024 * 1024,
    });
    topology = await waitForPackagedTopology(installed.executablePath, packageNode);
    const packagedHost = await import(pathToFileURL(path.join(canonicalPackageRoot, "packages/runtime/dist/host.js")).href);
    const packagedConfigModule = await import(pathToFileURL(path.join(canonicalPackageRoot, "packages/runtime/dist/config.js")).href);
    const packagedReadiness = await import(pathToFileURL(path.join(canonicalPackageRoot, "packages/runtime/dist/readiness.js")).href);
    const config = packagedConfigModule.resolveRuntimeConfig({
      repositoryRoot: canonicalPackageRoot,
      runtimeRoot: packageConfiguration.runtimeRoot,
      listen: packageConfiguration.listen,
      rendererOrigin: packageConfiguration.rendererOrigin,
      environment: packageEnvironment(packageConfiguration),
    });
    const liveInstalled = await packagedHost.assertInstalledHostIdentity(config);
    if (liveInstalled.bundleIdentifier !== installed.bundleIdentifier) throw new Error("packaged identity changed during proof");
    readiness = await packagedReadiness.waitForRecordingRuntime(config, { timeoutMs: 60_000 });
    if (path.resolve(readiness.daemonPlugin.sourcePath) !== path.resolve(config.paths.plugin)) {
      throw new Error("packaged readiness reported a plugin source outside the package");
    }
    rendererProof = await waitForRenderer(packageConfiguration.rendererOrigin, manifest.renderer);

    const stopScript = path.join(canonicalPackageRoot, "scripts", "stop-macos-host.mjs");
    await execFileAsync(packageNode, [stopScript], {
      cwd: canonicalPackageRoot,
      env: packageEnvironment(packageConfiguration),
      maxBuffer: 8 * 1024 * 1024,
    });
    stopSucceeded = true;
    assertNoExactHost(canonicalBundle);
    assertNoPackagedRuntimeProcesses();
    assertPortsReleased(packageConfiguration.listen, packageConfiguration.rendererOrigin);
    sentinelAfter = await readFile(path.join(runtimeRoot, "meeting-store", "M7-proof-sentinel.txt"));
    if (!sentinelBefore.equals(sentinelAfter)) throw new Error("isolated proof sentinel changed during packaged readiness");
    defaultAfter = await snapshotPaths(defaultPaths);
    assertSnapshotsEqual(defaultBefore, defaultAfter, "default MeetingStore chunks or export files");
  } catch (error) {
    primaryError = error;
  } finally {
    const liveHost = findExactHostPids(canonicalBundle);
    const packageProcesses = findPackagedRuntimeProcesses();
    if (!launchAttempted && liveHost.length === 0 && packageProcesses.length === 0) stopSucceeded = true;
    if (launchAttempted || liveHost.length > 0 || packageProcesses.length > 0) {
      try {
        if (!stopSucceeded) {
          const packageNode = path.join(canonicalPackageRoot, "runtime", "node");
          const stopScript = path.join(canonicalPackageRoot, "scripts", "stop-macos-host.mjs");
          await execFileAsync(packageNode, [stopScript], {
            cwd: canonicalPackageRoot,
            env: packageEnvironment(packageConfiguration),
            maxBuffer: 8 * 1024 * 1024,
          });
          stopSucceeded = true;
        }
        assertNoExactHost(canonicalBundle);
        assertNoPackagedRuntimeProcesses();
        assertPortsReleased(packageConfiguration.listen, packageConfiguration.rendererOrigin);
      } catch (error) {
        cleanupError = error;
      }
    }

    const safeToRestore = stopSucceeded && findExactHostPids(canonicalBundle).length === 0 &&
      findPackagedRuntimeProcesses().length === 0;
    if (safeToRestore && transaction) {
      try {
        await restorePackageTransaction(transaction, {
          ownerToken: proofOwner,
          target: canonicalBundle,
          identityPath,
          assertNoLiveHost: async () => {
            assertNoExactHost(canonicalBundle);
            assertNoPackagedRuntimeProcesses();
          },
        });
        transaction = null;
      } catch (error) {
        cleanupError ??= error;
      }
    } else if (transaction && !cleanupError) {
      cleanupError = new Error(
        "package proof stop or ownership guard did not complete; canonical bundle, identity, and transaction journal were left in place",
      );
    }

    if (safeToRestore && !transaction && runtimePrepared) {
      try {
        await removeProofRuntime();
        runtimePrepared = false;
      } catch (error) {
        cleanupError ??= error;
      }
    } else if (runtimePrepared && !cleanupError) {
      cleanupError = new Error("package proof runtime was left in place because the stop/ownership guard was not proven");
    }

    try {
      await verifyRestoration(previousBundleFingerprint, previousIdentity, defaultBefore, defaultAfter);
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!transaction && !runtimePrepared && stopSucceeded) {
    const result = {
      status: "passed",
      artifactDigest: validation.artifactDigest,
      candidateSnapshotDigest: manifest.candidateSnapshot.digest,
      bundlePath: canonicalBundle,
      ownerToken: proofOwner,
      launchBoundary: "LaunchServices open -g -a exact com.meetless.app bundle",
      host: { bundleIdentifier: installed.bundleIdentifier, cdHash: installed.cdHash },
      topology,
      readiness: {
        status: readiness.status.status,
        runtimeInstanceId: readiness.runtime.instanceId,
        pluginId: readiness.daemonPlugin.pluginId,
        pluginPid: readiness.daemonPlugin.pluginPid,
        pluginSource: readiness.daemonPlugin.sourcePath,
      },
      renderer: rendererProof,
      recovery: "transaction interruption and replacement recovery passed in isolated temp roots; canonical artifact restored byte-for-byte",
      defaultStoreUnchanged: true,
      defaultExportsUnchanged: true,
      isolatedProofStateUnchanged: true,
      ordinaryRuntimeRestarted: false,
      limits: [
        "ad-hoc local verification only",
        "no clean-install TCC acceptance claim",
        "no Developer ID, notarization, update publication, or distribution claim",
      ],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

async function readPackageHostConfiguration() {
  const configuration = JSON.parse(await readFile(path.join(candidateBundle, "Contents", "Resources", "host-config.json"), "utf8"));
  if (configuration.rendererOrigin !== MACOS_PACKAGE_RENDERER_ORIGIN) {
    throw new Error(`candidate host renderer origin is ${configuration.rendererOrigin}, expected ${MACOS_PACKAGE_RENDERER_ORIGIN}`);
  }
  if (configuration.runtimeRoot !== runtimeRoot || configuration.identityPath !== identityPath) {
    throw new Error("candidate host configuration is not bound to the accepted package runtime and identity paths");
  }
  if (!/^127\.0\.0\.1:\d+$/u.test(configuration.listen)) throw new Error(`candidate daemon listener is not loopback: ${configuration.listen}`);
  return configuration;
}

function packageEnvironment(configuration) {
  return {
    ...process.env,
    MEETLESS_RUNTIME_ROOT: configuration.runtimeRoot,
    MEETLESS_LISTEN: configuration.listen,
    MEETLESS_RENDERER_ORIGIN: configuration.rendererOrigin,
  };
}

async function exists(candidate) {
  return pathExists(candidate);
}

async function prepareProofRuntime() {
  if (await exists(runtimeRoot)) {
    const owner = await readFile(packageRuntimeOwnerPath, "utf8").then((value) => JSON.parse(value), () => null);
    if (!owner || owner.schema !== "MEETLESS_M7_PACKAGE_PROOF_RUNTIME_v1" || owner.ownerToken?.startsWith(proofOwnerPrefix) !== true) {
      throw new Error(`Refusing to remove unowned package proof runtime ${runtimeRoot}`);
    }
    assertNoPackagedRuntimeProcesses();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
  await mkdir(path.join(runtimeRoot, "meeting-store"), { recursive: true, mode: 0o700 });
  await writeFile(packageRuntimeOwnerPath, `${JSON.stringify({
    schema: "MEETLESS_M7_PACKAGE_PROOF_RUNTIME_v1",
    ownerToken: proofOwner,
    runtimeRoot,
    runId: proofRunId,
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(runtimeRoot, "meeting-store", "M7-proof-sentinel.txt"), "M7 isolated proof sentinel v1\n", { mode: 0o600 });
}

async function seedIsolatedProofState() {
  return readFile(path.join(runtimeRoot, "meeting-store", "M7-proof-sentinel.txt"));
}

async function removeProofRuntime() {
  if (!(await exists(runtimeRoot))) return;
  const owner = JSON.parse(await readFile(packageRuntimeOwnerPath, "utf8"));
  if (
    owner.schema !== "MEETLESS_M7_PACKAGE_PROOF_RUNTIME_v1" ||
    owner.ownerToken !== proofOwner ||
    owner.runtimeRoot !== runtimeRoot
  ) {
    throw new Error(`Refusing to remove unowned package proof runtime ${runtimeRoot}`);
  }
  assertNoExactHost(canonicalBundle);
  assertNoPackagedRuntimeProcesses();
  await rm(runtimeRoot, { recursive: true, force: true });
}

async function proveTransactionRecovery() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-m7-transaction-proof-"));
  try {
    const source = path.join(root, "source.app");
    const target = path.join(root, "Applications", "Meetless.app");
    const identityPath = path.join(root, "identity.json");
    await mkdir(path.join(source, "Contents"), { recursive: true });
    await writeFile(path.join(source, "Contents", "marker"), "candidate\n");
    await mkdir(path.join(target, "Contents"), { recursive: true });
    await writeFile(path.join(target, "Contents", "marker"), "prior\n");
    await writeFile(identityPath, "prior identity\n");
    const inspect = async (bundlePath) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath });
    const ownerToken = `${proofOwner}:isolated`;

    for (const state of ["staged", "target-backed-up", "candidate-installed", "identity-published", "committed"]) {
      const runId = newPackageTransactionId();
      let failed = false;
      try {
        await replacePackageBundle({ source, target, identityPath, ownerToken, runId, inspect, faultAt: state });
      } catch {
        failed = true;
      }
      if (!failed) throw new Error(`transaction fault injection did not interrupt at ${state}`);
      await recoverPackageTransaction(packageTransactionPaths(target, runId).journal, {
        ownerToken,
        target,
        identityPath,
      });
      await assertIsolatedPriorState(target, identityPath);
    }

    for (const state of ["restoring", "target-displaced", "target-restored", "identity-restored"]) {
      const transaction = await replacePackageBundle({
        source,
        target,
        identityPath,
        ownerToken,
        runId: newPackageTransactionId(),
        inspect,
      });
      let failed = false;
      try {
        await restorePackageTransaction(transaction, { ownerToken, target, identityPath, faultAt: state });
      } catch {
        failed = true;
      }
      if (!failed) throw new Error(`restore fault injection did not interrupt at ${state}`);
      await recoverPackageTransaction(transaction.paths.journal, { ownerToken, target, identityPath });
      await assertIsolatedPriorState(target, identityPath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertIsolatedPriorState(target, identityPath) {
  if (await readFile(path.join(target, "Contents", "marker"), "utf8") !== "prior\n") {
    throw new Error("isolated transaction recovery changed the prior artifact");
  }
  if (await readFile(identityPath, "utf8") !== "prior identity\n") {
    throw new Error("isolated transaction recovery changed the prior identity");
  }
}

async function recoverStaleProofTransactions() {
  const parent = path.dirname(canonicalBundle);
  const names = await readdir(parent).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  });
  const journals = names.filter((name) => /^\.Meetless\.app\.m7\..+\.transaction\.json$/u.test(name));
  for (const name of journals) {
    const journalPath = path.join(parent, name);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (path.resolve(journal.target) !== path.resolve(canonicalBundle) || path.resolve(journal.identityPath) !== path.resolve(identityPath)) {
      throw new Error(`Refusing to recover a transaction outside the fixed package paths: ${journalPath}`);
    }
    if (!journal.ownerToken?.startsWith(proofOwnerPrefix)) {
      throw new Error(`Refusing to recover an unowned package transaction: ${journalPath}`);
    }
    assertNoExactHost(canonicalBundle);
    await recoverPackageTransaction(journalPath, {
      ownerToken: journal.ownerToken,
      target: canonicalBundle,
      identityPath,
    });
  }
  const leftovers = (await readdir(parent)).filter((name) => name.startsWith(".Meetless.app.m7."));
  if (leftovers.length > 0) throw new Error(`Refusing to remove unowned package transaction artifacts: ${leftovers.join(", ")}`);
}

function assertNoActiveRecordingOrCapture() {
  const storePath = path.join(repositoryRoot, ".meetless-runtime", "meeting-store", "meetings.json");
  if (pathExists(storePath)) {
    let state;
    try { state = JSON.parse(readFileSync(storePath, "utf8")); } catch (error) {
      throw new Error(`Cannot inspect default MeetingStore safely: ${message(error)}`);
    }
    const active = (state.recordings ?? []).filter((recording) => recording.status === "recording" || recording.status === "finalizing");
    if (active.length > 0) throw new Error(`Default MeetingStore has active recording/finalizing state: ${active.map((recording) => recording.id).join(", ")}`);
  }
  const captures = processRows().filter((row) => row.command.split(/\s+/u).some((token) => token.endsWith("/meetless-capture")));
  if (captures.length > 0) throw new Error(`meetless-capture is already running: ${JSON.stringify(captures)}`);
}

function assertNoExactHost(bundle) {
  const matches = findExactHostPids(bundle);
  if (matches.length > 0) throw new Error(`exact MeetlessHost is already live at ${bundle}: ${matches.join(", ")}`);
}

function assertNoUnrelatedHost(bundle) {
  const executable = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  const unrelated = processRows().filter((row) => /(?:^|\s)(?:[^\s]*\/)?MeetlessHost(?:\s|$)/u.test(row.command) && row.command !== executable);
  if (unrelated.length > 0) throw new Error(`an unrelated MeetlessHost is live; no package proof stop is safe: ${JSON.stringify(unrelated)}`);
}

function findExactHostPids(bundle) {
  const executable = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  return processRows().filter((row) => row.command === executable).map((row) => row.pid);
}

function findPackagedRuntimeProcesses() {
  return processRows().filter((row) =>
    row.command.includes(canonicalPackageRoot) ||
    row.command.includes(canonicalBundle) ||
    row.command.includes(runtimeRoot),
  );
}

function assertNoPackagedRuntimeProcesses() {
  const live = findPackagedRuntimeProcesses();
  if (live.length > 0) throw new Error(`packaged processes remain after bounded stop: ${JSON.stringify(live)}`);
}

function assertPortAvailable(endpoint, label) {
  const port = endpointPort(endpoint);
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot inspect ${label} package proof port ${port}: ${result.error.message}`);
  if (result.status === 1 && result.stdout.trim() === "") return;
  if (result.status !== 0) throw new Error(`${label} package proof port ${port} inspection failed: ${result.stderr.trim()}`);
  if (result.stdout.trim()) throw new Error(`${label} package proof port ${port} is already in use:\n${result.stdout.trim()}`);
}

function assertPortsReleased(...endpoints) {
  for (const endpoint of endpoints) assertPortAvailable(endpoint, "released");
}

function endpointPort(endpoint) {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    const port = Number(new URL(endpoint).port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid package endpoint ${endpoint}`);
    return port;
  }
  const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid package listener ${endpoint}`);
  return port;
}

async function waitForPackagedTopology(hostExecutable, packageNode) {
  const nodePath = path.resolve(packageNode);
  const cliPath = path.join(canonicalPackageRoot, "packages/runtime/dist/cli.js");
  const electronPath = path.join(canonicalPackageRoot, "runtime/electron/Electron.app/Contents/MacOS/Electron");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = processRows();
    const host = rows.find((row) => row.ppid === 1 && row.command === hostExecutable);
    const desktop = host && rows.find((row) => row.ppid === host.pid && row.command.includes(`${cliPath} desktop`));
    const electron = desktop && rows.find((row) => row.ppid === desktop.pid && row.command.includes("electron-bootstrap.mjs"));
    if (host && desktop && electron) {
      const [desktopExecutable, electronExecutable] = [executablePath(desktop.pid), executablePath(electron.pid)];
      if (path.resolve(desktopExecutable) !== nodePath) throw new Error(`packaged desktop executable is ${desktopExecutable}`);
      if (path.resolve(electronExecutable) !== path.resolve(electronPath)) throw new Error(`packaged Electron executable is ${electronExecutable}`);
      return { hostPid: host.pid, desktopPid: desktop.pid, electronPid: electron.pid, nodePath, cliPath, electronPath };
    }
    await delay(100);
  }
  throw new Error("LaunchServices did not produce the exact packaged host → desktop → Electron topology");
}

async function waitForRenderer(origin, expected) {
  const deadline = Date.now() + 15_000;
  let lastStatus = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`);
      lastStatus = String(response.status);
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer());
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (body.byteLength !== expected.size || sha256 !== expected.sha256) {
          throw new Error(`served renderer bytes differ from manifest entry ${expected.entry}`);
        }
        return { origin, status: response.status, bytes: body.byteLength, sha256, entry: expected.entry };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("served renderer bytes")) throw error;
    }
    await delay(100);
  }
  throw new Error(`packaged renderer did not answer ${origin} (last status ${lastStatus})`);
}

async function verifyRestoration(previousBundleFingerprint, previousIdentity, defaultBefore, defaultAfter) {
  if (await fingerprintPath(canonicalBundle) !== previousBundleFingerprint) {
    throw new Error("canonical Meetless.app was not restored byte-for-byte after package proof");
  }
  const identity = await readBytes(identityPath);
  if (previousIdentity === null ? identity !== null : !identity?.equals(previousIdentity)) {
    throw new Error("canonical host identity was not restored byte-for-byte after package proof");
  }
  if (defaultAfter) assertSnapshotsEqual(defaultBefore, defaultAfter, "default MeetingStore chunks or export files");
}

async function snapshotPaths(paths) {
  const result = {};
  for (const candidate of paths) result[candidate] = await fingerprintPath(candidate);
  return result;
}

function assertSnapshotsEqual(expected, actual, label) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label} changed during package proof`);
}

function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function executablePath(pid) {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect executable for PID ${pid}`);
  const lines = result.stdout.split("\n");
  const index = lines.indexOf("ftxt");
  const value = index >= 0 ? lines[index + 1] : null;
  if (!value?.startsWith("n/")) throw new Error(`lsof did not report executable for PID ${pid}`);
  return value.slice(1);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
