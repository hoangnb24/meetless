import { link, mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingStore } from "../packages/meeting-store/dist/index.js";
import { RecordingService } from "../packages/meetless-plugin/dist/src/recording-service.js";
import { RecordingInventoryReconciler, resolveStorePath } from "../packages/meetless-plugin/dist/src/inventory.js";
import { Mp3Finalizer } from "../packages/meetless-plugin/dist/src/finalizer.js";

const ENTRY_COUNT = 340_944;
const root = await mkdtemp(path.join(tmpdir(), "meetless-scale-inventory-"));
const storeRoot = path.join(root, "store");
const exportRoot = path.join(root, "exports");
const store = new MeetingStore({ root: storeRoot });
let service;

try {
  const meeting = await store.create({ title: "Production-derived 340,944-entry recovery" });
  const recording = await store.startRecording({ meetingId: meeting.id });
  const sessionDirectory = path.join(storeRoot, "sessions", recording.id);
  await mkdir(sessionDirectory, { recursive: true });
  const base = path.join(root, "one-frame.wav");
  await writeFile(base, pcmWav());

  for (let offset = 0; offset < ENTRY_COUNT; offset += 512) {
    await Promise.all(Array.from({ length: Math.min(512, ENTRY_COUNT - offset) }, (_, local) => {
      const ordinal = offset + local;
      const source = ordinal % 2 === 0 ? "microphone" : "system";
      const sourceIndex = Math.floor(ordinal / 2);
      const id = `chunk--${source}--${String(sourceIndex).padStart(6, "0")}--${String(sourceIndex).padStart(12, "0")}--000000000001--16000--1.wav`;
      return link(base, path.join(sessionDirectory, id));
    }));
  }

  service = new RecordingService({
    storeRoot, helperPath: "/not-used", ffmpeg: "/opt/homebrew/bin/ffmpeg",
    ffprobe: "/opt/homebrew/bin/ffprobe", exportRoot, fixture: true,
  });
  const startupStarted = performance.now();
  await service.initialize();
  const startupMs = Math.round(performance.now() - startupStarted);
  const startupStatus = await service.status();
  assert(startupMs < 30_000, `startup exceeded bound: ${startupMs}ms`);
  assert(startupStatus.status === "recoverable", `startup status was ${startupStatus.status}`);
  assert(["pending", "scanning"].includes(startupStatus.inventoryState), `startup inventory was ${startupStatus.inventoryState}`);
  assert(!startupStatus.retryEligible, "retry became eligible before complete inventory publication");
  await service.shutdown();
  service = undefined;

  const reconciler = new RecordingInventoryReconciler(storeRoot, store);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const current = (await store.listRecordings())[0];
    await reconciler.reconcile(current, {
      signal: controller.signal,
      hooks: { afterValidated: (count) => { if (count === 1_000) controller.abort(); } },
    }).then(
      () => { throw new Error("cancelled scan unexpectedly published inventory"); },
      (error) => { if (error?.name !== "AbortError") throw error; },
    );
    const cancelled = (await store.listRecordings())[0];
    assert(cancelled.inventory.knownChunkCount === 0 && cancelled.inventory.pointer === null,
      `cancellation changed authoritative count on attempt ${attempt + 1}`);
  }

  const completionStarted = performance.now();
  const pointer = await reconciler.reconcile((await store.listRecordings())[0]);
  const completionMs = Math.round(performance.now() - completionStarted);
  assert(pointer.chunkCount === ENTRY_COUNT, `inventory count ${pointer.chunkCount} != ${ENTRY_COUNT}`);
  assert(pointer.microphoneCount === ENTRY_COUNT / 2 && pointer.systemCount === ENTRY_COUNT / 2,
    "source counts are not exact");

  const commands = [];
  const finalizer = new Mp3Finalizer({
    ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
    exportRoot, storeRoot, observeCommand: (_executable, arguments_) => commands.push([...arguments_]),
  });
  const staged = await finalizer.stage(recording.id, pointer);
  const verification = await finalizer.verify(staged.stagePath);
  assert(commands.length === 1 && commands[0].filter((argument) => argument === "-i").length === 2,
    "finalizer command topology exceeded two timeline inputs");
  const firstStorageKey = path.join("sessions", recording.id,
    "chunk--microphone--000000--000000000000--000000000001--16000--1.wav");
  await access(resolveStorePath(storeRoot, firstStorageKey));

  process.stdout.write(`${JSON.stringify({
    entryCount: ENTRY_COUNT,
    startupMs,
    startupStatus: { status: startupStatus.status, inventoryState: startupStatus.inventoryState, retryEligible: startupStatus.retryEligible },
    cancelledAuthoritativeCount: 0,
    completionMs,
    inventory: pointer,
    finalizer: { ffmpegInputs: 2, durationSeconds: verification.durationSeconds, rawPresentBeforeSaved: true },
  }, null, 2)}\n`);
} finally {
  await service?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function pcmWav() {
  const data = Buffer.alloc(46);
  data.write("RIFF", 0); data.writeUInt32LE(38, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(2, 40); data.writeInt16LE(1_000, 44);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
