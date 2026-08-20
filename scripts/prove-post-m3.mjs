import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { access, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import WebSocket from "ws";
import { MeetingStore } from "@meetless/meeting-store";
import { RecordingControlResponseSchema, RecordingStatusEventSchema } from "@meetless/meeting-contracts";
import { RecordingRuntimeReadinessResponseSchema } from "@meetless/plugin/readiness-protocol";
import { readInventory } from "../packages/meetless-plugin/dist/src/inventory.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";
import { assertInstalledHostIdentity } from "../packages/runtime/dist/host.js";
import { validatePostM3Correlation } from "../packages/runtime/dist/post-m3-correlation.js";
import { summarizePostM3Cleanup } from "../packages/runtime/dist/post-m3-cleanup.js";
import {
  newUiTestEnvelope,
  readConsumedUiTestMarker,
  removeUiTestRunState,
  writeUiTestEnvelope,
} from "../packages/runtime/dist/ui-test-envelope.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const providerArgument = process.argv[process.argv.indexOf("--provider") + 1] ?? "all";
if (!["fake", "native", "all"].includes(providerArgument)) {
  throw new Error("Usage: node scripts/prove-post-m3.mjs --provider fake|native|all");
}

const runId = `post-m3-proof-${Date.now()}-${randomUUID().slice(0, 8)}`;
const config = resolveRuntimeConfig({ runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT, listen: process.env.MEETLESS_LISTEN });
const hostIdentity = await assertInstalledHostIdentity(config);
const preservedRoot = `${config.paths.root}.post-m3-preserved-${runId}`;
const originalRootExisted = await exists(config.paths.root);
const results = [];
let staged = false;
let preserved = false;
let fatalError = null;
let cleanupReport;

try {
  await ensureNoAmbiguousRuntime(config, hostIdentity);
  if (originalRootExisted) {
    await assertDirectoryNotSymlink(config.paths.root);
    await rename(config.paths.root, preservedRoot);
    preserved = true;
  }
  staged = true;
  await mkdir(config.paths.root, { recursive: true, mode: 0o700 });

  for (const providerMode of providerArgument === "all" ? ["fake", "native"] : [providerArgument]) {
    const result = await runProviderMode(providerMode, config, hostIdentity, runId);
    results.push(result);
    await stopExactHost(hostIdentity.executablePath);
    await cleanupStagedRuntime(config.paths.root);
    await mkdir(config.paths.root, { recursive: true, mode: 0o700 });
  }
} catch (error) {
  fatalError = error;
  results.push({ mode: "harness", status: "failed", reason: describe(error) });
} finally {
  cleanupReport = await cleanupProofWorkspace({
    root: config.paths.root,
    preservedRoot,
    originalRootExisted,
    staged,
    preserved,
    hostExecutable: hostIdentity.executablePath,
  });
}

const manifest = {
  schema: "MEETLESS_POST_M3_CORRELATED_PROOF v1",
  status: cleanupReport.status === "failed"
    ? "failed"
    : results.some((result) => result.status === "failed")
      ? "failed"
      : results.some((result) => result.status === "incomplete")
        ? "incomplete"
        : "passed",
  frontierId: "POST-M3-E2E-IMPL-R1",
  logicalDesktopId: "com.meetless.desktop",
  acceptedHost: {
    bundleIdentifier: hostIdentity.bundleIdentifier,
    bundlePath: hostIdentity.bundleRealPath,
    cdHash: hostIdentity.cdHash,
    launchRoute: "LaunchServices",
  },
  evidencePolicy: {
    physicalClick: false,
    liveZoomMeetSource: false,
    tccClaim: false,
    generatedFixtureSource: true,
    nativeProviderIsSignedHostCapability: true,
  },
  cleanup: cleanupReport,
  fatalError: fatalError ? describe(fatalError) : null,
  results,
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
if (manifest.status !== "passed") process.exitCode = 1;

async function runProviderMode(providerMode, runtimeConfig, installedHost, proofRunId) {
  const cdpPort = await reservePort();
  const envelope = newUiTestEnvelope({
    runId: `${proofRunId}-${providerMode}`,
    cdpPort,
    transcriptionMode: providerMode,
    forceAccessibility: false,
  });
  await writeUiTestEnvelope(runtimeConfig.paths.root, envelope);

  let browser = null;
  let socket = null;
  let tracing = false;
  const artifactRoot = path.join("/private/tmp", `meetless-post-m3-${envelope.runId}`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const screenshotPath = path.join(artifactRoot, "renderer-final.png");
  const tracePath = path.join(artifactRoot, "renderer-trace.zip");
  try {
    process.stderr.write(`[post-m3] ${providerMode}: launching exact host\n`);
    await launchExactHost();
    process.stderr.write(`[post-m3] ${providerMode}: host launched\n`);
    const marker = await waitForMarker(runtimeConfig.paths.root, envelope.runId);
    process.stderr.write(`[post-m3] ${providerMode}: marker consumed on CDP ${marker.identity.cdpPort}\n`);
    if (providerMode === "native") {
      const nativeStatus = await waitForNativeProvider(runtimeConfig.paths.transcriptionSocket);
      if (nativeStatus !== "configured") {
        return {
          mode: "native",
          status: "incomplete",
          label: "native-provider-signed-host-capability",
          reason: `accepted host capability reports ${nativeStatus}; native acceptance is incomplete and no fake substitution was made`,
          evidenceClass: "native-provider-unavailable",
          noFakeSubstitution: true,
        };
      }
    }

    const endpoint = `http://${envelope.cdpAddress}:${envelope.cdpPort}`;
    process.stderr.write(`[post-m3] ${providerMode}: attaching ${endpoint}\n`);
    browser = await connectOverCdp(endpoint, envelope.runId, runtimeConfig.rendererOrigin);
    process.stderr.write(`[post-m3] ${providerMode}: CDP attached\n`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP endpoint exposed no browser context");
    process.stderr.write(`[post-m3] ${providerMode}: starting bounded trace\n`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    tracing = true;
    process.stderr.write(`[post-m3] ${providerMode}: trace started\n`);
    const page = await findExactRendererPage(browser, envelope.runId, runtimeConfig.rendererOrigin);
    process.stderr.write(`[post-m3] ${providerMode}: exact page found ${page.url()}\n`);
    const electronPid = await endpointPid(envelope.cdpPort);
    const processEvidence = exactAncestry(
      electronPid,
      marker.identity.hostPid,
      marker.identity.desktopPid,
      installedHost,
      expectedElectronExecutable(),
    );
    const rendererUrl = page.url();
    const markerInPage = rendererMarker(page.url());
    if (markerInPage.runId !== envelope.runId || markerInPage.logicalDesktopId !== "com.meetless.desktop") {
      throw new Error("renderer page marker does not match the consumed envelope");
    }

    socket = await openRecordingSocket(runtimeConfig.paths.recordingSocket);
    const runtimeReady = await socket.requestReadiness("status");
    const runtimeUiTest = runtimeReady.runtime.uiTest;
    if (
      !runtimeUiTest ||
      runtimeUiTest.runId !== marker.runId ||
      runtimeUiTest.logicalDesktopId !== marker.logicalDesktopId ||
      runtimeUiTest.hostBundlePath !== installedHost.bundleRealPath ||
      runtimeUiTest.hostCdHash !== installedHost.cdHash
    ) {
      throw new Error("recording socket runtime.uiTest is missing or differs from the consumed marker and installed host authority");
    }
    process.stderr.write(`[post-m3] ${providerMode}: socket ${runtimeReady.runtime.socketPath} instance ${runtimeReady.runtime.instanceId} status ${runtimeReady.status.status}\n`);
    const start = page.locator('[data-testid="recording-start"]');
    const title = page.locator('[data-testid="recording-title-input"]');
    await waitForVisible(page.locator('[data-testid="connection-status"]'), 30_000);
    const bridgeDaemonStatus = await page.evaluate(async () => {
      const bridge = globalThis.paseoDesktop;
      const status = typeof bridge?.invoke === "function" ? await bridge.invoke("desktop_daemon_status") : null;
      return {
        platform: typeof bridge?.platform === "string" ? bridge.platform : "",
        ...(status && typeof status === "object" ? status : {}),
      };
    });
    process.stderr.write(`[post-m3] ${providerMode}: renderer bridge daemon ${JSON.stringify(bridgeDaemonStatus)}\n`);
    if (
      !bridgeDaemonStatus ||
      bridgeDaemonStatus.platform !== "darwin" ||
      path.resolve(bridgeDaemonStatus.home ?? "") !== path.resolve(runtimeConfig.paths.paseoHome) ||
      bridgeDaemonStatus.listen !== runtimeConfig.listen ||
      bridgeDaemonStatus.status !== "running" ||
      bridgeDaemonStatus.desktopManaged !== true ||
      !Number.isInteger(bridgeDaemonStatus.pid) ||
      bridgeDaemonStatus.pid <= 1 ||
      typeof bridgeDaemonStatus.serverId !== "string" ||
      bridgeDaemonStatus.serverId.trim().length === 0
    ) {
      throw new Error(`renderer bridge daemon is not the exact staged runtime (${JSON.stringify(bridgeDaemonStatus)})`);
    }
    await waitFor(() => start.isVisible(), "recording Start control");
    await title.fill(`Post-M3 ${envelope.runId}`);
    const titleEntered = (await title.inputValue()) === `Post-M3 ${envelope.runId}`;
    const startControlVisible = await start.isVisible();
    await start.click();
    const stop = page.locator('[data-testid="recording-stop"]');
    await waitFor(() => stop.isVisible(), "recording Stop control");
    const stopControlVisible = await stop.isVisible();
    const afterStart = await socket.requestReadiness("status");
    process.stderr.write(`[post-m3] ${providerMode}: after UI Start socket status ${afterStart.status.status} recording ${afterStart.status.recordingId ?? "none"}\n`);
    const recordingStatus = await socket.waitForStatus((status) => status.status === "recording", 20_000, "recording status after UI Start");
    const recordingReadiness = await socket.requestReadiness("status");
    const helper = await waitForHelper(runtimeConfig.paths.recordingSocket, socket, recordingReadiness, recordingStatus.status.recordingId);
    const firstChunks = await waitForChunks(runtimeConfig, socket, recordingStatus.status.recordingId);
    const latestChunks = await readChunkInventory(runtimeConfig, socket, recordingStatus.status.recordingId);
    const observedChunks = latestChunks.count >= firstChunks.count ? latestChunks : firstChunks;

    await stop.click();
    // RecordingService deliberately returns idle after durable publication; the
    // saved state is then read from MeetingStore. Keep the socket observation
    // as the authoritative pre/post control boundary instead of inventing a
    // transient saved socket state that the contract does not expose.
    const postStopStatus = await socket.waitForStatus((status) => status.status === "idle", 60_000, "post-stop idle socket status");
    await waitFor(() => page.locator('[data-testid="recording-stop"]').isVisible().then((visible) => !visible), "renderer saved state");

    const store = new MeetingStore({ root: runtimeConfig.paths.meetingStore });
    const storeSnapshot = await readSavedStore(store, recordingStatus.status.meetingId, recordingStatus.status.recordingId);
    const publishedChunks = await readPublishedChunkInventory(
      runtimeConfig.paths.meetingStore,
      storeSnapshot.recording.inventory.pointer,
      recordingStatus.status.recordingId,
    );
    const chunks = publishedChunks.count >= observedChunks.count ? publishedChunks : observedChunks;
    await page.locator('[data-testid="meeting-refresh-button"]').click();
    const transcriptButton = page.locator(`[data-testid="meeting-transcript-${storeSnapshot.meeting.id}"]`);
    await waitFor(() => transcriptButton.isVisible(), "meeting transcript control");
    await transcriptButton.click();
    const consent = page.locator('[data-testid="transcription-consent"]');
    await waitFor(() => consent.isVisible(), "transcription consent control");
    await consent.click();
    await waitFor(async () => {
      const ready = await store.getTranscriptForMeeting(storeSnapshot.meeting.id);
      return ready?.status === "ready" ? ready : null;
    }, "accepted MeetingStore transcript state", 60_000);
    // The existing transcript surface loads on open/refresh rather than
    // subscribing to provider completion; refresh the same UI control after
    // the authoritative store publication so the transcript panel is visible.
    await page.locator('[data-testid="meeting-refresh-button"]').click();
    await transcriptButton.click();
    await waitFor(() => page.locator('[data-testid="transcript-panel"]').isVisible(), "transcript panel after accepted store state");
    const finalState = await page.locator('[data-testid="global-recording-strip"]').innerText();
    const transcriptStatus = await store.getTranscriptForMeeting(storeSnapshot.meeting.id);
    if (!transcriptStatus) throw new Error("MeetingStore transcript disappeared after accepted UI state");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await context.tracing.stop({ path: tracePath });
    tracing = false;

    const output = storeSnapshot.recording.savedOutput;
    const mp3Identity = await fileIdentity(output.destination);
    const observation = {
      identity: {
        logicalDesktopId: runtimeUiTest.logicalDesktopId,
        runId: runtimeUiTest.runId,
        hostBundleIdentifier: runtimeUiTest.hostBundleIdentifier,
        hostBundlePath: runtimeUiTest.hostBundlePath,
        hostCdHash: runtimeUiTest.hostCdHash,
        hostPid: runtimeUiTest.hostPid,
        desktopPid: runtimeUiTest.desktopPid,
        electronPid,
        electronExecutable: processEvidence.electronExecutable,
        ancestry: processEvidence.ancestry,
        cdpAddress: runtimeUiTest.cdpAddress,
        cdpPort: runtimeUiTest.cdpPort,
      },
      renderer: {
        runId: markerInPage.runId,
        logicalDesktopId: markerInPage.logicalDesktopId,
        url: rendererUrl,
        title: await page.title(),
        titleEntered,
        startControlVisible,
        stopControlVisible,
        finalState,
        screenshotPath,
        tracePath,
        bridge: bridgeDaemonStatus,
      },
      socket: {
        runId: runtimeUiTest.runId,
        runtimeInstanceId: runtimeReady.runtime.instanceId,
        pluginPid: recordingReadiness.runtime.pluginPid,
        recordingId: recordingStatus.status.recordingId,
        meetingId: recordingStatus.status.meetingId,
        captureMode: recordingReadiness.runtime.capture.mode,
        uiTest: runtimeUiTest,
        postStopStatus: postStopStatus.status.status,
        statuses: socket.statuses,
      },
      store: {
        meetingId: storeSnapshot.meeting.id,
        recordingId: storeSnapshot.recording.id,
        title: storeSnapshot.meeting.title,
        recordingStatus: storeSnapshot.recording.status,
        savedOutput: output,
        transcript: {
          meetingId: transcriptStatus.meetingId,
          recordingId: transcriptStatus.recordingId,
          status: transcriptStatus.status,
          audio: transcriptStatus.audio,
          segments: transcriptStatus.checkpoints.map((checkpoint) => ({ text: checkpoint.text, segmentId: checkpoint.range.segmentId })),
        },
      },
      helper: {
        pid: helper.pid,
        pluginPid: helper.pluginPid,
        parentPid: helper.parentPid,
        recordingId: recordingStatus.status.recordingId,
        executable: helper.executable,
        arguments: helper.arguments,
      },
      chunks,
      mp3: { recordingId: storeSnapshot.recording.id, ...mp3Identity, destination: output.destination },
      transcription: {
        mode: providerMode,
        meetingId: transcriptStatus.meetingId,
        recordingId: transcriptStatus.recordingId,
        status: transcriptStatus.status,
        audio: transcriptStatus.audio,
        segments: transcriptStatus.checkpoints.map((checkpoint) => ({ text: checkpoint.text, segmentId: checkpoint.range.segmentId })),
      },
    };
    process.stderr.write(`[post-m3] ${providerMode}: renderer evidence ${JSON.stringify({ titleEntered, startControlVisible, stopControlVisible, finalState })}\n`);
    validatePostM3Correlation(observation, {
      hostBundleIdentifier: installedHost.bundleIdentifier,
      hostBundlePath: installedHost.bundleRealPath,
      hostCdHash: installedHost.cdHash,
      runtimeRoot: runtimeConfig.paths.root,
      listen: runtimeConfig.listen,
      electronExecutable: expectedElectronExecutable(),
    });
    return {
      mode: providerMode,
      status: "passed",
      label: providerMode === "fake" ? "deterministic-fixture-generated-source" : "native-provider-signed-host-capability",
      evidenceClass: providerMode === "fake" ? "generated-fixture-source" : "native-provider-signed-host-capability",
      physicalClick: false,
      liveSource: false,
      tcc: false,
      runId: envelope.runId,
      runtimeInstanceId: runtimeReady.runtime.instanceId,
      recordingId: recordingStatus.status.recordingId,
      meetingId: recordingStatus.status.meetingId,
      screenshot: screenshotPath,
      trace: tracePath,
      correlation: observation,
    };
  } catch (error) {
    return {
      mode: providerMode,
      status: "failed",
      label: providerMode === "fake" ? "deterministic-fixture-generated-source" : "native-provider-signed-host-capability",
      evidenceClass: providerMode === "fake" ? "generated-fixture-source" : "native-provider-failure",
      reason: describe(error),
      noFakeSubstitution: providerMode === "native",
      screenshot: screenshotPath,
      trace: tracePath,
    };
  } finally {
    if (tracing && browser) await browser.contexts()[0]?.tracing.stop({ path: tracePath }).catch(() => undefined);
    if (socket) await socket.close();
    if (browser) await browser.close().catch(() => undefined);
    await removeUiTestRunState(runtimeConfig.paths.root);
  }
}

async function launchExactHost() {
  await execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/launch-macos-host.mjs")], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function stopExactHost(executablePath) {
  const pids = exactHostPids(executablePath);
  if (pids.length === 0) return;
  if (pids.length !== 1) throw new Error(`Refusing to stop multiple exact MeetlessHost processes: ${pids.join(", ")}`);
  await execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/stop-macos-host.mjs")], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function ensureNoAmbiguousRuntime(runtimeConfig, installedHost) {
  await stopExactHost(installedHost.executablePath);
  const listener = await listenerPids(runtimeConfig.listen);
  if (listener.length > 0) {
    throw new Error(`Cannot stage post-M3 proof while non-host process owns ${runtimeConfig.listen}: ${listener.join(", ")}`);
  }
}

async function cleanupStagedRuntime(root) {
  await removeUiTestRunState(root);
  await rm(root, { recursive: true, force: true });
}

async function cleanupProofWorkspace(input) {
  const errors = [];
  let stagedRootRemoved = !input.staged;
  let originalRootRestored = !input.staged || !input.originalRootExisted;
  let runStateRemoved = !input.staged && !input.preserved;
  let liveHostPids = [];
  let hostInspectionFailed = false;
  try {
    liveHostPids = exactHostPids(input.hostExecutable);
  } catch (error) {
    hostInspectionFailed = true;
    errors.push(`cannot inspect exact host during cleanup: ${describe(error)}`);
  }
  if (hostInspectionFailed) {
    errors.push("refusing root cleanup because exact MeetlessHost liveness could not be verified");
  } else if (liveHostPids.length > 0) {
    errors.push(`refusing root cleanup while exact MeetlessHost remains live: ${liveHostPids.join(", ")}`);
  } else {
    if (input.staged) {
      try {
        await cleanupStagedRuntime(input.root);
        stagedRootRemoved = true;
        runStateRemoved = true;
      } catch (error) {
        errors.push(`staged runtime cleanup failed: ${describe(error)}`);
      }
    }
    if (input.preserved) {
      try {
        await rename(input.preservedRoot, input.root);
        originalRootRestored = true;
      } catch (error) {
        errors.push(`original runtime restore failed: ${describe(error)}`);
      }
    } else if (!input.originalRootExisted) {
      try {
        await rm(input.preservedRoot, { recursive: true, force: true });
        originalRootRestored = true;
      } catch (error) {
        errors.push(`unowned preserved-path cleanup failed: ${describe(error)}`);
      }
    }
  }
  return summarizePostM3Cleanup({
    root: input.root,
    preservedPath: input.preserved ? input.preservedRoot : null,
    originalRootExisted: input.originalRootExisted,
    staged: input.staged,
    stagedRootRemoved,
    originalRootRestored,
    runStateRemoved,
    liveHostPids,
    errors,
  });
}

async function waitForMarker(root, expectedRunId) {
  return waitFor(async () => {
    const marker = await readConsumedUiTestMarker(root);
    if (marker?.runId !== expectedRunId) throw new Error(`consumed marker is ${marker?.runId ?? "missing"}`);
    return marker;
  }, "consumed UI-test marker", 30_000);
}

async function connectOverCdp(endpoint, expectedRunId, rendererOrigin) {
  let lastError;
  let primed = false;
  process.stderr.write(`[post-m3] ${expectedRunId}: priming renderer CDP\n`);
  await primeRendererCdp(endpoint, rendererOrigin)
    .then(() => { primed = true; })
    .catch((error) => { lastError = error; });
  if (primed) process.stderr.write(`[post-m3] ${expectedRunId}: renderer CDP prime finished\n`);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 1_000 });
      // The host can expose CDP before its first renderer navigation. Keep the
      // attached browser alive and let findExactRendererPage wait for the
      // marker instead of closing the host-owned Electron process.
      return browser;
    } catch (error) {
      lastError = error;
      if (!primed) {
        primed = true;
        await primeRendererCdp(endpoint, rendererOrigin).catch((primeError) => { lastError = primeError; });
        process.stderr.write(`[post-m3] ${expectedRunId}: renderer CDP prime finished\n`);
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out attaching to exact host-owned CDP endpoint for ${expectedRunId}: ${describe(lastError)}`);
}

async function primeRendererCdp(endpoint, rendererOrigin) {
  const port = new URL(endpoint).port;
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page" && candidate.url.startsWith(rendererOrigin));
  if (!target?.webSocketDebuggerUrl) throw new Error("CDP preflight found no isolated renderer page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("renderer CDP preflight timed out")); }, 2_000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("open", () => {
      const navigateId = ++nextId;
      const enableId = ++nextId;
      const url = JSON.stringify(target.url);
      socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id === navigateId) socket.send(JSON.stringify({ id: enableId, method: "Runtime.enable" }));
        if (message.id === enableId) { clearTimeout(timer); resolve(); socket.close(); }
      });
      socket.send(JSON.stringify({ id: navigateId, method: "Page.navigate", params: { url: JSON.parse(url) } }));
    });
  });
}

async function findExactRendererPage(browser, expectedRunId, rendererOrigin) {
  return waitFor(async () => {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      if (!page.url().startsWith(rendererOrigin)) continue;
      const marker = rendererMarker(page.url());
      if (marker?.runId === expectedRunId && marker.logicalDesktopId === "com.meetless.desktop") return page;
    }
    throw new Error(`no page with the consumed run marker; observed pages: ${pages.map((page) => page.url()).join(" | ") || "none"}`);
  }, "exact host-owned renderer page", 30_000);
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

async function openRecordingSocket(socketPath) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`);
  const statuses = [];
  const pending = new Map();
  socket.on("message", (raw) => {
    let decoded;
    try { decoded = JSON.parse(raw.toString()); } catch { return; }
    const statusEvent = RecordingStatusEventSchema.safeParse(decoded);
    if (statusEvent.success) {
      statuses.push(statusEvent.data.status);
      return;
    }
    const request = decoded && typeof decoded === "object" ? pending.get(decoded.requestId) : undefined;
    if (request) {
      pending.delete(decoded.requestId);
      request.resolve(decoded);
    }
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return {
    socket,
    statuses,
    requestReadiness: (operation) => request(socket, pending, `post-m3-readiness-${randomUUID()}`, { version: 1, requestId: "pending", command: "runtime.readiness", operation }, true),
    waitForStatus: (predicate, timeout, label = "recording status") => waitFor(async () => {
      const eventStatus = statuses.find(predicate);
      if (eventStatus) return { status: eventStatus };
      const readiness = await request(socket, pending, `post-m3-status-${randomUUID()}`, {
        version: 1,
        requestId: "pending",
        command: "runtime.readiness",
        operation: "status",
      }, true);
      statuses.push(readiness.status);
      if (predicate(readiness.status)) return { status: readiness.status };
      throw new Error(`authoritative status is ${readiness.status.status}`);
    }, label, timeout),
    close: async () => { socket.close(); await new Promise((resolve) => socket.once("close", resolve)); },
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

async function waitForHelper(_socketPath, socket, readiness, recordingId) {
  return waitFor(async () => {
    const current = await socket.requestReadiness("status");
    const capture = current.runtime.capture;
    if (!capture.helperPid) throw new Error("capture helper is not live");
    const parentPid = processRow(capture.helperPid)?.ppid;
    if (!parentPid) throw new Error(`capture helper PID ${capture.helperPid} is not in the process table`);
    return {
      pid: capture.helperPid,
      pluginPid: current.runtime.pluginPid,
      parentPid,
      recordingId,
      executable: capture.executable.realPath,
      arguments: capture.arguments,
    };
  }, "live helper readiness", 20_000);
}

async function waitForChunks(runtimeConfig, socket, recordingId) {
  return waitFor(
    () => readChunkInventory(runtimeConfig, socket, recordingId),
    "microphone and system chunk inventory",
    30_000,
  );
}

async function readChunkInventory(runtimeConfig, socket, recordingId) {
  const readiness = await socket.requestReadiness("status");
  const status = readiness.status;
  if (status.recordingId !== recordingId || status.chunkCount < 2 || status.microphoneCount < 1 || status.systemCount < 1) {
    throw new Error(`chunk inventory is ${status.chunkCount}/${status.microphoneCount}/${status.systemCount}`);
  }
  const identities = await Promise.all(status.chunks.map(async (chunk) => ({
    storageKey: chunk.storageKey,
    byteLength: chunk.byteLength,
    sha256: chunk.sha256,
    source: chunk.source,
    observed: await fileIdentity(path.resolve(runtimeConfig.paths.meetingStore, chunk.storageKey)),
  })));
  if (identities.some((chunk) => chunk.observed.byteLength !== chunk.byteLength || chunk.observed.sha256 !== chunk.sha256)) {
    throw new Error("committed chunk identity changed before Stop");
  }
  return {
    recordingId,
    count: status.chunkCount,
    microphoneCount: status.microphoneCount,
    systemCount: status.systemCount,
    identities: identities.map(({ storageKey, byteLength, sha256, source }) => ({ storageKey, byteLength, sha256, source })),
  };
}

async function readSavedStore(store, meetingId, recordingId) {
  return waitFor(async () => {
    const meetings = await store.list();
    const meeting = meetings.find((candidate) => candidate.id === meetingId);
    const recordings = await store.listRecordings();
    const recording = recordings.find((candidate) => candidate.id === recordingId);
    if (!meeting || !recording || recording.status !== "saved" || !recording.savedOutput) throw new Error("store has not published saved state");
    return { meeting, recording };
  }, "MeetingStore saved state", 30_000);
}

async function readPublishedChunkInventory(storeRoot, pointer, recordingId) {
  if (!pointer) throw new Error("saved MeetingStore recording has no immutable inventory pointer");
  const identities = [];
  let microphoneCount = 0;
  let systemCount = 0;
  for await (const chunk of readInventory(storeRoot, pointer)) {
    identities.push({
      storageKey: chunk.storageKey,
      byteLength: chunk.byteLength,
      sha256: chunk.sha256,
      source: chunk.source,
    });
    if (chunk.source === "microphone") microphoneCount += 1;
    else systemCount += 1;
  }
  return {
    recordingId,
    count: identities.length,
    microphoneCount,
    systemCount,
    identities,
  };
}

async function waitForNativeProvider(socketPath) {
  return waitFor(async () => {
    const response = await nativeRequest(socketPath, { operation: "status" });
    if (response.status !== "configured") throw new Error(`native provider is ${response.status}`);
    return response.status;
  }, "signed host native provider readiness", 15_000).catch(() => "invalid");
}

function nativeRequest(socketPath, input) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", (error) => { socket.destroy(); reject(error); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        socket.destroy();
        if (response.requestId !== requestId) reject(new Error("native provider request identity mismatch"));
        else resolve(response);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify({ version: 1, requestId, ...input })}\n`));
  });
}

async function endpointPid(port) {
  return waitFor(async () => {
    const pids = await listenerPids(String(port));
    if (pids.length !== 1) throw new Error(`CDP endpoint has ${pids.length} listeners`);
    return pids[0];
  }, "run-scoped CDP listener", 10_000);
}

function exactAncestry(electronPid, hostPid, desktopPid, installedHost, expectedElectron) {
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
  if (ancestry[0] !== hostPid || ancestry[1] !== desktopPid || ancestry[ancestry.length - 1] !== electronPid) {
    throw new Error(`CDP endpoint PID ${electronPid} is not exact host ${hostPid} → desktop ${desktopPid} ancestry (${ancestry.join(" → ")})`);
  }
  const host = rows.get(hostPid);
  const desktop = rows.get(desktopPid);
  if (!host || host.ppid !== 1 || host.command !== installedHost.executablePath) {
    throw new Error(`CDP ancestry host PID ${hostPid} is not the exact installed MeetlessHost executable ${installedHost.executablePath}`);
  }
  const expectedDesktopCommand = `${installedHost.configuration.nodePath} ${installedHost.configuration.runtimeCliPath} desktop`;
  if (!desktop || desktop.ppid !== hostPid || desktop.command !== expectedDesktopCommand) {
    throw new Error(`CDP ancestry desktop PID ${desktopPid} is not the exact host-owned runtime desktop child ${expectedDesktopCommand}`);
  }
  const row = rows.get(electronPid);
  const observedElectron = electronExecutable(electronPid);
  if (!row || !row.command.includes("Electron") || path.resolve(observedElectron) !== path.resolve(expectedElectron)) {
    throw new Error(`CDP endpoint PID ${electronPid} is not the exact repository Electron executable ${expectedElectron}`);
  }
  return { ancestry, electronExecutable: observedElectron };
}

function expectedElectronExecutable() {
  return path.join(repositoryRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
}

function electronExecutable(pid) {
  const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt"], { encoding: "utf8" });
  const executable = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? "")
    .find((candidate) => candidate.endsWith("/Electron") && !candidate.includes("Helper"));
  return executable ?? processRow(pid)?.command.split(" ")[0] ?? "unknown";
}

function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function processRow(pid) { return processRows().find((row) => row.pid === pid); }

function exactHostPids(executablePath) {
  return processRows().filter((row) => row.ppid === 1 && row.command === executablePath).map((row) => row.pid);
}

async function listenerPids(listen) {
  const inspected = await execFileAsync("lsof", ["-nP", `-iTCP:${listen.includes(":") ? listen.slice(listen.lastIndexOf(":") + 1) : listen}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" }).catch((error) => {
    if (error.code === 1) return { stdout: "" };
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
  if (!port) throw new Error("Could not reserve a CDP port");
  return port;
}

async function waitFor(operation, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
      throw new Error(`${label} is not ready`);
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${describe(lastError)}`);
}

async function waitForVisible(locator, timeoutMs) {
  await waitFor(async () => {
    if (!(await locator.isVisible())) throw new Error("control is not visible");
    return true;
  }, "visible control", timeoutMs);
}

async function fileIdentity(filePath) {
  const bytes = await readFile(filePath);
  return { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assertDirectoryNotSymlink(candidate) {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to stage non-directory runtime root ${candidate}`);
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of ["MEETLESS_CAPTURE_MODE", "MEETLESS_TRANSCRIPTION_MODE", "MEETLESS_UI_TEST_MODE", "MEETLESS_UI_TEST_RUN_ID", "MEETLESS_UI_TEST_MARKER", "MEETLESS_UI_TEST_IDENTITY", "PASEO_ELECTRON_FLAGS"]) delete env[key];
  return env;
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function describe(error) { return error instanceof Error ? error.message : String(error); }
async function exists(candidate) { try { await access(candidate); return true; } catch { return false; } }
