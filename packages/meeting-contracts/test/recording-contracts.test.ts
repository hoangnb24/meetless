import { describe, expect, test } from "vitest";
import { RecordingControlRequestSchema, RecordingStatusWireSchema } from "../src/index.js";

describe("private recording wire contracts", () => {
  test("accepts a complete source-labelled timeline status", () => {
    expect(RecordingStatusWireSchema.parse({
      status: "recording", recordingId: "r-1", meetingId: "m-1", title: "Sync",
      elapsedMs: 1_000, paused: false, outputPath: null, error: null,
      chunks: [{
        id: "mic-1", source: "microphone", storageKey: "sessions/r-1/mic-1.wav",
        byteLength: 32_044, sha256: "abc", committedAt: "2026-08-17T10:00:01.000Z",
        logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
      }],
    }).chunks[0]?.source).toBe("microphone");
  });

  test("rejects missing start title and unknown transport fields", () => {
    expect(() => RecordingControlRequestSchema.parse({ version: 1, requestId: "x", command: "start" }))
      .toThrow(/start requires a meeting title/);
    expect(() => RecordingControlRequestSchema.parse({ version: 1, requestId: "x", command: "status", fromQuery: true }))
      .toThrow();
  });
});
