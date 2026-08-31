import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ManagedTranscriptionPolicy,
  parseCanonicalPcmWav,
  type ManagedTranscriptionSnapshot,
} from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import {
  ManagedTimelineArtifactStore,
  ManagedTranscriptionService,
} from "../../packages/meetless-plugin/src/managed-transcription.js";
import { managedTimelineStagingDirectory } from "../../packages/meetless-plugin/src/finalizer.js";
import { MeetingLifecycleCoordinator } from "../../packages/meetless-plugin/src/meeting-lifecycle-coordinator.js";
import { RecordingService, type RecordingFinalizationCheckpoint } from "../../packages/meetless-plugin/src/recording-service.js";
import { FileManagedUploadPort, type ManagedUploadCredential } from "../../packages/meetless-plugin/src/managed-upload.js";
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
    const observedFinalizerCommands: string[][] = [];
    const storeRoot = path.join(root, "store");
    const exportRoot = path.join(root, "Documents", "meetings");
    const artifacts = new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts"));
    const config = {
      storeRoot,
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot,
      fixture: true,
      exportNow: () => new Date("2026-08-31T12:00:00.000Z"),
      observeCommand: (_executable: string, arguments_: readonly string[]) => observedFinalizerCommands.push([...arguments_]),
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
    const stagedWavPaths = observedFinalizerCommands.flatMap((arguments_) =>
      arguments_.filter((argument) => argument.endsWith(".wav.stage")));
    expect(stagedWavPaths.length).toBeGreaterThan(0);
    expect(stagedWavPaths.every((candidate) => isPathInside(config.storeRoot, candidate))).toBe(true);
    expect(stagedWavPaths.every((candidate) =>
      isPathInside(path.join(config.storeRoot, "managed-artifacts"), candidate))).toBe(true);
    expect(stagedWavPaths.every((candidate) => !isPathInside(config.exportRoot, candidate))).toBe(true);
    expect((await readdir(config.exportRoot)).every((name) => name.endsWith(".mp3"))).toBe(true);
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
    const uploadCredential: ManagedUploadCredential = {
      deviceId: "real-composition-upload-device", keyId: "real-composition-upload-key", hostProof: "real-composition-host-proof",
    };
    const uploadAuthenticator = {
      authenticate: async () => ({ accountId: "real-composition-upload-account", deviceId: uploadCredential.deviceId }),
    };
    const managedUpload = new FileManagedUploadPort(path.join(root, "managed-upload"), uploadAuthenticator, {
      partSize: 1_024, now: () => START,
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
    let persistedPolicy: ManagedTranscriptionSnapshot | null = null;
    const crashedManaged = new ManagedTranscriptionService(recordingService.store, lineagePolicy, provider, {
      lifecycle,
      timelineArtifacts: artifacts,
      managedUpload,
      managedUploadCredential: uploadCredential,
      afterProviderSuccess: () => {
        persistedPolicy = JSON.parse(JSON.stringify(lineagePolicy.snapshot())) as ManagedTranscriptionSnapshot;
        throw new Error("simulated managed process crash after upload and provider success");
      },
    });
    await expect(crashedManaged.transcribe({
      recordingId,
      credential: device.credential,
      audioId: "managed-finalized-timeline",
      chunkId: "managed-finalized-chunk",
    })).rejects.toThrow("simulated managed process crash after upload and provider success");
    expect(persistedPolicy).not.toBeNull();
    expect(provider.transcribe).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(root, "managed-upload", "sessions.json"), "utf8")).sessions).toHaveLength(1);

    const restartedStore = new MeetingStore({ root: config.storeRoot, now: () => "2026-08-31T12:00:00.000Z" });
    const restartedManaged = new ManagedTranscriptionService(
      restartedStore,
      ManagedTranscriptionPolicy.fromSnapshot(persistedPolicy!, { now: () => START }),
      provider,
      {
        lifecycle,
        timelineArtifacts: new ManagedTimelineArtifactStore(path.join(config.storeRoot, "managed-artifacts")),
        managedUpload: new FileManagedUploadPort(path.join(root, "managed-upload"), uploadAuthenticator, {
          partSize: 1_024, now: () => START,
        }),
        managedUploadCredential: uploadCredential,
      },
    );
    const result = await restartedManaged.transcribe({
      recordingId,
      credential: device.credential,
      audioId: "managed-finalized-timeline",
      chunkId: "managed-finalized-chunk",
    });

    expect(result.transcript).toMatchObject({ status: "ready", audio: { destination: outputPath } });
    expect(result.transcript.ranges).toHaveLength(1);
    await expect(restartedStore.resolveCitation(
      saved.meetingId!, result.transcript.ranges[0]!.segmentId,
    )).resolves.toMatchObject({
      audioPath: outputPath,
      text: "Finalizer-owned managed transcript.",
    });
    expect(provider.transcribe).toHaveBeenCalledOnce();
    await expect(artifacts.get(recordingId)).resolves.toBeNull();
    await expect(access(handedOffPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(root, "managed-upload", "sessions.json")))).toEqual({ version: 1, sessions: [] });
  }, 30_000);

  test.each([
    "after-publication",
    "after-saved",
    "after-handoff",
    "after-cleanup",
  ] as const)("recovers a finalization crash at %s in a fresh service instance", async (checkpoint) => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-handoff-restart-"));
    roots.push(root);
    const lifecycle = new MeetingLifecycleCoordinator();
    const artifacts = new ManagedTimelineArtifactStore(path.join(root, "store", "managed-artifacts"));
    let injected = true;
    const config: ConstructorParameters<typeof RecordingService>[0] = {
      storeRoot: path.join(root, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(root, "Documents", "meetings"),
      fixture: true,
      exportNow: () => new Date("2026-08-31T12:00:00.000Z"),
      managedTimelineConsumer: artifacts,
      finalizationCheckpoint: (point: RecordingFinalizationCheckpoint) => {
        if (point === checkpoint && injected) {
          injected = false;
          throw new Error(`injected ${checkpoint}`);
        }
      },
    };
    const first = new RecordingService(config, undefined, lifecycle);
    services.push(first);
    await first.initialize();
    await first.execute({ version: 1, requestId: "start", command: "start", title: `Restart ${checkpoint}` });
    await waitFor(async () => (await first.status()).chunks.length >= 2);
    const recordingId = (await first.status()).recordingId!;
    const sessionDirectory = path.join(config.storeRoot, "sessions", recordingId);
    await expect(first.execute({ version: 1, requestId: "stop", command: "stop" }))
      .rejects.toThrow(`injected ${checkpoint}`);
    await first.shutdown();

    const restarted = new RecordingService(config, undefined, lifecycle);
    services.push(restarted);
    await restarted.initialize();
    const saved = await restarted.status();
    expect(saved).toMatchObject({ status: "saved", recordingId, chunks: [] });
    expect((await readdir(sessionDirectory)).filter((name) => name.endsWith(".wav"))).toEqual([]);
    expect((await readdir(config.exportRoot)).filter((name) => name.endsWith(".wav.stage"))).toEqual([]);
    expect((await existingNames(managedTimelineStagingDirectory(config.storeRoot, recordingId)))
      .filter((name) => name.endsWith(".wav.stage"))).toEqual([]);

    const policy = new ManagedTranscriptionPolicy({ now: () => START });
    const lineage = policy.seedVerifiedSubscriptionLineage({
      lineageKey: `restart-${checkpoint}`, product: "monthly", startedAt: START,
    });
    const device = policy.enrollDevice({
      verifiedLineageToken: lineage.token,
      installationId: `restart-${checkpoint}-install`,
      deviceKeyId: `restart-${checkpoint}-key`,
    });
    const provider: TranscriptionProvider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async () => ({ text: `recovered ${checkpoint}`, detectedLanguages: ["en"], usage: null })),
    };
    const managed = new ManagedTranscriptionService(restarted.store, policy, provider, {
      lifecycle,
      timelineArtifacts: new ManagedTimelineArtifactStore(path.join(config.storeRoot, "managed-artifacts")),
    });
    const result = await managed.transcribe({
      recordingId,
      credential: device.credential,
      audioId: "caller-cannot-change-recording-timeline",
      chunkId: `restart-${checkpoint}-admission`,
    });
    expect(result.transcript.status).toBe("ready");
    expect(provider.transcribe).toHaveBeenCalledOnce();
    await expect(artifacts.get(recordingId)).resolves.toBeNull();
    expect((await readdir(config.exportRoot)).filter((name) => name.endsWith(".mp3"))).toHaveLength(1);
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

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function existingNames(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
