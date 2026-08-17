import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { MeetingStore } from "@meetless/meeting-store";
import { RecordingService } from "../src/recording-service.js";
import { resolveFixtureExportNow } from "../src/server.js";

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
  test("rejects a direct production start before creating a session or spawning the helper", async () => {
    const config = await fixtureConfig({
      fixture: false,
      authorizeProductionStart: async () => {
        throw new Error(
          "Production recording start rejected before helper spawn: direct daemon ancestry. " +
          "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: launch with npm run runtime:host.",
        );
      },
    });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await expect(service.execute({ version: 1, requestId: "direct", command: "start", title: "Rejected" }))
      .rejects.toThrow(/rejected before helper spawn.*direct daemon ancestry.*Authority.*runtime:host/s);
    expect(await service.store.listRecordings()).toEqual([]);
    expect(service.helperRuntime().pid).toBeNull();
  });

  test("revalidates host provenance immediately before helper construction", async () => {
    let inspections = 0;
    const config = await fixtureConfig({
      fixture: false,
      authorizeProductionStart: async () => {
        inspections += 1;
        if (inspections === 2) throw new Error("live host identity changed before helper spawn");
      },
    });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await expect(service.execute({ version: 1, requestId: "changed", command: "start", title: "Changed host" }))
      .rejects.toThrow("live host identity changed before helper spawn");
    expect(inspections).toBe(2);
    expect(service.helperRuntime().pid).toBeNull();
    expect(await service.status()).toMatchObject({ status: "failed", error: "No readable committed chunks survived" });
  });

  test("production ignores fixture export stamps", () => {
    expect(resolveFixtureExportNow(false, "2026-08-17T12:00:00+07:00")).toBeUndefined();
    expect(resolveFixtureExportNow(true, "2026-08-17T12:00:00+07:00")?.().toISOString())
      .toBe("2026-08-17T05:00:00.000Z");
  });

  test("binds prepared collision evidence to stop across an hour boundary", async () => {
    const config = await fixtureConfig({ exportNow: () => new Date("2026-08-17T15:01:00+07:00") });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "start", command: "start", title: "Boundary fixture" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);

    const runtimeInstanceId = "ae988264-f028-4700-b2b3-afac8e4ce53a";
    const prepared = await service.prepareCollisionEvidence(
      runtimeInstanceId,
      new Date("2026-08-17T14:59:59+07:00"),
    );
    expect(prepared.path).toBe(path.join(config.exportRoot, "14-17-08-26.mp3"));
    expect(prepared.plannedPublishedPath).toBe(path.join(config.exportRoot, "14-17-08-26-2.mp3"));

    const saved = await service.execute({ version: 1, requestId: "stop", command: "stop" });
    expect(saved.outputPath).toBe(prepared.plannedPublishedPath);
    expect(await readFile(prepared.path, "utf8")).toContain(`runtime=${runtimeInstanceId}`);
  }, 30_000);

  test("revalidates a prepared target immediately before stop and keeps capture live on collision", async () => {
    const config = await fixtureConfig();
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "start", command: "start", title: "Revalidation fixture" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);
    const prepared = await service.prepareCollisionEvidence(
      "fe461197-64e4-4399-9317-da0d4484d35e",
      new Date("2026-08-17T12:00:00+07:00"),
    );
    await writeFile(prepared.plannedPublishedPath, "late collision", { flag: "wx" });

    await expect(service.execute({ version: 1, requestId: "stop", command: "stop" }))
      .rejects.toThrow(/no longer collision-safe.*runtime:preowner/u);
    expect(await service.status()).toMatchObject({ status: "recording", recordingId: prepared.recordingId });
    expect(service.helperRuntime().pid).toEqual(expect.any(Number));
  }, 30_000);

  test("consumes prepared collision state at durable finalization intent before retry and the next recording", async () => {
    const config = await fixtureConfig({ failFinalizationOnce: true });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "first-start", command: "start", title: "Interrupted prepared stop" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);
    const prepared = await service.prepareCollisionEvidence(
      "27d24098-41f8-46eb-a2a0-cb4db64dc493",
      new Date("2026-08-17T12:00:00+07:00"),
    );

    await expect(service.execute({ version: 1, requestId: "first-stop", command: "stop" }))
      .rejects.toThrow("retry without re-recording");
    expect(await service.status()).toMatchObject({ status: "recoverable", recordingId: prepared.recordingId });
    await expect(service.execute({ version: 1, requestId: "retry", command: "retryFinalization" }))
      .resolves.toMatchObject({ status: "saved", recordingId: prepared.recordingId });

    await service.execute({ version: 1, requestId: "second-start", command: "start", title: "Fresh recording" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);
    await expect(service.execute({ version: 1, requestId: "second-stop", command: "stop" }))
      .resolves.toMatchObject({ status: "saved", title: "Fresh recording" });
  }, 30_000);

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
    expect(await first.status()).toMatchObject({ status: "recoverable", recordingId });

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

  test("drains two persisted unresolved sessions oldest-first regardless of storage order", async () => {
    const config = await fixtureConfig();
    let now = "2026-08-17T10:00:00.000Z";
    const seed = new MeetingStore({ root: config.storeRoot, now: () => now });
    await seed.create({ id: "meeting-old", title: "Old recovery" });
    await seed.startRecording({ id: "recording-old", meetingId: "meeting-old" });
    await seedRecoverableChunk(seed, config, "recording-old", "microphone", 440, "2026-08-17T10:00:01.000Z");
    now = "2026-08-17T10:00:02.000Z";
    await seed.interruptRecording("recording-old", "seeded interruption");
    now = "2026-08-17T10:00:03.000Z";
    await seed.assessInterruption("recording-old", { recoverable: true });

    now = "2026-08-17T11:00:00.000Z";
    await seed.create({ id: "meeting-new", title: "New recovery" });
    await seed.startRecording({ id: "recording-new", meetingId: "meeting-new" });
    await seedRecoverableChunk(seed, config, "recording-new", "system", 880, "2026-08-17T11:00:01.000Z");
    now = "2026-08-17T11:00:02.000Z";
    await seed.interruptRecording("recording-new", "seeded interruption");
    now = "2026-08-17T11:00:03.000Z";
    await seed.assessInterruption("recording-new", { recoverable: true });

    const statePath = path.join(config.storeRoot, "meetings.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { recordings: unknown[] };
    persisted.recordings.reverse();
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const service = new RecordingService(config); services.add(service);
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(await service.status()).toMatchObject({ recordingId: "recording-old", status: "recoverable" });

    let beforeRejectedStart = await readFile(statePath);
    await expect(service.execute({ version: 1, requestId: "blocked-old", command: "start", title: "Blocked" }))
      .rejects.toThrow(/Resolve recording recording-old/u);
    expect(await readFile(statePath)).toEqual(beforeRejectedStart);

    await service.execute({ version: 1, requestId: "retry-old", command: "retryFinalization" });
    expect((await service.store.listRecordings()).find((recording) => recording.id === "recording-old")?.status).toBe("saved");
    expect(await service.status()).toMatchObject({ recordingId: "recording-new", status: "recoverable" });

    beforeRejectedStart = await readFile(statePath);
    await expect(service.execute({ version: 1, requestId: "blocked-new", command: "start", title: "Still blocked" }))
      .rejects.toThrow(/Resolve recording recording-new/u);
    expect(await readFile(statePath)).toEqual(beforeRejectedStart);

    await service.execute({ version: 1, requestId: "retry-new", command: "retryFinalization" });
    expect((await service.store.listRecordings()).find((recording) => recording.id === "recording-new")?.status).toBe("saved");
    await expect(service.execute({ version: 1, requestId: "allowed", command: "start", title: "All drained" }))
      .resolves.toMatchObject({ status: "recording", title: "All drained" });
  }, 30_000);
});

async function seedRecoverableChunk(
  store: MeetingStore,
  config: Awaited<ReturnType<typeof fixtureConfig>>,
  recordingId: string,
  source: "microphone" | "system",
  frequency: number,
  committedAt: string,
): Promise<void> {
  const sessionDirectory = path.join(config.storeRoot, "sessions", recordingId);
  await mkdir(sessionDirectory, { recursive: true });
  const id = `chunk--${source}--000000--000000000000--000000016000--16000--1`;
  const chunkPath = path.join(sessionDirectory, `${id}.wav`);
  await execFileAsync(config.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `sine=frequency=${frequency}:duration=1:sample_rate=16000`, "-ar", "16000", "-ac", "1", chunkPath,
  ]);
  await store.commitChunk(recordingId, {
    id, source, storageKey: path.relative(config.storeRoot, chunkPath), ...(await identity(chunkPath)),
    committedAt, logicalStartMs: 0, durationMs: 1_000,
    sampleRate: 16_000, channels: 1, format: "wav",
  });
}

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
