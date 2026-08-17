import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectMeetlessClient } from "@meetless/client";
import {
  RecordingControlResponseSchema,
  type RecordingStatusWire,
} from "@meetless/meeting-contracts";
import WebSocket from "ws";
import type { RuntimeConfig } from "./config.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";

export const RECORDING_READINESS_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";

export interface RecordingReadinessDependencies {
  bootstrapPlugin(config: RuntimeConfig): Promise<void>;
  requestStatus(socketPath: string): Promise<RecordingStatusWire>;
  delay(milliseconds: number): Promise<void>;
}

export interface RuntimeReadinessReport {
  authority: string;
  captureMode: "production";
  supervisor: { pid: number; live: boolean };
  daemon: { pid: number; listen: string };
  plugin: { pid: number; live: boolean };
  socket: { path: string; live: true; authoritativeStatus: true };
  helper: { pid: number; live: true; mode: "production" } | null;
  session: {
    status: RecordingStatusWire["status"];
    recordingId: string | null;
    meetingId: string | null;
    paused: boolean;
    error: string | null;
  };
  chunks: {
    microphone: number;
    system: number;
    total: number;
    evidencePaths: string[];
  };
  stopTarget: { command: "Electron recording control: stop"; prepared: boolean };
  collisionTarget: null | {
    path: string;
    byteLength: number;
    sha256: string;
    plannedPublishedPath: string;
    validUntil: string;
  };
}

const defaultDependencies: RecordingReadinessDependencies = {
  bootstrapPlugin: async (config) => {
    const connected = await connectMeetlessClient({
      url: `ws://${config.listen}/ws`,
      clientId: `meetless-readiness-${process.pid}-${randomUUID()}`,
      clientType: "cli",
    });
    try {
      await connected.client.listMeetings();
    } finally {
      await connected.close();
    }
  },
  requestStatus: requestAuthoritativeRecordingStatus,
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function waitForRecordingRuntime(
  config: RuntimeConfig,
  input: {
    timeoutMs?: number;
    retryMs?: number;
    dependencies?: Partial<RecordingReadinessDependencies>;
  } = {},
): Promise<RecordingStatusWire> {
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
        await dependencies.bootstrapPlugin(config);
        pluginBootstrapped = true;
      }
      return await dependencies.requestStatus(config.paths.recordingSocket);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await dependencies.delay(retryMs);
    }
  } while (Date.now() <= deadline);

  const stage = pluginBootstrapped ? "authoritative recording status" : "Meetless plugin bootstrap";
  throw readinessFailure(stage, config, lastError);
}

export async function requestAuthoritativeRecordingStatus(socketPath: string): Promise<RecordingStatusWire> {
  const requestId = `readiness-${process.pid}-${randomUUID()}`;
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`, { handshakeTimeout: 2_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<RecordingStatusWire>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("status request timed out")), 2_000);
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const parsed = RecordingControlResponseSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success || parsed.data.requestId !== requestId) return;
          clearTimeout(timer);
          socket.off("message", onMessage);
          if (!parsed.data.ok) reject(new Error(parsed.data.error ?? "status request failed"));
          else resolve(parsed.data.status);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      };
      socket.on("message", onMessage);
    });
    socket.send(JSON.stringify({ version: 1, requestId, command: "status" }));
    return await response;
  } finally {
    socket.close();
  }
}

export async function inspectRuntimeReadiness(
  config: RuntimeConfig,
  status: RecordingStatusWire,
): Promise<RuntimeReadinessReport> {
  assertProductionCapture(config);
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
  const plugin = processes.find((candidate) =>
    isDescendant(candidate.pid, daemonPid, processes) && candidate.command.includes("/plugin-process.js"),
  );
  if (!plugin) throw readinessFailure("Meetless plugin process", config, new Error("plugin process is unavailable"));
  const helper = processes.find((candidate) =>
    isDescendant(candidate.pid, plugin.pid, processes) && candidate.command.split(" ")[0] === config.paths.captureHelper,
  );
  if (helper?.command.includes("--fixture")) {
    throw readinessFailure("production capture helper", config, new Error("fixture helper process is running"));
  }
  const socketInfo = await stat(config.paths.recordingSocket).catch(() => null);
  if (!socketInfo?.isSocket()) {
    throw readinessFailure("live recording socket", config, new Error("socket inode is unavailable after status"));
  }
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
  return {
    authority: RECORDING_READINESS_AUTHORITY,
    captureMode: "production",
    supervisor: { pid: lock.pid, live: true },
    daemon: { pid: daemonPid, listen: config.listen },
    plugin: { pid: plugin.pid, live: true },
    socket: { path: config.paths.recordingSocket, live: true, authoritativeStatus: true },
    helper: helper ? { pid: helper.pid, live: true, mode: "production" } : null,
    session: {
      status: status.status,
      recordingId: status.recordingId,
      meetingId: status.meetingId,
      paused: status.paused,
      error: status.error,
    },
    chunks: {
      microphone: microphone.length,
      system: system.length,
      total: status.chunks.length,
      evidencePaths,
    },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
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
  now = new Date(),
): Promise<RuntimeReadinessReport> {
  assertPreOwnerRecordingReady(report);
  await mkdir(config.paths.recordingExports, { recursive: true, mode: 0o700 });
  const contents = Buffer.from(
    `Meetless pre-owner collision sentinel\nrecording=${report.session.recordingId}\ncreated=${now.toISOString()}\n`,
  );
  const target = await nextAvailableExportPath(config.paths.recordingExports, now);
  await writeFile(target, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(target, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  const plannedPublishedPath = await nextAvailableExportPath(config.paths.recordingExports, now);
  const validUntil = new Date(now);
  validUntil.setMinutes(0, 0, 0);
  validUntil.setHours(validUntil.getHours() + 1);
  return {
    ...report,
    stopTarget: { ...report.stopTarget, prepared: true },
    collisionTarget: {
      path: target,
      byteLength: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
      plannedPublishedPath,
      validUntil: validUntil.toISOString(),
    },
  };
}

function assertProductionCapture(config: RuntimeConfig): void {
  if (config.environment.MEETLESS_CAPTURE_MODE === "fixture") {
    throw new Error(
      `Production desktop readiness rejects MEETLESS_CAPTURE_MODE=fixture. Remove fixture mode and rebuild before owner participation. ` +
        `Authority: ${RECORDING_READINESS_AUTHORITY}.`,
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

function inspectProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) throw new Error("Cannot inspect runtime process tree");
  return inspected.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

function isDescendant(
  candidatePid: number,
  ancestorPid: number,
  processes: Array<{ pid: number; ppid: number }>,
): boolean {
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

async function nextAvailableExportPath(exportRoot: string, now: Date): Promise<string> {
  const two = (value: number) => String(value).padStart(2, "0");
  const base = `${two(now.getHours())}-${two(now.getDate())}-${two(now.getMonth() + 1)}-${two(now.getFullYear() % 100)}`;
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = path.join(exportRoot, suffix === 1 ? `${base}.mp3` : `${base}-${suffix}.mp3`);
    try { await access(candidate); } catch { return candidate; }
  }
  throw new Error("Could not prepare a collision-safe recording evidence target");
}

export async function verifyCollisionEvidence(report: RuntimeReadinessReport): Promise<boolean> {
  if (!report.collisionTarget) return false;
  const bytes = await readFile(report.collisionTarget.path);
  return bytes.byteLength === report.collisionTarget.byteLength &&
    createHash("sha256").update(bytes).digest("hex") === report.collisionTarget.sha256;
}
