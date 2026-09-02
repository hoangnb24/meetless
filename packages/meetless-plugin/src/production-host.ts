import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { runtimeEndpoint } from "./runtime-endpoints.js";
import {
  requestHostProcessProtocol,
  type HostIdentityAttestation,
  type HostProcessIdentity,
  type HostProcessPolicy,
} from "./readiness-protocol.js";

const AUTHORITY = "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0004-recording-host-and-capture-permission-boundary.md";
const HostIdentitySchema = z.object({
  version: z.literal(1),
  bundleIdentifier: z.literal("com.meetless.app"),
  bundlePath: z.string().min(1),
  bundleRealPath: z.string().min(1),
  executablePath: z.string().min(1),
  designatedRequirement: z.string().min(1),
  cdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryDevice: z.number().int().nonnegative(),
  binaryInode: z.number().int().nonnegative(),
  binarySize: z.number().int().positive(),
}).passthrough();

interface ProcessExecutable {
  path: string;
  device: number;
  inode: number;
  size: number;
}

interface ProductionHostDependencies {
  parentPid(pid: number): number;
  executable(pid: number): ProcessExecutable;
  readIdentity(file: string): Promise<z.infer<typeof HostIdentitySchema>>;
  inspectCode(bundle: string): { cdHash: string; designatedRequirement: string };
}

const defaultDependencies: ProductionHostDependencies = {
  parentPid: (pid) => Number(inspectRequired("ps", ["-p", String(pid), "-o", "ppid="], `parent PID for ${pid}`)),
  executable: inspectProcessExecutable,
  readIdentity: async (file) => HostIdentitySchema.parse(JSON.parse(await readFile(file, "utf8"))),
  inspectCode: inspectCodeIdentity,
};

interface PackagedProcessAuthority {
  generation: number;
  registrationToken: string;
  identity: HostProcessIdentity;
}

const packagedProcessAuthorities = new WeakMap<object, PackagedProcessAuthority>();

export async function assertProductionHostProvenance(
  environment: NodeJS.ProcessEnv = process.env,
  pluginPid = process.pid,
  dependencies: ProductionHostDependencies = defaultDependencies,
): Promise<void> {
  const packaged = environment.MEETLESS_RUNTIME_PACKAGED === "1" ||
    environment.MEETLESS_HOST_PROCESS_ENDPOINT !== undefined ||
    environment.MEETLESS_HOST_EXPECTED_NODE_PATH !== undefined;
  if (packaged) {
    if (environment.MEETLESS_RUNTIME_PACKAGED !== "1") {
      throw hostFailure("packaged plugin environment is missing the host-provided packaged marker");
    }
    await assertPackagedPluginProvenance(environment, pluginPid);
    return;
  }
  if (environment.MEETLESS_CAPTURE_MODE === "fixture") return;
  const hostPid = Number(environment.MEETLESS_HOST_PID);
  const bundlePath = environment.MEETLESS_HOST_BUNDLE_PATH?.trim();
  const identityPath = environment.MEETLESS_HOST_IDENTITY_PATH?.trim();
  if (!Number.isInteger(hostPid) || hostPid <= 1 || !bundlePath || !identityPath) {
    throw hostFailure("the daemon/plugin environment has no complete MeetlessHost attestation");
  }
  if (!isAncestor(pluginPid, hostPid, dependencies.parentPid)) {
    throw hostFailure(`configured host PID ${hostPid} is not an ancestor of plugin PID ${pluginPid}`);
  }

  let identity: z.infer<typeof HostIdentitySchema>;
  let live: ProcessExecutable;
  try {
    [identity, live] = await Promise.all([
      dependencies.readIdentity(identityPath),
      Promise.resolve(dependencies.executable(hostPid)),
    ]);
  } catch (error) {
    throw hostFailure(`cannot inspect the responsible host: ${describe(error)}`);
  }
  const canonicalBundle = await realpath(bundlePath).catch((error) => {
    throw hostFailure(`cannot resolve the responsible host bundle: ${describe(error)}`);
  });
  const canonicalExecutable = await realpath(live.path).catch((error) => {
    throw hostFailure(`cannot resolve the live host executable: ${describe(error)}`);
  });
  if (
    canonicalBundle !== identity.bundleRealPath ||
    canonicalExecutable !== identity.executablePath ||
    live.device !== identity.binaryDevice ||
    live.inode !== identity.binaryInode ||
    live.size !== identity.binarySize
  ) {
    throw hostFailure("the live host executable path/device/inode/size differs from the installed identity");
  }
  const binary = await readFile(canonicalExecutable);
  const digest = createHash("sha256").update(binary).digest("hex");
  if (digest !== identity.binarySha256) throw hostFailure("the live host executable hash differs from the installed identity");
  const code = dependencies.inspectCode(canonicalBundle);
  if (code.cdHash !== identity.cdHash || code.designatedRequirement !== identity.designatedRequirement) {
    throw hostFailure("the live host CDHash/designated requirement differs from the installed identity");
  }
}

export async function registerPackagedCaptureHelper(
  childPid: number,
  registrationToken: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  if (environment.MEETLESS_RUNTIME_PACKAGED !== "1") {
    throw hostFailure("capture-helper registration requires the host-provided packaged runtime");
  }
  const authority = await requirePackagedProcessAuthority(environment);
  if (!Number.isInteger(childPid) || childPid <= 1 || !validToken(registrationToken)) {
    throw hostFailure("capture-helper registration has an invalid child PID or registration token");
  }
  const expectedPath = requiredPackagedEnvironment(environment, "MEETLESS_HOST_EXPECTED_CAPTURE_HELPER_PATH");
  const expected = await configuredProcessIdentity(expectedPath, [expectedPath]);
  const policy = packagedProcessPolicy(environment);
  const response = await requestHostProcessProtocol(
    runtimeEndpoint(environment, "transcription").bindArgument,
    {
      version: 1,
      requestId: randomUUID(),
      operation: "registerChild",
      generation: authority.generation,
      ownerToken: authority.registrationToken,
      registrationToken,
      role: "capture-helper",
      childPid,
      expectedIdentity: expected,
      policy,
    },
  );
  if (
    response.type !== "host.process.registration" ||
    response.role !== "capture-helper" ||
    response.processPid !== childPid ||
    response.generation !== authority.generation ||
    response.registrationToken !== registrationToken
  ) {
    throw hostFailure("native capture-helper registration is not bound to the spawned child and launch generation");
  }
  return async () => {
    const release = await requestHostProcessProtocol(
      runtimeEndpoint(environment, "transcription").bindArgument,
      {
        version: 1,
        requestId: randomUUID(),
        operation: "releaseChild",
        generation: authority.generation,
        ownerToken: authority.registrationToken,
        childPid,
      },
    );
    if (
      release.type !== "host.process.release" ||
      release.processPid !== childPid ||
      release.generation !== authority.generation
    ) {
      throw hostFailure("native capture-helper release is not bound to the registered child and launch generation");
    }
  };
}

async function requirePackagedProcessAuthority(environment: NodeJS.ProcessEnv): Promise<PackagedProcessAuthority> {
  const cached = packagedProcessAuthorities.get(environment);
  if (cached) return cached;
  const authority = await assertPackagedPluginProvenance(environment, process.pid);
  const resolved = authority ?? packagedProcessAuthorities.get(environment);
  if (!resolved) throw hostFailure("packaged plugin attestation did not establish a native process authority");
  return resolved;
}

async function assertPackagedPluginProvenance(
  environment: NodeJS.ProcessEnv,
  pluginPid: number,
): Promise<PackagedProcessAuthority | undefined> {
  const cached = packagedProcessAuthorities.get(environment);
  if (cached) {
    if (pluginPid !== process.pid) throw hostFailure("packaged plugin attestation PID differs from this process");
    return cached;
  }
  const generation = positiveInteger(environment.MEETLESS_HOST_PROCESS_GENERATION);
  const ownerToken = requiredPackagedEnvironment(environment, "MEETLESS_HOST_PROCESS_TOKEN");
  const expectedNodePath = requiredPackagedEnvironment(environment, "MEETLESS_HOST_EXPECTED_NODE_PATH");
  const expectedPluginPath = requiredPackagedEnvironment(environment, "MEETLESS_HOST_EXPECTED_PLUGIN_PATH");
  const expectedArguments = parseExpectedPluginArguments(environment, expectedNodePath, expectedPluginPath);
  const expected = await configuredProcessIdentity(expectedNodePath, expectedArguments);
  const policy = packagedProcessPolicy(environment);
  const registrationToken = randomUUID();
  const socketPath = runtimeEndpoint(environment, "transcription").bindArgument;
  const registration = await requestHostProcessProtocol(socketPath, {
    version: 1,
    requestId: randomUUID(),
    operation: "registerChild",
    generation,
    ownerToken,
    registrationToken,
    role: "plugin",
    childPid: pluginPid,
    expectedIdentity: expected,
    policy,
  });
  if (
    registration.type !== "host.process.registration" ||
    registration.role !== "plugin" ||
    registration.processPid !== pluginPid ||
    registration.generation !== generation ||
    registration.registrationToken !== registrationToken
  ) {
    throw hostFailure("native plugin registration is not bound to this process and launch generation");
  }
  const attestation = await requestHostProcessProtocol(socketPath, {
    version: 1,
    requestId: randomUUID(),
    operation: "processAttestation",
    generation,
    registrationToken,
    role: "plugin",
  });
  const hostIdentity = await readPackagedHostIdentity(environment);
  if (
    attestation.type !== "host.process.attestation" ||
    attestation.role !== "plugin" ||
    attestation.processPid !== pluginPid ||
    attestation.generation !== generation
  ) {
    throw hostFailure("native plugin attestation is not bound to this process and launch generation");
  }
  assertProcessIdentity(attestation.identity, expected, "plugin");
  assertHostIdentityAttestation(attestation.host, hostIdentity);
  const authority: PackagedProcessAuthority = { generation, registrationToken, identity: attestation.identity };
  packagedProcessAuthorities.set(environment, authority);
  return authority;
}

function packagedProcessPolicy(environment: NodeJS.ProcessEnv): HostProcessPolicy {
  const recording = runtimeEndpoint(environment, "recording");
  const transcription = runtimeEndpoint(environment, "transcription");
  if (recording.workingDirectory !== transcription.workingDirectory) {
    throw hostFailure("packaged endpoint working directories differ");
  }
  return {
    runtimeRoot: transcription.workingDirectory,
    endpointPolicy: "MEETLESS_RUNTIME_ENDPOINTS v1",
    endpointWorkingDirectory: "runtime-root",
    recordingEndpointName: recording.name,
    transcriptionEndpointName: transcription.name,
  };
}

function parseExpectedPluginArguments(
  environment: NodeJS.ProcessEnv,
  expectedNodePath: string,
  expectedPluginPath: string,
): string[] {
  const raw = requiredPackagedEnvironment(environment, "MEETLESS_HOST_EXPECTED_PLUGIN_ARGV");
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw hostFailure("packaged plugin argv policy is not valid JSON"); }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    decoded[0] !== expectedNodePath ||
    decoded[1] !== expectedPluginPath ||
    decoded.some((value) => typeof value !== "string" || !value || value !== value.trim() || value.includes("\0"))
  ) {
    throw hostFailure("packaged plugin argv policy is incomplete or differs from the native host policy");
  }
  return decoded;
}

async function readPackagedHostIdentity(environment: NodeJS.ProcessEnv): Promise<HostIdentity> {
  const identityPath = requiredPackagedEnvironment(environment, "MEETLESS_HOST_IDENTITY_PATH");
  try { return HostIdentitySchema.parse(JSON.parse(await readFile(identityPath, "utf8"))); }
  catch (error) { throw hostFailure(`cannot read the native host identity: ${describe(error)}`); }
}

async function configuredProcessIdentity(executable: string, argv: string[]): Promise<HostProcessIdentity> {
  if (
    !path.isAbsolute(executable) ||
    !argv.length ||
    argv.some((argument) => !path.isAbsolute(argument) && argument !== "daemon" && argument !== "desktop" && argument !== "plugin") ||
    argv.some((argument) => !argument || argument !== argument.trim() || argument.includes("\0"))
  ) {
    throw hostFailure("packaged process identity contains an empty, whitespace, or non-absolute field");
  }
  const [info, realPath, bytes] = await Promise.all([stat(executable), realpath(executable), readFile(executable)]);
  return {
    configuredPath: path.resolve(executable),
    realPath,
    device: info.dev,
    inode: info.ino,
    byteLength: info.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    argv,
  };
}

function assertProcessIdentity(actual: HostProcessIdentity, expected: HostProcessIdentity, role: string): void {
  if (
    actual.configuredPath !== expected.configuredPath ||
    actual.realPath !== expected.realPath ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.byteLength !== expected.byteLength ||
    actual.sha256 !== expected.sha256 ||
    actual.argv.length !== expected.argv.length ||
    actual.argv.some((argument, index) => argument !== expected.argv[index])
  ) throw hostFailure(`native ${role} executable identity or argv differs from the configured package resource`);
}

function assertHostIdentityAttestation(actual: HostIdentityAttestation, expected: HostIdentity): void {
  if (
    actual.bundleIdentifier !== expected.bundleIdentifier ||
    actual.bundlePath !== expected.bundlePath ||
    actual.bundleRealPath !== expected.bundleRealPath ||
    actual.executablePath !== expected.executablePath ||
    actual.designatedRequirement !== expected.designatedRequirement ||
    actual.cdHash !== expected.cdHash ||
    actual.binarySha256 !== expected.binarySha256 ||
    actual.binaryDevice !== expected.binaryDevice ||
    actual.binaryInode !== expected.binaryInode ||
    actual.binarySize !== expected.binarySize
  ) throw hostFailure("native host attestation differs from the recorded installed host identity");
}

function positiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw hostFailure("packaged process generation is invalid");
  return parsed;
}

function requiredPackagedEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw hostFailure(`packaged process environment is missing ${key}`);
  return value;
}

function validToken(value: string): boolean {
  return value.length > 0 && value === value.trim() && value.length <= 4096 && !value.includes("\0");
}

type HostIdentity = z.infer<typeof HostIdentitySchema>;

export async function assertCapturePermissionsReady(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.MEETLESS_CAPTURE_MODE === "fixture") return;
  let socketPath: string;
  try {
    socketPath = runtimeEndpoint(environment, "transcription").bindArgument;
  } catch (error) {
    throw hostFailure(error instanceof Error ? error.message : String(error));
  }
  const requestId = randomUUID();
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", () => reject(hostFailure("the native capture-permission check failed")));
    socket.once("connect", () => socket.end(`${JSON.stringify({ version: 1, requestId, operation: "capturePermissionStatus" })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>); }
      catch { reject(hostFailure("the native capture-permission response is invalid")); }
    });
  });
  assertCapturePermissionResponse(response, requestId);
}

export function assertCapturePermissionResponse(response: Record<string, unknown>, requestId: string): void {
  if (response.requestId !== requestId || response.type !== "capture.permissions" || response.ok !== true) {
    throw hostFailure("the native capture-permission response is invalid");
  }
  if (response.microphone !== "authorized") {
    throw hostFailure(`capture permission microphone/${String(response.microphone)} is not ready`);
  }
  if (response.systemAudio !== "authorized") {
    throw hostFailure(`capture permission systemAudio/${String(response.systemAudio)} is not ready`);
  }
}

function isAncestor(candidatePid: number, ancestorPid: number, parentPid: (pid: number) => number): boolean {
  let current = candidatePid;
  const visited = new Set<number>();
  while (current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true;
    visited.add(current);
    current = parentPid(current);
    if (!Number.isInteger(current)) return false;
  }
  return false;
}

function inspectProcessExecutable(pid: number): ProcessExecutable {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-FDsin"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`lsof cannot inspect PID ${pid}`);
  const entries = result.stdout.split("ftxt\n").slice(1);
  for (const entry of entries) {
    const fields = Object.fromEntries(entry.split("\n").filter(Boolean).map((line) => [line[0], line.slice(1)]));
    if (!fields.n || !fields.D || !fields.i || !fields.s) continue;
    return {
      path: fields.n,
      device: Number(fields.D),
      inode: Number(fields.i),
      size: Number(fields.s),
    };
  }
  throw new Error(`lsof did not report a live executable identity for PID ${pid}`);
}

function inspectCodeIdentity(bundle: string): { cdHash: string; designatedRequirement: string } {
  const details = inspectRequiredOutput("codesign", ["-d", "--verbose=4", "-r-", bundle], "code identity");
  const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(details)?.[1];
  const designatedRequirement = /^(?:# )?designated => (.+)$/mu.exec(details)?.[1];
  if (!cdHash || !designatedRequirement) throw new Error("codesign did not report the host CDHash/designated requirement");
  return { cdHash, designatedRequirement };
}

function inspectRequired(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect ${fact}`);
  return result.stdout.trim();
}

function inspectRequiredOutput(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect ${fact}`);
  return `${result.stdout}\n${result.stderr}`.trim();
}

function hostFailure(reason: string): Error {
  return new Error(
    `Production recording start rejected before helper spawn: ${reason}. Authority: ${AUTHORITY}. ` +
    "Next action: stop the direct daemon/plugin runtime and launch with npm run runtime:host.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
