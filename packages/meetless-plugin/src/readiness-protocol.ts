import { RecordingStatusWireSchema } from "@meetless/meeting-contracts";
import { z } from "zod";

export const MEETLESS_DESKTOP_LOGICAL_ID = "com.meetless.desktop" as const;

export const UiTestIdentitySchema = z.object({
  version: z.literal(1),
  logicalDesktopId: z.literal(MEETLESS_DESKTOP_LOGICAL_ID),
  hostBundleIdentifier: z.literal("com.meetless.app"),
  hostBundlePath: z.string().min(1),
  hostCdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  hostPid: z.number().int().positive(),
  hostStartInstance: z.string().min(1),
  desktopPid: z.number().int().positive(),
  desktopStartInstance: z.string().min(1),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
  cdpAddress: z.literal("127.0.0.1"),
  cdpPort: z.number().int().min(1024).max(65535),
  captureMode: z.literal("fixture"),
  transcriptionMode: z.enum(["fake", "native"]),
  accessibility: z.enum(["forced-controlled-runtime", "labels-only-controlled-runtime"]),
}).strict();

export type UiTestIdentity = z.infer<typeof UiTestIdentitySchema>;

export const RecordingRuntimeBootstrapInputSchema = z.object({
  nonce: z.string().uuid(),
  deadlineEpochMs: z.number().int().positive(),
}).strict();

export const RecordingRuntimeBootstrapOutputSchema = z.object({
  nonce: z.string().uuid(),
  runtimeInstanceId: z.string().uuid(),
  pluginPid: z.number().int().positive(),
}).strict();

export const RecordingRuntimeBootstrapRpc = {
  name: "runtime.readiness.bootstrap",
  input: RecordingRuntimeBootstrapInputSchema,
  output: RecordingRuntimeBootstrapOutputSchema,
};

export const RecordingRuntimeReadinessRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1),
  command: z.literal("runtime.readiness"),
  operation: z.enum(["status", "prepareCollision", "validateCollision"]),
}).strict();

const FileIdentitySchema = z.object({
  configuredPath: z.string().min(1),
  realPath: z.string().min(1),
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const CollisionEvidenceSchema = z.object({
  path: z.string().min(1),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  plannedPublishedPath: z.string().min(1),
  recordingId: z.string().min(1),
  runtimeInstanceId: z.string().uuid(),
  exportRoot: z.string().min(1),
  exportStamp: z.string().datetime({ offset: true }),
  preparedAt: z.string().datetime({ offset: true }),
  validUntil: z.null(),
}).strict();

export const RecordingRuntimeReadinessResponseSchema = z.object({
  version: z.literal(1),
  type: z.literal("recording.runtime.readiness"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  runtime: z.object({
    instanceId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
    pluginPid: z.number().int().positive(),
    socketPath: z.string().min(1),
    socketIdentity: z.object({
      device: z.number().int().nonnegative(),
      inode: z.number().int().nonnegative(),
    }).strict(),
    capture: z.object({
      mode: z.enum(["production", "fixture"]),
      executable: FileIdentitySchema,
      arguments: z.array(z.string()),
      helperPid: z.number().int().positive().nullable(),
    }).strict(),
    export: z.object({
      root: z.string().min(1),
      fixtureStampApplied: z.boolean(),
    }).strict(),
    uiTest: UiTestIdentitySchema.nullable().optional(),
  }).strict(),
  status: RecordingStatusWireSchema,
  collision: CollisionEvidenceSchema.nullable(),
  error: z.string().nullable(),
}).strict();

export type RecordingRuntimeReadinessRequest = z.infer<typeof RecordingRuntimeReadinessRequestSchema>;
export type RecordingRuntimeReadinessResponse = z.infer<typeof RecordingRuntimeReadinessResponseSchema>;
export type CollisionEvidence = z.infer<typeof CollisionEvidenceSchema>;
