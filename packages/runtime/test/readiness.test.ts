import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RecordingRuntimeReadinessResponse } from "@meetless/plugin/readiness-protocol";
import { resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  RECORDING_READINESS_AUTHORITY,
  assertAttestedProcessOwnership,
  assertPreOwnerRecordingReady,
  prepareCollisionEvidence,
  type RuntimeReadinessReport,
  verifyCollisionEvidence,
  waitForRecordingRuntime,
} from "../src/readiness.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("production recording readiness invariant", () => {
  test("accepts an idempotent current-runtime identity only after plugin bootstrap", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config);
    const bootstrapPlugin = vi.fn(async () => undefined);
    const requestReadiness = vi.fn(async () => response);
    const verifyOwnership = vi.fn(async () => undefined);

    const first = await waitForRecordingRuntime(config, {
      timeoutMs: 500,
      dependencies: { bootstrapPlugin, requestReadiness, verifyOwnership },
    });
    const second = await waitForRecordingRuntime(config, {
      timeoutMs: 500,
      dependencies: { bootstrapPlugin, requestReadiness, verifyOwnership },
    });

    expect(first.runtime.instanceId).toBe(response.runtime.instanceId);
    expect(second.runtime.instanceId).toBe(response.runtime.instanceId);
    expect(first.status).toEqual(idleStatus());
    expect(bootstrapPlugin).toHaveBeenCalledTimes(2);
    expect(verifyOwnership).toHaveBeenCalledTimes(2);
  });

  test("outer startup timeout bounds a hung catalog/bootstrap operation", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const started = Date.now();
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 25,
      dependencies: { bootstrapPlugin: () => new Promise<void>(() => undefined) },
    })).rejects.toThrow(/failed closed at Meetless plugin bootstrap.*outer startup deadline/s);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("a replaced socket fails even when the old listener returns a matching request ID", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "recording.sock");
    const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);
    const firstHttp = createServer();
    const firstWs = new WebSocketServer({ noServer: true });
    let replacementHttp: Server | null = null;
    firstHttp.on("upgrade", (request, socket, head) => {
      firstWs.handleUpgrade(request, socket, head, (client) => firstWs.emit("connection", client, request));
    });
    firstWs.on("connection", (client) => {
      client.on("message", (data) => void (async () => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        await unlink(socketPath);
        replacementHttp = createServer();
        await listen(replacementHttp, socketPath);
        const replacement = await stat(socketPath);
        client.send(JSON.stringify(await runtimeResponse(config, {
          requestId: request.requestId,
          socketIdentity: { device: replacement.dev, inode: replacement.ino },
        })));
      })());
    });
    await listen(firstHttp, socketPath);
    try {
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 100,
        retryMs: 1,
        dependencies: {
          bootstrapPlugin: async () => undefined,
          verifyOwnership: async () => undefined,
        },
      })).rejects.toThrow(
        new RegExp(`failed closed at authoritative recording status.*Socket existence.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
      );
    } finally {
      await closeWebSocketServer(firstWs);
      await closeServer(firstHttp);
      if (replacementHttp) await closeServer(replacementHttp);
    }
  });

  test("an unavailable plugin fails before the desktop can expose controls", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 100,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => { throw new Error('required "meetless" plugin is absent'); },
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at Meetless plugin bootstrap.*no desktop controls were exposed.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}`, "s"),
    );
  });

  test("rejects every fixture-helper argument mode and equivalent production argv", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    for (const argument of ["--fixture", "--timeline-fixture", "--invalid-claim-fixture", "--future-fixture-mode"]) {
      const response = await runtimeResponse(config, { arguments: [argument] });
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 20,
        retryMs: 1,
        dependencies: {
          bootstrapPlugin: async () => undefined,
          requestReadiness: async () => response,
        },
      })).rejects.toThrow(new RegExp(`helper arguments are forbidden in production: ${argument}`));
    }
  });

  test("fixture capture and differing daemon export configuration cannot pass", async () => {
    const resolved = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const fixtureConfig = {
      ...resolved,
      environment: { ...resolved.environment, MEETLESS_CAPTURE_MODE: "fixture" },
    };
    await expect(waitForRecordingRuntime(fixtureConfig, { timeoutMs: 20 })).rejects.toThrow(/rejects MEETLESS_CAPTURE_MODE=fixture.*Authority/s);

    const wrongExport = await runtimeResponse(resolved, { exportRoot: path.join(resolved.paths.root, "other-exports") });
    await expect(waitForRecordingRuntime(resolved, {
      timeoutMs: 20,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => undefined,
        requestReadiness: async () => wrongExport,
      },
    })).rejects.toThrow(/daemon export root differs from launcher configuration/u);
  });

  test("binds to the attested plugin PID when multiple plugin descendants exist", () => {
    const processes = [
      { pid: 10, ppid: 1, command: "daemon" },
      { pid: 20, ppid: 10, command: "node /wrong/plugin-process.js" },
      { pid: 21, ppid: 10, command: "node /right/plugin-process.js" },
      { pid: 30, ppid: 20, command: "/repo/meetless-capture --fixture" },
      { pid: 31, ppid: 21, command: "/repo/meetless-capture" },
    ];
    expect(() => assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, helperPid: 31, helperRealPath: "/repo/meetless-capture", processes,
    })).not.toThrow();
    expect(() => assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, helperPid: 30, helperRealPath: "/repo/meetless-capture", processes,
    })).toThrow(/not a descendant of plugin PID 21/u);
  });

  test("wrong attested plugin ownership fails with the accepted authority and next action", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config);
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 30,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => undefined,
        requestReadiness: async () => response,
        verifyOwnership: async () => { throw new Error("authoritative Meetless plugin PID is not owned"); },
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at authoritative recording status.*plugin PID is not owned.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
    );
  });

  test("pre-owner report accepts only daemon-bound collision evidence and preserves source chunks", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    const sourceEvidence = path.join(root, "meeting-store", "sessions", "recording-1", "microphone.wav");
    await mkdir(path.dirname(sourceEvidence), { recursive: true });
    await writeFile(sourceEvidence, "source evidence remains\n");
    const collisionPath = path.join(root, "collision.mp3");
    await writeFile(collisionPath, "sentinel\n");
    const collisionBytes = await readFile(collisionPath);
    const report = activeReport(sourceEvidence);
    const response = await runtimeResponse(config, {
      instanceId: report.plugin.instanceId,
      pluginPid: report.plugin.pid,
      helperPid: report.helper?.pid ?? null,
      socketIdentity: { device: report.socket.device, inode: report.socket.inode },
      status: activeStatus(),
      collision: {
        path: collisionPath,
        byteLength: collisionBytes.byteLength,
        sha256: createHash("sha256").update(collisionBytes).digest("hex"),
        plannedPublishedPath: path.join(root, "planned.mp3"),
        recordingId: "recording-1",
        runtimeInstanceId: report.plugin.instanceId,
        exportRoot: config.paths.recordingExports,
        exportStamp: "2026-08-17T14:59:59.000+07:00",
        preparedAt: "2026-08-17T08:00:00.000Z",
        validUntil: null,
      },
    });
    const prepared = await prepareCollisionEvidence(config, report, async () => response);

    expect(prepared.stopTarget.prepared).toBe(true);
    expect(prepared.collisionTarget?.plannedPublishedPath).toBe(path.join(root, "planned.mp3"));
    expect(await verifyCollisionEvidence(prepared)).toBe(true);
    await expect(access(sourceEvidence)).resolves.toBeUndefined();
  });

  test("pre-owner failure surfaces the recorder cause and corrective route", () => {
    const report = activeReport("/tmp/chunk.wav");
    report.session.status = "failed";
    report.session.error = "The user declined TCCs for application, window, display capture";
    report.helper = null;
    report.chunks = { microphone: 0, system: 0, total: 0, evidencePaths: [] };
    expect(() => assertPreOwnerRecordingReady(report)).toThrow(
      /recorder error: The user declined TCCs.*Start recording only through the Electron controls.*Authority/s,
    );
  });
});

async function runtimeResponse(config: RuntimeConfig, overrides: {
  requestId?: string;
  instanceId?: string;
  pluginPid?: number;
  helperPid?: number | null;
  arguments?: string[];
  exportRoot?: string;
  socketIdentity?: { device: number; inode: number };
  status?: ReturnType<typeof idleStatus> | ReturnType<typeof activeStatus>;
  collision?: RecordingRuntimeReadinessResponse["collision"];
} = {}): Promise<RecordingRuntimeReadinessResponse> {
  const [helperInfo, helperRealPath, helperBytes] = await Promise.all([
    stat(config.paths.captureHelper),
    realpath(config.paths.captureHelper),
    readFile(config.paths.captureHelper),
  ]);
  return {
    version: 1,
    type: "recording.runtime.readiness",
    requestId: overrides.requestId ?? "request",
    ok: true,
    runtime: {
      instanceId: overrides.instanceId ?? randomUUID(),
      startedAt: "2026-08-17T08:00:00.000Z",
      pluginPid: overrides.pluginPid ?? 321,
      socketPath: config.paths.recordingSocket,
      socketIdentity: overrides.socketIdentity ?? { device: 1, inode: 2 },
      capture: {
        mode: "production",
        executable: {
          configuredPath: config.paths.captureHelper,
          realPath: helperRealPath,
          device: helperInfo.dev,
          inode: helperInfo.ino,
          byteLength: helperInfo.size,
          sha256: createHash("sha256").update(helperBytes).digest("hex"),
        },
        arguments: overrides.arguments ?? [],
        helperPid: overrides.helperPid ?? null,
      },
      export: { root: overrides.exportRoot ?? config.paths.recordingExports, fixtureStampApplied: false },
    },
    status: overrides.status ?? idleStatus(),
    collision: overrides.collision ?? null,
    error: null,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-readiness-"));
  roots.add(root);
  return root;
}

function withSocket(config: RuntimeConfig, recordingSocket: string): RuntimeConfig {
  return { ...config, paths: { ...config.paths, recordingSocket } };
}

function idleStatus() {
  return { status: "idle" as const, recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [], outputPath: null, error: null };
}

function activeStatus() {
  return { ...idleStatus(), status: "recording" as const, recordingId: "recording-1", meetingId: "meeting-1", title: "Ready" };
}

function activeReport(sourceEvidence: string): RuntimeReadinessReport {
  return {
    authority: RECORDING_READINESS_AUTHORITY,
    captureMode: "production",
    supervisor: { pid: 1, live: true },
    daemon: { pid: 2, listen: "127.0.0.1:6777" },
    plugin: { pid: 3, live: true, instanceId: "a10ff4d8-1a5d-4e8f-b4f1-c37080b958d8", startedAt: "2026-08-17T08:00:00.000Z" },
    socket: { path: "/tmp/recording.sock", live: true, authoritativeStatus: true, device: 1, inode: 2 },
    helper: { pid: 4, live: true, mode: "production", path: "/repo/helper", realPath: "/repo/helper", sha256: "a".repeat(64), arguments: [] },
    session: { status: "recording", recordingId: "recording-1", meetingId: "meeting-1", paused: false, error: null },
    chunks: { microphone: 1, system: 1, total: 2, evidencePaths: [sourceEvidence] },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}
