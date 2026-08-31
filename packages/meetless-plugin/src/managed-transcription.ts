import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ManagedTranscriptionPolicy,
  type ManagedDeviceCredential,
  type ManagedJob,
  type ManagedProviderResult,
  type ManagedTimelineEvidence,
} from "@meetless/managed-transcription-foundation";
import {
  type OutputIdentity,
  type RecordingSession,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import {
  fileIdentity,
  type ManagedTimelineArtifact,
  type ManagedTimelineArtifactConsumer,
} from "./finalizer.js";
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

export interface ManagedTimelineArtifactSource {
  get(recordingId: string): Promise<ManagedTimelineArtifact | null>;
}

export interface ManagedTimelinePreparer {
  prepare(recording: RecordingSession, audioId?: string): Promise<ManagedCanonicalTimeline>;
}

export interface ManagedTranscriptionServiceOptions {
  /** Must be the coordinator shared by recording, Ask, and deletion. */
  readonly lifecycle: MeetingLifecycleCoordinator;
  readonly timelinePreparer?: ManagedTimelinePreparer;
  /** Receives the artifact handed off by RecordingService before chunk cleanup. */
  readonly timelineArtifacts?: ManagedTimelineArtifactSource;
  readonly afterProviderSuccess?: (job: ManagedJob) => void | Promise<void>;
}

export interface ManagedTranscriptionResult {
  readonly job: ManagedJob;
  readonly transcript: TranscriptState;
}

/**
 * Edge adapter for the fake-backed managed policy. It verifies the durable MP3
 * identity, prepares one canonical timeline from the validated recording
 * finalizer-owned canonical timeline, calls the existing provider abstraction,
 * and publishes only via MeetingStore. The shared lifecycle lease spans
 * provider and publication.
 */
export class ManagedTranscriptionService {
  private readonly timelinePreparer: ManagedTimelinePreparer;

  constructor(
    private readonly store: MeetingStore,
    private readonly policy: ManagedTranscriptionPolicy,
    private readonly provider: TranscriptionProvider,
    private readonly options: ManagedTranscriptionServiceOptions,
  ) {
    if (!options.timelinePreparer && !options.timelineArtifacts) {
      throw new Error("Managed transcription requires the canonical timeline handoff from recording finalization");
    }
    this.timelinePreparer = options.timelinePreparer
      ?? new HandedOffTimelinePreparer(options.timelineArtifacts!);
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
    let retainTimeline = false;
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
      if (timeline.startMs !== 0) {
        throw new Error("Managed canonical timeline must cover the recording from zero");
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
      retainTimeline = true;
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
          const rangeDurationMs = timeline.endMs - timeline.startMs;
          const transcript = await this.store.ensureTranscript({
            meetingId: recording.meetingId,
            recordingId: recording.id,
            audio: { ...savedOutput, durationMs: rangeDurationMs },
            rangeMs: rangeDurationMs,
          });
          if (
            transcript.ranges.length !== 1 ||
            transcript.ranges[0]?.startMs !== 0 ||
            transcript.ranges[0]?.endMs !== rangeDurationMs
          ) {
            throw new Error("Managed provider result requires one full-timeline transcript range");
          }
          const range = transcript.ranges[0];
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
          retainTimeline = true;
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
      if (transcript.status !== "ready") {
        throw new Error("Managed transcript remains pending; provider result was retained for recovery");
      }
      job = this.policy.acknowledgePublication(job.jobId);
      retainTimeline = false;
      return { job, transcript };
    } finally {
      if (!retainTimeline) await timeline.cleanup().catch(() => undefined);
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
      rangeMs: durationMs,
    });
    if (transcript.status === "ready") return transcript;
    if (
      transcript.ranges.length !== 1 ||
      transcript.ranges[0]?.startMs !== 0 ||
      transcript.ranges[0]?.endMs !== durationMs
    ) {
      throw new Error("Managed transcript must contain one full-timeline range before publication");
    }

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

class HandedOffTimelinePreparer implements ManagedTimelinePreparer {
  constructor(private readonly source: ManagedTimelineArtifactSource) {}

  async prepare(recording: RecordingSession, audioId?: string): Promise<ManagedCanonicalTimeline> {
    if (recording.status !== "saved" || !recording.savedOutput) {
      throw new Error(`Managed timeline requires a saved recording: ${recording.id}`);
    }
    const artifact = await this.source.get(recording.id);
    if (!artifact) {
      throw new Error(`Managed canonical timeline was not handed off before source cleanup: ${recording.id}`);
    }
    return {
      ...artifact,
      audioId: audioId?.trim() || `recording:${recording.id}`,
    };
  }
}

/**
 * Fake durable owner for the finalizer handoff. The metadata sidecar lets a
 * new managed adapter instance rehydrate the temporary artifact without
 * making MeetingStore a second transcript or artifact owner.
 */
export class ManagedTimelineArtifactStore implements ManagedTimelineArtifactSource, ManagedTimelineArtifactConsumer {
  constructor(private readonly directory: string) {}

  async accept(artifact: ManagedTimelineArtifact): Promise<void> {
    if (!path.isAbsolute(artifact.path)) throw new Error("Managed artifact path must be absolute");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadataPath = this.metadataPath(artifact.recordingId);
    const current = await this.readMetadata(metadataPath);
    const next = metadataFrom(artifact);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        throw new Error(`Managed artifact handoff changed for ${artifact.recordingId}`);
      }
      return;
    }
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, metadataPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const raced = await this.readMetadata(metadataPath);
      if (!raced || JSON.stringify(raced) !== JSON.stringify(next)) throw error;
    }
  }

  async get(recordingId: string): Promise<ManagedTimelineArtifact | null> {
    const metadataPath = this.metadataPath(recordingId);
    const metadata = await this.readMetadata(metadataPath);
    if (!metadata) return null;
    let cleaned = false;
    return {
      path: metadata.path,
      recordingId: metadata.recordingId,
      manifestSha256: metadata.manifestSha256,
      identity: { byteLength: metadata.byteLength, sha256: metadata.sha256 },
      startMs: metadata.startMs,
      endMs: metadata.endMs,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await Promise.all([
          rm(metadata.path, { force: true }),
          rm(metadataPath, { force: true }),
        ]);
      },
    };
  }

  private metadataPath(recordingId: string): string {
    const key = createHash("sha256").update(recordingId).digest("hex");
    return path.join(this.directory, `${key}.json`);
  }

  private async readMetadata(metadataPath: string): Promise<ManagedArtifactMetadata | null> {
    let text: string;
    try {
      text = await readFile(metadataPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return checkedMetadata(parsed, metadataPath);
  }
}

interface ManagedArtifactMetadata {
  readonly version: 1;
  readonly path: string;
  readonly recordingId: string;
  readonly manifestSha256: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly startMs: number;
  readonly endMs: number;
}

function metadataFrom(artifact: ManagedTimelineArtifact): ManagedArtifactMetadata {
  return {
    version: 1,
    path: artifact.path,
    recordingId: artifact.recordingId,
    manifestSha256: artifact.manifestSha256,
    byteLength: artifact.identity.byteLength,
    sha256: artifact.identity.sha256,
    startMs: artifact.startMs,
    endMs: artifact.endMs,
  };
}

function checkedMetadata(value: unknown, metadataPath: string): ManagedArtifactMetadata {
  if (!value || typeof value !== "object") throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`);
  const candidate = value as Partial<ManagedArtifactMetadata>;
  const byteLength = candidate.byteLength;
  const startMs = candidate.startMs;
  const endMs = candidate.endMs;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`);
  }
  if (typeof startMs !== "number" || !Number.isSafeInteger(startMs) || startMs < 0) {
    throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`);
  }
  if (typeof endMs !== "number" || !Number.isSafeInteger(endMs) || endMs <= startMs) {
    throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`);
  }
  if (
    candidate.version !== 1 || typeof candidate.path !== "string" || !path.isAbsolute(candidate.path) ||
    typeof candidate.recordingId !== "string" || !candidate.recordingId ||
    typeof candidate.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.manifestSha256) ||
    typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)
  ) throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`);
  return candidate as ManagedArtifactMetadata;
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
