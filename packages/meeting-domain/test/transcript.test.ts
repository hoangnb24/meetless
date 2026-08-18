import { describe, expect, test } from "vitest";
import {
  beginTranscriptRequest,
  checkpointTranscriptRange,
  canRetryTranscript,
  createTranscript,
  failTranscript,
  planTranscriptRanges,
  publishTranscript,
  reconcileTranscriptAfterRestart,
  resolveTranscriptCitation,
  retryTranscript,
} from "../src/index.js";

const now = "2026-08-18T10:00:00.000Z";

describe("transcript policy", () => {
  test("plans deterministic half-open ranges and wording-independent IDs", () => {
    const first = planTranscriptRanges({
      recordingId: "r-1", audioSha256: "audio-sha", durationMs: 65_000, rangeMs: 30_000,
    });
    const second = planTranscriptRanges({
      recordingId: "r-1", audioSha256: "audio-sha", durationMs: 65_000, rangeMs: 30_000,
    });

    expect(first).toEqual(second);
    expect(first.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 30_000], [30_000, 60_000], [60_000, 65_000],
    ]);
    expect(new Set(first.map((range) => range.segmentId)).size).toBe(3);
  });

  test("checkpoints exact saved ranges, bounds retries, and resolves only ready citations", () => {
    let transcript = createTranscript({
      id: "t-1", meetingId: "m-1", recordingId: "r-1",
      audio: { destination: "recordings/r-1.mp3", byteLength: 10, sha256: "audio-sha", durationMs: 60_000 },
      now, maxAttempts: 3,
    });
    const request = beginTranscriptRequest(transcript, now)!;
    transcript = request.transcript;
    transcript = checkpointTranscriptRange(transcript, {
      range: request.range, attempts: request.attempt, text: "Xin chào, hello",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, durationSeconds: 2 },
      detectedLanguages: ["vi", "en"], now,
    });
    expect(transcript.status).toBe("pending");

    const failedRequest = beginTranscriptRequest(transcript, now)!;
    transcript = failTranscript(failedRequest.transcript, "provider unavailable: transcription unavailable", now);
    transcript = retryTranscript(transcript, now);
    const secondRequest = beginTranscriptRequest(transcript, now)!;
    transcript = checkpointTranscriptRange(secondRequest.transcript, {
      range: secondRequest.range, attempts: secondRequest.attempt, text: "Done",
      usage: null, detectedLanguages: ["en"], now,
    });
    transcript = publishTranscript(transcript, {
      publication: { storageKey: "transcripts/t-1.json", byteLength: 20, sha256: "sidecar-sha", publishedAt: now },
      now,
    });
    expect(transcript.status).toBe("ready");
    const citation = resolveTranscriptCitation(transcript, { meetingId: "m-1", segmentId: transcript.ranges[1]!.segmentId });
    expect(citation).toMatchObject({ recordingId: "r-1", startMs: 30_000, endMs: 60_000 });
    expect(() => resolveTranscriptCitation(transcript, { meetingId: "m-1", segmentId: "unknown" })).toThrow(
      /Unknown transcript segment citation/,
    );

    let bounded = createTranscript({
      meetingId: "m-1", recordingId: "r-2",
      audio: { destination: "recordings/r-2.mp3", byteLength: 10, sha256: "audio-sha-2", durationMs: 1_000 },
      now, maxAttempts: 1,
    });
    bounded = failTranscript(beginTranscriptRequest(bounded, now)!.transcript, "provider unavailable", now);
    expect(canRetryTranscript(bounded)).toBe(false);
    expect(reconcileTranscriptAfterRestart(bounded, now)).toEqual(bounded);
    expect(() => retryTranscript(bounded)).toThrow(/retry bound/);
  });

  test("restart resumes only work with remaining attempt budget and terminalizes exhausted in-flight work", () => {
    let retryable = createTranscript({
      meetingId: "m-1", recordingId: "r-retryable",
      audio: { destination: "recordings/retryable.mp3", byteLength: 10, sha256: "retryable-sha", durationMs: 1_000 },
      now, maxAttempts: 2,
    });
    retryable = failTranscript(beginTranscriptRequest(retryable, now)!.transcript, "interrupted after durable failure", now);
    expect(canRetryTranscript(retryable)).toBe(true);
    expect(reconcileTranscriptAfterRestart(retryable, now)).toMatchObject({ status: "pending", failureReason: null });

    let exhausted = createTranscript({
      meetingId: "m-1", recordingId: "r-exhausted",
      audio: { destination: "recordings/exhausted.mp3", byteLength: 10, sha256: "exhausted-sha", durationMs: 1_000 },
      now, maxAttempts: 1,
    });
    exhausted = failTranscript(beginTranscriptRequest(exhausted, now)!.transcript, "attempt budget exhausted", now);
    expect(canRetryTranscript(exhausted)).toBe(false);
    expect(reconcileTranscriptAfterRestart(exhausted, now)).toEqual(exhausted);

    let inFlightWithBudget = createTranscript({
      meetingId: "m-1", recordingId: "r-in-flight",
      audio: { destination: "recordings/in-flight.mp3", byteLength: 10, sha256: "in-flight-sha", durationMs: 1_000 },
      now, maxAttempts: 2,
    });
    inFlightWithBudget = beginTranscriptRequest(inFlightWithBudget, now)!.transcript;
    expect(reconcileTranscriptAfterRestart(inFlightWithBudget, now)).toMatchObject({
      status: "pending", requestCount: 1, failureReason: null,
    });

    let exhaustedInFlight = createTranscript({
      meetingId: "m-1", recordingId: "r-in-flight-exhausted",
      audio: { destination: "recordings/in-flight-exhausted.mp3", byteLength: 10, sha256: "in-flight-exhausted-sha", durationMs: 1_000 },
      now, maxAttempts: 1,
    });
    exhaustedInFlight = beginTranscriptRequest(exhaustedInFlight, now)!.transcript;
    expect(reconcileTranscriptAfterRestart(exhaustedInFlight, now)).toMatchObject({
      status: "failed",
      requestCount: 1,
      failureReason: "Transcription interrupted after the final allowed attempt",
    });
  });
});
