import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ManagedTranscriptionPolicy,
  parseCanonicalPcmWav,
} from "@meetless/managed-transcription-foundation";
import {
  ManagedTimelineArtifactStore,
  ManagedTranscriptionService,
} from "../../packages/meetless-plugin/src/managed-transcription.js";
import { MeetingLifecycleCoordinator } from "../../packages/meetless-plugin/src/meeting-lifecycle-coordinator.js";
import { RecordingService } from "../../packages/meetless-plugin/src/recording-service.js";
import type { TranscriptionProvider } from "../../packages/meetless-plugin/src/transcription-provider.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const roots: string[] = [];
const services: RecordingService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed transcription composition", () => {
  test("finalizer hands off canonical WAV before cleanup and publishes through MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-composition-"));
    roots.push(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const artifacts = new ManagedTimelineArtifactStore(path.join(root, "managed-artifacts"));
    const config = {
      storeRoot: path.join(root, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(root, "Documents", "meetings"),
      fixture: true,
      exportNow: () => new Date("2026-08-31T12:00:00.000Z"),
      managedTimelineConsumer: artifacts,
    };
    const recordingService = new RecordingService(config, undefined, lifecycle);
    services.push(recordingService);
    await recordingService.initialize();
    await recordingService.execute({ version: 1, requestId: "start", command: "start", title: "Managed composition" });
    await waitFor(async () => (await recordingService.status()).chunks.length >= 2);
    const recordingId = (await recordingService.status()).recordingId!;
    const sessionDirectory = path.join(config.storeRoot, "sessions", recordingId);
    const cleanupInventory = recordingService.store.cleanupEligibleInventory.bind(recordingService.store);
    recordingService.store.cleanupEligibleInventory = async (...args) => {
      await expect(artifacts.get(recordingId)).resolves.not.toBeNull();
      return cleanupInventory(...args);
    };

    const saved = await recordingService.execute({ version: 1, requestId: "stop", command: "stop" });
    expect(saved).toMatchObject({ status: "saved", recordingId, chunks: [] });
    expect((await readdir(sessionDirectory)).filter((name) => name.endsWith(".wav"))).toEqual([]);
    const savedRecording = (await recordingService.store.listRecordings()).find((recording) => recording.id === recordingId)!;
    const outputPath = savedRecording.savedOutput!.destination;
    const outputBytes = await readFile(outputPath);
    expect(outputBytes.subarray(0, 3).toString("ascii")).toBe("ID3");
    const handedOff = await artifacts.get(recordingId);
    expect(handedOff).not.toBeNull();
    const handedOffPath = handedOff!.path;
    const handedOffBytes = await readFile(handedOffPath);
    expect(parseCanonicalPcmWav(handedOffBytes)).toMatchObject({ sampleRate: 16_000, channels: 1 });

    const lineagePolicy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = lineagePolicy.seedVerifiedSubscriptionLineage({
      lineageKey: "real-composition-lineage", product: "monthly", startedAt: START,
    });
    const device = lineagePolicy.enrollDevice({
      verifiedLineageToken: lineage.token, installationId: "real-composition-install", deviceKeyId: "real-composition-key",
    });
    const provider: TranscriptionProvider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async ({ audioPath, range }) => {
        expect(audioPath).toBe(handedOffPath);
        expect(audioPath).not.toBe(outputPath);
        expect(range.startMs).toBe(0);
        expect(range.endMs).toBeGreaterThanOrEqual(1_000);
        return { text: "Finalizer-owned managed transcript.", detectedLanguages: ["en"], usage: null };
      }),
    };
    const managed = new ManagedTranscriptionService(recordingService.store, lineagePolicy, provider, {
      lifecycle,
      timelineArtifacts: artifacts,
    });
    const result = await managed.transcribe({
      recordingId,
      credential: device.credential,
      audioId: "managed-finalized-timeline",
      chunkId: "managed-finalized-chunk",
    });

    expect(result.transcript).toMatchObject({ status: "ready", audio: { destination: outputPath } });
    expect(result.transcript.ranges).toHaveLength(1);
    await expect(recordingService.store.resolveCitation(
      saved.meetingId!, result.transcript.ranges[0]!.segmentId,
    )).resolves.toMatchObject({
      audioPath: outputPath,
      text: "Finalizer-owned managed transcript.",
    });
    expect(provider.transcribe).toHaveBeenCalledOnce();
    await expect(artifacts.get(recordingId)).resolves.toBeNull();
    await expect(access(handedOffPath)).rejects.toMatchObject({ code: "ENOENT" });
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
