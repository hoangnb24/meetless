import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import { Mp3Finalizer } from "../src/finalizer.js";
import { readInventory, RecordingInventoryReconciler, resolveStorePath } from "../src/inventory.js";
import { validateCommittedWavChunk } from "../src/chunk-validator.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("atomic recording inventory", () => {
  test("cancellation before and after sidecar publication never adopts a partial count", async () => {
    const fixture = await createRecordingFixture();
    const known = await createChunk(fixture, "microphone", 0, 0);
    await fixture.store.commitChunk(fixture.recordingId, known);
    await createChunk(fixture, "system", 0, 0);
    let recording = await fixture.store.prepareInventoryRecovery(fixture.recordingId, "stale capture");
    const reconciler = new RecordingInventoryReconciler(fixture.root, fixture.store);

    const duringScan = new AbortController();
    await expect(reconciler.reconcile(recording, {
      signal: duringScan.signal,
      hooks: { afterValidated: () => duringScan.abort() },
    })).rejects.toMatchObject({ name: "AbortError" });
    recording = (await fixture.store.listRecordings())[0]!;
    expect(recording.inventory).toMatchObject({ state: "scanning", knownChunkCount: 1, pointer: null });
    expect(recording.chunks).toHaveLength(1);

    const beforePointer = new AbortController();
    await expect(reconciler.reconcile(recording, {
      signal: beforePointer.signal,
      hooks: { afterSidecarPublished: () => beforePointer.abort() },
    })).rejects.toMatchObject({ name: "AbortError" });
    recording = (await fixture.store.listRecordings())[0]!;
    expect(recording.inventory).toMatchObject({ state: "scanning", knownChunkCount: 1, pointer: null });

    const pointer = await reconciler.reconcile(recording);
    recording = (await fixture.store.listRecordings())[0]!;
    expect(recording.inventory).toMatchObject({ state: "complete", knownChunkCount: 2, pointer: { digest: pointer.digest } });
    expect(recording.chunks).toEqual([]);
    expect([...await collect(readInventory(fixture.root, pointer))].map((chunk) => chunk.source)).toEqual(["microphone", "system"]);
  });

  test("missing previously committed media blocks publication and retry/finalization", async () => {
    const fixture = await createRecordingFixture();
    const known = await createChunk(fixture, "microphone", 0, 0);
    await fixture.store.commitChunk(fixture.recordingId, known);
    await rm(resolveStorePath(fixture.root, known.storageKey));
    const recording = await fixture.store.prepareInventoryRecovery(fixture.recordingId, "stale capture");

    await expect(new RecordingInventoryReconciler(fixture.root, fixture.store).reconcile(recording))
      .rejects.toThrow(/Previously committed media is missing/);
    const blocked = (await fixture.store.listRecordings())[0]!;
    expect(blocked.inventory).toMatchObject({ state: "blocked", knownChunkCount: 1, pointer: null });
    await expect(fixture.store.beginFinalization(fixture.recordingId, {
      openChunksDurablyClosed: true, chunkSetDigest: "unpublished", destination: "output.mp3",
      expectedIdentity: { byteLength: 1, sha256: "x" },
    })).rejects.toThrow(/inventory reconciliation/);
  });

  test("finalization uses at most two source timelines, preserves gaps, and leaves raw WAVs", async () => {
    const fixture = await createRecordingFixture();
    const raw = [
      await createChunk(fixture, "microphone", 0, 0, 16_000),
      await createChunk(fixture, "microphone", 1, 32_000, 16_000),
      await createChunk(fixture, "system", 0, 8_000, 16_000),
    ];
    const recovered = await fixture.store.prepareInventoryRecovery(fixture.recordingId, "capture closed");
    const pointer = await new RecordingInventoryReconciler(fixture.root, fixture.store).reconcile(recovered);
    const commands: string[][] = [];
    const finalizer = new Mp3Finalizer({
      ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(fixture.root, "exports"), storeRoot: fixture.root,
      observeCommand: (_executable, arguments_) => commands.push([...arguments_]),
    });
    const staged = await finalizer.stage(fixture.recordingId, pointer);

    expect(commands).toHaveLength(1);
    expect(commands[0]!.filter((argument) => argument === "-i")).toHaveLength(2);
    expect((await finalizer.verify(staged.stagePath)).durationSeconds).toBeGreaterThanOrEqual(3);
    for (const chunk of raw) await expect(access(resolveStorePath(fixture.root, chunk.storageKey))).resolves.toBeUndefined();
  }, 30_000);
});

async function createRecordingFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-inventory-"));
  roots.add(root);
  const store = new MeetingStore({ root });
  const meeting = await store.create({ title: "Inventory fixture" });
  const recording = await store.startRecording({ meetingId: meeting.id });
  return { root, store, recordingId: recording.id, sessionDirectory: path.join(root, "sessions", recording.id) };
}

async function createChunk(
  fixture: Awaited<ReturnType<typeof createRecordingFixture>>,
  source: "microphone" | "system",
  index: number,
  startFrame: number,
  frameCount = 1,
) {
  const id = `chunk--${source}--${String(index).padStart(6, "0")}--${String(startFrame).padStart(12, "0")}--${String(frameCount).padStart(12, "0")}--16000--1`;
  const filePath = path.join(fixture.sessionDirectory, `${id}.wav`);
  await mkdir(fixture.sessionDirectory, { recursive: true });
  await writeFile(filePath, pcmWav(frameCount));
  return validateCommittedWavChunk({ filePath, sessionDirectory: fixture.sessionDirectory, storeRoot: fixture.root });
}

function pcmWav(frameCount: number): Buffer {
  const dataBytes = frameCount * 2;
  const data = Buffer.alloc(44 + dataBytes);
  data.write("RIFF", 0); data.writeUInt32LE(36 + dataBytes, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset < data.length; offset += 2) data.writeInt16LE(1_000, offset);
  return data;
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}
