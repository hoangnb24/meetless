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
  ConvexManagedTranscriptionService,
  ManagedTranscriptionService,
} from "../../packages/meetless-plugin/src/managed-transcription.js";
import { managedTimelineStagingDirectory } from "../../packages/meetless-plugin/src/finalizer.js";
import { MeetingLifecycleCoordinator } from "../../packages/meetless-plugin/src/meeting-lifecycle-coordinator.js";
import { RecordingService, type RecordingFinalizationCheckpoint } from "../../packages/meetless-plugin/src/recording-service.js";
import {
  ConvexManagedUploadPort,
  FileManagedConvexUploadJournal,
  FileManagedUploadPort,
  type ManagedConvexFunctionClient,
  type ManagedConvexJob,
  type ManagedConvexUploadSession,
  type ManagedUploadCredential,
} from "../../packages/meetless-plugin/src/managed-upload.js";
import type { ManagedLogicalTimelineManifest } from "@meetless/managed-transcription-foundation";
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

  test("keeps finalization local until explicit Convex intent, then publishes the private timeline result through MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-convex-composition-"));
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
    await recordingService.execute({ version: 1, requestId: "start", command: "start", title: "Convex composition" });
    await waitFor(async () => (await recordingService.status()).chunks.length >= 2);
    const recordingId = (await recordingService.status()).recordingId!;
    const sessionDirectory = path.join(config.storeRoot, "sessions", recordingId);
    const convexCalls: Array<{ kind: "mutation" | "query" | "action"; name: string; args: Record<string, unknown> }> = [];
    const postedPartLengths: number[] = [];
    const authTokens: string[] = [];
    let uploadPartNumber = 1;
    let manifest: ManagedLogicalTimelineManifest | null = null;
    let session: ManagedConvexUploadSession = {
      sessionId: "composition-upload",
      accountId: "composition-account",
      deviceId: "composition-device",
      state: "uploading",
      createdAt: START,
      expiresAt: START + 24 * 60 * 60 * 1_000,
      receivedPartNumbers: [],
      completedAt: null,
      jobId: null,
    };
    let job: ManagedConvexJob = {
      _id: "composition-job",
      uploadId: session.sessionId,
      recordingId,
      audioId: `recording:${recordingId}`,
      admissionId: "composition-admission",
      admissionNumber: 1,
      status: "reserved",
      durationMs: 0,
      sampleCount: 0,
      billableSeconds: 0,
      providerResult: null,
    };
    const client: ManagedConvexFunctionClient = {
      setAuth: (token) => authTokens.push(token),
      mutation: vi.fn(async (name, args) => {
        convexCalls.push({ kind: "mutation", name, args });
        if (name.endsWith(":beginUpload")) {
          manifest = args.manifest as ManagedLogicalTimelineManifest;
          job = {
            ...job,
            recordingId: manifest.recordingId,
            audioId: manifest.audioId,
            durationMs: manifest.durationMs,
            sampleCount: manifest.sampleCount,
            billableSeconds: Math.ceil(manifest.sampleCount / 16_000),
          };
          return session;
        }
        if (name.endsWith(":generateUploadUrl")) return `https://convex.local/composition/${uploadPartNumber}`;
        if (name.endsWith(":registerPart")) {
          const partNumber = args.partNumber as number;
          session = {
            ...session,
            receivedPartNumbers: [...new Set([...session.receivedPartNumbers, partNumber])].sort((left, right) => left - right),
          };
          uploadPartNumber += 1;
          return { outcome: "stored", partNumber, storageId: `composition-storage-${partNumber}` };
        }
        if (name.endsWith(":settleJob")) {
          job = { ...job, status: "succeeded" };
          return job;
        }
        throw new Error(`unexpected composition mutation ${name}`);
      }),
      query: vi.fn(async (name, args) => {
        convexCalls.push({ kind: "query", name, args });
        if (name.endsWith(":status")) return session;
        if (name.endsWith(":jobStatusByRecording")) return job;
        if (name.endsWith(":jobStatus")) return job;
        throw new Error(`unexpected composition query ${name}`);
      }),
      action: vi.fn(async (name, args) => {
        convexCalls.push({ kind: "action", name, args });
        if (name.endsWith(":sealUpload")) {
          session = { ...session, state: "sealed", jobId: job._id };
          return job;
        }
        if (name.endsWith(":runProvider")) {
          const text = "Convex local provider publication";
          job = {
            ...job,
            status: "provider_completed",
            providerResult: { text, ranges: [{ startMs: 0, endMs: job.durationMs, text }], detectedLanguages: [] },
          };
          return job;
        }
        if (name.endsWith(":acknowledge")) {
          session = { ...session, state: "cleaned" };
          return true;
        }
        throw new Error(`unexpected composition action ${name}`);
      }),
    };
    const managedUpload = new ConvexManagedUploadPort(client, {
      journal: new FileManagedConvexUploadJournal(path.join(root, "convex-journal")),
      fetch: async (url, init) => {
        expect(init?.method).toBe("POST");
        const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
        postedPartLengths.push(bytes.byteLength);
        return new Response(JSON.stringify({ storageId: `composition-storage-${postedPartLengths.length}` }), { status: 200 });
      },
    });

    const saved = await recordingService.execute({ version: 1, requestId: "stop", command: "stop" });
    expect(saved).toMatchObject({ status: "saved", recordingId, chunks: [] });
    expect(convexCalls).toEqual([]);
    expect((await readdir(sessionDirectory)).filter((name) => name.endsWith(".wav"))).toEqual([]);
    expect((await readdir(exportRoot)).every((name) => name.endsWith(".mp3"))).toBe(true);
    const stagedWavPaths = observedFinalizerCommands.flatMap((arguments_) =>
      arguments_.filter((argument) => argument.endsWith(".wav.stage")));
    expect(stagedWavPaths.length).toBeGreaterThan(0);
    expect(stagedWavPaths.every((candidate) => isPathInside(config.storeRoot, candidate))).toBe(true);
    expect(stagedWavPaths.every((candidate) => !isPathInside(config.exportRoot, candidate))).toBe(true);
    await expect(artifacts.get(recordingId)).resolves.not.toBeNull();

    const managed = new ConvexManagedTranscriptionService(recordingService.store, {
      lifecycle,
      timelineArtifacts: artifacts,
      managedUpload,
    });
    const result = await managed.transcribe({
      recordingId,
      credential: { authToken: "host-issued-composition-token" },
    });
    expect(result.job).toMatchObject({ status: "succeeded", recordingId, audioId: `recording:${recordingId}` });
    expect(result.transcript).toMatchObject({ status: "ready", recordingId });
    expect(result.transcript.ranges).toHaveLength(1);
    await expect(recordingService.store.resolveCitation(saved.meetingId!, result.transcript.ranges[0]!.segmentId)).resolves.toMatchObject({
      audioPath: expect.stringMatching(/\.mp3$/u),
      text: "Convex local provider publication",
    });
    expect(manifest).not.toBeNull();
    expect(postedPartLengths).toEqual(manifest!.parts.map((part) => part.byteLength));
    expect(authTokens).toEqual(expect.arrayContaining(["host-issued-composition-token"]));
    expect(convexCalls.some((call) => call.name.endsWith(":beginUpload"))).toBe(true);
    expect(convexCalls.every(({ args }) => !containsAudioBytes(args))).toBe(true);
    expect(convexCalls.every(({ args }) => !containsValue(args, path.join(config.exportRoot, "")))).toBe(true);
    expect(session.state).toBe("cleaned");
    await expect(artifacts.get(recordingId)).resolves.toBeNull();
    expect(await readdir(path.join(config.storeRoot, "managed-artifacts"))).toEqual([]);

    const callsBeforeFreshRetry = convexCalls.length;
    const freshManaged = new ConvexManagedTranscriptionService(recordingService.store, {
      lifecycle,
      timelineArtifacts: artifacts,
      managedUpload,
    });
    const freshRetry = await freshManaged.transcribe({
      recordingId,
      credential: { authToken: "host-issued-composition-token" },
    });
    expect(freshRetry.job).toMatchObject({ status: "succeeded", recordingId });
    expect(freshRetry.transcript).toMatchObject({ status: "ready", recordingId });
    expect(convexCalls.slice(callsBeforeFreshRetry).every((call) => call.kind === "query" && call.name.endsWith(":jobStatusByRecording"))).toBe(true);
    await expect(artifacts.get(recordingId)).resolves.toBeNull();
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

function containsAudioBytes(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsAudioBytes(item, seen));
  return Object.values(value).some((item) => containsAudioBytes(item, seen));
}

function containsValue(value: unknown, target: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(target);
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, target, seen));
  return Object.values(value).some((item) => containsValue(item, target, seen));
}
