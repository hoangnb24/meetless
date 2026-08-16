import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  adoptOrphanChunk,
  assertCleanupEligible,
  assessInterruptedRecording,
  beginFinalization,
  commitRecordingChunk,
  createMeeting,
  interruptRecording,
  markRecordingSaved,
  MEETING_STATUSES,
  pauseRecording,
  reconcilePublishIntent,
  RECORDING_SOURCES,
  RECORDING_STATUSES,
  resumeRecording,
  retryFinalization,
  startRecording,
  transitionMeeting,
  type CommittedRecordingChunk,
  type Meeting,
  type MeetingStatus,
  type OutputIdentity,
  type RecordingSession,
} from "@meetless/meeting-domain";
import { z } from "zod";

const MeetingSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: z.enum(MEETING_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const StateV1Schema = z
  .object({
    version: z.literal(1),
    meetings: z.array(MeetingSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    state.meetings.forEach((meeting, index) => {
      if (ids.has(meeting.id)) {
        context.addIssue({
          code: "custom",
          path: ["meetings", index, "id"],
          message: `Duplicate meeting id: ${meeting.id}`,
        });
      }
      ids.add(meeting.id);
    });
  });

const OutputIdentitySchema = z
  .object({
    byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1),
  })
  .strict();

const ChunkSchema = z
  .object({
    id: z.string().trim().min(1),
    source: z.enum(RECORDING_SOURCES),
    storageKey: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1),
    committedAt: z.string().datetime(),
  })
  .strict();

const RecordingSchema = z
  .object({
    id: z.string().trim().min(1),
    meetingId: z.string().trim().min(1),
    status: z.enum(RECORDING_STATUSES),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    elapsedMs: z.number().int().nonnegative(),
    activeSince: z.string().datetime().nullable(),
    chunks: z.array(ChunkSchema),
    interruption: z
      .object({ reason: z.string().trim().min(1), interruptedAt: z.string().datetime() })
      .strict()
      .nullable(),
    failureReason: z.string().trim().min(1).nullable(),
    finalization: z
      .object({
        chunkIds: z.array(z.string().trim().min(1)).min(1),
        chunkSetDigest: z.string().trim().min(1),
        publishIntent: z
          .object({
            destination: z.string().trim().min(1),
            expectedIdentity: OutputIdentitySchema,
            createdAt: z.string().datetime(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    savedOutput: z
      .object({
        destination: z.string().trim().min(1),
        byteLength: z.number().int().positive(),
        sha256: z.string().trim().min(1),
        savedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((recording, context) => {
    const chunkIds = new Set<string>();
    recording.chunks.forEach((chunk, index) => {
      if (chunkIds.has(chunk.id)) {
        context.addIssue({ code: "custom", path: ["chunks", index, "id"], message: `Duplicate chunk id: ${chunk.id}` });
      }
      chunkIds.add(chunk.id);
    });
    if (recording.status === "recording" && recording.finalization !== null) {
      context.addIssue({ code: "custom", path: ["finalization"], message: "Recording state cannot have finalization intent" });
    }
    if (recording.status !== "recording" && recording.activeSince !== null) {
      context.addIssue({ code: "custom", path: ["activeSince"], message: "Inactive recording state cannot accumulate elapsed time" });
    }
    if (recording.status === "finalizing" && recording.finalization === null) {
      context.addIssue({ code: "custom", path: ["finalization"], message: "Finalizing recording requires durable intent" });
    }
    if (recording.status === "saved" && (!recording.savedOutput || !recording.finalization)) {
      context.addIssue({ code: "custom", path: ["savedOutput"], message: "Saved recording requires output and finalization identity" });
    }
    if (recording.status !== "saved" && recording.savedOutput !== null) {
      context.addIssue({ code: "custom", path: ["savedOutput"], message: "Only saved state can own saved output identity" });
    }
    if (recording.status === "interrupted" && recording.interruption === null) {
      context.addIssue({ code: "custom", path: ["interruption"], message: "Interrupted state requires interruption evidence" });
    }
    if (recording.status === "failed" && recording.failureReason === null) {
      context.addIssue({ code: "custom", path: ["failureReason"], message: "Failed state requires proven failure reason" });
    }
    if (
      recording.finalization &&
      recording.finalization.chunkIds.join("\u0000") !== recording.chunks.map((chunk) => chunk.id).join("\u0000")
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalization", "chunkIds"],
        message: "Finalization chunk set must exactly match committed chunks",
      });
    }
    if (
      recording.savedOutput &&
      recording.finalization &&
      (recording.savedOutput.destination !== recording.finalization.publishIntent.destination ||
        recording.savedOutput.byteLength !== recording.finalization.publishIntent.expectedIdentity.byteLength ||
        recording.savedOutput.sha256 !== recording.finalization.publishIntent.expectedIdentity.sha256)
    ) {
      context.addIssue({
        code: "custom",
        path: ["savedOutput"],
        message: "Saved output must exactly match publication intent",
      });
    }
  });

const MeetingStateSchema = z
  .object({
    version: z.literal(2),
    meetings: z.array(MeetingSchema),
    recordings: z.array(RecordingSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const meetingIds = new Set<string>();
    state.meetings.forEach((meeting, index) => {
      if (meetingIds.has(meeting.id)) {
        context.addIssue({ code: "custom", path: ["meetings", index, "id"], message: `Duplicate meeting id: ${meeting.id}` });
      }
      meetingIds.add(meeting.id);
    });
    const recordingIds = new Set<string>();
    state.recordings.forEach((recording, index) => {
      if (recordingIds.has(recording.id)) {
        context.addIssue({ code: "custom", path: ["recordings", index, "id"], message: `Duplicate recording id: ${recording.id}` });
      }
      recordingIds.add(recording.id);
      const meeting = state.meetings.find((candidate) => candidate.id === recording.meetingId);
      if (!meeting) {
        context.addIssue({
          code: "custom",
          path: ["recordings", index, "meetingId"],
          message: `Recording references missing meeting ${recording.meetingId} (docs/product/recording.md). Restore the parent meeting before retrying`,
        });
      } else if (!recordingParentStatuses(recording).includes(meeting.status)) {
        const expected = recordingParentStatuses(recording).join(" or ");
        context.addIssue({
          code: "custom",
          path: ["recordings", index, "meetingId"],
          message: `Recording ${recording.id} (${recording.status}) requires parent meeting ${meeting.id} to be ${expected}, not ${meeting.status} (docs/product/recording.md). Restore the coupled lifecycle state before retrying`,
        });
      }
    });
    if (state.recordings.filter((recording) => recording.status === "recording").length > 1) {
      context.addIssue({
        code: "custom",
        path: ["recordings"],
        message: "At most one active recording is allowed (docs/product/recording.md). Recover the existing session before starting another",
      });
    }
  });

function recordingParentStatuses(recording: RecordingSession): readonly MeetingStatus[] {
  if (recording.status === "saved") return ["processing", "ready", "archived"];
  return recording.finalization === null ? ["recording"] : ["processing"];
}

interface MeetingState {
  version: 2;
  meetings: Meeting[];
  recordings: RecordingSession[];
}

export class MeetingStoreCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Meeting state is corrupt at ${filePath}; repair or restore it before retrying`, { cause });
    this.name = "MeetingStoreCorruptError";
  }
}

export class DuplicateMeetingError extends Error {
  constructor(id: string) {
    super(`Meeting already exists: ${id}`);
    this.name = "DuplicateMeetingError";
  }
}

export class RecordingOwnedMeetingTransitionError extends Error {
  constructor(from: MeetingStatus, to: MeetingStatus, nextAction: string) {
    super(
      `Meeting transition ${from} -> ${to} is owned by the recording lifecycle (docs/product/recording.md). ${nextAction}`,
    );
    this.name = "RecordingOwnedMeetingTransitionError";
  }
}

export interface MeetingStoreOptions {
  root: string;
  now?: () => string;
  createId?: () => string;
}

export class MeetingStore {
  readonly filePath: string;
  private readonly root: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: MeetingStoreOptions) {
    this.root = path.resolve(options.root);
    this.filePath = path.join(this.root, "meetings.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
  }

  async list(): Promise<Meeting[]> {
    await this.mutationTail;
    const state = await this.readState();
    return state.meetings.map((meeting) => ({ ...meeting }));
  }

  async listRecordings(): Promise<RecordingSession[]> {
    await this.mutationTail;
    const state = await this.readState();
    return state.recordings.map((recording) => structuredClone(recording));
  }

  migrateSchemaV1(): Promise<void> {
    return this.mutate(async () => undefined);
  }

  create(input: { title: string; id?: string }): Promise<Meeting> {
    return this.mutate(async (state) => {
      const meeting = createMeeting({
        id: input.id ?? this.createId(),
        title: input.title,
        now: this.now(),
      });
      if (state.meetings.some((candidate) => candidate.id === meeting.id)) {
        throw new DuplicateMeetingError(meeting.id);
      }
      state.meetings.push(meeting);
      return meeting;
    });
  }

  transition(id: string, status: MeetingStatus): Promise<Meeting> {
    return this.mutate(async (state) => {
      const index = state.meetings.findIndex((meeting) => meeting.id === id);
      if (index < 0) throw new Error(`Meeting not found: ${id}`);
      const current = state.meetings[index];
      if (!current) throw new Error(`Meeting not found: ${id}`);
      if (current.status === "draft" && status === "recording") {
        throw new RecordingOwnedMeetingTransitionError(
          current.status,
          status,
          "Call startRecording so the meeting and recording session are committed together.",
        );
      }
      if (current.status === "recording" && status === "processing") {
        throw new RecordingOwnedMeetingTransitionError(
          current.status,
          status,
          "Call beginFinalization so the meeting and recording session are committed together.",
        );
      }
      const next = transitionMeeting(current, status, this.now());
      state.meetings[index] = next;
      return next;
    });
  }

  startRecording(input: { meetingId: string; id?: string }): Promise<RecordingSession> {
    return this.mutate(async (state) => {
      const meetingIndex = state.meetings.findIndex((meeting) => meeting.id === input.meetingId);
      if (meetingIndex < 0) throw new Error(`Meeting not found: ${input.meetingId}`);
      const meeting = state.meetings[meetingIndex]!;
      if (meeting.status !== "draft") {
        throw new RecordingOwnedMeetingTransitionError(
          meeting.status,
          "recording",
          "Start recording only from a draft meeting.",
        );
      }
      if (state.recordings.some((recording) => recording.status === "recording")) {
        throw new Error(
          "At most one active recording is allowed (docs/product/recording.md). Stop or recover the active session before starting another.",
        );
      }
      const now = this.now();
      const recording = startRecording({
        id: input.id ?? this.createId(),
        meetingId: input.meetingId,
        now,
      });
      if (state.recordings.some((candidate) => candidate.id === recording.id)) {
        throw new Error(`Recording already exists: ${recording.id}`);
      }
      const transitionedMeeting = transitionMeeting(meeting, "recording", now);
      state.meetings[meetingIndex] = transitionedMeeting;
      state.recordings.push(recording);
      return recording;
    });
  }

  pauseRecording(id: string, openChunksDurablyClosed: boolean): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      pauseRecording(recording, { now: this.now(), openChunksDurablyClosed }),
    );
  }

  resumeRecording(id: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) => resumeRecording(recording, this.now()));
  }

  commitChunk(id: string, chunk: CommittedRecordingChunk): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) => commitRecordingChunk(recording, chunk));
  }

  adoptOrphanChunk(
    id: string,
    input: {
      chunk: CommittedRecordingChunk;
      fullyCommitted: boolean;
      readable: boolean;
      identityValid: boolean;
    },
  ): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) => adoptOrphanChunk(recording, input));
  }

  interruptRecording(id: string, reason: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      interruptRecording(recording, { now: this.now(), reason }),
    );
  }

  assessInterruption(
    id: string,
    input: { recoverable: boolean; reason?: string },
  ): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      assessInterruptedRecording(recording, { ...input, now: this.now() }),
    );
  }

  beginFinalization(
    id: string,
    input: {
      openChunksDurablyClosed: boolean;
      chunkSetDigest: string;
      destination: string;
      expectedIdentity: OutputIdentity;
    },
  ): Promise<RecordingSession> {
    return this.mutate(async (state) => {
      const recordingIndex = this.recordingIndex(state, id);
      const recording = state.recordings[recordingIndex]!;
      const meetingIndex = state.meetings.findIndex((meeting) => meeting.id === recording.meetingId);
      if (meetingIndex < 0) throw new Error(`Meeting not found: ${recording.meetingId}`);
      const meeting = state.meetings[meetingIndex]!;
      if (meeting.status !== "recording") {
        throw new RecordingOwnedMeetingTransitionError(
          meeting.status,
          "processing",
          "Begin finalization only while the parent meeting is recording.",
        );
      }
      const now = this.now();
      const finalizedRecording = beginFinalization(recording, { ...input, now });
      const transitionedMeeting = transitionMeeting(meeting, "processing", now);
      state.recordings[recordingIndex] = finalizedRecording;
      state.meetings[meetingIndex] = transitionedMeeting;
      return finalizedRecording;
    });
  }

  retryFinalization(id: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      retryFinalization(recording, { now: this.now() }),
    );
  }

  reconcilePublish(
    id: string,
    input: {
      existingOutput: OutputIdentity | null;
      existingOutputReadable?: boolean;
      nextDestination?: string;
    },
  ): Promise<{ action: "publish" | "adopt" | "collision"; recording: RecordingSession }> {
    return this.mutate(async (state) => {
      const index = this.recordingIndex(state, id);
      const result = reconcilePublishIntent(state.recordings[index]!, { ...input, now: this.now() });
      state.recordings[index] = result.session;
      return { action: result.action, recording: result.session };
    });
  }

  markRecordingSaved(
    id: string,
    input: { destination: string; identity: OutputIdentity; readable: boolean },
  ): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      markRecordingSaved(recording, { ...input, now: this.now() }),
    );
  }

  async cleanupEligibleChunks(
    id: string,
    verification: { destination: string; identity: OutputIdentity; readable: boolean },
  ): Promise<CommittedRecordingChunk[]> {
    await this.mutationTail;
    const state = await this.readState();
    const recording = state.recordings[this.recordingIndex(state, id)]!;
    assertCleanupEligible(recording, verification);
    return recording.chunks.map((chunk) => ({ ...chunk }));
  }

  private changeRecording(
    id: string,
    change: (recording: RecordingSession) => RecordingSession,
  ): Promise<RecordingSession> {
    return this.mutate(async (state) => {
      const index = this.recordingIndex(state, id);
      const next = change(state.recordings[index]!);
      state.recordings[index] = next;
      return next;
    });
  }

  private recordingIndex(state: MeetingState, id: string): number {
    const index = state.recordings.findIndex((recording) => recording.id === id);
    if (index < 0) throw new Error(`Recording not found: ${id}`);
    return index;
  }

  private mutate<T>(change: (state: MeetingState) => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const state = await this.readState();
      const result = await change(state);
      await this.writeState(state);
      return result;
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async readState(): Promise<MeetingState> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { version: 2, meetings: [], recordings: [] };
      throw error;
    }
    try {
      const decoded: unknown = JSON.parse(contents);
      const v1 = StateV1Schema.safeParse(decoded);
      if (v1.success) return { version: 2, meetings: v1.data.meetings, recordings: [] };
      return MeetingStateSchema.parse(decoded);
    } catch (error) {
      throw new MeetingStoreCorruptError(this.filePath, error);
    }
  }

  private async writeState(state: MeetingState): Promise<void> {
    const checked = MeetingStateSchema.parse(state);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.root, `.meetings.${process.pid}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      temporaryCreated = false;
      await syncDirectory(this.root);
    } finally {
      if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
