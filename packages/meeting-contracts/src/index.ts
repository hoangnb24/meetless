import { defineRpc } from "@paseo/plugin";
import { z } from "zod";

export const MeetingWireSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: z.enum(["draft", "recording", "processing", "ready", "archived"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MeetingWire = z.infer<typeof MeetingWireSchema>;

export const MeetingCreateRpc = defineRpc({
  name: "meeting.create",
  input: z.object({ title: z.string().trim().min(1).max(200) }).strict(),
  output: MeetingWireSchema,
});

export const MeetingListRpc = defineRpc({
  name: "meeting.list",
  input: z.object({}).strict(),
  output: z.object({ meetings: z.array(MeetingWireSchema) }).strict(),
});

export const RecordingChunkWireSchema = z.object({
  id: z.string().trim().min(1),
  source: z.enum(["microphone", "system"]),
  storageKey: z.string().trim().min(1),
  byteLength: z.number().int().positive(),
  sha256: z.string().trim().min(1),
  committedAt: z.string().datetime(),
  logicalStartMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  format: z.literal("wav"),
}).strict();

export const RecordingStatusWireSchema = z.object({
  status: z.enum(["idle", "recording", "interrupted", "recoverable", "finalizing", "saved", "failed"]),
  recordingId: z.string().trim().min(1).nullable(),
  meetingId: z.string().trim().min(1).nullable(),
  title: z.string().trim().min(1).nullable(),
  elapsedMs: z.number().int().nonnegative(),
  paused: z.boolean(),
  chunks: z.array(RecordingChunkWireSchema).max(4),
  inventoryState: z.enum(["pending", "scanning", "complete", "blocked"]).nullable(),
  chunkCount: z.number().int().nonnegative(),
  microphoneCount: z.number().int().nonnegative(),
  systemCount: z.number().int().nonnegative(),
  inventoryDigest: z.string().trim().min(1).nullable(),
  retryEligible: z.boolean(),
  outputPath: z.string().trim().min(1).nullable(),
  error: z.string().trim().min(1).nullable(),
}).strict();

export type RecordingStatusWire = z.infer<typeof RecordingStatusWireSchema>;

export const RecordingControlRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  command: z.enum(["start", "status", "pause", "resume", "stop", "retryFinalization"]),
  title: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((request, context) => {
  if (request.command === "start" && !request.title) {
    context.addIssue({ code: "custom", path: ["title"], message: "start requires a meeting title" });
  }
  if (request.command !== "start" && request.title !== undefined) {
    context.addIssue({ code: "custom", path: ["title"], message: "title is allowed only for start" });
  }
});

export type RecordingControlRequest = z.infer<typeof RecordingControlRequestSchema>;

export const RecordingControlResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  ok: z.boolean(),
  status: RecordingStatusWireSchema,
  error: z.string().trim().min(1).nullable(),
}).strict();

export type RecordingControlResponse = z.infer<typeof RecordingControlResponseSchema>;

export const RecordingStatusEventSchema = z.object({
  version: z.literal(1),
  type: z.literal("recording.status"),
  status: RecordingStatusWireSchema,
}).strict();

export type RecordingStatusEvent = z.infer<typeof RecordingStatusEventSchema>;
