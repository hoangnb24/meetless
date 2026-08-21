import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  buildCompanionClientConfig,
  createDirectCompanionProfile,
  createRelayCompanionProfile,
  MeetlessConnectionSession,
  type CompanionProfile,
  type MeetlessClient,
} from "@meetless/client";
import { MeetingStore } from "@meetless/meeting-store";

let daemonProcess: ChildProcess | null = null;
let relayProcess: ChildProcess | null = null;
let runtimeRoot: string | null = null;
let fixtureSegmentId = "";

afterEach(async () => {
  const children = [daemonProcess, relayProcess].filter((child): child is ChildProcess => child !== null);
  daemonProcess = null;
  relayProcess = null;
  const exits = await Promise.allSettled(children.map(terminateAndAssertChild));
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
  fixtureSegmentId = "";
  const failed = exits.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
});

describe("M6 real direct and E2EE relay composition", () => {
  test("opens the M5 fixture, restores grounded chat, validates citation audio, and rejects wrong direct auth", async () => {
    const directPort = await availablePort();
    const relayPort = await availablePort();
    runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-m6-transport-"));
    await seedM5Fixture(path.join(runtimeRoot, "meeting-store"));

    relayProcess = spawn(
      path.resolve("node_modules/.bin/wrangler"),
      ["dev", "--local", "--ip", "127.0.0.1", "--port", String(relayPort), "--live-reload=false", "--show-interactive-dev-session=false"],
      {
        cwd: path.resolve("vendor/paseo/packages/relay"),
        env: { ...process.env },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    await waitForPort(relayPort, relayProcess, 30_000);

    const directPassword = "m6-automated-direct-secret";
    daemonProcess = spawn(process.execPath, ["packages/runtime/dist/cli.js", "daemon"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEETLESS_RUNTIME_ROOT: runtimeRoot,
        MEETLESS_LISTEN: `127.0.0.1:${directPort}`,
        MEETLESS_DIRECT_PASSWORD: directPassword,
        PASEO_RELAY_ENDPOINT: `127.0.0.1:${relayPort}`,
        PASEO_RELAY_PUBLIC_ENDPOINT: `127.0.0.1:${relayPort}`,
        PASEO_RELAY_USE_TLS: "false",
        PASEO_RELAY_PUBLIC_USE_TLS: "false",
        PASEO_NODE_INSPECT: "0",
        PASEO_LOG_CONSOLE_LEVEL: "fatal",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await waitForDaemon(runtimeRoot, daemonProcess, 30_000);

    const directProfile = createDirectCompanionProfile({
      endpoint: `127.0.0.1:${directPort}`,
      password: directPassword,
    });
    await expectTransportPath(directProfile, "direct");

    const wrongConfig = buildCompanionClientConfig(
      createDirectCompanionProfile({ endpoint: `127.0.0.1:${directPort}`, password: "wrong-test-secret" }),
      { clientId: "m6-wrong-auth" },
    );
    const wrongClient = new DaemonClient({
      ...wrongConfig,
      reconnect: { enabled: false },
      connectTimeoutMs: 3_000,
    });
    try {
      await expect(wrongClient.connect()).rejects.toThrow();
    } finally {
      await wrongClient.close();
    }

    const offerClient = new DaemonClient({
      ...buildCompanionClientConfig(directProfile, { clientId: "m6-offer" }),
      reconnect: { enabled: false },
    });
    let pairing!: Awaited<ReturnType<DaemonClient["getDaemonPairingOffer"]>>;
    try {
      await offerClient.connect();
      pairing = await offerClient.getDaemonPairingOffer();
    } finally {
      await offerClient.close();
    }
    expect(pairing.relayEnabled).toBe(true);
    expect(pairing.url).toEqual(expect.any(String));
    const relayProfile = createRelayCompanionProfile(pairing.url!);
    await expectTransportPath(relayProfile, "relay");
  }, 120_000);

  test("escalates proof-child cleanup and asserts the owned process exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => setTimeout(resolve, 100));
      child.once("error", reject);
    });
    await terminateAndAssertChild(child, 50);
    expect(child.signalCode).toBe("SIGKILL");
  });
});

async function expectTransportPath(profile: CompanionProfile, transport: "direct" | "relay"): Promise<void> {
  let observed = false;
  let observedError: unknown = null;
  const session = new MeetlessConnectionSession(profile, async (client) => {
    try {
      await assertM5Fixture(client);
      observed = true;
    } catch (error) {
      observedError = error;
      throw error;
    }
  });
  try {
    await session.start({ clientId: `m6-${transport}-${Date.now()}`, clientType: "mobile" });
    await waitFor(() => session.getState().status === "online" && observed, 30_000);
    expect(session.getState().status).toBe("online");
  } catch {
    throw new Error(`${transport} path failed in state ${session.getState().status}: ${String(observedError)}`);
  } finally {
    await session.close();
  }
}

async function terminateAndAssertChild(child: ChildProcess, gracefulTimeoutMs = 5_000): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (!(await waitForChildExit(child, gracefulTimeoutMs))) {
      child.kill("SIGKILL");
      expect(await waitForChildExit(child, 5_000)).toBe(true);
    }
  }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function assertM5Fixture(client: MeetlessClient): Promise<void> {
  const meetings = await client.listMeetings();
  expect(meetings).toMatchObject([{ id: "m6-meeting", status: "ready" }]);
  const detail = await client.getMeetingTranscript("m6-meeting");
  expect(detail.transcript?.segments).toMatchObject([
    { range: { segmentId: fixtureSegmentId, startMs: 0, endMs: 1_000 }, text: "The fixture contains eight hundred eighty hertz." },
  ]);
  const chat = await client.getMeetingChat("m6-meeting");
  expect(chat).toMatchObject({
    status: "ready",
    messages: [
      { role: "user", text: "Which interval contains eight hundred eighty hertz?" },
      { role: "assistant", outcome: "supported", citations: [{ meetingId: "m6-meeting", segmentId: fixtureSegmentId }] },
    ],
  });
  const citation = await client.resolveCitation({ meetingId: "m6-meeting", segmentId: fixtureSegmentId });
  expect(citation).toMatchObject({
    meetingId: "m6-meeting",
    segmentId: fixtureSegmentId,
    startMs: 0,
    endMs: 1_000,
    audio: { mimeType: "audio/mpeg" },
  });
  expect(Buffer.from(citation.audio.base64, "base64").byteLength).toBeGreaterThan(1_000);
}

async function seedM5Fixture(storeRoot: string): Promise<void> {
  const now = "2026-08-21T00:00:00.000Z";
  const audioPath = path.join(storeRoot, "m6-fixture", "source.mp3");
  await mkdir(path.dirname(audioPath), { recursive: true });
  await copyFile(path.resolve("test/fixtures/m3/english.mp3"), audioPath);
  const bytes = await readFile(audioPath);
  const identity = { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  const store = new MeetingStore({ root: storeRoot, now: () => now, createId: () => "generated-id" });
  await store.create({ id: "m6-meeting", title: "M6 transport fixture" });
  await store.startRecording({ id: "m6-recording", meetingId: "m6-meeting" });
  await store.commitChunk("m6-recording", {
    id: "m6-chunk", source: "microphone", storageKey: "m6-fixture/source.wav",
    byteLength: 128, sha256: "chunk-sha", committedAt: now, logicalStartMs: 0,
    durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery("m6-recording", "fixture complete");
  await store.markInventoryScanning("m6-recording");
  await store.publishInventory("m6-recording", {
    storageKey: "m6-fixture/inventory.ndjson", digest: "inventory-sha",
    chunkCount: recovered.inventory.knownChunkCount, microphoneCount: 1, systemCount: 0, publishedAt: now,
  });
  await store.beginFinalization("m6-recording", {
    openChunksDurablyClosed: true, chunkSetDigest: "inventory-sha", destination: audioPath, expectedIdentity: identity,
  });
  await store.markRecordingSaved("m6-recording", { destination: audioPath, identity, readable: true });
  const transcript = await store.ensureTranscript({
    meetingId: "m6-meeting", recordingId: "m6-recording", rangeMs: 1_000,
    audio: { destination: audioPath, ...identity, durationMs: 1_000 },
  });
  const request = await store.beginTranscriptRequest(transcript.id);
  fixtureSegmentId = transcript.ranges[0]!.segmentId;
  await store.checkpointTranscriptRange(transcript.id, {
    range: transcript.ranges[0]!, attempts: request!.attempt,
    text: "The fixture contains eight hundred eighty hertz.", usage: null, detectedLanguages: ["en"],
  });
  await store.publishTranscript(transcript.id);
  const thread = await store.startChatQuestion({
    meetingId: "m6-meeting",
    question: "Which interval contains eight hundred eighty hertz?",
    provider: "codex",
    model: "gpt-5",
    threadId: "m6-thread",
    userMessageId: "m6-user-message",
    attemptId: "m6-attempt",
  });
  await store.recordChatRetrieval("m6-meeting", thread.activeAttemptId!, [fixtureSegmentId]);
  await store.completeChatTurn("m6-meeting", {
    attemptId: thread.activeAttemptId!,
    assistantMessageId: "m6-assistant-message",
    outcome: "supported",
    text: "The cited interval contains the tone.",
    citationSegmentIds: [fixtureSegmentId],
  });
  expect((await stat(audioPath)).size).toBe(identity.byteLength);
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Process exited before port ${port} became ready`);
    return new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
  }, timeoutMs);
}

async function waitForDaemon(root: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error("Meetless daemon exited before readiness");
    try {
      const lock = JSON.parse(await readFile(path.join(root, "paseo-home", "paseo.pid"), "utf8"));
      return typeof lock.pid === "number";
    } catch {
      return false;
    }
  }, timeoutMs);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
