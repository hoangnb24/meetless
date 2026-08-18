import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import {
  NativeOpenAiTranscriptionProvider,
  type NativeTranscriptionTransport,
  type TranscriptionProvider,
} from "../src/transcription-provider.js";
import { TranscriptionService } from "../src/transcription-service.js";

const roots = new Set<string>();
const now = "2026-08-18T10:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("saved recording transcription composition", () => {
  test("uses fake native transport for English, Vietnamese, and mixed ranges with durable retry accounting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-transcription-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await store.create({ id: "m-1", title: "Cloud transcript" });
    await store.startRecording({ id: "r-1", meetingId: "m-1" });
    await store.commitChunk("r-1", {
      id: "mic-1", source: "microphone", storageKey: "sessions/r-1/mic-1.chunk",
      byteLength: 128, sha256: "chunk-sha", committedAt: now,
      logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
    });
    const recovered = await store.prepareInventoryRecovery("r-1", "capture closed");
    await store.markInventoryScanning("r-1");
    await store.publishInventory("r-1", {
      storageKey: "sessions/r-1/inventory.ndjson", digest: "chunk-set-sha",
      chunkCount: recovered.inventory.knownChunkCount,
      microphoneCount: recovered.inventory.microphoneCount,
      systemCount: recovered.inventory.systemCount,
      publishedAt: now,
    });
    await store.beginFinalization("r-1", {
      openChunksDurablyClosed: true, chunkSetDigest: "chunk-set-sha",
      destination: "meetings/r-1.mp3", expectedIdentity: { byteLength: 128, sha256: "audio-sha" },
    });
    await store.markRecordingSaved("r-1", {
      destination: "meetings/r-1.mp3", identity: { byteLength: 128, sha256: "audio-sha" }, readable: true,
    });
    const texts = ["hello", "xin chào", "hello, xin chào"];
    const attempts = new Map<number, number>();
    const transport: NativeTranscriptionTransport = {
      request: vi.fn(async (input) => {
        if (input.operation === "status") {
          return { version: 1 as const, requestId: "status", ok: true, status: "configured" as const };
        }
        const ordinal = input.range!.ordinal;
        const attempt = (attempts.get(ordinal) ?? 0) + 1;
        attempts.set(ordinal, attempt);
        if (ordinal === 1 && attempt === 1) throw new Error("injected provider failure with secret sk-never");
        return {
          version: 1 as const, requestId: `request-${ordinal}-${attempt}`, ok: true, status: "configured" as const,
          text: texts[ordinal], detectedLanguages: ordinal === 1 ? ["vi"] : ordinal === 2 ? ["en", "vi"] : ["en"],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, durationSeconds: 1 },
        };
      }),
    };
    const cleanup = vi.fn(async () => undefined);
    const inspector = {
      initialize: vi.fn(async () => undefined),
      inspect: vi.fn(async () => ({ identity: { byteLength: 128, sha256: "audio-sha" }, durationMs: 65_000 })),
      extractRange: vi.fn(async (_filePath: string, range: { ordinal: number }) => {
        const rangePath = path.join(root, `fake-range-${range.ordinal}.mp3`);
        await writeFile(rangePath, `range-${range.ordinal}`);
        return { path: rangePath, cleanup };
      }),
    };
    const service = new TranscriptionService(store, new NativeOpenAiTranscriptionProvider(transport), {
      inspector,
      sourceSnapshots: passThroughSnapshots(),
    });

    await expect(service.transcribeSavedRecording("r-1")).rejects.toThrow(/consent/);
    expect(transport.request).not.toHaveBeenCalled();
    await store.grantTranscriptionConsent();
    const transcript = await service.transcribeSavedRecording("r-1");
    expect(transcript.status).toBe("ready");
    expect(transcript.checkpoints.map((checkpoint) => checkpoint.text)).toEqual(texts);
    expect(transcript.requestCount).toBe(4);
    expect(transcript.attemptsByOrdinal).toEqual({ "0": 1, "1": 2, "2": 1 });
    expect(transcript.usage).toEqual({ inputTokens: 3, outputTokens: 6, totalTokens: 9, durationSeconds: 3 });
    expect(transcript.detectedLanguages).toEqual(["en", "vi"]);
    expect(cleanup).toHaveBeenCalledTimes(4);
    const nativeRequests = vi.mocked(transport.request).mock.calls
      .map(([input]) => input)
      .filter((input) => input.operation === "transcribe");
    expect(nativeRequests.every((input) => (input.audioByteLength ?? 0) > 0 && /^[0-9a-f]{64}$/.test(input.audioSha256 ?? ""))).toBe(true);
    expect((await store.list())[0]).toMatchObject({ id: "m-1", status: "ready" });
    await expect(store.resolveCitation("m-1", transcript.ranges[2]!.segmentId)).resolves.toMatchObject({
      startMs: 60_000, endMs: 65_000, text: "hello, xin chào",
    });
  });

  test("startup resumes an in-flight request with budget and publishes after the remaining attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-transcription-restart-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-restart", "r-restart");
    await store.grantTranscriptionConsent();
    const transcript = await store.ensureTranscript({
      meetingId: "m-restart", recordingId: "r-restart", maxAttempts: 2,
      audio: { destination: "meetings/r-restart.mp3", byteLength: 128, sha256: "audio-sha", durationMs: 1_000 },
    });
    await store.beginTranscriptRequest(transcript.id);

    const transcribe = vi.fn(async () => ({ text: "resumed", detectedLanguages: ["en"], usage: null }));
    const provider: TranscriptionProvider = { status: async () => "configured", transcribe };
    const inspector = restartInspector(root);
    const restarted = new MeetingStore({ root, now: () => now });
    const service = new TranscriptionService(restarted, provider, { inspector, sourceSnapshots: passThroughSnapshots() });
    await service.initialize();

    await vi.waitFor(async () => {
      expect(await restarted.getTranscript(transcript.id)).toMatchObject({ status: "ready", requestCount: 2 });
    });
    expect(transcribe).toHaveBeenCalledOnce();
  });

  test("startup terminalizes an exhausted in-flight request and does not schedule a provider call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-transcription-exhausted-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-exhausted", "r-exhausted");
    await store.grantTranscriptionConsent();
    const transcript = await store.ensureTranscript({
      meetingId: "m-exhausted", recordingId: "r-exhausted", maxAttempts: 1,
      audio: { destination: "meetings/r-exhausted.mp3", byteLength: 128, sha256: "audio-sha", durationMs: 1_000 },
    });
    await store.beginTranscriptRequest(transcript.id);
    const transcribe = vi.fn(async () => ({ text: "must not run", detectedLanguages: [], usage: null }));
    const restarted = new MeetingStore({ root, now: () => now });
    const service = new TranscriptionService(
      restarted,
      { status: async () => "configured", transcribe },
      { inspector: restartInspector(root), sourceSnapshots: passThroughSnapshots() },
    );

    await service.initialize();

    expect(await restarted.getTranscript(transcript.id)).toMatchObject({
      status: "failed", requestCount: 1,
      failureReason: "Transcription interrupted after the final allowed attempt",
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("changed source identity fails before range encoding, upload, or transcript publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-transcription-tamper-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-tamper", "r-tamper");
    await store.grantTranscriptionConsent();
    const extractRange = vi.fn();
    const transcribe = vi.fn();
    const service = new TranscriptionService(
      store,
      { status: async () => "configured", transcribe },
      {
        inspector: {
          initialize: async () => undefined,
          inspect: vi.fn(),
          extractRange,
        },
        sourceSnapshots: {
          initialize: async () => undefined,
          create: vi.fn(async () => { throw new Error("Saved MP3 identity changed before private snapshot"); }),
        },
      },
    );

    await expect(service.transcribeSavedRecording("r-tamper")).rejects.toThrow(/identity changed/);
    expect(extractRange).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(await store.getTranscriptForMeeting("m-tamper")).toBeNull();
  });

  test("native PID readiness retries complete before durable transcription attempts begin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-transcription-readiness-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-readiness", "r-readiness");
    await store.grantTranscriptionConsent();
    const events: string[] = [];
    let statusCalls = 0;
    const transport: NativeTranscriptionTransport = {
      request: vi.fn(async (input) => {
        if (input.operation === "status") {
          statusCalls += 1;
          events.push(`status-${statusCalls}`);
          return statusCalls < 3
            ? { version: 1 as const, requestId: `status-${statusCalls}`, ok: false, status: "invalid" as const, error: "transcription unavailable" as const }
            : { version: 1 as const, requestId: `status-${statusCalls}`, ok: true, status: "configured" as const };
        }
        events.push("transcribe");
        return {
          version: 1 as const, requestId: "transcribe", ok: true, status: "configured" as const,
          text: "ready once", detectedLanguages: ["en"], usage: null,
        };
      }),
    };
    const service = new TranscriptionService(
      store,
      new NativeOpenAiTranscriptionProvider(transport, {
        readinessDelayMs: 0,
        delay: async () => undefined,
      }),
      { inspector: restartInspector(root), sourceSnapshots: passThroughSnapshots() },
    );

    await service.initialize();
    await vi.waitFor(async () => {
      expect(await store.getTranscriptForMeeting("m-readiness")).toMatchObject({ status: "ready", requestCount: 1 });
    });
    expect(events.slice(0, 3)).toEqual(["status-1", "status-2", "status-3"]);
    expect(events.filter((event) => event === "transcribe")).toHaveLength(1);
  });
});

async function createSavedRecording(store: MeetingStore, meetingId: string, recordingId: string): Promise<void> {
  await store.create({ id: meetingId, title: "Restart transcription" });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: `${recordingId}-mic`, source: "microphone", storageKey: `sessions/${recordingId}/mic.chunk`,
    byteLength: 128, sha256: "chunk-sha", committedAt: now,
    logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery(recordingId, "capture closed");
  await store.markInventoryScanning(recordingId);
  await store.publishInventory(recordingId, {
    storageKey: `sessions/${recordingId}/inventory.ndjson`, digest: "chunk-set-sha",
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: recovered.inventory.microphoneCount,
    systemCount: recovered.inventory.systemCount,
    publishedAt: now,
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true, chunkSetDigest: "chunk-set-sha",
    destination: `meetings/${recordingId}.mp3`, expectedIdentity: { byteLength: 128, sha256: "audio-sha" },
  });
  await store.markRecordingSaved(recordingId, {
    destination: `meetings/${recordingId}.mp3`, identity: { byteLength: 128, sha256: "audio-sha" }, readable: true,
  });
}

function restartInspector(root: string) {
  return {
    initialize: async () => undefined,
    inspect: vi.fn(async () => ({ identity: { byteLength: 128, sha256: "audio-sha" }, durationMs: 1_000 })),
    extractRange: vi.fn(async () => {
      const rangePath = path.join(root, "restart-range.mp3");
      await writeFile(rangePath, "restart-range");
      return { path: rangePath, cleanup: async () => undefined };
    }),
  };
}

function passThroughSnapshots() {
  return {
    initialize: async () => undefined,
    create: vi.fn(async (sourcePath: string) => ({ path: sourcePath, cleanup: async () => undefined })),
  };
}
