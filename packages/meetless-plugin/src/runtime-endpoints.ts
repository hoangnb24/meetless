import path from "node:path";

export const RUNTIME_ENDPOINTS_SCHEMA = "MEETLESS_RUNTIME_ENDPOINTS v1" as const;
export const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

export type RuntimeEndpointRole = "recording" | "transcription";
export type RuntimeEndpointMode = "packaged" | "development";

export interface RuntimeEndpoint {
  role: RuntimeEndpointRole;
  mode: RuntimeEndpointMode;
  workingDirectory: string;
  name: string;
  bindArgument: string;
  canonicalPath: string;
}

const AUTHORITY =
  "docs/decisions/0005-mac-app-store-and-revenuecat.md, " +
  "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md, " +
  "docs/decisions/0004-recording-host-and-capture-permission-boundary.md, " +
  "PLAN_RECONCILIATION v47";

export function runtimeEndpoint(
  environment: NodeJS.ProcessEnv,
  role: RuntimeEndpointRole,
): RuntimeEndpoint {
  const packaged = environment.MEETLESS_RUNTIME_PACKAGED === "1";
  const raw = environment.MEETLESS_RUNTIME_ENDPOINTS?.trim();
  if (!raw) {
    if (packaged) {
      throw endpointError(role, "the packaged endpoint composition is missing; no absolute-socket fallback is allowed");
    }
    const legacyName = role === "recording" ? "MEETLESS_RECORDING_SOCKET" : "MEETLESS_TRANSCRIPTION_SOCKET";
    const legacyPath = environment[legacyName]?.trim();
    if (!legacyPath || !path.isAbsolute(legacyPath)) {
      throw endpointError(role, `${legacyName} must be an absolute development endpoint when the versioned composition is absent`);
    }
    return {
      role,
      mode: "development",
      workingDirectory: process.cwd(),
      name: path.resolve(legacyPath),
      bindArgument: path.resolve(legacyPath),
      canonicalPath: path.resolve(legacyPath),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw endpointError(role, `the endpoint composition is not valid JSON (${describe(error)})`);
  }
  const composition = parseComposition(decoded, role);
  if ((packaged && composition.mode !== "packaged") || (!packaged && composition.mode !== "development")) {
    throw endpointError(role, `composition mode ${composition.mode} does not match MEETLESS_RUNTIME_PACKAGED=${packaged ? "1" : "0"}`);
  }
  if (composition.mode === "packaged" && path.resolve(process.cwd()) !== composition.workingDirectory) {
    throw endpointError(
      role,
      `process CWD ${process.cwd()} differs from the authoritative runtime-root working directory ${composition.workingDirectory}`,
    );
  }
  const legacyName = role === "recording" ? "MEETLESS_RECORDING_SOCKET" : "MEETLESS_TRANSCRIPTION_SOCKET";
  const legacyPath = environment[legacyName]?.trim();
  if (!legacyPath || !path.isAbsolute(legacyPath) || path.resolve(legacyPath) !== composition.endpoint.canonicalPath) {
    throw endpointError(
      role,
      `${legacyName} must remain the absolute canonical projection ${composition.endpoint.canonicalPath}`,
    );
  }
  return composition.endpoint;
}

function parseComposition(value: unknown, requestedRole: RuntimeEndpointRole): {
  mode: RuntimeEndpointMode;
  workingDirectory: string;
  endpoint: RuntimeEndpoint;
} {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== "mode\u0000recording\u0000schema\u0000transcription\u0000workingDirectory") {
    throw endpointError(requestedRole, "the endpoint composition has an unknown or incomplete shape");
  }
  if (value.schema !== RUNTIME_ENDPOINTS_SCHEMA) {
    throw endpointError(requestedRole, `policy version ${JSON.stringify(value.schema)} is not ${RUNTIME_ENDPOINTS_SCHEMA}`);
  }
  if (value.mode !== "packaged" && value.mode !== "development") {
    throw endpointError(requestedRole, `composition mode ${JSON.stringify(value.mode)} is unsupported`);
  }
  if (typeof value.workingDirectory !== "string" || !path.isAbsolute(value.workingDirectory) || path.resolve(value.workingDirectory) !== value.workingDirectory) {
    throw endpointError(requestedRole, "composition working directory must be canonical and absolute");
  }
  const recording = parseDescriptor("recording", value.recording, value.workingDirectory, value.mode);
  const transcription = parseDescriptor("transcription", value.transcription, value.workingDirectory, value.mode);
  if (recording.name === transcription.name) {
    throw endpointError(requestedRole, "recording and transcription endpoint names must remain distinct");
  }
  return {
    mode: value.mode,
    workingDirectory: value.workingDirectory,
    endpoint: requestedRole === "recording" ? recording : transcription,
  };
}

function parseDescriptor(
  role: RuntimeEndpointRole,
  value: unknown,
  workingDirectory: string,
  mode: RuntimeEndpointMode,
): RuntimeEndpoint {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== "bindArgument\u0000canonicalPath\u0000name\u0000role") {
    throw endpointError(role, "endpoint descriptor has an unknown or incomplete shape");
  }
  if (value.role !== role) throw endpointError(role, `descriptor role is ${JSON.stringify(value.role)}`);
  if (typeof value.name !== "string" || !value.name || value.name !== value.name.trim() || path.isAbsolute(value.name) || value.name.includes("\\") || value.name.includes("\u0000") || value.name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw endpointError(role, `endpoint name ${JSON.stringify(value.name)} must be a safe relative name`);
  }
  if (Buffer.byteLength(value.name, "utf8") > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw endpointError(role, `endpoint name ${JSON.stringify(value.name)} exceeds ${DARWIN_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
  }
  if (typeof value.canonicalPath !== "string" || !path.isAbsolute(value.canonicalPath)) {
    throw endpointError(role, "canonical endpoint path must be absolute");
  }
  const canonicalPath = path.resolve(workingDirectory, value.name);
  const relative = path.relative(workingDirectory, canonicalPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || value.canonicalPath !== canonicalPath) {
    throw endpointError(role, `canonical endpoint path ${JSON.stringify(value.canonicalPath)} escapes or differs from the runtime root`);
  }
  const expectedBind = mode === "packaged" ? value.name : canonicalPath;
  if (value.bindArgument !== expectedBind) {
    throw endpointError(role, `bind argument ${JSON.stringify(value.bindArgument)} does not match ${JSON.stringify(expectedBind)}`);
  }
  if (mode === "packaged" && Buffer.byteLength(value.bindArgument, "utf8") > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw endpointError(role, "packaged bind argument exceeds the Darwin AF_UNIX limit");
  }
  return {
    role,
    mode,
    workingDirectory,
    name: value.name,
    bindArgument: value.bindArgument,
    canonicalPath,
  };
}

function endpointError(role: string, reason: string): Error {
  return new Error(
    `Runtime endpoint ${role} violates policy: ${reason}. Authority: ${AUTHORITY}. ` +
      "Next action: use the host-provided versioned endpoint composition and stop before helper or listener launch.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
