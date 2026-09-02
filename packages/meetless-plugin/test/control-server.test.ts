import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
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

  test("binds a packaged endpoint relative to the explicit runtime-root working directory", async () => {
    root = await mkdtemp("/private/tmp/meetless-control-");
    const socketPath = path.join(root, "recording-control.sock");
    service = await fixtureService(root);
    const endpoint = {
      role: "recording" as const,
      mode: "packaged" as const,
      workingDirectory: root,
      name: "recording-control.sock",
      bindArgument: "recording-control.sock",
      canonicalPath: socketPath,
    };
    const previousDirectory = process.cwd();
    process.chdir(root);
    try {
      server = new RecordingControlServer(endpoint, service);
      await server.start();
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      await connectRelative(endpoint.bindArgument);
      await server.close();
      server = null;
      expect(await exists(socketPath)).toBe(false);
      expect(await exists(`${socketPath}.owner.json`)).toBe(false);
    } finally {
      process.chdir(previousDirectory);
    }
  });

  test("rejects a wrong CWD and preserves foreign regular, symlink, and unknown socket entries", async () => {
    root = await mkdtemp("/private/tmp/meetless-control-");
    service = await fixtureService(root);
    const socketPath = path.join(root, "recording-control.sock");
    const wrongCwdEndpoint = {
      role: "recording" as const,
      mode: "packaged" as const,
      workingDirectory: path.join(root, "expected-runtime-root"),
      name: "recording-control.sock",
      bindArgument: "recording-control.sock",
      canonicalPath: path.join(root, "expected-runtime-root", "recording-control.sock"),
    };
    const wrongCwd = new RecordingControlServer(wrongCwdEndpoint, service);
    await expect(wrongCwd.start()).rejects.toThrow(/CWD.*runtime-root working directory.*Authority.*Next action/s);

    await writeFile(socketPath, "foreign-entry\n");
    const regular = new RecordingControlServer(socketPath, service);
    await expect(regular.start()).rejects.toThrow(/foreign non-socket entry.*not removed/);
    expect(await readFile(socketPath, "utf8")).toBe("foreign-entry\n");
    await rm(socketPath);

    const target = path.join(root, "foreign-target");
    await writeFile(target, "target\n");
    await symlink(target, socketPath);
    const link = new RecordingControlServer(socketPath, service);
    await expect(link.start()).rejects.toThrow(/foreign symlink.*not removed/);
    expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
    await rm(socketPath);

    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(socketPath, () => resolve());
    });
    const unknown = new RecordingControlServer(socketPath, service);
    await expect(unknown.start()).rejects.toThrow(/unknown socket without an owned marker.*not removed/);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(socketPath, { force: true });
  });

  test("reclaims a provably stale owner marker and rejects a concurrently occupied owner", async () => {
    root = await mkdtemp("/private/tmp/meetless-control-");
    service = await fixtureService(root);
    const socketPath = path.join(root, "recording-control.sock");
    const endpoint = {
      role: "recording" as const,
      mode: "packaged" as const,
      workingDirectory: root,
      name: "recording-control.sock",
      bindArgument: "recording-control.sock",
      canonicalPath: socketPath,
    };
    const previousDirectory = process.cwd();
    process.chdir(root);
    try {
      const staleListener = net.createServer();
      await new Promise<void>((resolve, reject) => {
        staleListener.once("error", reject);
        staleListener.listen(socketPath, () => resolve());
      });
      await new Promise<void>((resolve) => staleListener.close(() => resolve()));
      await writeFile(`${socketPath}.owner.json`, `${JSON.stringify({
        schema: "MEETLESS_RECORDING_ENDPOINT_OWNER v1",
        role: "recording",
        endpointName: endpoint.name,
        canonicalPath: endpoint.canonicalPath,
        pid: 2_147_483_647,
        token: "stale-marker",
      })}\n`, { mode: 0o600 });

      server = new RecordingControlServer(endpoint, service);
      await server.start();
      const contender = new RecordingControlServer(endpoint, service);
      await expect(contender.start()).rejects.toThrow(/owner PID.*still running|concurrently occupied/);
      await connectRelative(endpoint.bindArgument);
      await server.close();
      server = null;
      expect(await exists(socketPath)).toBe(false);
      expect(await exists(`${socketPath}.owner.json`)).toBe(false);
    } finally {
      process.chdir(previousDirectory);
    }
  });
});

async function fixtureService(fixtureRoot: string): Promise<RecordingService> {
  const instance = new RecordingService({
    storeRoot: path.join(fixtureRoot, "store"),
    helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
    ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
    exportRoot: path.join(fixtureRoot, "exports"), fixture: true,
  });
  await instance.initialize();
  return instance;
}

async function connectRelative(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
}

async function exists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true, () => false);
}

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
