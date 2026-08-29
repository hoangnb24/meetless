import { randomUUID } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import type { MeetingDeleteStoreResult } from "@meetless/meeting-store";
import { RecordingService } from "./recording-service.js";
import { RecordingControlServer } from "./control-server.js";
import { assertProductionHostProvenance } from "./production-host.js";
import { FfmpegAudioInspector, TranscriptionService } from "./transcription-service.js";
import {
  DeterministicFixtureTranscriptionProvider,
  NativeOpenAiTranscriptionProvider,
  UnixSocketNativeTranscriptionTransport,
  type TranscriptionProvider,
} from "./transcription-provider.js";
import { CitationPlaybackService, FfmpegCitationClipEncoder } from "./citation-playback.js";
import { PrivateAudioSnapshotStore } from "./private-audio-snapshot.js";
import { UiTestIdentitySchema, type UiTestIdentity } from "./readiness-protocol.js";
import type { PluginHandlerContext } from "@paseo/plugin";
import {
  MeetingChatService,
  PaseoMeetingChatAgentPort,
  resolveChatExecutionRoot,
} from "./chat-service.js";
import { MeetingLifecycleCoordinator, type MeetingWorkKind } from "./meeting-lifecycle-coordinator.js";
import { listRecordingOwnedStagePaths } from "./finalizer.js";

let store: MeetingStore | null = null;
let recordingService: RecordingService | null = null;
let controlServer: RecordingControlServer | null = null;
let transcriptionService: TranscriptionService | null = null;
let citationPlaybackService: CitationPlaybackService | null = null;
let recordingStart: Promise<void> | null = null;
let runtimeIdentity: { instanceId: string; startedAt: string; uiTest: UiTestIdentity | null } | null = null;
let chatService: MeetingChatService | null = null;
const meetingLifecycle = new MeetingLifecycleCoordinator();

export async function deleteMeetingSafely(
  meetingStore: Pick<MeetingStore, "deleteMeeting">,
  meetingId: string,
  activity: { transcription?: boolean; ask?: boolean } = {},
): Promise<MeetingDeleteStoreResult> {
  if (activity.transcription) return { meetingId, outcome: "refused", reason: "transcription" };
  if (activity.ask) return { meetingId, outcome: "refused", reason: "ask" };
  return meetingStore.deleteMeeting(meetingId);
}

export function deleteMeeting(meetingId: string): Promise<MeetingDeleteStoreResult> {
  const acquisition = meetingLifecycle.tryAcquireDeletion(meetingId);
  if (!acquisition.acquired) {
    return Promise.resolve({ meetingId, outcome: "refused", reason: deletionReason(acquisition.active) });
  }
  return (async () => {
    try {
      const meetingStore = getMeetingStore();
      if (!recordingService) {
        return await deleteMeetingBeforeRecordingBootstrap(
          meetingStore,
          meetingId,
          requiredAbsolute("MEETLESS_EXPORT_ROOT"),
          requiredAbsolute("MEETLESS_STORE_ROOT"),
        );
      }
      const recordingStagePaths = await recordingService.ownedStagePaths(meetingId);
      return await meetingStore.deleteMeeting(meetingId, { recordingStagePaths });
    } finally {
      acquisition.lease.release();
    }
  })();
}

export async function deleteMeetingBeforeRecordingBootstrap(
  meetingStore: Pick<MeetingStore, "listRecordings" | "deleteMeeting">,
  meetingId: string,
  exportRoot: string,
  storeRoot: string,
): Promise<MeetingDeleteStoreResult> {
  const candidates = (await meetingStore.listRecordings()).filter((recording) => recording.meetingId === meetingId);
  const recordingIds = (await Promise.all(candidates.map(async (recording) => {
    if (["recording", "interrupted", "recoverable", "finalizing"].includes(recording.status)) return recording.id;
    if (recording.status !== "failed") return null;
    return lstat(path.join(storeRoot, "sessions", recording.id)).then(
      (state) => state.isDirectory() && !state.isSymbolicLink() ? recording.id : null,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error),
    );
  }))).filter((recordingId): recordingId is string => recordingId !== null);
  const recordingStagePaths = await listRecordingOwnedStagePaths(exportRoot, recordingIds);
  return meetingStore.deleteMeeting(meetingId, { recordingStagePaths });
}

function deletionReason(active: MeetingWorkKind[]): "active_capture" | "finalization" | "transcription" | "ask" {
  if (active.includes("active_capture")) return "active_capture";
  if (active.includes("finalization")) return "finalization";
  if (active.includes("transcription")) return "transcription";
  return "ask";
}

export function getMeetingStore(): MeetingStore {
  if (store) return store;
  const configuredRoot = process.env.MEETLESS_STORE_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      "MEETLESS_STORE_ROOT must be an absolute isolated path fixed by the Meetless launcher",
    );
  }
  const exportRoot = process.env.MEETLESS_EXPORT_ROOT?.trim();
  store = new MeetingStore({
    root: configuredRoot,
    approvedExportRoots: exportRoot && path.isAbsolute(exportRoot) ? [exportRoot] : [],
  });
  return store;
}

export async function getMeetingChatService(
  paseo: PluginHandlerContext["paseo"],
): Promise<MeetingChatService> {
  chatService ??= new MeetingChatService(
    getMeetingStore(),
    new PaseoMeetingChatAgentPort(paseo, resolveChatExecutionRoot()),
    meetingLifecycle,
  );
  await chatService.initialize();
  return chatService;
}

export async function stopMeetingChatService(): Promise<void> {
  const current = chatService;
  if (!current) return;
  await current.close();
  if (chatService === current) chatService = null;
}

export async function startRecordingRuntime(deadlineEpochMs = Number.POSITIVE_INFINITY): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  if (recordingService || controlServer) return;
  if (recordingStart) {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
    return;
  }
  recordingStart = startRecordingRuntimeOnce(deadlineEpochMs);
  try {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
  } catch (error) {
    if (Date.now() >= deadlineEpochMs) await stopRecordingRuntime();
    throw error;
  } finally {
    recordingStart = null;
  }
}

async function startRecordingRuntimeOnce(deadlineEpochMs: number): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const helperPath = requiredAbsolute("MEETLESS_CAPTURE_HELPER");
  const ffmpeg = requiredAbsolute("MEETLESS_FFMPEG");
  const ffprobe = requiredAbsolute("MEETLESS_FFPROBE");
  const exportRoot = requiredAbsolute("MEETLESS_EXPORT_ROOT");
  const socketPath = requiredAbsolute("MEETLESS_RECORDING_SOCKET");
  const transcriptionSocket = process.env.MEETLESS_TRANSCRIPTION_SOCKET?.trim();
  const transcriptionStaging = process.env.MEETLESS_TRANSCRIPTION_STAGING?.trim();
  const uiTest = await readControlledUiTestIdentity();
  await Promise.all([access(helperPath), access(ffmpeg), access(ffprobe)]);
  const fixedStamp = process.env.MEETLESS_FIXTURE_EXPORT_STAMP?.trim();
  const fixture = process.env.MEETLESS_CAPTURE_MODE === "fixture";
  if (fixture && !uiTest) {
    throw new Error(
      "Fixture capture requires a valid consumed one-shot UI-test envelope; normal production has no fixture fallback",
    );
  }
  if (!fixture) await assertProductionHostProvenance();
  if (!fixture && (!transcriptionSocket || !path.isAbsolute(transcriptionSocket) || !transcriptionStaging || !path.isAbsolute(transcriptionStaging))) {
    throw new Error("Production transcription requires the signed MeetlessHost native capability socket");
  }
  const fixtureExportNow = resolveFixtureExportNow(fixture, fixedStamp);
  const transcriptionMode = uiTest?.transcriptionMode ?? "native";
  const provider: TranscriptionProvider | null = transcriptionMode === "fake"
    ? new DeterministicFixtureTranscriptionProvider()
    : transcriptionSocket
      ? new NativeOpenAiTranscriptionProvider(new UnixSocketNativeTranscriptionTransport(transcriptionSocket))
      : null;
  if (fixture && !provider) {
    throw new Error("Controlled native transcription requires the signed host capability socket");
  }
  const transcript = provider
    ? new TranscriptionService(getMeetingStore(), provider, {
      inspector: new FfmpegAudioInspector(
        ffmpeg,
        ffprobe,
        transcriptionStaging ?? path.join(storeRoot, "transcription-ranges"),
      ),
      sourceSnapshots: new PrivateAudioSnapshotStore(
        path.join(storeRoot, "transcription-source-snapshots"),
        "transcription-source",
      ),
    }, meetingLifecycle)
    : undefined;
  const service = new RecordingService({
    storeRoot, helperPath, ffmpeg, ffprobe, exportRoot,
    fixture,
    exportNow: fixtureExportNow,
    fixtureStampApplied: fixtureExportNow !== undefined,
    failFinalizationOnce: process.env.MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE === "1",
    authorizeProductionStart: assertProductionHostProvenance,
    transcription: transcript,
  }, getMeetingStore(), meetingLifecycle);
  const identity = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    uiTest,
  };
  const server = new RecordingControlServer(socketPath, service, identity);
  try {
    await service.initialize();
    assertBootstrapDeadline(deadlineEpochMs);
    await server.start();
    assertBootstrapDeadline(deadlineEpochMs);
    recordingService = service;
    controlServer = server;
    transcriptionService = transcript ?? null;
    runtimeIdentity = identity;
  } catch (error) {
    await server.close().catch(() => undefined);
    await service.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function stopRecordingRuntime(): Promise<void> {
  const server = controlServer; const service = recordingService;
  controlServer = null; recordingService = null; transcriptionService = null;
  runtimeIdentity = null;
  await service?.shutdown();
  await server?.close();
}

export function recordingRuntimeForTest(): RecordingService | null { return recordingService; }

export function getTranscriptionService(): TranscriptionService {
  if (!transcriptionService) throw new Error("Meetless transcription runtime is not active");
  return transcriptionService;
}

export function getCitationPlaybackService(): CitationPlaybackService {
  if (citationPlaybackService) return citationPlaybackService;
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  citationPlaybackService = new CitationPlaybackService(
    getMeetingStore(),
    new FfmpegCitationClipEncoder(
      requiredAbsolute("MEETLESS_FFMPEG"),
      path.join(storeRoot, "citation-clips"),
    ),
    new PrivateAudioSnapshotStore(
      path.join(storeRoot, "citation-source-snapshots"),
      "citation-source",
    ),
  );
  return citationPlaybackService;
}

export async function transcriptionProviderStatus(): Promise<"configured" | "missing" | "invalid"> {
  // Reading an existing host-owned transcript does not require the recording runtime.
  // The provider is unavailable until that runtime is active, so report that state
  // without hiding or replacing the durable transcript.
  return transcriptionService ? transcriptionService.providerStatus() : "missing";
}

export async function grantTranscriptionConsent(): Promise<{ status: "granted"; grantedAt: string }> {
  return getTranscriptionService().grantConsent();
}

export function recordingRuntimeIdentity(): { instanceId: string; startedAt: string } {
  if (!runtimeIdentity) throw new Error("Meetless recording runtime is not active");
  return runtimeIdentity;
}

async function readControlledUiTestIdentity(): Promise<UiTestIdentity | null> {
  if (process.env.MEETLESS_UI_TEST_MODE !== "1") return null;
  const markerPath = process.env.MEETLESS_UI_TEST_MARKER?.trim();
  const runtimeRoot = process.env.MEETLESS_RUNTIME_ROOT?.trim();
  if (!markerPath || !runtimeRoot || path.resolve(markerPath) !== path.join(path.resolve(runtimeRoot), "ui-test-run.json")) {
    throw new Error("Controlled UI-test mode requires the exact runtime-root consumed marker");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error("Controlled UI-test mode requires a readable consumed marker");
  }
  const identity = UiTestIdentitySchema.parse(
    decoded && typeof decoded === "object" && "identity" in decoded ? decoded.identity : undefined,
  );
  if (
    process.env.MEETLESS_UI_TEST_RUN_ID !== identity.runId ||
    process.env.MEETLESS_CAPTURE_MODE !== identity.captureMode ||
    (process.env.MEETLESS_TRANSCRIPTION_MODE ?? "") !== identity.transcriptionMode
  ) {
    throw new Error("Controlled UI-test environment does not match the consumed marker identity");
  }
  return identity;
}

export function resolveFixtureExportNow(fixture: boolean, fixedStamp: string | undefined): (() => Date) | undefined {
  return fixture && fixedStamp ? () => new Date(fixedStamp) : undefined;
}

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path fixed by the Meetless launcher`);
  return path.resolve(value);
}

function assertBootstrapDeadline(deadlineEpochMs: number): void {
  if (Date.now() >= deadlineEpochMs) {
    throw new Error("Meetless recording runtime bootstrap exceeded the launcher startup deadline");
  }
}
