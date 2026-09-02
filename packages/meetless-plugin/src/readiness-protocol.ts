import { randomUUID } from "node:crypto";
import net from "node:net";
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

export const HostProcessProtocolVersion = 1 as const;
export const HostProcessRoleSchema = z.enum(["desktop", "daemon", "plugin", "capture-helper"]);

export const HostProcessIdentitySchema = z.object({
  configuredPath: z.string().min(1),
  realPath: z.string().min(1),
  device: z.number().int().nonnegative(),
  inode: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  argv: z.array(z.string().min(1)).min(1).max(32),
}).strict();

export const HostProcessPolicySchema = z.object({
  runtimeRoot: z.string().min(1),
  endpointPolicy: z.literal("MEETLESS_RUNTIME_ENDPOINTS v1"),
  endpointWorkingDirectory: z.literal("runtime-root"),
  recordingEndpointName: z.string().min(1),
  transcriptionEndpointName: z.string().min(1),
}).strict();

export const HostIdentityAttestationSchema = z.object({
  bundleIdentifier: z.literal("com.meetless.app"),
  bundlePath: z.string().min(1),
  bundleRealPath: z.string().min(1),
  executablePath: z.string().min(1),
  designatedRequirement: z.string().min(1),
  cdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryDevice: z.number().int().nonnegative(),
  binaryInode: z.number().int().positive(),
  binarySize: z.number().int().positive(),
}).strict();

const HostProcessAttestationResponseSchema = z.object({
  version: z.literal(HostProcessProtocolVersion),
  type: z.literal("host.process.attestation"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  challenge: z.string().min(1).optional(),
  generation: z.number().int().positive(),
  role: HostProcessRoleSchema,
  processPid: z.number().int().positive(),
  identity: HostProcessIdentitySchema,
  host: HostIdentityAttestationSchema,
  ownerToken: z.string().min(1).optional(),
}).strict();

const HostProcessRegistrationResponseSchema = z.object({
  version: z.literal(HostProcessProtocolVersion),
  type: z.literal("host.process.registration"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  generation: z.number().int().positive(),
  role: HostProcessRoleSchema,
  processPid: z.number().int().positive(),
  registrationToken: z.string().min(1),
}).strict();

const HostProcessRegistrationStatusSchema = z.object({
  role: HostProcessRoleSchema,
  pid: z.number().int().positive(),
  attested: z.boolean(),
  identity: HostProcessIdentitySchema,
}).strict();

const HostProcessRegistrationsResponseSchema = z.object({
  version: z.literal(HostProcessProtocolVersion),
  type: z.literal("host.process.registrations"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  generation: z.number().int().positive(),
  registrations: z.array(HostProcessRegistrationStatusSchema).max(8),
}).strict();

const HostProcessReleaseResponseSchema = z.object({
  version: z.literal(HostProcessProtocolVersion),
  type: z.literal("host.process.release"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  generation: z.number().int().positive(),
  processPid: z.number().int().positive(),
}).strict();

const HostProcessErrorResponseSchema = z.object({
  version: z.literal(HostProcessProtocolVersion),
  type: z.literal("host.process.error"),
  requestId: z.string().min(1),
  ok: z.literal(false),
  error: z.string().min(1).max(512),
}).strict();

export const HostProcessProtocolResponseSchema = z.union([
  HostProcessAttestationResponseSchema,
  HostProcessRegistrationResponseSchema,
  HostProcessRegistrationsResponseSchema,
  HostProcessReleaseResponseSchema,
  HostProcessErrorResponseSchema,
]);

export type HostProcessRole = z.infer<typeof HostProcessRoleSchema>;
export type HostProcessIdentity = z.infer<typeof HostProcessIdentitySchema>;
export type HostProcessPolicy = z.infer<typeof HostProcessPolicySchema>;
export type HostIdentityAttestation = z.infer<typeof HostIdentityAttestationSchema>;
export type HostProcessProtocolResponse = z.infer<typeof HostProcessProtocolResponseSchema>;
export type HostProcessRegistration = z.infer<typeof HostProcessRegistrationStatusSchema>;

export type HostProcessProtocolRequest = {
  version: typeof HostProcessProtocolVersion;
  requestId: string;
  operation: "desktopAttestation" | "registerChild" | "processAttestation" | "registrationStatus" | "releaseChild";
  challenge?: string;
  generation?: number;
  ownerToken?: string;
  registrationToken?: string;
  role?: HostProcessRole;
  childPid?: number;
  expectedIdentity?: HostProcessIdentity;
  policy?: HostProcessPolicy;
};

export async function requestHostProcessProtocol(
  socketPath: string,
  request: HostProcessProtocolRequest,
  timeoutMs = 2_000,
): Promise<HostProcessProtocolResponse> {
  const requestId = request.requestId || randomUUID();
  const payload = JSON.stringify({ ...request, requestId });
  if (Buffer.byteLength(payload, "utf8") > 16 * 1024) {
    throw new Error("host process protocol request exceeds the bounded frame size");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: HostProcessProtocolResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("host process protocol request timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${payload}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) {
        finish(new Error("host process protocol response exceeds the bounded frame size"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("host process protocol response is not valid JSON"));
        return;
      }
      const parsed = HostProcessProtocolResponseSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.requestId !== requestId) {
        finish(new Error("host process protocol response is invalid or misbound"));
        return;
      }
      if (!parsed.data.ok) {
        finish(new Error(`host process protocol rejected ${parsed.data.type}: ${parsed.data.error}`));
        return;
      }
      finish(undefined, parsed.data);
    });
    socket.once("error", () => finish(new Error("host process protocol socket is unavailable")));
    socket.once("close", () => {
      if (!settled) finish(new Error("host process protocol socket closed before response"));
    });
  });
}

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
