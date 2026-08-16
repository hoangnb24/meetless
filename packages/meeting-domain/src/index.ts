export const MEETING_STATUSES = [
  "draft",
  "recording",
  "processing",
  "ready",
  "archived",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMeetingInput {
  id: string;
  title: string;
  now: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<MeetingStatus, readonly MeetingStatus[]>> = {
  draft: ["recording"],
  recording: ["processing"],
  processing: ["ready"],
  ready: ["archived"],
  archived: [],
};

export class InvalidMeetingTransitionError extends Error {
  constructor(from: MeetingStatus, to: MeetingStatus) {
    super(`Meeting cannot transition from ${from} to ${to}`);
    this.name = "InvalidMeetingTransitionError";
  }
}

function requireText(value: string, field: "id" | "title" | "now"): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Meeting ${field} must not be empty`);
  return normalized;
}

export function createMeeting(input: CreateMeetingInput): Meeting {
  const now = requireText(input.now, "now");
  return {
    id: requireText(input.id, "id"),
    title: requireText(input.title, "title"),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionMeeting(
  meeting: Meeting,
  nextStatus: MeetingStatus,
  now: string,
): Meeting {
  if (!ALLOWED_TRANSITIONS[meeting.status].includes(nextStatus)) {
    throw new InvalidMeetingTransitionError(meeting.status, nextStatus);
  }
  return { ...meeting, status: nextStatus, updatedAt: requireText(now, "now") };
}

export const RECORDING_STATUSES = [
  "recording",
  "interrupted",
  "recoverable",
  "finalizing",
  "saved",
  "failed",
] as const;

export const RECORDING_SOURCES = ["microphone", "system"] as const;

export type RecordingStatus = (typeof RECORDING_STATUSES)[number];
export type RecordingSource = (typeof RECORDING_SOURCES)[number];

export interface CommittedRecordingChunk {
  id: string;
  source: RecordingSource;
  storageKey: string;
  byteLength: number;
  sha256: string;
  committedAt: string;
}

export interface OutputIdentity {
  byteLength: number;
  sha256: string;
}

export interface PublishIntent {
  destination: string;
  expectedIdentity: OutputIdentity;
  createdAt: string;
}

export interface SavedRecordingOutput extends OutputIdentity {
  destination: string;
  savedAt: string;
}

export interface RecordingFinalization {
  chunkIds: string[];
  chunkSetDigest: string;
  publishIntent: PublishIntent;
}

export interface RecordingInterruption {
  reason: string;
  interruptedAt: string;
}

export interface RecordingSession {
  id: string;
  meetingId: string;
  status: RecordingStatus;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  activeSince: string | null;
  chunks: CommittedRecordingChunk[];
  interruption: RecordingInterruption | null;
  failureReason: string | null;
  finalization: RecordingFinalization | null;
  savedOutput: SavedRecordingOutput | null;
}

const RECORDING_AUTHORITY = "docs/product/recording.md";

export class RecordingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingPolicyError";
  }
}

function recordingViolation(rule: string, nextAction: string): RecordingPolicyError {
  return new RecordingPolicyError(`${rule} (${RECORDING_AUTHORITY}). ${nextAction}`);
}

function requireRecordingText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw recordingViolation(`${field} must not be empty`, `Provide a valid ${field}.`);
  return normalized;
}

function requireInstant(value: string, field: string): string {
  const normalized = requireRecordingText(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw recordingViolation(`${field} must be an ISO timestamp`, `Provide a valid ${field}.`);
  }
  return normalized;
}

function elapsedUntil(session: RecordingSession, now: string): number {
  if (session.activeSince === null) return session.elapsedMs;
  const delta = Date.parse(now) - Date.parse(session.activeSince);
  if (delta < 0) {
    throw recordingViolation("Recording time cannot move backwards", "Retry with a current timestamp.");
  }
  return session.elapsedMs + delta;
}

function updated(session: RecordingSession, now: string): RecordingSession {
  return { ...session, updatedAt: requireInstant(now, "now") };
}

export function startRecording(input: {
  id: string;
  meetingId: string;
  now: string;
}): RecordingSession {
  const now = requireInstant(input.now, "now");
  return {
    id: requireRecordingText(input.id, "recording id"),
    meetingId: requireRecordingText(input.meetingId, "meeting id"),
    status: "recording",
    startedAt: now,
    updatedAt: now,
    elapsedMs: 0,
    activeSince: now,
    chunks: [],
    interruption: null,
    failureReason: null,
    finalization: null,
    savedOutput: null,
  };
}

export function recordingElapsedMs(session: RecordingSession, now: string): number {
  return elapsedUntil(session, requireInstant(now, "now"));
}

export function pauseRecording(
  session: RecordingSession,
  input: { now: string; openChunksDurablyClosed: boolean },
): RecordingSession {
  if (session.status !== "recording" || session.activeSince === null) {
    throw recordingViolation("Only an active recording can be paused", "Resume or start a recording first.");
  }
  if (!input.openChunksDurablyClosed) {
    throw recordingViolation(
      "Pause cannot be acknowledged while a chunk is open",
      "Durably close every open chunk, then retry pause.",
    );
  }
  const now = requireInstant(input.now, "now");
  return { ...updated(session, now), elapsedMs: elapsedUntil(session, now), activeSince: null };
}

export function resumeRecording(session: RecordingSession, nowInput: string): RecordingSession {
  if (session.status !== "recording" || session.activeSince !== null) {
    throw recordingViolation("Only a paused recording can be resumed", "Pause the active recording first.");
  }
  const now = requireInstant(nowInput, "now");
  return { ...updated(session, now), activeSince: now };
}

export function commitRecordingChunk(
  session: RecordingSession,
  chunk: CommittedRecordingChunk,
): RecordingSession {
  if (session.status !== "recording" || session.activeSince === null) {
    throw recordingViolation(
      "Chunks can be committed only while recording is active",
      "Resume the recording before committing a new chunk.",
    );
  }
  const checked = checkCommittedChunk(chunk);
  if (session.chunks.some((candidate) => candidate.id === checked.id)) {
    throw recordingViolation(`Chunk already committed: ${checked.id}`, "Reuse the existing committed chunk.");
  }
  return { ...updated(session, checked.committedAt), chunks: [...session.chunks, checked] };
}

function checkCommittedChunk(chunk: CommittedRecordingChunk): CommittedRecordingChunk {
  const checked: CommittedRecordingChunk = {
    id: requireRecordingText(chunk.id, "chunk id"),
    source: chunk.source,
    storageKey: requireRecordingText(chunk.storageKey, "chunk storage key"),
    byteLength: chunk.byteLength,
    sha256: requireRecordingText(chunk.sha256, "chunk sha256"),
    committedAt: requireInstant(chunk.committedAt, "chunk committedAt"),
  };
  if (!RECORDING_SOURCES.includes(checked.source)) {
    throw recordingViolation(
      "Every committed chunk needs one microphone or system source",
      "Label the chunk microphone or system before committing it.",
    );
  }
  if (!Number.isSafeInteger(checked.byteLength) || checked.byteLength <= 0) {
    throw recordingViolation("Committed chunks must contain bytes", "Commit a readable non-empty chunk.");
  }
  return checked;
}

export function adoptOrphanChunk(
  session: RecordingSession,
  input: {
    chunk: CommittedRecordingChunk;
    fullyCommitted: boolean;
    readable: boolean;
    identityValid: boolean;
  },
): RecordingSession {
  if (!input.fullyCommitted || !input.readable || !input.identityValid) {
    throw recordingViolation(
      "Partial or invalid orphan chunks cannot be adopted",
      "Quarantine the partial and adopt only a fully committed, readable chunk with valid identity.",
    );
  }
  if (session.status !== "recording" && session.status !== "interrupted" && session.status !== "recoverable") {
    throw recordingViolation("Orphan chunks cannot be adopted in this lifecycle state", "Recover the session first.");
  }
  const checked = checkCommittedChunk(input.chunk);
  if (session.chunks.some((candidate) => candidate.id === checked.id)) {
    throw recordingViolation(`Chunk already committed: ${checked.id}`, "Reuse the existing committed chunk.");
  }
  return { ...updated(session, checked.committedAt), chunks: [...session.chunks, checked] };
}

export function interruptRecording(
  session: RecordingSession,
  input: { now: string; reason: string },
): RecordingSession {
  if (session.status !== "recording" && session.status !== "finalizing") {
    throw recordingViolation("Only recording or finalizing work can be interrupted", "Inspect the current lifecycle state.");
  }
  const now = requireInstant(input.now, "now");
  return {
    ...updated(session, now),
    status: "interrupted",
    elapsedMs: elapsedUntil(session, now),
    activeSince: null,
    interruption: { reason: requireRecordingText(input.reason, "interruption reason"), interruptedAt: now },
  };
}

export function assessInterruptedRecording(
  session: RecordingSession,
  input: { recoverable: boolean; reason?: string; now: string },
): RecordingSession {
  if (session.status !== "interrupted") {
    throw recordingViolation("Only an interrupted recording can be assessed", "Interrupt the session first.");
  }
  const next = updated(session, input.now);
  if (input.recoverable && session.chunks.length > 0) {
    return { ...next, status: "recoverable", failureReason: null };
  }
  return {
    ...next,
    status: "failed",
    failureReason: requireRecordingText(input.reason ?? "Unrecoverable media loss or corruption", "failure reason"),
  };
}

export function beginFinalization(
  session: RecordingSession,
  input: {
    now: string;
    openChunksDurablyClosed: boolean;
    chunkSetDigest: string;
    destination: string;
    expectedIdentity: OutputIdentity;
  },
): RecordingSession {
  if (session.status !== "recording" && session.status !== "recoverable") {
    throw recordingViolation("Only recording or recoverable sessions can finalize", "Recover the session first.");
  }
  if (session.finalization !== null) {
    throw recordingViolation(
      "The finalization chunk digest and intent are immutable",
      "Retry finalization with the original committed chunks and chunk-set digest.",
    );
  }
  if (!input.openChunksDurablyClosed) {
    throw recordingViolation(
      "Stop cannot be acknowledged while a chunk is open",
      "Durably close every open chunk, then retry finalization.",
    );
  }
  if (session.chunks.length === 0) {
    throw recordingViolation("A recording without committed chunks cannot finalize", "Recover a valid chunk first.");
  }
  const now = requireInstant(input.now, "now");
  const identity = checkOutputIdentity(input.expectedIdentity);
  return {
    ...updated(session, now),
    status: "finalizing",
    elapsedMs: elapsedUntil(session, now),
    activeSince: null,
    finalization: {
      chunkIds: session.chunks.map((chunk) => chunk.id),
      chunkSetDigest: requireRecordingText(input.chunkSetDigest, "chunk-set digest"),
      publishIntent: {
        destination: requireRecordingText(input.destination, "publish destination"),
        expectedIdentity: identity,
        createdAt: now,
      },
    },
  };
}

export function retryFinalization(
  session: RecordingSession,
  input: { now: string; destination?: string },
): RecordingSession {
  if ((session.status !== "recoverable" && session.status !== "finalizing") || !session.finalization) {
    throw recordingViolation("Finalization retry requires an existing immutable intent", "Begin finalization once first.");
  }
  const currentIds = session.chunks.map((chunk) => chunk.id);
  if (currentIds.join("\u0000") !== session.finalization.chunkIds.join("\u0000")) {
    throw recordingViolation(
      "Finalization retry cannot change the committed chunk set",
      "Retry with the original committed chunks and chunk-set digest.",
    );
  }
  const next = updated(session, input.now);
  return {
    ...next,
    status: "finalizing",
    finalization: input.destination
      ? {
          ...session.finalization,
          publishIntent: {
            ...session.finalization.publishIntent,
            destination: requireRecordingText(input.destination, "publish destination"),
          },
        }
      : session.finalization,
  };
}

export type PublishReconciliation =
  | { action: "publish"; session: RecordingSession }
  | { action: "adopt"; session: RecordingSession }
  | { action: "collision"; session: RecordingSession };

export function reconcilePublishIntent(
  session: RecordingSession,
  input: {
    now: string;
    existingOutput: OutputIdentity | null;
    existingOutputReadable?: boolean;
    nextDestination?: string;
  },
): PublishReconciliation {
  if (session.status !== "finalizing" || !session.finalization) {
    throw recordingViolation("Publish reconciliation requires finalizing state", "Begin finalization first.");
  }
  const next = updated(session, input.now);
  if (input.existingOutput === null) return { action: "publish", session: next };
  const existing = checkOutputIdentity(input.existingOutput);
  if (input.existingOutputReadable && sameIdentity(existing, session.finalization.publishIntent.expectedIdentity)) {
    return { action: "adopt", session: next };
  }
  const nextDestination = input.nextDestination?.trim();
  if (!nextDestination || nextDestination === session.finalization.publishIntent.destination) {
    throw recordingViolation(
      `Existing export collision at ${session.finalization.publishIntent.destination}; exports are never overwritten`,
      "Choose a new collision-safe destination and retry publication.",
    );
  }
  return {
    action: "collision",
    session: {
      ...next,
      finalization: {
        ...session.finalization,
        publishIntent: {
          ...session.finalization.publishIntent,
          destination: nextDestination,
        },
      },
    },
  };
}

export function markRecordingSaved(
  session: RecordingSession,
  input: { now: string; destination: string; identity: OutputIdentity; readable: boolean },
): RecordingSession {
  if (session.status !== "finalizing" || !session.finalization) {
    throw recordingViolation("Only a finalizing recording can be saved", "Re-enter finalizing and verify the MP3.");
  }
  const destination = requireRecordingText(input.destination, "saved destination");
  const identity = checkOutputIdentity(input.identity);
  const intent = session.finalization.publishIntent;
  if (!input.readable || destination !== intent.destination || !sameIdentity(identity, intent.expectedIdentity)) {
    throw recordingViolation(
      "Source chunks cannot be cleaned before the exact MP3 is readable and verified",
      "Verify the intended MP3 path and identity, durably mark it saved, then request cleanup.",
    );
  }
  const now = requireInstant(input.now, "now");
  return {
    ...updated(session, now),
    status: "saved",
    savedOutput: { destination, ...identity, savedAt: now },
  };
}

export function assertCleanupEligible(
  session: RecordingSession,
  verification: { destination: string; identity: OutputIdentity; readable: boolean },
): void {
  if (session.status !== "saved" || !session.savedOutput || !session.finalization) {
    throw recordingViolation(
      "Source chunks cannot be cleaned before the exact MP3 is readable and verified and saved state is durable",
      "Verify the intended MP3, durably mark the recording saved, then retry cleanup.",
    );
  }
  const intent = session.finalization.publishIntent;
  const destination = requireRecordingText(verification.destination, "cleanup destination");
  const identity = checkOutputIdentity(verification.identity);
  if (
    !verification.readable ||
    destination !== session.savedOutput.destination ||
    !sameIdentity(identity, session.savedOutput) ||
    session.savedOutput.destination !== intent.destination ||
    !sameIdentity(session.savedOutput, intent.expectedIdentity)
  ) {
    throw recordingViolation(
      "Cleanup verification does not match the readable saved output and immutable publication intent",
      "Preserve the chunks and verify the exact saved MP3 path and identity before cleanup.",
    );
  }
}

function checkOutputIdentity(identity: OutputIdentity): OutputIdentity {
  if (!Number.isSafeInteger(identity.byteLength) || identity.byteLength <= 0) {
    throw recordingViolation("Output identity requires a positive byte length", "Verify a readable non-empty MP3.");
  }
  return { byteLength: identity.byteLength, sha256: requireRecordingText(identity.sha256, "output sha256") };
}

function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
