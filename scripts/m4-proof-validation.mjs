import path from "node:path";

const AUTHORITY = "docs/product/experience.md";

export const M4_TARGET_MEETING_ID = "m4-proof-target";
export const M4_DISTRACTOR_MEETING_ID = "m4-proof-distractor";
export const M4_TARGET_RECORDING_ID = "m4-proof-recording";
export const M4_DISTRACTOR_SENTINEL = "DISTRACTOR TRANSCRIPT MUST NEVER RENDER";
export const M4_EXPECTED_RANGES = [
  { ordinal: 0, startMs: 0, endMs: 30_000, text: "First interval: four hundred forty hertz." },
  { ordinal: 1, startMs: 30_000, endMs: 60_000, text: "Second interval: six hundred sixty hertz." },
  { ordinal: 2, startMs: 60_000, endMs: 65_000, text: "Third interval: eight hundred eighty hertz." },
];

export class M4ProofValidationError extends Error {
  constructor(stage, message, nextAction) {
    super(`M4 proof failed at ${stage}: ${message} (authority: ${AUTHORITY}). Next action: ${nextAction}`);
    this.name = "M4ProofValidationError";
    this.stage = stage;
  }
}

export function validateM4Observation(input) {
  requireValue(input?.schema === "MEETLESS_M4_COMPOSITION_OBSERVATION v1", "schema", "observation schema is missing", "emit the M4 v1 observation");
  const policy = input.evidencePolicy ?? {};
  requireValue(
    policy.generatedFixture === true && policy.liveSource === false && policy.nativeProvider === false && policy.fakeNativeSubstitution === false,
    "labels",
    "generated fixture, live-source, native-provider, or substitution labels are dishonest or incomplete",
    "label this run generated-only with no live/native substitution claim",
  );
  requireValue(
    input.identity?.exactInstalledHost === true && input.identity?.exactRunMarker === true && input.identity?.trustedRendererBridge === true,
    "identity",
    "installed host, fresh run marker, or trusted renderer bridge was not correlated",
    "reuse the accepted installed-host one-shot envelope and exact identity checks",
  );

  const sidebar = input.sidebar ?? {};
  requireValue(
    sameArray(sidebar.meetingIds, [M4_DISTRACTOR_MEETING_ID, M4_TARGET_MEETING_ID]),
    "sidebar",
    `sidebar meeting IDs are ${JSON.stringify(sidebar.meetingIds)}`,
    "render exactly the distractor and target Meetless meetings",
  );
  requireValue(
    sidebar.selectedMeetingId === M4_TARGET_MEETING_ID && sidebar.selectedAccessibility === true && sidebar.detailMeetingId === M4_TARGET_MEETING_ID,
    "selection",
    "target row selection and detail identity do not agree",
    "select the target row and correlate its accessibility state with the detail",
  );

  const authoritative = input.authoritativeTranscript ?? {};
  const rpc = input.rpcTranscript ?? {};
  const rendered = input.renderedTranscript ?? {};
  requireValue(authoritative.meetingId === M4_TARGET_MEETING_ID && authoritative.recordingId === M4_TARGET_RECORDING_ID, "transcript-authority", "authoritative transcript has the wrong owner", "read the target transcript from MeetingStore");
  requireTranscriptRanges(authoritative.segments, "transcript-authority");
  requireValue(sameSegments(rpc.segments, authoritative.segments) && rpc.meetingId === authoritative.meetingId && rpc.recordingId === authoritative.recordingId, "rpc-transcript", "RPC transcript differs from MeetingStore", "read the same target transcript through the real daemon/plugin client");
  requireValue(sameSegments(rendered.segments, authoritative.segments), "rendered-order", "rendered segment IDs, text, timestamps, count, or DOM order differs from authority", "render every authoritative segment once in planner order");
  requireValue(rendered.distractorSentinelPresent === false, "selection-isolation", "distractor transcript sentinel appeared in the target detail", "scope detail rendering to the selected target meeting");

  const third = authoritative.segments[2];
  const citation = input.citation ?? {};
  requireValue(
    citation.meetingId === M4_TARGET_MEETING_ID && citation.recordingId === M4_TARGET_RECORDING_ID &&
      citation.segmentId === third?.segmentId && citation.text === third?.text && citation.startMs === 60_000 && citation.endMs === 65_000,
    "citation",
    "third timestamp did not resolve the authoritative target identity and [60000,65000) interval",
    "resolve the clicked stable segment ID through the accepted M3 citation boundary",
  );

  const playback = input.playback ?? {};
  requireValue(playback.audioAccepted === true && playback.playResolved === true, "playback-start", "the real browser Audio path did not accept and play the clip", "click the timestamp and wait for the native Audio play promise");
  requireValue(Number(playback.maximumCurrentTime) >= 0.2, "playback-advance", "media time did not advance", "observe timeupdate/currentTime after play resolves");
  requireValue(playback.boundedStopObserved === true, "playback-stop", "bounded playback stop was not observed", "wait for the application playback timer to pause the clip");
  requireValue(Number(playback.clipDurationSeconds) >= 4.8 && Number(playback.clipDurationSeconds) <= 5.3, "clip-duration", `clip duration is ${playback.clipDurationSeconds}`, "analyze the clicked third-range clip with ffprobe");
  requireValue(playback.markerHz === 880 && playback.markerPowerRatio >= 3, "clip-marker", `third-range marker is ${playback.markerHz} Hz at ratio ${playback.markerPowerRatio}`, "decode the clicked clip and require the 880 Hz marker to dominate adjacent fixture markers");
  return input;
}

export function validateM4PublishedManifest(input) {
  requireValue(input?.schema === "MEETLESS_M4_COMPOSITION_PROOF v1", "manifest-schema", "published schema is missing", "publish the privacy-safe M4 v1 manifest");
  validateM4Observation(input.observation);
  requireValue(input.status === "passed", "manifest-status", `manifest status is ${input.status}`, "publish only after every M4 observation passes");
  requireValue(
    input.cleanup?.status === "passed" &&
      input.cleanup?.stagedRootRemoved === true &&
      input.cleanup?.originalRootRestored === true &&
      input.cleanup?.runStateRemoved === true &&
      input.cleanup?.proofArtifactRootRemoved === true &&
      Array.isArray(input.cleanup?.liveHostPids) && input.cleanup.liveHostPids.length === 0 &&
      Array.isArray(input.cleanup?.errors) && input.cleanup.errors.length === 0,
    "cleanup",
    "staged root, original root, run state, exact proof artifact root, host process, or cleanup error evidence is incomplete",
    "finish and observe every exact cleanup boundary before publishing",
  );
  requireValue(
    input.restoration?.matched === true && restorationDigestsMatch(input.restoration),
    "restoration",
    "pre-run runtime state was not restored byte-for-byte",
    "compare the pre-run and restored runtime tree digests before publishing",
  );
  requireValue(input.evidence?.screenshot === "screenshot.png", "evidence-path", "screenshot path is not privacy-safe and relative", "publish only the relative evidence filename");
  requirePrivacySafeManifest(input);
  return input;
}

function requireTranscriptRanges(segments, stage) {
  requireValue(Array.isArray(segments) && segments.length === 3, stage, `expected three segments, received ${segments?.length ?? "missing"}`, "publish all three default M3 ranges");
  for (let index = 0; index < M4_EXPECTED_RANGES.length; index += 1) {
    const expected = M4_EXPECTED_RANGES[index];
    const actual = segments[index];
    requireValue(
      actual?.ordinal === expected.ordinal && actual?.startMs === expected.startMs && actual?.endMs === expected.endMs &&
        actual?.text === expected.text && typeof actual?.segmentId === "string" && actual.segmentId.length > 0,
      stage,
      `segment ${index} differs from ${JSON.stringify(expected)}`,
      "seed and publish the exact default M3 range plan through MeetingStore APIs",
    );
  }
}

function sameSegments(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function sameArray(left, right) {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function restorationDigestsMatch(restoration) {
  const before = restoration.beforeDigest;
  const after = restoration.afterDigest;
  if (before === null || after === null) return before === null && after === null && restoration.originalRootExisted === false;
  return restoration.originalRootExisted === true && /^[a-f0-9]{64}$/u.test(before) && before === after;
}

function requirePrivacySafeManifest(value, property = "manifest") {
  if (typeof value === "string") {
    const absolute = path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^file:/iu.test(value);
    const embedded = /^data:/iu.test(value) || /(?:^|[\\/])[^\\/]+\.(?:mp3|wav|m4a|aac|flac|log|zip)$/iu.test(value);
    requireValue(!absolute && !embedded, "privacy", `${property} contains an absolute filesystem path or embedded/source artifact`, "publish only bounded values and the exact relative screenshot name");
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  requireValue(!ArrayBuffer.isView(value), "privacy", `${property} contains a raw byte-array view`, "publish bounded scalar observations instead of raw audio or log bytes");
  if (Array.isArray(value)) {
    const rawBytes = value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
    requireValue(!rawBytes, "privacy", `${property} contains a raw byte array`, "publish a bounded digest or analyzed scalar instead of raw audio or log bytes");
    value.forEach((item, index) => requirePrivacySafeManifest(item, `${property}[${index}]`));
    return;
  }
  requireValue(typeof value === "object", "privacy", `${property} has an unsupported manifest value`, "publish JSON primitives, arrays, and objects only");
  const bufferShape = value.type === "Buffer" && Array.isArray(value.data);
  requireValue(!bufferShape, "privacy", `${property} contains a buffer-shaped raw payload`, "publish a bounded digest or analyzed scalar instead of raw audio or log bytes");
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const rawContentField = new Set(["audio", "rawaudio", "rawaudiobytes", "log", "logs"]).has(normalizedKey);
    const sensitiveKey = /(?:path|trace|raw.*log|base64|payload|clipbytes|screenshotbytes|artifactroot)$/iu.test(key);
    requireValue(!rawContentField && !sensitiveKey, "privacy", `${property}.${key} is a forbidden source/raw evidence field`, "remove source paths, raw audio, raw logs, traces, embedded payloads, and temporary artifact identities");
    requirePrivacySafeManifest(child, `${property}.${key}`);
  }
}

function requireValue(condition, stage, message, nextAction) {
  if (!condition) throw new M4ProofValidationError(stage, message, nextAction);
}
