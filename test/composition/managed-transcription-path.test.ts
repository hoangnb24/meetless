import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ManagedTranscriptionPolicy } from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import { ManagedTranscriptionService } from "../../packages/meetless-plugin/src/managed-transcription.js";
import type { TranscriptionProvider } from "../../packages/meetless-plugin/src/transcription-provider.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const NOW = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed transcription composition", () => {
  test("publishes the managed result through MeetingStore's durable transcript and citation lifecycle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-composition-"));
    roots.push(root);
    const audioPath = path.join(root, "managed.wav");
    const wav = pcmWav(16_000);
    await writeFile(audioPath, wav);
    const identity = { byteLength: wav.byteLength, sha256: createHash("sha256").update(wav).digest("hex") };
    const store = await savedStore(root, audioPath, identity);
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "composition-proof-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "composition-proof-install", deviceKeyId: "composition-proof-key" });
    const transcribe = vi.fn(async () => ({ text: "A durable managed transcript.", detectedLanguages: ["en"], usage: null }));
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe,
    };

    const result = await new ManagedTranscriptionService(store, policy, provider).transcribe({
      recordingId: "recording-composition-proof",
      audioPath,
      credential: device.credential,
      audioId: identity.sha256,
      chunkId: "chunk-composition-proof",
    });

    expect(result.transcript.status).toBe("ready");
    expect(await store.resolveCitation("meeting-composition-proof", result.transcript.ranges[0]!.segmentId)).toMatchObject({
      text: "A durable managed transcript.",
      audioPath,
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(policy.ledger()).toHaveLength(1);
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      meetings: Array<{ id: string; status: string }>;
      transcripts?: Array<{ status: string; meetingId: string }>;
    };
    expect(persisted.meetings).toContainEqual({ id: "meeting-composition-proof", status: "ready", createdAt: NOW, updatedAt: NOW, title: "Managed composition proof" });
    expect(persisted.transcripts).toEqual([expect.objectContaining({ status: "ready", meetingId: "meeting-composition-proof" })]);
  });
});

async function savedStore(root: string, audioPath: string, identity: { byteLength: number; sha256: string }): Promise<MeetingStore> {
  const store = new MeetingStore({ root: path.join(root, "store"), now: () => NOW });
  await store.create({ id: "meeting-composition-proof", title: "Managed composition proof" });
  await store.startRecording({ id: "recording-composition-proof", meetingId: "meeting-composition-proof" });
  await store.commitChunk("recording-composition-proof", {
    id: "source-chunk",
    source: "microphone",
    storageKey: "sessions/recording-composition-proof/source.wav",
    byteLength: identity.byteLength,
    sha256: identity.sha256,
    committedAt: NOW,
    logicalStartMs: 0,
    durationMs: 1_000,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery("recording-composition-proof", "capture closed");
  await store.markInventoryScanning("recording-composition-proof");
  await store.publishInventory("recording-composition-proof", {
    storageKey: "sessions/recording-composition-proof/inventory.ndjson",
    digest: "composition-proof-inventory",
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: NOW,
  });
  await store.beginFinalization("recording-composition-proof", {
    openChunksDurablyClosed: true,
    chunkSetDigest: "composition-proof-inventory",
    destination: audioPath,
    expectedIdentity: identity,
  });
  await store.markRecordingSaved("recording-composition-proof", { destination: audioPath, identity, readable: true });
  return store;
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
