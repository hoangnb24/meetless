import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { RecordingService } from "../src/recording-service.js";

const roots = new Set<string>();
const services = new Set<RecordingService>();
const execFileAsync = promisify(execFile);

async function fixtureConfig(extra: Partial<ConstructorParameters<typeof RecordingService>[0]> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-recording-service-"));
  roots.add(root);
  return {
    storeRoot: path.join(root, "store"),
    helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
    ffmpeg: "/opt/homebrew/bin/ffmpeg",
    ffprobe: "/opt/homebrew/bin/ffprobe",
    exportRoot: path.join(root, "Documents", "meetings"),
    fixture: true,
    exportNow: () => new Date("2026-08-17T12:00:00+07:00"),
    ...extra,
  };
}

afterEach(async () => {
  await Promise.all([...services].map((service) => service.shutdown()));
  services.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("daemon recording service", () => {
  test("serializes pause/resume, preserves collision bytes, publishes a playable MP3, then cleans chunks", async () => {
    const config = await fixtureConfig();
    const collision = path.join(config.exportRoot, "12-17-08-26.mp3");
    await mkdir(config.exportRoot, { recursive: true });
    await writeFile(collision, "existing recording bytes", { encoding: "utf8", flag: "wx" });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "start", command: "start", title: "Fixture tones" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);

    const [paused, serializedStatus] = await Promise.all([
      service.execute({ version: 1, requestId: "pause", command: "pause" }),
      service.execute({ version: 1, requestId: "status", command: "status" }),
    ]);
    expect(paused.paused).toBe(true);
    expect(serializedStatus.paused).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await service.status()).elapsedMs).toBe(paused.elapsedMs);
    await service.execute({ version: 1, requestId: "resume", command: "resume" });
    await waitFor(async () => (await service.status()).chunks.length >= 4);
    const saved = await service.execute({ version: 1, requestId: "stop", command: "stop" });

    expect(saved).toMatchObject({ status: "saved", outputPath: path.join(config.exportRoot, "12-17-08-26-2.mp3") });
    expect(await readFile(collision, "utf8")).toBe("existing recording bytes");
    expect(await readdir(path.join(config.storeRoot, "sessions", saved.recordingId!))).toEqual([]);
  }, 30_000);

  test("retries finalization from the immutable chunk set without recording again", async () => {
    const config = await fixtureConfig({ failFinalizationOnce: true });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "start", command: "start", title: "Retry fixture" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);
    await expect(service.execute({ version: 1, requestId: "stop", command: "stop" })).rejects.toThrow("retry without re-recording");
    const recoverable = await service.status();
    expect(recoverable.status).toBe("recoverable");
    const chunkIds = recoverable.chunks.map((chunk) => chunk.id);
    const saved = await service.execute({ version: 1, requestId: "retry", command: "retryFinalization" });
    expect(saved.status).toBe("saved");
    expect(saved.chunks.map((chunk) => chunk.id)).toEqual(chunkIds);
  }, 30_000);

  test("reconstructs a recoverable session after daemon-owned service restart and never adopts partials", async () => {
    const config = await fixtureConfig();
    const first = new RecordingService(config); services.add(first); await first.initialize();
    await first.execute({ version: 1, requestId: "start", command: "start", title: "Restart fixture" });
    await waitFor(async () => (await first.status()).chunks.length >= 2);
    const recordingId = (await first.status()).recordingId!;
    const sessionDirectory = path.join(config.storeRoot, "sessions", recordingId);
    await writeFile(path.join(sessionDirectory, ".uncommitted.partial"), "partial", "utf8");
    const malformedOrphan = "chunk--system--999999--000000032000--000000016000--16000--1";
    await writeFile(path.join(sessionDirectory, `${malformedOrphan}.wav`), "RIFF malformed orphan", "utf8");
    await first.shutdown(); services.delete(first);

    const restarted = new RecordingService(config); services.add(restarted); await restarted.initialize();
    const recovered = await restarted.status();
    expect(recovered.status).toBe("recoverable");
    expect(recovered.chunks.length).toBeGreaterThanOrEqual(2);
    expect(recovered.chunks.some((chunk) => chunk.id.includes("uncommitted"))).toBe(false);
    expect(recovered.chunks.some((chunk) => chunk.id === malformedOrphan)).toBe(false);
  }, 30_000);

  test("adopts only the exact decode-readable publish intent after publication-before-saved crash", async () => {
    const config = await fixtureConfig();
    const service = new RecordingService(config); services.add(service); await service.initialize();
    const meeting = await service.store.create({ title: "Publication crash" });
    const recording = await service.store.startRecording({ meetingId: meeting.id });
    const sessionDirectory = path.join(config.storeRoot, "sessions", recording.id);
    await mkdir(sessionDirectory, { recursive: true });
    const chunkPath = path.join(sessionDirectory, "chunk--microphone--000000--000000000000--000000016000--16000--1.wav");
    await execFileAsync(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=16000", "-ar", "16000", "-ac", "1", chunkPath]);
    const chunkIdentity = await identity(chunkPath);
    await service.store.commitChunk(recording.id, {
      id: path.basename(chunkPath, ".wav"), source: "microphone", storageKey: path.relative(config.storeRoot, chunkPath),
      ...chunkIdentity, committedAt: new Date().toISOString(), logicalStartMs: 0, durationMs: 1_000,
      sampleRate: 16_000, channels: 1, format: "wav",
    });
    const destination = path.join(config.exportRoot, "published.mp3");
    await mkdir(config.exportRoot, { recursive: true });
    await execFileAsync(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", chunkPath, "-codec:a", "libmp3lame", destination]);
    const outputIdentity = await identity(destination);
    await service.store.beginFinalization(recording.id, {
      openChunksDurablyClosed: true, chunkSetDigest: "fixed-set", destination, expectedIdentity: outputIdentity,
    });
    await service.shutdown(); services.delete(service);

    const restarted = new RecordingService(config); services.add(restarted); await restarted.initialize();
    expect((await restarted.status()).status).toBe("saved");
    await expect(access(chunkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await identity(destination)).toEqual(outputIdentity);
  }, 30_000);

  test("keeps a non-last recoverable session selected, rejects byte-changing start, then allows start after retry", async () => {
    const config = await fixtureConfig();
    const first = new RecordingService(config); services.add(first); await first.initialize();
    await first.execute({ version: 1, requestId: "saved-start", command: "start", title: "Saved history" });
    await waitFor(async () => (await first.status()).chunks.length >= 2);
    await first.execute({ version: 1, requestId: "saved-stop", command: "stop" });

    await first.execute({ version: 1, requestId: "recoverable-start", command: "start", title: "Must recover" });
    await waitFor(async () => (await first.status()).chunks.length >= 2);
    const recoverableId = (await first.status()).recordingId!;
    await first.shutdown(); services.delete(first);

    const statePath = path.join(config.storeRoot, "meetings.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { recordings: unknown[] };
    persisted.recordings.reverse();
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const restarted = new RecordingService(config); services.add(restarted); await restarted.initialize();
    expect(await restarted.status()).toMatchObject({ recordingId: recoverableId, status: "recoverable", title: "Must recover" });
    const beforeRejectedStart = await readFile(statePath);
    await expect(restarted.execute({
      version: 1, requestId: "blocked-start", command: "start", title: "Must not strand recovery",
    })).rejects.toThrow(/Resolve recording.*recoverable.*before starting another/u);
    expect(await readFile(statePath)).toEqual(beforeRejectedStart);

    const saved = await restarted.execute({ version: 1, requestId: "retry", command: "retryFinalization" });
    expect(saved).toMatchObject({ recordingId: recoverableId, status: "saved" });
    const next = await restarted.execute({ version: 1, requestId: "next-start", command: "start", title: "Now allowed" });
    expect(next).toMatchObject({ status: "recording", title: "Now allowed" });
  }, 30_000);
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for recording fixture state");
}

async function identity(filePath: string) {
  const data = await readFile(filePath); const info = await stat(filePath);
  return { byteLength: info.size, sha256: createHash("sha256").update(data).digest("hex") };
}
