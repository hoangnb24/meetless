import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ManagedTranscriptionPolicy,
  MANAGED_TEMPORARY_DATA_TTL_MS,
  type ManagedDeviceCredential,
  type ManagedJob,
  type ManagedProviderResult,
  type ManagedTimelineEvidence,
} from "@meetless/managed-transcription-foundation";
import {
  canRetryTranscript,
  type OutputIdentity,
  type RecordingSession,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import {
  fileIdentity,
  type ManagedTimelineHandoffContext,
  type ManagedTimelineArtifact,
  type ManagedTimelineArtifactConsumer,
} from "./finalizer.js";
import { MeetingLifecycleCoordinator } from "./meeting-lifecycle-coordinator.js";
import type { TranscriptionProvider } from "./transcription-provider.js";
import { TranscriptionProviderError } from "./transcription-provider.js";
import type {
  ManagedUploadCredential,
  ManagedUploadManifest,
  ManagedUploadPort,
  ManagedUploadReceipt,
} from "./managed-upload.js";

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
  prepare(recording: RecordingSession): Promise<ManagedCanonicalTimeline>;
}

export interface ManagedTranscriptionServiceOptions {
  /** Must be the coordinator shared by recording, Ask, and deletion. */
  readonly lifecycle: MeetingLifecycleCoordinator;
  readonly timelinePreparer?: ManagedTimelinePreparer;
  /** Receives the artifact handed off by RecordingService before chunk cleanup. */
  readonly timelineArtifacts?: ManagedTimelineArtifactSource;
  /** Optional pre-external transport seam; it is not the direct/BYOK provider. */
  readonly managedUpload?: ManagedUploadPort;
  readonly managedUploadCredential?: ManagedUploadCredential;
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
      return await this.transcribeOwned(input, recording, lifecycleLease);
    } finally {
      lifecycleLease.release();
    }
  }

  private async transcribeOwned(
    input: ManagedTranscriptionInput,
    recording: RecordingSession,
    executionLease: { release(): void },
  ): Promise<ManagedTranscriptionResult> {
    const savedOutput = recording.savedOutput!;
    const savedIdentity = await fileIdentity(savedOutput.destination);
    if (!sameIdentity(savedIdentity, savedOutput)) {
      throw new Error("Managed durable saved MP3 identity does not match MeetingStore");
    }

    const timeline = await this.timelinePreparer.prepare(recording);
    let retainTimeline = false;
    try {
      if (timeline.recordingId !== recording.id) {
        throw new Error("Managed canonical timeline is bound to a different recording");
      }
      const expectedAudioId = `recording:${recording.id}`;
      if (timeline.audioId !== expectedAudioId) {
        throw new Error("Managed canonical timeline identity must be bound to its recording");
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
      let transcript: TranscriptState;
      try {
        transcript = await this.ensureManagedTranscript(recording, timeline.endMs - timeline.startMs);
      } catch (error) {
        this.failReservedJob(job.jobId, error);
        throw error;
      }
      if (job.status === "reserved") {
        let providerStatus: Awaited<ReturnType<TranscriptionProvider["status"]>>;
        try {
          providerStatus = await this.provider.status();
        } catch {
          this.policy.failJob(job.jobId, "provider status unavailable");
          await this.failManagedTranscript(transcript, "Managed provider status is unavailable");
          throw new TranscriptionProviderError("Managed transcription provider status is unavailable");
        }
        if (providerStatus !== "configured") {
          this.policy.failJob(job.jobId, "provider unavailable");
          await this.failManagedTranscript(transcript, "Managed transcription provider is unavailable");
          throw new TranscriptionProviderError("Managed transcription provider is unavailable");
        }
        this.policy.startProvider(job.jobId, job.admissionId);
        let uploadReceipt: ManagedUploadReceipt | null = null;
        try {
          const rangeDurationMs = timeline.endMs - timeline.startMs;
          if (
            transcript.ranges.length !== 1 ||
            transcript.ranges[0]?.startMs !== 0 ||
            transcript.ranges[0]?.endMs !== rangeDurationMs
          ) {
            throw new Error("Managed provider result requires one full-timeline transcript range");
          }
          const range = transcript.ranges[0];
          if (!range) throw new Error("Managed audio produced no transcript range");
          if (this.options.managedUpload) {
            const credential = this.options.managedUploadCredential;
            if (!credential) throw new Error("Managed upload requires a host-authenticated credential");
            uploadReceipt = await this.options.managedUpload.uploadCanonicalTimeline({
              credential,
              manifest: managedUploadManifest(timelineEvidence, timeline.endMs - timeline.startMs),
              source: readFileChunks(timeline.path),
            });
          }
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
          await this.failManagedTranscript(transcript, error instanceof TranscriptionProviderError
            ? error.message : "Managed transcription provider failed");
          if (uploadReceipt && this.options.managedUpload && this.options.managedUploadCredential) {
            await this.options.managedUpload.acknowledge({
              credential: this.options.managedUploadCredential,
              manifest: uploadReceipt.manifest,
            }).catch(() => undefined);
          }
          if (error instanceof TranscriptionProviderError) throw error;
          throw new TranscriptionProviderError("Managed transcription provider failed");
        }
        await this.options.afterProviderSuccess?.(job);
      }

      if (job.status === "provider_completed") job = this.policy.settleJob(job.jobId);
      if (job.status !== "succeeded") {
        throw new Error(`Managed transcription job ${job.jobId} is ${job.status}`);
      }
      executionLease.release();
      const publicationLease = this.options.lifecycle.tryAcquireWork(recording.meetingId, "transcription");
      if (!publicationLease) throw new Error("Meeting deletion is in progress; managed result retained for recovery");
      try {
        const published = await this.publishResult(
          recording.meetingId,
          recording.id,
          savedOutput,
          timeline.endMs - timeline.startMs,
          job.providerResult,
        );
        if (published.status !== "ready") {
          throw new Error("Managed transcript remains pending; provider result was retained for recovery");
        }
        job = this.policy.acknowledgePublication(job.jobId);
        if (this.options.managedUpload && this.options.managedUploadCredential) {
          await this.options.managedUpload.acknowledge({
            credential: this.options.managedUploadCredential,
            manifest: managedUploadManifest(timelineEvidence, timeline.endMs - timeline.startMs),
          }).catch(() => undefined);
        }
        retainTimeline = false;
        return { job, transcript: published };
      } finally {
        publicationLease.release();
      }
    } finally {
      if (!retainTimeline) await timeline.cleanup().catch(() => undefined);
    }
  }

  private async ensureManagedTranscript(recording: RecordingSession, durationMs: number): Promise<TranscriptState> {
    let transcript = await this.store.ensureTranscript({
      meetingId: recording.meetingId,
      recordingId: recording.id,
      audio: { ...recording.savedOutput!, durationMs },
      rangeMs: durationMs,
    });
    if (transcript.status === "failed") {
      if (!canRetryTranscript(transcript)) throw new Error("Managed transcript retry bound has been reached");
      transcript = await this.store.retryTranscript(transcript.id);
    }
    return transcript;
  }

  private failReservedJob(jobId: string, _error: unknown): void {
    try {
      const current = this.policy.job(jobId);
      if (current.status === "reserved" || current.status === "running") this.policy.failJob(jobId, "managed admission preparation failed");
    } catch {
      // Preserve the original boundary failure. A policy state transition that
      // already completed is reconciled by the next managed attempt.
    }
  }

  private async failManagedTranscript(transcript: TranscriptState, reason: string): Promise<void> {
    if (transcript.status !== "pending" && transcript.status !== "transcribing") return;
    await this.store.failTranscript(transcript.id, reason).catch(() => undefined);
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
    if (transcript.status === "failed") {
      if (!canRetryTranscript(transcript)) throw new Error("Managed transcript is permanently failed");
      transcript = await this.store.retryTranscript(transcript.id);
    }
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

  async prepare(recording: RecordingSession): Promise<ManagedCanonicalTimeline> {
    if (recording.status !== "saved" || !recording.savedOutput) {
      throw new Error(`Managed timeline requires a saved recording: ${recording.id}`);
    }
    const artifact = await this.source.get(recording.id);
    if (!artifact) {
      throw new Error(`Managed canonical timeline was not handed off before source cleanup: ${recording.id}`);
    }
    return {
      ...artifact,
      // A managed timeline is recording-bound. The caller may carry an old
      // optional label for compatibility, but it cannot alter admission
      // identity.
      audioId: `recording:${recording.id}`,
    };
  }
}

/**
 * Private app-owned temporary artifact store. It copies the finalizer stage
 * with bounded streaming before the recording source inventory is removed.
 * MeetingStore receives only the exact per-recording directory for deletion;
 * transcript and citation truth remains in MeetingStore.
 */
export class ManagedTimelineArtifactStore implements ManagedTimelineArtifactSource, ManagedTimelineArtifactConsumer {
  readonly directory: string;
  private readonly now: () => number;

  constructor(directory: string, options: { now?: () => number } = {}) {
    this.directory = path.resolve(directory);
    this.now = options.now ?? (() => Date.now());
  }

  async accept(artifact: ManagedTimelineArtifact, context: ManagedTimelineHandoffContext): Promise<void> {
    validateArtifactInput(artifact);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const recordingDirectory = this.recordingDirectory(artifact.recordingId);
    const metadataPath = this.metadataPath(artifact.recordingId);
    const artifactPath = this.artifactPath(artifact.recordingId);
    const current = await this.readMetadata(metadataPath);
    const meetingId = context.meetingId.trim();
    if (!meetingId) throw new Error("Managed artifact handoff requires its owning meeting");
    const next = metadataFrom(artifact, meetingId, this.now());
    if (current && !sameMetadataIdentity(current, next)) {
      throw new Error(`Managed artifact handoff changed for ${artifact.recordingId}`);
    }
    await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
    if (current && current.expiresAt <= this.now()) {
      await this.remove(artifact.recordingId);
      await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
    }
    await this.ensureCopied(artifact.path, artifactPath, artifact.identity);
    if (!current || current.expiresAt <= this.now()) {
      await writeMetadata(metadataPath, metadataFrom(artifact, meetingId, this.now()));
    }
  }

  async get(recordingId: string): Promise<ManagedTimelineArtifact | null> {
    const metadataPath = this.metadataPath(recordingId);
    const metadata = await this.readMetadata(metadataPath);
    if (!metadata) return null;
    if (metadata.expiresAt <= this.now()) {
      await this.remove(recordingId);
      return null;
    }
    const artifactPath = this.artifactPath(recordingId);
    try {
      const identity = await fileIdentity(artifactPath);
      if (!sameIdentity(identity, { byteLength: metadata.byteLength, sha256: metadata.sha256 })) {
        throw new Error(`Managed artifact bytes changed for ${recordingId}`);
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new Error(`Managed artifact bytes are missing for ${recordingId}`);
      throw error;
    }
    let cleaned = false;
    return {
      path: artifactPath,
      recordingId: metadata.recordingId,
      manifestSha256: metadata.manifestSha256,
      identity: { byteLength: metadata.byteLength, sha256: metadata.sha256 },
      startMs: metadata.startMs,
      endMs: metadata.endMs,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await this.remove(recordingId);
      },
    };
  }

  async ownedArtifactPaths(meetingId: string, recordingIds?: readonly string[]): Promise<Array<{ recordingId: string; path: string }>> {
    const allowed = recordingIds ? new Set(recordingIds) : null;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const owned: Array<{ recordingId: string; path: string }> = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/u.test(name) || (allowed && ![...allowed].some((id) => artifactKey(id) === name))) continue;
      const metadata = await this.readMetadata(path.join(this.directory, name, "metadata.json"));
      if (metadata?.meetingId === meetingId && metadata.expiresAt > this.now()) {
        owned.push({ recordingId: metadata.recordingId, path: path.join(this.directory, name) });
      }
    }
    return owned;
  }

  async sweep(input: {
    recordings: readonly Pick<RecordingSession, "id" | "meetingId">[];
    meetingIds: readonly string[];
    now?: number;
  }): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const now = input.now ?? this.now();
    const recordings = new Map(input.recordings.map((recording) => [recording.id, recording.meetingId]));
    const meetings = new Set(input.meetingIds);
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      const candidate = path.join(this.directory, name);
      const info = await stat(candidate).catch((error: unknown) => isErrno(error, "ENOENT") ? null : Promise.reject(error));
      if (!info) continue;
      if (!info.isDirectory() || !/^[a-f0-9]{64}$/u.test(name)) {
        await rm(candidate, { recursive: info.isDirectory(), force: true });
        removed += 1;
        continue;
      }
      let metadata: ManagedArtifactMetadata | null;
      try {
        metadata = await this.readMetadata(path.join(candidate, "metadata.json"));
      } catch {
        metadata = null;
      }
      const expectedMeeting = metadata ? recordings.get(metadata.recordingId) : undefined;
      const shouldRemove = !metadata || metadata.expiresAt <= now || !expectedMeeting || !meetings.has(expectedMeeting) ||
        expectedMeeting !== metadata.meetingId || artifactKey(metadata.recordingId) !== name;
      if (shouldRemove) {
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (!metadata) continue;
      try {
        const identity = await fileIdentity(this.artifactPath(metadata.recordingId));
        if (!sameIdentity(identity, { byteLength: metadata.byteLength, sha256: metadata.sha256 })) {
          await rm(candidate, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
      }
    }
    await syncDirectory(this.directory);
    return removed;
  }

  async remove(recordingId: string): Promise<void> {
    await rm(this.recordingDirectory(recordingId), { recursive: true, force: true });
    await syncDirectory(this.directory).catch(() => undefined);
  }

  artifactDirectory(recordingId: string): string {
    return this.recordingDirectory(recordingId);
  }

  private recordingDirectory(recordingId: string): string {
    return path.join(this.directory, artifactKey(recordingId));
  }

  private artifactPath(recordingId: string): string {
    return path.join(this.recordingDirectory(recordingId), "timeline.wav");
  }

  private metadataPath(recordingId: string): string {
    return path.join(this.recordingDirectory(recordingId), "metadata.json");
  }

  private async ensureCopied(sourcePath: string, destination: string, expected: OutputIdentity): Promise<void> {
    const existing = await fileIdentity(destination).catch((error: unknown) => isErrno(error, "ENOENT") ? null : Promise.reject(error));
    if (existing) {
      if (!sameIdentity(existing, expected)) throw new Error("Managed private artifact identity changed");
      return;
    }
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const source = createReadStream(sourcePath, { highWaterMark: 64 * 1024 });
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    let moved = false;
    try {
      for await (const chunk of source) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        byteLength += bytes.byteLength;
        if (byteLength > expected.byteLength) throw new Error("Managed artifact source exceeded its declared identity");
        await handle.write(bytes);
      }
      await handle.sync();
      const identity = { byteLength, sha256: hash.digest("hex") };
      if (!sameIdentity(identity, expected)) throw new Error("Managed artifact source identity does not match finalizer evidence");
      await handle.close();
      await rename(temporary, destination);
      moved = true;
      await syncDirectory(path.dirname(destination));
    } finally {
      await handle.close().catch(() => undefined);
      source.destroy();
      if (!moved) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readMetadata(metadataPath: string): Promise<ManagedArtifactMetadata | null> {
    let text: string;
    try {
      text = await readFile(metadataPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    try {
      return checkedMetadata(JSON.parse(text), metadataPath);
    } catch (error) {
      throw new Error(`Managed artifact metadata is invalid: ${metadataPath}`, { cause: error });
    }
  }
}

interface ManagedArtifactMetadata {
  readonly version: 2;
  readonly recordingId: string;
  readonly meetingId: string;
  readonly manifestSha256: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export async function listManagedArtifactPaths(
  directory: string,
  recordingIds: readonly string[],
): Promise<Array<{ recordingId: string; path: string }>> {
  const owner = new ManagedTimelineArtifactStore(directory);
  const result: Array<{ recordingId: string; path: string }> = [];
  for (const recordingId of recordingIds) {
    const metadataPath = path.join(owner.artifactDirectory(recordingId), "metadata.json");
    const contents = await readFile(metadataPath, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? null : Promise.reject(error));
    if (!contents) continue;
    const metadata = checkedMetadata(JSON.parse(contents), metadataPath);
    if (metadata.recordingId !== recordingId) throw new Error(`Managed artifact metadata owner changed: ${metadataPath}`);
    result.push({ recordingId, path: owner.artifactDirectory(metadata.recordingId) });
  }
  return result;
}

function metadataFrom(artifact: ManagedTimelineArtifact, meetingId: string, createdAt: number): ManagedArtifactMetadata {
  return {
    version: 2,
    recordingId: artifact.recordingId,
    meetingId,
    manifestSha256: artifact.manifestSha256,
    byteLength: artifact.identity.byteLength,
    sha256: artifact.identity.sha256,
    startMs: artifact.startMs,
    endMs: artifact.endMs,
    createdAt,
    expiresAt: createdAt + MANAGED_TEMPORARY_DATA_TTL_MS,
  };
}

function validateArtifactInput(artifact: ManagedTimelineArtifact): void {
  if (!path.isAbsolute(artifact.path)) throw new Error("Managed artifact source path must be absolute");
  if (
    !artifact.recordingId.trim() || !/^[a-f0-9]{64}$/u.test(artifact.manifestSha256) ||
    !Number.isSafeInteger(artifact.identity.byteLength) || artifact.identity.byteLength <= 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.identity.sha256) ||
    !Number.isSafeInteger(artifact.startMs) || artifact.startMs < 0 ||
    !Number.isSafeInteger(artifact.endMs) || artifact.endMs <= artifact.startMs
  ) {
    throw new Error("Managed artifact timeline identity is invalid");
  }
}

function checkedMetadata(value: unknown, metadataPath: string): ManagedArtifactMetadata {
  if (!value || typeof value !== "object") throw new Error(`invalid object at ${metadataPath}`);
  const candidate = value as Partial<ManagedArtifactMetadata>;
  if (
    candidate.version !== 2 || typeof candidate.recordingId !== "string" || !candidate.recordingId ||
    typeof candidate.meetingId !== "string" || !candidate.meetingId ||
    typeof candidate.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.manifestSha256) ||
    typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
    typeof candidate.byteLength !== "number" || !Number.isSafeInteger(candidate.byteLength) || candidate.byteLength <= 0 ||
    typeof candidate.startMs !== "number" || !Number.isSafeInteger(candidate.startMs) || candidate.startMs < 0 ||
    typeof candidate.endMs !== "number" || !Number.isSafeInteger(candidate.endMs) || candidate.endMs <= candidate.startMs ||
    typeof candidate.createdAt !== "number" || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt < 0 ||
    typeof candidate.expiresAt !== "number" || !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt !== candidate.createdAt + MANAGED_TEMPORARY_DATA_TTL_MS
  ) throw new Error(`invalid fields at ${metadataPath}`);
  return candidate as ManagedArtifactMetadata;
}

function sameMetadataIdentity(left: ManagedArtifactMetadata, right: ManagedArtifactMetadata): boolean {
  return left.recordingId === right.recordingId && left.meetingId === right.meetingId &&
    left.manifestSha256 === right.manifestSha256 && left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 && left.startMs === right.startMs && left.endMs === right.endMs;
}

async function writeMetadata(metadataPath: string, metadata: ManagedArtifactMetadata): Promise<void> {
  const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temporary, metadataPath);
    created = false;
    await syncDirectory(path.dirname(metadataPath));
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function artifactKey(recordingId: string): string {
  return createHash("sha256").update(recordingId).digest("hex");
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

function managedUploadManifest(
  timeline: ManagedTimelineEvidence,
  durationMs: number,
): ManagedUploadManifest {
  return {
    recordingId: timeline.recordingId,
    audioId: timeline.audioId,
    manifestSha256: timeline.manifestSha256,
    contentSha256: timeline.contentSha256,
    byteLength: timeline.byteLength,
    durationMs,
  };
}

async function* readFileChunks(filePath: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) yield chunk as Buffer;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
