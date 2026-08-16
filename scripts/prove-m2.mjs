import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { connectMeetlessClient } from "../packages/meetless-client/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp("/private/tmp/meetless-m2-proof-");
const runtimeRoot = path.join(root, "runtime");
const exportRoot = path.join(root, "Documents", "meetings");
const helper = path.join(repositoryRoot, "native/macos-capture/.build/release/meetless-capture");
const ffmpeg = process.env.MEETLESS_FFMPEG || "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.MEETLESS_FFPROBE || "/opt/homebrew/bin/ffprobe";
const port = await availablePort();
const listen = `127.0.0.1:${port}`;
const socketPath = path.join(runtimeRoot, "paseo-home", "recording-control.sock");
const collisionPath = path.join(exportRoot, "12-17-08-26.mp3");
const collisionBytes = Buffer.from("M2 collision sentinel: never overwrite\n");
const environment = {
  ...process.env,
  MEETLESS_RUNTIME_ROOT: runtimeRoot,
  MEETLESS_LISTEN: listen,
  MEETLESS_CAPTURE_MODE: "fixture",
  MEETLESS_EXPORT_ROOT: exportRoot,
  MEETLESS_FIXTURE_EXPORT_STAMP: "2026-08-17T12:00:00+07:00",
  MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE: "1",
  MEETLESS_FFMPEG: ffmpeg,
  MEETLESS_FFPROBE: ffprobe,
  PASEO_NODE_INSPECT: "0",
  PASEO_LOG_CONSOLE_LEVEL: "warn",
};

const daemons = new Set();
const helpers = new Set();
let socket = null;
let result;
let requestSequence = 0;
try {
  await mkdir(exportRoot, { recursive: true });
  await writeFile(collisionPath, collisionBytes, { flag: "wx" });

  let daemon = await startDaemon(environment, socketPath, daemons);
  socket = await connect(socketPath);
  const started = await command(socket, "start", { title: "M2 fixture acceptance" });
  if (started.status.status !== "recording") throw new Error(`start returned ${started.status.status}`);
  await waitFor(async () => (await command(socket, "status")).status.chunks.length >= 2);

  socket.close();
  socket = null;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  socket = await connect(socketPath);
  const afterRendererExit = await command(socket, "status");
  if (afterRendererExit.status.status !== "recording" || afterRendererExit.status.chunks.length < 2) {
    throw new Error("Capture did not survive renderer transport exit/reconnect");
  }
  socket.close();
  socket = null;

  await stopDaemon(daemon);
  daemon = await startDaemon(environment, socketPath, daemons);
  socket = await connect(socketPath);
  const afterRestart = await command(socket, "status");
  if (afterRestart.status.status !== "recoverable" || afterRestart.status.chunks.length < 2) {
    throw new Error(`Daemon restart did not recover committed chunks: ${JSON.stringify(afterRestart.status)}`);
  }
  const originalChunkIds = afterRestart.status.chunks.map((chunk) => chunk.id);

  const injected = await command(socket, "retryFinalization", {}, true);
  if (injected.ok || injected.status.status !== "recoverable") {
    throw new Error("Expected one injected finalization interruption with recoverable chunks");
  }
  const saved = await command(socket, "retryFinalization");
  if (saved.status.status !== "saved" || !saved.status.outputPath) throw new Error("Finalization retry did not save MP3");
  if (JSON.stringify(saved.status.chunks.map((chunk) => chunk.id)) !== JSON.stringify(originalChunkIds)) {
    throw new Error("Finalization retry changed the committed chunk set");
  }
  socket.close();
  socket = null;
  await stopDaemon(daemon);

  const timeline = await proveTimestampTimeline(path.join(root, "timeline-fixture"), helpers);

  if (!Buffer.from(await readFile(collisionPath)).equals(collisionBytes)) throw new Error("Collision target bytes changed");
  const outputPath = saved.status.outputPath;
  const probe = JSON.parse((await execFileAsync(ffprobe, [
    "-v", "error", "-show_entries", "format=filename,duration,size:stream=codec_name,sample_rate,channels", "-of", "json", outputPath,
  ])).stdout);
  const frequencyEvidence = {};
  for (const frequency of [440, 880]) {
    const measured = await execFileAsync(ffmpeg, [
      "-hide_banner", "-nostats", "-i", outputPath,
      "-af", `bandpass=f=${frequency}:width_type=h:width=35,volumedetect`, "-f", "null", "-",
    ], { maxBuffer: 2 * 1024 * 1024 });
    const combined = `${measured.stdout}\n${measured.stderr}`;
    const match = /mean_volume:\s*(-?[\d.]+) dB/u.exec(combined);
    if (!match) throw new Error(`Could not measure ${frequency} Hz fixture tone`);
    frequencyEvidence[`${frequency}HzMeanDb`] = Number(match[1]);
  }
  if (frequencyEvidence["440HzMeanDb"] < -40 || frequencyEvidence["880HzMeanDb"] < -40) {
    throw new Error(`One fixture tone was not decode-observable: ${JSON.stringify(frequencyEvidence)}`);
  }

  result = {
    proof: "Meetless Milestone 2 fixture acceptance",
    runtimeRoot,
    listen,
    rendererExit: { captureContinued: true, chunksAfterReconnect: afterRendererExit.status.chunks.length },
    daemonRestart: { recovered: true, chunkIds: originalChunkIds },
    retryWithoutRecording: { injectedFailure: injected.error, saved: true, sameChunkIds: true },
    timestampTimeline: timeline,
    collision: { path: collisionPath, sha256: sha256(collisionBytes), unchanged: true, publishedPath: outputPath },
    output: { path: outputPath, sha256: await fileSha256(outputPath), probe, frequencyEvidence },
    tools: {
      helper: { path: helper, sha256: await fileSha256(helper) },
      ffmpeg: { path: ffmpeg, sha256: await fileSha256(ffmpeg) },
      ffprobe: { path: ffprobe, sha256: await fileSha256(ffprobe) },
    },
  };
} finally {
  socket?.close();
  await Promise.all([...daemons].map((daemon) => stopDaemon(daemon)));
  await Promise.all([...helpers].map((helperProcess) => stopChild(helperProcess, "timeline fixture helper")));
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function startDaemon(env, expectedSocket, ownedDaemons) {
  const output = [];
  let lastClientError = null;
  const child = spawn(process.execPath, ["packages/runtime/dist/cli.js", "daemon"], {
    cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"],
  });
  ownedDaemons.add(child);
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Daemon exited ${child.exitCode}: ${output.join("")}`);
    try { return (await stat(path.join(env.MEETLESS_RUNTIME_ROOT, "paseo-home", "paseo.pid"))).isFile(); } catch { return false; }
  }, 30_000, () => `daemon PID lock; output:\n${output.join("")}`);
  await waitFor(async () => {
    let client;
    try {
      client = await connectMeetlessClient({ url: `ws://${env.MEETLESS_LISTEN}/ws`, clientId: `m2-proof-bootstrap-${Date.now()}`, clientType: "cli" });
      await client.client.listMeetings();
      return true;
    } catch (error) { lastClientError = error; return false; }
    finally { await client?.close().catch(() => undefined); }
  }, 30_000, () => `Meetless plugin catalog/RPC; last client error: ${lastClientError}; output:\n${output.join("")}`);
  await waitFor(
    async () => { try { return (await stat(expectedSocket)).isSocket(); } catch { return false; } },
    30_000,
    () => `private recording socket ${expectedSocket}; output:\n${output.join("")}`,
  );
  return child;
}

async function connect(socketFile) {
  const ws = new WebSocket(`ws+unix://${socketFile}:/ws`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

async function command(ws, name, extra = {}, allowFailure = false) {
  const requestId = `proof-${++requestSequence}`;
  const response = new Promise((resolve, reject) => {
    const listener = (data) => {
      try {
        const decoded = JSON.parse(data.toString());
        if (decoded.requestId !== requestId) return;
        ws.off("message", listener); resolve(decoded);
      } catch (error) { reject(error); }
    };
    ws.on("message", listener);
  });
  ws.send(JSON.stringify({ version: 1, requestId, command: name, ...extra }));
  const decoded = await response;
  if (!allowFailure && !decoded.ok) throw new Error(decoded.error || `${name} failed`);
  return decoded;
}

async function waitFor(condition, timeoutMs = 10_000, describeWait = () => "M2 proof state") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${describeWait()}`);
}

async function stopDaemon(child) {
  return stopChild(child, "proof daemon");
}

async function stopChild(child, label) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 10_000)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, 5_000)) throw new Error(`${label} ${child.pid} did not exit`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate proof port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function proveTimestampTimeline(sessionDirectory, ownedHelpers) {
  const child = spawn(helper, ["--timeline-fixture"], {
    cwd: repositoryRoot, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
  });
  ownedHelpers.add(child);
  const events = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const newline = stdout.indexOf("\n");
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  const sendHelper = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const starts = (source) => events
    .filter((event) => event.event === "chunkCommitted" && event.source === source)
    .map((event) => event.logicalStartMs);
  const wait = (condition, label) => waitFor(() => {
    if (condition()) return true;
    if (child.exitCode !== null) throw new Error(`Timeline fixture exited ${child.exitCode}: ${stderr}`);
    return false;
  }, 10_000, () => label);

  sendHelper({ version: 1, command: "start", sessionDirectory, elapsedMs: 0 });
  await wait(() => events.some((event) => event.event === "started"), "timeline fixture start");
  await wait(() => starts("microphone").includes(500) && starts("system").includes(125), "PTS source offset and gap");
  sendHelper({ version: 1, command: "pause" });
  await wait(() => events.some((event) => event.event === "paused"), "timeline fixture pause");
  await new Promise((resolve) => setTimeout(resolve, 150));
  sendHelper({ version: 1, command: "resume", elapsedMs: 2_000 });
  await wait(() => events.some((event) => event.event === "resumed"), "timeline fixture resume");
  await new Promise((resolve) => setTimeout(resolve, 80));
  sendHelper({ version: 1, command: "stop" });
  await wait(() => events.some((event) => event.event === "stopped"), "timeline fixture stop");
  await waitForExit(child, 5_000);

  const microphoneStartsMs = starts("microphone");
  const systemStartsMs = starts("system");
  if (![0, 500, 2_125].every((start) => microphoneStartsMs.includes(start))) {
    throw new Error(`Microphone PTS timeline mismatch: ${JSON.stringify(microphoneStartsMs)}`);
  }
  if (![125, 2_000].every((start) => systemStartsMs.includes(start))) {
    throw new Error(`System PTS timeline mismatch: ${JSON.stringify(systemStartsMs)}`);
  }
  return {
    sharedOrigin: true,
    microphoneStartsMs,
    systemStartsMs,
    discontinuityPreserved: microphoneStartsMs.includes(500),
    pauseExcludedAtMs: 2_000,
    crossSourceResumeOffsetMs: 125,
  };
}

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
async function fileSha256(filePath) { return sha256(await readFile(filePath)); }
