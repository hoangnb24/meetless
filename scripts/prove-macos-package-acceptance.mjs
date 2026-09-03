import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync as pathExistsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";
import { connectMeetlessClient } from "@meetless/client";
import { RecordingControlResponseSchema, RecordingStatusEventSchema } from "@meetless/meeting-contracts";
import { RecordingRuntimeReadinessResponseSchema } from "@meetless/plugin/readiness-protocol";
import {
  compareManifestEntrySets,
  digestManifest,
  validateAcceptanceEvidenceBinding,
  validateMacOSPackage,
  validateManifestDocument,
} from "./validate-macos-package.mjs";
import { enumeratePackageEntries, inspectPackageMachOEntries } from "./lib/macos-package-inventory.mjs";
import { citationIdentity, validateBoundedPlaybackObservation } from "./lib/macos-playback-proof.mjs";
import {
  fingerprintPath,
  newPackageTransactionId,
  packageTransactionPaths,
  readBytes,
  recoverPackageTransaction,
  replacePackageBundle,
  restorePackageTransaction,
} from "./lib/macos-package-transaction.mjs";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import { acceptedMacOSPackagePaths } from "./lib/macos-package-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.argv[2] ?? path.join(repositoryRoot, "release/macos/composition-manifest.json"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const releaseRoot = path.dirname(manifestPath);
const candidateBundle = path.resolve(releaseRoot, manifest.bundlePath);
// Direct-DMG proof authority only. This runner uses acceptedMacOSPackagePaths()
// and never claims to preserve the app-container MAS runtime root.
const packagePaths = acceptedMacOSPackagePaths();
const canonicalBundle = packagePaths.canonicalBundlePath;
const canonicalPackageRoot = path.join(canonicalBundle, "Contents", "Resources", "meetless");
const runtimeRoot = packagePaths.runtimeRoot;
const identityPath = packagePaths.identityPath;
const exportLeaseParent = "/private/tmp/meetless-package-proof-exports";
const proofLockPath = "/private/tmp/meetless-m7-package-acceptance.lock";
const proofLockMarker = "MEETLESS_M7_PACKAGE_ACCEPTANCE_LOCK_HELD";
const proofOwnerPrefix = "MEETLESS_M7_PACKAGE_ACCEPTANCE_v1:";
const proofRunId = `m7-f3-${Date.now()}-${randomUUID().slice(0, 8)}`;
const proofOwner = `${proofOwnerPrefix}${proofRunId}`;
const packageRuntimeOwnerPath = path.join(runtimeRoot, "package-acceptance-owner.json");
const evidencePath = path.join(repositoryRoot, "test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json");
let packageLaunchAttempted = false;

const lockHeld = await acquireProofLock();
if (lockHeld) await main();

async function acquireProofLock() {
  if (process.env[proofLockMarker] === proofLockPath) {
    await writeFile(
      proofLockPath,
      `${JSON.stringify({ role: "package-acceptance", runId: proofRunId, ownerToken: proofOwner, pid: process.pid })}\n`,
      { mode: 0o600 },
    );
    return true;
  }
  const locked = spawnSync("/usr/bin/lockf", [
    "-t", "0", "-k", proofLockPath, process.execPath, ...process.argv.slice(1),
  ], {
    stdio: "inherit",
    env: { ...process.env, [proofLockMarker]: proofLockPath },
  });
  if (locked.error) throw locked.error;
  if (locked.status === 75) throw new Error(`package acceptance lock is held at ${proofLockPath}`);
  if (locked.status !== 0) process.exit(locked.status ?? 1);
  return false;
}

async function main() {
  assertDarwinArm64();
  assertNoActiveRecordingOrCapture();
  assertNoExactHost(canonicalBundle);
  assertNoUnrelatedHost(canonicalBundle);
  await recoverStaleProofTransactions();

  // This is the only source-side validation. It completes before the canonical
  // bundle is changed. Every runtime operation below comes from the installed
  // package root.
  const validation = await validateMacOSPackage(manifestPath, {
    repositoryRoot,
    signingMode: "local-ad-hoc",
    signingIdentity: "-",
  });
  validateManifestDocument(manifest);
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
  let runtimePrepared = false;
  let stopSucceeded = false;
  let externalRoot = null;
  let lease1 = null;
  let lease2 = null;
  let lease3 = null;
  let packagedModules = null;
  let generation1 = null;
  let generation2 = null;
  let installed = null;
  let topology = [];
  let lifecycle = null;
  let primaryError = null;
  let cleanupError = null;
  let defaultAfter = null;

  try {
    await prepareProofRuntime();
    runtimePrepared = true;

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
    if (installed.bundleIdentifier !== "com.meetless.app") throw new Error("installed package identity is not com.meetless.app");
    if (installed.configuration.rendererOrigin !== packageConfiguration.rendererOrigin) {
      throw new Error("installed host renderer origin differs from the candidate configuration");
    }

    const packaged = await importPackagedModules();
    packagedModules = packaged;
    lease1 = await packaged.envelope.createUiTestExportLease({
      proofSessionId: proofRunId,
      restartGeneration: 1,
      runtimeRoot,
      repositoryRoot: canonicalPackageRoot,
    });
    externalRoot = lease1.exportRoot;
    generation1 = await runGeneration({
      generation: 1,
      lease: lease1,
      packaged,
      installed,
      packageConfiguration,
      launch: true,
    });
    topology.push(generation1.topology);
    lifecycle = generation1.lifecycle;

    await stopPackagedHost(packageConfiguration);
    stopSucceeded = true;
    await assertStoppedPackage(packageConfiguration, packaged, lease1.exportRoot, generation1.snapshot);
    await closeGeneration(generation1);

    lease2 = await packaged.envelope.createUiTestExportLease({
      proofSessionId: proofRunId,
      restartGeneration: 2,
      runtimeRoot,
      repositoryRoot: canonicalPackageRoot,
      exportRoot: lease1.exportRoot,
      allowExistingRoot: true,
    });
    generation2 = await runGeneration({
      generation: 2,
      lease: lease2,
      packaged,
      installed,
      packageConfiguration,
      launch: true,
      prior: generation1,
    });
    topology.push(generation2.topology);
    lifecycle = { generation1: generation1.lifecycle, generation2: generation2.lifecycle };

    await closeGeneration(generation2);
    await stopPackagedHost(packageConfiguration);
    stopSucceeded = true;
    await assertStoppedPackage(packageConfiguration, packaged, lease2.exportRoot, generation2.snapshot);

    // The runner advances to a short-lived cleanup lease. This keeps deletion
    // fail-closed: only an expired, exact-session lease may remove the root.
    lease3 = await packaged.envelope.createUiTestExportLease({
      proofSessionId: proofRunId,
      restartGeneration: 3,
      runtimeRoot,
      repositoryRoot: canonicalPackageRoot,
      exportRoot: lease2.exportRoot,
      allowExistingRoot: true,
      ttlMs: 1,
    });
    await delay(25);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (packageLaunchAttempted || findExactHostPids(canonicalBundle).length > 0 || findPackagedRuntimeProcesses().length > 0) {
        await stopPackagedHost(packageConfiguration);
        stopSucceeded = true;
      }
      assertNoExactHost(canonicalBundle);
      assertNoPackagedRuntimeProcesses();
      assertPortsReleased(packageConfiguration.listen, packageConfiguration.rendererOrigin);
    } catch (error) {
      cleanupError ??= error;
    }

    const safeToRestore = stopSucceeded && findExactHostPids(canonicalBundle).length === 0 &&
      findPackagedRuntimeProcesses().length === 0;
    if (safeToRestore && externalRoot && !lease3 && lease1 && packagedModules) {
      try {
        lease3 = await packagedModules.envelope.createUiTestExportLease({
          proofSessionId: proofRunId,
          restartGeneration: lease1.restartGeneration + 1,
          runtimeRoot,
          repositoryRoot: canonicalPackageRoot,
          exportRoot: externalRoot,
          allowExistingRoot: true,
          ttlMs: 1,
        });
        await delay(25);
      } catch (error) {
        cleanupError ??= error;
      }
    }
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
      cleanupError = new Error("package acceptance could not prove a safe canonical restore");
    }

    if (safeToRestore && !transaction && runtimePrepared) {
      try {
        await removeProofRuntime(externalRoot);
        runtimePrepared = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }

    if (!runtimePrepared && externalRoot) {
      try {
        await removeExternalExportRoot(externalRoot, proofRunId, lease3);
        externalRoot = null;
      } catch (error) {
        cleanupError ??= error;
      }
    }

    try {
      defaultAfter = await snapshotPaths(defaultPaths);
      await verifyRestoration(previousBundleFingerprint, previousIdentity, defaultBefore, defaultAfter);
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (transaction || runtimePrepared || externalRoot || !stopSucceeded) {
    throw new Error("package acceptance cleanup left owned state or did not prove bounded stop");
  }

  const evidence = buildEvidence({
    validation,
    installed,
    packageConfiguration,
    lease1,
    lease2,
    lease3,
    generation1,
    generation2,
    topology,
    lifecycle,
    defaultBefore,
    defaultAfter,
  });
  validateEvidenceManifest(evidence);
  const evidenceSha256 = await publishEvidence(evidence);
  process.stdout.write(`${JSON.stringify({ status: "passed", evidencePath: path.relative(repositoryRoot, evidencePath), evidenceSha256 }, null, 2)}\n`);
}

async function publishEvidence(evidence) {
  await mkdir(path.dirname(evidencePath), { recursive: true, mode: 0o755 });
  const temporaryPath = `${evidencePath}.${proofRunId}-${randomUUID()}.tmp`;
  try {
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, evidencePath);
    const finalBytes = await readFile(evidencePath);
    const published = JSON.parse(finalBytes.toString("utf8"));
    validateEvidenceManifest(published);
    validateAcceptanceEvidenceBinding(published, manifest);
    return sha256(finalBytes);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function importPackagedModules() {
  const fromPackage = (relative) => import(pathToFileURL(path.join(canonicalPackageRoot, relative)).href);
  const [envelope, config, readiness, host, store, client] = await Promise.all([
    fromPackage("packages/runtime/dist/ui-test-envelope.js"),
    fromPackage("packages/runtime/dist/config.js"),
    fromPackage("packages/runtime/dist/readiness.js"),
    fromPackage("packages/runtime/dist/host.js"),
    fromPackage("packages/meeting-store/dist/index.js"),
    fromPackage("packages/meetless-client/dist/index.js"),
  ]);
  return { envelope, config, readiness, host, store, client };
}

async function runGeneration(input) {
  const { generation, lease, packaged, installed, packageConfiguration } = input;
  const cdpPort = await reservePort();
  const envelope = packaged.envelope.newUiTestEnvelope({
    runId: `${proofRunId}-g${generation}`,
    cdpPort,
    transcriptionMode: "fake",
    forceAccessibility: false,
    exportLease: lease,
  });
  await packaged.envelope.writeUiTestEnvelope(runtimeRoot, envelope);
  const packageNode = path.join(canonicalPackageRoot, "runtime/node");
  const launchScript = path.join(canonicalPackageRoot, "scripts/launch-macos-host.mjs");
  const stopScript = path.join(canonicalPackageRoot, "scripts/stop-macos-host.mjs");
  let browser = null;
  let socket = null;
  let connectedClient = null;
  try {
    packageLaunchAttempted = true;
    await execFileAsync(packageNode, [launchScript], {
      cwd: canonicalPackageRoot,
      env: packageEnvironment(packageConfiguration),
      maxBuffer: 8 * 1024 * 1024,
    });
    const marker = await waitForMarker(packaged.envelope, envelope.runId);
    const config = packaged.config.resolveRuntimeConfig({
      repositoryRoot: canonicalPackageRoot,
      runtimeRoot,
      listen: packageConfiguration.listen,
      rendererOrigin: packageConfiguration.rendererOrigin,
      environment: packageEnvironment(packageConfiguration),
    });
    const liveIdentity = await packaged.host.assertInstalledHostIdentity(config);
    if (liveIdentity.cdHash !== installed.cdHash || liveIdentity.bundleRealPath !== installed.bundleRealPath) {
      throw new Error("packaged runtime observed a host identity different from the installed candidate");
    }
    const activated = await packaged.envelope.activateUiTestRun(config);
    if (!activated || activated.restartGeneration !== generation || activated.exportRoot !== lease.exportRoot) {
      throw new Error(`generation ${generation} did not consume the exact lease envelope`);
    }
    if (path.resolve(config.paths.recordingExports) !== path.resolve(lease.exportRoot)) {
      throw new Error(`generation ${generation} config export root is not the leased external root`);
    }
    const topology = await waitForPackagedTopology(installed.executablePath, packageNode);
    const renderer = await waitForRenderer(packageConfiguration.rendererOrigin, manifest.renderer);
    const browserEndpoint = `http://${envelope.cdpAddress}:${envelope.cdpPort}`;
    browser = await connectOverCdp(browserEndpoint, envelope.runId, packageConfiguration.rendererOrigin);
    const page = await findExactRendererPage(browser, envelope.runId, packageConfiguration.rendererOrigin);
    const electronPid = await endpointPid(envelope.cdpPort);
    const ancestry = exactAncestry(electronPid, marker.identity.hostPid, marker.identity.desktopPid, installed, expectedElectronExecutable());
    const pageMarker = rendererMarker(page.url());
    if (!pageMarker || pageMarker.runId !== envelope.runId || pageMarker.logicalDesktopId !== "com.meetless.desktop") {
      throw new Error("packaged renderer marker does not match the consumed envelope");
    }

    socket = await openRecordingSocket(config.paths.recordingSocket);
    const initialReadiness = await socket.requestReadiness("status");
    if (
      initialReadiness.runtime.capture.mode !== "fixture" ||
      initialReadiness.runtime.export.root !== lease.exportRoot ||
      initialReadiness.runtime.uiTest?.runId !== marker.runId
    ) throw new Error(`generation ${generation} readiness does not bind fixture, lease root, and run identity`);
    const startup = await packaged.readiness.waitForRecordingRuntime(config, {
      timeoutMs: 60_000,
    });
    const mediaClosure = await readMediaSnapshotEvidence();
    if (generation === 2 && input.prior && mediaClosure.snapshotFingerprint !== input.prior.snapshot.mediaClosure.snapshotFingerprint) {
      throw new Error("generation 2 did not reuse the identical packaged media snapshot");
    }
    const bridge = await readBridgeStatus(page, config);
    if (bridge.platform !== "darwin" || bridge.status !== "running" || bridge.listen !== config.listen || bridge.home !== config.paths.paseoHome) {
      throw new Error(`packaged renderer bridge is not the exact isolated runtime: ${JSON.stringify(bridge)}`);
    }

    const snapshot = generation === 1
      ? await recordAndTranscribe({ page, socket, clientModule: input.packaged.client, storeModule: input.packaged.store, config, lease, marker, startup })
      : await reopenAndVerify({ page, socket, clientModule: input.packaged.client, storeModule: input.packaged.store, config, lease, marker, prior: input.prior, startup });
    connectedClient = snapshot.clientConnection;
    return {
      generation,
      envelope,
      marker,
      topology: {
        generation,
        hostPid: topology.hostPid,
        desktopPid: topology.desktopPid,
        electronPid,
        ancestry: ancestry.ancestry,
        nodePath: topology.nodePath,
        electronExecutable: ancestry.electronExecutable,
      },
      renderer,
      readiness: {
        runtimeInstanceId: startup.runtime.instanceId,
        pluginPid: startup.runtime.pluginPid,
        pluginSource: startup.daemonPlugin.sourcePath,
        exportRoot: startup.runtime.export.root,
        captureMode: startup.runtime.capture.mode,
      },
      lifecycle: snapshot.lifecycle,
      snapshot: { ...snapshot.snapshot, mediaClosure },
      clientConnection: connectedClient,
      page,
      browser,
      socket,
      packageNode,
      stopScript,
    };
  } catch (error) {
    if (connectedClient) await connectedClient.close().catch(() => undefined);
    if (socket) await socket.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    throw error;
  }
}

async function recordAndTranscribe(input) {
  const { page, socket, clientModule, storeModule, config, lease, marker, startup } = input;
  const title = page.locator('[data-testid="recording-setup-title"]');
  const start = page.locator('[data-testid="recording-start"]');
  await waitForVisible(page.locator('[data-testid="connection-status"]'), 30_000);
  const recordEntry = page.locator('[data-testid="record-meeting-entry"]');
  const emptyRecordEntry = page.locator('[data-testid="empty-record-meeting"]');
  if (await recordEntry.isVisible()) await recordEntry.click();
  else if (await emptyRecordEntry.isVisible()) await emptyRecordEntry.click();
  await waitForVisible(title, 10_000);
  try {
    await waitFor(() => start.isVisible(), "packaged recording start control", 30_000);
  } catch (error) {
    const diagnostics = await page.locator("[data-testid]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")).filter(Boolean));
    throw new Error(`${describe(error)}; renderer=${page.url()}; visibleTestIds=${JSON.stringify(diagnostics)}`);
  }
  await title.fill(`M7 controlled fixture ${proofRunId}`);
  await start.click();
  const stop = page.locator('[data-testid="recording-stop"]');
  await waitFor(() => stop.isVisible(), "packaged recording stop control", 20_000);
  const recordingStatus = await socket.waitForStatus(
    (status) => status.status === "recording",
    20_000,
    "fixture recording status",
  );
  if (!recordingStatus.status.recordingId || !recordingStatus.status.meetingId) throw new Error("fixture recording has no meeting or recording identity");
  const recordingId = recordingStatus.status.recordingId;
  const meetingId = recordingStatus.status.meetingId;
  const chunks = await waitForChunks(config, socket, recordingId);
  if (chunks.identities.some((chunk) => chunk.source !== "microphone" && chunk.source !== "system")) {
    throw new Error("fixture chunk evidence has an unknown source label");
  }
  const prepared = await socket.requestReadiness("prepareCollision");
  if (!prepared.collision || prepared.collision.exportRoot !== lease.exportRoot) {
    throw new Error("collision evidence is not bound to the external lease root");
  }
  const collisionBefore = await fileIdentity(prepared.collision.path);
  if (collisionBefore.byteLength !== prepared.collision.byteLength || collisionBefore.sha256 !== prepared.collision.sha256) {
    throw new Error("pre-existing collision target identity does not match readiness");
  }

  await stop.click();
  let postStop;
  try {
    postStop = await socket.waitForStatus(
      (status) => status.status === "saved" && status.recordingId === recordingId,
      60_000,
      "fixture saved status",
    );
  } catch (error) {
    const hostLogPath = path.join(runtimeRoot, "logs", "host-runtime.log");
    const hostLog = await execFileAsync("/usr/bin/strings", ["-n", "3", hostLogPath], { encoding: "utf8", maxBuffer: 64 * 1024 })
      .then(({ stdout }) => stdout.split("\n")
        .filter((line) => /meetless|ffmpeg|final|capture|error|failed/iu.test(line))
        .slice(-40)
        .join("\n")
        .slice(-8_000)
        .replaceAll(/[^\x20-\x7e\n]/gu, "?"), () => "unavailable");
    throw new Error(`${describe(error)}; hostLogTail=${JSON.stringify(hostLog)}`);
  }
  await waitFor(() => stop.isVisible().then((visible) => !visible), "packaged saved recording state", 30_000);

  const store = new storeModule.MeetingStore({ root: config.paths.meetingStore });
  const saved = await readSavedStore(store, meetingId, recordingId);
  const output = saved.recording.savedOutput;
  if (!output || !pathInside(output.destination, lease.exportRoot)) throw new Error("saved MP3 is outside the leased external root");
  if (path.resolve(output.destination) === path.resolve(prepared.collision.path)) {
    throw new Error("saved MP3 path is the pre-existing collision target");
  }
  if (path.resolve(output.destination) !== path.resolve(prepared.collision.plannedPublishedPath)) {
    throw new Error("saved MP3 path does not match the prepared collision-safe destination");
  }
  const mp3 = await fileIdentity(output.destination);
  if (mp3.byteLength !== output.byteLength || mp3.sha256 !== output.sha256) throw new Error("saved MP3 identity changed");
  const media = await analyzeMp3(config.environment.MEETLESS_FFPROBE, output.destination);
  const collisionAfter = await fileIdentity(prepared.collision.path);
  if (collisionAfter.byteLength !== collisionBefore.byteLength || collisionAfter.sha256 !== collisionBefore.sha256) {
    throw new Error("pre-existing collision target changed during finalization");
  }

  await page.locator('[data-testid="meeting-refresh-button"]').click();
  const meetingRow = page.locator(`[data-testid="meeting-${meetingId}"]`);
  await waitFor(() => meetingRow.isVisible(), "saved meeting row", 30_000);
  await meetingRow.click();
  const consent = page.locator('[data-testid="transcription-consent"]');
  await waitFor(() => consent.isVisible(), "controlled transcription consent", 30_000);
  await consent.click();
  await waitFor(async () => {
    const current = await store.getTranscriptForMeeting(meetingId);
    return current?.status === "ready" ? current : null;
  }, "fake transcript publication", 60_000);
  await page.locator('[data-testid="meeting-refresh-button"]').click();
  await meetingRow.click();
  await waitFor(() => page.locator('[data-testid="transcript-ready"]').isVisible(), "ready transcript surface", 30_000);

  const clientConnection = await clientModule.connectMeetlessClient({
    url: `ws://${config.listen}/ws`,
    clientId: `${proofRunId}-g1-client`,
    clientType: "browser",
  });
  const rpcTranscript = await clientConnection.client.getMeetingTranscript(meetingId);
  const transcript = await assertTranscript(store, rpcTranscript, meetingId, recordingId, output);
  const citation = await clientConnection.client.resolveCitation({ meetingId, segmentId: transcript.segments[0].segmentId });
  assertCitation(citation, transcript.segments[0], output);
  await expectRejected(
    () => clientConnection.client.resolveCitation({ meetingId, segmentId: `${transcript.segments[0].segmentId}-unknown` }),
    "unknown citation segment",
  );
  await installAudioObserver(page, citation);
  await page.locator(`[data-testid="citation-${transcript.segments[0].segmentId}"]`).click();
  const playback = await waitForPlayback(page, citation);
  const audioBytes = Buffer.from(playback.source.slice(playback.source.indexOf(",") + 1), "base64");
  if (sha256(audioBytes) !== sha256(Buffer.from(citation.audio.base64, "base64"))) throw new Error("browser playback bytes differ from the citation response");
  const chat = await clientConnection.client.getMeetingChat(meetingId);
  if (chat !== null) throw new Error("controlled lifecycle unexpectedly created an external chat thread");
  const storeFile = await fileIdentity(store.filePath);
  return {
    clientConnection,
    lifecycle: {
      fixtureRecording: true,
      stopCommand: "Electron recording control: stop",
      stopStatus: postStop.status.status,
      sourceLabels: [...new Set(chunks.identities.map((chunk) => chunk.source))].sort(),
      fakeTranscription: true,
      chatState: "empty-controlled-run",
    },
    snapshot: {
      session: {
        proofSessionId: lease.proofSessionId,
        restartGeneration: lease.restartGeneration,
        runId: marker.runId,
        exportRoot: lease.exportRoot,
        runtimeInstanceId: startup.runtime.instanceId,
      },
      meetingId,
      recordingId,
      output: { path: relativeEvidencePath(output.destination, lease.exportRoot), ...mp3 },
      media,
      collision: {
        path: relativeEvidencePath(prepared.collision.path, lease.exportRoot),
        plannedPublishedPath: relativeEvidencePath(prepared.collision.plannedPublishedPath, lease.exportRoot),
        byteLength: collisionBefore.byteLength,
        sha256: collisionBefore.sha256,
        distinctOutputName: path.resolve(output.destination) !== path.resolve(prepared.collision.path),
      },
      chunks,
      transcript,
      citation: citationSummary(citation),
      playback: playbackSummary(playback, audioBytes),
      chat: null,
      store: { path: "meeting-store/meetings.json", ...storeFile },
    },
  };
}

async function reopenAndVerify(input) {
  const { page, socket, clientModule, storeModule, config, lease, marker, prior } = input;
  const store = new storeModule.MeetingStore({ root: config.paths.meetingStore });
  const recordings = await store.listRecordings();
  const recording = recordings.find((candidate) => candidate.id === prior.snapshot.recordingId);
  if (!recording || recording.status !== "saved" || !recording.savedOutput) throw new Error("generation 2 did not reopen the saved recording");
  const output = recording.savedOutput;
  const outputIdentity = await fileIdentity(output.destination);
  if (outputIdentity.sha256 !== prior.snapshot.output.sha256 || outputIdentity.byteLength !== prior.snapshot.output.byteLength) {
    throw new Error("generation 2 MP3 identity differs from generation 1");
  }
  const clientConnection = await clientModule.connectMeetlessClient({
    url: `ws://${config.listen}/ws`,
    clientId: `${proofRunId}-g2-client`,
    clientType: "browser",
  });
  const rpcTranscript = await clientConnection.client.getMeetingTranscript(prior.snapshot.meetingId);
  const transcript = await assertTranscript(store, rpcTranscript, prior.snapshot.meetingId, prior.snapshot.recordingId, output);
  if (transcript.fullTranscriptSha256 !== prior.snapshot.transcript.fullTranscriptSha256) throw new Error("generation 2 transcript changed");
  const citation = await clientConnection.client.resolveCitation({ meetingId: prior.snapshot.meetingId, segmentId: transcript.segments[0].segmentId });
  assertCitation(citation, transcript.segments[0], output);
  if (citation.startMs !== prior.snapshot.citation.startMs || citation.endMs !== prior.snapshot.citation.endMs) throw new Error("generation 2 citation range changed");
  await expectRejected(
    () => clientConnection.client.resolveCitation({ meetingId: prior.snapshot.meetingId, segmentId: `${transcript.segments[0].segmentId}-unknown` }),
    "generation 2 unknown citation segment",
  );
  await page.locator('[data-testid="meeting-refresh-button"]').click();
  const meetingRow = page.locator(`[data-testid="meeting-${prior.snapshot.meetingId}"]`);
  await waitFor(() => meetingRow.isVisible(), "generation 2 meeting row", 30_000);
  await meetingRow.click();
  await waitFor(() => page.locator('[data-testid="transcript-ready"]').isVisible(), "generation 2 transcript surface", 30_000);
  await installAudioObserver(page, citation);
  await page.locator(`[data-testid="citation-${transcript.segments[0].segmentId}"]`).click();
  const playback = await waitForPlayback(page, citation);
  const audioBytes = Buffer.from(playback.source.slice(playback.source.indexOf(",") + 1), "base64");
  if (sha256(audioBytes) !== sha256(Buffer.from(citation.audio.base64, "base64"))) throw new Error("generation 2 playback bytes differ from citation");
  const chat = await clientConnection.client.getMeetingChat(prior.snapshot.meetingId);
  if (chat !== null) throw new Error("generation 2 changed the empty controlled chat state");
  const storeFile = await fileIdentity(store.filePath);
  return {
    clientConnection,
    lifecycle: {
      reopenedMeeting: true,
      sameMeetingId: prior.snapshot.meetingId,
      sameRecordingId: prior.snapshot.recordingId,
      sameMp3: true,
      transcriptPreserved: true,
      chatStatePreserved: true,
      citationPreserved: true,
      playbackReboundToSameMp3: true,
    },
    snapshot: {
      session: {
        proofSessionId: lease.proofSessionId,
        restartGeneration: lease.restartGeneration,
        runId: marker.runId,
        exportRoot: lease.exportRoot,
        runtimeInstanceId: input.startup?.runtime?.instanceId ?? "observed-by-envelope",
      },
      meetingId: prior.snapshot.meetingId,
      recordingId: prior.snapshot.recordingId,
      output: { path: relativeEvidencePath(output.destination, lease.exportRoot), ...outputIdentity },
      transcript,
      citation: citationSummary(citation),
      playback: playbackSummary(playback, audioBytes),
      chat: null,
      store: { path: "meeting-store/meetings.json", ...storeFile },
    },
  };
}

async function closeGeneration(generation) {
  if (!generation) return;
  if (generation.clientConnection) await generation.clientConnection.close().catch(() => undefined);
  if (generation.socket) await generation.socket.close().catch(() => undefined);
  if (generation.browser) await generation.browser.close().catch(() => undefined);
}

async function stopPackagedHost(configuration) {
  const packageNode = path.join(canonicalPackageRoot, "runtime/node");
  const stopScript = path.join(canonicalPackageRoot, "scripts/stop-macos-host.mjs");
  if (findExactHostPids(canonicalBundle).length === 0) return;
  await execFileAsync(packageNode, [stopScript], {
    cwd: canonicalPackageRoot,
    env: packageEnvironment(configuration),
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function assertStoppedPackage(configuration, packaged, expectedExportRoot, snapshot) {
  assertNoExactHost(canonicalBundle);
  assertNoPackagedRuntimeProcesses();
  assertPortsReleased(configuration.listen, configuration.rendererOrigin);
  if (await pathExists(path.join(runtimeRoot, "ui-test-envelope.json")) || await pathExists(path.join(runtimeRoot, "ui-test-run.json"))) {
    throw new Error("exact host shutdown left reusable controlled envelope state");
  }
  if (!await pathExists(expectedExportRoot)) throw new Error("exact host shutdown removed the leased external root");
  const output = path.join(expectedExportRoot, snapshot.output.path);
  const current = await fileIdentity(output);
  if (current.byteLength !== snapshot.output.byteLength || current.sha256 !== snapshot.output.sha256) {
    throw new Error("exact host shutdown changed the external MP3 identity");
  }
  const marker = await packaged.envelope.readConsumedUiTestMarker(runtimeRoot);
  if (marker !== null) throw new Error("exact host shutdown left a consumed marker");
}

async function readMediaSnapshotEvidence() {
  const targetRoot = path.join(runtimeRoot, "media-tools");
  const manifestPath = path.join(targetRoot, "media-tools.snapshot.json");
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`packaged runtime media snapshot manifest is unavailable: ${describe(error)}`);
  }
  if (
    snapshot?.schema !== "MEETLESS_PACKAGED_MEDIA_CLOSURE v1" ||
    snapshot.runtimeRoot !== runtimeRoot ||
    snapshot.targetRoot !== targetRoot ||
    !/^[a-f0-9]{64}$/u.test(snapshot.sourceFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/u.test(snapshot.snapshotFingerprint ?? "") ||
    snapshot.sourceFingerprint !== snapshot.snapshotFingerprint ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length === 0
  ) {
    throw new Error("packaged runtime media snapshot manifest is not an exact complete closure");
  }
  for (const relative of ["bin/ffmpeg", "bin/ffprobe"]) {
    const toolPath = path.join(targetRoot, relative);
    const tool = await stat(toolPath).catch(() => null);
    if (!tool?.isFile() || tool.size <= 0) throw new Error(`packaged runtime media snapshot tool is unavailable: ${relative}`);
  }
  return {
    schema: snapshot.schema,
    sourceFingerprint: snapshot.sourceFingerprint,
    snapshotFingerprint: snapshot.snapshotFingerprint,
    entryCount: snapshot.entries.length,
    targetRoot: "media-tools",
    sourceRoot: "<installed-package-root>/runtime/media",
    tools: { ffmpeg: "media-tools/bin/ffmpeg", ffprobe: "media-tools/bin/ffprobe" },
    atomicDirectoryUnit: true,
  };
}

async function assertTranscript(store, rpcResult, meetingId, recordingId, output) {
  const durable = await store.getTranscriptForMeeting(meetingId);
  if (!durable || durable.status !== "ready" || durable.recordingId !== recordingId) throw new Error("durable transcript is not ready for the saved recording");
  if (!rpcResult.transcript || rpcResult.transcript.status !== "ready" || rpcResult.transcript.recordingId !== recordingId) {
    throw new Error("packaged transcript RPC did not return the ready transcript");
  }
  if (rpcResult.consent.status !== "granted") throw new Error("transcript RPC did not observe granted controlled consent");
  const segments = rpcResult.transcript.segments.map((segment, index) => ({
    meetingId,
    recordingId,
    ordinal: segment.range.ordinal,
    startMs: segment.range.startMs,
    endMs: segment.range.endMs,
    segmentId: segment.range.segmentId,
    segmentDigest: sha256(Buffer.from(segment.text)),
    segmentCharCount: segment.text.length,
    ordered: segment.range.ordinal === index,
  }));
  if (segments.length === 0 || segments.some((segment) => !segment.ordered || segment.endMs <= segment.startMs || segment.segmentCharCount === 0)) {
    throw new Error("fake transcription did not yield ordered non-empty timestamped segments");
  }
  if (durable.audio.destination !== output.destination || durable.audio.sha256 !== output.sha256 || durable.audio.byteLength !== output.byteLength) {
    throw new Error("durable and RPC transcript audio identities differ from the saved MP3");
  }
  const fullTranscript = rpcResult.transcript.segments.map((segment) => segment.text).join("\n");
  return {
    status: "ready",
    meetingId,
    recordingId,
    segmentCount: segments.length,
    segments,
    fullTranscriptSha256: sha256(Buffer.from(fullTranscript)),
    audio: { byteLength: output.byteLength, sha256: output.sha256 },
  };
}

function assertCitation(citation, segment, output) {
  if (
    citation.meetingId !== segment.meetingId ||
    citation.segmentId !== segment.segmentId ||
    citation.recordingId !== segment.recordingId ||
    citation.startMs !== segment.startMs ||
    citation.endMs !== segment.endMs ||
    citation.endMs <= citation.startMs ||
    citation.audio.mimeType !== "audio/mpeg"
  ) throw new Error("known citation does not resolve to the expected transcript range");
  const bytes = Buffer.from(citation.audio.base64, "base64");
  if (bytes.byteLength === 0 || sha256(bytes) === output.sha256) {
    // A citation is a bounded clip. It may be shorter than the complete MP3,
    // but it must still contain a non-empty encoded audio payload.
    if (bytes.byteLength === 0) throw new Error("known citation returned an empty audio payload");
  }
}

function citationSummary(citation) {
  return {
    meetingId: citation.meetingId,
    recordingId: citation.recordingId,
    segmentId: citation.segmentId,
    startMs: citation.startMs,
    endMs: citation.endMs,
    audio: { byteLength: Buffer.byteLength(citation.audio.base64, "base64"), sha256: sha256(Buffer.from(citation.audio.base64, "base64")) },
  };
}

function playbackSummary(observation, bytes) {
  return {
    audioAccepted: observation.audioAccepted === true,
    playResolved: observation.playResolved === true,
    pauseObserved: observation.pauseObserved === true,
    maximumCurrentTime: Number(observation.maximumCurrentTime.toFixed(3)),
    citationIdentity: observation.citationIdentity,
    positiveBoundedProgress: observation.positiveBoundedProgress === true,
    sourceBytes: bytes.byteLength,
    sourceSha256: sha256(bytes),
    controlledEvidence: true,
  };
}

async function installAudioObserver(page, citation) {
  await page.evaluate(() => {
    const NativeAudio = globalThis.Audio;
    globalThis.__meetlessM7AudioObservation = null;
    globalThis.Audio = function observedMeetlessAudio(source) {
      const audio = new NativeAudio(source);
      const observation = {
        source: typeof source === "string" ? source : "",
        audioAccepted: true,
        playResolved: false,
        pauseObserved: false,
        maximumCurrentTime: 0,
        citationIdentity: globalThis.__meetlessM7ExpectedCitationIdentity,
      };
      globalThis.__meetlessM7AudioObservation = observation;
      const originalPlay = audio.play.bind(audio);
      const originalPause = audio.pause.bind(audio);
      audio.play = async () => {
        await originalPlay();
        observation.playResolved = true;
      };
      audio.pause = () => {
        observation.pauseObserved = true;
        observation.maximumCurrentTime = Math.max(observation.maximumCurrentTime, Number(audio.currentTime) || 0);
        originalPause();
      };
      audio.addEventListener("timeupdate", () => {
        observation.maximumCurrentTime = Math.max(observation.maximumCurrentTime, Number(audio.currentTime) || 0);
      });
      return audio;
    };
  });
  await page.evaluate((identity) => {
    globalThis.__meetlessM7ExpectedCitationIdentity = identity;
  }, citationIdentity(citation));
}

async function waitForPlayback(page, citation) {
  return waitFor(async () => {
    const observation = await page.evaluate(() => globalThis.__meetlessM7AudioObservation);
    if (typeof observation.source !== "string" || !observation.source.startsWith("data:audio/mpeg;base64,")) {
      throw new Error("browser Audio source is not a bounded MP3 data URL");
    }
    const bounded = validateBoundedPlaybackObservation(observation, citation);
    return { ...observation, ...bounded };
  }, "bounded citation playback", 15_000);
}

async function openRecordingSocket(socketPath) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`);
  const statuses = [];
  const pending = new Map();
  socket.on("message", (raw) => {
    let decoded;
    try { decoded = JSON.parse(raw.toString()); } catch { return; }
    const event = RecordingStatusEventSchema.safeParse(decoded);
    if (event.success) {
      statuses.push(event.data.status);
      return;
    }
    const request = decoded && typeof decoded === "object" ? pending.get(decoded.requestId) : undefined;
    if (request) {
      pending.delete(decoded.requestId);
      request.resolve(decoded);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    statuses,
    requestReadiness: (operation) => request(socket, pending, `m7-f3-readiness-${randomUUID()}`, {
      version: 1, requestId: "pending", command: "runtime.readiness", operation,
    }, true),
    waitForStatus: (predicate, timeout, label) => waitFor(async () => {
      const cached = statuses.find(predicate);
      if (cached) return { status: cached };
      const current = await request(socket, pending, `m7-f3-status-${randomUUID()}`, {
        version: 1, requestId: "pending", command: "runtime.readiness", operation: "status",
      }, true);
      statuses.push(current.status);
      if (predicate(current.status)) return { status: current.status };
      throw new Error(`authoritative status is ${current.status.status} recording=${current.status.recordingId ?? "none"} inventory=${current.status.inventoryState ?? "none"} chunks=${current.status.chunkCount} output=${current.status.outputPath ?? "none"} error=${current.status.error ?? "none"}`);
    }, label, timeout),
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await new Promise((resolve) => socket.once("close", resolve));
    },
  };
}

async function request(socket, pending, requestId, payload, readiness) {
  const message = { ...payload, requestId };
  const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  socket.send(JSON.stringify(message));
  const decoded = await response;
  if (readiness) return RecordingRuntimeReadinessResponseSchema.parse(decoded);
  return RecordingControlResponseSchema.parse(decoded);
}

async function waitForChunks(config, socket, recordingId) {
  return waitFor(async () => {
    const readiness = await socket.requestReadiness("status");
    const status = readiness.status;
    if (status.recordingId !== recordingId || status.chunkCount < 2 || status.microphoneCount < 1 || status.systemCount < 1) {
      throw new Error(`fixture chunks are ${status.chunkCount}/${status.microphoneCount}/${status.systemCount}`);
    }
    const identities = await Promise.all(status.chunks.map(async (chunk) => ({
      storageKey: chunk.storageKey,
      source: chunk.source,
      byteLength: chunk.byteLength,
      sha256: chunk.sha256,
      observed: await fileIdentity(path.resolve(config.paths.meetingStore, chunk.storageKey)),
    })));
    if (identities.some((chunk) => chunk.observed.byteLength !== chunk.byteLength || chunk.observed.sha256 !== chunk.sha256)) {
      throw new Error("fixture committed chunk identity changed before stop");
    }
    return {
      recordingId,
      count: status.chunkCount,
      microphoneCount: status.microphoneCount,
      systemCount: status.systemCount,
      identities: identities.map(({ storageKey, source, byteLength, sha256 }) => ({ storageKey, source, byteLength, sha256 })),
    };
  }, "fixture microphone and system chunks", 30_000);
}

async function readSavedStore(store, meetingId, recordingId) {
  return waitFor(async () => {
    const meetings = await store.list();
    const recordings = await store.listRecordings();
    const meeting = meetings.find((candidate) => candidate.id === meetingId);
    const recording = recordings.find((candidate) => candidate.id === recordingId);
    if (!meeting || !recording || recording.status !== "saved" || !recording.savedOutput) throw new Error("saved MeetingStore state is not ready");
    return { meeting, recording };
  }, "saved MeetingStore recording", 30_000);
}

async function analyzeMp3(ffprobe, filePath) {
  const result = await execFileAsync(ffprobe, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", filePath,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const decoded = JSON.parse(result.stdout);
  const durationSeconds = Number(decoded.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !decoded.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "mp3")) {
    throw new Error("ffprobe did not validate a readable MP3");
  }
  return { durationSeconds: Number(durationSeconds.toFixed(3)), codec: "mp3" };
}

async function expectRejected(operation, label) {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  if (!rejected) throw new Error(`${label} was accepted unexpectedly`);
}

async function prepareProofRuntime() {
  if (await pathExists(runtimeRoot)) {
    const owner = await readFile(packageRuntimeOwnerPath, "utf8").then((value) => JSON.parse(value), () => null);
    if (!owner || owner.schema !== "MEETLESS_M7_PACKAGE_ACCEPTANCE_RUNTIME_v1" || owner.ownerToken?.startsWith(proofOwnerPrefix) !== true) {
      throw new Error(`refusing to remove an unowned package runtime ${runtimeRoot}`);
    }
    assertNoPackagedRuntimeProcesses();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
  await mkdir(path.join(runtimeRoot, "meeting-store"), { recursive: true, mode: 0o700 });
  await writeFile(packageRuntimeOwnerPath, `${JSON.stringify({
    schema: "MEETLESS_M7_PACKAGE_ACCEPTANCE_RUNTIME_v1",
    ownerToken: proofOwner,
    runtimeRoot,
    runId: proofRunId,
  })}\n`, { mode: 0o600 });
  await writeFile(path.join(runtimeRoot, "meeting-store", "M7-proof-sentinel.txt"), "M7 isolated package acceptance sentinel v1\n", { mode: 0o600 });
}

async function removeProofRuntime(ownedExportRoot) {
  if (!await pathExists(runtimeRoot)) return;
  const owner = JSON.parse(await readFile(packageRuntimeOwnerPath, "utf8"));
  if (owner.schema !== "MEETLESS_M7_PACKAGE_ACCEPTANCE_RUNTIME_v1" || owner.ownerToken !== proofOwner || owner.runtimeRoot !== runtimeRoot) {
    throw new Error(`refusing to remove an unowned package runtime ${runtimeRoot}`);
  }
  assertNoExactHost(canonicalBundle);
  assertNoPackagedRuntimeProcesses();
  const storePath = path.join(runtimeRoot, "meeting-store", "meetings.json");
  if (await pathExists(storePath)) {
    const state = JSON.parse(await readFile(storePath, "utf8"));
    const destinations = (state.recordings ?? []).map((recording) => recording.savedOutput?.destination).filter(Boolean);
    if (destinations.some((destination) => !pathInside(destination, ownedExportRoot ?? exportLeaseParent))) {
      throw new Error("package runtime store still references an export outside the owned lease root");
    }
  }
  await rm(runtimeRoot, { recursive: true, force: true });
  if (await pathExists(runtimeRoot)) throw new Error("package runtime root remained after owned removal");
}

async function removeExternalExportRoot(root, sessionId, cleanupLease) {
  if (!cleanupLease) throw new Error("cleanup lease was not created");
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== exportLeaseParent || path.basename(resolved) !== sessionId) throw new Error("external cleanup root identity is not exact");
  if (pathInside(resolved, runtimeRoot) || pathInside(resolved, path.join(homedir(), "Documents")) || pathInside(resolved, repositoryRoot)) {
    throw new Error("refusing to remove an external root inside a protected path");
  }
  if (findExactHostPids(canonicalBundle).length > 0 || findPackagedRuntimeProcesses().length > 0) throw new Error("refusing external cleanup while owned processes remain");
  if (await pathExists(runtimeRoot)) throw new Error("refusing external cleanup while proof runtime/store remains");
  const rootInfo = await lstat(resolved);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700 || rootInfo.uid !== currentUid()) {
    throw new Error("external cleanup root is not a secure owned directory");
  }
  const leasePath = path.join(resolved, "meetless-export-lease.json");
  const leaseInfo = await lstat(leasePath);
  if (!leaseInfo.isFile() || leaseInfo.isSymbolicLink() || (leaseInfo.mode & 0o777) !== 0o600 || leaseInfo.uid !== currentUid()) {
    throw new Error("external cleanup lease is not a secure owned file");
  }
  const bytes = await readFile(leasePath);
  const lease = JSON.parse(bytes.toString("utf8"));
  if (
    lease.proofSessionId !== sessionId || lease.restartGeneration !== cleanupLease.restartGeneration ||
    lease.exportRoot !== resolved || lease.ownerUid !== currentUid() || Date.parse(lease.expiresAt) >= Date.now() ||
    sha256(bytes) !== cleanupLease.exportLeaseSha256
  ) throw new Error("external cleanup requires the exact expired session lease");
  await rm(resolved, { recursive: true, force: false });
  if (await pathExists(resolved)) throw new Error("external export root remained after owned cleanup");
}

async function recoverStaleProofTransactions() {
  const parent = path.dirname(canonicalBundle);
  const names = await readdir(parent).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names.filter((candidate) => /^\.Meetless\.app\.m7\..+\.transaction\.json$/u.test(candidate))) {
    const journalPath = path.join(parent, name);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (path.resolve(journal.target) !== path.resolve(canonicalBundle) || path.resolve(journal.identityPath) !== path.resolve(identityPath)) {
      throw new Error(`refusing a transaction outside the fixed package paths: ${journalPath}`);
    }
    if (!journal.ownerToken?.startsWith(proofOwnerPrefix) && !journal.ownerToken?.startsWith("MEETLESS_M7_PACKAGE_PROOF_v1:")) {
      throw new Error(`refusing an unowned package transaction: ${journalPath}`);
    }
    assertNoExactHost(canonicalBundle);
    await recoverPackageTransaction(journalPath, { ownerToken: journal.ownerToken, target: canonicalBundle, identityPath });
  }
  const leftovers = (await readdir(parent)).filter((name) => name.startsWith(".Meetless.app.m7."));
  if (leftovers.length > 0) throw new Error(`refusing unowned package transaction artifacts: ${leftovers.join(", ")}`);
}

async function verifyRestoration(previousBundleFingerprint, previousIdentity, defaultBefore, defaultAfter) {
  if (await fingerprintPath(canonicalBundle) !== previousBundleFingerprint) throw new Error("canonical Meetless.app was not restored byte-for-byte");
  const identity = await readBytes(identityPath);
  if (previousIdentity === null ? identity !== null : !identity?.equals(previousIdentity)) throw new Error("canonical host identity was not restored byte-for-byte");
  if (JSON.stringify(defaultBefore) !== JSON.stringify(defaultAfter)) throw new Error("default MeetingStore or Documents/meetings state changed");
}

async function readPackageHostConfiguration() {
  const configuration = JSON.parse(await readFile(path.join(candidateBundle, "Contents/Resources/host-config.json"), "utf8"));
  if (configuration.runtimeRoot !== runtimeRoot || configuration.identityPath !== identityPath) throw new Error("candidate host config is not bound to the accepted package runtime and identity");
  if (configuration.rendererOrigin !== packagePaths.rendererOrigin) throw new Error("candidate host renderer origin is not the accepted isolated renderer");
  if (!/^127\.0\.0\.1:\d+$/u.test(configuration.listen)) throw new Error(`candidate package listener is not loopback: ${configuration.listen}`);
  if (!configuration.nodePath.startsWith(canonicalPackageRoot) && !configuration.nodePath.includes("Meetless.app")) throw new Error("candidate host node path is not packaged");
  return configuration;
}

function packageEnvironment(configuration) {
  const environment = { ...process.env };
  for (const key of [
    "MEETLESS_CAPTURE_MODE", "MEETLESS_TRANSCRIPTION_MODE", "MEETLESS_UI_TEST_MODE", "MEETLESS_UI_TEST_RUN_ID",
    "MEETLESS_UI_TEST_MARKER", "MEETLESS_UI_TEST_IDENTITY", "PASEO_ELECTRON_FLAGS", "MEETLESS_EXPORT_ROOT",
  ]) delete environment[key];
  return {
    ...environment,
    MEETLESS_RUNTIME_ROOT: configuration.runtimeRoot,
    MEETLESS_LISTEN: configuration.listen,
    MEETLESS_RENDERER_ORIGIN: configuration.rendererOrigin,
  };
}

async function snapshotPaths(paths) {
  const result = {};
  for (const candidate of paths) result[candidate] = await fingerprintPath(candidate);
  return result;
}

function assertDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error(`M7 package acceptance requires darwin arm64, received ${process.platform} ${process.arch}`);
}

function assertNoActiveRecordingOrCapture() {
  const storePath = path.join(repositoryRoot, ".meetless-runtime", "meeting-store", "meetings.json");
  if (pathExistsSync(storePath)) {
    const state = JSON.parse(readFileSync(storePath, "utf8"));
    const active = (state.recordings ?? []).filter((recording) => recording.status === "recording" || recording.status === "finalizing");
    if (active.length > 0) throw new Error(`default MeetingStore has active recording state: ${active.map((recording) => recording.id).join(", ")}`);
  }
  const captures = processRows().filter((row) => row.command.split(/\s+/u).some((token) => token.endsWith("/meetless-capture")));
  if (captures.length > 0) throw new Error(`meetless-capture is already running: ${JSON.stringify(captures)}`);
}

function assertNoExactHost(bundle) {
  const matches = findExactHostPids(bundle);
  if (matches.length > 0) throw new Error(`exact MeetlessHost is already live at ${bundle}: ${matches.join(", ")}`);
}

function assertNoUnrelatedHost(bundle) {
  const executable = path.join(bundle, "Contents/MacOS/MeetlessHost");
  const unrelated = processRows().filter((row) => /(?:^|\s)(?:[^\s]*\/)?MeetlessHost(?:\s|$)/u.test(row.command) && row.command !== executable);
  if (unrelated.length > 0) throw new Error(`an unrelated MeetlessHost is live: ${JSON.stringify(unrelated)}`);
}

function findExactHostPids(bundle) {
  const executable = path.join(bundle, "Contents/MacOS/MeetlessHost");
  return processRows().filter((row) => row.ppid === 1 && row.command === executable).map((row) => row.pid);
}

function findPackagedRuntimeProcesses() {
  return processRows().filter((row) => row.command.includes(canonicalPackageRoot) || row.command.includes(canonicalBundle) || row.command.includes(runtimeRoot));
}

function assertNoPackagedRuntimeProcesses() {
  const live = findPackagedRuntimeProcesses();
  if (live.length > 0) throw new Error(`packaged processes remain after bounded stop: ${JSON.stringify(live)}`);
}

function assertPortAvailable(endpoint, label) {
  const port = endpointPort(endpoint);
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot inspect ${label} port ${port}: ${result.error.message}`);
  if (result.status === 1 && result.stdout.trim() === "") return;
  if (result.status !== 0) throw new Error(`${label} port ${port} inspection failed: ${result.stderr.trim()}`);
  if (result.stdout.trim()) throw new Error(`${label} port ${port} is already in use: ${result.stdout.trim()}`);
}

function assertPortsReleased(...endpoints) {
  for (const endpoint of endpoints) assertPortAvailable(endpoint, "released");
}

function endpointPort(endpoint) {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) return Number(new URL(endpoint).port);
  return Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
}

async function waitForPackagedTopology(hostExecutable, packageNode) {
  const deadline = Date.now() + 30_000;
  const nodePath = path.resolve(packageNode);
  const cliPath = path.join(canonicalPackageRoot, "packages/runtime/dist/cli.js");
  const electronPath = path.join(canonicalPackageRoot, "runtime/electron/Electron.app/Contents/MacOS/Electron");
  while (Date.now() < deadline) {
    const rows = processRows();
    const host = rows.find((row) => row.ppid === 1 && row.command === hostExecutable);
    const desktop = host && rows.find((row) => row.ppid === host.pid && row.command.includes(`${cliPath} desktop`));
    const electron = desktop && rows.find((row) => row.ppid === desktop.pid && row.command.includes("electron-bootstrap.mjs"));
    if (host && desktop && electron) {
      if (path.resolve(executablePath(desktop.pid)) !== nodePath) throw new Error("packaged desktop executable is not the packaged node");
      if (path.resolve(executablePath(electron.pid)) !== path.resolve(electronPath)) throw new Error("packaged Electron executable is not the package Electron");
      return { hostPid: host.pid, desktopPid: desktop.pid, electronPid: electron.pid, nodePath, cliPath, electronPath };
    }
    await delay(100);
  }
  throw new Error("LaunchServices did not produce the exact packaged host -> desktop -> Electron topology");
}

async function waitForRenderer(origin, expected) {
  return waitFor(async () => {
    const response = await fetch(`${origin}/`);
    if (!response.ok) throw new Error(`renderer status ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const actual = { byteLength: body.byteLength, sha256: sha256(body) };
    if (actual.byteLength !== expected.size || actual.sha256 !== expected.sha256) throw new Error("packaged renderer bytes differ from the manifest");
    return { origin, ...actual, entry: expected.entry };
  }, "packaged renderer", 30_000);
}

async function connectOverCdp(endpoint, expectedRunId, rendererOrigin) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 1_000 });
      if (browser.contexts().flatMap((context) => context.pages()).some((page) => page.url().startsWith(rendererOrigin))) return browser;
      await browser.close();
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`timed out attaching to packaged CDP for ${expectedRunId}: ${describe(lastError)}`);
}

async function findExactRendererPage(browser, expectedRunId, rendererOrigin) {
  return waitFor(async () => {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      if (!page.url().startsWith(rendererOrigin)) continue;
      const marker = rendererMarker(page.url());
      if (marker?.runId === expectedRunId && marker.logicalDesktopId === "com.meetless.desktop") return page;
    }
    throw new Error(`renderer pages do not expose run ${expectedRunId}: ${pages.map((page) => page.url()).join(" | ")}`);
  }, "exact packaged renderer page", 30_000);
}

function rendererMarker(url) {
  try {
    const parsed = new URL(url);
    return {
      runId: parsed.searchParams.get("uiTestRunId") ?? "",
      logicalDesktopId: parsed.searchParams.get("uiTestDesktopId") ?? "",
    };
  } catch {
    return null;
  }
}

async function readBridgeStatus(page, config) {
  return page.evaluate(async () => {
    const bridge = globalThis.paseoDesktop;
    const status = typeof bridge?.invoke === "function" ? await bridge.invoke("desktop_daemon_status") : null;
    return { platform: bridge?.platform ?? "", ...(status && typeof status === "object" ? status : {}) };
  }).then((value) => ({
    ...value,
    expectedListen: config.listen,
    expectedHome: config.paths.paseoHome,
  }));
}

async function endpointPid(port) {
  return waitFor(async () => {
    const pids = await listenerPids(String(port));
    if (pids.length !== 1) throw new Error(`CDP endpoint has ${pids.length} listeners`);
    return pids[0];
  }, "run-scoped CDP listener", 10_000);
}

function exactAncestry(electronPid, hostPid, desktopPid, installed, expectedElectron) {
  const rows = new Map(processRows().map((row) => [row.pid, row]));
  const ancestry = [];
  const seen = new Set();
  let current = electronPid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    ancestry.unshift(current);
    if (current === hostPid) break;
    current = rows.get(current)?.ppid ?? 1;
  }
  if (ancestry[0] !== hostPid || ancestry[1] !== desktopPid || ancestry.at(-1) !== electronPid) throw new Error(`CDP PID ${electronPid} is not exact host -> desktop ancestry: ${ancestry.join(" -> ")}`);
  const host = rows.get(hostPid);
  const desktop = rows.get(desktopPid);
  if (!host || host.ppid !== 1 || host.command !== installed.executablePath) throw new Error("CDP ancestry host is not the installed candidate");
  const expectedDesktopCommand = `${installed.configuration.nodePath} ${installed.configuration.runtimeCliPath} desktop`;
  if (!desktop || desktop.ppid !== hostPid || desktop.command !== expectedDesktopCommand) throw new Error("CDP ancestry desktop is not the exact packaged runtime");
  const observedElectron = electronExecutable(electronPid);
  if (path.resolve(observedElectron) !== path.resolve(expectedElectron)) throw new Error("CDP endpoint is not the packaged Electron executable");
  return { ancestry, electronExecutable: observedElectron };
}

function expectedElectronExecutable() {
  return path.join(canonicalPackageRoot, "runtime/electron/Electron.app/Contents/MacOS/Electron");
}

function electronExecutable(pid) {
  const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt"], { encoding: "utf8" });
  const value = output.split("\n").map((line) => line.trim().split(/\s+/u).at(-1) ?? "").find((candidate) => candidate.endsWith("/Electron") && !candidate.includes("Helper"));
  return value ?? processRow(pid)?.command.split(" ")[0] ?? "unknown";
}

async function listenerPids(listen) {
  const port = listen.includes(":") ? listen.slice(listen.lastIndexOf(":") + 1) : listen;
  const inspected = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" }).catch((error) => {
    if (error?.code === 1) return { stdout: "" };
    throw error;
  });
  return [...String(inspected.stdout).matchAll(/^p(\d+)$/gmu)].map((match) => Number(match[1]));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not reserve a CDP port");
  return port;
}

async function waitFor(operation, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
      throw new Error(`${label} is not ready`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}: ${describe(lastError)}`);
}

async function waitForVisible(locator, timeoutMs) {
  return waitFor(async () => (await locator.isVisible()) ? true : (() => { throw new Error("control is not visible"); })(), "visible control", timeoutMs);
}

async function waitForMarker(envelopeModule, expectedRunId) {
  return waitFor(async () => {
    const marker = await envelopeModule.readConsumedUiTestMarker(runtimeRoot);
    if (marker?.runId !== expectedRunId) throw new Error(`consumed marker is ${marker?.runId ?? "missing"}`);
    return marker;
  }, "consumed packaged UI-test marker", 30_000);
}

function buildEvidence(input) {
  const { validation, installed, packageConfiguration, lease1, lease2, lease3, generation1, generation2, topology, lifecycle, defaultBefore, defaultAfter } = input;
  return {
    schema: "MEETLESS_M7_F3_PACKAGED_CONTROLLED_LIFECYCLE v1",
    frontierId: "M7-F3-RUNTIME-MEDIA-CLOSURE",
    status: "passed",
    runId: proofRunId,
    candidate: {
      sourceSnapshotMode: manifest.candidateSnapshot.mode,
      sourceSnapshotExcludedPaths: manifest.candidateSnapshot.excludedPaths,
      sourceSnapshotDigest: manifest.candidateSnapshot.digest,
      sourceSnapshotHead: manifest.candidateSnapshot.head,
      packageInputDigest: manifest.packageInputs.digest,
      artifactInputDigest: manifest.packageInputs.artifactInput.digest,
      artifactDigest: validation.artifactDigest,
      entryCount: manifest.entries.length,
      machoCount: manifest.macho.length,
      paseoCommit: manifest.candidateSnapshot.paseoCommit,
    },
    acceptedHost: {
      bundleIdentifier: installed.bundleIdentifier,
      cdHash: installed.cdHash,
      launchRoute: "LaunchServices open -g -a exact com.meetless.app bundle",
      canonicalBundleRestored: true,
      identityRestoredByteForByte: true,
    },
    packageConfiguration: {
      listen: packageConfiguration.listen,
      rendererOrigin: packageConfiguration.rendererOrigin,
      runtimeRoot: "<owned-proof-runtime>",
      packageRoot: "<installed-package-root>",
      exportRoot: "<leased-external-root>",
      sourceFallbackAfterLaunch: false,
      homebrewFallback: false,
    },
    lease: {
      parent: exportLeaseParent,
      proofSessionId: proofRunId,
      root: lease1.exportRoot,
      generation1: leaseSummary(lease1),
      generation2: leaseSummary(lease2),
      cleanupGeneration: leaseSummary(lease3),
      rootRemovedAfterExpiredOwnershipCheck: true,
    },
    generations: {
      generation1: generationSummary(generation1),
      generation2: generationSummary(generation2),
      freshProcessIdentity: generation1.readiness.runtimeInstanceId !== generation2.readiness.runtimeInstanceId &&
        generation1.topology.hostPid !== generation2.topology.hostPid,
    },
    topology,
    lifecycle,
    correlations: {
      sourceLabelEvidence: generation1.snapshot.chunks,
      mp3: generation1.snapshot.output,
      collision: generation1.snapshot.collision,
      transcript: generation1.snapshot.transcript,
      citation: generation1.snapshot.citation,
      playbackGeneration1: generation1.snapshot.playback,
      playbackGeneration2: generation2.snapshot.playback,
      transcriptGeneration2: generation2.snapshot.transcript,
      citationGeneration2: generation2.snapshot.citation,
      chatGeneration1: generation1.snapshot.chat,
      chatGeneration2: generation2.snapshot.chat,
      mediaClosureGeneration1: generation1.snapshot.mediaClosure,
      mediaClosureGeneration2: generation2.snapshot.mediaClosure,
    },
    fingerprints: {
      defaultBefore,
      defaultAfter,
      defaultUnchanged: JSON.stringify(defaultBefore) === JSON.stringify(defaultAfter),
      generation1Store: generation1.snapshot.store,
      generation2Store: generation2.snapshot.store,
      externalMp3AfterGeneration1Stop: generation1.snapshot.output,
      externalMp3AfterGeneration2Stop: generation2.snapshot.output,
    },
    cleanup: {
      exactHostStopped: true,
      packagedProcessesStopped: true,
      packagePortsReleased: true,
      internalEnvelopeRemovedOnEachShutdown: true,
      runtimeRemovedBeforeExternalRoot: true,
      externalRootOwnershipChecked: true,
      externalLeaseExpiredBeforeRemoval: true,
      externalRootRemoved: true,
      defaultStoreUnchanged: true,
      defaultExportsUnchanged: true,
      canonicalBundleRestored: true,
      canonicalIdentityRestored: true,
    },
    evidenceLimits: [
      "Controlled fixture capture only; source-labelled chunks do not prove a real call or native capture provider.",
      "Fake transcription only; ordered segments and citations do not prove a native provider or external service.",
      "Browser Audio progression is machine-observed bounded playback; it does not prove audible output or human hearing.",
      "This run does not prove clean-install TCC, signing, notarization, release acceptance, or legal clearance.",
      "No credentials, network provider, real target, or raw private content is included.",
    ],
  };
}

function leaseSummary(lease) {
  return lease ? {
    restartGeneration: lease.restartGeneration,
    leaseId: lease.exportLeaseId,
    leaseSha256: lease.exportLeaseSha256,
    leasePath: "meetless-export-lease.json",
    expiresAt: lease.expiresAt,
  } : null;
}

function generationSummary(generation) {
  return {
    generation: generation.generation,
    runId: generation.marker.runId,
    runtimeInstanceId: generation.readiness.runtimeInstanceId,
    pluginPid: generation.readiness.pluginPid,
    exportRoot: generation.readiness.exportRoot,
    captureMode: generation.readiness.captureMode,
    renderer: generation.renderer,
    meetingId: generation.snapshot.meetingId,
    recordingId: generation.snapshot.recordingId,
  };
}

function validateEvidenceManifest(evidence) {
  if (!evidence || evidence.schema !== "MEETLESS_M7_F3_PACKAGED_CONTROLLED_LIFECYCLE v1" || evidence.status !== "passed") throw new Error("M7 evidence manifest schema/status is invalid");
  if (evidence.frontierId !== "M7-F3-RUNTIME-MEDIA-CLOSURE") throw new Error("M7 evidence frontier is stale");
  if (Object.prototype.hasOwnProperty.call(evidence, "evidenceSha256")) throw new Error("M7 evidence must not contain its own digest");
  for (const field of ["runId", "candidate", "acceptedHost", "lease", "generations", "correlations", "fingerprints", "cleanup", "evidenceLimits"]) {
    if (!(field in evidence)) throw new Error(`M7 evidence manifest is missing ${field}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(evidence.candidate.sourceSnapshotDigest) || !/^[a-f0-9]{64}$/u.test(evidence.candidate.packageInputDigest) || !/^[a-f0-9]{64}$/u.test(evidence.candidate.artifactInputDigest) || !/^[a-f0-9]{64}$/u.test(evidence.candidate.artifactDigest)) throw new Error("M7 evidence candidate hashes are invalid");
  if (evidence.candidate.entryCount <= 0 || evidence.candidate.machoCount <= 0) throw new Error("M7 evidence package counts are invalid");
  if (!evidence.acceptedHost.canonicalBundleRestored || !evidence.acceptedHost.identityRestoredByteForByte) throw new Error("M7 evidence lacks identity restoration proof");
  if (!evidence.cleanup.externalRootRemoved || !evidence.cleanup.runtimeRemovedBeforeExternalRoot || !evidence.cleanup.externalLeaseExpiredBeforeRemoval) throw new Error("M7 evidence lacks bounded external cleanup proof");
  if (
    evidence.correlations.transcript.segmentCount < 1 ||
    !evidence.correlations.citation.segmentId ||
    !evidence.correlations.playbackGeneration1.pauseObserved ||
    !evidence.correlations.playbackGeneration2.pauseObserved ||
    !evidence.correlations.playbackGeneration1.positiveBoundedProgress ||
    !evidence.correlations.playbackGeneration2.positiveBoundedProgress
  ) throw new Error("M7 evidence lacks transcript/citation/positive bounded playback proof");
  if (
    !evidence.correlations.mediaClosureGeneration1?.snapshotFingerprint ||
    evidence.correlations.mediaClosureGeneration1.snapshotFingerprint !== evidence.correlations.mediaClosureGeneration2?.snapshotFingerprint ||
    evidence.correlations.mediaClosureGeneration1.entryCount <= 0 ||
    evidence.correlations.mediaClosureGeneration1.atomicDirectoryUnit !== true ||
    evidence.correlations.mediaClosureGeneration2.atomicDirectoryUnit !== true
  ) throw new Error("M7 evidence lacks identical generation-1/generation-2 media closure proof");
  if (!Array.isArray(evidence.evidenceLimits) || evidence.evidenceLimits.length < 4) throw new Error("M7 evidence limits are incomplete");
  validateAcceptanceEvidenceBinding(evidence, manifest);
  rejectPrivateOrRawFields(evidence);
  return evidence;
}

function rejectPrivateOrRawFields(value, location = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrivateOrRawFields(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["base64", "text", "question", "token", "secret", "password", "credential"].some((marker) => key.toLowerCase().includes(marker))) {
      throw new Error(`M7 evidence contains a forbidden raw/private field: ${location}.${key}`);
    }
    rejectPrivateOrRawFields(child, `${location}.${key}`);
  }
}

function pathInside(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function relativeEvidencePath(filePath, root) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`evidence path leaves the leased root: ${filePath}`);
  return relative.split(path.sep).join("/");
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("proof ownership requires process UID support");
  return process.getuid();
}

function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function processRow(pid) { return processRows().find((row) => row.pid === pid); }
function executablePath(pid) {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect executable for PID ${pid}`);
  const lines = result.stdout.split("\n");
  const index = lines.indexOf("ftxt");
  const value = index >= 0 ? lines[index + 1] : null;
  if (!value?.startsWith("n/")) throw new Error(`lsof did not report executable for PID ${pid}`);
  return value.slice(1);
}

async function fileIdentity(filePath) {
  const bytes = await readFile(filePath);
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function describe(error) { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function pathExists(candidate) { try { await access(candidate); return true; } catch { return false; } }
