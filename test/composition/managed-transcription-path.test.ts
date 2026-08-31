import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ManagedTranscriptionPolicy } from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import { MeetingLifecycleCoordinator } from "../../packages/meetless-plugin/src/meeting-lifecycle-coordinator.js";
import { ManagedTranscriptionService } from "../../packages/meetless-plugin/src/managed-transcription.js";
import type { TranscriptionProvider } from "../../packages/meetless-plugin/src/transcription-provider.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const NOW = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed transcription composition", () => {
  test("maps validated repository chunks into a temporary canonical WAV while durable output stays MP3", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-composition-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "composition-proof-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "composition-proof-install", deviceKeyId: "composition-proof-key" });
    const transcribe = vi.fn(async ({ audioPath, audioIdentity }: Parameters<NonNullable<TranscriptionProvider["transcribe"]>>[0]) => {
      expect(audioPath).not.toBe(fixture.outputPath);
      expect(audioPath).toMatch(/managed-transcription-timelines/u);
      expect(audioIdentity.sha256).not.toBe(fixture.outputIdentity.sha256);
      return { text: "A durable managed transcript.", detectedLanguages: ["en"], usage: null };
    });
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe,
    };

    const result = await new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle }).transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      audioId: "composition-audio",
      chunkId: "chunk-composition-proof",
      claimedDurationSeconds: 1,
    });

    expect(result.transcript.status).toBe("ready");
    await expect(fixture.store.resolveCitation(fixture.meetingId, result.transcript.ranges[0]!.segmentId)).resolves.toMatchObject({
      text: "A durable managed transcript.",
      audioPath: fixture.outputPath,
      audioIdentity: fixture.outputIdentity,
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(policy.ledger()).toHaveLength(1);
    expect(await readFile(fixture.outputPath)).toEqual(Buffer.from("fake-mp3-output"));
    expect(await fixture.store.getTranscriptForMeeting(fixture.meetingId)).toMatchObject({
      status: "ready",
      audio: { destination: fixture.outputPath, sha256: fixture.outputIdentity.sha256 },
    });
    expect(await filesUnder(path.join(root, "store", "managed-transcription-timelines"))).toEqual([]);
  });
});

interface SavedFixture {
  store: MeetingStore;
  meetingId: string;
  recordingId: string;
  outputPath: string;
  outputIdentity: { byteLength: number; sha256: string };
}

async function savedStore(root: string): Promise<SavedFixture> {
  const meetingId = "meeting-composition-proof";
  const recordingId = "recording-composition-proof";
  const storeRoot = path.join(root, "store");
  const outputPath = path.join(root, "recording.mp3");
  const chunkIds = [
    "chunk--microphone--000000--000000000000--000000016000--16000--1",
    "chunk--system--000000--000000000000--000000016000--16000--1",
  ];
  const chunks = [pcmWav(16_000, 1), pcmWav(16_000, 2)];
  const output = Buffer.from("fake-mp3-output");
  const chunkPaths = chunkIds.map((chunkId) => path.join(storeRoot, "sessions", recordingId, `${chunkId}.wav`));
  const inventoryPath = path.join(storeRoot, "sessions", recordingId, "inventory.ndjson");
  await mkdir(path.dirname(chunkPaths[0]!), { recursive: true, mode: 0o700 });
  await Promise.all(chunkPaths.map((chunkPath, index) => writeFile(chunkPath, chunks[index]!, { flag: "w+" })));
  await writeFile(outputPath, output, { flag: "w+" });
  const chunkIdentities = chunks.map(identityOf);
  const outputIdentity = identityOf(output);
  const store = new MeetingStore({ root: storeRoot, now: () => NOW });
  await store.create({ id: meetingId, title: "Managed composition proof" });
  await store.startRecording({ id: recordingId, meetingId });
  for (const [index, chunkId] of chunkIds.entries()) {
    await store.commitChunk(recordingId, {
      id: chunkId,
      source: index === 0 ? "microphone" : "system",
      storageKey: path.relative(storeRoot, chunkPaths[index]!),
      byteLength: chunkIdentities[index]!.byteLength,
      sha256: chunkIdentities[index]!.sha256,
      committedAt: NOW,
      logicalStartMs: 0,
      durationMs: 1_000,
      sampleRate: 16_000,
      channels: 1,
      format: "wav",
    });
  }
  await store.prepareInventoryRecovery(recordingId, "capture closed");
  await store.markInventoryScanning(recordingId);
  const inventoryLines = chunkIds.map((chunkId, index) => ({
    sortKey: `${index === 0 ? "microphone" : "system"}:${String(0).padStart(16, "0")}:${chunkId}`,
    id: chunkId,
    source: index === 0 ? "microphone" : "system",
    storageKey: path.relative(storeRoot, chunkPaths[index]!),
    byteLength: chunkIdentities[index]!.byteLength,
    sha256: chunkIdentities[index]!.sha256,
    committedAt: NOW,
    logicalStartMs: 0,
    durationMs: 1_000,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  }));
  const inventoryBytes = Buffer.from(`${inventoryLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  await writeFile(inventoryPath, inventoryBytes, { flag: "w+" });
  await store.publishInventory(recordingId, {
    storageKey: path.relative(storeRoot, inventoryPath),
    digest: sha256(inventoryBytes),
    chunkCount: 2,
    microphoneCount: 1,
    systemCount: 1,
    publishedAt: NOW,
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true,
    chunkSetDigest: sha256(inventoryBytes),
    destination: outputPath,
    expectedIdentity: outputIdentity,
  });
  await store.markRecordingSaved(recordingId, { destination: outputPath, identity: outputIdentity, readable: true });
  return { store, meetingId, recordingId, outputPath, outputIdentity };
}

async function filesUnder(directory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function identityOf(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pcmWav(sampleCount: number): Uint8Array {
  const dataByteLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataByteLength, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
