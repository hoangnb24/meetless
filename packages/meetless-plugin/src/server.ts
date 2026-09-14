import { ManagedBackendRouter, type AppleEnvironment, type ManagedBackendOperation } from "./managed-backend.js";
import { randomUUID } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import type { MeetingDeleteStoreResult } from "@meetless/meeting-store";
import { RecordingService } from "./recording-service.js";
import { RecordingControlServer } from "./control-server.js";
import { runtimeEndpoint } from "./runtime-endpoints.js";
import {
  assertCapturePermissionsReady,
  assertProductionHostProvenance,
  registerPackagedCaptureHelper,
} from "./production-host.js";
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
import {
  ConvexManagedTranscriptionService,
  listManagedArtifactPaths,
  ManagedTimelineArtifactStore,
  type ConvexManagedTranscriptionResult,
} from "./managed-transcription.js";
import {
  NativePremiumAccessPort,
  PremiumService,
  UnavailablePremiumAccessPort,
} from "./premium-service.js";
import { ManagedDeviceWireSchema, type ManagedDeviceWire } from "@meetless/meeting-contracts";
import {
  ConvexManagedCredentialSource,
  UnixSocketManagedAuthTransport,
  type ManagedAppleVerificationMaterial,
} from "./managed-auth.js";
import {
  ConvexHttpManagedFunctionClient,
  ConvexManagedUploadPort,
  FileManagedConvexUploadJournal,
  type ManagedConvexCredential,
} from "./managed-upload.js";
import { TranscriptionRouteCoordinator } from "./transcription-route.js";

let store: MeetingStore | null = null;
let recordingService: RecordingService | null = null;
let controlServer: RecordingControlServer | null = null;
let transcriptionService: TranscriptionService | null = null;
let citationPlaybackService: CitationPlaybackService | null = null;
let recordingStart: Promise<void> | null = null;
let runtimeIdentity: { instanceId: string; startedAt: string; uiTest: UiTestIdentity | null } | null = null;
let chatService: MeetingChatService | null = null;
let premiumService: PremiumService | null = null;
let managedBackendRouter: ManagedBackendRouter | null = null;
let managedCredentialSource: ConvexManagedCredentialSource | null = null;
let transcriptionRoute: TranscriptionRouteCoordinator | null = null;
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
      const managedArtifactPaths = await recordingService.ownedManagedArtifactPaths(meetingId);
      return await meetingStore.deleteMeeting(meetingId, { recordingStagePaths, managedArtifactPaths });
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
  const managedArtifactPaths = await listManagedArtifactPaths(path.join(storeRoot, "managed-artifacts"), recordingIds);
  return meetingStore.deleteMeeting(meetingId, { recordingStagePaths, managedArtifactPaths });
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

export function getPremiumService(): PremiumService {
  if (premiumService) return premiumService;
  const configuredSocket = process.env.MEETLESS_TRANSCRIPTION_SOCKET?.trim() ?? "";
  if (!configuredSocket && process.env.MEETLESS_RUNTIME_PACKAGED !== "1") {
    return new PremiumService(new UnavailablePremiumAccessPort(configuredSocket ? "store_unavailable" : "not_configured"));
  }
  const endpoint = runtimeEndpoint(process.env, "transcription");
  premiumService ??= new PremiumService(new NativePremiumAccessPort(endpoint.bindArgument), {
    requireAppleSignedTransaction: true,
    onAppleSignedTransaction: enrollManagedAppleTransaction,
    readAuthorization: async () => {
      const credential = await refreshManagedAuthorization();
      if (!credential.state) throw new Error("Managed authorization snapshot is missing state");
      return {
        state: credential.state,
        naturalExpiryAt: credential.naturalExpiryAt ?? null,
      };
    },
  });
  return premiumService;
}

/** Consumes the opaque host JWS before the public Premium RPC resolves. */
export async function enrollManagedAppleTransaction(signedTransaction: string, environment?: AppleEnvironment): Promise<ManagedConvexCredential> {
  if (!signedTransaction.trim()) throw new Error("Apple signed transaction is empty");
  const router = getManagedBackendRouter();
  if (router.routed && !environment) throw new Error("Verified Store environment is missing");
  const operation = await router.select(environment ? { signedTransaction, environment } : undefined, { adapter: "app-store-server-api", signedTransaction });
  return router.authorize(operation, { enroll: true });
}

export async function listManagedDevices(): Promise<ManagedDeviceWire[]> {
  const client = await managedClientWithCredential();
  await client.mutation("managedAuth:touchDeviceActivity", {});
  const value = await client.query("managedAuth:listDevices", {});
  if (!Array.isArray(value)) throw new Error("Managed device list response is invalid");
  return value.map((device) => ManagedDeviceWireSchema.parse(device));
}

export async function revokeManagedDevice(deviceId: string): Promise<{ deviceId: string; outcome: "revoked" | "already-revoked" }> {
  const client = await managedClientWithCredential();
  const value = await client.mutation("managedAuth:revokeEnrolledDevice", { deviceId });
  if (!value || typeof value !== "object" || typeof (value as { deviceId?: unknown }).deviceId !== "string" || (value as { outcome?: unknown }).outcome !== "revoked" && (value as { outcome?: unknown }).outcome !== "already-revoked") {
    throw new Error("Managed device revoke response is invalid");
  }
  return { deviceId: (value as { deviceId: string }).deviceId, outcome: (value as { outcome: "revoked" | "already-revoked" }).outcome };
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
  const recordingEndpoint = runtimeEndpoint(process.env, "recording");
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
  if (!fixture || process.env.MEETLESS_RUNTIME_PACKAGED === "1") await assertProductionHostProvenance();
  const transcriptionMode = uiTest?.transcriptionMode ?? "native";
  const transcriptionEndpoint = transcriptionMode === "fake"
    ? null
    : runtimeEndpoint(process.env, "transcription");
  if (!fixture && (!transcriptionEndpoint || !transcriptionStaging || !path.isAbsolute(transcriptionStaging))) {
    throw new Error("Production transcription requires the signed MeetlessHost native capability socket");
  }
  const fixtureExportNow = resolveFixtureExportNow(fixture, fixedStamp);
  const managedArtifacts = new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts"));
  const provider: TranscriptionProvider | null = transcriptionMode === "fake"
    ? new DeterministicFixtureTranscriptionProvider()
    : transcriptionEndpoint
      ? new NativeOpenAiTranscriptionProvider(new UnixSocketNativeTranscriptionTransport(transcriptionEndpoint.bindArgument))
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
    authorizeProductionStart: async () => {
      await assertProductionHostProvenance();
      await assertCapturePermissionsReady();
    },
    ...(process.env.MEETLESS_RUNTIME_PACKAGED === "1"
      ? { registerCaptureHelper: (childPid: number, registrationToken: string) =>
        registerPackagedCaptureHelper(childPid, registrationToken) }
      : {}),
    transcription: transcript,
    managedTimelineConsumer: managedArtifacts,
  }, getMeetingStore(), meetingLifecycle);
  const identity = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    uiTest,
  };
  const server = new RecordingControlServer(recordingEndpoint, service, identity);
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

export function getTranscriptionRoute(): TranscriptionRouteCoordinator {
  if (transcriptionRoute) return transcriptionRoute;
  transcriptionRoute = new TranscriptionRouteCoordinator(
    getMeetingStore(),
    getPremiumService(),
    {
      resumeExisting: (recordingId) => resumeExistingManagedRecording(recordingId),
      transcribe: (input) => transcribeManagedRecording({
        recordingId: input.recordingId,
        onDurableStart: input.onDurableStart,
      }),
    },
  );
  return transcriptionRoute;
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

export function grantTranscriptionConsent(meetingId: string) {
  return getTranscriptionRoute().start(meetingId);
}

export function recordingRuntimeIdentity(): { instanceId: string; startedAt: string } {
  if (!runtimeIdentity) throw new Error("Meetless recording runtime is not active");
  return runtimeIdentity;
}

/**
 * Trusted native composition seam. No renderer RPC calls this factory; a
 * future explicit Premium command supplies Apple material or refreshes the
 * enrolled key before invoking the managed service.
 */
export function getManagedConvexCredentialSource(): ConvexManagedCredentialSource {
  const convexUrl = requiredEnv("MEETLESS_CONVEX_URL");
  const socket = runtimeEndpoint(process.env, "transcription").bindArgument;
  managedCredentialSource ??= new ConvexManagedCredentialSource(
    new ConvexHttpManagedFunctionClient(convexUrl),
    new UnixSocketManagedAuthTransport(socket),
    {},
    async () => {
      const signedTransaction = await new NativePremiumAccessPort(socket).readSignedTransaction();
      return signedTransaction ? { adapter: "app-store-server-api", signedTransaction } : null;
    },
  );
  return managedCredentialSource;
}

function getManagedBackendRouter(): ManagedBackendRouter {
  if (managedBackendRouter) return managedBackendRouter;
  const socket = runtimeEndpoint(process.env, "transcription").bindArgument;
  const routed = process.env.MEETLESS_STORE_BACKEND_ROUTING === "1";
  managedBackendRouter = new ManagedBackendRouter(
    routed ? { SANDBOX: requiredEnv("MEETLESS_CONVEX_SANDBOX_URL"), PRODUCTION: requiredEnv("MEETLESS_CONVEX_PRODUCTION_URL") } : { development: requiredEnv("MEETLESS_CONVEX_URL") },
    (endpoint) => routed ? new ConvexManagedCredentialSource(new ConvexHttpManagedFunctionClient(endpoint), new UnixSocketManagedAuthTransport(socket)) : getManagedConvexCredentialSource(),
    () => new NativePremiumAccessPort(socket).readVerifiedTransaction(),
  );
  return managedBackendRouter;
}

async function managedClientWithCredential(): Promise<ConvexHttpManagedFunctionClient> {
  const router = getManagedBackendRouter();
  const operation = await router.select();
  const credential = await router.authorize(operation);
  return new ConvexHttpManagedFunctionClient(operation.context.endpoint, { authToken: credential.authToken });
}

async function refreshManagedAuthorization(): Promise<ManagedConvexCredential> {
  const router = getManagedBackendRouter();
  return router.authorize(await router.select(), { refresh: true });
}

function managedJournalRoot(storeRoot: string, operation: ManagedBackendOperation): string {
  return path.join(storeRoot, "managed-convex-upload-journal", operation.context.namespace);
}

async function resumeExistingManagedRecording(recordingId: string) {
  const router = getManagedBackendRouter();
  const operation = await router.select();
  const credential = await router.authorize(operation, { refresh: true }).catch(() => { throw new Error("Managed device enrollment could not be verified"); });
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const managedUpload = new ConvexManagedUploadPort(new ConvexHttpManagedFunctionClient(operation.context.endpoint), {
    journal: new FileManagedConvexUploadJournal(managedJournalRoot(storeRoot, operation)),
  });
  return new ConvexManagedTranscriptionService(getMeetingStore(), {
    lifecycle: meetingLifecycle,
    timelineArtifacts: new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts")),
    managedUpload,
  }).resumeExisting({ recordingId, credential });
}

export async function transcribeManagedRecording(input: {
  recordingId: string;
  appleVerification?: ManagedAppleVerificationMaterial;
  credential?: ManagedConvexCredential;
  onDurableStart?: (transcript: import("@meetless/meeting-domain").TranscriptState) => void;
}): Promise<ConvexManagedTranscriptionResult> {
  const router = getManagedBackendRouter();
  const operation = await router.select(undefined, input.appleVerification);
  const credential = await router.authorize(operation, { enroll: !!input.appleVerification, credential: input.credential }).catch(() => { throw new Error("Managed device enrollment could not be verified"); });
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const upload = new ConvexManagedUploadPort(new ConvexHttpManagedFunctionClient(operation.context.endpoint), {
    journal: new FileManagedConvexUploadJournal(managedJournalRoot(storeRoot, operation)),
  });
  return new ConvexManagedTranscriptionService(getMeetingStore(), {
    lifecycle: meetingLifecycle,
    timelineArtifacts: new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts")),
    managedUpload: upload,
  }).transcribe({ recordingId: input.recordingId, credential, onDurableStart: input.onDurableStart });
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured for the explicit managed Convex command`);
  return value;
}

function assertBootstrapDeadline(deadlineEpochMs: number): void {
  if (Date.now() >= deadlineEpochMs) {
    throw new Error("Meetless recording runtime bootstrap exceeded the launcher startup deadline");
  }
}

let providerAccessService: import("./provider-access.js").ProviderAccessService | null = null;
export async function getProviderAccess(provider?: import("@meetless/meeting-contracts").ProviderAccessId) {
  const { providerAccess, ProviderAccessService } = await import("./provider-access.js");
  providerAccessService ??= new ProviderAccessService((selected) =>
    providerAccess(runtimeEndpoint(process.env, "transcription").bindArgument, selected));
  return provider ? providerAccessService.request(provider) : providerAccessService.status();
}
