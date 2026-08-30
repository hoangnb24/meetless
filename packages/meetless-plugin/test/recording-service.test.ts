import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { MeetingStore } from "@meetless/meeting-store";
import { RecordingService, RecordingStartRollbackError } from "../src/recording-service.js";
import { RecordingInventoryReconciler } from "../src/inventory.js";
import { resolveFixtureExportNow } from "../src/server.js";
import { MeetingLifecycleCoordinator } from "../src/meeting-lifecycle-coordinator.js";

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
  test("startup removes only exact stage names owned by known recordings", async () => {
    const config = await fixtureConfig();
    const store = new MeetingStore({ root: config.storeRoot, approvedExportRoots: [config.exportRoot] });
    await store.create({ id: "meeting-stage", title: "Stage recovery" });
    await store.startRecording({ id: "recording-stage", meetingId: "meeting-stage" });
    await mkdir(config.exportRoot, { recursive: true });
    const owned = path.join(config.exportRoot, ".meetless-recording-stage-00000000-0000-4000-8000-000000000000.mp3.stage");
    const unrelated = path.join(config.exportRoot, ".meetless-other-recording-00000000-0000-4000-8000-000000000000.mp3.stage");
    const deceptive = path.join(config.exportRoot, ".meetless-recording-stage-not-a-uuid.mp3.stage");
    await Promise.all([writeFile(owned, "owned"), writeFile(unrelated, "other"), writeFile(deceptive, "deceptive")]);

    const service = new RecordingService(config, store); services.add(service);
    await service.initialize();

    await expect(access(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(access(deceptive)).resolves.toBeUndefined();
  });

  test("startup does not enumerate exports for failed recordings", async () => {
    const config = await fixtureConfig();
    await mkdir(path.dirname(config.exportRoot), { recursive: true });
    await writeFile(config.exportRoot, "not a directory");
    const store = new MeetingStore({ root: config.storeRoot, approvedExportRoots: [path.dirname(config.exportRoot)] });
    await store.create({ id: "meeting-failed", title: "Failed" });
    await store.startRecording({ id: "recording-failed", meetingId: "meeting-failed" });
    await mkdir(path.join(config.storeRoot, "sessions", "recording-failed"), { recursive: true });
    await store.interruptRecording("recording-failed", "capture failed");
    await store.assessInterruption("recording-failed", { recoverable: false });

    const service = new RecordingService(config, store); services.add(service);
    await expect(service.initialize()).resolves.toBeUndefined();
  });

  test("rejects a direct production start before creating a session or spawning the helper", async () => {
    const config = await fixtureConfig({
      fixture: false,
      authorizeProductionStart: async () => {
        throw new Error(
          "Production recording start rejected before helper spawn: direct daemon ancestry. " +
          "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. Next action: launch with npm run runtime:host.",
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
    let releaseScan!: () => void;
    let scanEntered!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const scanStarted = new Promise<void>((resolve) => { scanEntered = resolve; });
    const config = await fixtureConfig({
      fixture: false,
      authorizeProductionStart: async () => {
        inspections += 1;
        if (inspections === 2) throw new Error("live host identity changed before helper spawn");
      },
    });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    const originalMarkScanning = service.store.markInventoryScanning.bind(service.store);
    service.store.markInventoryScanning = async (recordingId) => {
      scanEntered();
      await scanGate;
      return originalMarkScanning(recordingId);
    };
    let startSettled = false;
    const startResult = service.execute({ version: 1, requestId: "changed", command: "start", title: "Changed host" })
      .then(
        () => { startSettled = true; return new Error("start unexpectedly resolved"); },
        (error: unknown) => { startSettled = true; return error; },
      );
    await scanStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startSettled).toBe(false);
    releaseScan();
    await expect(startResult).resolves.toMatchObject({ message: "live host identity changed before helper spawn" });
    expect(inspections).toBe(2);
    expect(service.helperRuntime().pid).toBeNull();
    expect(await service.store.list()).toEqual([]);
    expect(await service.store.listRecordings()).toEqual([]);
    expect(await service.status()).toMatchObject({ status: "idle", recordingId: null, meetingId: null });
  });

  test("rolls back a meeting when capture permission fails before any media is committed", async () => {
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      helperArguments: [path.resolve("packages/meetless-plugin/test/fixtures/start-permission-denied.mjs")],
      authorizeProductionStart: async () => undefined,
    });
    const service = new RecordingService(config); services.add(service); await service.initialize();

    await expect(service.execute({ version: 1, requestId: "denied", command: "start", title: "Not started" }))
      .rejects.toThrow("The user declined TCCs for application, window, display capture");

    expect(await service.store.list()).toEqual([]);
    expect(await service.store.listRecordings()).toEqual([]);
    expect(await readdir(path.join(config.storeRoot, "sessions"))).toEqual([]);
    expect(await service.status()).toMatchObject({ status: "idle", recordingId: null, meetingId: null });
  });

  test("quiesces a timed-out helper before deleting a conclusively empty start", async () => {
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      helperStartTimeoutMs: 50,
      authorizeProductionStart: async () => undefined,
    });
    const pidPath = path.join(path.dirname(config.storeRoot), "hanging-helper.pid");
    const exitPath = path.join(path.dirname(config.storeRoot), "hanging-helper.exited");
    config.helperArguments = [
      path.resolve("packages/meetless-plugin/test/fixtures/start-hangs.mjs"),
      pidPath,
      exitPath,
    ];
    const service = new RecordingService(config); services.add(service); await service.initialize();

    await expect(service.execute({ version: 1, requestId: "timeout", command: "start", title: "Timed out" }))
      .rejects.toThrow("Timed out waiting for helper started");

    const helperPid = Number((await readFile(pidPath, "utf8")).trim());
    expect(await readFile(exitPath, "utf8")).toBe("exited\n");
    expect(processExists(helperPid)).toBe(false);
    expect(await service.store.list()).toEqual([]);
    expect(await readdir(path.join(config.storeRoot, "sessions"))).toEqual([]);
  });

  test("does not deadlock when started and failure events arrive after the start timeout", async () => {
    const lifecycle = new MeetingLifecycleCoordinator();
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      helperArguments: [
        path.resolve("packages/meetless-plugin/test/fixtures/start-late-events.mjs"),
        "75",
      ],
      helperStartTimeoutMs: 20,
      authorizeProductionStart: async () => undefined,
    });
    const service = new RecordingService(config, undefined, lifecycle); services.add(service); await service.initialize();

    await expect(service.execute({ version: 1, requestId: "late-timeout", command: "start", title: "Late" }))
      .rejects.toThrow("Timed out waiting for helper started");

    expect(await service.store.list()).toEqual([]);
    expect(await service.store.listRecordings()).toEqual([]);
    expect(await readdir(path.join(config.storeRoot, "sessions"))).toEqual([]);
    expect(await service.status()).toMatchObject({ status: "idle", recordingId: null, meetingId: null });
  }, 5_000);

  test("rolls back a meeting when recording creation fails before helper startup", async () => {
    const config = await fixtureConfig();
    const store = new MeetingStore({ root: config.storeRoot, approvedExportRoots: [config.exportRoot] });
    const originalStartRecording = store.startRecording.bind(store);
    store.startRecording = async () => { throw new Error("recording state write failed"); };
    const service = new RecordingService(config, store); services.add(service); await service.initialize();

    await expect(service.execute({ version: 1, requestId: "state-failure", command: "start", title: "State failure" }))
      .rejects.toThrow("recording state write failed");

    expect(await store.list()).toEqual([]);
    expect(await store.listRecordings()).toEqual([]);
    store.startRecording = originalStartRecording;
  });

  test("rolls back without inventory when session setup fails before helper construction", async () => {
    const config = await fixtureConfig({
      fixture: false,
      authorizeProductionStart: async () => undefined,
    });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    const sessions = path.join(config.storeRoot, "sessions");
    await chmod(sessions, 0o500);
    try {
      await expect(service.execute({ version: 1, requestId: "session-failure", command: "start", title: "Session failure" }))
        .rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(sessions, 0o700);
    }

    expect(await service.store.list()).toEqual([]);
    expect(await service.store.listRecordings()).toEqual([]);
    expect(await readdir(sessions)).toEqual([]);
  });

  test.each(["committed", "orphan", "late"] as const)(
    "preserves %s media when helper startup fails",
    async (mode) => {
      const config = await fixtureConfig({
        fixture: false,
        helperPath: process.execPath,
        authorizeProductionStart: async () => undefined,
      });
      const sourceWav = await createSourceWav(config, `startup-${mode}`);
      config.helperArguments = [
        path.resolve("packages/meetless-plugin/test/fixtures/start-failure-after-media.mjs"),
        sourceWav,
        mode,
      ];
      const service = new RecordingService(config); services.add(service); await service.initialize();

      await expect(service.execute({ version: 1, requestId: mode, command: "start", title: `Keep ${mode}` }))
        .rejects.toThrow("capture startup failed after media");

      expect(await service.store.list()).toHaveLength(1);
      expect(await service.store.listRecordings()).toHaveLength(1);
      expect(await service.status()).toMatchObject({
        status: "recoverable",
        inventoryState: "complete",
        chunkCount: 1,
        retryEligible: true,
      });
    },
    15_000,
  );

  test("allows permission denial followed by a successful start after service relaunch", async () => {
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      authorizeProductionStart: async () => undefined,
    });
    const permissionState = path.join(path.dirname(config.storeRoot), "permission-granted");
    const sourceWav = await createSourceWav(config, "permission-retry");
    config.helperArguments = [
      path.resolve("packages/meetless-plugin/test/fixtures/start-permission-retry.mjs"),
      permissionState,
      sourceWav,
    ];
    const first = new RecordingService(config); services.add(first); await first.initialize();

    await expect(first.execute({ version: 1, requestId: "denied", command: "start", title: "First" }))
      .rejects.toThrow("The user declined TCCs for application, window, display capture");
    expect(await first.store.list()).toEqual([]);
    await first.shutdown(); services.delete(first);

    const relaunched = new RecordingService(config); services.add(relaunched); await relaunched.initialize();
    await expect(relaunched.execute({ version: 1, requestId: "granted", command: "start", title: "Second" }))
      .resolves.toMatchObject({ status: "recording", title: "Second" });
    await waitFor(async () => (await relaunched.status()).chunks.length === 1);
    expect(await relaunched.store.list()).toHaveLength(1);
  }, 15_000);

  test("holds active-capture exclusion until zero-media rollback commits", async () => {
    const lifecycle = new MeetingLifecycleCoordinator();
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      helperArguments: [path.resolve("packages/meetless-plugin/test/fixtures/start-permission-denied.mjs")],
      authorizeProductionStart: async () => undefined,
    });
    const service = new RecordingService(config, undefined, lifecycle); services.add(service); await service.initialize();
    const originalDelete = service.store.deleteMeeting.bind(service.store);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let enteredDelete!: (meetingId: string) => void;
    const deleteEntered = new Promise<string>((resolve) => { enteredDelete = resolve; });
    service.store.deleteMeeting = async (meetingId, input) => {
      enteredDelete(meetingId);
      await deleteGate;
      return originalDelete(meetingId, input);
    };

    const start = service.execute({ version: 1, requestId: "race", command: "start", title: "Race" });
    const meetingId = await deleteEntered;
    expect(lifecycle.tryAcquireDeletion(meetingId)).toEqual({ acquired: false, active: ["active_capture"] });
    releaseDelete();
    await expect(start).rejects.toThrow("The user declined TCCs for application, window, display capture");
    const after = lifecycle.tryAcquireDeletion(meetingId);
    expect(after.acquired).toBe(true);
    if (after.acquired) after.lease.release();
  });

  test("keeps the actionable start error primary when rollback cleanup fails", async () => {
    const lifecycle = new MeetingLifecycleCoordinator();
    const config = await fixtureConfig({
      fixture: false,
      helperPath: process.execPath,
      helperArguments: [path.resolve("packages/meetless-plugin/test/fixtures/start-permission-denied.mjs")],
      authorizeProductionStart: async () => undefined,
    });
    const service = new RecordingService(config, undefined, lifecycle); services.add(service); await service.initialize();
    service.store.deleteMeeting = async () => { throw new Error("injected rollback cleanup failure"); };

    const error = await service.execute({ version: 1, requestId: "cleanup", command: "start", title: "Cleanup" })
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(RecordingStartRollbackError);
    expect(error).toMatchObject({
      message: "The user declined TCCs for application, window, display capture",
      rollbackError: expect.objectContaining({ message: "injected rollback cleanup failure" }),
    });
    expect(await service.status()).toMatchObject({ status: "failed", chunkCount: 0 });
    const meetingId = (await service.store.list())[0]!.id;
    const deletion = lifecycle.tryAcquireDeletion(meetingId);
    expect(deletion.acquired).toBe(true);
    if (deletion.acquired) deletion.lease.release();
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
    expect((await readdir(path.join(config.storeRoot, "sessions", saved.recordingId!))).filter((name) => name.endsWith(".wav"))).toEqual([]);
  }, 30_000);

  test("retries finalization from the immutable chunk set without recording again", async () => {
    const config = await fixtureConfig({ failFinalizationOnce: true });
    const service = new RecordingService(config); services.add(service); await service.initialize();
    await service.execute({ version: 1, requestId: "start", command: "start", title: "Retry fixture" });
    await waitFor(async () => (await service.status()).chunks.length >= 2);
    await expect(service.execute({ version: 1, requestId: "stop", command: "stop" })).rejects.toThrow("retry without re-recording");
    const recoverable = await service.status();
    expect(recoverable.status).toBe("recoverable");
    const digest = recoverable.inventoryDigest;
    const chunkCount = recoverable.chunkCount;
    const saved = await service.execute({ version: 1, requestId: "retry", command: "retryFinalization" });
    expect(saved.status).toBe("saved");
    expect(saved).toMatchObject({ inventoryDigest: digest, chunkCount, chunks: [] });
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

  test("graceful shutdown drains a delayed final callback before exact recoverable inventory assessment", async () => {
    const config = await fixtureConfig();
    const service = new RecordingService(config); services.add(service); await service.initialize();
    const committedIds: string[] = [];
    const originalCommit = service.store.commitChunk.bind(service.store);
    let delayNext = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedCommitEntered = new Promise<void>((resolve) => { entered = resolve; });
    service.store.commitChunk = async (recordingId, chunk) => {
      committedIds.push(chunk.id);
      if (delayNext) {
        delayNext = false;
        entered();
        await gate;
      }
      return originalCommit(recordingId, chunk);
    };

    await service.execute({ version: 1, requestId: "start-delayed", command: "start", title: "Delayed shutdown" });
    await waitFor(async () => committedIds.length >= 2);
    delayNext = true;
    await delayedCommitEntered;
    const shutdown = service.shutdown();
    release();
    await shutdown;
    services.delete(service);

    const recovered = await service.status();
    expect(recovered.status).toBe("recoverable");
    expect(recovered.chunks.map((chunk) => chunk.id).sort()).toEqual([...committedIds].sort());
    expect(recovered.chunks.length).toBe(committedIds.length);
  }, 30_000);

  test("crash-style stale recording restart becomes recoverable without replacing committed chunks", async () => {
    const config = await fixtureConfig();
    const seed = new MeetingStore({ root: config.storeRoot });
    const meeting = await seed.create({ title: "Crash recovery" });
    const recording = await seed.startRecording({ meetingId: meeting.id });
    await seedRecoverableChunk(seed, config, recording.id, "microphone", 440, "2026-08-18T02:20:50.000Z");
    const before = (await seed.listRecordings())[0]!.chunks;

    const restarted = new RecordingService(config); services.add(restarted); await restarted.initialize();
    const recovered = await restarted.status();
    expect(recovered).toMatchObject({ status: "recoverable", recordingId: recording.id, inventoryState: "pending", retryEligible: false });
    expect(recovered.chunks).toEqual(before);
    expect(recovered.error).toBe("daemon restarted while capture was active");
  }, 30_000);

  test("startup reconciliation adopts a valid orphan WAV and keeps retry enabled", async () => {
    const config = await fixtureConfig();
    const seed = new MeetingStore({ root: config.storeRoot });
    const meeting = await seed.create({ title: "Orphan recovery" });
    const recording = await seed.startRecording({ meetingId: meeting.id });
    const sessionDirectory = path.join(config.storeRoot, "sessions", recording.id);
    const orphanId = "chunk--system--000000--000000000000--000000016000--16000--1";
    await mkdir(sessionDirectory, { recursive: true });
    await execFileAsync(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=frequency=880:duration=1:sample_rate=16000", "-ar", "16000", "-ac", "1",
      path.join(sessionDirectory, `${orphanId}.wav`),
    ]);

    const restarted = new RecordingService(config); services.add(restarted); await restarted.initialize();
    await waitFor(async () => (await restarted.status()).retryEligible);
    expect(await restarted.status()).toMatchObject({
      status: "recoverable",
      recordingId: recording.id,
      inventoryState: "complete",
      chunkCount: 1,
      systemCount: 1,
      retryEligible: true,
    });
  }, 30_000);

  test("restart does not reopen every already-committed chunk before exposing recovery", async () => {
    const config = await fixtureConfig();
    const seed = new MeetingStore({ root: config.storeRoot });
    const meeting = await seed.create({ title: "Bounded known inventory" });
    const recording = await seed.startRecording({ meetingId: meeting.id });
    const id = "chunk--microphone--000000--000000000000--000000016000--16000--1";
    const sessionDirectory = path.join(config.storeRoot, "sessions", recording.id);
    const storageKey = path.join("sessions", recording.id, `${id}.wav`);
    await mkdir(sessionDirectory, { recursive: true });
    await execFileAsync("mkfifo", [path.join(config.storeRoot, storageKey)]);
    await seed.commitChunk(recording.id, {
      id, source: "microphone", storageKey, byteLength: 1, sha256: "a".repeat(64),
      committedAt: "2026-08-18T02:20:50.000Z", logicalStartMs: 0, durationMs: 1_000,
      sampleRate: 16_000, channels: 1, format: "wav",
    });

    const restarted = new RecordingService(config); services.add(restarted);
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      status: "recoverable", recordingId: recording.id, chunks: [{ id }],
    });
  }, 5_000);

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
    const inventory = await new RecordingInventoryReconciler(config.storeRoot, service.store)
      .reconcile(await service.store.prepareInventoryRecovery(recording.id, "publication fixture capture closed"));
    await service.store.beginFinalization(recording.id, {
      openChunksDurablyClosed: true, chunkSetDigest: inventory.digest, destination, expectedIdentity: outputIdentity,
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

    await waitFor(async () => (await restarted.status()).retryEligible);

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
    await waitFor(async () => (await service.status()).retryEligible);

    let beforeRejectedStart = await readFile(statePath);
    await expect(service.execute({ version: 1, requestId: "blocked-old", command: "start", title: "Blocked" }))
      .rejects.toThrow(/Resolve recording recording-old/u);
    expect(await readFile(statePath)).toEqual(beforeRejectedStart);

    await service.execute({ version: 1, requestId: "retry-old", command: "retryFinalization" });
    expect((await service.store.listRecordings()).find((recording) => recording.id === "recording-old")?.status).toBe("saved");
    expect(await service.status()).toMatchObject({ recordingId: "recording-new", status: "recoverable" });
    await waitFor(async () => (await service.status()).retryEligible);

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

async function createSourceWav(
  config: Awaited<ReturnType<typeof fixtureConfig>>,
  name: string,
): Promise<string> {
  const sourceWav = path.join(path.dirname(config.storeRoot), `${name}.wav`);
  await execFileAsync(config.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=1:sample_rate=16000", "-ar", "16000", "-ac", "1", sourceWav,
  ]);
  return sourceWav;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
