import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import { validateCommittedWavChunk, type CommittedChunkClaim } from "../src/chunk-validator.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("committed WAV byte authority", () => {
  test("rejects truncation, malformed bytes, false identity, and false timeline metadata before MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-chunk-validator-"));
    roots.add(root);
    const store = new MeetingStore({ root });
    const meeting = await store.create({ title: "Validation boundary" });
    const recording = await store.startRecording({ meetingId: meeting.id });
    const sessionDirectory = path.join(root, "sessions", recording.id);
    await mkdir(sessionDirectory, { recursive: true });

    const validPath = path.join(sessionDirectory, "chunk--microphone--000000--000000000000--000000016000--16000--1.wav");
    await writeFile(validPath, pcmWav(16_000));
    const validClaim = await claim(validPath, "microphone", 0, 1_000);

    const truncatedPath = path.join(sessionDirectory, "chunk--microphone--000001--000000016000--000000016000--16000--1.wav");
    await writeFile(truncatedPath, (await readFile(validPath)).subarray(0, 100));
    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, truncatedPath)).rejects.toThrow(/RIFF|truncated|metadata/u);

    const malformedPath = path.join(sessionDirectory, "chunk--system--000000--000000000000--000000016000--16000--1.wav");
    const malformed = pcmWav(16_000); malformed.write("NOPE", 8, "ascii");
    await writeFile(malformedPath, malformed);
    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, malformedPath)).rejects.toThrow(/RIFF\/WAVE/u);

    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, validPath, {
      ...validClaim, sha256: "0".repeat(64),
    })).rejects.toThrow(/does not match validated WAV bytes/u);
    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, validPath, {
      ...validClaim, logicalStartMs: 1,
    })).rejects.toThrow(/does not match validated WAV bytes/u);

    const falseFilenamePath = path.join(sessionDirectory, "chunk--system--000001--000000016000--000000015999--16000--1.wav");
    await writeFile(falseFilenamePath, pcmWav(16_000));
    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, falseFilenamePath)).rejects.toThrow(/filename metadata/u);
    expect((await store.listRecordings())[0]!.chunks).toEqual([]);

    await expect(validateAndCommit(store, recording.id, root, sessionDirectory, validPath, validClaim)).resolves.toMatchObject({
      id: validClaim.id, sha256: validClaim.sha256, byteLength: validClaim.byteLength,
    });
    expect((await store.listRecordings())[0]!.chunks.map((chunk) => chunk.id)).toEqual([validClaim.id]);
  });
});

async function validateAndCommit(
  store: MeetingStore,
  recordingId: string,
  storeRoot: string,
  sessionDirectory: string,
  filePath: string,
  eventClaim?: CommittedChunkClaim,
) {
  const chunk = await validateCommittedWavChunk({ filePath, sessionDirectory, storeRoot, claim: eventClaim });
  await store.commitChunk(recordingId, chunk);
  return chunk;
}

async function claim(
  filePath: string,
  source: "microphone" | "system",
  logicalStartMs: number,
  durationMs: number,
): Promise<CommittedChunkClaim> {
  const bytes = await readFile(filePath);
  return {
    id: path.basename(filePath, ".wav"), source, path: filePath,
    byteLength: (await stat(filePath)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    logicalStartMs, durationMs, sampleRate: 16_000, channels: 1, format: "wav",
  };
}

function pcmWav(frameCount: number): Buffer {
  const data = Buffer.alloc(44 + frameCount * 2);
  data.write("RIFF", 0, "ascii"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii"); data.writeUInt32LE(frameCount * 2, 40);
  return data;
}
