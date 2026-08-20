import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import WebSocket from "ws";
import { connectMeetlessClient } from "@meetless/client";
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
import {
  M4_DISTRACTOR_MEETING_ID,
  M4_DISTRACTOR_SENTINEL,
  M4_EXPECTED_RANGES,
  M4_TARGET_MEETING_ID,
  M4_TARGET_RECORDING_ID,
  validateM4Observation,
  validateM4PublishedManifest,
} from "./m4-proof-validation.mjs";
import { validateM5Observation, validateM5PublishedManifest } from "./m5-proof-validation.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const providerArgument = process.argv[process.argv.indexOf("--provider") + 1] ?? "all";
const m5Journey = process.argv.includes("--m5");
const m4Journey = process.argv.includes("--m4") || m5Journey;
if (!["fake", "native", "all"].includes(providerArgument)) {
  throw new Error("Usage: node scripts/prove-post-m3.mjs --provider fake|native|all");
}
if (m4Journey && providerArgument !== "fake") {
  throw new Error("M4 generated composition proof requires --provider fake and never substitutes native evidence");
}

const runId = `${m5Journey ? "m5-proof" : m4Journey ? "m4-proof" : "post-m3-proof"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const config = resolveRuntimeConfig({ runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT, listen: process.env.MEETLESS_LISTEN });
const hostIdentity = await assertInstalledHostIdentity(config);
const preservedRoot = `${config.paths.root}.post-m3-preserved-${runId}`;
const originalRootExisted = await exists(config.paths.root);
const results = [];
let staged = false;
let preserved = false;
let fatalError = null;
let cleanupReport;
let originalRuntimeDigest = null;
let restoredRuntimeDigest = null;
let evidencePath = null;

try {
  await ensureNoAmbiguousRuntime(config, hostIdentity);
  originalRuntimeDigest = originalRootExisted ? await runtimeTreeDigest(config.paths.root) : null;
  if (originalRootExisted) {
    await assertDirectoryNotSymlink(config.paths.root);
    await rename(config.paths.root, preservedRoot);
    preserved = true;
  }
  staged = true;
  await mkdir(config.paths.root, { recursive: true, mode: 0o700 });

  for (const providerMode of providerArgument === "all" ? ["fake", "native"] : [providerArgument]) {
    const result = m4Journey
      ? await runM4Mode(config, hostIdentity, runId, m5Journey)
      : await runProviderMode(providerMode, config, hostIdentity, runId);
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
  restoredRuntimeDigest = originalRootExisted
    ? await runtimeTreeDigest(config.paths.root).catch(() => null)
    : (await exists(config.paths.root) ? "unexpected-runtime-root" : null);
}

const manifest = m4Journey ? await publishM4Result({
  runId,
  result: results[0],
  cleanupReport,
  originalRootExisted,
  originalRuntimeDigest,
  restoredRuntimeDigest,
  hostIdentity,
  m5Journey,
}).then((published) => {
  evidencePath = published.evidencePath;
  return published.manifest;
}).catch(async (error) => {
  if (results[0]?.evidenceStagingRoot) {
    await removeExactM4StagingRoot(results[0].evidenceStagingRoot, runId).catch(() => undefined);
  }
  return {
    schema: m5Journey ? "MEETLESS_M5_COMPOSITION_PROOF v1" : "MEETLESS_M4_COMPOSITION_PROOF v1",
    status: "failed",
    reason: describe(error),
    cleanup: privacySafeCleanup(cleanupReport, results[0]?.artifactCleanup),
    restoration: restorationSummary({ originalRootExisted, originalRuntimeDigest, restoredRuntimeDigest }),
  };
}) : {
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
if (evidencePath) process.stderr.write(`[${m5Journey ? "m5" : "m4"}] durable evidence ${evidencePath}\n`);
if (manifest.status !== "passed") process.exitCode = 1;

async function runM4Mode(runtimeConfig, installedHost, proofRunId, runM5) {
  const cdpPort = await reservePort();
  const envelope = newUiTestEnvelope({
    runId: `${proofRunId}-generated`,
    cdpPort,
    transcriptionMode: "fake",
    forceAccessibility: false,
  });
  const seeded = await seedM4Fixture(runtimeConfig);
  await writeUiTestEnvelope(runtimeConfig.paths.root, envelope);

  let browser = null;
  let recordingSocket = null;
  let connectedClient = null;
  const artifactRoot = path.join("/private/tmp", `meetless-${runM5 ? "m5" : "m4"}-${envelope.runId}`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const screenshotPath = path.join(artifactRoot, "screenshot.png");
  const clipPath = path.join(artifactRoot, "clicked-citation.mp3");
  const evidenceStagingRoot = path.join(repositoryRoot, "test", "evidence", runM5 ? "m5" : "m4", `.staging-${proofRunId}`);
  let result = null;
  try {
    process.stderr.write("[m4] launching exact installed host\n");
    await launchExactHost();
    const marker = await waitForMarker(runtimeConfig.paths.root, envelope.runId);
    browser = await connectOverCdp(`http://${envelope.cdpAddress}:${envelope.cdpPort}`, envelope.runId, runtimeConfig.rendererOrigin);
    const page = await findExactRendererPage(browser, envelope.runId, runtimeConfig.rendererOrigin);
    const electronPid = await endpointPid(envelope.cdpPort);
    exactAncestry(electronPid, marker.identity.hostPid, marker.identity.desktopPid, installedHost, expectedElectronExecutable());

    recordingSocket = await openRecordingSocket(runtimeConfig.paths.recordingSocket);
    const runtimeReady = await recordingSocket.requestReadiness("status");
    const runtimeUiTest = runtimeReady.runtime.uiTest;
    if (!runtimeUiTest || runtimeUiTest.runId !== envelope.runId || runtimeUiTest.hostCdHash !== installedHost.cdHash) {
      throw new Error("M4 recording socket does not independently attest the consumed host/run identity");
    }
    await waitForVisible(page.locator('[data-testid="connection-status"]'), 30_000);
    const bridge = await page.evaluate(async () => {
      const desktop = globalThis.paseoDesktop;
      const status = typeof desktop?.invoke === "function" ? await desktop.invoke("desktop_daemon_status") : null;
      return { platform: desktop?.platform ?? "", ...(status && typeof status === "object" ? status : {}) };
    });
    if (bridge.platform !== "darwin" || bridge.status !== "running" || bridge.desktopManaged !== true || bridge.listen !== runtimeConfig.listen || bridge.home !== runtimeConfig.paths.paseoHome) {
      throw new Error(`M4 renderer bridge does not identify the exact managed daemon (${JSON.stringify(bridge)})`);
    }

    connectedClient = await connectMeetlessClient({
      url: `ws://${runtimeConfig.listen}/ws`,
      clientId: `m4-proof-client-${Date.now()}`,
      clientType: "browser",
    });
    const rpcMeetings = await connectedClient.client.listMeetings();
    if (JSON.stringify(rpcMeetings.map((meeting) => meeting.id)) !== JSON.stringify([M4_DISTRACTOR_MEETING_ID, M4_TARGET_MEETING_ID])) {
      throw new Error(`M4 RPC meeting list differs from the seeded pair (${rpcMeetings.map((meeting) => meeting.id).join(", ")})`);
    }

    const distractorRow = page.locator(`[data-testid="meeting-${M4_DISTRACTOR_MEETING_ID}"]`);
    const targetRow = page.locator(`[data-testid="meeting-${M4_TARGET_MEETING_ID}"]`);
    await waitFor(() => Promise.all([distractorRow.isVisible(), targetRow.isVisible()]).then((values) => values.every(Boolean)), "both M4 sidebar meetings");
    await targetRow.click();
    await waitFor(() => page.locator('[data-testid="transcript-ready"]').isVisible(), "M4 target ready transcript");
    const selectionAttributes = await targetRow.evaluate((element) => ({
      ariaCurrent: element.getAttribute("aria-current"),
      ariaPressed: element.getAttribute("aria-pressed"),
      ariaSelected: element.getAttribute("aria-selected"),
      dataSelected: element.getAttribute("data-selected"),
      role: element.getAttribute("role"),
    }));
    process.stderr.write(`[m4] target accessibility ${JSON.stringify(selectionAttributes)}\n`);
    const selectedAccessibility = selectionAttributes.ariaSelected === "true";
    const detail = page.locator('[data-testid="meeting-detail"]');
    const detailText = await detail.innerText();
    if (!detailText.includes(seeded.targetTitle)) throw new Error("M4 detail does not expose the selected target title");

    const store = new MeetingStore({ root: runtimeConfig.paths.meetingStore });
    const authoritative = await store.getTranscriptForMeeting(M4_TARGET_MEETING_ID);
    if (!authoritative || authoritative.status !== "ready") throw new Error("M4 authoritative transcript is not ready");
    const rpcResult = await connectedClient.client.getMeetingTranscript(M4_TARGET_MEETING_ID);
    if (!rpcResult.transcript) throw new Error("M4 transcript RPC returned no target transcript");
    const authoritativeSegments = authoritative.checkpoints.map((checkpoint) => ({
      ordinal: checkpoint.range.ordinal,
      startMs: checkpoint.range.startMs,
      endMs: checkpoint.range.endMs,
      segmentId: checkpoint.range.segmentId,
      text: checkpoint.text,
    }));
    const rpcSegments = rpcResult.transcript.segments.map((segment) => ({
      ordinal: segment.range.ordinal,
      startMs: segment.range.startMs,
      endMs: segment.range.endMs,
      segmentId: segment.range.segmentId,
      text: segment.text,
    }));
    const renderedSegments = await readRenderedSegments(page);
    const third = authoritativeSegments[2];
    if (!third) throw new Error("M4 authoritative transcript has no third segment");
    const citation = await connectedClient.client.resolveCitation({ meetingId: M4_TARGET_MEETING_ID, segmentId: third.segmentId });

    await installAudioObserver(page);
    await page.locator(`[data-testid="citation-${third.segmentId}"]`).click();
    const playback = await waitFor(() => page.evaluate(() => {
      const value = globalThis.__meetlessM4AudioObservation;
      if (!value?.playResolved || value.maximumCurrentTime < 0.2) throw new Error("browser Audio has not advanced");
      return value;
    }), "browser Audio time advancement", 10_000);
    const stoppedPlayback = await waitFor(() => page.evaluate(() => {
      const value = globalThis.__meetlessM4AudioObservation;
      if (!value?.boundedStopObserved) throw new Error("bounded browser Audio stop not observed");
      return value;
    }), "bounded browser Audio stop", 10_000);
    const source = stoppedPlayback.source;
    if (typeof source !== "string" || !source.startsWith("data:audio/mpeg;base64,")) throw new Error("M4 browser Audio source is not a bounded MP3 data URL");
    const clipBytes = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
    const rpcClipBytes = Buffer.from(citation.audio.base64, "base64");
    if (sha256(clipBytes) !== sha256(rpcClipBytes)) throw new Error("M4 browser Audio payload differs from the authoritative citation RPC payload");
    await writeFile(clipPath, clipBytes, { flag: "wx", mode: 0o600 });
    const clipAnalysis = await analyzeClip(runtimeConfig, clipPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await mkdir(path.dirname(evidenceStagingRoot), { recursive: true, mode: 0o755 });
    await mkdir(evidenceStagingRoot, { recursive: false, mode: 0o755 });
    await copyFile(screenshotPath, path.join(evidenceStagingRoot, "screenshot.png"));
    const stagedScreenshot = await stat(path.join(evidenceStagingRoot, "screenshot.png"));
    if (!stagedScreenshot.isFile() || stagedScreenshot.size <= 0) throw new Error("M4 screenshot was not durably staged before artifact cleanup");

    let chatObservation = null;
    if (runM5) {
      await recordingSocket.close();
      recordingSocket = null;
      const journey = await runM5ChatJourney({
        browser,
        client: connectedClient,
        installedHost,
        page,
        proofRunId,
        runtimeConfig,
        screenshotPath,
        targetSegment: third,
        transcriptRangeCount: authoritativeSegments.length,
      });
      browser = journey.browser;
      connectedClient = journey.client;
      chatObservation = journey.observation;
      await copyFile(screenshotPath, path.join(evidenceStagingRoot, "screenshot.png"));
    }

    const observation = {
      schema: runM5 ? "MEETLESS_M5_COMPOSITION_OBSERVATION v1" : "MEETLESS_M4_COMPOSITION_OBSERVATION v1",
      evidencePolicy: { generatedFixture: true, liveSource: false, nativeProvider: false, fakeNativeSubstitution: false },
      identity: { exactInstalledHost: true, exactRunMarker: true, trustedRendererBridge: true },
      sidebar: {
        meetingIds: rpcMeetings.map((meeting) => meeting.id),
        selectedMeetingId: M4_TARGET_MEETING_ID,
        selectedAccessibility,
        detailMeetingId: detailText.includes(seeded.targetTitle) ? M4_TARGET_MEETING_ID : "mismatch",
      },
      authoritativeTranscript: { meetingId: authoritative.meetingId, recordingId: authoritative.recordingId, segments: authoritativeSegments },
      rpcTranscript: { meetingId: rpcResult.transcript.meetingId, recordingId: rpcResult.transcript.recordingId, segments: rpcSegments },
      renderedTranscript: { segments: renderedSegments, distractorSentinelPresent: detailText.includes(M4_DISTRACTOR_SENTINEL) },
      citation: {
        meetingId: citation.meetingId, recordingId: citation.recordingId, segmentId: citation.segmentId,
        text: citation.text, startMs: citation.startMs, endMs: citation.endMs,
      },
      playback: {
        audioAccepted: stoppedPlayback.audioAccepted === true,
        playResolved: stoppedPlayback.playResolved === true,
        maximumCurrentTime: stoppedPlayback.maximumCurrentTime,
        boundedStopObserved: stoppedPlayback.boundedStopObserved === true,
        clipDurationSeconds: clipAnalysis.durationSeconds,
        markerHz: clipAnalysis.markerHz,
        markerPowerRatio: clipAnalysis.markerPowerRatio,
      },
      ...(chatObservation ? { chat: chatObservation } : {}),
    };
    if (runM5) validateM5Observation(observation);
    else validateM4Observation(observation);
    result = {
      mode: runM5 ? "m5-generated-real-codex" : "m4-generated",
      status: "passed",
      observation,
      evidenceStagingRoot,
    };
  } catch (error) {
    result = { mode: "m4-generated", status: "failed", reason: describe(error) };
  } finally {
    if (connectedClient) await connectedClient.close().catch(() => undefined);
    if (recordingSocket) await recordingSocket.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await removeUiTestRunState(runtimeConfig.paths.root).catch(() => undefined);
    const artifactCleanup = await removeExactM4ArtifactRoot(artifactRoot, envelope.runId);
    result ??= { mode: "m4-generated", status: "failed", reason: "M4 proof produced no result" };
    result.artifactCleanup = artifactCleanup;
    if (artifactCleanup.status !== "passed") {
      result.status = "failed";
      result.reason = `M4 proof artifact cleanup failed: ${artifactCleanup.error}`;
    }
    if (result.status !== "passed" && await exists(evidenceStagingRoot)) {
      await removeExactM4StagingRoot(evidenceStagingRoot, proofRunId).catch(() => undefined);
    }
  }
  return result;
}

async function runM5ChatJourney(input) {
  const providers = await input.client.client.listChatProviders();
  const codex = providers.providers.find((provider) => provider.id === "codex");
  if (!codex) throw new Error(`M5 real composition did not discover Codex (${providers.providers.map((provider) => provider.id).join(", ")})`);
  const model = codex.models.find((candidate) => candidate.isDefault) ?? codex.models[0];
  if (!model) throw new Error("M5 Codex discovery returned no selectable model");
  await waitFor(() => input.page.locator('[data-testid="meeting-chat"]').isVisible(), "M5 chat panel");
  await input.page.getByTestId(`chat-model-${codex.id}-${model.id}`).click();
  await input.page.getByTestId("chat-question-input").fill("Which interval contains eight hundred eighty hertz?");
  await input.page.getByTestId("chat-ask").click();
  const supportedThread = await waitForChatTerminal(input.client, M4_TARGET_MEETING_ID, 180_000);
  const supported = supportedThread.messages.at(-1);
  if (!supported || supported.role !== "assistant" || supported.outcome !== "supported") {
    throw new Error(`M5 fixture question did not return a supported answer (${JSON.stringify(supportedThread.failure)})`);
  }
  if (!supported.citations.some((citation) => citation.segmentId === input.targetSegment.segmentId)) {
    throw new Error(`M5 supported answer did not cite the expected third segment (${supported.citations.map((citation) => citation.segmentId).join(", ")})`);
  }
  await waitFor(() => input.page.getByTestId(`chat-citation-${input.targetSegment.segmentId}`).isVisible(), "M5 rendered supported citation", 30_000);
  await input.page.evaluate(() => { globalThis.__meetlessM4AudioObservation = null; });
  await input.page.getByTestId(`chat-citation-${input.targetSegment.segmentId}`).click();
  const playback = await waitFor(() => input.page.evaluate(() => {
    const value = globalThis.__meetlessM4AudioObservation;
    if (!value?.boundedStopObserved) throw new Error("M5 chat citation playback has not stopped at its bound");
    return value;
  }), "M5 chat citation bounded playback", 15_000);
  const source = playback.source;
  if (typeof source !== "string" || !source.startsWith("data:audio/mpeg;base64,")) {
    throw new Error("M5 chat citation did not use bounded MP3 playback");
  }
  const chatClipPath = path.join(path.dirname(input.screenshotPath), "chat-citation.mp3");
  await writeFile(chatClipPath, Buffer.from(source.slice(source.indexOf(",") + 1), "base64"), { flag: "wx", mode: 0o600 });
  const clipAnalysis = await analyzeClip(input.runtimeConfig, chatClipPath);

  await input.client.close();
  await input.browser.close();
  await stopExactHost(input.installedHost.executablePath);
  await removeUiTestRunState(input.runtimeConfig.paths.root).catch(() => undefined);

  const restartEnvelope = newUiTestEnvelope({
    runId: `${input.proofRunId}-restart`,
    cdpPort: await reservePort(),
    transcriptionMode: "fake",
    forceAccessibility: false,
  });
  await writeUiTestEnvelope(input.runtimeConfig.paths.root, restartEnvelope);
  let browser = null;
  let client = null;
  try {
    await launchExactHost();
    const marker = await waitForMarker(input.runtimeConfig.paths.root, restartEnvelope.runId);
    browser = await connectOverCdp(`http://${restartEnvelope.cdpAddress}:${restartEnvelope.cdpPort}`, restartEnvelope.runId, input.runtimeConfig.rendererOrigin);
    const page = await findExactRendererPage(browser, restartEnvelope.runId, input.runtimeConfig.rendererOrigin);
    const electronPid = await endpointPid(restartEnvelope.cdpPort);
    exactAncestry(electronPid, marker.identity.hostPid, marker.identity.desktopPid, input.installedHost, expectedElectronExecutable());
    client = await connectMeetlessClient({
      url: `ws://${input.runtimeConfig.listen}/ws`,
      clientId: `m5-restart-proof-${Date.now()}`,
      clientType: "browser",
    });
    await waitForVisible(page.locator('[data-testid="connection-status"]'), 30_000);
    const targetRow = page.locator(`[data-testid="meeting-${M4_TARGET_MEETING_ID}"]`);
    await waitFor(() => targetRow.isVisible(), "M5 target after restart");
    await targetRow.click();
    await waitFor(() => page.locator('[data-testid="transcript-ready"]').isVisible(), "M5 transcript after restart");
    await waitFor(() => page.locator('[data-testid="meeting-chat"]').isVisible(), "M5 chat after restart");
    const restoredText = await page.getByTestId("chat-messages").innerText();
    const historyRestored = restoredText.includes(supported.text);
    if (!historyRestored) throw new Error("M5 supported history was not restored after full host restart");

    await page.getByTestId("chat-question-input").fill("What insurance premium did the team approve for a Mars launch?");
    await page.getByTestId("chat-ask").click();
    const unsupportedThread = await waitForChatTerminal(client, M4_TARGET_MEETING_ID, 180_000);
    const unsupported = unsupportedThread.messages.at(-1);
    if (!unsupported || unsupported.role !== "assistant" || unsupported.outcome !== "insufficient_evidence") {
      throw new Error(`M5 unsupported question did not return insufficient evidence (${JSON.stringify(unsupportedThread.failure)})`);
    }
    const canonicalRendered = await waitFor(async () =>
      (await page.getByTestId("chat-messages").innerText()).includes("The meeting does not contain enough evidence."),
    "M5 canonical insufficient-evidence text", 30_000);
    const persisted = await readFile(path.join(input.runtimeConfig.paths.meetingStore, "meetings.json"), "utf8");
    const noPaseoIdentityPersisted = !/(?:agentId|workspaceId|sessionId|timeline|paseo-agent)/u.test(persisted);
    await page.screenshot({ path: input.screenshotPath, fullPage: true });
    return {
      browser,
      client,
      observation: {
        realCodex: true,
        provider: codex.id,
        model: model.id,
        transcriptRangeCount: input.transcriptRangeCount,
        supported: {
          outcome: supported.outcome,
          text: supported.text,
          citationSegmentIds: supported.citations.map((citation) => citation.segmentId),
        },
        citationPlayback: {
          boundedStopObserved: playback.boundedStopObserved === true,
          markerHz: clipAnalysis.markerHz,
          markerPowerRatio: clipAnalysis.markerPowerRatio,
        },
        restart: { exactInstalledHost: true, historyRestored },
        unsupported: {
          outcome: unsupported.outcome,
          text: unsupported.text,
          citationSegmentIds: unsupported.citations.map((citation) => citation.segmentId),
          canonicalRendered: canonicalRendered === true,
        },
        noPaseoIdentityPersisted,
      },
    };
  } catch (error) {
    if (client) await client.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    throw error;
  }
}

async function waitForChatTerminal(client, meetingId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const thread = await client.client.getMeetingChat(meetingId);
    if (thread?.status === "ready") return thread;
    if (thread?.status === "failed") throw new Error(`M5 chat failed: ${thread.failure?.message ?? "unknown failure"}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for M5 chat after ${timeoutMs}ms`);
}

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
    const meetingRow = page.locator(`[data-testid="meeting-${storeSnapshot.meeting.id}"]`);
    await waitFor(() => meetingRow.isVisible(), "meeting row");
    await meetingRow.click();
    const consent = page.locator('[data-testid="transcription-consent"]');
    await waitFor(() => consent.isVisible(), "transcription consent control");
    await consent.click();
    await waitFor(async () => {
      const ready = await store.getTranscriptForMeeting(storeSnapshot.meeting.id);
      return ready?.status === "ready" ? ready : null;
    }, "accepted MeetingStore transcript state", 60_000);
    // The transcript surface loads on open/refresh rather than subscribing to
    // provider completion; refresh and select the same meeting row after the
    // authoritative store publication so the ready state is visible.
    await page.locator('[data-testid="meeting-refresh-button"]').click();
    await meetingRow.click();
    await waitFor(() => page.locator('[data-testid="transcript-ready"]').isVisible(), "ready transcript state after accepted store state");
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

async function seedM4Fixture(runtimeConfig) {
  const store = new MeetingStore({ root: runtimeConfig.paths.meetingStore });
  const fixtureDirectory = path.join(runtimeConfig.paths.meetingStore, "m4-generated-fixture");
  const sessionDirectory = path.join(runtimeConfig.paths.meetingStore, "sessions", M4_TARGET_RECORDING_ID);
  await Promise.all([
    mkdir(fixtureDirectory, { recursive: true, mode: 0o700 }),
    mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const targetAudio = path.join(fixtureDirectory, "target-65s.mp3");
  await execFileAsync(runtimeConfig.environment.MEETLESS_FFMPEG, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=16000",
    "-f", "lavfi", "-i", "sine=frequency=660:duration=30:sample_rate=16000",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=5:sample_rate=16000",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", targetAudio,
  ], { maxBuffer: 2 * 1024 * 1024 });
  await chmod(targetAudio, 0o600);
  const outputIdentity = await fileIdentity(targetAudio);

  await store.create({ id: M4_DISTRACTOR_MEETING_ID, title: M4_DISTRACTOR_SENTINEL });
  const targetTitle = "M4 ordered transcript target";
  await store.create({ id: M4_TARGET_MEETING_ID, title: targetTitle });
  await store.startRecording({ id: M4_TARGET_RECORDING_ID, meetingId: M4_TARGET_MEETING_ID });

  const chunkPath = path.join(sessionDirectory, "fixture-source.wav");
  const chunkBytes = oneFrameWav();
  await writeFile(chunkPath, chunkBytes, { flag: "wx", mode: 0o600 });
  const chunkStats = await stat(chunkPath);
  const chunk = {
    id: "m4-proof-source",
    source: "microphone",
    storageKey: path.relative(runtimeConfig.paths.meetingStore, chunkPath),
    byteLength: chunkBytes.byteLength,
    sha256: sha256(chunkBytes),
    committedAt: chunkStats.mtime.toISOString(),
    logicalStartMs: 0,
    durationMs: 1,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
  await store.commitChunk(M4_TARGET_RECORDING_ID, chunk);
  await store.prepareInventoryRecovery(M4_TARGET_RECORDING_ID, "M4 generated fixture capture is complete");
  await store.markInventoryScanning(M4_TARGET_RECORDING_ID);
  const inventoryBytes = Buffer.from(`${JSON.stringify(chunk)}\n`);
  const inventoryPath = path.join(sessionDirectory, "inventory.ndjson");
  await writeFile(inventoryPath, inventoryBytes, { flag: "wx", mode: 0o600 });
  const pointer = {
    storageKey: path.relative(runtimeConfig.paths.meetingStore, inventoryPath),
    digest: sha256(inventoryBytes),
    chunkCount: 1,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: new Date().toISOString(),
  };
  await store.publishInventory(M4_TARGET_RECORDING_ID, pointer);
  await store.beginFinalization(M4_TARGET_RECORDING_ID, {
    openChunksDurablyClosed: true,
    chunkSetDigest: pointer.digest,
    destination: targetAudio,
    expectedIdentity: outputIdentity,
  });
  await store.markRecordingSaved(M4_TARGET_RECORDING_ID, { destination: targetAudio, identity: outputIdentity, readable: true });
  await store.grantTranscriptionConsent();
  let transcript = await store.ensureTranscript({
    meetingId: M4_TARGET_MEETING_ID,
    recordingId: M4_TARGET_RECORDING_ID,
    audio: { destination: targetAudio, ...outputIdentity, durationMs: 65_000 },
  });
  if (JSON.stringify(transcript.ranges.map(({ ordinal, startMs, endMs }) => ({ ordinal, startMs, endMs }))) !== JSON.stringify(M4_EXPECTED_RANGES.map(({ ordinal, startMs, endMs }) => ({ ordinal, startMs, endMs })))) {
    throw new Error("MeetingStore did not plan the exact three default M3 ranges for the 65-second fixture");
  }
  for (const expected of M4_EXPECTED_RANGES) {
    const request = await store.beginTranscriptRequest(transcript.id);
    if (!request || request.range.ordinal !== expected.ordinal) throw new Error(`MeetingStore did not expose transcript range ${expected.ordinal} in order`);
    transcript = await store.checkpointTranscriptRange(transcript.id, {
      range: request.range,
      text: expected.text,
      attempts: request.attempt,
      usage: { durationSeconds: (request.range.endMs - request.range.startMs) / 1_000 },
      detectedLanguages: ["en"],
    });
  }
  transcript = await store.publishTranscript(transcript.id);
  if (transcript.status !== "ready" || transcript.checkpoints.length !== 3) throw new Error("MeetingStore did not publish the complete three-segment M4 transcript");
  return { targetTitle };
}

async function readRenderedSegments(page) {
  const locators = page.locator('[data-testid^="transcript-segment-"]');
  const count = await locators.count();
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const segment = locators.nth(index);
    const testId = await segment.getAttribute("data-testid");
    const segmentId = testId?.slice("transcript-segment-".length) ?? "";
    const timestamp = (await segment.locator(`[data-testid="citation-${segmentId}"]`).innerText()).trim();
    const parsed = parseRenderedRange(timestamp);
    const fullText = (await segment.innerText()).trim();
    const text = fullText.startsWith(timestamp) ? fullText.slice(timestamp.length).trim() : fullText;
    result.push({ ordinal: index, startMs: parsed.startMs, endMs: parsed.endMs, segmentId, text });
  }
  return result;
}

function parseRenderedRange(value) {
  const match = /^(\d{2}):(\d{2})–(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error(`M4 rendered timestamp is not MM:SS–MM:SS (${value})`);
  return {
    startMs: (Number(match[1]) * 60 + Number(match[2])) * 1_000,
    endMs: (Number(match[3]) * 60 + Number(match[4])) * 1_000,
  };
}

async function installAudioObserver(page) {
  await page.evaluate(() => {
    const NativeAudio = globalThis.Audio;
    globalThis.__meetlessM4AudioObservation = null;
    globalThis.Audio = function observedMeetlessAudio(source) {
      const audio = new NativeAudio(source);
      const observation = {
        source: typeof source === "string" ? source : "",
        audioAccepted: true,
        playResolved: false,
        maximumCurrentTime: 0,
        boundedStopObserved: false,
      };
      globalThis.__meetlessM4AudioObservation = observation;
      const originalPlay = audio.play.bind(audio);
      const originalPause = audio.pause.bind(audio);
      audio.play = async () => {
        await originalPlay();
        observation.playResolved = true;
      };
      audio.pause = () => {
        observation.maximumCurrentTime = Math.max(observation.maximumCurrentTime, Number(audio.currentTime) || 0);
        if (observation.maximumCurrentTime >= 4.7) observation.boundedStopObserved = true;
        originalPause();
      };
      audio.addEventListener("timeupdate", () => {
        observation.maximumCurrentTime = Math.max(observation.maximumCurrentTime, Number(audio.currentTime) || 0);
      });
      return audio;
    };
  });
}

async function analyzeClip(runtimeConfig, clipPath) {
  const probe = await execFileAsync(runtimeConfig.environment.MEETLESS_FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", clipPath,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const durationSeconds = Number(probe.stdout.trim());
  const decoded = await execFileAsync(runtimeConfig.environment.MEETLESS_FFMPEG, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-i", clipPath,
    "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  const samples = new Int16Array(decoded.stdout.buffer, decoded.stdout.byteOffset, Math.floor(decoded.stdout.byteLength / 2));
  const powers = [440, 660, 880].map((frequency) => ({ frequency, power: tonePower(samples, 16_000, frequency) }));
  powers.sort((left, right) => right.power - left.power);
  return {
    durationSeconds: Number(durationSeconds.toFixed(3)),
    markerHz: powers[0]?.frequency ?? 0,
    markerPowerRatio: Number((powers[0].power / Math.max(1, powers[1].power)).toFixed(2)),
  };
}

function tonePower(samples, sampleRate, frequency) {
  let sine = 0;
  let cosine = 0;
  const stride = Math.max(1, Math.floor(samples.length / 160_000));
  for (let index = 0; index < samples.length; index += stride) {
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    sine += samples[index] * Math.sin(angle);
    cosine += samples[index] * Math.cos(angle);
  }
  return sine * sine + cosine * cosine;
}

async function publishM4Result(input) {
  if (input.result?.status !== "passed") throw new Error(input.result?.reason ?? "M4 real-composition observation failed");
  const restoration = restorationSummary(input);
  const safeCleanup = privacySafeCleanup(input.cleanupReport, input.result.artifactCleanup);
  const manifest = {
    schema: input.m5Journey ? "MEETLESS_M5_COMPOSITION_PROOF v1" : "MEETLESS_M4_COMPOSITION_PROOF v1",
    status: "passed",
    frontierId: input.m5Journey ? "M5-PROOF" : "M4-PROOF",
    runId: input.runId,
    acceptedHost: { bundleIdentifier: input.hostIdentity.bundleIdentifier, cdHash: input.hostIdentity.cdHash, launchRoute: "LaunchServices" },
    observation: input.result.observation,
    cleanup: safeCleanup,
    restoration,
    evidence: { screenshot: "screenshot.png" },
    evidenceLimit: "Machine-observed browser Audio playback only; this does not prove that a human heard speaker output.",
  };
  if (input.m5Journey) validateM5PublishedManifest(manifest);
  else validateM4PublishedManifest(manifest);
  const evidenceRoot = path.join(repositoryRoot, "test", "evidence", input.m5Journey ? "m5" : "m4", input.runId);
  await assertExactM4StagingRoot(input.result.evidenceStagingRoot, input.runId);
  try {
    if (await exists(evidenceRoot)) throw new Error("Refusing to replace an existing M4 evidence root");
    await writeFile(path.join(input.result.evidenceStagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(input.result.evidenceStagingRoot, evidenceRoot);
    return { manifest, evidencePath: path.relative(repositoryRoot, evidenceRoot) };
  } catch (error) {
    await removeExactM4StagingRoot(input.result.evidenceStagingRoot, input.runId).catch(() => undefined);
    throw error;
  }
}

function restorationSummary(input) {
  return {
    originalRootExisted: input.originalRootExisted,
    matched: input.originalRootExisted
      ? input.originalRuntimeDigest !== null && input.originalRuntimeDigest === input.restoredRuntimeDigest
      : input.restoredRuntimeDigest === null,
    beforeDigest: input.originalRuntimeDigest,
    afterDigest: input.restoredRuntimeDigest,
  };
}

function privacySafeCleanup(report, artifactCleanup) {
  return {
    status: report?.status ?? "failed",
    stagedRootRemoved: report?.stagedRootRemoved === true,
    originalRootRestored: report?.originalRootRestored === true,
    runStateRemoved: report?.runStateRemoved === true,
    proofArtifactRootRemoved: artifactCleanup?.status === "passed" && artifactCleanup?.absent === true,
    liveHostPids: Array.isArray(report?.liveHostPids) ? report.liveHostPids : [],
    errors: Array.isArray(report?.errors) ? report.errors.map((error) => String(error).replaceAll(repositoryRoot, "<repository>")) : [],
  };
}

async function removeExactM4ArtifactRoot(artifactRoot, envelopeRunId) {
  const match = /^(m4|m5)-proof-\d{13}-[0-9a-f]{8}-generated$/u.exec(envelopeRunId);
  const expectedRoot = path.join("/private/tmp", `meetless-${match?.[1] ?? "invalid"}-${envelopeRunId}`);
  if (!match || artifactRoot !== expectedRoot) {
    return { status: "failed", absent: false, error: "artifact identity does not match the exact generated M4 run" };
  }
  try {
    const info = await lstat(artifactRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { status: "failed", absent: false, error: "artifact root is not an owned non-symlink directory" };
    }
    await rm(artifactRoot, { recursive: true, force: false });
    const absent = !(await exists(artifactRoot));
    return absent
      ? { status: "passed", absent: true, error: null }
      : { status: "failed", absent: false, error: "artifact root remained after exact removal" };
  } catch (error) {
    if (!(await exists(artifactRoot))) return { status: "passed", absent: true, error: null };
    return { status: "failed", absent: false, error: describe(error) };
  }
}

async function assertExactM4StagingRoot(stagingRoot, proofRunId) {
  const match = /^(m4|m5)-proof-\d{13}-[0-9a-f]{8}$/u.exec(proofRunId);
  const expectedRoot = path.join(repositoryRoot, "test", "evidence", match?.[1] ?? "invalid", `.staging-${proofRunId}`);
  if (!match || stagingRoot !== expectedRoot) {
    throw new Error("Refusing publication from a non-exact M4 staging root");
  }
  const info = await lstat(stagingRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("M4 staging root is not an owned non-symlink directory");
  const children = (await readdir(stagingRoot)).sort();
  if (JSON.stringify(children) !== JSON.stringify(["screenshot.png"])) {
    throw new Error(`M4 staging root contains unexpected files: ${children.join(", ")}`);
  }
  const screenshot = await lstat(path.join(stagingRoot, "screenshot.png"));
  if (!screenshot.isFile() || screenshot.isSymbolicLink() || screenshot.size <= 0) {
    throw new Error("M4 staged screenshot is not a non-empty regular file");
  }
}

async function removeExactM4StagingRoot(stagingRoot, proofRunId) {
  const match = /^(m4|m5)-proof-\d{13}-[0-9a-f]{8}$/u.exec(proofRunId);
  const expectedRoot = path.join(repositoryRoot, "test", "evidence", match?.[1] ?? "invalid", `.staging-${proofRunId}`);
  if (!match || stagingRoot !== expectedRoot) {
    throw new Error("Refusing cleanup for a non-exact M4 staging root");
  }
  if (!(await exists(stagingRoot))) return;
  const info = await lstat(stagingRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing cleanup for a non-directory M4 staging root");
  await rm(stagingRoot, { recursive: true, force: false });
}

async function runtimeTreeDigest(root) {
  const entries = [];
  async function visit(current, relative) {
    const info = await lstat(current);
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      entries.push({ path: relative || ".", type: "directory", mode });
      const children = await readdir(current);
      children.sort();
      for (const child of children) await visit(path.join(current, child), path.join(relative, child));
    } else if (info.isFile()) {
      entries.push({ path: relative, type: "file", mode, byteLength: info.size, sha256: sha256(await readFile(current)) });
    } else if (info.isSymbolicLink()) {
      entries.push({ path: relative, type: "symlink", mode, target: await readlink(current) });
    } else {
      entries.push({ path: relative, type: "other", mode });
    }
  }
  await visit(root, "");
  return sha256(Buffer.from(JSON.stringify(entries)));
}

function oneFrameWav() {
  const data = Buffer.alloc(46);
  data.write("RIFF", 0); data.writeUInt32LE(38, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(2, 40); data.writeInt16LE(0, 44);
  return data;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

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
