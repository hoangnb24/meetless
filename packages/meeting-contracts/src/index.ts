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

export const TranscriptRangeWireSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  segmentId: z.string().trim().min(1),
}).strict().superRefine((range, context) => {
  if (range.endMs <= range.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "Transcript ranges are half-open and non-empty" });
});

export const TranscriptUsageWireSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
}).strict();

export const TranscriptSegmentWireSchema = z.object({
  range: TranscriptRangeWireSchema,
  text: z.string(),
  completedAt: z.string().datetime(),
  detectedLanguages: z.array(z.string().trim().min(1)),
}).strict();

export const TranscriptWireSchema = z.object({
  id: z.string().trim().min(1),
  meetingId: z.string().trim().min(1),
  recordingId: z.string().trim().min(1),
  status: z.enum(["pending", "transcribing", "ready", "failed"]),
  plannerVersion: z.literal("m3-range-v1"),
  audioDurationMs: z.number().int().positive(),
  ranges: z.array(TranscriptRangeWireSchema).min(1),
  segments: z.array(TranscriptSegmentWireSchema),
  requestCount: z.number().int().nonnegative(),
  usage: TranscriptUsageWireSchema.nullable(),
  detectedLanguages: z.array(z.string().trim().min(1)),
  failureReason: z.string().trim().min(1).nullable(),
}).strict();

export type TranscriptWire = z.infer<typeof TranscriptWireSchema>;

export const TranscriptionConsentWireSchema = z.object({
  status: z.enum(["unknown", "granted"]),
  grantedAt: z.string().datetime().optional(),
}).strict().superRefine((consent, context) => {
  if (consent.status === "granted" && !consent.grantedAt) context.addIssue({ code: "custom", path: ["grantedAt"], message: "Granted consent requires a durable timestamp" });
  if (consent.status === "unknown" && consent.grantedAt) context.addIssue({ code: "custom", path: ["grantedAt"], message: "Unknown consent cannot expose a grant timestamp" });
});

export const TranscriptionProviderStatusWireSchema = z.object({
  status: z.enum(["configured", "missing", "invalid"]),
}).strict();

export type TranscriptionProviderStatusWire = z.infer<typeof TranscriptionProviderStatusWireSchema>;

export const MeetingTranscriptRpc = defineRpc({
  name: "meeting.transcript",
  input: z.object({ meetingId: z.string().trim().min(1) }).strict(),
  output: z.object({
    meeting: MeetingWireSchema,
    transcript: TranscriptWireSchema.nullable(),
    consent: TranscriptionConsentWireSchema,
    provider: TranscriptionProviderStatusWireSchema,
  }).strict(),
});

export const MeetingTranscriptionConsentRpc = defineRpc({
  name: "meeting.transcription.consent",
  input: z.object({ accepted: z.literal(true) }).strict(),
  output: z.object({
    consent: TranscriptionConsentWireSchema,
    provider: TranscriptionProviderStatusWireSchema,
  }).strict(),
});

export const MeetingCitationResolveRpc = defineRpc({
  name: "meeting.citation.resolve",
  input: z.object({ meetingId: z.string().trim().min(1), segmentId: z.string().trim().min(1) }).strict(),
  output: z.object({
    meetingId: z.string().trim().min(1),
    recordingId: z.string().trim().min(1),
    segmentId: z.string().trim().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string(),
    audio: z.object({
      mimeType: z.literal("audio/mpeg"),
      base64: z.string().min(1).max(3_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    }).strict(),
  }).strict().superRefine((citation, context) => {
    if (citation.endMs <= citation.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "Citation playback interval must be bounded" });
  }),
});

export type CitationWire = z.infer<typeof MeetingCitationResolveRpc.output>;

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
