import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InvalidMeetingTransitionError } from "@meetless/meeting-domain";
import { MeetingStore, MeetingStoreCorruptError } from "../src/index.js";

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
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({ version: 2 });
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
      version: 2,
      meetings: [meeting],
      recordings: [],
    });
    expect((await readdir(root)).sort()).toEqual(["meetings.json"]);
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
    });
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

    now = "2026-08-17T10:00:12.000Z";
    await new MeetingStore({ root, now: () => now }).markRecordingSaved("r-1", {
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "mp3-sha" },
      readable: true,
    });

    const restarted = new MeetingStore({ root });
    await expect(restarted.cleanupEligibleChunks("r-1", verification)).resolves.toMatchObject([
      { id: "mic-1", source: "microphone", sha256: "chunk-sha" },
    ]);
    expect((await restarted.listRecordings())[0]).toMatchObject({
      status: "saved",
      savedOutput: { destination: "meetings/output.mp3", sha256: "mp3-sha" },
      finalization: { chunkSetDigest: "chunk-set-sha", chunkIds: ["mic-1"] },
    });
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
    });
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
    });
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
      chunks: [{ id: "mic-1", sha256: "chunk-sha" }],
      finalization: { chunkIds: ["mic-1"], chunkSetDigest: "immutable-set-sha" },
    });
  });
});
