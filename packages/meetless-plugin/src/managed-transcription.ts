import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ManagedTranscriptionPolicy,
  parseCanonicalPcmWav,
  type ManagedDeviceCredential,
  type ManagedJob,
  type ManagedProviderResult,
  type ManagedTimelineEvidence,
} from "@meetless/managed-transcription-foundation";
import {
  planTranscriptRanges,
  type CommittedRecordingChunk,
  type OutputIdentity,
  type RecordingSession,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import { fileIdentity } from "./finalizer.js";
import { readInventory, resolveStorePath } from "./inventory.js";
import { MeetingLifecycleCoordinator } from "./meeting-lifecycle-coordinator.js";
import type { TranscriptionProvider } from "./transcription-provider.js";
import { TranscriptionProviderError } from "./transcription-provider.js";

export interface ManagedTranscriptionInput {
  readonly recordingId: string;
  readonly credential: ManagedDeviceCredential;
  readonly chunkId: string;
  readonly audioId?: string;
  readonly claimedDurationSeconds?: number;
}

export interface ManagedCanonicalTimeline {
  /** Temporary canonical 16 kHz mono PCM WAV; never the durable saved MP3. */
  readonly path: string;
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly identity: OutputIdentity;
  readonly startMs: number;
  readonly endMs: number;
  cleanup(): Promise<void>;
}

export interface ManagedTimelinePreparer {
  prepare(recording: RecordingSession, audioId?: string): Promise<ManagedCanonicalTimeline>;
}

export interface ManagedTranscriptionServiceOptions {
  /** Must be the coordinator shared by recording, Ask, and deletion. */
  readonly lifecycle: MeetingLifecycleCoordinator;
  readonly timelinePreparer?: ManagedTimelinePreparer;
  readonly afterProviderSuccess?: (job: ManagedJob) => void | Promise<void>;
}

export interface ManagedTranscriptionResult {
  readonly job: ManagedJob;
  readonly transcript: TranscriptState;
}

/**
 * Edge adapter for the fake-backed managed policy. It verifies the durable MP3
 * identity, prepares one canonical timeline from the validated recording
 * inventory, calls the existing provider abstraction, and publishes only via
 * MeetingStore. The shared lifecycle lease spans provider and publication.
 */
export class ManagedTranscriptionService {
  private readonly timelinePreparer: ManagedTimelinePreparer;

  constructor(
    private readonly store: MeetingStore,
    private readonly policy: ManagedTranscriptionPolicy,
    private readonly provider: TranscriptionProvider,
    private readonly options: ManagedTranscriptionServiceOptions,
  ) {
    this.timelinePreparer = options.timelinePreparer ?? new RecordingManagedTimelinePreparer(path.dirname(store.filePath));
  }

  async transcribe(input: ManagedTranscriptionInput): Promise<ManagedTranscriptionResult> {
    const recording = (await this.store.listRecordings()).find((candidate) => candidate.id === input.recordingId);
    if (!recording || recording.status !== "saved" || !recording.savedOutput) {
      throw new Error(`Managed transcription requires saved recording ${input.recordingId}`);
    }
    const lifecycleLease = this.options.lifecycle.tryAcquireWork(recording.meetingId, "transcription");
    if (!lifecycleLease) throw new Error("Meeting deletion is in progress");
    try {
      return await this.transcribeOwned(input, recording);
    } finally {
      lifecycleLease.release();
    }
  }

  private async transcribeOwned(
    input: ManagedTranscriptionInput,
    recording: RecordingSession,
  ): Promise<ManagedTranscriptionResult> {
    const savedOutput = recording.savedOutput!;
    const savedIdentity = await fileIdentity(savedOutput.destination);
    if (!sameIdentity(savedIdentity, savedOutput)) {
      throw new Error("Managed durable saved MP3 identity does not match MeetingStore");
    }

    const timeline = await this.timelinePreparer.prepare(recording, input.audioId);
    try {
      if (timeline.recordingId !== recording.id) {
        throw new Error("Managed canonical timeline is bound to a different recording");
      }
      const requestedAudioId = input.audioId?.trim();
      if (requestedAudioId && timeline.audioId !== requestedAudioId) {
        throw new Error("Managed canonical timeline is bound to a different audio identity");
      }
      if (path.resolve(timeline.path) === path.resolve(savedOutput.destination)) {
        throw new Error("Managed canonical timeline must be temporary; durable saved output remains MP3");
      }
      const preparedIdentity = await fileIdentity(timeline.path);
      if (!sameIdentity(preparedIdentity, timeline.identity)) {
        throw new Error("Managed canonical timeline identity changed before admission");
      }
      const wav = await readFile(timeline.path);
      if (!sameIdentity(identityOf(wav), timeline.identity)) {
        throw new Error("Managed canonical timeline bytes changed before admission");
      }
      const timelineEvidence: ManagedTimelineEvidence = {
        recordingId: timeline.recordingId,
        audioId: timeline.audioId,
        manifestSha256: timeline.manifestSha256,
        contentSha256: timeline.identity.sha256,
        byteLength: timeline.identity.byteLength,
        startMs: timeline.startMs,
        endMs: timeline.endMs,
      };
      const reservation = this.policy.reserve({
        credential: input.credential,
        timeline: timelineEvidence,
        chunkId: input.chunkId,
        wav,
        claimedDurationSeconds: input.claimedDurationSeconds,
      });
      let job = reservation.job;
      if (job.status === "failed") job = this.policy.retryJob(job.jobId);
      if (job.status === "reserved") {
        let providerStatus: Awaited<ReturnType<TranscriptionProvider["status"]>>;
        try {
          providerStatus = await this.provider.status();
        } catch {
          this.policy.failJob(job.jobId, "provider status unavailable");
          throw new TranscriptionProviderError("Managed transcription provider status is unavailable");
        }
        if (providerStatus !== "configured") {
          this.policy.failJob(job.jobId, "provider unavailable");
          throw new TranscriptionProviderError("Managed transcription provider is unavailable");
        }
        this.policy.startProvider(job.jobId, job.admissionId);
        try {
          const range = planTranscriptRanges({
            recordingId: recording.id,
            audioSha256: savedOutput.sha256,
            durationMs: timeline.endMs - timeline.startMs,
            rangeMs: timeline.endMs - timeline.startMs,
          })[0];
          if (!range) throw new Error("Managed audio produced no transcript range");
          const result = await this.provider.transcribe({
            recordingId: recording.id,
            audioPath: timeline.path,
            audioIdentity: timeline.identity,
            range,
          });
          const providerResult: ManagedProviderResult = {
            text: result.text,
            detectedLanguages: result.detectedLanguages,
          };
          job = this.policy.recordProviderSuccess(job.jobId, job.admissionId, providerResult);
        } catch (error) {
          if (this.policy.job(job.jobId).status === "running") this.policy.failJob(job.jobId, "provider failed");
          if (error instanceof TranscriptionProviderError) throw error;
          throw new TranscriptionProviderError("Managed transcription provider failed");
        }
        await this.options.afterProviderSuccess?.(job);
      }

      if (job.status === "provider_completed") job = this.policy.settleJob(job.jobId);
      if (job.status !== "succeeded") {
        throw new Error(`Managed transcription job ${job.jobId} is ${job.status}`);
      }
      const transcript = await this.publishResult(
        recording.meetingId,
        recording.id,
        savedOutput,
        timeline.endMs - timeline.startMs,
        job.providerResult,
      );
      job = this.policy.acknowledgePublication(job.jobId);
      return { job, transcript };
    } finally {
      await timeline.cleanup().catch(() => undefined);
    }
  }

  private async publishResult(
    meetingId: string,
    recordingId: string,
    audio: OutputIdentity & { destination: string },
    durationMs: number,
    providerResult: ManagedProviderResult | null,
  ): Promise<TranscriptState> {
    let transcript = await this.store.ensureTranscript({
      meetingId,
      recordingId,
      audio: { ...audio, durationMs },
    });
    if (transcript.status === "ready") return transcript;

    const reconciled = await this.store.reconcileTranscriptPublications([meetingId]);
    transcript = reconciled.find((candidate) => candidate.recordingId === recordingId)
      ?? await this.store.getTranscript(transcript.id)
      ?? transcript;
    if (transcript.status === "ready") return transcript;
    if (transcript.status !== "pending") throw new Error("Managed transcript is not ready for publication");

    // MeetingStore checkpoints leave the state pending until its final publish.
    // A crash after the last checkpoint must take this path without provider work.
    if (transcript.checkpoints.length === transcript.ranges.length) {
      return this.store.publishTranscript(transcript.id);
    }
    if (!providerResult) throw new Error("Managed provider result expired before local publication");
    const next = await this.store.beginTranscriptRequest(transcript.id);
    if (!next) throw new Error("Managed transcript has no pending range");
    transcript = await this.store.checkpointTranscriptRange(transcript.id, {
      range: next.range,
      attempts: next.attempt,
      text: providerResult.text,
      usage: null,
      detectedLanguages: providerResult.detectedLanguages,
    });
    if (transcript.checkpoints.length === transcript.ranges.length) {
      transcript = await this.store.publishTranscript(transcript.id);
    }
    return transcript;
  }
}

/**
 * Prepares the managed billing timeline from the real MeetingStore inventory
 * shape. Source chunks are verified by SHA-256 and mixed into one timeline;
 * the saved MP3 remains the durable recording output and is never parsed as WAV.
 */
export class RecordingManagedTimelinePreparer implements ManagedTimelinePreparer {
  constructor(private readonly storeRoot: string) {}

  async prepare(recording: RecordingSession, audioId = `recording:${recording.id}`): Promise<ManagedCanonicalTimeline> {
    const pointer = recording.inventory.pointer;
    if (recording.status !== "saved" || !recording.savedOutput || recording.inventory.state !== "complete" || !pointer) {
      throw new Error(`Managed timeline requires a saved recording with complete inventory: ${recording.id}`);
    }
    const chunks: PreparedChunk[] = [];
    for await (const chunk of readInventory(this.storeRoot, pointer)) {
      chunks.push(await this.readVerifiedChunk(chunk));
    }
    if (chunks.length === 0) throw new Error(`Managed timeline inventory is empty: ${recording.id}`);
    const manifest = JSON.stringify({
      version: 1,
      recordingId: recording.id,
      chunks: chunks.map(({ chunk }) => ({
        id: chunk.id,
        source: chunk.source,
        storageKey: chunk.storageKey,
        byteLength: chunk.byteLength,
        sha256: chunk.sha256,
        logicalStartMs: chunk.logicalStartMs,
        durationMs: chunk.durationMs,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        format: chunk.format,
      })),
    });
    const manifestSha256 = sha256(Buffer.from(manifest));
    const endFrame = Math.max(...chunks.map((chunk) => chunk.startFrame + chunk.frameCount));
    if (!Number.isSafeInteger(endFrame) || endFrame <= 0) throw new Error(`Managed timeline frame extent is invalid: ${recording.id}`);
    const mixed = Buffer.alloc(endFrame * 2);
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.frameCount; index += 1) {
        const target = (chunk.startFrame + index) * 2;
        const sample = chunk.payload.readInt16LE(index * 2);
        const current = mixed.readInt16LE(target);
        mixed.writeInt16LE(clampPcm16(current + sample), target);
      }
    }
    const bytes = Buffer.concat([wavHeader(endFrame), mixed]);
    const directory = path.join(this.storeRoot, "managed-transcription-timelines");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const timelinePath = path.join(directory, `${recording.id}-${randomUUID()}.wav`);
    await writeFile(timelinePath, bytes, { flag: "wx", mode: 0o600 });
    const identity = identityOf(bytes);
    const canonical = parseCanonicalPcmWav(bytes);
    let cleaned = false;
    return {
      path: timelinePath,
      recordingId: recording.id,
      audioId: audioId.trim(),
      manifestSha256,
      identity,
      startMs: 0,
      endMs: canonical.durationMs,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(timelinePath, { force: true });
      },
    };
  }

  private async readVerifiedChunk(chunk: CommittedRecordingChunk): Promise<PreparedChunk> {
    if (chunk.sampleRate !== 16_000 || chunk.channels !== 1 || chunk.format !== "wav") {
      throw new Error(`Managed timeline requires validated 16 kHz mono WAV chunks: ${chunk.id}`);
    }
    const chunkPath = resolveStorePath(this.storeRoot, chunk.storageKey);
    const verifiedIdentity = await fileIdentity(chunkPath);
    if (!sameIdentity(verifiedIdentity, chunk)) throw new Error(`Managed chunk identity changed: ${chunk.id}`);
    const bytes = await readFile(chunkPath);
    const identity = identityOf(bytes);
    if (!sameIdentity(identity, verifiedIdentity)) throw new Error(`Managed chunk changed while being read: ${chunk.id}`);
    const canonical = parseCanonicalPcmWav(bytes);
    const timeline = chunkFramePosition(chunk.id);
    if (timeline.frameCount !== canonical.sampleCount || timeline.sampleRate !== canonical.sampleRate || timeline.channels !== canonical.channels) {
      throw new Error(`Managed chunk timeline metadata changed: ${chunk.id}`);
    }
    const expectedStartMs = Math.floor(timeline.startFrame * 1_000 / timeline.sampleRate);
    const expectedDurationMs = Math.max(1, Math.floor(timeline.frameCount * 1_000 / timeline.sampleRate));
    if (chunk.logicalStartMs !== expectedStartMs || chunk.durationMs !== expectedDurationMs) {
      throw new Error(`Managed chunk duration metadata changed: ${chunk.id}`);
    }
    return {
      chunk,
      payload: pcmPayload(bytes),
      startFrame: timeline.startFrame,
      frameCount: timeline.frameCount,
    };
  }
}

interface PreparedChunk {
  readonly chunk: CommittedRecordingChunk;
  readonly payload: Buffer;
  readonly startFrame: number;
  readonly frameCount: number;
}

function identityOf(bytes: Uint8Array): OutputIdentity {
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkFramePosition(id: string): { startFrame: number; frameCount: number; sampleRate: number; channels: number } {
  const match = /^chunk--(?:microphone|system)--\d{6}--(\d{12})--(\d{12})--(\d+)--(\d+)$/u.exec(id);
  if (!match) throw new Error(`Managed chunk has invalid timeline identity: ${id}`);
  const values = match.slice(1).map(Number);
  const startFrame = values[0]!;
  const frameCount = values[1]!;
  const sampleRate = values[2]!;
  const channels = values[3]!;
  if (![startFrame, frameCount, sampleRate, channels].every(Number.isSafeInteger) || frameCount <= 0 || sampleRate <= 0 || channels <= 0) {
    throw new Error(`Managed chunk timeline identity is invalid: ${id}`);
  }
  return { startFrame, frameCount, sampleRate, channels };
}

function pcmPayload(bytes: Uint8Array): Buffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let payload: { start: number; end: number } | null = null;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("Managed timeline has a truncated PCM chunk");
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) throw new Error("Managed timeline has a truncated PCM payload");
    if (ascii(bytes, offset, 4) === "data") {
      if (payload) throw new Error("Managed timeline contains multiple PCM data chunks");
      payload = { start, end };
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.byteLength || !payload) throw new Error("Managed timeline has no complete PCM payload");
  return Buffer.from(bytes.subarray(payload.start, payload.end));
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function wavHeader(frameCount: number): Buffer {
  const dataBytes = frameCount * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function clampPcm16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, value));
}
