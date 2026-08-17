import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  RECORDING_READINESS_AUTHORITY,
  assertPreOwnerRecordingReady,
  prepareCollisionEvidence,
  requestAuthoritativeRecordingStatus,
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
  test("accepts only a correlated authoritative status response after plugin bootstrap", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "recording.sock");
    const http = createServer();
    const websocket = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
    });
    websocket.on("connection", (client) => {
      client.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        client.send(JSON.stringify({
          version: 1,
          requestId: request.requestId,
          ok: true,
          status: idleStatus(),
          error: null,
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(socketPath, resolve);
    });
    try {
      const bootstrapPlugin = vi.fn(async () => undefined);
      const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 0,
        dependencies: { bootstrapPlugin },
      })).resolves.toEqual(idleStatus());
      expect(bootstrapPlugin).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  test("a stale socket inode fails with the authority and next action", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "recording.sock");
    await writeFile(socketPath, "stale socket evidence\n");
    const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);

    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 0,
      dependencies: { bootstrapPlugin: async () => undefined },
    })).rejects.toThrow(
      new RegExp(`failed closed at authoritative recording status.*Socket existence.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
    );
  });

  test("an unavailable plugin fails before the desktop can expose controls", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 0,
      dependencies: {
        bootstrapPlugin: async () => { throw new Error('required "meetless" plugin is absent'); },
        requestStatus: async () => idleStatus(),
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at Meetless plugin bootstrap.*no desktop controls were exposed.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}`, "s"),
    );
  });

  test("fixture capture cannot pass production readiness", async () => {
    const root = await temporaryRoot();
    const resolved = resolveRuntimeConfig({ runtimeRoot: root });
    const config = {
      ...resolved,
      environment: { ...resolved.environment, MEETLESS_CAPTURE_MODE: "fixture" },
    };
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 0,
      dependencies: {
        bootstrapPlugin: async () => undefined,
        requestStatus: async () => idleStatus(),
      },
    })).rejects.toThrow(/rejects MEETLESS_CAPTURE_MODE=fixture.*Authority/s);
  });

  test("pre-owner proof prepares a no-replace collision sentinel and preserves source evidence", async () => {
    const root = await temporaryRoot();
    const resolved = resolveRuntimeConfig({ runtimeRoot: root });
    const config = {
      ...resolved,
      paths: { ...resolved.paths, recordingExports: path.join(root, "exports") },
    };
    const sourceEvidence = path.join(root, "meeting-store", "sessions", "recording-1", "microphone.wav");
    await mkdir(path.dirname(sourceEvidence), { recursive: true });
    await writeFile(sourceEvidence, "source evidence remains\n");
    const report = activeReport(sourceEvidence);
    const prepared = await prepareCollisionEvidence(config, report, new Date(2026, 7, 17, 14, 30));

    expect(prepared.stopTarget.prepared).toBe(true);
    expect(prepared.collisionTarget?.path).toBe(path.join(root, "exports", "14-17-08-26.mp3"));
    expect(prepared.collisionTarget?.plannedPublishedPath).toBe(path.join(root, "exports", "14-17-08-26-2.mp3"));
    expect(await verifyCollisionEvidence(prepared)).toBe(true);
    await expect(access(sourceEvidence)).resolves.toBeUndefined();
    expect(await readFile(sourceEvidence, "utf8")).toBe("source evidence remains\n");
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-readiness-"));
  roots.add(root);
  return root;
}

function withSocket(config: ReturnType<typeof resolveRuntimeConfig>, recordingSocket: string) {
  return { ...config, paths: { ...config.paths, recordingSocket } };
}

function idleStatus() {
  return {
    status: "idle" as const,
    recordingId: null,
    meetingId: null,
    title: null,
    elapsedMs: 0,
    paused: false,
    chunks: [],
    outputPath: null,
    error: null,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function activeReport(sourceEvidence: string): RuntimeReadinessReport {
  return {
    authority: RECORDING_READINESS_AUTHORITY,
    captureMode: "production",
    supervisor: { pid: 1, live: true },
    daemon: { pid: 2, listen: "127.0.0.1:6777" },
    plugin: { pid: 3, live: true },
    socket: { path: "/tmp/recording.sock", live: true, authoritativeStatus: true },
    helper: { pid: 4, live: true, mode: "production" },
    session: { status: "recording", recordingId: "recording-1", meetingId: "meeting-1", paused: false, error: null },
    chunks: { microphone: 1, system: 1, total: 2, evidencePaths: [sourceEvidence] },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
}
