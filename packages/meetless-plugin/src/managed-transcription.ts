import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ManagedTranscriptionPolicy,
  type ManagedDeviceCredential,
  type ManagedJob,
  type ManagedProviderResult,
} from "@meetless/managed-transcription-foundation";
import {
  planTranscriptRanges,
  type OutputIdentity,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import type { TranscriptionProvider } from "./transcription-provider.js";
import { TranscriptionProviderError } from "./transcription-provider.js";

export interface ManagedTranscriptionInput {
  readonly recordingId: string;
  readonly audioPath: string;
  readonly credential: ManagedDeviceCredential;
  readonly chunkId: string;
  readonly audioId?: string;
  readonly claimedDurationSeconds?: number;
}

export interface ManagedTranscriptionServiceOptions {
  readonly afterProviderSuccess?: (job: ManagedJob) => void | Promise<void>;
}

export interface ManagedTranscriptionResult {
  readonly job: ManagedJob;
  readonly transcript: TranscriptState;
}

/**
 * Adapter for the fake-backed managed policy. File bytes and the existing
 * TranscriptionProvider stay at this edge; the policy receives only ordinary
 * values and never imports storage, transport, or provider types.
 */
export class ManagedTranscriptionService {
  constructor(
    private readonly store: MeetingStore,
    private readonly policy: ManagedTranscriptionPolicy,
    private readonly provider: TranscriptionProvider,
    private readonly options: ManagedTranscriptionServiceOptions = {},
  ) {}

  async transcribe(input: ManagedTranscriptionInput): Promise<ManagedTranscriptionResult> {
    const recording = (await this.store.listRecordings()).find((candidate) => candidate.id === input.recordingId);
    if (!recording || recording.status !== "saved" || !recording.savedOutput) {
      throw new Error(`Managed transcription requires saved recording ${input.recordingId}`);
    }
    const bytes = await readFile(input.audioPath);
    const identity = identityOf(bytes);
    if (!sameIdentity(identity, recording.savedOutput)) {
      throw new Error("Managed audio identity does not match the saved recording");
    }

    const reservation = this.policy.reserve({
      credential: input.credential,
      audioId: input.audioId ?? identity.sha256,
      chunkId: input.chunkId,
      wav: bytes,
      claimedDurationSeconds: input.claimedDurationSeconds,
    });
    let job = reservation.job;
    if (job.status === "failed") job = this.policy.retryJob(job.jobId);
    if (job.status === "reserved") {
      if (await this.provider.status() !== "configured") {
        this.policy.failJob(job.jobId, "provider unavailable");
        throw new TranscriptionProviderError("Managed transcription provider is unavailable");
      }
      this.policy.startProvider(job.jobId);
      try {
        const range = planTranscriptRanges({
          recordingId: recording.id,
          audioSha256: identity.sha256,
          durationMs: job.audio.durationMs,
          rangeMs: job.audio.durationMs,
        })[0];
        if (!range) throw new Error("Managed audio produced no transcript range");
        const result = await this.provider.transcribe({
          recordingId: recording.id,
          audioPath: input.audioPath,
          audioIdentity: identity,
          range,
        });
        const providerResult: ManagedProviderResult = {
          text: result.text,
          detectedLanguages: result.detectedLanguages,
        };
        job = this.policy.recordProviderSuccess(job.jobId, providerResult);
      } catch (error) {
        if (this.policy.job(job.jobId).status === "running") this.policy.failJob(job.jobId, "provider unavailable");
        if (error instanceof TranscriptionProviderError) throw error;
        throw new TranscriptionProviderError("Managed transcription provider failed");
      }
      await this.options.afterProviderSuccess?.(job);
    }

    if (job.status === "provider_completed") job = this.policy.settleJob(job.jobId);
    if (job.status !== "succeeded") {
      throw new Error(`Managed transcription job ${job.jobId} is ${job.status}`);
    }
    const providerResult = job.providerResult;
    const transcript = await this.publishResult(
      recording.meetingId,
      recording.id,
      recording.savedOutput,
      job.audio.durationMs,
      providerResult,
    );
    job = this.policy.acknowledgePublication(job.jobId);
    return { job, transcript };
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
    if (!providerResult) throw new Error("Managed provider result expired before local publication");
    if (transcript.status !== "pending") {
      await this.store.reconcileTranscriptPublications([meetingId]);
      transcript = await this.store.getTranscriptForMeeting(meetingId) ?? transcript;
    }
    if (transcript.status !== "pending") throw new Error("Managed transcript is not ready for publication");
    const next = await this.store.beginTranscriptRequest(transcript.id);
    if (!next) throw new Error("Managed transcript has no pending range");
    transcript = await this.store.checkpointTranscriptRange(transcript.id, {
      range: next.range,
      attempts: next.attempt,
      text: providerResult.text,
      usage: null,
      detectedLanguages: providerResult.detectedLanguages,
    });
    return this.store.publishTranscript(transcript.id);
  }
}

function identityOf(bytes: Uint8Array): OutputIdentity {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
