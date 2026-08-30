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

export const MeetingDeleteResultSchema = z.object({
  meetingId: z.string().trim().min(1),
  outcome: z.enum(["deleted", "not_found", "refused"]),
  reason: z.enum(["active_capture", "finalization", "transcription", "ask"]).nullable(),
}).strict().superRefine((result, context) => {
  if (result.outcome === "refused" && result.reason === null) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Refused deletion requires an active-work reason" });
  }
  if (result.outcome !== "refused" && result.reason !== null) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Only refused deletion can include a reason" });
  }
});

export type MeetingDeleteResultWire = z.infer<typeof MeetingDeleteResultSchema>;

export const MeetingDeleteRpc = defineRpc({
  name: "meeting.delete",
  input: z.object({ meetingId: z.string().trim().min(1) }).strict(),
  output: MeetingDeleteResultSchema,
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

export const PremiumPackageWireSchema = z.object({
  packageId: z.enum(["monthly", "annual"]),
  productId: z.string().trim().min(1),
  localizedPrice: z.string().trim().min(1),
  trialEligible: z.boolean(),
}).strict();

export type PremiumPackageWire = z.infer<typeof PremiumPackageWireSchema>;

export const PremiumAccessWireSchema = z.object({
  entitlement: z.literal("premium"),
  status: z.enum(["active", "inactive", "unavailable"]),
  packages: z.array(PremiumPackageWireSchema),
  reason: z.enum(["not_configured", "store_unavailable"]).nullable(),
}).strict().superRefine((access, context) => {
  if (access.status === "unavailable" && access.reason === null) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Unavailable Premium status requires a redacted reason" });
  }
  if (access.status !== "unavailable" && access.reason !== null) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Only unavailable Premium status can include a reason" });
  }
});

export type PremiumAccessWire = z.infer<typeof PremiumAccessWireSchema>;

export const PremiumMutationResultWireSchema = z.object({
  outcome: z.enum(["active", "cancelled", "pending", "failed"]),
  access: PremiumAccessWireSchema,
}).strict();

export type PremiumMutationResultWire = z.infer<typeof PremiumMutationResultWireSchema>;

export const MeetingPremiumStatusRpc = defineRpc({
  name: "meeting.premium.status",
  input: z.object({}).strict(),
  output: PremiumAccessWireSchema,
});

export const MeetingPremiumPurchaseRpc = defineRpc({
  name: "meeting.premium.purchase",
  input: z.object({ packageId: z.enum(["monthly", "annual"]) }).strict(),
  output: PremiumMutationResultWireSchema,
});

export const MeetingPremiumRestoreRpc = defineRpc({
  name: "meeting.premium.restore",
  input: z.object({}).strict(),
  output: PremiumMutationResultWireSchema,
});

export const ChatProviderModelWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  isDefault: z.boolean(),
}).strict();

export const ChatProviderWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  models: z.array(ChatProviderModelWireSchema).min(1),
}).strict();

export type ChatProviderWire = z.infer<typeof ChatProviderWireSchema>;

const ChatFeatureValueSchema = z.union([z.boolean(), z.string(), z.null()]);

export const ChatSelectionWireSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  modeId: z.string().trim().min(1).nullable(),
  thinkingOptionId: z.string().trim().min(1).nullable(),
  featureValues: z.record(z.string().trim().min(1), ChatFeatureValueSchema),
}).strict();

export type ChatSelectionWire = z.infer<typeof ChatSelectionWireSchema>;

export function chatSelectionIdentity(selection: ChatSelectionWire): string {
  const features = Object.entries(selection.featureValues)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    selection.provider,
    selection.model,
    selection.modeId,
    selection.thinkingOptionId,
    features,
  ]);
}

export const ChatThinkingOptionWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict();

export type ChatThinkingOptionWire = z.infer<typeof ChatThinkingOptionWireSchema>;

export const ChatModeWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict();

export type ChatModeWire = z.infer<typeof ChatModeWireSchema>;

export const ChatControlModelWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  isDefault: z.boolean(),
  thinkingOptions: z.array(ChatThinkingOptionWireSchema),
  defaultThinkingOptionId: z.string().trim().min(1).nullable(),
}).strict();

export type ChatControlModelWire = z.infer<typeof ChatControlModelWireSchema>;

export const ChatControlProviderWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  models: z.array(ChatControlModelWireSchema),
  modes: z.array(ChatModeWireSchema),
  defaultModeId: z.string().trim().min(1).nullable(),
  error: z.string().trim().min(1).nullable(),
}).strict();

export type ChatControlProviderWire = z.infer<typeof ChatControlProviderWireSchema>;

export const ChatControlsCatalogWireSchema = z.object({
  providers: z.array(ChatControlProviderWireSchema),
}).strict();

export type ChatControlsCatalogWire = z.infer<typeof ChatControlsCatalogWireSchema>;

export const ChatProfileWireSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  icon: z.string().trim().min(1).nullable(),
  color: z.string().trim().min(1).nullable(),
  selection: ChatSelectionWireSchema,
}).strict();

export type ChatProfileWire = z.infer<typeof ChatProfileWireSchema>;

export const ChatCapabilityErrorWireSchema = z.object({
  kind: z.enum(["unavailable", "update_required", "repair_required"]),
  message: z.string().trim().min(1),
}).strict();

export type ChatCapabilityErrorWire = z.infer<typeof ChatCapabilityErrorWireSchema>;

export const ChatControlsWireSchema = z.object({
  version: z.literal(1),
  catalog: ChatControlsCatalogWireSchema,
  profiles: z.array(ChatProfileWireSchema),
  catalogError: ChatCapabilityErrorWireSchema.nullable(),
  lastSelection: ChatSelectionWireSchema.nullable(),
  lastSelectionState: z.enum(["available", "unavailable", "repair_required"]),
  lastSelectionError: ChatCapabilityErrorWireSchema.nullable(),
}).strict();

export type ChatControlsWire = z.infer<typeof ChatControlsWireSchema>;

const ChatFeatureBaseWireSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().optional(),
  tooltip: z.string().optional(),
  icon: z.string().trim().min(1).optional(),
});

export const ChatFeatureWireSchema = z.discriminatedUnion("type", [
  ChatFeatureBaseWireSchema.extend({
    type: z.literal("toggle"),
    value: z.boolean(),
  }).strict(),
  ChatFeatureBaseWireSchema.extend({
    type: z.literal("select"),
    value: z.string().nullable(),
    options: z.array(ChatThinkingOptionWireSchema),
  }).strict(),
]);

export type ChatFeatureWire = z.infer<typeof ChatFeatureWireSchema>;

export const ChatFeatureDiscoveryWireSchema = z.object({
  version: z.literal(1),
  selection: ChatSelectionWireSchema,
  status: z.enum(["ready", "unavailable", "update_required", "repair_required"]),
  features: z.array(ChatFeatureWireSchema).nullable(),
  error: ChatCapabilityErrorWireSchema.nullable(),
}).strict().superRefine((result, context) => {
  if (result.status === "ready" && (result.features === null || result.error !== null)) {
    context.addIssue({ code: "custom", path: ["features"], message: "Ready feature discovery requires features and no error" });
  }
  if (result.status !== "ready" && (result.features !== null || result.error === null)) {
    context.addIssue({ code: "custom", path: ["error"], message: "Unavailable feature discovery requires a redacted error and no feature list" });
  }
});

export type ChatFeatureDiscoveryWire = z.infer<typeof ChatFeatureDiscoveryWireSchema>;

export const MeetingChatControlsRpc = defineRpc({
  name: "meeting.chat.controls.v1",
  input: z.object({}).strict(),
  output: ChatControlsWireSchema,
});

export const MeetingChatFeaturesRpc = defineRpc({
  name: "meeting.chat.features.v1",
  input: z.object({ selection: ChatSelectionWireSchema }).strict(),
  output: ChatFeatureDiscoveryWireSchema,
});

export const MeetingChatSelectionRpc = defineRpc({
  name: "meeting.chat.selection.v1",
  input: z.object({ selection: ChatSelectionWireSchema }).strict(),
  output: z.object({ version: z.literal(1), selection: ChatSelectionWireSchema }).strict(),
});

const ChatUserMessageWireSchema = z.object({
  role: z.literal("user"),
  text: z.string().trim().min(1),
  createdAt: z.string().datetime(),
}).strict();

const ChatSupportedMessageWireSchema = z.object({
  role: z.literal("assistant"),
  outcome: z.literal("supported"),
  text: z.string().trim().min(1),
  citations: z.array(z.object({
    meetingId: z.string().trim().min(1),
    segmentId: z.string().trim().min(1),
  }).strict()).min(1),
  createdAt: z.string().datetime(),
}).strict();

const ChatInsufficientMessageWireSchema = z.object({
  role: z.literal("assistant"),
  outcome: z.literal("insufficient_evidence"),
  text: z.null(),
  citations: z.array(z.never()).length(0),
  createdAt: z.string().datetime(),
}).strict();

export const ChatMessageWireSchema = z.union([
  ChatUserMessageWireSchema,
  ChatSupportedMessageWireSchema,
  ChatInsufficientMessageWireSchema,
]);

export const MeetingChatThreadWireSchema = z.object({
  meetingId: z.string().trim().min(1),
  status: z.enum(["ready", "running", "failed"]),
  messages: z.array(ChatMessageWireSchema),
  selection: z.object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
  }).strict().nullable(),
  failure: z.object({
    message: z.string().trim().min(1),
    retryable: z.literal(true),
  }).strict().nullable(),
}).strict();

export type MeetingChatThreadWire = z.infer<typeof MeetingChatThreadWireSchema>;

export const MeetingChatProvidersRpc = defineRpc({
  name: "meeting.chat.providers",
  input: z.object({}).strict(),
  output: z.object({
    providers: z.array(ChatProviderWireSchema),
    compatibilityCheck: z.literal("on_question_start"),
  }).strict(),
});

export const MeetingChatGetRpc = defineRpc({
  name: "meeting.chat.get",
  input: z.object({ meetingId: z.string().trim().min(1) }).strict(),
  output: z.object({ thread: MeetingChatThreadWireSchema.nullable() }).strict(),
});

const ChatQuestionInputSchema = z.object({
  meetingId: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
}).strict();

export const MeetingChatAskRpc = defineRpc({
  name: "meeting.chat.ask",
  input: ChatQuestionInputSchema.extend({ question: z.string().trim().min(1).max(4_000) }).strict(),
  output: MeetingChatThreadWireSchema,
});

export const MeetingChatRetryRpc = defineRpc({
  name: "meeting.chat.retry",
  input: ChatQuestionInputSchema,
  output: MeetingChatThreadWireSchema,
});

export const MeetingChatAskV1Rpc = defineRpc({
  name: "meeting.chat.ask.v1",
  input: z.object({
    meetingId: z.string().trim().min(1),
    question: z.string().trim().min(1).max(4_000),
    selection: ChatSelectionWireSchema,
  }).strict(),
  output: MeetingChatThreadWireSchema,
});

export const MeetingChatRetryV1Rpc = defineRpc({
  name: "meeting.chat.retry.v1",
  input: z.object({
    meetingId: z.string().trim().min(1),
    attemptId: z.string().trim().min(1).optional(),
    selection: ChatSelectionWireSchema,
  }).strict(),
  output: MeetingChatThreadWireSchema,
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
