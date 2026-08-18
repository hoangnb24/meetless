import { describe, expect, test } from "vitest";
import {
  MeetingCitationResolveRpc,
  RecordingControlRequestSchema,
  RecordingStatusWireSchema,
} from "../src/index.js";

describe("private recording wire contracts", () => {
  test("accepts compact source-labelled inventory status", () => {
    expect(RecordingStatusWireSchema.parse({
      status: "recoverable", recordingId: "r-1", meetingId: "m-1", title: "Sync",
      elapsedMs: 1_000, paused: false, outputPath: null, error: null,
      chunks: [],
      inventoryState: "complete", chunkCount: 340_944, microphoneCount: 170_472,
      systemCount: 170_472, inventoryDigest: "abc", retryEligible: true,
    }).chunkCount).toBe(340_944);
  });

  test("rejects missing start title and unknown transport fields", () => {
    expect(() => RecordingControlRequestSchema.parse({ version: 1, requestId: "x", command: "start" }))
      .toThrow(/start requires a meeting title/);
    expect(() => RecordingControlRequestSchema.parse({ version: 1, requestId: "x", command: "status", fromQuery: true }))
      .toThrow();
  });

  test("keeps routine status bounded for a 340k inventory", () => {
    const status = RecordingStatusWireSchema.parse({
      status: "recoverable", recordingId: "r-scale", meetingId: "m-scale", title: "Scale",
      elapsedMs: 60_000, paused: false, chunks: [], inventoryState: "complete",
      chunkCount: 340_944, microphoneCount: 170_472, systemCount: 170_472,
      inventoryDigest: "digest", retryEligible: true, outputPath: null, error: null,
    });
    expect(JSON.stringify(status).length).toBeLessThan(500);
    expect(status.chunks).toHaveLength(0);
    expect(() => RecordingStatusWireSchema.parse({ ...status, chunks: Array.from({ length: 5 }, (_, index) => ({
      id: `chunk-${index}`, source: "microphone", storageKey: `sessions/r/${index}.wav`, byteLength: 1,
      sha256: "x", committedAt: "2026-08-18T00:00:00.000Z", logicalStartMs: index,
      durationMs: 1, sampleRate: 16_000, channels: 1, format: "wav",
    })) })).toThrow();
  });

  test("rejects malformed citation playback ranges", () => {
    expect(() => MeetingCitationResolveRpc.output.parse({
      meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
      startMs: 2_000, endMs: 2_000, text: "hello", audio: { mimeType: "audio/mpeg", base64: "AQID" },
    })).toThrow(/bounded/);
    expect(() => MeetingCitationResolveRpc.input.parse({ meetingId: "m-1", segmentId: "segment-1", audioPath: "secret" }))
      .toThrow();
    expect(MeetingCitationResolveRpc.output.parse({
      meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
      startMs: 2_000, endMs: 4_000, text: "hello", audio: { mimeType: "audio/mpeg", base64: "AQID" },
    })).not.toHaveProperty("audioPath");
  });
});
