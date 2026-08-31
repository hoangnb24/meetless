import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ManagedTranscriptionPolicy,
  type ManagedTranscriptionSnapshot,
  type ManagedTimelineEvidence,
} from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import { MeetingLifecycleCoordinator } from "../src/meeting-lifecycle-coordinator.js";
import type { TranscriptionProvider } from "../src/transcription-provider.js";
import { ManagedTranscriptionService, RecordingManagedTimelinePreparer } from "../src/managed-transcription.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const NOW = "2026-08-31T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed transcription adapter", () => {
  test("rehydrates after a process crash and publishes one provider result through MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-transcription-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "composition-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "composition-install", deviceKeyId: "composition-key" });
    const provider: TranscriptionProvider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async ({ audioPath }) => {
        expect(audioPath).not.toBe(fixture.outputPath);
        expect(audioPath).toMatch(/managed-transcription-timelines/u);
        return {
          text: "The durable output is MP3 while billing uses a canonical WAV timeline.",
          detectedLanguages: ["en"],
          usage: null,
        };
      }),
    };
    let persistedState: ManagedTranscriptionSnapshot | null = null;
    const crashed = new ManagedTranscriptionService(fixture.store, policy, provider, {
      lifecycle,
      afterProviderSuccess: () => {
        // This is the fake durable repository boundary: state is serialized
        // after provider completion and before the process failure.
        persistedState = JSON.parse(JSON.stringify(policy.snapshot())) as ManagedTranscriptionSnapshot;
        throw new Error("simulated crash after provider success");
      },
    });

    await expect(crashed.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: "composition-audio",
      claimedDurationSeconds: 1.5,
    })).rejects.toThrow("simulated crash");
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    const jobId = policy.temporaryArtifacts().resultJobIds[0];
    expect(jobId).toBeDefined();
    expect(policy.job(jobId!).status).toBe("provider_completed");

    expect(persistedState).not.toBeNull();
    const restartedPolicy = ManagedTranscriptionPolicy.fromSnapshot(persistedState!, { now: () => START });
    const recovered = new ManagedTranscriptionService(fixture.store, restartedPolicy, provider, { lifecycle });
    const result = await recovered.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: "composition-audio",
    });
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(result.job).toMatchObject({ status: "succeeded", providerResult: null, audio: { durationMs: 1_500, billableSeconds: 2 } });
    expect(result.transcript).toMatchObject({ status: "ready", audio: { destination: fixture.outputPath, durationMs: 1_500 } });
    await expect(fixture.store.resolveCitation(fixture.meetingId, result.transcript.ranges[0]!.segmentId)).resolves.toMatchObject({
      meetingId: fixture.meetingId,
      audioPath: fixture.outputPath,
      text: "The durable output is MP3 while billing uses a canonical WAV timeline.",
      startMs: 0,
      endMs: 1_500,
    });
    expect(restartedPolicy.ledger()).toEqual([expect.objectContaining({ seconds: 2 })]);
    expect(restartedPolicy.temporaryArtifacts()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
    expect((await fixture.store.listTranscripts(fixture.meetingId))[0]).toMatchObject({ status: "ready", recordingId: fixture.recordingId });

    await expect(recovered.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "chunk-composition",
      audioId: "composition-audio",
    })).resolves.toMatchObject({ job: { status: "succeeded" }, transcript: { status: "ready" } });
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(restartedPolicy.ledger()).toHaveLength(1);
  });

  test("recovers a transcript with every range checkpointed before publish without calling provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-checkpoint-recovery-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "checkpoint-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "checkpoint-install", deviceKeyId: "checkpoint-key" });
    const preparer = new RecordingManagedTimelinePreparer(path.join(root, "store"));
    const recording = (await fixture.store.listRecordings())[0]!;
    const timeline = await preparer.prepare(recording, "checkpoint-audio");
    const wav = await readFile(timeline.path);
    const jobInput = {
      credential: device.credential,
      timeline: {
        recordingId: recording.id,
        audioId: timeline.audioId,
        manifestSha256: timeline.manifestSha256,
        contentSha256: timeline.identity.sha256,
        byteLength: timeline.identity.byteLength,
        startMs: 0,
        endMs: timeline.endMs,
      } satisfies ManagedTimelineEvidence,
      chunkId: "checkpoint-chunk",
      wav,
    };
    const job = policy.reserve(jobInput).job;
    policy.startProvider(job.jobId, job.admissionId);
    policy.recordProviderSuccess(job.jobId, job.admissionId, { text: "checkpointed before publish", detectedLanguages: ["en"] });
    const transcript = await fixture.store.ensureTranscript({
      meetingId: fixture.meetingId,
      recordingId: fixture.recordingId,
      audio: { destination: fixture.outputPath, ...fixture.outputIdentity, durationMs: 1_500 },
      rangeMs: 1_500,
    });
    const request = await fixture.store.beginTranscriptRequest(transcript.id);
    await fixture.store.checkpointTranscriptRange(transcript.id, {
      range: request!.range,
      attempts: request!.attempt,
      text: "checkpointed before publish",
      usage: null,
      detectedLanguages: ["en"],
    });
    await timeline.cleanup();

    const provider: TranscriptionProvider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async () => ({ text: "must not run", detectedLanguages: [] })),
    };
    const service = new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle });
    const result = await service.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "checkpoint-chunk",
      audioId: "checkpoint-audio",
    });
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(result.transcript.status).toBe("ready");
    expect(policy.ledger()).toHaveLength(1);
  });

  test("holds the shared transcription lifecycle lease while provider work is blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-lifecycle-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "lifecycle-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "lifecycle-install", deviceKeyId: "lifecycle-key" });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    let unblock!: () => void;
    const providerGate = new Promise<void>((resolve) => { unblock = resolve; });
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe: async () => {
        started();
        await providerGate;
        return { text: "blocked then complete", detectedLanguages: [] };
      },
    };
    const service = new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle });
    const transcription = service.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "lifecycle-chunk",
      audioId: "lifecycle-audio",
    });
    await providerStarted;
    expect(lifecycle.tryAcquireDeletion(fixture.meetingId)).toEqual({ acquired: false, active: ["transcription"] });
    unblock();
    await transcription;
    const deletion = lifecycle.tryAcquireDeletion(fixture.meetingId);
    expect(deletion.acquired).toBe(true);
    if (deletion.acquired) deletion.lease.release();
  });

  test("fails and releases reservation when provider status rejects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-status-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "status-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "status-install", deviceKeyId: "status-key" });
    let statusAttempts = 0;
    const transcribe = vi.fn(async () => ({ text: "must not run", detectedLanguages: [] }));
    const provider: TranscriptionProvider = {
      status: async () => {
        if (statusAttempts++ === 0) throw new Error("status transport failed");
        return "invalid";
      },
      transcribe,
    };
    const service = new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle });
    const input = {
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "status-chunk",
      audioId: "status-audio",
    };
    await expect(service.transcribe(input)).rejects.toThrow("provider status is unavailable");
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 0, usedSeconds: 0 });
    expect(policy.snapshot().jobs).toHaveLength(1);
    expect(policy.snapshot().jobs[0]).toMatchObject({ status: "failed", failureReason: "provider status unavailable" });

    await expect(service.transcribe(input)).rejects.toThrow("provider is unavailable");
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 0, usedSeconds: 0 });
    expect(policy.snapshot().jobs[0]).toMatchObject({ status: "failed", failureReason: "provider unavailable" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("rejects a tampered durable MP3 before reserving managed quota", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-tamper-"));
    roots.push(root);
    const fixture = await savedStore(root);
    await writeFile(fixture.outputPath, Buffer.from("tampered-mp3-output"));
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "tamper-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "tamper-install", deviceKeyId: "tamper-key" });
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe: async () => ({ text: "must not run", detectedLanguages: [] }),
    };
    const service = new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle });

    await expect(service.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "tamper-chunk",
      audioId: "tamper-audio",
    })).rejects.toThrow("durable saved MP3 identity");
    expect(policy.ledger()).toHaveLength(0);
    expect(policy.temporaryArtifacts()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
  });

  test("rejects a changed validated inventory chunk before managed admission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-chunk-tamper-"));
    roots.push(root);
    const fixture = await savedStore(root);
    const tampered = Buffer.from(await readFile(fixture.chunkPaths[0]!));
    tampered[44] = (tampered[44] ?? 0) ^ 1;
    await writeFile(fixture.chunkPaths[0]!, tampered);
    const lifecycle = new MeetingLifecycleCoordinator();
    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "chunk-tamper-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "chunk-tamper-install", deviceKeyId: "chunk-tamper-key" });
    const provider: TranscriptionProvider = {
      status: async () => "configured",
      transcribe: async () => ({ text: "must not run", detectedLanguages: [] }),
    };
    const service = new ManagedTranscriptionService(fixture.store, policy, provider, { lifecycle });

    await expect(service.transcribe({
      recordingId: fixture.recordingId,
      credential: device.credential,
      chunkId: "chunk-tamper-admission",
      audioId: "chunk-tamper-audio",
    })).rejects.toThrow("Managed chunk identity changed");
    expect(policy.ledger()).toHaveLength(0);
    expect(policy.snapshot().jobs).toHaveLength(0);
  });
});

interface SavedFixture {
  store: MeetingStore;
  meetingId: string;
  recordingId: string;
  outputPath: string;
  outputIdentity: { byteLength: number; sha256: string };
  chunkPaths: string[];
}

async function savedStore(root: string): Promise<SavedFixture> {
  const meetingId = "meeting-composition";
  const recordingId = "recording-composition";
  const storeRoot = path.join(root, "store");
  const outputPath = path.join(root, "recording.mp3");
  const chunkIds = [
    "chunk--microphone--000000--000000000000--000000024000--16000--1",
    "chunk--system--000000--000000000000--000000024000--16000--1",
  ];
  const chunks = [pcmWav(24_000, 1), pcmWav(24_000, 2)];
  const output = Buffer.from("fake-mp3-output");
  const chunkPaths = chunkIds.map((chunkId) => path.join(storeRoot, "sessions", recordingId, `${chunkId}.wav`));
  const inventoryPath = path.join(storeRoot, "sessions", recordingId, "inventory.ndjson");
  await mkdir(path.dirname(chunkPaths[0]!), { recursive: true, mode: 0o700 });
  await Promise.all(chunkPaths.map((chunkPath, index) => writeFile(chunkPath, chunks[index]!, { flag: "w+" })));
  await writeFile(outputPath, output, { flag: "w+" });
  const chunkIdentities = chunks.map(identityOf);
  const outputIdentity = identityOf(output);
  const store = new MeetingStore({ root: storeRoot, now: () => NOW });
  await store.create({ id: meetingId, title: "Managed composition" });
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
      durationMs: 1_500,
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
    durationMs: 1_500,
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
  return { store, meetingId, recordingId, outputPath, outputIdentity, chunkPaths };
}

function identityOf(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pcmWav(sampleCount: number, marker = 0): Uint8Array {
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
  bytes[44] = marker;
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
