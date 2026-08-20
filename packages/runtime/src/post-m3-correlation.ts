export const POST_M3_CORRELATION_VERSION = 1 as const;
export const POST_M3_LOGICAL_DESKTOP_ID = "com.meetless.desktop" as const;

export interface PostM3CorrelationObservation {
  identity: {
    logicalDesktopId: string;
    runId: string;
    hostBundleIdentifier: string;
    hostBundlePath: string;
    hostCdHash: string;
    hostPid: number;
    desktopPid: number;
    electronPid: number;
    electronExecutable: string;
    ancestry: number[];
    cdpAddress: string;
    cdpPort: number;
  };
  renderer: {
    runId: string;
    logicalDesktopId: string;
    url: string;
    title: string;
    titleEntered: boolean;
    startControlVisible: boolean;
    stopControlVisible: boolean;
    finalState: string;
    screenshotPath: string;
    tracePath: string;
  };
  socket: {
    runId: string;
    runtimeInstanceId: string;
    pluginPid: number;
    recordingId: string;
    meetingId: string;
    captureMode: "fixture";
    postStopStatus: string;
    statuses: Array<{ status: string; recordingId: string | null; meetingId: string | null }>;
  };
  store: {
    meetingId: string;
    recordingId: string;
    title: string;
    recordingStatus: string;
    savedOutput: { destination: string; byteLength: number; sha256: string };
    transcript: {
      meetingId: string;
      recordingId: string;
      status: string;
      audio: { byteLength: number; sha256: string };
      segments: Array<{ text: string; segmentId?: string }>;
    };
  };
  helper: {
    pid: number;
    pluginPid: number;
    parentPid: number;
    recordingId: string;
    executable: string;
    arguments: string[];
  };
  chunks: {
    recordingId: string;
    count: number;
    microphoneCount: number;
    systemCount: number;
    identities: Array<{ storageKey: string; byteLength: number; sha256: string; source: "microphone" | "system" }>;
  };
  mp3: {
    recordingId: string;
    destination: string;
    byteLength: number;
    sha256: string;
  };
  transcription: {
    mode: "fake" | "native";
    meetingId: string;
    recordingId: string;
    status: string;
    audio: { byteLength: number; sha256: string };
    segments: Array<{ text: string; segmentId?: string }>;
  };
}

export class PostM3CorrelationError extends Error {
  constructor(
    readonly stage: string,
    readonly edge: string,
    readonly nextAction: string,
    message: string,
  ) {
    super(`POST-M3 correlation failed at ${stage} (${edge}): ${message}. Next action: ${nextAction}`);
    this.name = "PostM3CorrelationError";
  }
}

export function validatePostM3Correlation(observation: PostM3CorrelationObservation): void {
  validateIdentity(observation);
  validateRenderer(observation);
  validateRendererToSocket(observation);
  validateSocketToStore(observation);
  validateStoreToHelper(observation);
  validateHelperToChunks(observation);
  validateChunksToMp3(observation);
  validateMp3ToTranscription(observation);
}

function validateIdentity(input: PostM3CorrelationObservation): void {
  const identity = input.identity;
  if ((identity.logicalDesktopId as string) === "com.github.Electron" || identity.logicalDesktopId !== POST_M3_LOGICAL_DESKTOP_ID) {
    fail("identity", "identity→renderer", `logical desktop identity is ${identity.logicalDesktopId || "missing"}; expected ${POST_M3_LOGICAL_DESKTOP_ID}`, "target the consumed logical desktop marker");
  }
  if (
    identity.hostBundleIdentifier !== "com.meetless.app" ||
    !identity.runId ||
    !identity.hostBundlePath.endsWith("/Applications/Meetless.app") ||
    !/^[a-f0-9]{40}$/u.test(identity.hostCdHash)
  ) {
    fail("identity", "identity→renderer", "run ID, accepted host bundle ID/path, and recorded host CDHash are incomplete", "read the consumed marker and installed host identity");
  }
  if (
    !positive(identity.hostPid) || !positive(identity.desktopPid) || !positive(identity.electronPid) ||
    identity.ancestry.length < 3 ||
    identity.ancestry[0] !== identity.hostPid ||
    identity.ancestry[1] !== identity.desktopPid ||
    identity.ancestry[identity.ancestry.length - 1] !== identity.electronPid
  ) {
    fail("identity", "host→desktop→Electron ancestry", "the CDP endpoint is not attested beneath the exact accepted host", "inspect the endpoint PID ancestry and retain the exact host executable");
  }
  if (identity.cdpAddress !== "127.0.0.1" || identity.cdpPort < 1024 || identity.cdpPort > 65535) {
    fail("identity", "identity→renderer", "CDP is not bound to a valid run-scoped loopback endpoint", "use the consumed envelope address and port");
  }
}

function validateRenderer(input: PostM3CorrelationObservation): void {
  const renderer = input.renderer;
  if (renderer.runId !== input.identity.runId || renderer.logicalDesktopId !== input.identity.logicalDesktopId) {
    fail("renderer", "identity→renderer", "renderer marker does not match the fresh desktop run", "attach the exact host-owned page by its run marker");
  }
  if (!renderer.url.startsWith("http://127.0.0.1:")) {
    fail("renderer", "identity→renderer", `renderer URL ${renderer.url || "missing"} is not the isolated loopback page`, "attach the renderer origin fixed by the runtime configuration");
  }
  if (!renderer.titleEntered || !renderer.startControlVisible || !renderer.stopControlVisible) {
    fail("renderer", "renderer controls", "title entry and visible Start/Stop controls were not all observed", "use the accessible title, Start, and Stop controls and retain the bounded trace");
  }
  if (!renderer.finalState || !renderer.screenshotPath || !renderer.tracePath) {
    fail("renderer", "renderer evidence", "final visible state, screenshot, or trace is missing", "capture the bounded renderer artifacts before cleanup");
  }
}

function validateRendererToSocket(input: PostM3CorrelationObservation): void {
  const socket = input.socket;
  if (socket.runId !== input.identity.runId) {
    fail("socket", "renderer→socket", "recording socket status has a different run ID", "correlate the socket observation with the consumed UI-test run");
  }
  if (!socket.runtimeInstanceId || !positive(socket.pluginPid) || !socket.recordingId || !socket.meetingId) {
    fail("socket", "renderer→socket", "authoritative runtime instance, plugin PID, recording ID, or meeting ID is missing", "request runtime readiness from the exact recording socket");
  }
  if (!socket.statuses.some((status) => status.status === "recording" && status.recordingId === socket.recordingId)) {
    fail("socket", "renderer→socket", "no recording status was correlated to the UI start action", "retain the socket status stream around Start");
  }
  if (socket.postStopStatus !== "idle") {
    fail("socket", "renderer→socket", `socket did not return to its post-stop idle state (${socket.postStopStatus || "missing"})`, "observe the recording socket after the UI Stop action, then read the durable saved record");
  }
  if (!socket.statuses.some((status) => status.status === "saved" && status.recordingId === socket.recordingId)) {
    fail("socket", "renderer→socket", "no saved status was correlated to the UI stop action", "retain the socket status stream through collision-safe MP3 publication");
  }
}

function validateSocketToStore(input: PostM3CorrelationObservation): void {
  const { socket, store } = input;
  if (store.meetingId !== socket.meetingId || store.recordingId !== socket.recordingId) {
    fail("store", "socket→store", "MeetingStore identifiers do not match the authoritative socket session", "read the store record selected by socket meetingId and recordingId");
  }
  if (store.recordingStatus !== "saved" || store.title.trim().length === 0) {
    fail("store", "socket→store", `store recording is ${store.recordingStatus || "missing"}, not a titled saved session`, "wait for durable saved state and inspect its title");
  }
}

function validateStoreToHelper(input: PostM3CorrelationObservation): void {
  const { store, helper } = input;
  if (!positive(helper.pid) || !positive(helper.pluginPid) || helper.parentPid !== helper.pluginPid || !helper.executable) {
    fail("helper", "store→helper", "helper PID, plugin parent, or executable identity is missing/mismatched", "capture runtime readiness while the helper is live and verify its parent");
  }
  if (helper.arguments.some((argument) => argument.trim().length === 0)) {
    fail("helper", "store→helper", "helper argv contains an empty argument", "retain the exact fixture or native helper argv");
  }
  if (helper.recordingId !== store.recordingId) {
    fail("helper", "store→helper", "helper observation cannot be bound to the saved recording", "retain the helper readiness observation before Stop");
  }
}

function validateHelperToChunks(input: PostM3CorrelationObservation): void {
  const chunks = input.chunks;
  if (
    chunks.recordingId !== input.store.recordingId ||
    chunks.count <= 0 ||
    chunks.identities.length !== chunks.count ||
    chunks.microphoneCount < 1 ||
    chunks.systemCount < 1
  ) {
    fail("chunks", "helper→chunks", "committed source-labelled chunks are missing or zero-chunk", "preserve the pre-stop authoritative chunk inventory and require microphone plus system evidence");
  }
  if (chunks.identities.some((chunk) => chunk.byteLength <= 0 || !/^[a-f0-9]{64}$/u.test(chunk.sha256))) {
    fail("chunks", "helper→chunks", "a committed chunk identity is incomplete", "read each chunk identity from the authoritative inventory");
  }
}

function validateChunksToMp3(input: PostM3CorrelationObservation): void {
  const { chunks, mp3, store } = input;
  if (
    mp3.recordingId !== chunks.recordingId ||
    mp3.destination !== store.savedOutput.destination ||
    mp3.byteLength !== store.savedOutput.byteLength ||
    mp3.sha256 !== store.savedOutput.sha256 ||
    mp3.byteLength <= 0
  ) {
    fail("mp3", "chunks→MP3", "published MP3 identity is not the saved output for the observed chunks", "compare MP3 path, byte length, and SHA-256 with the store publication intent");
  }
}

function validateMp3ToTranscription(input: PostM3CorrelationObservation): void {
  const { mp3, transcription, store } = input;
  if (
    transcription.mode !== "fake" && transcription.mode !== "native" ||
    transcription.meetingId !== store.meetingId ||
    transcription.recordingId !== mp3.recordingId ||
    transcription.status !== "ready" ||
    transcription.audio.byteLength !== mp3.byteLength ||
    transcription.audio.sha256 !== mp3.sha256 ||
    transcription.segments.length === 0
  ) {
    fail("transcription", "MP3→accepted M3 transcription", "transcript is not a ready identity-bound publication", "wait for the labeled provider result and compare its audio identity with the MP3");
  }
}

function positive(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function fail(stage: string, edge: string, message: string, nextAction: string): never {
  throw new PostM3CorrelationError(stage, edge, nextAction, message);
}
