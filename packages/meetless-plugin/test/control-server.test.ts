import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import { RecordingControlResponseSchema } from "@meetless/meeting-contracts";
import { RecordingControlServer } from "../src/control-server.js";
import { RecordingService } from "../src/recording-service.js";
import { RecordingRuntimeReadinessResponseSchema } from "../src/readiness-protocol.js";

let root: string | null = null;
let server: RecordingControlServer | null = null;
let service: RecordingService | null = null;

afterEach(async () => {
  await server?.close(); server = null;
  await service?.shutdown(); service = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("private desktop recording control", () => {
  test("rejects an overlong Unix socket path before binding a truncated listener", async () => {
    root = await mkdtemp("/private/tmp/meetless-control-");
    const socketPath = path.join(root, "x".repeat(110), "recording.sock");
    service = new RecordingService({
      storeRoot: path.join(root, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(root, "exports"), fixture: true,
    });
    await service.initialize();
    const candidate = new RecordingControlServer(socketPath, service);
    await expect(candidate.start()).rejects.toThrow("Recording control socket path is too long");
  });

  test("uses a restrictive Unix socket and capture survives renderer transport disconnect/reconnect", async () => {
    root = await mkdtemp("/private/tmp/meetless-control-");
    const socketPath = path.join(root, "recording.sock");
    service = new RecordingService({
      storeRoot: path.join(root, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(root, "exports"), fixture: true,
      exportNow: () => new Date("2026-08-17T12:00:00+07:00"),
    });
    await service.initialize();
    server = new RecordingControlServer(socketPath, service); await server.start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const first = await connect(socketPath);
    const started = await command(first, "start", { title: "Renderer exit fixture" });
    expect(started.status.status).toBe("recording");
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const second = await connect(socketPath);
    const reconnected = await command(second, "status");
    expect(reconnected.status.status).toBe("recording");
    expect(reconnected.status.chunks.length).toBeGreaterThanOrEqual(2);
    const runtimeStatus = await readinessCommand(second, "status");
    const repeatedStatus = await readinessCommand(second, "status");
    expect(repeatedStatus.runtime.instanceId).toBe(runtimeStatus.runtime.instanceId);
    expect(runtimeStatus.runtime).toMatchObject({
      pluginPid: process.pid,
      socketPath,
      capture: { mode: "fixture", helperPid: expect.any(Number), arguments: ["--fixture"] },
      export: { root: path.join(root, "exports"), fixtureStampApplied: false },
    });
    const collision = await readinessCommand(second, "prepareCollision");
    expect(collision.collision).toMatchObject({
      recordingId: reconnected.status.recordingId,
      runtimeInstanceId: runtimeStatus.runtime.instanceId,
      exportRoot: path.join(root, "exports"),
    });
    const stopped = await command(second, "stop");
    expect(stopped.status.status).toBe("saved");
    second.close();
  }, 30_000);
});

async function connect(socketPath: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/ws`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}

async function readinessCommand(socket: WebSocket, operation: "status" | "prepareCollision" | "validateCollision") {
  const requestId = `${operation}-${Date.now()}-${Math.random()}`;
  const response = new Promise<unknown>((resolve, reject) => {
    const listener = (data: RawData) => {
      try {
        const decoded = JSON.parse(data.toString()) as { requestId?: string };
        if (decoded.requestId !== requestId) return;
        socket.off("message", listener); resolve(decoded);
      } catch (error) { reject(error); }
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify({ version: 1, requestId, command: "runtime.readiness", operation }));
  return RecordingRuntimeReadinessResponseSchema.parse(await response);
}

async function command(socket: WebSocket, name: string, extra: Record<string, unknown> = {}) {
  const requestId = `${name}-${Date.now()}`;
  const response = new Promise<unknown>((resolve, reject) => {
    const listener = (data: RawData) => {
      try {
        const decoded = JSON.parse(data.toString()) as { requestId?: string };
        if (decoded.requestId !== requestId) return;
        socket.off("message", listener); resolve(decoded);
      } catch (error) { reject(error); }
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify({ version: 1, requestId, command: name, ...extra }));
  return RecordingControlResponseSchema.parse(await response);
}
