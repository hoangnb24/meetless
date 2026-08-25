import { describe, expect, test } from "vitest";
import { validateBoundedPlaybackObservation } from "../../../scripts/lib/macos-playback-proof.mjs";

const citation = {
  meetingId: "meeting-1",
  recordingId: "recording-1",
  segmentId: "segment-1",
  startMs: 0,
  endMs: 1_100,
};

describe("bounded packaged citation playback proof", () => {
  test("accepts positive progress inside the resolved citation interval", () => {
    expect(validateBoundedPlaybackObservation({
      citationIdentity: citation,
      playResolved: true,
      pauseObserved: true,
      maximumCurrentTime: 1.1,
    }, citation)).toMatchObject({ positiveBoundedProgress: true, currentTimeSeconds: 1.1 });
  });

  test("accepts clip-relative progress for a non-zero absolute citation start", () => {
    const nonZeroStartCitation = { ...citation, startMs: 2_000, endMs: 4_000 };
    expect(validateBoundedPlaybackObservation({
      citationIdentity: nonZeroStartCitation,
      playResolved: true,
      pauseObserved: true,
      maximumCurrentTime: 1,
    }, nonZeroStartCitation)).toMatchObject({
      clipDurationSeconds: 2,
      positiveBoundedProgress: true,
    });
  });

  test.each([
    ["zero time", { maximumCurrentTime: 0 }],
    ["negative time", { maximumCurrentTime: -0.1 }],
    ["NaN time", { maximumCurrentTime: Number.NaN }],
    ["infinite time", { maximumCurrentTime: Number.POSITIVE_INFINITY }],
    ["outside interval", { maximumCurrentTime: 1.2 }],
    ["pause without progress", { maximumCurrentTime: 0, pauseObserved: false }],
    ["wrong citation identity", { maximumCurrentTime: 0.5, citationIdentity: { ...citation, segmentId: "other" } }],
  ])("rejects %s", (_label, change) => {
    expect(() => validateBoundedPlaybackObservation({
      citationIdentity: citation,
      playResolved: true,
      pauseObserved: true,
      maximumCurrentTime: 0.5,
      ...change,
    }, citation)).toThrow(/playback|progress/);
  });
});
