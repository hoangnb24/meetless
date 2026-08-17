import { RecordingStatusWireSchema } from "@meetless/meeting-contracts";
import { z } from "zod";

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
  }).strict(),
  status: RecordingStatusWireSchema,
  collision: CollisionEvidenceSchema.nullable(),
  error: z.string().nullable(),
}).strict();

export type RecordingRuntimeReadinessRequest = z.infer<typeof RecordingRuntimeReadinessRequestSchema>;
export type RecordingRuntimeReadinessResponse = z.infer<typeof RecordingRuntimeReadinessResponseSchema>;
export type CollisionEvidence = z.infer<typeof CollisionEvidenceSchema>;
