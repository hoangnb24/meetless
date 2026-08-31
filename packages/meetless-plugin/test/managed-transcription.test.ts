import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ManagedTranscriptionPolicy,
} from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import type { TranscriptionProvider } from "../src/transcription-provider.js";
import { ManagedTranscriptionService } from "../src/managed-transcription.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const NOW = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed transcription adapter", () => {
  test("preserves a provider result across a crash and publishes once through MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-transcription-"));
    roots.push(root);
    const audioPath = path.join(root, "meeting.wav");
    const wav = pcmWav(24_000);
    await writeFile(audioPath, wav);
    const identity = identityOf(wav);
    const store = await savedStore(root, audioPath, identity);
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "composition-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "composition-install", deviceKeyId: "composition-key" });
    const provider: TranscriptionProvider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async () => ({
        text: "The release uses a local MeetingStore.",
        detectedLanguages: ["en"],
        usage: null,
      })),
    };
    const crashed = new ManagedTranscriptionService(store, policy, provider, {
      afterProviderSuccess: () => { throw new Error("simulated crash after provider success"); },
    });

    await expect(crashed.transcribe({
      recordingId: "recording-composition",
      audioPath,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: identity.sha256,
      claimedDurationSeconds: 1.5,
    })).rejects.toThrow("simulated crash");
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    const jobId = policy.temporaryArtifacts().resultJobIds[0];
    expect(jobId).toBeDefined();
    expect(policy.job(jobId!).status).toBe("provider_completed");
    expect(await store.getTranscriptForMeeting("meeting-composition")).toBeNull();

    const recovered = new ManagedTranscriptionService(store, policy, provider);
    const result = await recovered.transcribe({
      recordingId: "recording-composition",
      audioPath,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: identity.sha256,
    });
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(result.job).toMatchObject({ status: "succeeded", providerResult: null, audio: { durationMs: 1_500, billableSeconds: 2 } });
    expect(result.transcript).toMatchObject({ status: "ready", audio: { durationMs: 1_500 } });
    expect(await store.resolveCitation("meeting-composition", result.transcript.ranges[0]!.segmentId)).toMatchObject({
      meetingId: "meeting-composition",
      text: "The release uses a local MeetingStore.",
      startMs: 0,
      endMs: 1_500,
    });
    expect(policy.ledger()).toEqual([expect.objectContaining({ seconds: 2 })]);
    expect(policy.temporaryArtifacts()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
    const persisted = await store.listTranscripts("meeting-composition");
    expect(persisted[0]).toMatchObject({ status: "ready", recordingId: "recording-composition" });
    expect(JSON.stringify(persisted)).not.toContain("providerResult");

    await expect(recovered.transcribe({
      recordingId: "recording-composition",
      audioPath,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: identity.sha256,
    })).resolves.toMatchObject({ job: { status: "succeeded" }, transcript: { status: "ready" } });
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(policy.ledger()).toHaveLength(1);
  });

  test("rejects a tampered saved identity before reserving managed quota", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-tamper-"));
    roots.push(root);
    const audioPath = path.join(root, "meeting.wav");
    const original = pcmWav(16_000);
    await writeFile(audioPath, original);
    const store = await savedStore(root, audioPath, identityOf(original));
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "tamper-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "tamper-install", deviceKeyId: "tamper-key" });
    await writeFile(audioPath, pcmWav(32_000));
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe: async () => ({ text: "must not run", detectedLanguages: [] }),
    };
    const service = new ManagedTranscriptionService(store, policy, provider);

    await expect(service.transcribe({
      recordingId: "recording-composition",
      audioPath,
      credential: device.credential,
      chunkId: "tamper-chunk",
    })).rejects.toThrow("does not match the saved recording");
    expect(policy.ledger()).toHaveLength(0);
    expect(policy.temporaryArtifacts()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
  });
});

async function savedStore(root: string, audioPath: string, identity: { byteLength: number; sha256: string }): Promise<MeetingStore> {
  const store = new MeetingStore({ root: path.join(root, "store"), now: () => NOW });
  await store.create({ id: "meeting-composition", title: "Managed composition" });
  await store.startRecording({ id: "recording-composition", meetingId: "meeting-composition" });
  await store.commitChunk("recording-composition", {
    id: "chunk-source",
    source: "microphone",
    storageKey: "sessions/recording-composition/chunk.wav",
    byteLength: identity.byteLength,
    sha256: identity.sha256,
    committedAt: NOW,
    logicalStartMs: 0,
    durationMs: 1_500,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery("recording-composition", "capture closed");
  await store.markInventoryScanning("recording-composition");
  await store.publishInventory("recording-composition", {
    storageKey: "sessions/recording-composition/inventory.ndjson",
    digest: "composition-inventory",
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: NOW,
  });
  await store.beginFinalization("recording-composition", {
    openChunksDurablyClosed: true,
    chunkSetDigest: "composition-inventory",
    destination: audioPath,
    expectedIdentity: identity,
  });
  await store.markRecordingSaved("recording-composition", { destination: audioPath, identity, readable: true });
  return store;
}

function identityOf(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
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
