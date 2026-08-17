import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { connectMeetlessClient } from "@meetless/client";
import {
  RecordingRuntimeReadinessResponseSchema,
  type CollisionEvidence,
  type RecordingRuntimeReadinessResponse,
} from "@meetless/plugin/readiness-protocol";
import WebSocket from "ws";
import type { RuntimeConfig } from "./config.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";

export const RECORDING_READINESS_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";

type ReadinessOperation = "status" | "prepareCollision" | "validateCollision";
type ProcessEntry = { pid: number; ppid: number; command: string };

export interface RecordingReadinessDependencies {
  bootstrapPlugin(config: RuntimeConfig): Promise<void>;
  requestReadiness(socketPath: string, operation: ReadinessOperation): Promise<RecordingRuntimeReadinessResponse>;
  verifyOwnership(config: RuntimeConfig, response: RecordingRuntimeReadinessResponse): Promise<void>;
  delay(milliseconds: number): Promise<void>;
}

export interface RuntimeReadinessReport {
  authority: string;
  captureMode: "production";
  supervisor: { pid: number; live: boolean };
  daemon: { pid: number; listen: string };
  plugin: { pid: number; live: boolean; instanceId: string; startedAt: string };
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
  bootstrapPlugin: async (config) => {
    const connected = await connectMeetlessClient({
      url: `ws://${config.listen}/ws`,
      clientId: `meetless-readiness-${process.pid}-${randomUUID()}`,
      clientType: "cli",
    });
    try { await connected.client.listMeetings(); }
    finally { await connected.close(); }
  },
  requestReadiness: requestRecordingRuntimeReadiness,
  verifyOwnership: async (config, response) => { await inspectOwnedRuntime(config, response); },
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function waitForRecordingRuntime(
  config: RuntimeConfig,
  input: {
    timeoutMs?: number;
    retryMs?: number;
    dependencies?: Partial<RecordingReadinessDependencies>;
  } = {},
): Promise<RecordingRuntimeReadinessResponse> {
  assertProductionCapture(config);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const retryMs = input.retryMs ?? 100;
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const deadline = Date.now() + timeoutMs;
  let pluginBootstrapped = false;
  let lastError: unknown;

  do {
    try {
      if (!pluginBootstrapped) {
        await beforeDeadline(() => dependencies.bootstrapPlugin(config), deadline, "Meetless plugin bootstrap");
        pluginBootstrapped = true;
      }
      const response = await beforeDeadline(
        () => dependencies.requestReadiness(config.paths.recordingSocket, "status"),
        deadline,
        "authoritative recording status",
      );
      await assertRuntimeAttestation(config, response);
      await beforeDeadline(
        () => dependencies.verifyOwnership(config, response),
        deadline,
        "plugin process ownership",
      );
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Production desktop recording readiness failed closed")) {
        throw error;
      }
      const outerDeadline = error instanceof Error && error.message.includes("exceeded the outer startup deadline");
      if (!outerDeadline || lastError === undefined) lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await beforeDeadline(() => dependencies.delay(Math.min(retryMs, remaining)), deadline, "readiness retry");
    }
  } while (Date.now() <= deadline);

  const stage = pluginBootstrapped ? "authoritative recording status" : "Meetless plugin bootstrap";
  throw readinessFailure(stage, config, lastError);
}

export async function requestRecordingRuntimeReadiness(
  socketPath: string,
  operation: ReadinessOperation = "status",
): Promise<RecordingRuntimeReadinessResponse> {
  const before = await socketIdentity(socketPath);
  const requestId = `readiness-${process.pid}-${randomUUID()}`;
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`, { handshakeTimeout: 2_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<RecordingRuntimeReadinessResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime readiness request timed out")), 2_000);
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const parsed = RecordingRuntimeReadinessResponseSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success || parsed.data.requestId !== requestId) return;
          clearTimeout(timer);
          socket.off("message", onMessage);
          if (!parsed.data.ok) reject(new Error(parsed.data.error ?? "runtime readiness request failed"));
          else resolve(parsed.data);
        } catch (error) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          reject(error);
        }
      };
      socket.on("message", onMessage);
    });
    socket.send(JSON.stringify({ version: 1, requestId, command: "runtime.readiness", operation }));
    const attested = await response;
    const after = await socketIdentity(socketPath);
    if (!sameSocket(before, after) || !sameSocket(after, attested.runtime.socketIdentity)) {
      throw new Error("recording socket was replaced or the responding listener does not own its inode");
    }
    return attested;
  } finally {
    socket.close();
  }
}

export async function inspectRuntimeReadiness(
  config: RuntimeConfig,
  attestation: RecordingRuntimeReadinessResponse,
): Promise<RuntimeReadinessReport> {
  assertProductionCapture(config);
  await assertRuntimeAttestation(config, attestation);
  const ownership = await inspectOwnedRuntime(config, attestation);
  const { lock, daemonPid } = ownership;
  const currentSocket = await socketIdentity(config.paths.recordingSocket).catch(() => null);
  if (!currentSocket || !sameSocket(currentSocket, attestation.runtime.socketIdentity)) {
    throw readinessFailure("live recording socket", config, new Error("socket inode changed after authoritative status"));
  }
  const status = attestation.status;
  const microphone = status.chunks.filter((chunk) => chunk.source === "microphone");
  const system = status.chunks.filter((chunk) => chunk.source === "system");
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
      pid: attestation.runtime.pluginPid,
      live: true,
      instanceId: attestation.runtime.instanceId,
      startedAt: attestation.runtime.startedAt,
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
    chunks: { microphone: microphone.length, system: system.length, total: status.chunks.length, evidencePaths },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
}

async function inspectOwnedRuntime(
  config: RuntimeConfig,
  attestation: RecordingRuntimeReadinessResponse,
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
  assertAttestedProcessOwnership({
    daemonPid,
    pluginPid: attestation.runtime.pluginPid,
    helperPid: attestation.runtime.capture.helperPid,
    helperRealPath: attestation.runtime.capture.executable.realPath,
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

export function assertAttestedProcessOwnership(input: {
  daemonPid: number;
  pluginPid: number;
  helperPid: number | null;
  helperRealPath: string;
  processes: ProcessEntry[];
}): void {
  const plugin = input.processes.find((candidate) => candidate.pid === input.pluginPid);
  if (!plugin || !isDescendant(plugin.pid, input.daemonPid, input.processes) || !plugin.command.includes("/plugin-process.js")) {
    throw new Error(`authoritative Meetless plugin PID ${input.pluginPid} is not an owned daemon descendant`);
  }
  if (input.helperPid === null) return;
  const helper = input.processes.find((candidate) => candidate.pid === input.helperPid);
  if (!helper || !isDescendant(helper.pid, plugin.pid, input.processes)) {
    throw new Error(`authoritative capture helper PID ${input.helperPid} is not a descendant of plugin PID ${plugin.pid}`);
  }
  if (path.resolve(helper.command.split(" ")[0] ?? "") !== path.resolve(input.helperRealPath)) {
    throw new Error(`authoritative capture helper PID ${input.helperPid} is not the attested production executable`);
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

async function beforeDeadline<T>(operation: () => Promise<T>, deadline: number, stage: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${stage} exceeded the outer startup deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} exceeded the outer startup deadline`)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
