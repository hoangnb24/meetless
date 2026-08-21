import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { connectMeetlessClient } from "@meetless/client";
import { MeetingStore } from "@meetless/meeting-store";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";
import { inspectRuntimeReadiness, waitForRecordingRuntime } from "../packages/runtime/dist/readiness.js";
import { runFailClosedCleanup } from "./lib/m6-host-auth-cleanup.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identityPath = path.join(homedir(), "Library", "Application Support", "Meetless", "host-identity.json");
const originalIdentity = JSON.parse(await readFile(identityPath, "utf8"));
if (originalIdentity.configuration?.listen !== "127.0.0.1:6777") {
  throw new Error("M6 host-auth preflight requires the installed loopback host baseline");
}
const inheritedLaunchPassword = await launchctlGetenv("MEETLESS_DIRECT_PASSWORD");
const inheritedPaseoPassword = await launchctlGetenv("PASEO_PASSWORD");
if (inheritedLaunchPassword || inheritedPaseoPassword) {
  throw new Error("M6 host-auth preflight refuses to replace an existing launch password environment");
}

const runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-m6-host-auth-"));
const listen = "0.0.0.0:6777";
const secret = randomBytes(32).toString("hex");
const temporaryEnvironment = {
  ...process.env,
  MEETLESS_RUNTIME_ROOT: runtimeRoot,
  MEETLESS_LISTEN: listen,
  MEETLESS_DIRECT_PASSWORD: secret,
};
const config = resolveRuntimeConfig({ runtimeRoot, listen, environment: temporaryEnvironment });
let temporaryInstallAttempted = false;
let journeyResult;
let bodyFailure;
try {
  await launchctl("setenv", "MEETLESS_DIRECT_PASSWORD", secret);
  temporaryInstallAttempted = true;
  await runNode("scripts/install-macos-host.mjs", ["--replace"], temporaryEnvironment);
  const fixture = await seedFixture(config);
  const first = await runJourney(config, fixture, secret);
  await stopHost(temporaryEnvironment);
  const second = await runJourney(config, fixture, secret);
  await stopHost(temporaryEnvironment);
  const secretAbsent = await scanForBytes(runtimeRoot, Buffer.from(secret)).then((found) => !found);
  if (!secretAbsent) throw new Error("Temporary direct password entered the preflight runtime tree");
  journeyResult = {
    first,
    restart: second,
    secretIsolation: {
      rendererEnvironment: true,
      electronEnvironment: true,
      argv: true,
      runtimeTree: secretAbsent,
    },
  };
} catch (error) {
  bodyFailure = error;
} finally {
  const restoreEnvironment = { ...process.env };
  delete restoreEnvironment.MEETLESS_DIRECT_PASSWORD;
  delete restoreEnvironment.PASEO_PASSWORD;
  restoreEnvironment.MEETLESS_RUNTIME_ROOT = originalIdentity.configuration.runtimeRoot;
  restoreEnvironment.MEETLESS_LISTEN = originalIdentity.configuration.listen;
  try {
    await runFailClosedCleanup([
      ["stop temporary host", async () => {
        if (temporaryInstallAttempted) await stopHost(temporaryEnvironment);
      }],
      ["unset MEETLESS_DIRECT_PASSWORD", async () => launchctl("unsetenv", "MEETLESS_DIRECT_PASSWORD")],
      ["unset PASEO_PASSWORD", async () => launchctl("unsetenv", "PASEO_PASSWORD")],
      ["restore installed host", async () => {
        if (temporaryInstallAttempted) await runNode("scripts/install-macos-host.mjs", ["--replace"], restoreEnvironment);
      }],
      ["remove temporary runtime", async () => rm(runtimeRoot, { recursive: true, force: true })],
    ], async () => inspectCleanState(config, originalIdentity));
  } catch (error) {
    if (bodyFailure) {
      throw new AggregateError([bodyFailure, error], "M6 host-auth preflight and cleanup failed");
    }
    throw error;
  }
}

if (bodyFailure) throw bodyFailure;
const result = {
  schema: "MEETLESS_M6_HOST_AUTH_PREFLIGHT v1",
  status: "passed",
  listen,
  authRequired: true,
  ...journeyResult,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function runJourney(config, fixture, directSecret) {
  await runNode("scripts/launch-macos-host.mjs", [], temporaryEnvironment);
  const status = await waitForRecordingRuntime(config, { timeoutMs: 30_000 });
  const readiness = await inspectRuntimeReadiness(config, status);
  const connection = await connectMeetlessClient({
    url: "ws://127.0.0.1:6777/ws",
    clientId: `m6-host-auth-${randomUUID()}`,
    clientType: "cli",
  });
  try {
    const meetings = await connection.client.listMeetings();
    const detail = await connection.client.getMeetingTranscript(fixture.meetingId);
    const chat = await connection.client.getMeetingChat(fixture.meetingId);
    const citation = await connection.client.resolveCitation({
      meetingId: fixture.meetingId,
      segmentId: fixture.segmentId,
    });
    const childIsolation = await inspectDesktopChildren(directSecret);
    if (!detail.transcript || detail.transcript.status !== "ready") throw new Error("Signed host transcript path is not ready");
    if (citation.audio.mimeType !== "audio/mpeg" || citation.audio.base64.length === 0) {
      throw new Error("Signed host citation path did not return bounded MP3 audio");
    }
    return {
      authoritativeReadiness: readiness.socket.authoritativeStatus === true,
      pluginReady: readiness.plugin.live === true,
      desktopChildren: childIsolation,
      meetingIds: meetings.map((meeting) => meeting.id),
      detailReady: true,
      chatRpcAvailable: chat === null || typeof chat === "object",
      citation: {
        meetingId: citation.meetingId,
        segmentId: citation.segmentId,
        startMs: citation.startMs,
        endMs: citation.endMs,
        boundedMp3: citation.endMs > citation.startMs,
      },
    };
  } finally {
    await connection.close();
  }
}

async function seedFixture(config) {
  const store = new MeetingStore({ root: config.paths.meetingStore });
  const meetingId = "m6-host-auth-meeting";
  const recordingId = "m6-host-auth-recording";
  const fixtureDirectory = path.join(config.paths.meetingStore, "m6-host-auth-fixture");
  const sessionDirectory = path.join(config.paths.meetingStore, "sessions", recordingId);
  await Promise.all([
    mkdir(fixtureDirectory, { recursive: true, mode: 0o700 }),
    mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const audioPath = path.join(fixtureDirectory, "fixture.mp3");
  await execFileAsync(config.environment.MEETLESS_FFMPEG, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=2:sample_rate=16000",
    "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "32k", audioPath,
  ]);
  await chmod(audioPath, 0o600);
  const outputIdentity = await fileIdentity(audioPath);
  await store.create({ id: meetingId, title: "M6 host auth fixture" });
  await store.startRecording({ id: recordingId, meetingId });
  const chunkPath = path.join(sessionDirectory, "fixture.wav");
  const chunkBytes = oneFrameWav();
  await writeFile(chunkPath, chunkBytes, { flag: "wx", mode: 0o600 });
  const chunkStats = await stat(chunkPath);
  const chunk = {
    id: "m6-host-auth-source",
    source: "microphone",
    storageKey: path.relative(config.paths.meetingStore, chunkPath),
    byteLength: chunkBytes.byteLength,
    sha256: sha256(chunkBytes),
    committedAt: chunkStats.mtime.toISOString(),
    logicalStartMs: 0,
    durationMs: 1,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
  await store.commitChunk(recordingId, chunk);
  await store.prepareInventoryRecovery(recordingId, "M6 host auth fixture capture complete");
  await store.markInventoryScanning(recordingId);
  const inventoryBytes = Buffer.from(`${JSON.stringify(chunk)}\n`);
  const inventoryPath = path.join(sessionDirectory, "inventory.ndjson");
  await writeFile(inventoryPath, inventoryBytes, { flag: "wx", mode: 0o600 });
  const pointer = {
    storageKey: path.relative(config.paths.meetingStore, inventoryPath),
    digest: sha256(inventoryBytes),
    chunkCount: 1,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: new Date().toISOString(),
  };
  await store.publishInventory(recordingId, pointer);
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true,
    chunkSetDigest: pointer.digest,
    destination: audioPath,
    expectedIdentity: outputIdentity,
  });
  await store.markRecordingSaved(recordingId, { destination: audioPath, identity: outputIdentity, readable: true });
  await store.grantTranscriptionConsent();
  let transcript = await store.ensureTranscript({
    meetingId,
    recordingId,
    audio: { destination: audioPath, ...outputIdentity, durationMs: 2_000 },
  });
  while (transcript.status !== "ready") {
    const request = await store.beginTranscriptRequest(transcript.id);
    if (!request) break;
    transcript = await store.checkpointTranscriptRange(transcript.id, {
      range: request.range,
      text: "Fixture segment",
      attempts: request.attempt,
      usage: { durationSeconds: (request.range.endMs - request.range.startMs) / 1_000 },
      detectedLanguages: ["en"],
    });
    if (transcript.ranges.length === transcript.checkpoints.length) transcript = await store.publishTranscript(transcript.id);
  }
  const segmentId = transcript.checkpoints[0]?.range.segmentId;
  if (transcript.status !== "ready" || !segmentId) throw new Error("Cannot seed the host-auth transcript fixture");
  return { meetingId, segmentId };
}

async function inspectDesktopChildren(secretBytes) {
  const rows = (await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 2 * 1024 * 1024 })).stdout;
  const children = rows.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match || (!match[2].includes("electron-bootstrap.mjs") && !match[2].includes("expo/bin/cli"))) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
  if (children.length < 2) throw new Error("Signed host desktop renderer/Electron children are not both live");
  for (const child of children) {
    const processEnvironment = (await execFileAsync("ps", ["eww", "-p", String(child.pid), "-o", "command="], {
      maxBuffer: 4 * 1024 * 1024,
    })).stdout;
    if (processEnvironment.includes(secretBytes) || processEnvironment.includes("MEETLESS_DIRECT_PASSWORD=") ||
        processEnvironment.includes("PASEO_PASSWORD=") || child.command.includes(secretBytes)) {
      throw new Error("Direct password reached a desktop child environment or argv");
    }
  }
  return { renderer: true, electron: true, secretFree: true };
}

async function stopHost(environment) {
  await runNode("scripts/stop-macos-host.mjs", [], environment);
}

async function runNode(script, args, environment) {
  const result = await execFileAsync(process.execPath, [path.join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function launchctl(...args) {
  await execFileAsync("launchctl", args, { maxBuffer: 1024 * 1024 });
}

async function launchctlGetenv(key) {
  return (await execFileAsync("launchctl", ["getenv", key], { maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function inspectCleanState(config, identity) {
  const processRows = (await execFileAsync("ps", ["eww", "-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 })).stdout;
  const hostProcessIds = processRows.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    return match[2] === identity.executablePath || match[2].includes(config.paths.root) ? [Number(match[1])] : [];
  });
  const launchPasswordKeys = [];
  for (const key of ["MEETLESS_DIRECT_PASSWORD", "PASEO_PASSWORD"]) {
    if (await launchctlGetenv(key)) launchPasswordKeys.push(key);
  }
  return {
    hostProcessIds,
    listenerProcessIds: await listenerProcessIds(config.listen),
    ownedSocketPaths: (await Promise.all([
      config.paths.recordingSocket,
      config.paths.transcriptionSocket,
    ].map(async (socketPath) => await pathExists(socketPath) ? socketPath : null))).filter(Boolean),
    runtimeRootExists: await pathExists(config.paths.root),
    launchPasswordKeys,
  };
}

async function listenerProcessIds(listenAddress) {
  const port = listenAddress.slice(listenAddress.lastIndexOf(":") + 1);
  try {
    const result = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.split("\n").flatMap((line) => /^p(\d+)$/u.exec(line)?.[1] ?? []).map(Number);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1 && !error.stdout?.trim()) return [];
    throw error;
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function scanForBytes(root, needle) {
  async function visit(candidate) {
    const info = await lstat(candidate);
    if (info.isDirectory()) {
      for (const child of await readdir(candidate)) if (await visit(path.join(candidate, child))) return true;
      return false;
    }
    return info.isFile() && (await readFile(candidate)).includes(needle);
  }
  return visit(root);
}

async function fileIdentity(filePath) {
  const bytes = await readFile(filePath);
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function oneFrameWav() {
  const data = Buffer.alloc(46);
  data.write("RIFF", 0); data.writeUInt32LE(38, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(2, 40); data.writeInt16LE(0, 44);
  return data;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
