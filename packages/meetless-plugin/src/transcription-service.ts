import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type OutputIdentity,
  type RecordingSession,
  type TranscriptRange,
  type TranscriptState,
  canRetryTranscript,
} from "@meetless/meeting-domain";
import { MeetingStore } from "@meetless/meeting-store";
import { fileIdentity } from "./finalizer.js";
import type {
  TranscriptionProvider,
  TranscriptionProviderStatus,
  TranscriptionResult,
} from "./transcription-provider.js";
import { TranscriptionProviderError } from "./transcription-provider.js";
import { randomUUID } from "node:crypto";
import { sweepOwnedAudioCandidates, type AudioSnapshotStore } from "./private-audio-snapshot.js";
import { MeetingLifecycleCoordinator } from "./meeting-lifecycle-coordinator.js";

const execFileAsync = promisify(execFile);

export interface AudioInspector {
  initialize(): Promise<void>;
  inspect(filePath: string): Promise<{ identity: OutputIdentity; durationMs: number }>;
  extractRange(filePath: string, range: TranscriptRange): Promise<{ path: string; cleanup(): Promise<void> }>;
}

export class FfmpegAudioInspector implements AudioInspector {
  private initialization: Promise<void> | null = null;
  constructor(
    private readonly ffmpeg: string,
    private readonly ffprobe: string,
    private readonly stagingDirectory: string,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= sweepOwnedAudioCandidates(this.stagingDirectory, /^[0-9a-f-]{36}\.mp3$/);
    return this.initialization;
  }

  async inspect(filePath: string): Promise<{ identity: OutputIdentity; durationMs: number }> {
    const { stdout } = await execFileAsync(
      this.ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Saved MP3 duration could not be verified");
    return { identity: await fileIdentity(filePath), durationMs: Math.max(1, Math.ceil(seconds * 1_000)) };
  }

  async extractRange(filePath: string, range: TranscriptRange): Promise<{ path: string; cleanup(): Promise<void> }> {
    await this.initialize();
    const target = path.join(this.stagingDirectory, `${randomUUID()}.mp3`);
    const durationSeconds = (range.endMs - range.startMs) / 1_000;
    try {
      await execFileAsync(
        this.ffmpeg,
        [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          "-ss", String(range.startMs / 1_000), "-t", String(durationSeconds),
          "-i", filePath, "-codec:a", "libmp3lame", "-q:a", "2", "-f", "mp3", target,
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      return { path: target, cleanup: () => rm(target, { force: true }) };
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export interface TranscriptionServiceOptions {
  inspector: AudioInspector;
  sourceSnapshots: AudioSnapshotStore;
  onStateChange?: (transcript: TranscriptState) => void;
}

export class TranscriptionService {
  private readonly running = new Map<string, Promise<TranscriptState>>();
  private readonly runningMeetings = new Set<string>();

  constructor(
    readonly store: MeetingStore,
    readonly provider: TranscriptionProvider,
    private readonly options: TranscriptionServiceOptions,
    private readonly lifecycle = new MeetingLifecycleCoordinator(),
  ) {}

  async initialize(): Promise<void> {
    const pending = (await this.store.listTranscripts())
      .filter((transcript) => transcript.status === "pending" || transcript.status === "transcribing")
      .map((transcript) => ({
        meetingId: transcript.meetingId,
        lease: this.lifecycle.tryAcquireWork(transcript.meetingId, "transcription"),
      }))
      .filter((entry): entry is { meetingId: string; lease: NonNullable<typeof entry.lease> } => entry.lease !== null);
    try {
      await Promise.all([this.options.sourceSnapshots.initialize(), this.options.inspector.initialize()]);
      await this.store.reconcileTranscriptPublications(pending.map((entry) => entry.meetingId));
      const consent = await this.store.transcriptionConsent();
      if (consent.status === "granted") await this.scheduleSavedRecordings();
    } finally {
      for (const entry of pending) entry.lease.release();
    }
  }

  async providerStatus(): Promise<TranscriptionProviderStatus> {
    return this.provider.status();
  }

  async grantConsent(): Promise<{ status: "granted"; grantedAt: string }> {
    const consent = await this.store.grantTranscriptionConsent();
    if (await this.provider.status() === "configured") await this.scheduleSavedRecordings();
    return consent;
  }

  async scheduleSavedRecordings(): Promise<void> {
    for (const recording of await this.store.listRecordings()) {
      if (recording.status !== "saved" || !recording.savedOutput) continue;
      const transcript = await this.store.getTranscriptForMeeting(recording.meetingId);
      if (transcript?.status === "failed" && !canRetryTranscript(transcript)) continue;
      this.schedule(recording);
    }
  }

  schedule(recording: RecordingSession): void {
    if (this.running.has(recording.id) || recording.status !== "saved" || !recording.savedOutput) return;
    const lease = this.lifecycle.tryAcquireWork(recording.meetingId, "transcription");
    if (!lease) return;
    this.runningMeetings.add(recording.meetingId);
    const promise = this.transcribeSavedRecordingOwned(recording.id)
      .catch(() => this.store.getTranscriptForMeeting(recording.meetingId).then((transcript) => transcript ?? this.fallbackState(recording)))
      .finally(() => {
        this.running.delete(recording.id);
        this.runningMeetings.delete(recording.meetingId);
        lease.release();
      });
    this.running.set(recording.id, promise);
  }

  isMeetingRunning(meetingId: string): boolean {
    return this.runningMeetings.has(meetingId);
  }

  async transcribeSavedRecording(recordingId: string): Promise<TranscriptState> {
    const recording = (await this.store.listRecordings()).find((candidate) => candidate.id === recordingId);
    if (!recording) throw new Error(`Saved recording not found: ${recordingId}`);
    const lease = this.lifecycle.tryAcquireWork(recording.meetingId, "transcription");
    if (!lease) throw new Error("Meeting deletion is in progress");
    try {
      return await this.transcribeSavedRecordingOwned(recordingId);
    } finally {
      lease.release();
    }
  }

  private async transcribeSavedRecordingOwned(recordingId: string): Promise<TranscriptState> {
    if ((await this.store.transcriptionConsent()).status !== "granted") {
      throw new Error("Cloud transcription consent is required");
    }
    const recordings = await this.store.listRecordings();
    const recording = recordings.find((candidate) => candidate.id === recordingId);
    if (!recording || recording.status !== "saved" || !recording.savedOutput) throw new Error(`Saved recording not found: ${recordingId}`);
    if (await this.provider.status() !== "configured") throw new TranscriptionProviderError("Native transcription is not configured");
    const sourceSnapshot = await this.options.sourceSnapshots.create(recording.savedOutput.destination, recording.savedOutput);
    try {
      const inspected = await this.options.inspector.inspect(sourceSnapshot.path);
      if (!sameIdentity(inspected.identity, recording.savedOutput)) throw new Error("Private saved MP3 snapshot identity is invalid");
      let transcript = await this.store.ensureTranscript({
        meetingId: recording.meetingId,
        recordingId,
        audio: { destination: recording.savedOutput.destination, ...inspected.identity, durationMs: inspected.durationMs },
      });
      if (transcript.status === "failed" && !canRetryTranscript(transcript)) return transcript;
      if (canRetryTranscript(transcript)) transcript = await this.store.retryTranscript(transcript.id);
      for (;;) {
        const next = await this.store.beginTranscriptRequest(transcript.id);
        if (!next) {
          if (transcript.status !== "ready" && transcript.checkpoints.length === transcript.ranges.length) transcript = await this.store.publishTranscript(transcript.id);
          this.options.onStateChange?.(transcript);
          return transcript;
        }
        let rangeFile: { path: string; cleanup(): Promise<void> } | null = null;
        let result: TranscriptionResult;
        try {
          rangeFile = await this.options.inspector.extractRange(sourceSnapshot.path, next.range);
          const audioIdentity = await fileIdentity(rangeFile.path);
          result = await this.provider.transcribe({ recordingId, audioPath: rangeFile.path, audioIdentity, range: next.range });
        } catch (error) {
          await rangeFile?.cleanup().catch(() => undefined);
          transcript = await this.store.failTranscript(next.transcript.id, redactProviderFailure(error));
          this.options.onStateChange?.(transcript);
          if ((transcript.attemptsByOrdinal[String(next.range.ordinal)] ?? 0) < transcript.maxAttempts) {
            transcript = await this.store.retryTranscript(transcript.id);
            continue;
          }
          return transcript;
        }
        await rangeFile?.cleanup().catch(() => undefined);
        transcript = await this.store.checkpointTranscriptRange(next.transcript.id, {
          range: next.range,
          attempts: next.attempt,
          text: result.text,
          usage: result.usage,
          detectedLanguages: result.detectedLanguages,
        });
        this.options.onStateChange?.(transcript);
      }
    } finally {
      await sourceSnapshot.cleanup().catch(() => undefined);
    }
  }

  private fallbackState(recording: RecordingSession): TranscriptState {
    return {
      id: `transcript-${recording.id}`,
      meetingId: recording.meetingId,
      recordingId: recording.id,
      status: "failed",
      plannerVersion: "m3-range-v1",
      rangeMs: 30_000,
      maxAttempts: 3,
      audio: { destination: recording.savedOutput?.destination ?? "unavailable", byteLength: recording.savedOutput?.byteLength ?? 1, sha256: recording.savedOutput?.sha256 ?? "unavailable", durationMs: 1 },
      ranges: [], checkpoints: [], attemptsByOrdinal: {}, requestCount: 0, usage: null, detectedLanguages: [],
      startedAt: null, updatedAt: new Date().toISOString(), failureReason: "Transcription failed", publication: null,
    };
  }
}

function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function redactProviderFailure(error: unknown): string {
  if (error instanceof TranscriptionProviderError) return error.message;
  return "Native transcription request failed";
}
