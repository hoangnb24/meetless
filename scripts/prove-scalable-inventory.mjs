import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingStore } from "../packages/meeting-store/dist/index.js";
import { RecordingService } from "../packages/meetless-plugin/dist/src/recording-service.js";
import { readInventory, RecordingInventoryReconciler, resolveStorePath } from "../packages/meetless-plugin/dist/src/inventory.js";
import { Mp3Finalizer } from "../packages/meetless-plugin/dist/src/finalizer.js";
import { validateCommittedWavChunk } from "../packages/meetless-plugin/dist/src/chunk-validator.js";

const ENTRY_COUNT = 340_944;
const SOURCE_COUNT = ENTRY_COUNT / 2;
const DEFAULT_SAMPLE = 1_000;
const representativeSamples = new Map([
  [4, -1_200],
  [11, 3_100],
  [170_000, -2_400],
  [ENTRY_COUNT - 1, 4_200],
]);
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
  const bases = new Map();
  for (const sample of new Set([DEFAULT_SAMPLE, ...representativeSamples.values()])) {
    const base = path.join(root, `one-frame-${sample}.wav`);
    await writeFile(base, pcmWav(sample));
    bases.set(sample, base);
  }

  for (let offset = 0; offset < ENTRY_COUNT; offset += 512) {
    await Promise.all(Array.from({ length: Math.min(512, ENTRY_COUNT - offset) }, (_, local) => {
      const ordinal = offset + local;
      const source = ordinal % 2 === 0 ? "microphone" : "system";
      const sourceIndex = Math.floor(ordinal / 2);
      const id = chunkId(source, sourceIndex);
      return link(bases.get(representativeSamples.get(ordinal) ?? DEFAULT_SAMPLE), path.join(sessionDirectory, `${id}.wav`));
    }));
  }

  const committedOrdinals = [ENTRY_COUNT - 1, 4, 170_000, 11];
  const knownChunks = [];
  for (const ordinal of committedOrdinals) {
    const source = ordinal % 2 === 0 ? "microphone" : "system";
    const sourceIndex = Math.floor(ordinal / 2);
    const chunk = await validateCommittedWavChunk({
      filePath: path.join(sessionDirectory, `${chunkId(source, sourceIndex)}.wav`), sessionDirectory, storeRoot,
    });
    knownChunks.push(chunk);
    await store.commitChunk(recording.id, chunk);
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
    assert(cancelled.inventory.knownChunkCount === knownChunks.length && cancelled.inventory.pointer === null,
      `cancellation changed authoritative count on attempt ${attempt + 1}`);
    assert(JSON.stringify(cancelled.chunks) === JSON.stringify(knownChunks),
      `cancellation changed authoritative identities/order on attempt ${attempt + 1}`);
  }

  const completionStarted = performance.now();
  const pointer = await reconciler.reconcile((await store.listRecordings())[0]);
  const completionMs = Math.round(performance.now() - completionStarted);
  assert(pointer.chunkCount === ENTRY_COUNT, `inventory count ${pointer.chunkCount} != ${ENTRY_COUNT}`);
  assert(pointer.microphoneCount === SOURCE_COUNT && pointer.systemCount === SOURCE_COUNT,
    "source counts are not exact");
  const expected = await expectedInventory(recording.id, bases);
  assert(pointer.digest === expected.digest, `canonical sidecar digest ${pointer.digest} != ${expected.digest}`);
  const observedKnown = [];
  let observedCount = 0;
  const knownIds = new Set(knownChunks.map((chunk) => chunk.id));
  for await (const chunk of readInventory(storeRoot, pointer)) {
    if (knownIds.has(chunk.id)) observedKnown.push(chunk);
    observedCount += 1;
  }
  assert(observedCount === ENTRY_COUNT, `canonical sidecar yielded ${observedCount} entries`);
  const expectedKnownOrder = [...knownChunks].sort((left, right) =>
    left.source.localeCompare(right.source) || left.logicalStartMs - right.logicalStartMs || left.id.localeCompare(right.id));
  assert(JSON.stringify(observedKnown) === JSON.stringify(expectedKnownOrder),
    "canonical sidecar did not retain exact known identities in timeline order");

  const commands = [];
  const finalizer = new Mp3Finalizer({
    ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe",
    exportRoot, storeRoot, observeCommand: (_executable, arguments_) => commands.push([...arguments_]),
  });
  const staged = await finalizer.stage(recording.id, pointer);
  const verification = await finalizer.verify(staged.stagePath);
  assert(commands.length === 1 && commands[0].filter((argument) => argument === "-i").length === 2,
    "finalizer command topology exceeded two timeline inputs");
  const expectedTimelines = ["microphone", "system"].map(expectedTimeline);
  assert(JSON.stringify(staged.timelineEvidence) === JSON.stringify(expectedTimelines),
    `finalizer timeline content mismatch: ${JSON.stringify(staged.timelineEvidence)}`);
  assert(verification.identity.byteLength === staged.identity.byteLength && verification.identity.sha256 === staged.identity.sha256,
    "staged MP3 identity changed between finalizer verification and proof verification");
  const exactDurationSeconds = SOURCE_COUNT / 16_000;
  assert(verification.durationSeconds >= exactDurationSeconds && verification.durationSeconds <= exactDurationSeconds + 0.1,
    `MP3 duration ${verification.durationSeconds} is inconsistent with ${SOURCE_COUNT} exact source frames`);
  const firstStorageKey = path.join("sessions", recording.id, `${chunkId("microphone", 0)}.wav`);
  await access(resolveStorePath(storeRoot, firstStorageKey));

  process.stdout.write(`${JSON.stringify({
    entryCount: ENTRY_COUNT,
    startupMs,
    startupStatus: { status: startupStatus.status, inventoryState: startupStatus.inventoryState, retryEligible: startupStatus.retryEligible },
    cancelledAuthoritativeCount: knownChunks.length,
    cancelledAuthoritativeIds: knownChunks.map((chunk) => chunk.id),
    completionMs,
    inventory: { ...pointer, expectedCanonicalDigest: expected.digest, knownIdsInCanonicalOrder: observedKnown.map((chunk) => chunk.id) },
    finalizer: {
      ffmpegInputs: 2, exactDurationFrames: SOURCE_COUNT, durationSeconds: verification.durationSeconds,
      timelineEvidence: staged.timelineEvidence, mp3Identity: verification.identity, rawPresentBeforeSaved: true,
    },
  }, null, 2)}\n`);
} finally {
  await service?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function chunkId(source, sourceIndex) {
  return `chunk--${source}--${String(sourceIndex).padStart(6, "0")}--${String(sourceIndex).padStart(12, "0")}--000000000001--16000--1`;
}

function pcmWav(sample = DEFAULT_SAMPLE) {
  const data = Buffer.alloc(46);
  pcmHeader(1).copy(data);
  data.writeInt16LE(sample, 44);
  return data;
}

async function expectedInventory(recordingId, bases) {
  const identities = new Map();
  for (const [sample, base] of bases) {
    const bytes = pcmWav(sample);
    identities.set(sample, {
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      committedAt: (await stat(base)).mtime.toISOString(),
    });
  }
  const hash = createHash("sha256");
  for (const source of ["microphone", "system"]) {
    const parity = source === "microphone" ? 0 : 1;
    for (let sourceIndex = 0; sourceIndex < SOURCE_COUNT; sourceIndex += 1) {
      const ordinal = sourceIndex * 2 + parity;
      const identity = identities.get(representativeSamples.get(ordinal) ?? DEFAULT_SAMPLE);
      const id = chunkId(source, sourceIndex);
      const logicalStartMs = Math.floor(sourceIndex * 1_000 / 16_000);
      hash.update(`${JSON.stringify({
        sortKey: `${source}:${String(logicalStartMs).padStart(16, "0")}:${id}`,
        id, source, storageKey: path.join("sessions", recordingId, `${id}.wav`), ...identity,
        logicalStartMs, durationMs: 1, sampleRate: 16_000, channels: 1, format: "wav",
      })}\n`);
    }
  }
  return { digest: hash.digest("hex") };
}

function expectedTimeline(source) {
  const parity = source === "microphone" ? 0 : 1;
  const data = Buffer.alloc(44 + SOURCE_COUNT * 2);
  pcmHeader(SOURCE_COUNT).copy(data);
  for (let sourceIndex = 0; sourceIndex < SOURCE_COUNT; sourceIndex += 1) {
    const ordinal = sourceIndex * 2 + parity;
    data.writeInt16LE(representativeSamples.get(ordinal) ?? DEFAULT_SAMPLE, 44 + sourceIndex * 2);
  }
  return {
    source, frameCount: SOURCE_COUNT, byteLength: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function pcmHeader(frameCount) {
  const dataBytes = frameCount * 2;
  const data = Buffer.alloc(44);
  data.write("RIFF", 0); data.writeUInt32LE(36 + dataBytes, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(dataBytes, 40);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
