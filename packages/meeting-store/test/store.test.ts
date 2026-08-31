import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open as fsOpen, readFile, readdir, rename as fsRename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({ version: 4 });
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
      version: 4,
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

    const restarted = new MeetingStore({ root, approvedExportRoots: [path.join(root, "exports")] });
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

  test("durably checkpoints and publishes a transcript sidecar, then reconciles a crash before state publication", async () => {
    const root = await temporaryRoot();
    const now = "2026-08-18T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Transcript publication" });
    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    await store.commitChunk("r-1", {
      id: "mic-1", source: "microphone", storageKey: "sessions/r-1/mic-1.chunk",
      byteLength: 128, sha256: "chunk-sha", committedAt: now,
      logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-1", "chunk-set-sha");
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true, chunkSetDigest: "chunk-set-sha",
      destination: "meetings/r-1.mp3", expectedIdentity: { byteLength: 128, sha256: "audio-sha" },
    });
    await store.markRecordingSaved("r-1", {
      destination: "meetings/r-1.mp3", identity: { byteLength: 128, sha256: "audio-sha" }, readable: true,
    });
    await expect(store.transcriptionConsent()).resolves.toEqual({ status: "unknown" });
    await store.grantTranscriptionConsent();
    await expect(store.grantTranscriptionConsent()).resolves.toMatchObject({ status: "granted" });

    const created = await store.ensureTranscript({
      meetingId: "m-1", recordingId: "r-1",
      audio: { destination: "meetings/r-1.mp3", byteLength: 128, sha256: "audio-sha", durationMs: 1_000 },
    });
    const request = await store.beginTranscriptRequest(created.id);
    expect(request?.range).toMatchObject({ startMs: 0, endMs: 1_000 });
    await store.checkpointTranscriptRange(created.id, {
      range: request!.range, attempts: request!.attempt, text: "Hello, xin chào",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, durationSeconds: 1 },
      detectedLanguages: ["en", "vi"],
    });
    const ready = await store.publishTranscript(created.id);
    expect(ready.status).toBe("ready");
    expect((await store.list())[0]).toMatchObject({ id: "m-1", status: "ready" });
    await expect(store.resolveCitation("m-1", ready.ranges[0]!.segmentId)).resolves.toMatchObject({
      audioPath: "meetings/r-1.mp3", startMs: 0, endMs: 1_000, text: "Hello, xin chào",
    });

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      meetings: Array<{ status: string }>;
      transcripts: Array<{ status: string; publication: unknown }>;
    };
    persisted.meetings[0]!.status = "processing";
    persisted.transcripts[0]!.status = "pending";
    persisted.transcripts[0]!.publication = null;
    await writeFile(store.filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const restarted = new MeetingStore({ root, now: () => now });
    await restarted.reconcileTranscriptPublications();
    await expect(restarted.getTranscript(created.id)).resolves.toMatchObject({ status: "ready" });
    await expect(restarted.list()).resolves.toMatchObject([{ id: "m-1", status: "ready" }]);
  });

  test("restart keeps in-flight work resumable only while its durable attempt budget remains", async () => {
    const root = await temporaryRoot();
    const now = "2026-08-18T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    for (const [meetingId, recordingId] of [["m-budget", "r-budget"], ["m-exhausted", "r-exhausted"]]) {
      await store.create({ id: meetingId, title: meetingId });
      await store.startRecording({ id: recordingId, meetingId });
      await store.commitChunk(recordingId, {
        id: `${recordingId}-mic`, source: "microphone", storageKey: `sessions/${recordingId}/mic.chunk`,
        byteLength: 128, sha256: `${recordingId}-chunk`, committedAt: now,
        logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
      });
      await completeInventory(store, recordingId, `${recordingId}-inventory`);
      await store.beginFinalization(recordingId, {
        openChunksDurablyClosed: true, chunkSetDigest: `${recordingId}-inventory`,
        destination: `meetings/${recordingId}.mp3`, expectedIdentity: { byteLength: 128, sha256: `${recordingId}-audio` },
      });
      await store.markRecordingSaved(recordingId, {
        destination: `meetings/${recordingId}.mp3`, identity: { byteLength: 128, sha256: `${recordingId}-audio` }, readable: true,
      });
    }
    const resumable = await store.ensureTranscript({
      meetingId: "m-budget", recordingId: "r-budget", maxAttempts: 2,
      audio: { destination: "meetings/r-budget.mp3", byteLength: 128, sha256: "r-budget-audio", durationMs: 1_000 },
    });
    const exhausted = await store.ensureTranscript({
      meetingId: "m-exhausted", recordingId: "r-exhausted", maxAttempts: 1,
      audio: { destination: "meetings/r-exhausted.mp3", byteLength: 128, sha256: "r-exhausted-audio", durationMs: 1_000 },
    });
    await store.beginTranscriptRequest(resumable.id);
    await store.beginTranscriptRequest(exhausted.id);

    const restarted = new MeetingStore({ root, now: () => now });
    await restarted.reconcileTranscriptPublications();

    await expect(restarted.getTranscript(resumable.id)).resolves.toMatchObject({ status: "pending", requestCount: 1 });
    await expect(restarted.getTranscript(exhausted.id)).resolves.toMatchObject({
      status: "failed", requestCount: 1,
      failureReason: "Transcription interrupted after the final allowed attempt",
    });
  });

  test("deletes one durable meeting graph and owned files across restart, with idempotent not-found", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({
      root, approvedExportRoots: [path.join(root, "exports")], now: () => "2026-08-29T10:00:00.000Z",
    });
    const owned = await prepareReadyMeetingGraph(store, root, "m-delete", "r-delete");
    const stagePath = path.join(root, "exports", ".meetless-r-delete-00000000-0000-4000-8000-000000000000.mp3.stage");
    await writeFile(stagePath, "stage");
    owned.push(stagePath);
    const managedStagePath = path.join(root, "exports", ".meetless-r-delete-00000000-0000-4000-8000-000000000001.managed.wav.stage");
    await writeFile(managedStagePath, "managed stage");
    owned.push(managedStagePath);
    const managedArtifactPath = path.join(
      root, "managed-artifacts", createHash("sha256").update("r-delete").digest("hex"),
    );
    await mkdir(managedArtifactPath, { recursive: true });
    await writeFile(path.join(managedArtifactPath, "timeline.wav"), "managed private timeline");
    owned.push(managedArtifactPath);
    await store.create({ id: "m-keep", title: "Keep this meeting" });
    const cleanup = vi.spyOn(
      store as unknown as { finishDeletionManifest(manifestPath: string, manifest: unknown): Promise<void> },
      "finishDeletionManifest",
    ).mockRejectedValueOnce(new Error("injected post-commit cleanup failure"));

    await expect(store.deleteMeeting("m-delete", {
      recordingStagePaths: [
        { recordingId: "r-delete", path: stagePath },
        { recordingId: "r-delete", path: managedStagePath },
      ],
    })).resolves.toEqual({
      meetingId: "m-delete", outcome: "deleted", reason: null,
    });
    cleanup.mockRestore();
    await expect(readdir(path.join(root, ".deletions"))).resolves.toHaveLength(1);

    const restarted = new MeetingStore({ root, approvedExportRoots: [path.join(root, "exports")] });
    await expect(restarted.list()).resolves.toMatchObject([{ id: "m-keep" }]);
    await expect(restarted.listRecordings()).resolves.toEqual([]);
    await expect(restarted.listTranscripts()).resolves.toEqual([]);
    await expect(restarted.listChatThreads()).resolves.toEqual([]);
    for (const filePath of owned) await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(root, ".deletions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restarted.deleteMeeting("m-delete")).resolves.toEqual({
      meetingId: "m-delete", outcome: "not_found", reason: null,
    });
    await expect(restarted.list()).resolves.toMatchObject([{ id: "m-keep" }]);
  });

  test("deletes a failed recording whose parent meeting still has recording status", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root });
    await store.create({ id: "m-failed", title: "Failed capture" });
    await store.startRecording({ id: "r-failed", meetingId: "m-failed" });
    await store.interruptRecording("r-failed", "capture helper exited");
    await store.assessInterruption("r-failed", { recoverable: false, reason: "No valid media remains" });

    await expect(store.list()).resolves.toMatchObject([{ id: "m-failed", status: "recording" }]);
    await expect(store.listRecordings()).resolves.toMatchObject([{ id: "r-failed", status: "failed" }]);
    await expect(store.deleteMeeting("m-failed")).resolves.toEqual({
      meetingId: "m-failed", outcome: "deleted", reason: null,
    });
    await expect(new MeetingStore({ root }).list()).resolves.toEqual([]);
    await expect(new MeetingStore({ root }).listRecordings()).resolves.toEqual([]);
  });

  test("rolls staged files back when the durable graph commit fails", async () => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root, now: () => "2026-08-29T10:00:00.000Z" });
    const owned = await prepareReadyMeetingGraph(seed, root, "m-rollback", "r-rollback");
    const synced: string[] = [];
    const store = new MeetingStore({ root, deletionIo: { syncDirectory: async (directory) => {
      synced.push(directory);
      const handle = await fsOpen(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } } });
    const writeState = vi.spyOn(store as unknown as { replaceState(state: unknown): Promise<void> }, "replaceState")
      .mockRejectedValueOnce(new Error("injected durable commit failure"));

    await expect(store.deleteMeeting("m-rollback")).rejects.toThrow("injected durable commit failure");
    writeState.mockRestore();

    const restarted = new MeetingStore({ root });
    await expect(restarted.list()).resolves.toMatchObject([{ id: "m-rollback" }]);
    await expect(restarted.listRecordings()).resolves.toHaveLength(1);
    await expect(restarted.listTranscripts()).resolves.toHaveLength(1);
    await expect(restarted.listChatThreads()).resolves.toHaveLength(1);
    for (const filePath of owned) await expect(readFile(filePath)).resolves.toBeTruthy();
    expect(synced.filter((directory) => directory === path.join(root, "sessions"))).toHaveLength(2);
    expect(synced.filter((directory) => directory === path.join(root, "exports"))).toHaveLength(2);
    expect(synced.filter((directory) => directory === path.join(root, "transcripts"))).toHaveLength(2);
  });

  test("rolls the current entry back when its post-rename directory sync fails", async () => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root, now: () => "2026-08-29T10:00:00.000Z" });
    const owned = await prepareReadyMeetingGraph(seed, root, "m-stage-sync", "r-stage-sync");
    const failingParent = path.join(root, "sessions");
    let failed = false;
    const store = new MeetingStore({ root, deletionIo: { syncDirectory: async (directory) => {
      if (!failed && directory === failingParent) {
        failed = true;
        throw new Error("injected staging directory sync failure");
      }
      const handle = await fsOpen(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } } });

    await expect(store.deleteMeeting("m-stage-sync")).rejects.toThrow("injected staging directory sync failure");

    const restarted = new MeetingStore({ root });
    await expect(restarted.list()).resolves.toMatchObject([{ id: "m-stage-sync", status: "ready" }]);
    await expect(restarted.listRecordings()).resolves.toMatchObject([{ id: "r-stage-sync", meetingId: "m-stage-sync" }]);
    await expect(restarted.listTranscripts()).resolves.toHaveLength(1);
    await expect(restarted.listChatThreads()).resolves.toHaveLength(1);
    for (const filePath of owned) await expect(readFile(filePath)).resolves.toBeTruthy();
    await expect(readdir(path.join(root, ".deletions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(failingParent)).resolves.not.toContainEqual(expect.stringContaining(".meetless-delete-"));
  });

  test.each([
    ["active_capture", "recording"],
    ["finalization", "finalizing"],
  ] as const)("refuses %s without changing another meeting", async (reason, status) => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root });
    await store.create({ id: "m-busy", title: "Busy" });
    await store.create({ id: "m-other", title: "Other" });
    await store.startRecording({ id: "r-busy", meetingId: "m-busy" });
    if (status === "finalizing") {
      await store.commitChunk("r-busy", {
        id: "chunk", source: "microphone", storageKey: "sessions/r-busy/chunk.wav", byteLength: 1,
        sha256: "chunk", committedAt: "2026-08-29T10:00:00.000Z", logicalStartMs: 0, durationMs: 1,
        sampleRate: 16_000, channels: 1, format: "wav",
      });
      await completeInventory(store, "r-busy", "digest");
      await store.beginFinalization("r-busy", {
        openChunksDurablyClosed: true, chunkSetDigest: "digest", destination: path.join(root, "busy.mp3"),
        expectedIdentity: { byteLength: 1, sha256: "audio" },
      });
    }
    await expect(store.deleteMeeting("m-busy")).resolves.toEqual({ meetingId: "m-busy", outcome: "refused", reason });
    await expect(store.list()).resolves.toMatchObject([{ id: "m-busy" }, { id: "m-other" }]);
  });

  test("refuses transcription and Ask while each durable operation is active", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-29T10:00:00.000Z" });
    await prepareSavedMeeting(store, root, "m-transcribing", "r-transcribing");
    const transcript = await store.ensureTranscript({
      meetingId: "m-transcribing", recordingId: "r-transcribing",
      audio: { destination: path.join(root, "exports", "r-transcribing.mp3"), byteLength: 5, sha256: "audio-sha", durationMs: 1_000 },
    });
    await store.beginTranscriptRequest(transcript.id);
    await expect(store.deleteMeeting("m-transcribing")).resolves.toEqual({
      meetingId: "m-transcribing", outcome: "refused", reason: "transcription",
    });

    await prepareReadyMeetingGraph(store, root, "m-asking", "r-asking");
    await store.startChatQuestion({ meetingId: "m-asking", question: "Still running?", provider: "codex", model: "gpt-5" });
    await expect(store.deleteMeeting("m-asking")).resolves.toEqual({
      meetingId: "m-asking", outcome: "refused", reason: "ask",
    });
    expect((await store.list()).map((meeting) => meeting.id)).toEqual(["m-transcribing", "m-asking"]);
  });

  test("refuses deletion while a saved managed timeline handoff is pending, including after restart", async () => {
    const root = await temporaryRoot();
    const now = "2026-08-29T10:00:00.000Z";
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-managed-pending", title: "Managed pending" });
    await store.startRecording({ id: "r-managed-pending", meetingId: "m-managed-pending" });
    await store.commitChunk("r-managed-pending", {
      id: "r-managed-pending-chunk", source: "microphone", storageKey: "sessions/r-managed-pending/chunk.wav",
      byteLength: 1, sha256: "chunk", committedAt: now, logicalStartMs: 0, durationMs: 1_000,
      sampleRate: 16_000, channels: 1, format: "wav",
    });
    await completeInventory(store, "r-managed-pending", "managed-pending-inventory");
    const outputPath = path.join(root, "exports", "r-managed-pending.mp3");
    await store.beginFinalization("r-managed-pending", {
      openChunksDurablyClosed: true, chunkSetDigest: "managed-pending-inventory", destination: outputPath,
      expectedIdentity: { byteLength: 1, sha256: "output" },
      managedTimeline: {
        stagePath: path.join(root, "exports", ".meetless-r-managed-pending-00000000-0000-4000-8000-000000000000.managed.wav.stage"),
        manifestSha256: "a".repeat(64), identity: { byteLength: 1, sha256: "managed" }, startMs: 0, endMs: 1_000,
      },
    });
    await store.markRecordingSaved("r-managed-pending", {
      destination: outputPath, identity: { byteLength: 1, sha256: "output" }, readable: true,
    });

    await expect(store.deleteMeeting("m-managed-pending")).resolves.toEqual({
      meetingId: "m-managed-pending", outcome: "refused", reason: "finalization",
    });
    const restarted = new MeetingStore({ root, now: () => now });
    await expect(restarted.deleteMeeting("m-managed-pending")).resolves.toEqual({
      meetingId: "m-managed-pending", outcome: "refused", reason: "finalization",
    });
  });

  test("refuses deletion while recording recovery is durable", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root });
    await store.create({ id: "m-recovery", title: "Recovery" });
    await store.startRecording({ id: "r-recovery", meetingId: "m-recovery" });
    await store.commitChunk("r-recovery", {
      id: "chunk", source: "microphone", storageKey: "sessions/r-recovery/chunk.wav", byteLength: 1,
      sha256: "chunk", committedAt: "2026-08-29T10:00:00.000Z", logicalStartMs: 0, durationMs: 1,
      sampleRate: 16_000, channels: 1, format: "wav",
    });
    await store.interruptRecording("r-recovery", "capture stopped");
    await store.assessInterruption("r-recovery", { recoverable: true });

    await expect(store.deleteMeeting("m-recovery")).resolves.toEqual({
      meetingId: "m-recovery", outcome: "refused", reason: "active_capture",
    });
  });

  test.each(["write", "sync", "rename"] as const)("cleans failed manifest temp publication after %s failure", async (failure) => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root });
    const owned = await prepareReadyMeetingGraph(seed, root, "m-manifest", "r-manifest");
    const store = new MeetingStore({
      root,
      deletionIo: {
        open: (async (...args: Parameters<typeof fsOpen>) => {
          const handle = await fsOpen(...args);
          if (!String(args[0]).includes(`${path.sep}.deletions${path.sep}.`)) return handle;
          if (failure === "write") handle.writeFile = async () => { throw new Error("injected manifest write failure"); };
          if (failure === "sync") handle.sync = async () => { throw new Error("injected manifest sync failure"); };
          return handle;
        }) as typeof fsOpen,
        rename: (async (from: string, to: string) => {
          if (failure === "rename" && from.includes(`${path.sep}.deletions${path.sep}.`)) {
            throw new Error("injected manifest rename failure");
          }
          await fsRename(from, to);
        }) as typeof fsRename,
      },
    });

    await expect(store.deleteMeeting("m-manifest")).rejects.toThrow(`injected manifest ${failure} failure`);
    expect((await new MeetingStore({ root }).list()).map((meeting) => meeting.id)).toEqual(["m-manifest"]);
    for (const filePath of owned) await expect(readFile(filePath)).resolves.toBeTruthy();
    await expect(readdir(path.join(root, ".deletions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the manifest after state replacement sync failure and converges on restart", async () => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root });
    const owned = await prepareReadyMeetingGraph(seed, root, "m-post-replace", "r-post-replace");
    let stateReplaced = false;
    const store = new MeetingStore({
      root,
      deletionIo: {
        rename: (async (from: string, to: string) => {
          await fsRename(from, to);
          if (to === path.join(root, "meetings.json")) stateReplaced = true;
        }) as typeof fsRename,
        syncDirectory: async (directory) => {
          if (stateReplaced && directory === root) throw new Error("injected post-replace directory sync failure");
          const handle = await fsOpen(directory, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        },
      },
    });

    await expect(store.deleteMeeting("m-post-replace")).rejects.toThrow("Meeting state replacement failed");
    await expect(readdir(path.join(root, ".deletions"))).resolves.toHaveLength(1);
    const restarted = new MeetingStore({ root });
    await expect(restarted.list()).resolves.toEqual([]);
    for (const filePath of owned) await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(root, ".deletions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fsyncs affected parents for staging, replacement, cleanup, and manifest removal", async () => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root });
    await prepareReadyMeetingGraph(seed, root, "m-sync", "r-sync");
    const synced: string[] = [];
    const store = new MeetingStore({ root, deletionIo: { syncDirectory: async (directory) => {
      synced.push(directory);
      const handle = await fsOpen(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } } });
    await store.deleteMeeting("m-sync");

    expect(synced.filter((directory) => directory === path.join(root, "sessions"))).toHaveLength(2);
    expect(synced.filter((directory) => directory === path.join(root, "exports"))).toHaveLength(2);
    expect(synced.filter((directory) => directory === path.join(root, "transcripts"))).toHaveLength(2);
    expect(synced).toContain(root);
    expect(synced.filter((directory) => directory === path.join(root, ".deletions")).length).toBeGreaterThanOrEqual(2);
  });

  test("rejects traversal, outside roots, symlinks, shared paths, and output directories", async () => {
    for (const violation of ["traversal", "outside", "symlink", "shared", "directory"] as const) {
      const root = await temporaryRoot();
      const store = new MeetingStore({ root });
      const owned = await prepareReadyMeetingGraph(store, root, "m-target", "r-target");
      const output = path.join(root, "exports", "r-target.mp3");
      if (violation === "shared") await prepareReadyMeetingGraph(store, root, "m-other", "r-other");
      const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as any;
      if (violation === "traversal") persisted.transcripts[0].publication.storageKey = "../outside.json";
      if (violation === "outside") {
        const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.mp3`);
        await writeFile(outside, "audio"); roots.add(outside);
        persisted.recordings[0].savedOutput.destination = outside;
        persisted.recordings[0].finalization.publishIntent.destination = outside;
      }
      if (violation === "shared") {
        persisted.recordings[1].savedOutput.destination = output;
        persisted.recordings[1].finalization.publishIntent.destination = output;
      }
      await writeFile(store.filePath, `${JSON.stringify(persisted, null, 2)}\n`);
      if (violation === "symlink") {
        await rm(output);
        const outside = path.join(root, "outside-audio.mp3");
        await writeFile(outside, "audio");
        await symlink(outside, output);
      }
      if (violation === "directory") {
        await rm(output);
        await mkdir(output);
      }

      await expect(new MeetingStore({ root }).deleteMeeting("m-target"), violation).rejects.toThrow(
        /exact owned sidecar|outside approved|symlink|shared|invalid file type/u,
      );
      await expect(new MeetingStore({ root }).list()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "m-target" }),
      ]));
      expect(owned.length).toBeGreaterThan(0);
    }
  });

  test("fails closed on a tampered manifest during restart recovery", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root });
    await prepareReadyMeetingGraph(store, root, "m-tamper", "r-tamper");
    const cleanup = vi.spyOn(
      store as unknown as { finishDeletionManifest(manifestPath: string, manifest: unknown): Promise<void> },
      "finishDeletionManifest",
    ).mockRejectedValueOnce(new Error("leave manifest"));
    await store.deleteMeeting("m-tamper");
    cleanup.mockRestore();
    const directory = path.join(root, ".deletions");
    const name = (await readdir(directory))[0]!;
    const manifestPath = path.join(directory, name);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].original = path.join(root, "tampered");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(new MeetingStore({ root }).list()).rejects.toThrow(/corrupt|integrity/u);
  });

  test("fails closed when a quarantined recovery path becomes a symlink", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root });
    await prepareReadyMeetingGraph(store, root, "m-recovery-link", "r-recovery-link");
    const cleanup = vi.spyOn(
      store as unknown as { finishDeletionManifest(manifestPath: string, manifest: unknown): Promise<void> },
      "finishDeletionManifest",
    ).mockRejectedValueOnce(new Error("leave manifest"));
    await store.deleteMeeting("m-recovery-link");
    cleanup.mockRestore();
    const directory = path.join(root, ".deletions");
    const manifestPath = path.join(directory, (await readdir(directory))[0]!);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.entries.find((candidate: { kind: string }) => candidate.kind === "output");
    const outside = path.join(path.dirname(root), `${path.basename(root)}-recovery-outside.mp3`);
    await writeFile(outside, "outside"); roots.add(outside);
    await rm(entry.quarantine, { force: true });
    await symlink(outside, entry.quarantine);

    await expect(new MeetingStore({ root }).list()).rejects.toThrow(/corrupt|symlink/u);
  });
});

async function prepareReadyMeetingGraph(store: MeetingStore, root: string, meetingId: string, recordingId: string): Promise<string[]> {
  const owned = await prepareSavedMeeting(store, root, meetingId, recordingId);
  const outputPath = path.join(root, "exports", `${recordingId}.mp3`);
  const transcript = await store.ensureTranscript({
    meetingId, recordingId,
    audio: { destination: outputPath, byteLength: 5, sha256: "audio-sha", durationMs: 1_000 },
  });
  const request = await store.beginTranscriptRequest(transcript.id);
  await store.checkpointTranscriptRange(transcript.id, {
    range: request!.range, attempts: request!.attempt, text: "Decision", usage: null, detectedLanguages: ["en"],
  });
  const ready = await store.publishTranscript(transcript.id);
  const thread = await store.startChatQuestion({ meetingId, question: "What changed?", provider: "codex", model: "gpt-5" });
  await store.recordChatRetrieval(meetingId, thread.activeAttemptId!, [ready.ranges[0]!.segmentId]);
  await store.completeChatTurn(meetingId, {
    attemptId: thread.activeAttemptId!, outcome: "supported", text: "A decision changed.",
    citationSegmentIds: [ready.ranges[0]!.segmentId],
  });
  return [...owned, path.join(root, ready.publication!.storageKey)];
}

async function prepareSavedMeeting(store: MeetingStore, root: string, meetingId: string, recordingId: string): Promise<string[]> {
  const sessionDirectory = path.join(root, "sessions", recordingId);
  const outputPath = path.join(root, "exports", `${recordingId}.mp3`);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const chunkPath = path.join(sessionDirectory, "chunk.wav");
  const inventoryPath = path.join(sessionDirectory, "inventory.ndjson");
  await writeFile(chunkPath, "chunk");
  await writeFile(inventoryPath, "inventory");
  await writeFile(outputPath, "audio");
  await store.create({ id: meetingId, title: `Delete ${meetingId}` });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: `${recordingId}-chunk`, source: "microphone", storageKey: path.relative(root, chunkPath), byteLength: 5,
    sha256: "chunk-sha", committedAt: "2026-08-29T10:00:00.000Z", logicalStartMs: 0, durationMs: 1_000,
    sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery(recordingId, "ready");
  await store.markInventoryScanning(recordingId);
  await store.publishInventory(recordingId, {
    storageKey: path.relative(root, inventoryPath), digest: "inventory-sha", chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: recovered.inventory.microphoneCount, systemCount: recovered.inventory.systemCount,
    publishedAt: "2026-08-29T10:00:00.000Z",
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true, chunkSetDigest: "inventory-sha", destination: outputPath,
    expectedIdentity: { byteLength: 5, sha256: "audio-sha" },
  });
  await store.markRecordingSaved(recordingId, {
    destination: outputPath, identity: { byteLength: 5, sha256: "audio-sha" }, readable: true,
  });
  return [chunkPath, inventoryPath, outputPath];
}

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
