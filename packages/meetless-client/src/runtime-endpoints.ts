export const RUNTIME_ENDPOINTS_SCHEMA = "MEETLESS_RUNTIME_ENDPOINTS v1" as const;
export const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

export type RuntimeEndpointMode = "packaged" | "development";
export type RuntimeEndpointRole = "recording" | "transcription";

export interface RuntimeEndpointDescriptor {
  role: RuntimeEndpointRole;
  name: string;
  bindArgument: string;
  canonicalPath: string;
}

export interface RuntimeEndpointComposition {
  schema: typeof RUNTIME_ENDPOINTS_SCHEMA;
  mode: RuntimeEndpointMode;
  workingDirectory: string;
  recording: RuntimeEndpointDescriptor;
  transcription: RuntimeEndpointDescriptor;
}

const AUTHORITY =
  "docs/decisions/0005-mac-app-store-and-revenuecat.md, " +
  "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md, " +
  "docs/decisions/0004-recording-host-and-capture-permission-boundary.md, " +
  "the accepted MEETLESS_RUNTIME_ENDPOINTS v1 package/runtime endpoint contract";

export function parseRuntimeEndpointComposition(value: unknown): RuntimeEndpointComposition {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "mode", "workingDirectory", "recording", "transcription"])) {
    throw endpointError("composition", "the endpoint composition has an unknown or incomplete shape");
  }
  if (value.schema !== RUNTIME_ENDPOINTS_SCHEMA) {
    throw endpointError("composition", `policy version ${JSON.stringify(value.schema)} is not ${RUNTIME_ENDPOINTS_SCHEMA}`);
  }
  if (value.mode !== "packaged" && value.mode !== "development") {
    throw endpointError("composition", `mode ${JSON.stringify(value.mode)} is unsupported`);
  }
  const workingDirectory = validateAbsolutePath(value.workingDirectory, "composition working directory");
  const recording = parseDescriptor("recording", value.recording, workingDirectory, value.mode);
  const transcription = parseDescriptor("transcription", value.transcription, workingDirectory, value.mode);
  if (recording.name === transcription.name) {
    throw endpointError("recording/transcription", "endpoint names must remain distinct");
  }
  return { schema: RUNTIME_ENDPOINTS_SCHEMA, mode: value.mode, workingDirectory, recording, transcription };
}

export function parseRendererRuntimeEndpointComposition(href: string): RuntimeEndpointComposition {
  let raw: string | null;
  try {
    raw = new URL(href).searchParams.get("meetlessEndpoints");
  } catch (error) {
    throw endpointError("composition", `renderer URL is invalid (${describe(error)})`);
  }
  if (!raw) throw endpointError("composition", "renderer URL has no authoritative meetlessEndpoints composition");
  try {
    return parseRuntimeEndpointComposition(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Runtime endpoint")) throw error;
    throw endpointError("composition", `renderer endpoint composition is invalid (${describe(error)})`);
  }
}

function parseDescriptor(
  role: RuntimeEndpointRole,
  value: unknown,
  workingDirectory: string,
  mode: RuntimeEndpointMode,
): RuntimeEndpointDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, ["role", "name", "bindArgument", "canonicalPath"])) {
    throw endpointError(role, "endpoint descriptor has an unknown or incomplete shape");
  }
  if (value.role !== role) throw endpointError(role, `descriptor role is ${JSON.stringify(value.role)}`);
  const name = validateEndpointName(role, value.name);
  const canonicalPath = projectCanonicalPath(workingDirectory, name, role);
  if (typeof value.canonicalPath !== "string" || value.canonicalPath !== canonicalPath) {
    throw endpointError(role, `canonical endpoint path ${JSON.stringify(value.canonicalPath)} is not ${canonicalPath}`);
  }
  const expectedBindArgument = mode === "packaged" ? name : canonicalPath;
  if (value.bindArgument !== expectedBindArgument) {
    throw endpointError(role, `bind argument ${JSON.stringify(value.bindArgument)} is not ${JSON.stringify(expectedBindArgument)}`);
  }
  if (mode === "packaged" && byteLength(value.bindArgument) > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw endpointError(role, `packaged bind argument exceeds ${DARWIN_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
  }
  return { role, name, bindArgument: value.bindArgument, canonicalPath };
}

function validateEndpointName(role: RuntimeEndpointRole, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.startsWith("/") || value.includes("\\") || value.includes("\u0000") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw endpointError(role, `endpoint name ${JSON.stringify(value)} must be a safe relative name`);
  }
  if (byteLength(value) > DARWIN_UNIX_SOCKET_PATH_BYTES) {
    throw endpointError(role, `endpoint name ${JSON.stringify(value)} exceeds ${DARWIN_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
  }
  return value;
}

function projectCanonicalPath(workingDirectory: string, name: string, role: RuntimeEndpointRole): string {
  const canonical = workingDirectory === "/" ? `/${name}` : `${workingDirectory}/${name}`;
  if (canonical === workingDirectory || !canonical.startsWith(`${workingDirectory}/`)) {
    throw endpointError(role, `endpoint name ${JSON.stringify(name)} escapes the runtime root`);
  }
  return canonical;
}

function validateAbsolutePath(value: unknown, endpoint: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1 && value.endsWith("/") || value !== "/" && value.includes("//")) {
    throw endpointError(endpoint, "working directory must be a canonical absolute path");
  }
  if (value.split("/").some((part) => part === "." || part === "..")) {
    throw endpointError(endpoint, "working directory must not contain traversal segments");
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function endpointError(endpoint: string, reason: string): Error {
  return new Error(
    `Runtime endpoint ${endpoint} violates policy: ${reason}. Authority: ${AUTHORITY}. ` +
      "Next action: consume the host-provided versioned endpoint composition and stop before opening the transport.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
