import path from "node:path";

export const MEETLESS_RUNTIME_ENDPOINTS_SCHEMA = "MEETLESS_RUNTIME_ENDPOINTS v1" as const;
export const MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY = "runtime-root" as const;
export const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

export type RuntimeEndpointRole = "recording" | "transcription";
export type RuntimeEndpointMode = "packaged" | "development";

export interface RuntimeEndpointPolicy {
  schema: typeof MEETLESS_RUNTIME_ENDPOINTS_SCHEMA;
  workingDirectory: typeof MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY;
  recordingEndpointName: string;
  transcriptionEndpointName: string;
}

export interface RuntimeEndpointDescriptor {
  role: RuntimeEndpointRole;
  name: string;
  bindArgument: string;
  canonicalPath: string;
}

export interface RuntimeEndpointComposition {
  schema: typeof MEETLESS_RUNTIME_ENDPOINTS_SCHEMA;
  mode: RuntimeEndpointMode;
  workingDirectory: string;
  recording: RuntimeEndpointDescriptor;
  transcription: RuntimeEndpointDescriptor;
}

const ENDPOINT_AUTHORITY =
  "docs/decisions/0005-mac-app-store-and-revenuecat.md, " +
  "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md, " +
  "docs/decisions/0004-recording-host-and-capture-permission-boundary.md, " +
  "PLAN_RECONCILIATION v47";

export class RuntimeEndpointPolicyViolationError extends Error {
  constructor(endpoint: string, reason: string) {
    super(
      `Runtime endpoint ${endpoint} violates policy: ${reason}. Authority: ${ENDPOINT_AUTHORITY}. ` +
        "Next action: use the versioned endpoint names from the accepted installation contract, " +
        "run from the canonical runtime-root working directory, and stop before child launch.",
    );
    this.name = "RuntimeEndpointPolicyViolationError";
  }
}

export function composeRuntimeEndpointComposition(input: {
  runtimeRoot: string;
  packaged: boolean;
  policy: unknown;
}): RuntimeEndpointComposition {
  const policy = validateRuntimeEndpointPolicy(input.policy);
  const workingDirectory = validateWorkingDirectory(input.runtimeRoot, "runtime endpoint working directory");
  const mode: RuntimeEndpointMode = input.packaged ? "packaged" : "development";
  const recording = composeDescriptor(
    "recording",
    policy.recordingEndpointName,
    workingDirectory,
    mode,
  );
  const transcription = composeDescriptor(
    "transcription",
    policy.transcriptionEndpointName,
    workingDirectory,
    mode,
  );
  if (recording.name === transcription.name) {
    throw new RuntimeEndpointPolicyViolationError(
      "recording/transcription",
      `endpoint names must remain distinct (received ${JSON.stringify(recording.name)})`,
    );
  }
  return {
    schema: MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
    mode,
    workingDirectory,
    recording,
    transcription,
  };
}

export function validateRuntimeEndpointPolicy(value: unknown): RuntimeEndpointPolicy {
  if (!isRecord(value)) {
    throw new RuntimeEndpointPolicyViolationError("policy", "the endpoint policy must be an object");
  }
  assertExactKeys(value, ["schema", "workingDirectory", "recordingEndpointName", "transcriptionEndpointName"], "policy");
  if (value.schema !== MEETLESS_RUNTIME_ENDPOINTS_SCHEMA) {
    throw new RuntimeEndpointPolicyViolationError(
      "policy",
      `version ${JSON.stringify(value.schema)} is not ${MEETLESS_RUNTIME_ENDPOINTS_SCHEMA}`,
    );
  }
  if (value.workingDirectory !== MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY) {
    throw new RuntimeEndpointPolicyViolationError(
      "policy",
      `working directory ${JSON.stringify(value.workingDirectory)} is not ${MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY}`,
    );
  }
  const recordingEndpointName = validateEndpointName("recording", value.recordingEndpointName);
  const transcriptionEndpointName = validateEndpointName("transcription", value.transcriptionEndpointName);
  if (recordingEndpointName === transcriptionEndpointName) {
    throw new RuntimeEndpointPolicyViolationError(
      "recording/transcription",
      `endpoint names must remain distinct (received ${JSON.stringify(recordingEndpointName)})`,
    );
  }
  return {
    schema: MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
    workingDirectory: MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
    recordingEndpointName,
    transcriptionEndpointName,
  };
}

export function parseRuntimeEndpointComposition(value: unknown): RuntimeEndpointComposition {
  if (!isRecord(value)) {
    throw new RuntimeEndpointPolicyViolationError("composition", "the endpoint composition must be an object");
  }
  assertExactKeys(value, ["schema", "mode", "workingDirectory", "recording", "transcription"], "composition");
  if (value.schema !== MEETLESS_RUNTIME_ENDPOINTS_SCHEMA) {
    throw new RuntimeEndpointPolicyViolationError(
      "composition",
      `version ${JSON.stringify(value.schema)} is not ${MEETLESS_RUNTIME_ENDPOINTS_SCHEMA}`,
    );
  }
  if (value.mode !== "packaged" && value.mode !== "development") {
    throw new RuntimeEndpointPolicyViolationError("composition", `mode ${JSON.stringify(value.mode)} is not supported`);
  }
  const workingDirectory = validateWorkingDirectory(value.workingDirectory, "composition working directory");
  const recording = parseDescriptor("recording", value.recording, workingDirectory, value.mode);
  const transcription = parseDescriptor("transcription", value.transcription, workingDirectory, value.mode);
  if (recording.name === transcription.name) {
    throw new RuntimeEndpointPolicyViolationError(
      "recording/transcription",
      `endpoint names must remain distinct (received ${JSON.stringify(recording.name)})`,
    );
  }
  return {
    schema: MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
    mode: value.mode,
    workingDirectory,
    recording,
    transcription,
  };
}

export function serializeRuntimeEndpointComposition(composition: RuntimeEndpointComposition): string {
  return JSON.stringify(parseRuntimeEndpointComposition(composition));
}

export function validateEndpointName(role: RuntimeEndpointRole | "policy", value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeEndpointPolicyViolationError(role, "endpoint name must be a non-empty string");
  }
  if (value !== value.trim() || value.includes("\u0000")) {
    throw new RuntimeEndpointPolicyViolationError(role, `endpoint name ${JSON.stringify(value)} contains unsafe whitespace or NUL`);
  }
  if (path.isAbsolute(value)) {
    throw new RuntimeEndpointPolicyViolationError(role, `endpoint name ${JSON.stringify(value)} must be relative`);
  }
  if (value.includes("\\")) {
    throw new RuntimeEndpointPolicyViolationError(role, `endpoint name ${JSON.stringify(value)} contains a non-portable separator`);
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `endpoint name ${JSON.stringify(value)} contains an empty, current-directory, or parent segment`,
    );
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `endpoint name ${JSON.stringify(value)} is ${byteLength} UTF-8 bytes; the Darwin limit is ${DARWIN_UNIX_SOCKET_PATH_BYTES}`,
    );
  }
  return value;
}

function composeDescriptor(
  role: RuntimeEndpointRole,
  name: string,
  workingDirectory: string,
  mode: RuntimeEndpointMode,
): RuntimeEndpointDescriptor {
  const validatedName = validateEndpointName(role, name);
  const canonicalPath = projectCanonicalPath(workingDirectory, validatedName, role);
  const bindArgument = mode === "packaged" ? validatedName : canonicalPath;
  if (mode === "packaged" && Buffer.byteLength(bindArgument, "utf8") > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `packaged bind argument ${JSON.stringify(bindArgument)} exceeds the ${DARWIN_UNIX_SOCKET_PATH_BYTES}-byte Darwin limit`,
    );
  }
  return { role, name: validatedName, bindArgument, canonicalPath };
}

function parseDescriptor(
  role: RuntimeEndpointRole,
  value: unknown,
  workingDirectory: string,
  mode: RuntimeEndpointMode,
): RuntimeEndpointDescriptor {
  if (!isRecord(value)) {
    throw new RuntimeEndpointPolicyViolationError(role, "endpoint descriptor must be an object");
  }
  assertExactKeys(value, ["role", "name", "bindArgument", "canonicalPath"], `${role} descriptor`);
  if (value.role !== role) {
    throw new RuntimeEndpointPolicyViolationError(role, `descriptor role is ${JSON.stringify(value.role)}`);
  }
  const name = validateEndpointName(role, value.name);
  if (typeof value.bindArgument !== "string" || value.bindArgument.length === 0) {
    throw new RuntimeEndpointPolicyViolationError(role, "bind argument must be a non-empty string");
  }
  if (typeof value.canonicalPath !== "string" || !path.isAbsolute(value.canonicalPath)) {
    throw new RuntimeEndpointPolicyViolationError(role, "canonical endpoint path must be absolute");
  }
  const canonicalPath = projectCanonicalPath(workingDirectory, name, role);
  if (value.canonicalPath !== canonicalPath) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `canonical endpoint path ${JSON.stringify(value.canonicalPath)} does not project to ${canonicalPath}`,
    );
  }
  const expectedBindArgument = mode === "packaged" ? name : canonicalPath;
  if (value.bindArgument !== expectedBindArgument) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `bind argument ${JSON.stringify(value.bindArgument)} does not match the authoritative ${mode} composition ${JSON.stringify(expectedBindArgument)}`,
    );
  }
  if (mode === "packaged" && Buffer.byteLength(value.bindArgument, "utf8") > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `packaged bind argument ${JSON.stringify(value.bindArgument)} exceeds the ${DARWIN_UNIX_SOCKET_PATH_BYTES}-byte Darwin limit`,
    );
  }
  return { role, name, bindArgument: value.bindArgument, canonicalPath };
}

function projectCanonicalPath(workingDirectory: string, name: string, role: RuntimeEndpointRole): string {
  const canonicalPath = path.resolve(workingDirectory, name);
  const relative = path.relative(workingDirectory, canonicalPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RuntimeEndpointPolicyViolationError(
      role,
      `endpoint name ${JSON.stringify(name)} projects outside the canonical runtime root ${workingDirectory}`,
    );
  }
  return canonicalPath;
}

function validateWorkingDirectory(value: unknown, endpoint: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new RuntimeEndpointPolicyViolationError(endpoint, "working directory must be absolute");
  }
  const resolved = path.resolve(value);
  if (resolved !== value) {
    throw new RuntimeEndpointPolicyViolationError(
      endpoint,
      `working directory ${JSON.stringify(value)} is not canonical after projection (${resolved})`,
    );
  }
  return resolved;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], endpoint: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RuntimeEndpointPolicyViolationError(
      endpoint,
      `fields ${JSON.stringify(actual)} do not match the accepted shape ${JSON.stringify(expected)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
