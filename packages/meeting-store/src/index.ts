import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
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
  markRecordingInventoryScanning,
  MEETING_STATUSES,
  pauseRecording,
  prepareRecordingInventoryRecovery,
  publishRecordingInventory,
  blockRecordingInventory,
  reconcilePublishIntent,
  RECORDING_SOURCES,
  RECORDING_STATUSES,
  RECORDING_INVENTORY_STATES,
  resumeRecording,
  retryFinalization,
  startRecording,
  beginTranscriptRequest,
  checkpointTranscriptRange,
  createTranscript,
  failTranscript,
  failRecordingWithNoValidMedia,
  publishTranscript,
  reconcileTranscriptAfterRestart,
  resolveTranscriptCitation,
  retryTranscript,
  type TranscriptAudioIdentity,
  type TranscriptCitation,
  type TranscriptPublication,
  type TranscriptState,
  type TranscriptUsage,
  DEFAULT_TRANSCRIPT_MAX_ATTEMPTS,
  CHAT_ATTEMPT_STATUSES,
  CHAT_THREAD_STATUSES,
  completeChatAttempt,
  createMeetingChatThread,
  failChatAttempt,
  reconcileChatAfterRestart,
  recordChatRetrieval,
  retryChatAttempt,
  startChatQuestion,
  type MeetingChatThread,
  transitionMeeting,
  type CommittedRecordingChunk,
  type Meeting,
  type MeetingStatus,
  type OutputIdentity,
  type RecordingSession,
  type RecordingInventoryPointer,
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
    logicalStartMs: z.number().int().nonnegative(),
    durationMs: z.number().int().positive(),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    format: z.literal("wav"),
  })
  .strict();

const RecordingV2Schema = z
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

const MeetingStateV2Schema = z
  .object({
    version: z.literal(2),
    meetings: z.array(MeetingSchema),
    recordings: z.array(RecordingV2Schema),
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

const InventoryPointerSchema = z.object({
  storageKey: z.string().trim().min(1),
  digest: z.string().trim().min(1),
  chunkCount: z.number().int().positive(),
  microphoneCount: z.number().int().nonnegative(),
  systemCount: z.number().int().nonnegative(),
  publishedAt: z.string().datetime(),
}).strict();

const InventorySchema = z.object({
  state: z.enum(RECORDING_INVENTORY_STATES),
  knownChunkCount: z.number().int().nonnegative(),
  microphoneCount: z.number().int().nonnegative(),
  systemCount: z.number().int().nonnegative(),
  pointer: InventoryPointerSchema.nullable(),
  error: z.string().trim().min(1).nullable(),
}).strict().superRefine((inventory, context) => {
  if (inventory.microphoneCount + inventory.systemCount !== inventory.knownChunkCount) {
    context.addIssue({ code: "custom", path: ["knownChunkCount"], message: "Inventory source counts must equal its authoritative count" });
  }
  if ((inventory.state === "complete") !== (inventory.pointer !== null)) {
    context.addIssue({ code: "custom", path: ["pointer"], message: "Only complete inventory owns an immutable sidecar pointer" });
  }
  if (inventory.state === "blocked" && !inventory.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "Blocked inventory requires reconciliation evidence" });
  }
  if (inventory.pointer && (
    inventory.pointer.chunkCount !== inventory.knownChunkCount ||
    inventory.pointer.microphoneCount !== inventory.microphoneCount ||
    inventory.pointer.systemCount !== inventory.systemCount
  )) {
    context.addIssue({ code: "custom", path: ["pointer"], message: "Inventory pointer counts must exactly match the store summary" });
  }
});

const RecordingSchema = z.object({
  id: z.string().trim().min(1),
  meetingId: z.string().trim().min(1),
  status: z.enum(RECORDING_STATUSES),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative(),
  activeSince: z.string().datetime().nullable(),
  chunks: z.array(ChunkSchema),
  inventory: InventorySchema,
  interruption: z.object({ reason: z.string().trim().min(1), interruptedAt: z.string().datetime() }).strict().nullable(),
  failureReason: z.string().trim().min(1).nullable(),
  finalization: z.object({
    chunkSetDigest: z.string().trim().min(1),
    chunkCount: z.number().int().positive(),
    publishIntent: z.object({
      destination: z.string().trim().min(1),
      expectedIdentity: OutputIdentitySchema,
      createdAt: z.string().datetime(),
    }).strict(),
  }).strict().nullable(),
  savedOutput: z.object({
    destination: z.string().trim().min(1), byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1), savedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict().superRefine((recording, context) => {
  const ids = new Set<string>();
  recording.chunks.forEach((chunk, index) => {
    if (ids.has(chunk.id)) context.addIssue({ code: "custom", path: ["chunks", index, "id"], message: `Duplicate chunk id: ${chunk.id}` });
    ids.add(chunk.id);
  });
  if (recording.inventory.state === "complete" && recording.chunks.length !== 0) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Published inventory must not duplicate chunk entries in MeetingStore" });
  }
  if (recording.inventory.state !== "complete" && recording.chunks.length !== recording.inventory.knownChunkCount) {
    context.addIssue({ code: "custom", path: ["inventory", "knownChunkCount"], message: "Pending inventory count must match known store chunks" });
  }
  if (recording.status === "recording" && recording.finalization !== null) context.addIssue({ code: "custom", path: ["finalization"], message: "Recording state cannot have finalization intent" });
  if (recording.status !== "recording" && recording.activeSince !== null) context.addIssue({ code: "custom", path: ["activeSince"], message: "Inactive recording state cannot accumulate elapsed time" });
  if (recording.status === "finalizing" && (!recording.finalization || recording.inventory.state !== "complete")) context.addIssue({ code: "custom", path: ["finalization"], message: "Finalizing recording requires a complete durable inventory and intent" });
  if (recording.status === "saved" && (!recording.savedOutput || !recording.finalization)) context.addIssue({ code: "custom", path: ["savedOutput"], message: "Saved recording requires output and finalization identity" });
  if (recording.status !== "saved" && recording.savedOutput !== null) context.addIssue({ code: "custom", path: ["savedOutput"], message: "Only saved state can own saved output identity" });
  if (recording.status === "interrupted" && recording.interruption === null) context.addIssue({ code: "custom", path: ["interruption"], message: "Interrupted state requires interruption evidence" });
  if (recording.status === "failed" && recording.failureReason === null) context.addIssue({ code: "custom", path: ["failureReason"], message: "Failed state requires proven failure reason" });
  if (recording.finalization && recording.inventory.pointer && (
    recording.finalization.chunkSetDigest !== recording.inventory.pointer.digest ||
    recording.finalization.chunkCount !== recording.inventory.pointer.chunkCount
  )) context.addIssue({ code: "custom", path: ["finalization"], message: "Finalization must consume the frozen inventory digest" });
  if (recording.savedOutput && recording.finalization && (
    recording.savedOutput.destination !== recording.finalization.publishIntent.destination ||
    recording.savedOutput.byteLength !== recording.finalization.publishIntent.expectedIdentity.byteLength ||
    recording.savedOutput.sha256 !== recording.finalization.publishIntent.expectedIdentity.sha256
  )) context.addIssue({ code: "custom", path: ["savedOutput"], message: "Saved output must exactly match publication intent" });
});

const TranscriptUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
}).strict();

const TranscriptRangeSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  segmentId: z.string().trim().min(1),
}).strict().superRefine((range, context) => {
  if (range.endMs <= range.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "Transcript ranges must be half-open and non-empty" });
});

const TranscriptCheckpointSchema = z.object({
  range: TranscriptRangeSchema,
  text: z.string(),
  attempts: z.number().int().positive(),
  completedAt: z.string().datetime(),
  usage: TranscriptUsageSchema.nullable(),
  detectedLanguages: z.array(z.string().trim().min(1)),
}).strict();

const TranscriptSchema = z.object({
  id: z.string().trim().min(1),
  meetingId: z.string().trim().min(1),
  recordingId: z.string().trim().min(1),
  status: z.enum(["pending", "transcribing", "ready", "failed"]),
  plannerVersion: z.literal("m3-range-v1"),
  rangeMs: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  audio: z.object({
    destination: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1),
    durationMs: z.number().int().positive(),
  }).strict(),
  ranges: z.array(TranscriptRangeSchema).min(1),
  checkpoints: z.array(TranscriptCheckpointSchema),
  attemptsByOrdinal: z.record(z.string(), z.number().int().positive()),
  requestCount: z.number().int().nonnegative(),
  usage: TranscriptUsageSchema.nullable(),
  detectedLanguages: z.array(z.string().trim().min(1)),
  startedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  failureReason: z.string().trim().min(1).nullable(),
  publication: z.object({
    storageKey: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1),
    publishedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict().superRefine((transcript, context) => {
  if (transcript.status === "ready" && transcript.publication === null) {
    context.addIssue({ code: "custom", path: ["publication"], message: "Ready transcript requires an immutable publication sidecar" });
  }
  if (transcript.status === "failed" && transcript.failureReason === null) {
    context.addIssue({ code: "custom", path: ["failureReason"], message: "Failed transcript requires a redacted failure reason" });
  }
  if (transcript.checkpoints.length > transcript.ranges.length) {
    context.addIssue({ code: "custom", path: ["checkpoints"], message: "Transcript cannot checkpoint more ranges than planned" });
  }
  transcript.checkpoints.forEach((checkpoint, index) => {
    const expected = transcript.ranges[index];
    if (!expected || JSON.stringify(expected) !== JSON.stringify(checkpoint.range)) {
      context.addIssue({ code: "custom", path: ["checkpoints", index, "range"], message: "Transcript checkpoint does not match the deterministic range plan" });
    }
  });
  const requestCount = Object.values(transcript.attemptsByOrdinal).reduce((total, count) => total + count, 0);
  if (requestCount !== transcript.requestCount) {
    context.addIssue({ code: "custom", path: ["requestCount"], message: "Transcript request count must equal persisted range attempts" });
  }
});

const TranscriptSidecarSchema = z.object({
  version: z.literal(1),
  transcriptId: z.string().trim().min(1),
  meetingId: z.string().trim().min(1),
  recordingId: z.string().trim().min(1),
  plannerVersion: z.literal("m3-range-v1"),
  audio: z.object({
    destination: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    sha256: z.string().trim().min(1),
    durationMs: z.number().int().positive(),
  }).strict(),
  ranges: z.array(TranscriptRangeSchema).min(1),
  segments: z.array(z.object({ range: TranscriptRangeSchema, text: z.string() }).strict()),
  usage: TranscriptUsageSchema.nullable(),
  detectedLanguages: z.array(z.string().trim().min(1)),
  publishedAt: z.string().datetime(),
}).strict();

const StateV3Schema = z.object({
  version: z.literal(3), meetings: z.array(MeetingSchema), recordings: z.array(RecordingSchema),
  transcripts: z.array(TranscriptSchema).optional(),
  cloudConsent: z.object({ status: z.literal("granted"), grantedAt: z.string().datetime() }).strict().optional(),
}).strict().superRefine((state, context) => {
  const meetingIds = new Set<string>();
  state.meetings.forEach((meeting, index) => {
    if (meetingIds.has(meeting.id)) context.addIssue({ code: "custom", path: ["meetings", index, "id"], message: `Duplicate meeting id: ${meeting.id}` });
    meetingIds.add(meeting.id);
  });
  const recordingIds = new Set<string>();
  state.recordings.forEach((recording, index) => {
    if (recordingIds.has(recording.id)) context.addIssue({ code: "custom", path: ["recordings", index, "id"], message: `Duplicate recording id: ${recording.id}` });
    recordingIds.add(recording.id);
    const meeting = state.meetings.find((candidate) => candidate.id === recording.meetingId);
    if (!meeting) context.addIssue({ code: "custom", path: ["recordings", index, "meetingId"], message: `Recording references missing meeting ${recording.meetingId} (docs/product/recording.md). Restore the parent meeting before retrying` });
    else if (!recordingParentStatuses(recording).includes(meeting.status)) context.addIssue({ code: "custom", path: ["recordings", index, "meetingId"], message: `Recording ${recording.id} (${recording.status}) has inconsistent parent meeting ${meeting.id} (${meeting.status}) (docs/product/recording.md). Restore the coupled lifecycle state before retrying` });
  });
  if (state.recordings.filter((recording) => recording.status === "recording").length > 1) context.addIssue({ code: "custom", path: ["recordings"], message: "At most one active recording is allowed (docs/product/recording.md). Recover the existing session before starting another" });
  const transcriptIds = new Set<string>();
  for (const [index, transcript] of (state.transcripts ?? []).entries()) {
    if (transcriptIds.has(transcript.id)) context.addIssue({ code: "custom", path: ["transcripts", index, "id"], message: `Duplicate transcript id: ${transcript.id}` });
    transcriptIds.add(transcript.id);
    const recording = state.recordings.find((candidate) => candidate.id === transcript.recordingId);
    if (!recording) context.addIssue({ code: "custom", path: ["transcripts", index, "recordingId"], message: `Transcript references missing recording ${transcript.recordingId}` });
    else if (recording.meetingId !== transcript.meetingId) context.addIssue({ code: "custom", path: ["transcripts", index, "meetingId"], message: `Transcript ${transcript.id} does not belong to recording ${transcript.recordingId}` });
  }
});

const ChatCitationSchema = z.object({
  segmentId: z.string().trim().min(1),
}).strict();

const ChatMessageSchema = z.union([
  z.object({
    id: z.string().trim().min(1),
    role: z.literal("user"),
    text: z.string().trim().min(1),
    createdAt: z.string().datetime(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    role: z.literal("assistant"),
    attemptId: z.string().trim().min(1),
    outcome: z.literal("supported"),
    text: z.string().trim().min(1),
    citations: z.array(ChatCitationSchema).min(1),
    createdAt: z.string().datetime(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    role: z.literal("assistant"),
    attemptId: z.string().trim().min(1),
    outcome: z.literal("insufficient_evidence"),
    text: z.null(),
    citations: z.array(ChatCitationSchema).length(0),
    createdAt: z.string().datetime(),
  }).strict(),
]);

const ChatAttemptSchema = z.object({
  id: z.string().trim().min(1),
  userMessageId: z.string().trim().min(1),
  status: z.enum(CHAT_ATTEMPT_STATUSES),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  retrievedSegmentIds: z.array(z.string().trim().min(1)),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  failureReason: z.string().trim().min(1).nullable(),
}).strict().superRefine((attempt, context) => {
  if (new Set(attempt.retrievedSegmentIds).size !== attempt.retrievedSegmentIds.length) {
    context.addIssue({ code: "custom", path: ["retrievedSegmentIds"], message: "Retrieved chat segment IDs must be unique" });
  }
  if (attempt.status === "running" && (attempt.completedAt !== null || attempt.failureReason !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Running chat attempt cannot be complete or failed" });
  }
  if (attempt.status === "completed" && (attempt.completedAt === null || attempt.failureReason !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Completed chat attempt requires completion time and no failure" });
  }
  if (attempt.status === "failed" && (attempt.completedAt === null || attempt.failureReason === null)) {
    context.addIssue({ code: "custom", path: ["failureReason"], message: "Failed chat attempt requires completion time and retry reason" });
  }
});

const ChatThreadSchema = z.object({
  id: z.string().trim().min(1),
  meetingId: z.string().trim().min(1),
  status: z.enum(CHAT_THREAD_STATUSES),
  messages: z.array(ChatMessageSchema),
  attempts: z.array(ChatAttemptSchema),
  activeAttemptId: z.string().trim().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((thread, context) => {
  const messageIds = new Set<string>();
  thread.messages.forEach((message, index) => {
    if (messageIds.has(message.id)) context.addIssue({ code: "custom", path: ["messages", index, "id"], message: `Duplicate chat message id: ${message.id}` });
    messageIds.add(message.id);
  });
  const attemptIds = new Set<string>();
  thread.attempts.forEach((attempt, index) => {
    if (attemptIds.has(attempt.id)) context.addIssue({ code: "custom", path: ["attempts", index, "id"], message: `Duplicate chat attempt id: ${attempt.id}` });
    attemptIds.add(attempt.id);
    const userIndex = thread.messages.findIndex((message) => message.id === attempt.userMessageId && message.role === "user");
    if (userIndex < 0) context.addIssue({ code: "custom", path: ["attempts", index, "userMessageId"], message: `Chat attempt ${attempt.id} references a missing user message` });
    const assistantIndexes = thread.messages.flatMap((message, messageIndex) =>
      message.role === "assistant" && message.attemptId === attempt.id ? [messageIndex] : []);
    if (attempt.status === "completed" && assistantIndexes.length !== 1) {
      context.addIssue({ code: "custom", path: ["attempts", index], message: `Completed chat attempt ${attempt.id} requires exactly one assistant answer` });
    }
    if (attempt.status !== "completed" && assistantIndexes.length !== 0) {
      context.addIssue({ code: "custom", path: ["attempts", index], message: `Unfinished chat attempt ${attempt.id} cannot own an assistant answer` });
    }
    if (assistantIndexes.some((assistantIndex) => assistantIndex <= userIndex)) {
      context.addIssue({ code: "custom", path: ["messages"], message: `Assistant answer for ${attempt.id} must follow its user question` });
    }
  });
  thread.messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const attempt = thread.attempts.find((candidate) => candidate.id === message.attemptId);
    if (!attempt) context.addIssue({ code: "custom", path: ["messages", index, "attemptId"], message: `Assistant message references missing attempt ${message.attemptId}` });
    const citationIds = message.citations.map((citation) => citation.segmentId);
    if (new Set(citationIds).size !== citationIds.length) context.addIssue({ code: "custom", path: ["messages", index, "citations"], message: "Assistant citations must be unique" });
    if (message.outcome === "supported" && citationIds.length === 0) context.addIssue({ code: "custom", path: ["messages", index, "citations"], message: "Supported answer requires at least one citation" });
    if (message.outcome === "insufficient_evidence" && citationIds.length !== 0) context.addIssue({ code: "custom", path: ["messages", index, "citations"], message: "Insufficient-evidence answer cannot contain citations" });
    if (attempt && citationIds.some((segmentId) => !attempt.retrievedSegmentIds.includes(segmentId))) {
      context.addIssue({ code: "custom", path: ["messages", index, "citations"], message: "Assistant cited a segment not retrieved during its attempt" });
    }
  });
  const running = thread.attempts.filter((attempt) => attempt.status === "running");
  if (thread.status === "running" && (running.length !== 1 || running[0]?.id !== thread.activeAttemptId)) {
    context.addIssue({ code: "custom", path: ["activeAttemptId"], message: "Running chat thread requires exactly one matching active attempt" });
  }
  if (thread.status !== "running" && (thread.activeAttemptId !== null || running.length !== 0)) {
    context.addIssue({ code: "custom", path: ["activeAttemptId"], message: "Only a running chat thread can own an active attempt" });
  }
  const latest = thread.attempts.at(-1);
  if (thread.status === "failed" && latest?.status !== "failed") context.addIssue({ code: "custom", path: ["status"], message: "Failed chat thread requires the latest failed attempt" });
  if (thread.status === "ready" && latest && latest.status !== "completed") context.addIssue({ code: "custom", path: ["status"], message: "Ready non-empty chat thread requires the latest completed attempt" });
});

const MeetingStateSchema = z.object({
  version: z.literal(4),
  meetings: z.array(MeetingSchema),
  recordings: z.array(RecordingSchema),
  transcripts: z.array(TranscriptSchema).optional(),
  cloudConsent: z.object({ status: z.literal("granted"), grantedAt: z.string().datetime() }).strict().optional(),
  chatThreads: z.array(ChatThreadSchema).optional(),
}).strict().superRefine((state, context) => {
  const v3Shape = {
    version: 3 as const,
    meetings: state.meetings,
    recordings: state.recordings,
    ...(state.transcripts ? { transcripts: state.transcripts } : {}),
    ...(state.cloudConsent ? { cloudConsent: state.cloudConsent } : {}),
  };
  const v3 = StateV3Schema.safeParse(v3Shape);
  if (!v3.success) {
    for (const issue of v3.error.issues) context.addIssue({ ...issue, path: issue.path });
  }
  const threadIds = new Set<string>();
  const threadMeetingIds = new Set<string>();
  for (const [index, thread] of (state.chatThreads ?? []).entries()) {
    if (threadIds.has(thread.id)) context.addIssue({ code: "custom", path: ["chatThreads", index, "id"], message: `Duplicate chat thread id: ${thread.id}` });
    threadIds.add(thread.id);
    if (threadMeetingIds.has(thread.meetingId)) context.addIssue({ code: "custom", path: ["chatThreads", index, "meetingId"], message: `Meeting has more than one V1 chat thread: ${thread.meetingId}` });
    threadMeetingIds.add(thread.meetingId);
    if (!state.meetings.some((meeting) => meeting.id === thread.meetingId)) context.addIssue({ code: "custom", path: ["chatThreads", index, "meetingId"], message: `Chat thread references missing meeting ${thread.meetingId}` });
    const transcript = state.transcripts?.find((candidate) => candidate.meetingId === thread.meetingId);
    if (!transcript || transcript.status !== "ready" || transcript.publication === null) {
      context.addIssue({ code: "custom", path: ["chatThreads", index, "meetingId"], message: `Chat thread ${thread.id} requires its meeting's immutable ready transcript` });
      continue;
    }
    const segmentIds = new Set(transcript.checkpoints.map((checkpoint) => checkpoint.range.segmentId));
    for (const [attemptIndex, attempt] of thread.attempts.entries()) {
      const invalid = attempt.retrievedSegmentIds.find((segmentId) => !segmentIds.has(segmentId));
      if (invalid) context.addIssue({ code: "custom", path: ["chatThreads", index, "attempts", attemptIndex, "retrievedSegmentIds"], message: `Retrieved segment does not resolve through meeting ${thread.meetingId}: ${invalid}` });
    }
    for (const [messageIndex, message] of thread.messages.entries()) {
      if (message.role !== "assistant") continue;
      const invalid = message.citations.find((citation) => !segmentIds.has(citation.segmentId));
      if (invalid) context.addIssue({ code: "custom", path: ["chatThreads", index, "messages", messageIndex, "citations"], message: `Citation does not resolve through meeting ${thread.meetingId}: ${invalid.segmentId}` });
    }
  }
});

function recordingParentStatuses(recording: { status: RecordingSession["status"]; finalization: unknown | null }): readonly MeetingStatus[] {
  if (recording.status === "saved") return ["processing", "ready", "archived"];
  return recording.finalization === null ? ["recording"] : ["processing"];
}

interface MeetingState {
  version: 4;
  meetings: Meeting[];
  recordings: RecordingSession[];
  transcripts: TranscriptState[];
  cloudConsent: { status: "granted"; grantedAt: string } | null;
  chatThreads: MeetingChatThread[];
}

const DeletionManifestSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  meetingId: z.string().trim().min(1),
  entries: z.array(z.object({
    kind: z.enum(["session", "output", "transcript", "stage"]),
    ownerId: z.string().trim().min(1),
    approvedRoot: z.string().trim().min(1),
    original: z.string().trim().min(1),
    quarantine: z.string().trim().min(1),
  }).strict()),
  integritySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

type DeletionManifest = z.infer<typeof DeletionManifestSchema>;

export type MeetingDeleteStoreResult =
  | { meetingId: string; outcome: "deleted" | "not_found"; reason: null }
  | { meetingId: string; outcome: "refused"; reason: "active_capture" | "finalization" | "transcription" | "ask" };

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
  approvedExportRoots?: readonly string[];
  now?: () => string;
  createId?: () => string;
  deletionIo?: Partial<MeetingDeletionIo>;
}

export interface MeetingDeletionIo {
  open: typeof open;
  rename: typeof rename;
  rm: typeof rm;
  syncDirectory(directory: string): Promise<void>;
}

export interface MeetingDeleteInput {
  recordingStagePaths?: ReadonlyArray<{ recordingId: string; path: string }>;
}

class MeetingStateReplacementError extends Error {
  constructor(readonly replaced: boolean, cause: unknown) {
    super("Meeting state replacement failed", { cause });
  }
}

export class MeetingStore {
  readonly filePath: string;
  private readonly root: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly approvedExportRoots: string[];
  private readonly deletionIo: MeetingDeletionIo;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: MeetingStoreOptions) {
    this.root = path.resolve(options.root);
    this.filePath = path.join(this.root, "meetings.json");
    this.approvedExportRoots = (options.approvedExportRoots ?? []).map((root) => path.resolve(root));
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
    this.deletionIo = {
      open,
      rename,
      rm,
      syncDirectory,
      ...options.deletionIo,
    };
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

  async listTranscripts(meetingId?: string): Promise<TranscriptState[]> {
    await this.mutationTail;
    const state = await this.readState();
    return state.transcripts
      .filter((transcript) => meetingId === undefined || transcript.meetingId === meetingId)
      .map((transcript) => structuredClone(transcript));
  }

  async getTranscript(id: string): Promise<TranscriptState | null> {
    await this.mutationTail;
    const state = await this.readState();
    const transcript = state.transcripts.find((candidate) => candidate.id === id);
    return transcript ? structuredClone(transcript) : null;
  }

  async getTranscriptForMeeting(meetingId: string): Promise<TranscriptState | null> {
    await this.mutationTail;
    const state = await this.readState();
    const transcript = state.transcripts.find((candidate) => candidate.meetingId === meetingId);
    return transcript ? structuredClone(transcript) : null;
  }

  async transcriptionConsent(): Promise<{ status: "unknown" | "granted"; grantedAt?: string }> {
    await this.mutationTail;
    const state = await this.readState();
    return state.cloudConsent
      ? { status: "granted", grantedAt: state.cloudConsent.grantedAt }
      : { status: "unknown" };
  }

  grantTranscriptionConsent(): Promise<{ status: "granted"; grantedAt: string }> {
    return this.mutate(async (state) => {
      if (!state.cloudConsent) state.cloudConsent = { status: "granted", grantedAt: this.now() };
      return { ...state.cloudConsent };
    });
  }

  ensureTranscript(input: {
    meetingId: string;
    recordingId: string;
    audio: TranscriptAudioIdentity;
    rangeMs?: number;
    maxAttempts?: number;
  }): Promise<TranscriptState> {
    return this.mutate(async (state) => {
      const existing = state.transcripts.find((transcript) => transcript.recordingId === input.recordingId);
      if (existing) {
        if (
          existing.meetingId !== input.meetingId ||
          existing.audio.destination !== input.audio.destination ||
          existing.audio.byteLength !== input.audio.byteLength ||
          existing.audio.sha256 !== input.audio.sha256 ||
          existing.audio.durationMs !== input.audio.durationMs
        ) {
          throw new MeetingStoreCorruptError(this.filePath, new Error(`Transcript audio identity changed for ${input.recordingId}`));
        }
        return structuredClone(existing);
      }
      const recording = state.recordings.find((candidate) => candidate.id === input.recordingId);
      if (!recording || recording.meetingId !== input.meetingId || recording.status !== "saved" || !recording.savedOutput) {
        throw new Error(`Transcript requires the exact saved recording ${input.recordingId}`);
      }
      if (
        recording.savedOutput.destination !== input.audio.destination ||
        recording.savedOutput.byteLength !== input.audio.byteLength ||
        recording.savedOutput.sha256 !== input.audio.sha256
      ) {
        throw new MeetingStoreCorruptError(this.filePath, new Error(`Transcript audio identity does not match saved recording ${input.recordingId}`));
      }
      const transcript = createTranscript({
        meetingId: input.meetingId,
        recordingId: input.recordingId,
        audio: input.audio,
        now: this.now(),
        rangeMs: input.rangeMs,
        maxAttempts: input.maxAttempts ?? DEFAULT_TRANSCRIPT_MAX_ATTEMPTS,
      });
      state.transcripts.push(transcript);
      return transcript;
    });
  }

  beginTranscriptRequest(id: string): Promise<{
    transcript: TranscriptState;
    range: TranscriptState["ranges"][number];
    attempt: number;
  } | null> {
    return this.mutate(async (state) => {
      const index = this.transcriptIndex(state, id);
      const result = beginTranscriptRequest(state.transcripts[index]!, this.now());
      if (!result) return null;
      state.transcripts[index] = result.transcript;
      return { transcript: structuredClone(result.transcript), range: { ...result.range }, attempt: result.attempt };
    });
  }

  checkpointTranscriptRange(id: string, input: {
    range: TranscriptState["ranges"][number];
    text: string;
    attempts: number;
    usage: TranscriptUsage | null;
    detectedLanguages?: readonly string[];
  }): Promise<TranscriptState> {
    return this.changeTranscript(id, (transcript) => checkpointTranscriptRange(transcript, { ...input, now: this.now() }));
  }

  failTranscript(id: string, reason: string): Promise<TranscriptState> {
    return this.changeTranscript(id, (transcript) => failTranscript(transcript, reason, this.now()));
  }

  retryTranscript(id: string): Promise<TranscriptState> {
    return this.changeTranscript(id, (transcript) => retryTranscript(transcript, this.now()));
  }

  async publishTranscript(id: string): Promise<TranscriptState> {
    return this.mutate(async (state) => {
      const transcriptIndex = this.transcriptIndex(state, id);
      const current = state.transcripts[transcriptIndex]!;
      if (current.status === "ready" && current.publication) {
        await this.assertTranscriptSidecar(current);
        return structuredClone(current);
      }
      const publication = await this.writeTranscriptSidecar(current);
      const next = publishTranscript(current, { publication, now: this.now() });
      state.transcripts[transcriptIndex] = next;
      const meetingIndex = state.meetings.findIndex((meeting) => meeting.id === next.meetingId);
      if (meetingIndex < 0) throw new MeetingStoreCorruptError(this.filePath, new Error(`Transcript meeting missing: ${next.meetingId}`));
      const meeting = state.meetings[meetingIndex]!;
      if (meeting.status === "processing") state.meetings[meetingIndex] = transitionMeeting(meeting, "ready", this.now());
      else if (meeting.status !== "ready" && meeting.status !== "archived") {
        throw new MeetingStoreCorruptError(this.filePath, new Error(`Transcript publication requires processing meeting, found ${meeting.status}`));
      }
      return structuredClone(next);
    });
  }

  async reconcileTranscriptPublications(meetingIds?: readonly string[]): Promise<TranscriptState[]> {
    return this.mutate(async (state) => {
      const allowed = meetingIds ? new Set(meetingIds) : null;
      for (let index = 0; index < state.transcripts.length; index += 1) {
        const current = state.transcripts[index]!;
        if (allowed && !allowed.has(current.meetingId)) continue;
        if (current.status === "ready") {
          await this.assertTranscriptSidecar(current);
          continue;
        }
        const recovered = reconcileTranscriptAfterRestart(current, this.now());
        state.transcripts[index] = recovered;
        const sidecar = await this.readTranscriptSidecarIfPresent(recovered);
        if (!sidecar) continue;
        if (!this.transcriptSidecarMatches(recovered, sidecar)) {
          throw new MeetingStoreCorruptError(
            this.transcriptSidecarPath(recovered),
            new Error("Transcript publication sidecar does not match the durable checkpoint plan"),
          );
        }
        const publication = await this.transcriptPublicationForSidecar(recovered, sidecar);
        state.transcripts[index] = publishTranscript(recovered, { publication, now: this.now() });
        const meetingIndex = state.meetings.findIndex((meeting) => meeting.id === recovered.meetingId);
        if (meetingIndex >= 0 && state.meetings[meetingIndex]!.status === "processing") {
          state.meetings[meetingIndex] = transitionMeeting(state.meetings[meetingIndex]!, "ready", this.now());
        }
      }
      return state.transcripts.map((transcript) => structuredClone(transcript));
    });
  }

  async resolveCitation(meetingId: string, segmentId: string): Promise<TranscriptCitation> {
    await this.mutationTail;
    const state = await this.readState();
    const transcript = state.transcripts.find((candidate) => candidate.meetingId === meetingId);
    if (!transcript) throw new Error(`Transcript not found for meeting: ${meetingId}`);
    await this.assertTranscriptSidecar(transcript);
    return resolveTranscriptCitation(transcript, { meetingId, segmentId });
  }

  async listChatThreads(): Promise<MeetingChatThread[]> {
    await this.mutationTail;
    const state = await this.readState();
    for (const thread of state.chatThreads) {
      await this.assertTranscriptSidecar(this.chatTranscript(state, thread));
    }
    return state.chatThreads.map((thread) => structuredClone(thread));
  }

  async getChatThread(meetingId: string): Promise<MeetingChatThread | null> {
    await this.mutationTail;
    const state = await this.readState();
    const thread = state.chatThreads.find((candidate) => candidate.meetingId === meetingId);
    if (!thread) return null;
    await this.assertTranscriptSidecar(this.chatTranscript(state, thread));
    return structuredClone(thread);
  }

  startChatQuestion(input: {
    meetingId: string;
    question: string;
    provider: string;
    model: string;
    threadId?: string;
    userMessageId?: string;
    attemptId?: string;
  }): Promise<MeetingChatThread> {
    return this.mutate(async (state) => {
      const meeting = state.meetings.find((candidate) => candidate.id === input.meetingId);
      if (!meeting || (meeting.status !== "ready" && meeting.status !== "archived")) {
        throw new Error(`Chat requires a ready meeting: ${input.meetingId}`);
      }
      const transcript = state.transcripts.find((candidate) => candidate.meetingId === input.meetingId);
      if (!transcript || transcript.status !== "ready" || !transcript.publication) {
        throw new Error(`Chat requires the immutable ready transcript for meeting: ${input.meetingId}`);
      }
      await this.assertTranscriptSidecar(transcript);
      let threadIndex = state.chatThreads.findIndex((candidate) => candidate.meetingId === input.meetingId);
      if (threadIndex < 0) {
        const thread = createMeetingChatThread({
          id: input.threadId ?? this.createId(), meetingId: input.meetingId, now: this.now(),
        });
        if (state.chatThreads.some((candidate) => candidate.id === thread.id)) {
          throw new Error(`Chat thread already exists: ${thread.id}`);
        }
        state.chatThreads.push(thread);
        threadIndex = state.chatThreads.length - 1;
      }
      const next = startChatQuestion(state.chatThreads[threadIndex]!, {
        userMessageId: input.userMessageId ?? this.createId(),
        attemptId: input.attemptId ?? this.createId(),
        question: input.question,
        provider: input.provider,
        model: input.model,
        now: this.now(),
      });
      state.chatThreads[threadIndex] = next;
      return structuredClone(next);
    });
  }

  recordChatRetrieval(
    meetingId: string,
    attemptId: string,
    segmentIds: readonly string[],
  ): Promise<MeetingChatThread> {
    return this.changeChatThread(meetingId, async (state, thread) => {
      const transcript = this.chatTranscript(state, thread);
      await this.assertTranscriptSidecar(transcript);
      return recordChatRetrieval(thread, {
        attemptId, segmentIds, availableSegmentIds: this.transcriptSegmentIds(transcript), now: this.now(),
      });
    });
  }

  completeChatTurn(meetingId: string, input: {
    attemptId: string;
    assistantMessageId?: string;
  } & (
    | { outcome: "supported"; text: string; citationSegmentIds: readonly string[] }
    | { outcome: "insufficient_evidence"; text?: null; citationSegmentIds: readonly [] }
  )): Promise<MeetingChatThread> {
    return this.changeChatThread(meetingId, async (state, thread) => {
      const transcript = this.chatTranscript(state, thread);
      await this.assertTranscriptSidecar(transcript);
      return completeChatAttempt(thread, {
        ...input,
        assistantMessageId: input.assistantMessageId ?? this.createId(),
        availableSegmentIds: this.transcriptSegmentIds(transcript),
        now: this.now(),
      });
    });
  }

  failChatTurn(meetingId: string, attemptId: string, reason: string): Promise<MeetingChatThread> {
    return this.changeChatThread(meetingId, async (_state, thread) =>
      failChatAttempt(thread, { attemptId, reason, now: this.now() }));
  }

  retryChatTurn(meetingId: string, input: {
    attemptId?: string;
    provider: string;
    model: string;
  }): Promise<MeetingChatThread> {
    return this.changeChatThread(meetingId, async (state, thread) => {
      await this.assertTranscriptSidecar(this.chatTranscript(state, thread));
      return retryChatAttempt(thread, {
        attemptId: input.attemptId ?? this.createId(), provider: input.provider, model: input.model, now: this.now(),
      });
    });
  }

  reconcileChatAfterRestart(meetingIds?: readonly string[]): Promise<MeetingChatThread[]> {
    return this.mutate(async (state) => {
      const allowed = meetingIds ? new Set(meetingIds) : null;
      state.chatThreads = state.chatThreads.map((thread) =>
        !allowed || allowed.has(thread.meetingId) ? reconcileChatAfterRestart(thread, this.now()) : thread);
      return state.chatThreads.map((thread) => structuredClone(thread));
    });
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

  deleteMeeting(meetingId: string, input: MeetingDeleteInput = {}): Promise<MeetingDeleteStoreResult> {
    const operation = this.mutationTail.then(async () => {
      const state = await this.readState();
      const meeting = state.meetings.find((candidate) => candidate.id === meetingId);
      if (!meeting) return { meetingId, outcome: "not_found" as const, reason: null };

      const recordings = state.recordings.filter((recording) => recording.meetingId === meetingId);
      const unsafeRecording = recordings.find((recording) =>
        ["recording", "interrupted", "recoverable"].includes(recording.status));
      if (unsafeRecording) {
        return {
          meetingId,
          outcome: "refused" as const,
          reason: unsafeRecording.finalization ? "finalization" as const : "active_capture" as const,
        };
      }
      if (recordings.some((recording) => recording.status === "finalizing")) {
        return { meetingId, outcome: "refused" as const, reason: "finalization" as const };
      }
      if (state.transcripts.some((transcript) => transcript.meetingId === meetingId &&
        (transcript.status === "pending" || transcript.status === "transcribing"))) {
        return { meetingId, outcome: "refused" as const, reason: "transcription" as const };
      }
      if (state.chatThreads.some((thread) => thread.meetingId === meetingId && thread.status === "running")) {
        return { meetingId, outcome: "refused" as const, reason: "ask" as const };
      }

      const operationId = randomUUID();
      const entries = await this.deletionOwnedEntries(state, meetingId, input);
      const unsigned = {
        version: 1 as const,
        operationId,
        meetingId,
        entries: entries.map((entry) => ({ ...entry,
          quarantine: path.join(path.dirname(entry.original), `.${path.basename(entry.original)}.meetless-delete-${operationId}`),
        })),
      };
      const manifest: DeletionManifest = { ...unsigned, integritySha256: manifestIntegrity(unsigned) };
      const manifestPath = await this.writeDeletionManifest(manifest);
      const staged: DeletionManifest["entries"] = [];
      try {
        for (const entry of manifest.entries) {
          try {
            await this.assertSafeDeletionEntry(entry, false);
            await this.deletionIo.rename(entry.original, entry.quarantine);
            staged.push(entry);
            await this.deletionIo.syncDirectory(path.dirname(entry.original));
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
          }
        }
        state.chatThreads = state.chatThreads.filter((thread) => thread.meetingId !== meetingId);
        state.transcripts = state.transcripts.filter((transcript) => transcript.meetingId !== meetingId);
        const recordingIds = new Set(recordings.map((recording) => recording.id));
        state.recordings = state.recordings.filter((recording) => !recordingIds.has(recording.id));
        state.meetings = state.meetings.filter((candidate) => candidate.id !== meetingId);
        await this.replaceState(state);
      } catch (error) {
        if (!(error instanceof MeetingStateReplacementError) || !error.replaced) {
          await this.restoreDeletionEntries(staged);
          await this.removeDeletionManifest(manifestPath);
        }
        throw error;
      }
      await this.finishDeletionManifest(manifestPath, manifest).catch(() => undefined);
      return { meetingId, outcome: "deleted" as const, reason: null };
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
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

  prepareInventoryRecovery(id: string, reason: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      prepareRecordingInventoryRecovery(recording, { now: this.now(), reason }),
    );
  }

  markInventoryScanning(id: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) => markRecordingInventoryScanning(recording, this.now()));
  }

  publishInventory(id: string, pointer: RecordingInventoryPointer): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      publishRecordingInventory(recording, { now: this.now(), pointer }),
    );
  }

  blockInventory(id: string, reason: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      blockRecordingInventory(recording, { now: this.now(), reason }),
    );
  }

  failInventoryWithNoValidMedia(id: string, reason: string): Promise<RecordingSession> {
    return this.changeRecording(id, (recording) =>
      failRecordingWithNoValidMedia(recording, { now: this.now(), reason }),
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

  async cleanupEligibleInventory(
    id: string,
    verification: { destination: string; identity: OutputIdentity; readable: boolean },
  ): Promise<{ pointer: RecordingInventoryPointer | null; legacyChunks: CommittedRecordingChunk[] }> {
    await this.mutationTail;
    const state = await this.readState();
    const recording = state.recordings[this.recordingIndex(state, id)]!;
    assertCleanupEligible(recording, verification);
    return {
      pointer: recording.inventory.pointer ? { ...recording.inventory.pointer } : null,
      legacyChunks: recording.chunks.map((chunk) => ({ ...chunk })),
    };
  }

  private changeTranscript(
    id: string,
    change: (transcript: TranscriptState) => TranscriptState,
  ): Promise<TranscriptState> {
    return this.mutate(async (state) => {
      const index = this.transcriptIndex(state, id);
      const next = change(state.transcripts[index]!);
      state.transcripts[index] = next;
      return structuredClone(next);
    });
  }

  private changeChatThread(
    meetingId: string,
    change: (state: MeetingState, thread: MeetingChatThread) => Promise<MeetingChatThread>,
  ): Promise<MeetingChatThread> {
    return this.mutate(async (state) => {
      const index = state.chatThreads.findIndex((thread) => thread.meetingId === meetingId);
      if (index < 0) throw new Error(`Chat thread not found for meeting: ${meetingId}`);
      const next = await change(state, state.chatThreads[index]!);
      state.chatThreads[index] = next;
      return structuredClone(next);
    });
  }

  private chatTranscript(state: MeetingState, thread: MeetingChatThread): TranscriptState {
    const transcript = state.transcripts.find((candidate) => candidate.meetingId === thread.meetingId);
    if (!transcript || transcript.status !== "ready" || !transcript.publication) {
      throw new MeetingStoreCorruptError(
        this.filePath,
        new Error(`Chat thread ${thread.id} requires the immutable ready transcript for meeting ${thread.meetingId}`),
      );
    }
    return transcript;
  }

  private transcriptSegmentIds(transcript: TranscriptState): string[] {
    return transcript.checkpoints.map((checkpoint) => checkpoint.range.segmentId);
  }

  private transcriptIndex(state: MeetingState, id: string): number {
    const index = state.transcripts.findIndex((transcript) => transcript.id === id);
    if (index < 0) throw new Error(`Transcript not found: ${id}`);
    return index;
  }

  private transcriptSidecarPath(transcript: TranscriptState): string {
    return path.join(this.root, "transcripts", `${transcript.id}.json`);
  }

  private transcriptSidecarPayload(transcript: TranscriptState, publishedAt: string) {
    return {
      version: 1 as const,
      transcriptId: transcript.id,
      meetingId: transcript.meetingId,
      recordingId: transcript.recordingId,
      plannerVersion: transcript.plannerVersion,
      audio: transcript.audio,
      ranges: transcript.ranges,
      segments: transcript.checkpoints.map((checkpoint) => ({ range: checkpoint.range, text: checkpoint.text })),
      usage: transcript.usage,
      detectedLanguages: transcript.detectedLanguages,
      publishedAt,
    };
  }

  private async writeTranscriptSidecar(transcript: TranscriptState): Promise<TranscriptPublication> {
    const publishedAt = this.now();
    const payload = TranscriptSidecarSchema.parse(this.transcriptSidecarPayload(transcript, publishedAt));
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const sidecarPath = this.transcriptSidecarPath(transcript);
    let publicationBytes = bytes;
    let publicationTime = publishedAt;
    await mkdir(path.dirname(sidecarPath), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(sidecarPath);
      const existingPayload = TranscriptSidecarSchema.parse(JSON.parse(existing.toString("utf8")));
      const expectedExistingPayload = { ...payload, publishedAt: existingPayload.publishedAt };
      if (JSON.stringify(existingPayload) !== JSON.stringify(expectedExistingPayload)) {
        throw new MeetingStoreCorruptError(sidecarPath, new Error("Transcript publication sidecar is immutable and differs from the requested publication"));
      }
      // A crash can leave the immutable sidecar ahead of the state file. Reuse
      // its original publication time and bytes so reconciliation is idempotent.
      publicationBytes = existing;
      publicationTime = existingPayload.publishedAt;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const temporaryPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
      let temporaryCreated = false;
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, sidecarPath);
        temporaryCreated = false;
        await syncDirectory(path.dirname(sidecarPath));
      } finally {
        if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    const identity = { byteLength: publicationBytes.byteLength, sha256: createHash("sha256").update(publicationBytes).digest("hex") };
    return { storageKey: path.relative(this.root, sidecarPath), ...identity, publishedAt: publicationTime };
  }

  private async readTranscriptSidecarIfPresent(transcript: TranscriptState): Promise<z.infer<typeof TranscriptSidecarSchema> | null> {
    try {
      const bytes = await readFile(this.transcriptSidecarPath(transcript));
      const parsed = TranscriptSidecarSchema.parse(JSON.parse(bytes.toString("utf8")));
      const identity = await fileIdentity(this.transcriptSidecarPath(transcript));
      if (parsed.transcriptId !== transcript.id || identity.byteLength !== bytes.byteLength) return null;
      return parsed;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw new MeetingStoreCorruptError(this.transcriptSidecarPath(transcript), error);
    }
  }

  private async transcriptPublicationForSidecar(
    transcript: TranscriptState,
    sidecar: z.infer<typeof TranscriptSidecarSchema>,
  ): Promise<TranscriptPublication> {
    const sidecarPath = this.transcriptSidecarPath(transcript);
    const identity = await fileIdentity(sidecarPath);
    return { storageKey: path.relative(this.root, sidecarPath), ...identity, publishedAt: sidecar.publishedAt };
  }

  private async assertTranscriptSidecar(transcript: TranscriptState): Promise<void> {
    if (!transcript.publication) throw new MeetingStoreCorruptError(this.filePath, new Error(`Ready transcript ${transcript.id} has no publication identity`));
    const sidecarPath = this.transcriptSidecarPath(transcript);
    const identity = await fileIdentity(sidecarPath).catch((error) => {
      throw new MeetingStoreCorruptError(sidecarPath, error);
    });
    if (
      identity.byteLength !== transcript.publication.byteLength ||
      identity.sha256 !== transcript.publication.sha256 ||
      path.relative(this.root, sidecarPath) !== transcript.publication.storageKey
    ) {
      throw new MeetingStoreCorruptError(sidecarPath, new Error("Transcript publication identity changed"));
    }
    const parsed = await this.readTranscriptSidecarIfPresent(transcript);
    if (!parsed || !this.transcriptSidecarMatches(transcript, parsed)) {
      throw new MeetingStoreCorruptError(sidecarPath, new Error("Transcript publication sidecar is incomplete"));
    }
  }

  private transcriptSidecarMatches(
    transcript: TranscriptState,
    sidecar: z.infer<typeof TranscriptSidecarSchema>,
  ): boolean {
    return JSON.stringify(sidecar) === JSON.stringify(
      this.transcriptSidecarPayload(transcript, sidecar.publishedAt),
    );
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
      if (isErrno(error, "ENOENT")) {
        const empty = { version: 4 as const, meetings: [], recordings: [], transcripts: [], cloudConsent: null, chatThreads: [] };
        await this.reconcileDeletionManifests(empty);
        return empty;
      }
      throw error;
    }
    try {
      const decoded: unknown = JSON.parse(contents);
      const v1 = StateV1Schema.safeParse(decoded);
      if (v1.success) return await this.withDeletionRecovery({ version: 4, meetings: v1.data.meetings, recordings: [], transcripts: [], cloudConsent: null, chatThreads: [] });
      const v2 = MeetingStateV2Schema.safeParse(decoded);
      if (v2.success) return await this.withDeletionRecovery(migrateV2(v2.data));
      const v3 = StateV3Schema.safeParse(decoded);
      if (v3.success) return await this.withDeletionRecovery({
        version: 4,
        meetings: v3.data.meetings,
        recordings: v3.data.recordings,
        transcripts: v3.data.transcripts ?? [],
        cloudConsent: v3.data.cloudConsent ?? null,
        chatThreads: [],
      });
      const parsed = MeetingStateSchema.parse(decoded);
      return await this.withDeletionRecovery({
        version: 4,
        meetings: parsed.meetings,
        recordings: parsed.recordings,
        transcripts: parsed.transcripts ?? [],
        cloudConsent: parsed.cloudConsent ?? null,
        chatThreads: parsed.chatThreads ?? [],
      });
    } catch (error) {
      throw new MeetingStoreCorruptError(this.filePath, error);
    }
  }

  private async deletionOwnedEntries(
    state: MeetingState,
    meetingId: string,
    input: MeetingDeleteInput,
  ): Promise<Array<Omit<DeletionManifest["entries"][number], "quarantine">>> {
    const recordings = state.recordings.filter((recording) => recording.meetingId === meetingId);
    const recordingIds = new Set(recordings.map((recording) => recording.id));
    const entries: Array<Omit<DeletionManifest["entries"][number], "quarantine">> = [];
    for (const recording of recordings) {
      entries.push({
        kind: "session", ownerId: recording.id, approvedRoot: this.root,
        original: path.join(this.root, "sessions", recording.id),
      });
      for (const output of [recording.savedOutput?.destination, recording.finalization?.publishIntent.destination]) {
        if (!output) continue;
        entries.push({
          kind: "output", ownerId: recording.id,
          approvedRoot: this.approvedRootFor(path.resolve(output), [this.root, ...this.approvedExportRoots]),
          original: path.resolve(output),
        });
      }
    }
    for (const transcript of state.transcripts.filter((candidate) => candidate.meetingId === meetingId)) {
      if (!transcript.publication) continue;
      const expected = this.transcriptSidecarPath(transcript);
      if (path.resolve(this.root, transcript.publication.storageKey) !== expected) {
        throw new Error(`Transcript ${transcript.id} deletion path does not match its exact owned sidecar`);
      }
      entries.push({ kind: "transcript", ownerId: transcript.id, approvedRoot: this.root, original: expected });
    }
    for (const stage of input.recordingStagePaths ?? []) {
      if (!recordingIds.has(stage.recordingId)) {
        throw new Error(`Stage path is not owned by meeting ${meetingId}: ${stage.recordingId}`);
      }
      const original = path.resolve(stage.path);
      const approvedRoot = this.approvedRootFor(original, this.approvedExportRoots);
      if (!isExactRecordingStageName(path.basename(original), stage.recordingId)) {
        throw new Error(`Stage path is not an exact recording-owned .stage file: ${stage.path}`);
      }
      entries.push({ kind: "stage", ownerId: stage.recordingId, approvedRoot, original });
    }
    const unique = deduplicateDeletionEntries(entries);
    this.assertNoSharedDeletionPaths(state, meetingId, unique);
    for (const entry of unique) await this.assertSafeDeletionEntry(entry, false);
    return unique.filter((entry) => !unique.some((parent) =>
      parent.original !== entry.original && parent.kind === "session" && isPathInside(parent.original, entry.original)));
  }

  private async writeDeletionManifest(manifest: DeletionManifest): Promise<string> {
    const directory = path.join(this.root, ".deletions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(directory, `${manifest.operationId}.json`);
    const temporaryPath = path.join(directory, `.${manifest.operationId}.${randomUUID()}.tmp`);
    let published = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await this.deletionIo.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.deletionIo.rename(temporaryPath, manifestPath);
      published = true;
      await this.deletionIo.syncDirectory(directory);
      return manifestPath;
    } catch (error) {
      await this.deletionIo.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (published) await this.deletionIo.rm(manifestPath, { force: true }).catch(() => undefined);
      await this.deletionIo.syncDirectory(directory).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await this.deletionIo.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withDeletionRecovery(state: MeetingState): Promise<MeetingState> {
    await this.reconcileDeletionManifests(state);
    return state;
  }

  private async reconcileDeletionManifests(state: MeetingState): Promise<void> {
    const directory = path.join(this.root, ".deletions");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const manifestPath = path.join(directory, name);
      let manifest: DeletionManifest;
      try {
        manifest = DeletionManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        this.assertDeletionManifestPaths(manifest);
        if (manifest.integritySha256 !== manifestIntegrity({
          version: manifest.version, operationId: manifest.operationId, meetingId: manifest.meetingId, entries: manifest.entries,
        })) throw new Error("Deletion manifest integrity check failed");
        for (const entry of manifest.entries) await this.assertSafeDeletionEntry(entry, true);
        this.assertDeletionManifestOwnership(state, manifest);
      } catch (error) {
        throw new MeetingStoreCorruptError(manifestPath, error);
      }
      if (state.meetings.some((meeting) => meeting.id === manifest.meetingId)) {
        await this.restoreDeletionEntries(manifest.entries);
        await this.removeDeletionManifest(manifestPath);
      } else {
        await this.finishDeletionManifest(manifestPath, manifest);
      }
    }
    let removedDirectory = false;
    await rmdir(directory).then(() => { removedDirectory = true; }).catch((error) => {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
    });
    if (removedDirectory) await this.deletionIo.syncDirectory(this.root);
  }

  private assertDeletionManifestPaths(manifest: DeletionManifest): void {
    for (const entry of manifest.entries) {
      if (!path.isAbsolute(entry.original) || !path.isAbsolute(entry.quarantine)) {
        throw new Error("Deletion manifest paths must be absolute");
      }
      const expected = path.join(
        path.dirname(entry.original),
        `.${path.basename(entry.original)}.meetless-delete-${manifest.operationId}`,
      );
      if (entry.quarantine !== expected) throw new Error("Deletion manifest quarantine path is invalid");
      if (path.resolve(entry.original) !== entry.original || path.resolve(entry.approvedRoot) !== entry.approvedRoot) {
        throw new Error("Deletion manifest paths must be normalized");
      }
      const approvedRoots = entry.kind === "session" || entry.kind === "transcript"
        ? [this.root]
        : [this.root, ...this.approvedExportRoots];
      if (!approvedRoots.includes(entry.approvedRoot)) throw new Error("Deletion manifest root is not approved");
    }
  }

  private async restoreDeletionEntries(entries: DeletionManifest["entries"]): Promise<void> {
    for (const entry of [...entries].reverse()) {
      try {
        await this.deletionIo.rename(entry.quarantine, entry.original);
        await this.deletionIo.syncDirectory(path.dirname(entry.original));
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }

  private async finishDeletionManifest(manifestPath: string, manifest: DeletionManifest): Promise<void> {
    for (const entry of manifest.entries) {
      try {
        await lstat(entry.quarantine);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      await this.deletionIo.rm(entry.quarantine, { recursive: entry.kind === "session", force: true });
      await this.deletionIo.syncDirectory(path.dirname(entry.quarantine));
    }
    await this.removeDeletionManifest(manifestPath);
  }

  private async removeDeletionManifest(manifestPath: string): Promise<void> {
    await this.deletionIo.rm(manifestPath, { force: true });
    await this.deletionIo.syncDirectory(path.dirname(manifestPath));
  }

  private approvedRootFor(candidate: string, roots: readonly string[]): string {
    const root = roots.find((approved) => isPathInside(approved, candidate));
    if (!root) {
      throw new Error(`Deletion path is outside approved store/export roots: ${candidate}`);
    }
    return root;
  }

  private async assertSafeDeletionEntry(
    entry: Omit<DeletionManifest["entries"][number], "quarantine"> | DeletionManifest["entries"][number],
    recovery: boolean,
  ): Promise<void> {
    if (!isPathInside(entry.approvedRoot, entry.original)) {
      throw new Error(`Deletion path escapes approved root: ${entry.original}`);
    }
    if ((entry.kind === "session" && entry.original !== path.join(this.root, "sessions", entry.ownerId)) ||
      (entry.kind === "transcript" && entry.original !== path.join(this.root, "transcripts", `${entry.ownerId}.json`)) ||
      (entry.kind === "stage" && !isExactRecordingStageName(path.basename(entry.original), entry.ownerId))) {
      throw new Error(`Deletion path does not match exact meeting ownership: ${entry.original}`);
    }
    const rootReal = await realpath(entry.approvedRoot);
    const candidatePath = recovery && "quarantine" in entry ? entry.quarantine : entry.original;
    const candidateReal = await realExistingPathOrAncestor(candidatePath);
    if (!isPathInside(rootReal, candidateReal) && candidateReal !== rootReal) {
      throw new Error(`Deletion path has symlink ancestry outside approved root: ${candidatePath}`);
    }
    try {
      const info = await lstat(candidatePath);
      if (info.isSymbolicLink()) throw new Error(`Deletion target cannot be a symlink: ${candidatePath}`);
      if (entry.kind === "session" ? !info.isDirectory() : !info.isFile()) {
        throw new Error(`Deletion target has an invalid file type: ${candidatePath}`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  private assertNoSharedDeletionPaths(
    state: MeetingState,
    meetingId: string,
    entries: ReadonlyArray<Omit<DeletionManifest["entries"][number], "quarantine">>,
  ): void {
    const owned = new Set(entries.map((entry) => entry.original));
    for (const recording of state.recordings.filter((candidate) => candidate.meetingId !== meetingId)) {
      const paths = [
        path.join(this.root, "sessions", recording.id),
        recording.savedOutput?.destination,
        recording.finalization?.publishIntent.destination,
      ].filter((candidate): candidate is string => Boolean(candidate)).map((candidate) => path.resolve(candidate));
      const shared = paths.find((candidate) => owned.has(candidate));
      if (shared) throw new Error(`Deletion path is shared with meeting ${recording.meetingId}: ${shared}`);
    }
    for (const transcript of state.transcripts.filter((candidate) => candidate.meetingId !== meetingId && candidate.publication)) {
      const shared = path.resolve(this.root, transcript.publication!.storageKey);
      if (owned.has(shared)) throw new Error(`Deletion path is shared with meeting ${transcript.meetingId}: ${shared}`);
    }
  }

  private assertDeletionManifestOwnership(state: MeetingState, manifest: DeletionManifest): void {
    const meetingExists = state.meetings.some((meeting) => meeting.id === manifest.meetingId);
    if (!meetingExists) return;
    const recordingIds = new Set(state.recordings
      .filter((recording) => recording.meetingId === manifest.meetingId).map((recording) => recording.id));
    const transcriptIds = new Set(state.transcripts
      .filter((transcript) => transcript.meetingId === manifest.meetingId).map((transcript) => transcript.id));
    for (const entry of manifest.entries) {
      if ((entry.kind === "session" || entry.kind === "output" || entry.kind === "stage") && !recordingIds.has(entry.ownerId)) {
        throw new Error(`Deletion manifest entry is not owned by meeting ${manifest.meetingId}`);
      }
      if (entry.kind === "transcript" && !transcriptIds.has(entry.ownerId)) {
        throw new Error(`Deletion manifest transcript is not owned by meeting ${manifest.meetingId}`);
      }
      if (entry.kind === "output") {
        const recording = state.recordings.find((candidate) => candidate.id === entry.ownerId);
        const exactOutputs = [recording?.savedOutput?.destination, recording?.finalization?.publishIntent.destination]
          .filter((candidate): candidate is string => Boolean(candidate)).map((candidate) => path.resolve(candidate));
        if (!exactOutputs.includes(entry.original)) {
          throw new Error(`Deletion manifest output is not exactly owned by recording ${entry.ownerId}`);
        }
      }
    }
    this.assertNoSharedDeletionPaths(state, manifest.meetingId, manifest.entries);
  }

  private async writeState(state: MeetingState): Promise<void> {
    const checked = MeetingStateSchema.parse({
      version: state.version,
      meetings: state.meetings,
      recordings: state.recordings,
      ...(state.transcripts.length > 0 ? { transcripts: state.transcripts } : {}),
      ...(state.cloudConsent ? { cloudConsent: state.cloudConsent } : {}),
      ...(state.chatThreads.length > 0 ? { chatThreads: state.chatThreads } : {}),
    });
    await this.replaceStateBytes(`${JSON.stringify(checked, null, 2)}\n`);
  }

  private async replaceState(state: MeetingState): Promise<void> {
    const checked = MeetingStateSchema.parse({
      version: state.version,
      meetings: state.meetings,
      recordings: state.recordings,
      ...(state.transcripts.length > 0 ? { transcripts: state.transcripts } : {}),
      ...(state.cloudConsent ? { cloudConsent: state.cloudConsent } : {}),
      ...(state.chatThreads.length > 0 ? { chatThreads: state.chatThreads } : {}),
    });
    await this.replaceStateBytes(`${JSON.stringify(checked, null, 2)}\n`);
  }

  private async replaceStateBytes(contents: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.root, `.meetings.${process.pid}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    let replaced = false;
    try {
      const handle = await this.deletionIo.open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.deletionIo.rename(temporaryPath, this.filePath);
      replaced = true;
      temporaryCreated = false;
      await this.deletionIo.syncDirectory(this.root);
    } catch (error) {
      throw new MeetingStateReplacementError(replaced, error);
    } finally {
      if (temporaryCreated) await this.deletionIo.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function deduplicateDeletionEntries(
  entries: ReadonlyArray<Omit<DeletionManifest["entries"][number], "quarantine">>,
): Array<Omit<DeletionManifest["entries"][number], "quarantine">> {
  const byPath = new Map<string, Omit<DeletionManifest["entries"][number], "quarantine">>();
  for (const entry of entries) {
    const existing = byPath.get(entry.original);
    if (existing && (existing.kind !== entry.kind || existing.ownerId !== entry.ownerId)) {
      throw new Error(`Deletion path has more than one owner: ${entry.original}`);
    }
    byPath.set(entry.original, entry);
  }
  return [...byPath.values()];
}

function manifestIntegrity(manifest: Omit<DeletionManifest, "integritySha256">): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function isExactRecordingStageName(name: string, recordingId: string): boolean {
  const escaped = recordingId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^\\.meetless-${escaped}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-(?:microphone|system)\\.wav|\\.mp3)\\.stage$`,
    "u",
  ).test(name);
}

async function realExistingPathOrAncestor(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return current === candidate ? resolved : path.join(resolved, path.relative(current, candidate));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileIdentity(filePath: string): Promise<{ byteLength: number; sha256: string }> {
  const [bytes, before] = await Promise.all([readFile(filePath), stat(filePath)]);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
    throw new Error(`Transcript sidecar changed while being read: ${filePath}`);
  }
  return { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function migrateV2(state: z.infer<typeof MeetingStateV2Schema>): MeetingState {
  return {
    version: 4,
    meetings: state.meetings,
    transcripts: [],
    cloudConsent: null,
    chatThreads: [],
    recordings: state.recordings.map((recording) => {
      const microphoneCount = recording.chunks.filter((chunk) => chunk.source === "microphone").length;
      const systemCount = recording.chunks.length - microphoneCount;
      const interruptedAt = recording.interruption?.interruptedAt ?? recording.updatedAt;
      const wasFinalizing = recording.status === "finalizing";
      return {
        ...recording,
        status: wasFinalizing ? "recoverable" as const : recording.status,
        activeSince: wasFinalizing ? null : recording.activeSince,
        interruption: wasFinalizing
          ? { reason: "Migrated unfinished finalization requires inventory reconciliation", interruptedAt }
          : recording.interruption,
        inventory: {
          state: "pending" as const,
          knownChunkCount: recording.chunks.length,
          microphoneCount,
          systemCount,
          pointer: null,
          error: null,
        },
        finalization: recording.finalization ? {
          chunkSetDigest: recording.finalization.chunkSetDigest,
          chunkCount: recording.finalization.chunkIds.length,
          publishIntent: recording.finalization.publishIntent,
        } : null,
      };
    }),
  };
}
