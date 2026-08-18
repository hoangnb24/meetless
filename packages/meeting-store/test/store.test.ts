import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InvalidMeetingTransitionError } from "@meetless/meeting-domain";
import {
  MeetingStore,
  MeetingStoreCorruptError,
  RecordingOwnedMeetingTransitionError,
} from "../src/index.js";

const roots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-store-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("meeting store", () => {
  test("persists a create and rejects an invalid transition without changing disk", async () => {
    const root = await temporaryRoot();
    let tick = 0;
    const store = new MeetingStore({
      root,
      now: () => `2026-08-16T10:00:0${tick++}.000Z`,
      createId: () => "m-1",
    });
    await store.create({ title: "Design sync" });
    const before = await readFile(store.filePath, "utf8");

    await expect(store.transition("m-1", "ready")).rejects.toBeInstanceOf(
      InvalidMeetingTransitionError,
    );

    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect(await store.list()).toMatchObject([{ id: "m-1", status: "draft" }]);
  });

  test("serializes concurrent atomic creates without losing records", async () => {
    const root = await temporaryRoot();
    let id = 0;
    const store = new MeetingStore({
      root,
      now: () => "2026-08-16T10:00:00.000Z",
      createId: () => `m-${++id}`,
    });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.create({ title: `Meeting ${index}` })),
    );

    const meetings = await store.list();
    expect(meetings).toHaveLength(40);
    expect(new Set(meetings.map((meeting) => meeting.id))).toHaveLength(40);
    expect((await readdir(root)).sort()).toEqual(["meetings.json"]);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({ version: 3 });
  });

  test("fails closed and preserves corrupt state", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "meetings.json");
    await writeFile(filePath, "{ corrupt state\n", "utf8");
    const store = new MeetingStore({ root });

    await expect(store.create({ title: "Must not overwrite" })).rejects.toBeInstanceOf(
      MeetingStoreCorruptError,
    );
    expect(await readFile(filePath, "utf8")).toBe("{ corrupt state\n");
  });

  test("migrates schema v1 atomically without changing existing meetings", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "meetings.json");
    const meeting = {
      id: "m-1",
      title: "Existing meeting",
      status: "draft",
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    };
    await writeFile(filePath, `${JSON.stringify({ version: 1, meetings: [meeting] }, null, 2)}\n`, "utf8");

    const store = new MeetingStore({ root });
    await store.migrateSchemaV1();

    expect(await store.list()).toEqual([meeting]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 3,
      meetings: [meeting],
      recordings: [],
    });
    expect((await readdir(root)).sort()).toEqual(["meetings.json"]);
  });

  test("recording lifecycle owns both coupled meeting transitions", async () => {
    const root = await temporaryRoot();
    let now = "2026-08-17T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Coupled lifecycle" });

    const draftContents = await readFile(store.filePath, "utf8");
    await expect(store.transition("m-1", "recording")).rejects.toBeInstanceOf(
      RecordingOwnedMeetingTransitionError,
    );
    await expect(store.transition("m-1", "recording")).rejects.toThrow(
      /docs\/product\/recording\.md.*Call startRecording/,
    );
    expect(await readFile(store.filePath, "utf8")).toBe(draftContents);

    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    let restarted = new MeetingStore({ root });
    expect(await restarted.list()).toMatchObject([{ id: "m-1", status: "recording" }]);
    expect(await restarted.listRecordings()).toMatchObject([{ id: "r-1", status: "recording" }]);

    const coupledContents = await readFile(store.filePath, "utf8");
    await expect(store.transition("m-1", "processing")).rejects.toBeInstanceOf(
      RecordingOwnedMeetingTransitionError,
    );
    await expect(store.transition("m-1", "processing")).rejects.toThrow(
      /docs\/product\/recording\.md.*Call beginFinalization/,
    );
    expect(await readFile(store.filePath, "utf8")).toBe(coupledContents);

    now = "2026-08-17T10:00:02.000Z";
    await store.pauseRecording("r-1", true);
    restarted = new MeetingStore({ root });
    expect(await restarted.list()).toMatchObject([{ status: "recording" }]);
    expect(await restarted.listRecordings()).toMatchObject([{ status: "recording", activeSince: null }]);
    await store.resumeRecording("r-1");

    const beforeRejectedFinalization = await readFile(store.filePath, "utf8");
    await expect(store.beginFinalization("r-1", {
      openChunksDurablyClosed: true,
      chunkSetDigest: "empty-set",
      destination: "meetings/rejected.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    })).rejects.toThrow(/inventory reconciliation/);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeRejectedFinalization);
    expect(await store.list()).toMatchObject([{ status: "recording" }]);
    expect(await store.listRecordings()).toMatchObject([{ status: "recording", finalization: null }]);

    await store.commitChunk("r-1", {
      id: "mic-1",
      source: "microphone",
      storageKey: "sessions/r-1/mic-1.chunk",
      byteLength: 128,
      sha256: "chunk-sha",
      committedAt: "2026-08-17T10:00:05.000Z",
      logicalStartMs: 0, durationMs: 5_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-1", "chunk-set-sha");
    now = "2026-08-17T10:00:10.000Z";
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true,
      chunkSetDigest: "chunk-set-sha",
      destination: "meetings/output.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    });

    restarted = new MeetingStore({ root });
    expect(await restarted.list()).toMatchObject([{ id: "m-1", status: "processing" }]);
    expect(await restarted.listRecordings()).toMatchObject([{ id: "r-1", status: "finalizing" }]);
  });

  test("rejects starting from a non-draft parent without persisting either entity", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "meetings.json");
    const original = `${JSON.stringify({
      version: 1,
      meetings: [{
        id: "m-1",
        title: "Already ready",
        status: "ready",
        createdAt: "2026-08-16T10:00:00.000Z",
        updatedAt: "2026-08-16T10:00:00.000Z",
      }],
    }, null, 2)}\n`;
    await writeFile(filePath, original, "utf8");
    const store = new MeetingStore({ root });

    await expect(store.startRecording({ id: "r-1", meetingId: "m-1" })).rejects.toThrow(
      /ready -> recording.*docs\/product\/recording\.md.*only from a draft meeting/i,
    );

    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(await store.list()).toMatchObject([{ id: "m-1", status: "ready" }]);
    expect(await store.listRecordings()).toEqual([]);
  });

  test("serializes start so only one recording session can be active", async () => {
    const root = await temporaryRoot();
    let id = 0;
    const store = new MeetingStore({
      root,
      now: () => "2026-08-17T10:00:00.000Z",
      createId: () => `id-${++id}`,
    });
    const firstMeeting = await store.create({ title: "First" });
    const secondMeeting = await store.create({ title: "Second" });

    const results = await Promise.allSettled([
      store.startRecording({ meetingId: firstMeeting.id }),
      store.startRecording({ meetingId: secondMeeting.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected" });
    if (rejection?.status === "rejected") {
      expect(String(rejection.reason)).toMatch(
        /At most one active recording.*docs\/product\/recording\.md.*Stop or recover the active session/,
      );
    }
    expect((await store.listRecordings()).filter((recording) => recording.status === "recording")).toHaveLength(1);
  });

  test("durably reconciles publish-before-saved and exposes chunks only after exact saved identity", async () => {
    const root = await temporaryRoot();
    let now = "2026-08-17T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Recovery proof" });
    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    await store.commitChunk("r-1", {
      id: "mic-1",
      source: "microphone",
      storageKey: "sessions/r-1/mic-1.chunk",
      byteLength: 128,
      sha256: "chunk-sha",
      committedAt: "2026-08-17T10:00:05.000Z",
      logicalStartMs: 0, durationMs: 5_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-1", "chunk-set-sha");
    now = "2026-08-17T10:00:10.000Z";
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true,
      chunkSetDigest: "chunk-set-sha",
      destination: "meetings/output.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    });

    const verification = {
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "mp3-sha" },
      readable: true,
    };
    await expect(store.cleanupEligibleChunks("r-1", verification)).rejects.toThrow(
      /docs\/product\/recording\.md.*durably mark the recording saved/,
    );

    now = "2026-08-17T10:00:11.000Z";
    const reconciliation = await new MeetingStore({ root, now: () => now }).reconcilePublish("r-1", {
      existingOutput: { byteLength: 512, sha256: "mp3-sha" },
      existingOutputReadable: true,
    });
    expect(reconciliation.action).toBe("adopt");
    expect((await new MeetingStore({ root, now: () => now }).retryFinalization("r-1")).finalization)
      .toEqual(reconciliation.recording.finalization);

    now = "2026-08-17T10:00:12.000Z";
    await new MeetingStore({ root, now: () => now }).markRecordingSaved("r-1", {
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "mp3-sha" },
      readable: true,
    });

    const lifecycleStore = new MeetingStore({ root, now: () => now });
    await lifecycleStore.transition("m-1", "ready");
    await lifecycleStore.transition("m-1", "archived");

    const restarted = new MeetingStore({ root });
    await expect(restarted.cleanupEligibleInventory("r-1", verification)).resolves.toMatchObject({
      pointer: { digest: "chunk-set-sha", chunkCount: 1 }, legacyChunks: [],
    });
    expect((await restarted.listRecordings())[0]).toMatchObject({
      status: "saved",
      savedOutput: { destination: "meetings/output.mp3", sha256: "mp3-sha" },
      finalization: { chunkSetDigest: "chunk-set-sha", chunkCount: 1 },
    });
    expect(await restarted.list()).toMatchObject([{ id: "m-1", status: "archived" }]);
  });

  test("never mutates a colliding export and durably selects another destination", async () => {
    const root = await temporaryRoot();
    const exportPath = path.join(root, "existing.mp3");
    await writeFile(exportPath, "original recording", "utf8");
    let now = "2026-08-17T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Collision proof" });
    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    await store.commitChunk("r-1", {
      id: "system-1",
      source: "system",
      storageKey: "sessions/r-1/system-1.chunk",
      byteLength: 128,
      sha256: "chunk-sha",
      committedAt: "2026-08-17T10:00:05.000Z",
      logicalStartMs: 0, durationMs: 5_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-1", "chunk-set-sha");
    now = "2026-08-17T10:00:10.000Z";
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true,
      chunkSetDigest: "chunk-set-sha",
      destination: exportPath,
      expectedIdentity: { byteLength: 512, sha256: "new-output" },
    });

    now = "2026-08-17T10:00:11.000Z";
    const alternatePath = path.join(root, "existing-2.mp3");
    const result = await store.reconcilePublish("r-1", {
      existingOutput: { byteLength: 18, sha256: "original-output" },
      existingOutputReadable: true,
      nextDestination: alternatePath,
    });

    expect(result.action).toBe("collision");
    expect(result.recording.finalization?.publishIntent.destination).toBe(alternatePath);
    expect(await readFile(exportPath, "utf8")).toBe("original recording");
    expect((await new MeetingStore({ root }).listRecordings())[0]?.finalization?.publishIntent.destination).toBe(
      alternatePath,
    );
  });

  test("serializes finalization retries with the original durable chunk set", async () => {
    const root = await temporaryRoot();
    let now = "2026-08-17T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Retry proof" });
    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    await store.commitChunk("r-1", {
      id: "mic-1",
      source: "microphone",
      storageKey: "sessions/r-1/mic-1.chunk",
      byteLength: 128,
      sha256: "chunk-sha",
      committedAt: "2026-08-17T10:00:05.000Z",
      logicalStartMs: 0, durationMs: 5_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-1", "immutable-set-sha");
    now = "2026-08-17T10:00:10.000Z";
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true,
      chunkSetDigest: "immutable-set-sha",
      destination: "meetings/retry.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    });
    now = "2026-08-17T10:00:11.000Z";
    await store.interruptRecording("r-1", "encoder exited");
    now = "2026-08-17T10:00:12.000Z";
    await store.assessInterruption("r-1", { recoverable: true });

    now = "2026-08-17T10:00:13.000Z";
    await Promise.all([store.retryFinalization("r-1"), store.retryFinalization("r-1")]);

    expect((await new MeetingStore({ root }).listRecordings())[0]).toMatchObject({
      status: "finalizing",
      chunks: [],
      inventory: { state: "complete", knownChunkCount: 1 },
      finalization: {
        chunkCount: 1,
        chunkSetDigest: "immutable-set-sha",
        publishIntent: { destination: "meetings/retry.mp3", expectedIdentity: { sha256: "mp3-sha" } },
      },
    });

    now = "2026-08-17T10:00:14.000Z";
    const collision = await store.reconcilePublish("r-1", {
      existingOutput: { byteLength: 400, sha256: "different-output" },
      existingOutputReadable: true,
      nextDestination: "meetings/retry-2.mp3",
    });
    expect(collision.action).toBe("collision");
    await store.retryFinalization("r-1");
    expect((await new MeetingStore({ root }).listRecordings())[0]?.finalization?.publishIntent.destination)
      .toBe("meetings/retry-2.mp3");
  });

  test("fails closed on every inconsistent recording-to-meeting lifecycle family", async () => {
    const finalization = {
      chunkIds: ["chunk-1"],
      chunkSetDigest: "set-sha",
      publishIntent: {
        destination: "meetings/output.mp3",
        expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
        createdAt: "2026-08-17T10:00:10.000Z",
      },
    };
    const cases = [
      { name: "active", status: "recording", activeSince: "2026-08-17T10:00:00.000Z", intent: null, parent: "draft" },
      { name: "paused", status: "recording", activeSince: null, intent: null, parent: "processing" },
      { name: "interrupted capture", status: "interrupted", activeSince: null, intent: null, parent: "processing" },
      { name: "recoverable capture", status: "recoverable", activeSince: null, intent: null, parent: "processing" },
      { name: "finalizing", status: "finalizing", activeSince: null, intent: finalization, parent: "recording" },
      { name: "interrupted finalization", status: "interrupted", activeSince: null, intent: finalization, parent: "recording" },
      { name: "recoverable finalization", status: "recoverable", activeSince: null, intent: finalization, parent: "recording" },
      { name: "failed capture", status: "failed", activeSince: null, intent: null, parent: "processing" },
      { name: "failed finalization", status: "failed", activeSince: null, intent: finalization, parent: "recording" },
      { name: "saved", status: "saved", activeSince: null, intent: finalization, parent: "recording" },
    ] as const;

    for (const fixture of cases) {
      const root = await temporaryRoot();
      const recording = {
        id: "r-1",
        meetingId: "m-1",
        status: fixture.status,
        startedAt: "2026-08-17T10:00:00.000Z",
        updatedAt: "2026-08-17T10:00:12.000Z",
        elapsedMs: 10_000,
        activeSince: fixture.activeSince,
        chunks: [{
          id: "chunk-1",
          source: "microphone",
          storageKey: "sessions/r-1/chunk-1.chunk",
          byteLength: 128,
          sha256: "chunk-sha",
          committedAt: "2026-08-17T10:00:05.000Z",
          logicalStartMs: 0, durationMs: 5_000, sampleRate: 16_000, channels: 1, format: "wav",
        }],
        interruption: fixture.status === "interrupted" || fixture.status === "recoverable"
          ? { reason: "fixture interruption", interruptedAt: "2026-08-17T10:00:11.000Z" }
          : null,
        failureReason: fixture.status === "failed" ? "fixture failure" : null,
        finalization: fixture.intent,
        savedOutput: fixture.status === "saved"
          ? { destination: "meetings/output.mp3", byteLength: 512, sha256: "mp3-sha", savedAt: "2026-08-17T10:00:12.000Z" }
          : null,
      };
      await writeFile(path.join(root, "meetings.json"), `${JSON.stringify({
        version: 2,
        meetings: [{
          id: "m-1",
          title: fixture.name,
          status: fixture.parent,
          createdAt: "2026-08-17T10:00:00.000Z",
          updatedAt: "2026-08-17T10:00:12.000Z",
        }],
        recordings: [recording],
      }, null, 2)}\n`, "utf8");

      await expect(new MeetingStore({ root }).listRecordings(), fixture.name).rejects.toBeInstanceOf(
        MeetingStoreCorruptError,
      );
    }
  });
});

async function completeInventory(store: MeetingStore, recordingId: string, digest: string): Promise<void> {
  const recovered = await store.prepareInventoryRecovery(recordingId, "capture closed for inventory");
  await store.markInventoryScanning(recordingId);
  await store.publishInventory(recordingId, {
    storageKey: `sessions/${recordingId}/inventory-${digest}.ndjson`, digest,
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: recovered.inventory.microphoneCount,
    systemCount: recovered.inventory.systemCount,
    publishedAt: new Date().toISOString(),
  });
}
