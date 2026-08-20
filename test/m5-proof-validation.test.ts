import { describe, expect, test } from "vitest";
import {
  M4_DISTRACTOR_MEETING_ID,
  M4_EXPECTED_RANGES,
  M4_TARGET_MEETING_ID,
  M4_TARGET_RECORDING_ID,
} from "../scripts/m4-proof-validation.mjs";
import { validateM5PublishedManifest } from "../scripts/m5-proof-validation.mjs";

describe("M5 real-Codex composition proof validation", () => {
  test("accepts grounded chat, playback, restart restoration, and insufficient evidence", () => {
    expect(() => validateM5PublishedManifest(manifest())).not.toThrow();
  });

  test.each([
    ["provider", (value: any) => { value.observation.chat.realCodex = false; }],
    ["supported-answer", (value: any) => { value.observation.chat.supported.outcome = "insufficient_evidence"; }],
    ["supported-citation", (value: any) => { value.observation.chat.supported.citationSegmentIds = ["segment-0"]; }],
    ["citation-playback", (value: any) => { value.observation.chat.citationPlayback.markerHz = 440; }],
    ["restart", (value: any) => { value.observation.chat.restart.historyRestored = false; }],
    ["insufficient-evidence", (value: any) => { value.observation.chat.unsupported.text = "invented"; }],
    ["insufficient-rendering", (value: any) => { value.observation.chat.unsupported.canonicalRendered = false; }],
    ["persistence-privacy", (value: any) => { value.observation.chat.noPaseoIdentityPersisted = false; }],
    ["cleanup", (value: any) => { value.cleanup.stagedRootRemoved = false; }],
    ["privacy", (value: any) => { value.evidence.providerLog = "/private/tmp/provider.log"; }],
  ])("rejects %s failure with an actionable stage", (stage, mutate) => {
    const value = manifest();
    mutate(value);
    expect(() => validateM5PublishedManifest(value)).toThrow(new RegExp(`(?:M5|M4) proof failed at ${stage}.*Next action:`));
  });
});

function manifest() {
  const segments = M4_EXPECTED_RANGES.map((range) => ({ ...range, segmentId: `segment-${range.ordinal}` }));
  return {
    schema: "MEETLESS_M5_COMPOSITION_PROOF v1",
    status: "passed",
    frontierId: "M5-PROOF",
    observation: {
      schema: "MEETLESS_M5_COMPOSITION_OBSERVATION v1",
      evidencePolicy: { generatedFixture: true, liveSource: false, nativeProvider: false, fakeNativeSubstitution: false },
      identity: { exactInstalledHost: true, exactRunMarker: true, trustedRendererBridge: true },
      sidebar: { meetingIds: [M4_DISTRACTOR_MEETING_ID, M4_TARGET_MEETING_ID], selectedMeetingId: M4_TARGET_MEETING_ID, selectedAccessibility: true, detailMeetingId: M4_TARGET_MEETING_ID },
      authoritativeTranscript: { meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID, segments },
      rpcTranscript: { meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID, segments: structuredClone(segments) },
      renderedTranscript: { segments: structuredClone(segments), distractorSentinelPresent: false },
      citation: { meetingId: M4_TARGET_MEETING_ID, recordingId: M4_TARGET_RECORDING_ID, segmentId: "segment-2", text: M4_EXPECTED_RANGES[2]!.text, startMs: 60_000, endMs: 65_000 },
      playback: { audioAccepted: true, playResolved: true, maximumCurrentTime: 4.9, boundedStopObserved: true, clipDurationSeconds: 5.04, markerHz: 880, markerPowerRatio: 8 },
      chat: {
        realCodex: true, provider: "codex", model: "gpt-5", transcriptRangeCount: 3,
        supported: { outcome: "supported", text: "The third interval.", citationSegmentIds: ["segment-2"] },
        citationPlayback: { boundedStopObserved: true, markerHz: 880, markerPowerRatio: 8 },
        restart: { exactInstalledHost: true, historyRestored: true },
        unsupported: { outcome: "insufficient_evidence", text: null, citationSegmentIds: [], canonicalRendered: true },
        noPaseoIdentityPersisted: true,
      },
    },
    cleanup: { status: "passed", stagedRootRemoved: true, originalRootRestored: true, runStateRemoved: true, proofArtifactRootRemoved: true, liveHostPids: [], errors: [] },
    restoration: { originalRootExisted: true, matched: true, beforeDigest: "a".repeat(64), afterDigest: "a".repeat(64) },
    evidence: { screenshot: "screenshot.png" },
    evidenceLimit: "Machine-observed browser playback only.",
  };
}
