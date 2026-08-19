import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WebSocketLike } from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  RecordingRuntimeBootstrapOutputSchema,
  RecordingRuntimeReadinessResponseSchema,
  type CollisionEvidence,
  type RecordingRuntimeReadinessResponse,
} from "@meetless/plugin/readiness-protocol";
import WebSocket from "ws";
import { REPOSITORY_ROOT, type RuntimeConfig } from "./config.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";

export const RECORDING_READINESS_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";

type ReadinessOperation = "status" | "prepareCollision" | "validateCollision";
type ProcessEntry = { pid: number; ppid: number; command: string };

interface LiveProcessInspection {
  executablePath(pid: number): Promise<string>;
  argumentVector(pid: number): Promise<string[]>;
}

interface ReadinessOperationContext {
  signal: AbortSignal;
  deadline: number;
}

export interface DaemonMeetlessPluginAttestation {
  pluginId: "meetless";
  sourcePath: string;
  status: "running";
  runtimeInstanceId: string;
  pluginPid: number;
}

export type AuthoritativeRecordingRuntime = RecordingRuntimeReadinessResponse & {
  daemonPlugin: DaemonMeetlessPluginAttestation;
};

export interface RecordingReadinessDependencies {
  bootstrapPlugin(config: RuntimeConfig, context: ReadinessOperationContext): Promise<DaemonMeetlessPluginAttestation>;
  requestReadiness(
    socketPath: string,
    operation: ReadinessOperation,
    context?: ReadinessOperationContext,
  ): Promise<RecordingRuntimeReadinessResponse>;
  verifyOwnership(
    config: RuntimeConfig,
    response: RecordingRuntimeReadinessResponse,
    daemonPlugin: DaemonMeetlessPluginAttestation,
    context: ReadinessOperationContext,
  ): Promise<void>;
  delay(milliseconds: number, context: ReadinessOperationContext): Promise<void>;
}

export interface RuntimeReadinessReport {
  authority: string;
  captureMode: "production";
  supervisor: { pid: number; live: boolean };
  daemon: { pid: number; listen: string };
  plugin: {
    id: "meetless";
    pid: number;
    live: boolean;
    instanceId: string;
    startedAt: string;
    sourcePath: string;
    sourceRealPath: string;
  };
  socket: {
    path: string;
    live: true;
    authoritativeStatus: true;
    device: number;
    inode: number;
  };
  helper: null | {
    pid: number;
    live: true;
    mode: "production";
    path: string;
    realPath: string;
    sha256: string;
    arguments: string[];
  };
  session: {
    status: RecordingRuntimeReadinessResponse["status"]["status"];
    recordingId: string | null;
    meetingId: string | null;
    paused: boolean;
    error: string | null;
  };
  chunks: { microphone: number; system: number; total: number; evidencePaths: string[] };
  stopTarget: { command: "Electron recording control: stop"; prepared: boolean };
  collisionTarget: CollisionEvidence | null;
}

const defaultDependencies: RecordingReadinessDependencies = {
  bootstrapPlugin: async (config, context) => {
    const daemon = new DaemonClient({
      url: `ws://${config.listen}/ws`,
      clientId: `meetless-readiness-${process.pid}-${randomUUID()}`,
      clientType: "cli",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
      reconnect: { enabled: false },
      connectTimeoutMs: Math.max(1, context.deadline - Date.now()),
    });
    const close = () => { void daemon.close().catch(() => undefined); };
    context.signal.addEventListener("abort", close, { once: true });
    try {
      context.signal.throwIfAborted();
      await daemon.connect();
      context.signal.throwIfAborted();
      if (daemon.getLastServerInfoMessage()?.features?.plugins !== true) {
        throw new Error("daemon does not advertise plugin support");
      }
      const catalog = await daemon.getPluginCatalog();
      context.signal.throwIfAborted();
      if (!catalog.some((plugin) => plugin.id === "meetless")) {
        throw new Error('daemon catalog does not contain the required "meetless" plugin');
      }
      const listed = (await daemon.listPlugins()).find((plugin) => plugin.id === "meetless");
      context.signal.throwIfAborted();
      if (!listed || listed.status !== "running") {
        throw new Error('daemon does not report the configured "meetless" plugin as running');
      }
      const nonce = randomUUID();
      const bootstrap = RecordingRuntimeBootstrapOutputSchema.parse(
        await daemon.invokePluginRpc("meetless", "runtime.readiness.bootstrap", {
          nonce,
          deadlineEpochMs: context.deadline,
        }),
      );
      context.signal.throwIfAborted();
      if (bootstrap.nonce !== nonce) throw new Error("Meetless bootstrap nonce was not correlated");
      return {
        pluginId: "meetless",
        sourcePath: listed.path,
        status: "running",
        runtimeInstanceId: bootstrap.runtimeInstanceId,
        pluginPid: bootstrap.pluginPid,
      };
    } finally {
      context.signal.removeEventListener("abort", close);
      await daemon.close().catch(() => undefined);
    }
  },
  requestReadiness: requestRecordingRuntimeReadiness,
  verifyOwnership: async (config, response, daemonPlugin) => {
    await inspectOwnedRuntime(config, response, daemonPlugin);
  },
  delay: (milliseconds, context) => abortableDelay(milliseconds, context.signal),
};

export async function waitForRecordingRuntime(
  config: RuntimeConfig,
  input: {
    timeoutMs?: number;
    retryMs?: number;
    signal?: AbortSignal;
    dependencies?: Partial<RecordingReadinessDependencies>;
  } = {},
): Promise<AuthoritativeRecordingRuntime> {
  assertProductionCapture(config);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const retryMs = input.retryMs ?? 100;
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const deadline = Date.now() + timeoutMs;
  let pluginBootstrapped = false;
  let daemonPlugin: DaemonMeetlessPluginAttestation | null = null;
  let lastError: unknown;
  input.signal?.throwIfAborted();

  do {
    try {
      if (!pluginBootstrapped) {
        daemonPlugin = await beforeDeadline(
          (context) => dependencies.bootstrapPlugin(config, context),
          deadline,
          "Meetless plugin bootstrap",
          input.signal,
        );
        pluginBootstrapped = true;
      }
      const response = await beforeDeadline(
        (context) => dependencies.requestReadiness(config.paths.recordingSocket, "status", context),
        deadline,
        "authoritative recording status",
        input.signal,
      );
      await assertRuntimeAttestation(config, response);
      await assertDaemonPluginAttestation(config, daemonPlugin!, response);
      await beforeDeadline(
        (context) => dependencies.verifyOwnership(config, response, daemonPlugin!, context),
        deadline,
        "plugin process ownership",
        input.signal,
      );
      return Object.assign(response, { daemonPlugin: daemonPlugin! });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (error instanceof Error && error.message.startsWith("Production desktop recording readiness failed closed")) {
        throw error;
      }
      const outerDeadline = error instanceof Error && error.message.includes("exceeded the outer startup deadline");
      if (!outerDeadline || lastError === undefined) lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await beforeDeadline(
        (context) => dependencies.delay(Math.min(retryMs, remaining), context),
        deadline,
        "readiness retry",
        input.signal,
      );
    }
  } while (Date.now() <= deadline);

  const stage = pluginBootstrapped ? "authoritative recording status" : "Meetless plugin bootstrap";
  throw readinessFailure(stage, config, lastError);
}

export async function requestRecordingRuntimeReadiness(
  socketPath: string,
  operation: ReadinessOperation = "status",
  context?: ReadinessOperationContext,
): Promise<RecordingRuntimeReadinessResponse> {
  context?.signal.throwIfAborted();
  const before = await socketIdentity(socketPath);
  const requestId = `readiness-${process.pid}-${randomUUID()}`;
  const remaining = context ? Math.max(1, context.deadline - Date.now()) : 2_000;
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`, { handshakeTimeout: Math.min(2_000, remaining) });
  const abort = () => socket.terminate();
  context?.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { socket.off("error", onError); resolve(); };
      const onError = (error: Error) => { socket.off("open", onOpen); reject(error); };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    const response = new Promise<RecordingRuntimeReadinessResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const onClose = () => { cleanup(); reject(new Error("runtime readiness socket closed before response")); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const parsed = RecordingRuntimeReadinessResponseSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success || parsed.data.requestId !== requestId) return;
          cleanup();
          if (!parsed.data.ok) reject(new Error(parsed.data.error ?? "runtime readiness request failed"));
          else resolve(parsed.data);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("runtime readiness request timed out"));
      }, Math.min(2_000, remaining));
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
    socket.send(JSON.stringify({ version: 1, requestId, command: "runtime.readiness", operation }));
    const attested = await response;
    const after = await socketIdentity(socketPath);
    if (!sameSocket(before, after) || !sameSocket(after, attested.runtime.socketIdentity)) {
      throw new Error("recording socket was replaced or the responding listener does not own its inode");
    }
    return attested;
  } finally {
    context?.signal.removeEventListener("abort", abort);
    socket.terminate();
  }
}

export async function inspectRuntimeReadiness(
  config: RuntimeConfig,
  attestation: AuthoritativeRecordingRuntime,
): Promise<RuntimeReadinessReport> {
  assertProductionCapture(config);
  await assertRuntimeAttestation(config, attestation);
  await assertDaemonPluginAttestation(config, attestation.daemonPlugin, attestation);
  const ownership = await inspectOwnedRuntime(config, attestation, attestation.daemonPlugin);
  const { lock, daemonPid } = ownership;
  const currentSocket = await socketIdentity(config.paths.recordingSocket).catch(() => null);
  if (!currentSocket || !sameSocket(currentSocket, attestation.runtime.socketIdentity)) {
    throw readinessFailure("live recording socket", config, new Error("socket inode changed after authoritative status"));
  }
  const status = attestation.status;
  const evidencePaths = await Promise.all(status.chunks.map(async (chunk) => {
    const candidate = path.resolve(config.paths.meetingStore, chunk.storageKey);
    const relative = path.relative(config.paths.meetingStore, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw readinessFailure("committed chunk evidence", config, new Error(`chunk escapes store: ${chunk.storageKey}`));
    }
    const bytes = await readFile(candidate).catch((error) => {
      throw readinessFailure("committed chunk evidence", config, error);
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== chunk.byteLength || sha256 !== chunk.sha256) {
      throw readinessFailure("committed chunk evidence", config, new Error(`identity changed: ${candidate}`));
    }
    return candidate;
  }));
  const capture = attestation.runtime.capture;
  return {
    authority: RECORDING_READINESS_AUTHORITY,
    captureMode: "production",
    supervisor: { pid: lock.pid, live: true },
    daemon: { pid: daemonPid, listen: config.listen },
    plugin: {
      id: "meetless",
      pid: attestation.runtime.pluginPid,
      live: true,
      instanceId: attestation.runtime.instanceId,
      startedAt: attestation.runtime.startedAt,
      sourcePath: attestation.daemonPlugin.sourcePath,
      sourceRealPath: await realpath(attestation.daemonPlugin.sourcePath),
    },
    socket: {
      path: config.paths.recordingSocket,
      live: true,
      authoritativeStatus: true,
      ...attestation.runtime.socketIdentity,
    },
    helper: capture.helperPid ? {
      pid: capture.helperPid,
      live: true,
      mode: "production",
      path: capture.executable.configuredPath,
      realPath: capture.executable.realPath,
      sha256: capture.executable.sha256,
      arguments: capture.arguments,
    } : null,
    session: {
      status: status.status,
      recordingId: status.recordingId,
      meetingId: status.meetingId,
      paused: status.paused,
      error: status.error,
    },
    chunks: { microphone: status.microphoneCount, system: status.systemCount, total: status.chunkCount, evidencePaths },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
}

async function inspectOwnedRuntime(
  config: RuntimeConfig,
  attestation: RecordingRuntimeReadinessResponse,
  daemonPlugin: DaemonMeetlessPluginAttestation,
): Promise<{ lock: NonNullable<Awaited<ReturnType<typeof readPidLock>>>; daemonPid: number }> {
  const lock = await readPidLock(config.paths.pidLock);
  if (!lock) throw readinessFailure("supervisor identity", config, new Error("PID lock is unavailable"));
  const live = inspectLiveProcess({
    pid: lock.pid,
    expectedListen: config.listen,
    expectedPaseoHome: config.paths.paseoHome,
    expectedSupervisorEntrypoint: config.supervisorEntrypoint,
  });
  assertStopAuthorization({
    lock,
    expectedListen: config.listen,
    expectedPaseoHome: config.paths.paseoHome,
    expectedSupervisorEntrypoint: config.supervisorEntrypoint,
    live,
  });
  const daemonPid = live.listener?.belongsToSupervisor ? live.listener.pid : null;
  if (!live.running || !daemonPid) {
    throw readinessFailure("live daemon listener", config, new Error("owned daemon listener is unavailable"));
  }
  const processes = inspectProcesses();
  await assertAttestedProcessOwnership({
    daemonPid,
    pluginPid: attestation.runtime.pluginPid,
    daemonPluginPid: daemonPlugin.pluginPid,
    helperPid: attestation.runtime.capture.helperPid,
    helperExecutable: attestation.runtime.capture.executable,
    helperArguments: attestation.runtime.capture.arguments,
    processes,
  });
  return { lock, daemonPid };
}

export function assertPreOwnerRecordingReady(report: RuntimeReadinessReport): void {
  const failures: string[] = [];
  if (report.session.status !== "recording") failures.push(`session is ${report.session.status}, not recording`);
  if (report.session.error) failures.push(`recorder error: ${report.session.error}`);
  if (report.session.paused) failures.push("session is paused");
  if (!report.helper?.live) failures.push("production capture helper is not live");
  if (report.chunks.microphone < 1) failures.push("no committed microphone chunk exists");
  if (report.chunks.system < 1) failures.push("no committed system chunk exists");
  if (failures.length > 0) {
    throw new Error(
      `Pre-owner recording readiness failed closed: ${failures.join("; ")}. ` +
        `Start recording only through the Electron controls, wait for both sources, then rerun npm run runtime:preowner. ` +
        `Authority: ${RECORDING_READINESS_AUTHORITY}.`,
    );
  }
}

export async function prepareCollisionEvidence(
  config: RuntimeConfig,
  report: RuntimeReadinessReport,
  requestReadiness: RecordingReadinessDependencies["requestReadiness"] = requestRecordingRuntimeReadiness,
): Promise<RuntimeReadinessReport> {
  assertPreOwnerRecordingReady(report);
  const prepared = await requestReadiness(config.paths.recordingSocket, "prepareCollision").catch((error) => {
    throw readinessFailure("collision evidence preparation", config, error);
  });
  await assertRuntimeAttestation(config, prepared);
  if (
    prepared.runtime.instanceId !== report.plugin.instanceId ||
    prepared.runtime.pluginPid !== report.plugin.pid ||
    prepared.runtime.socketIdentity.device !== report.socket.device ||
    prepared.runtime.socketIdentity.inode !== report.socket.inode ||
    prepared.runtime.capture.helperPid !== report.helper?.pid ||
    prepared.status.recordingId !== report.session.recordingId ||
    !prepared.collision
  ) {
    throw readinessFailure("collision evidence binding", config, new Error("runtime instance or recording changed during pre-owner proof"));
  }
  return {
    ...report,
    stopTarget: { ...report.stopTarget, prepared: true },
    collisionTarget: prepared.collision,
  };
}

export async function verifyCollisionEvidence(report: RuntimeReadinessReport): Promise<boolean> {
  if (!report.collisionTarget) return false;
  const bytes = await readFile(report.collisionTarget.path);
  return bytes.byteLength === report.collisionTarget.byteLength &&
    createHash("sha256").update(bytes).digest("hex") === report.collisionTarget.sha256;
}

export async function assertAttestedProcessOwnership(input: {
  daemonPid: number;
  pluginPid: number;
  daemonPluginPid: number;
  helperPid: number | null;
  helperExecutable: RecordingRuntimeReadinessResponse["runtime"]["capture"]["executable"];
  helperArguments: string[];
  processes: ProcessEntry[];
  inspection?: LiveProcessInspection;
}): Promise<void> {
  if (input.pluginPid !== input.daemonPluginPid) {
    throw new Error(
      `socket plugin PID ${input.pluginPid} does not match daemon-routed Meetless plugin PID ${input.daemonPluginPid}; ` +
      `authority ${RECORDING_READINESS_AUTHORITY}, restart the isolated runtime`,
    );
  }
  const plugin = input.processes.find((candidate) => candidate.pid === input.pluginPid);
  if (!plugin || !isDescendant(plugin.pid, input.daemonPid, input.processes)) {
    throw new Error(
      `daemon-routed Meetless plugin PID ${input.pluginPid} is not an owned daemon descendant; ` +
      `authority ${RECORDING_READINESS_AUTHORITY}, restart the isolated runtime`,
    );
  }
  if (input.helperPid === null) return;
  const helper = input.processes.find((candidate) => candidate.pid === input.helperPid);
  if (!helper || !isDescendant(helper.pid, plugin.pid, input.processes)) {
    throw new Error(`authoritative capture helper PID ${input.helperPid} is not a descendant of plugin PID ${plugin.pid}`);
  }
  const inspection = input.inspection ?? defaultLiveProcessInspection;
  const [osExecutablePath, argumentVector] = await Promise.all([
    inspection.executablePath(input.helperPid),
    inspection.argumentVector(input.helperPid),
  ]);
  const [osRealPath, osInfo, osBytes] = await Promise.all([
    realpath(osExecutablePath),
    stat(osExecutablePath),
    readFile(osExecutablePath),
  ]);
  const executable = input.helperExecutable;
  const osHash = createHash("sha256").update(osBytes).digest("hex");
  if (
    osRealPath !== executable.realPath ||
    osInfo.dev !== executable.device ||
    osInfo.ino !== executable.inode ||
    osInfo.size !== executable.byteLength ||
    osHash !== executable.sha256
  ) {
    throw new Error(
      `live capture helper PID ${input.helperPid} executable ${osExecutablePath} does not match the attested production helper; ` +
      `authority ${RECORDING_READINESS_AUTHORITY}, stop the runtime and rebuild the native helper`,
    );
  }
  const expectedArguments = [executable.configuredPath, ...input.helperArguments];
  if (
    input.helperArguments.length > 0 ||
    argumentVector.length !== expectedArguments.length ||
    argumentVector.some((argument, index) => argument !== expectedArguments[index])
  ) {
    throw new Error(
      `live capture helper PID ${input.helperPid} has unexpected native argv ${JSON.stringify(argumentVector)}; ` +
      `production requires exactly ${JSON.stringify(expectedArguments)} with no empty, whitespace, fixture, or wrapper arguments. ` +
      `Authority: ${RECORDING_READINESS_AUTHORITY}. Next action: stop the isolated runtime and restart without helper arguments.`,
    );
  }
}

function assertProductionCapture(config: RuntimeConfig): void {
  if (config.environment.MEETLESS_CAPTURE_MODE === "fixture") {
    throw new Error(
      `Production desktop readiness rejects MEETLESS_CAPTURE_MODE=fixture. Remove fixture mode and rebuild before owner participation. ` +
        `Authority: ${RECORDING_READINESS_AUTHORITY}.`,
    );
  }
}

async function assertRuntimeAttestation(
  config: RuntimeConfig,
  response: RecordingRuntimeReadinessResponse,
): Promise<void> {
  const runtime = response.runtime;
  if (runtime.socketPath !== config.paths.recordingSocket) {
    throw readinessFailure("recording socket ownership", config, new Error(`plugin attested unexpected socket ${runtime.socketPath}`));
  }
  if (runtime.capture.mode !== "production") {
    throw readinessFailure("production capture helper", config, new Error(`plugin attested ${runtime.capture.mode} capture mode`));
  }
  if (runtime.capture.arguments.length > 0) {
    throw readinessFailure(
      "production capture helper",
      config,
      new Error(`helper arguments are forbidden in production: ${runtime.capture.arguments.join(" ")}`),
    );
  }
  if (runtime.export.fixtureStampApplied) {
    throw readinessFailure("production export configuration", config, new Error("fixture export stamp affected production runtime"));
  }
  if (path.resolve(runtime.export.root) !== path.resolve(config.paths.recordingExports)) {
    throw readinessFailure("production export configuration", config, new Error("daemon export root differs from launcher configuration"));
  }
  const [configuredInfo, configuredRealPath, helperBytes] = await Promise.all([
    stat(config.paths.captureHelper),
    realpath(config.paths.captureHelper),
    readFile(config.paths.captureHelper),
  ]);
  const executable = runtime.capture.executable;
  const expectedHash = createHash("sha256").update(helperBytes).digest("hex");
  if (
    path.resolve(executable.configuredPath) !== path.resolve(config.paths.captureHelper) ||
    executable.realPath !== configuredRealPath ||
    executable.device !== configuredInfo.dev ||
    executable.inode !== configuredInfo.ino ||
    executable.byteLength !== configuredInfo.size ||
    executable.sha256 !== expectedHash
  ) {
    throw readinessFailure("production capture helper", config, new Error("daemon helper executable identity differs from launcher configuration"));
  }
}

async function assertDaemonPluginAttestation(
  config: RuntimeConfig,
  daemonPlugin: DaemonMeetlessPluginAttestation,
  response: RecordingRuntimeReadinessResponse,
): Promise<void> {
  const [configuredSource, daemonSource] = await Promise.all([
    realpath(config.paths.plugin),
    realpath(daemonPlugin.sourcePath).catch(() => ""),
  ]);
  if (
    daemonPlugin.pluginId !== "meetless" ||
    daemonPlugin.status !== "running" ||
    path.resolve(daemonPlugin.sourcePath) !== path.resolve(config.paths.plugin) ||
    daemonSource !== configuredSource ||
    daemonPlugin.runtimeInstanceId !== response.runtime.instanceId ||
    daemonPlugin.pluginPid !== response.runtime.pluginPid
  ) {
    throw readinessFailure(
      "daemon Meetless plugin identity",
      config,
      new Error(
        `daemon plugin ${daemonPlugin.pluginId} at ${daemonPlugin.sourcePath} PID ${daemonPlugin.pluginPid} ` +
        `does not match the socket runtime. Require active plugin ID "meetless" from ${config.paths.plugin}, ` +
        `then restart the isolated runtime`,
      ),
    );
  }
}

function readinessFailure(stage: string, config: RuntimeConfig, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Production desktop recording readiness failed closed at ${stage}: ${reason}. ` +
      `Socket existence at ${config.paths.recordingSocket} is not readiness; no desktop controls were exposed. ` +
      `Authority: ${RECORDING_READINESS_AUTHORITY}. Next action: inspect ${config.paths.daemonLog}, ` +
      `run npm run runtime:stop for this isolated runtime, then retry npm run runtime:desktop.`,
  );
}

function inspectProcesses(): ProcessEntry[] {
  const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) throw new Error("Cannot inspect runtime process tree");
  return inspected.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

const defaultLiveProcessInspection: LiveProcessInspection = {
  executablePath: async (pid) => {
    const inspected = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], {
      encoding: "utf8",
    });
    if (inspected.error || inspected.status !== 0) {
      throw new Error(`cannot inspect executable for capture helper PID ${pid} with lsof`);
    }
    const lines = inspected.stdout.split("\n");
    const textIndex = lines.indexOf("ftxt");
    const executable = textIndex >= 0 ? lines[textIndex + 1] : undefined;
    if (!executable?.startsWith("n/") || executable.length <= 2) {
      throw new Error(`lsof did not report an executable for capture helper PID ${pid}`);
    }
    return executable.slice(1);
  },
  argumentVector: async (pid) => inspectNativeArgumentVector(pid),
};

export async function inspectNativeArgumentVector(pid: number): Promise<string[]> {
  if (process.platform !== "darwin") {
    throw new Error(`native capture-helper argv inspection requires macOS, received ${process.platform}`);
  }
  const inspector = path.join(REPOSITORY_ROOT, "packages/runtime/dist/meetless-process-argv");
  const inspected = spawnSync(inspector, [String(pid)], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    const reason = inspected.stderr.trim() || inspected.error?.message || `exit ${inspected.status ?? "unknown"}`;
    throw new Error(
      `cannot inspect native argv for capture helper PID ${pid}: ${reason}. ` +
      `Run npm run build:native, then restart the isolated runtime.`,
    );
  }
  let decoded: unknown;
  try { decoded = JSON.parse(inspected.stdout); } catch { decoded = null; }
  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.some((value) => typeof value !== "string")) {
    throw new Error(`native argv inspector returned an invalid vector for capture helper PID ${pid}`);
  }
  return decoded as string[];
}

function isDescendant(candidatePid: number, ancestorPid: number, processes: Array<{ pid: number; ppid: number }>): boolean {
  const byPid = new Map(processes.map((process) => [process.pid, process.ppid]));
  const visited = new Set<number>();
  let current = candidatePid;
  while (current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true;
    visited.add(current);
    current = byPid.get(current) ?? 0;
  }
  return false;
}

async function socketIdentity(socketPath: string): Promise<{ device: number; inode: number }> {
  const info = await stat(socketPath);
  if (!info.isSocket()) throw new Error(`recording socket inode is not a Unix socket: ${socketPath}`);
  return { device: info.dev, inode: info.ino };
}

function sameSocket(left: { device: number; inode: number }, right: { device: number; inode: number }): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function beforeDeadline<T>(
  operation: (context: ReadinessOperationContext) => Promise<T>,
  deadline: number,
  stage: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${stage} exceeded the outer startup deadline`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  let rejectParent: (() => void) | undefined;
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  const operationPromise = operation({ signal: controller.signal, deadline });
  try {
    return await Promise.race([
      operationPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`${stage} exceeded the outer startup deadline`));
          reject(new Error(`${stage} exceeded the outer startup deadline`));
        }, remaining);
      }),
      new Promise<T>((_, reject) => {
        if (!parentSignal) return;
        rejectParent = () => reject(parentSignal.reason instanceof Error ? parentSignal.reason : new Error("readiness aborted"));
        if (parentSignal.aborted) rejectParent();
        else parentSignal.addEventListener("abort", rejectParent, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (rejectParent) parentSignal?.removeEventListener("abort", rejectParent);
    if (timedOut || controller.signal.aborted) {
      await Promise.race([
        operationPromise.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("readiness operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
