import { describe, expect, test } from "vitest";
import {
  M4_DISTRACTOR_MEETING_ID,
  M4_EXPECTED_RANGES,
  M4_TARGET_MEETING_ID,
  M4_TARGET_RECORDING_ID,
  validateM4Observation,
  validateM4PublishedManifest,
} from "../scripts/m4-proof-validation.mjs";

describe("M4 real-composition proof validation", () => {
  test("accepts the exact two-meeting, ordered transcript, bounded playback observation", () => {
    expect(() => validateM4PublishedManifest(manifest())).not.toThrow();
  });

  test.each([
    ["selection", (value: any) => { value.observation.sidebar.selectedAccessibility = false; }],
    ["rendered-order", (value: any) => { value.observation.renderedTranscript.segments.reverse(); }],
    ["selection-isolation", (value: any) => { value.observation.renderedTranscript.distractorSentinelPresent = true; }],
    ["citation", (value: any) => { value.observation.citation.startMs = 0; }],
    ["playback-advance", (value: any) => { value.observation.playback.maximumCurrentTime = 0; }],
    ["playback-stop", (value: any) => { value.observation.playback.boundedStopObserved = false; }],
    ["clip-marker", (value: any) => { value.observation.playback.markerHz = 440; }],
    ["labels", (value: any) => { value.observation.evidencePolicy.nativeProvider = true; }],
    ["cleanup", (value: any) => { value.cleanup.runStateRemoved = false; }],
    ["cleanup", (value: any) => { value.cleanup.stagedRootRemoved = false; }],
    ["cleanup", (value: any) => { value.cleanup.originalRootRestored = false; }],
    ["cleanup", (value: any) => { value.cleanup.proofArtifactRootRemoved = false; }],
    ["restoration", (value: any) => { value.restoration.matched = false; }],
    ["privacy", (value: any) => { value.evidence.source = "/private/tmp/source.mp3"; }],
    ["privacy", (value: any) => { value.evidence.cache = "/var/folders/zz/private-proof"; }],
    ["privacy", (value: any) => { value.observation.nested = { audio: "RIFF..." }; }],
    ["privacy", (value: any) => { value.observation.nested = { rawAudioBytes: [0, 1, 2, 255] }; }],
    ["privacy", (value: any) => { value.observation.nested = { log: "secret stderr" }; }],
    ["privacy", (value: any) => { value.observation.nested = { logs: ["secret trace"] }; }],
  ])("rejects %s failure with an actionable stage", (stage, mutate) => {
    const value = manifest();
    mutate(value);
    expect(() => validateM4PublishedManifest(value)).toThrow(new RegExp(`M4 proof failed at ${stage}.*Next action:`));
  });
});

function manifest() {
  const segments = M4_EXPECTED_RANGES.map((range) => ({ ...range, segmentId: `segment-${range.ordinal}` }));
  return {
    schema: "MEETLESS_M4_COMPOSITION_PROOF v1",
    status: "passed",
    observation: {
      schema: "MEETLESS_M4_COMPOSITION_OBSERVATION v1",
      evidencePolicy: { generatedFixture: true, liveSource: false, nativeProvider: false, fakeNativeSubstitution: false },
      identity: { exactInstalledHost: true, exactRunMarker: true, trustedRendererBridge: true },
      sidebar: {
        meetingIds: [M4_DISTRACTOR_MEETING_ID, M4_TARGET_MEETING_ID],
        selectedMeetingId: M4_TARGET_MEETING_ID,
        selectedAccessibility: true,
        detailMeetingId: M4_TARGET_MEETING_ID,
      },
      authoritativeTranscript: { meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID, segments },
      rpcTranscript: { meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID, segments: structuredClone(segments) },
      renderedTranscript: { segments: structuredClone(segments), distractorSentinelPresent: false },
      citation: {
        meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID,
        segmentId: "segment-2", text: M4_EXPECTED_RANGES[2]!.text, startMs: 60_000, endMs: 65_000,
      },
      playback: {
        audioAccepted: true, playResolved: true, maximumCurrentTime: 4.9, boundedStopObserved: true,
        clipDurationSeconds: 5.04, markerHz: 880, markerPowerRatio: 8,
      },
    },
    cleanup: {
      status: "passed", stagedRootRemoved: true, originalRootRestored: true,
      runStateRemoved: true, proofArtifactRootRemoved: true, liveHostPids: [], errors: [],
    },
    restoration: {
      originalRootExisted: true, matched: true,
      beforeDigest: "a".repeat(64), afterDigest: "a".repeat(64),
    },
    evidence: { screenshot: "screenshot.png" },
  };
}
