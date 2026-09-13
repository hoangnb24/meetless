import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MANAGED_MAX_UPLOAD_PART_SAMPLES,
  MANAGED_SAMPLE_RATE,
  MANAGED_TEMPORARY_DATA_TTL_MS,
  validateManagedLogicalTimelineManifest,
} from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import {
  ConvexManagedUploadPort,
  FileManagedConvexUploadJournal,
  FileManagedUploadPort,
  ManagedUploadAuthenticationError,
  ManagedQuotaExceededError,
  ManagedUploadConflictError,
  ManagedUploadStateError,
  type ManagedConvexFunctionClient,
  type ManagedConvexJob,
  type ManagedConvexUploadSession,
  buildManagedLogicalTimelineManifest,
  inspectCanonicalPcmWavStream,
  readManagedCanonicalPartBytes,
  type ManagedUploadCredential,
  type ManagedUploadManifest,
} from "../src/managed-upload.js";
import {
  ManagedTimelineArtifactStore,
  type ManagedCanonicalTimeline,
} from "../src/managed-transcription.js";
import { RecordingService } from "../src/recording-service.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");
const credential: ManagedUploadCredential = {
  deviceId: "device-a",
  keyId: "key-a",
  hostProof: "host-proof-a",
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pre-external managed upload seam", () => {
  test("materializes canonical parts without retaining reused source-buffer views", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-canonical-part-"));
    roots.push(root);
    const sourcePath = path.join(root, "canonical.wav");
    await writeFile(sourcePath, wavBytes(16_001));
    const manifest = await buildManagedLogicalTimelineManifest({
      recordingId: "recording-canonical-part",
      manifestSha256: sha256Text("canonical-part-manifest"),
      sourcePath,
    });
    const bytes = await readManagedCanonicalPartBytes(sourcePath, manifest.parts[0]!.sampleOffset, manifest.parts[0]!.sampleCount);
    expect(bytes.byteLength).toBe(manifest.parts[0]!.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.parts[0]!.sha256);
  });

  test.each([32_769, 361_067])("uploads immutable PCM bytes across reused read buffers (%i samples)", async (sampleCount) => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-stream-bytes-"));
    roots.push(root);
    const sourcePath = path.join(root, "canonical.wav");
    const expected = wavBytes(sampleCount);
    await writeFile(sourcePath, expected);
    const manifest = await buildManagedLogicalTimelineManifest({
      recordingId: "recording-stream-bytes",
      manifestSha256: sha256Text("stream-bytes-manifest"),
      sourcePath,
    });
    const session: ManagedConvexUploadSession = {
      sessionId: "upload-stream-bytes", accountId: "account-stream", deviceId: "device-stream",
      state: "uploading", createdAt: START, expiresAt: START + MANAGED_TEMPORARY_DATA_TTL_MS,
      receivedPartNumbers: [], completedAt: null, jobId: null,
    };
    let posted: Buffer | null = null;
    const client: ManagedConvexFunctionClient = {
      mutation: async (name) => {
        if (name.endsWith(":beginUpload")) return session;
        if (name.endsWith(":generateUploadUrl")) return "https://synthetic.invalid/upload";
        if (name.endsWith(":registerPart")) return { outcome: "stored" };
        throw new Error(`unexpected mutation ${name}`);
      },
      query: async () => session,
      action: async (name) => {
        if (!name.endsWith(":sealUpload")) throw new Error(`unexpected action ${name}`);
        return {
          _id: "job-stream-bytes", uploadId: session.sessionId,
          recordingId: manifest.recordingId, audioId: manifest.audioId,
          admissionId: "admission-stream", admissionNumber: 1, status: "reserved",
          durationMs: manifest.durationMs, sampleCount, billableSeconds: Math.ceil(sampleCount / MANAGED_SAMPLE_RATE),
          providerResult: null,
        };
      },
    };
    const port = new ConvexManagedUploadPort(client, {
      journal: new FileManagedConvexUploadJournal(path.join(root, "journal")),
      fetch: async (_url, init) => {
        // Consume the actual Readable.toWeb upload body, whose queued chunks
        // must remain unchanged while the producer reads subsequent PCM bytes.
        posted = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response(JSON.stringify({ storageId: "storage-stream-bytes" }));
      },
    });
    await port.uploadCanonicalTimelineFromPath({
      credential: { authToken: "synthetic-not-sent" }, manifest, sourcePath,
    });
    expect(posted).not.toBeNull();
    expect(identityOf(posted!)).toEqual({ byteLength: manifest.parts[0]!.byteLength, sha256: manifest.parts[0]!.sha256 });
    expect(posted).toEqual(expected);
  });

  test.each([false, true])("recovers old POST receipts before explicit repair, without crossing session IDs (Retry=%s)", async (repairCorruptUpload) => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-repair-order-"));
    roots.push(root);
    const sourcePath = path.join(root, "canonical.wav");
    await writeFile(sourcePath, wavBytes(32_769));
    const manifest = await buildManagedLogicalTimelineManifest({ recordingId: "repair-order", manifestSha256: sha256Text("repair-order"), sourcePath });
    const part = manifest.parts[0]!;
    const original: ManagedConvexUploadSession = {
      sessionId: "original", accountId: "account", deviceId: "device", state: "uploading",
      createdAt: START, expiresAt: START + MANAGED_TEMPORARY_DATA_TTL_MS,
      receivedPartNumbers: [], completedAt: null, jobId: null,
    };
    const successor = { ...original, sessionId: "successor", receivedPartNumbers: [] as number[] };
    const order: string[] = [];
    const journal = new FileManagedConvexUploadJournal(path.join(root, "journal"));
    await journal.record({ ...part, sessionId: original.sessionId, storageId: "old-corrupt-storage" });
    const port = new ConvexManagedUploadPort({
      mutation: async (name, args) => {
        if (name.endsWith(":beginUpload")) return original;
        if (name.endsWith(":registerPart")) {
          order.push(`register:${args.sessionId}:${args.storageId}`);
          const target = args.sessionId === original.sessionId ? original : successor;
          (target.receivedPartNumbers as number[]).push(args.partNumber as number);
          return { outcome: "stored" };
        }
        if (name.endsWith(":generateUploadUrl")) { order.push(`url:${args.sessionId}`); return "https://synthetic.invalid/upload"; }
        throw new Error(name);
      },
      query: async (_name, args) => args.sessionId === original.sessionId ? original : successor,
      action: async (name, args) => {
        if (name.endsWith(":repairUpload")) {
          order.push(`repair:${args.sessionId}`);
          expect(await journal.pending(original.sessionId)).toEqual([]);
          return successor;
        }
        if (!name.endsWith(":sealUpload")) throw new Error(name);
        order.push(`seal:${args.sessionId}`);
        return { _id: "job", uploadId: args.sessionId, recordingId: manifest.recordingId, audioId: manifest.audioId,
          admissionId: "admission", admissionNumber: 1, status: "reserved", durationMs: manifest.durationMs,
          sampleCount: manifest.sampleCount, billableSeconds: 3, providerResult: null };
      },
    }, { journal, fetch: async (_url, init) => {
      expect(sha256Bytes(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()))).toBe(part.sha256);
      return new Response(JSON.stringify({ storageId: "new-correct-storage" }));
    } });
    await port.uploadCanonicalTimelineFromPath({ credential: { authToken: "synthetic" }, manifest, sourcePath, repairCorruptUpload });
    expect(order).toEqual(repairCorruptUpload
      ? ["register:original:old-corrupt-storage", "repair:original", "url:successor", "register:successor:new-correct-storage", "seal:successor"]
      : ["register:original:old-corrupt-storage", "seal:original"]);
  });

  test("stops a validated quota denial before audio POST, journal recovery, repair or provider work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-quota-preflight-"));
    roots.push(root);
    const sourcePath = path.join(root, "canonical.wav");
    const audio = wavBytes(361_067);
    await writeFile(sourcePath, audio);
    const manifest = await buildManagedLogicalTimelineManifest({ recordingId: "quota-preflight", manifestSha256: sha256Text("quota-preflight"), sourcePath });
    const denied = { version: 1, kind: "managed_quota_insufficient", requiredSeconds: 23, remainingSeconds: 22, checkedAt: START, resetAt: START + 86_400_000 };
    const mutation = vi.fn(async () => denied);
    const query = vi.fn();
    const action = vi.fn();
    const post = vi.fn();
    const journal = { pending: vi.fn(), record: vi.fn(), remove: vi.fn(), clear: vi.fn() };
    const available = vi.fn();
    const port = new ConvexManagedUploadPort({ mutation, query, action }, { journal, fetch: post });
    await expect(port.uploadCanonicalTimelineFromPath({ credential: { authToken: "synthetic" }, manifest, sourcePath, repairCorruptUpload: true, onQuotaAvailable: available }))
      .rejects.toMatchObject({ quotaFailure: denied });
    expect(mutation).toHaveBeenCalledExactlyOnceWith("managedTranscription:beginUpload", { manifest });
    expect(post).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(journal.pending).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
    expect(await readFile(sourcePath)).toEqual(audio);
    mutation.mockResolvedValueOnce({ ...denied, remainingSeconds: 23 });
    await expect(port.begin({ credential: { authToken: "synthetic" }, manifest })).rejects.toThrow("invalid or inconsistent");
    expect(post).not.toHaveBeenCalled();
  });

  test("segments a large canonical timeline through generated upload URLs and resumes an immutable logical job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-convex-upload-"));
    roots.push(root);
    const sourcePath = path.join(root, "canonical.wav");
    const sampleCount = 13_200_001;
    await writeSparseCanonicalWav(sourcePath, sampleCount);
    const manifest = await buildManagedLogicalTimelineManifest({
      recordingId: "recording-convex-large",
      manifestSha256: sha256Text("convex-large-manifest"),
      sourcePath,
    });
    expect(manifest.sampleCount).toBe(sampleCount);
    expect(manifest.parts).toHaveLength(2);
    expect(manifest.parts[0]!.sampleCount).toBe(MANAGED_MAX_UPLOAD_PART_SAMPLES);
    expect(manifest.parts[1]!.sampleCount).toBe(sampleCount - MANAGED_MAX_UPLOAD_PART_SAMPLES);
    expect(manifest.durationMs).toBe(Math.ceil(sampleCount / MANAGED_SAMPLE_RATE * 1_000));

    const calls: Array<{ kind: "mutation" | "query" | "action"; name: string; args: Record<string, unknown> }> = [];
    const posted: Array<{ url: string; byteLength: number }> = [];
    const authTokens: string[] = [];
    let nextUploadUrlPart = 1;
    let failNextRegister = true;
    let session: ManagedConvexUploadSession = {
      sessionId: "upload-convex-large",
      accountId: "account-convex",
      deviceId: "device-convex",
      state: "uploading",
      createdAt: START,
      expiresAt: START + MANAGED_TEMPORARY_DATA_TTL_MS,
      receivedPartNumbers: [],
      completedAt: null,
      jobId: null,
    };
    let job: ManagedConvexJob = {
      _id: "job-convex-large",
      uploadId: session.sessionId,
      recordingId: manifest.recordingId,
      audioId: manifest.audioId,
      admissionId: "admission-convex-large",
      admissionNumber: 1,
      status: "reserved",
      durationMs: manifest.durationMs,
      sampleCount: manifest.sampleCount,
      billableSeconds: Math.ceil(manifest.sampleCount / MANAGED_SAMPLE_RATE),
      providerResult: null,
    };
    const client: ManagedConvexFunctionClient = {
      setAuth: (token) => authTokens.push(token),
      mutation: vi.fn(async (name, args) => {
        calls.push({ kind: "mutation", name, args });
        if (name.endsWith(":beginUpload")) return session;
        if (name.endsWith(":generateUploadUrl")) return `https://convex.local/upload/${nextUploadUrlPart++}`;
        if (name.endsWith(":registerPart")) {
          const partNumber = args.partNumber as number;
          if (failNextRegister) {
            failNextRegister = false;
            throw new Error("simulated process loss after Convex storage POST");
          }
          session = { ...session, receivedPartNumbers: [...new Set([...session.receivedPartNumbers, partNumber])].sort((a, b) => a - b) };
          return { outcome: "stored", partNumber, storageId: args.storageId };
        }
        if (name.endsWith(":settleJob")) {
          job = { ...job, status: "succeeded", providerResult: job.providerResult };
          return job;
        }
        throw new Error(`unexpected mutation ${name}`);
      }),
      query: vi.fn(async (name, args) => {
        calls.push({ kind: "query", name, args });
        if (name.endsWith(":status")) return session;
        if (name.endsWith(":jobStatus")) return job;
        throw new Error(`unexpected query ${name}`);
      }),
      action: vi.fn(async (name, args) => {
        calls.push({ kind: "action", name, args });
        if (name.endsWith(":sealUpload")) {
          session = { ...session, state: "sealed", jobId: job._id };
          return job;
        }
        if (name.endsWith(":runProvider")) {
          const text = "local provider result";
          job = {
            ...job,
            status: "provider_completed",
            providerResult: { text, ranges: [{ startMs: 0, endMs: manifest.durationMs, text }], detectedLanguages: [] },
          };
          return job;
        }
        if (name.endsWith(":acknowledge")) {
          session = { ...session, state: "cleaned" };
          return true;
        }
        throw new Error(`unexpected action ${name}`);
      }),
    };
    const journalDirectory = path.join(root, "convex-journal");
    const port = new ConvexManagedUploadPort(client, {
      journal: new FileManagedConvexUploadJournal(journalDirectory),
      fetch: async (url, init) => {
        const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
        posted.push({ url: String(url), byteLength: bytes.byteLength });
        return new Response(JSON.stringify({ storageId: `storage-convex-${posted.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const convexCredential = { authToken: "host-issued-convex-token" };

    await expect(port.uploadCanonicalTimelineFromPath({
      credential: convexCredential,
      manifest,
      sourcePath,
    })).rejects.toThrow("process loss after Convex storage POST");
    await expect(new FileManagedConvexUploadJournal(journalDirectory).pending(session.sessionId))
      .resolves.toMatchObject([{ partNumber: 1, storageId: "storage-convex-1" }]);

    const restarted = new ConvexManagedUploadPort(client, {
      journal: new FileManagedConvexUploadJournal(journalDirectory),
      fetch: async (url, init) => {
        const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
        posted.push({ url: String(url), byteLength: bytes.byteLength });
        return new Response(JSON.stringify({ storageId: `storage-convex-${posted.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const first = await restarted.uploadCanonicalTimelineFromPath({
      credential: convexCredential,
      manifest,
      sourcePath,
    });
    expect(first.session).toMatchObject({ state: "sealed", receivedPartNumbers: [1, 2], jobId: job._id });
    expect(posted.map((part) => part.byteLength)).toEqual(manifest.parts.map((part) => part.byteLength));
    expect(authTokens.length).toBeGreaterThan(0);
    expect(authTokens.every((token) => token === convexCredential.authToken)).toBe(true);

    const postedCount = posted.length;
    const resumed = await restarted.uploadCanonicalTimelineFromPath({
      credential: convexCredential,
      manifest,
      sourcePath,
    });
    expect(resumed.session).toMatchObject({ state: "sealed", receivedPartNumbers: [1, 2], jobId: job._id });
    expect(posted).toHaveLength(postedCount);
    const completed = await restarted.settle({ credential: convexCredential, jobId: job._id });
    expect(completed.status).toBe("succeeded");
    await expect(restarted.acknowledge({ credential: convexCredential, jobId: job._id })).resolves.toBe(true);
    expect(session.state).toBe("cleaned");
    expect(calls.every(({ args }) => !containsAudioBytes(args))).toBe(true);
    expect(calls.every(({ args }) => !Object.values(args).includes(sourcePath))).toBe(true);
  }, 30_000);

  test("accepts a logical manifest longer than 60 minutes without treating physical parts as separate jobs", () => {
    const sampleCount = MANAGED_MAX_UPLOAD_PART_SAMPLES * 7;
    const parts = Array.from({ length: 7 }, (_, index) => ({
      partNumber: index + 1,
      sampleOffset: index * MANAGED_MAX_UPLOAD_PART_SAMPLES,
      sampleCount: MANAGED_MAX_UPLOAD_PART_SAMPLES,
      byteLength: 44 + MANAGED_MAX_UPLOAD_PART_SAMPLES * 2,
      sha256: `${String(index + 1).repeat(64 / String(index + 1).length)}`,
    }));
    const manifest = validateManagedLogicalTimelineManifest({
      recordingId: "recording-over-hour",
      audioId: "recording:recording-over-hour",
      manifestSha256: sha256Text("over-hour-manifest"),
      contentSha256: sha256Text("over-hour-content"),
      byteLength: 44 + sampleCount * 2,
      durationMs: Math.ceil(sampleCount / MANAGED_SAMPLE_RATE * 1_000),
      sampleCount,
      partsManifestSha256: sha256Text("over-hour-parts"),
      parts,
    });
    expect(manifest.sampleCount / MANAGED_SAMPLE_RATE / 60).toBeGreaterThan(60);
    expect(manifest.parts).toHaveLength(7);
  });

  test("rejects over-bound, gapped, and overlapping physical parts at the policy edge", () => {
    const base = {
      recordingId: "recording-part-boundary",
      audioId: "recording:recording-part-boundary",
      manifestSha256: sha256Text("part-boundary-manifest"),
      contentSha256: sha256Text("part-boundary-content"),
      byteLength: 48,
      durationMs: 1,
      sampleCount: 2,
      partsManifestSha256: sha256Text("part-boundary-parts"),
      parts: [
        { partNumber: 1, sampleOffset: 0, sampleCount: 1, byteLength: 46, sha256: "a".repeat(64) },
        { partNumber: 2, sampleOffset: 1, sampleCount: 1, byteLength: 46, sha256: "b".repeat(64) },
      ],
    };
    expect(() => validateManagedLogicalTimelineManifest({ ...base, parts: [
      { ...base.parts[0]!, sampleCount: MANAGED_MAX_UPLOAD_PART_SAMPLES + 1, byteLength: 44 + (MANAGED_MAX_UPLOAD_PART_SAMPLES + 1) * 2 },
    ], sampleCount: MANAGED_MAX_UPLOAD_PART_SAMPLES + 1, byteLength: 44 + (MANAGED_MAX_UPLOAD_PART_SAMPLES + 1) * 2,
      durationMs: Math.ceil((MANAGED_MAX_UPLOAD_PART_SAMPLES + 1) / MANAGED_SAMPLE_RATE * 1_000) })).toThrow(/ten-minute/);
    expect(() => validateManagedLogicalTimelineManifest({ ...base, parts: [
      base.parts[0]!, { ...base.parts[1]!, sampleOffset: 2 },
    ] })).toThrow(/contiguous/);
    expect(() => validateManagedLogicalTimelineManifest({ ...base, parts: [
      base.parts[0]!, { ...base.parts[1]!, sampleOffset: 0 },
    ] })).toThrow(/contiguous/);
  });

  test("streams a canonical WAV larger than 25 MB, recovers duplicate parts/completion after restart, and acknowledges once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-upload-large-"));
    roots.push(root);
    const authenticator = {
      authenticate: vi.fn(async (candidate: ManagedUploadCredential) => {
        if (candidate.hostProof !== credential.hostProof) throw new ManagedUploadAuthenticationError("host proof rejected");
        return { accountId: "account-a", deviceId: candidate.deviceId };
      }),
    };
    const port = new FileManagedUploadPort(path.join(root, "upload"), authenticator, {
      partSize: 256 * 1024,
      now: () => START,
    });
    const sampleCount = 13_200_000;
    const inspected = await inspectCanonicalPcmWavStream(canonicalWav(sampleCount));
    expect(inspected.byteLength).toBeGreaterThan(25 * 1024 * 1024);
    const manifest: ManagedUploadManifest = {
      recordingId: "recording-large",
      audioId: "recording:recording-large",
      manifestSha256: sha256Text("validated-inventory-large"),
      contentSha256: inspected.contentSha256,
      byteLength: inspected.byteLength,
      durationMs: inspected.durationMs,
    };

    const first = await port.begin({ credential, manifest });
    await expect(port.begin({ credential, manifest })).resolves.toMatchObject({ sessionId: first.sessionId });
    const restartedBeforeParts = new FileManagedUploadPort(path.join(root, "upload"), authenticator, {
      partSize: 256 * 1024,
      now: () => START,
    });
    await expect(restartedBeforeParts.status({ sessionId: first.sessionId, credential })).resolves.toMatchObject({
      state: "uploading", receivedPartNumbers: [],
    });
    const firstPart = await firstPartBytes(sampleCount, 256 * 1024);
    const firstIdentity = identityOf(firstPart);
    await expect(port.uploadPart({
      sessionId: first.sessionId,
      credential,
      partNumber: 1,
      byteLength: firstIdentity.byteLength,
      sha256: firstIdentity.sha256,
      source: oneChunk(firstPart),
    })).resolves.toMatchObject({ outcome: "stored", partNumber: 1 });
    await expect(port.uploadPart({
      sessionId: first.sessionId,
      credential,
      partNumber: 1,
      byteLength: firstIdentity.byteLength,
      sha256: firstIdentity.sha256,
      source: oneChunk(firstPart),
    })).resolves.toMatchObject({ outcome: "duplicate", partNumber: 1 });
    await expect(port.uploadPart({
      sessionId: first.sessionId,
      credential,
      partNumber: 1,
      byteLength: firstIdentity.byteLength,
      sha256: sha256Text("different-part"),
      source: oneChunk(firstPart),
    })).rejects.toBeInstanceOf(ManagedUploadConflictError);

    const receipt = await port.uploadCanonicalTimeline({ credential, manifest, source: canonicalWav(sampleCount) });
    expect(receipt.manifest).toEqual(manifest);
    expect((await port.status({ sessionId: first.sessionId, credential })).receivedPartNumbers.length).toBeGreaterThan(100);
    await expect(port.complete({ sessionId: first.sessionId, credential, manifest })).resolves.toEqual(receipt);

    const restarted = new FileManagedUploadPort(path.join(root, "upload"), authenticator, {
      partSize: 256 * 1024,
      now: () => START,
    });
    await restarted.initialize();
    await expect(restarted.status({ sessionId: receipt.sessionId, credential })).resolves.toMatchObject({
      state: "completed", completedAt: START,
    });
    await expect(restarted.complete({ sessionId: receipt.sessionId, credential, manifest })).resolves.toEqual(receipt);
    await expect(restarted.complete({
      sessionId: receipt.sessionId,
      credential,
      manifest: { ...manifest, durationMs: manifest.durationMs + 1 },
    })).rejects.toBeInstanceOf(ManagedUploadConflictError);
    await expect(restarted.acknowledge({ credential, manifest })).resolves.toBe(true);
    await expect(restarted.acknowledge({ credential, manifest })).resolves.toBe(false);
    await expect(restarted.status({ sessionId: receipt.sessionId, credential })).rejects.toBeInstanceOf(ManagedUploadStateError);
    expect(await readdir(path.join(root, "upload", "parts"))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, "upload", "sessions.json"), "utf8"))).toEqual({ version: 1, sessions: [] });
  }, 30_000);

  test("requires host authentication, rejects caller audio overrides, and cancels idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-upload-boundary-"));
    roots.push(root);
    const authenticator = {
      authenticate: vi.fn(async () => ({ accountId: "account-a", deviceId: credential.deviceId })),
    };
    const port = new FileManagedUploadPort(path.join(root, "upload"), authenticator, { now: () => START, partSize: 64 });
    const inspected = await inspectCanonicalPcmWavStream(canonicalWav(16_000));
    const manifest: ManagedUploadManifest = {
      recordingId: "recording-cancel",
      audioId: "recording:recording-cancel",
      manifestSha256: sha256Text("cancel-manifest"),
      contentSha256: inspected.contentSha256,
      byteLength: inspected.byteLength,
      durationMs: inspected.durationMs,
    };
    await expect(port.begin({
      credential: { deviceId: "device-a", keyId: "key-a", hostProof: "" }, manifest,
    })).rejects.toBeInstanceOf(ManagedUploadAuthenticationError);
    await expect(port.begin({
      credential,
      manifest: { ...manifest, audioId: "client-selected-audio" },
    })).rejects.toThrow("caller overrides are rejected");

    const session = await port.begin({ credential, manifest });
    const bytes = Buffer.from("partial");
    const identity = identityOf(bytes);
    await port.uploadPart({
      sessionId: session.sessionId,
      credential,
      partNumber: 1,
      byteLength: identity.byteLength,
      sha256: identity.sha256,
      source: oneChunk(bytes),
    });
    await expect(port.cancel({ sessionId: session.sessionId, credential })).resolves.toMatchObject({
      state: "cancelled", receivedPartNumbers: [],
    });
    await expect(port.cancel({ sessionId: session.sessionId, credential })).resolves.toMatchObject({ state: "cancelled" });
    await expect(port.uploadPart({
      sessionId: session.sessionId,
      credential,
      partNumber: 1,
      byteLength: identity.byteLength,
      sha256: identity.sha256,
      source: oneChunk(bytes),
    })).rejects.toBeInstanceOf(ManagedUploadStateError);
    expect(await readdir(path.join(root, "upload", "parts"))).toEqual([]);
  });

  test("rejects malformed WAV bytes and false sample-count duration claims at completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-upload-invalid-"));
    roots.push(root);
    const authenticator = { authenticate: async () => ({ accountId: "account-a", deviceId: credential.deviceId }) };
    const port = new FileManagedUploadPort(path.join(root, "upload"), authenticator, { now: () => START, partSize: 128 });
    const malformed = Buffer.from("not-a-wav");
    const malformedIdentity = identityOf(malformed);
    const malformedManifest: ManagedUploadManifest = {
      recordingId: "recording-malformed",
      audioId: "recording:recording-malformed",
      manifestSha256: sha256Text("malformed-manifest"),
      contentSha256: malformedIdentity.sha256,
      byteLength: malformedIdentity.byteLength,
      durationMs: 1,
    };
    const malformedSession = await port.begin({ credential, manifest: malformedManifest });
    await port.uploadPart({
      sessionId: malformedSession.sessionId,
      credential,
      partNumber: 1,
      byteLength: malformedIdentity.byteLength,
      sha256: malformedIdentity.sha256,
      source: oneChunk(malformed),
    });
    await expect(port.complete({ sessionId: malformedSession.sessionId, credential, manifest: malformedManifest }))
      .rejects.toThrow("WAV container header");

    const inspected = await inspectCanonicalPcmWavStream(canonicalWav(16_000));
    const falseManifest: ManagedUploadManifest = {
      recordingId: "recording-false-duration",
      audioId: "recording:recording-false-duration",
      manifestSha256: sha256Text("false-duration-manifest"),
      contentSha256: inspected.contentSha256,
      byteLength: inspected.byteLength,
      durationMs: inspected.durationMs + 1,
    };
    const falseSession = await port.begin({ credential, manifest: falseManifest });
    await port.uploadCanonicalTimeline({ credential, manifest: falseManifest, source: canonicalWav(16_000) }).catch(() => undefined);
    await expect(port.complete({ sessionId: falseSession.sessionId, credential, manifest: falseManifest }))
      .rejects.toThrow("sample-count duration");
  });

  test("expires sessions and orphan part files at the durable restart sweep", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-upload-ttl-"));
    roots.push(root);
    let now = START;
    const authenticator = { authenticate: async () => ({ accountId: "account-a", deviceId: credential.deviceId }) };
    const port = new FileManagedUploadPort(path.join(root, "upload"), authenticator, { now: () => now, partSize: 64 });
    const inspected = await inspectCanonicalPcmWavStream(canonicalWav(16_000));
    const manifest: ManagedUploadManifest = {
      recordingId: "recording-ttl",
      audioId: "recording:recording-ttl",
      manifestSha256: sha256Text("ttl-manifest"),
      contentSha256: inspected.contentSha256,
      byteLength: inspected.byteLength,
      durationMs: inspected.durationMs,
    };
    const session = await port.begin({ credential, manifest });
    await mkdir(path.join(root, "upload", "parts"), { recursive: true });
    await writeFile(path.join(root, "upload", "parts", "orphan.tmp"), "orphan");
    now += MANAGED_TEMPORARY_DATA_TTL_MS + 1;
    const restarted = new FileManagedUploadPort(path.join(root, "upload"), authenticator, { now: () => now, partSize: 64 });
    await restarted.initialize();
    await expect(restarted.status({ sessionId: session.sessionId, credential })).rejects.toBeInstanceOf(ManagedUploadStateError);
    expect(await readdir(path.join(root, "upload", "parts"))).toEqual([]);
    expect(await restarted.cleanupExpired()).toBe(0);
  });

  test("copies a meeting-owned private timeline without expiry and deletes it through MeetingStore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-artifact-owner-"));
    roots.push(root);
    let now = START;
    const artifactRoot = path.join(root, "store", "managed-artifacts");
    const sourcePath = path.join(root, "source.wav");
    const bytes = wavBytes(16_000);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const sourceIdentity = identityOf(bytes);
    const sourceArtifact: ManagedCanonicalTimeline = {
      path: sourcePath,
      recordingId: "recording-owner",
      audioId: "recording:recording-owner",
      manifestSha256: sha256Text("owner-manifest"),
      identity: sourceIdentity,
      startMs: 0,
      endMs: 1_000,
      cleanup: async () => undefined,
    };
    const owner = new ManagedTimelineArtifactStore(artifactRoot, { now: () => now });
    await owner.accept(sourceArtifact, { meetingId: "meeting-owner" });
    const privateDirectory = owner.artifactDirectory(sourceArtifact.recordingId);
    expect((await stat(path.join(privateDirectory, "timeline.wav"))).isFile()).toBe(true);
    const metadata = JSON.parse(await readFile(path.join(privateDirectory, "metadata.json"), "utf8")) as {
      meetingId: string; createdAt: number; expiresAt: number;
    };
    expect(metadata).toMatchObject({ version: 3, meetingId: "meeting-owner", createdAt: START });
    expect(metadata).not.toHaveProperty("expiresAt");
    await rm(sourcePath);
    const rehydrated = new ManagedTimelineArtifactStore(artifactRoot, { now: () => now });
    await expect(rehydrated.get(sourceArtifact.recordingId)).resolves.toMatchObject({
      path: path.join(privateDirectory, "timeline.wav"),
      recordingId: sourceArtifact.recordingId,
    });

    const orphanDirectory = path.join(artifactRoot, "f".repeat(64));
    await mkdir(orphanDirectory, { recursive: true });
    await writeFile(path.join(orphanDirectory, "unexpected"), "orphan");
    expect(await rehydrated.sweep({ recordings: [{ id: sourceArtifact.recordingId, meetingId: "meeting-owner" }], meetingIds: ["meeting-owner"] })).toBe(1);
    now += MANAGED_TEMPORARY_DATA_TTL_MS + 1;
    expect(await rehydrated.sweep({ recordings: [{ id: sourceArtifact.recordingId, meetingId: "meeting-owner" }], meetingIds: ["meeting-owner"] })).toBe(0);
    const retained = await rehydrated.get(sourceArtifact.recordingId);
    await retained!.cleanup();
    expect(await readFile(retained!.path)).toEqual(bytes);

    const storeRoot = path.join(root, "delete-store");
    const exportRoot = path.join(root, "exports");
    const outputPath = path.join(exportRoot, "owner.mp3");
    const deletionStore = new MeetingStore({ root: storeRoot, approvedExportRoots: [exportRoot], now: () => new Date(now).toISOString() });
    await deletionStore.create({ id: "meeting-delete-owner", title: "Delete owner" });
    await deletionStore.startRecording({ id: "recording-delete-owner", meetingId: "meeting-delete-owner" });
    await deletionStore.prepareInventoryRecovery("recording-delete-owner", "closed");
    await deletionStore.markInventoryScanning("recording-delete-owner");
    const inventoryPath = path.join(storeRoot, "sessions", "recording-delete-owner", "inventory.ndjson");
    await mkdir(path.dirname(inventoryPath), { recursive: true, mode: 0o700 });
    await writeFile(inventoryPath, "{}\n", { mode: 0o600 });
    await deletionStore.publishInventory("recording-delete-owner", {
      storageKey: path.relative(storeRoot, inventoryPath),
      digest: "a".repeat(64), chunkCount: 1, microphoneCount: 1, systemCount: 0,
      publishedAt: new Date(now).toISOString(),
    });
    const output = Buffer.from("ID3-owner");
    await mkdir(exportRoot, { recursive: true });
    await writeFile(outputPath, output, { mode: 0o600 });
    const outputIdentity = identityOf(output);
    await deletionStore.beginFinalization("recording-delete-owner", {
      openChunksDurablyClosed: true, chunkSetDigest: "a".repeat(64), destination: outputPath, expectedIdentity: outputIdentity,
    });
    await deletionStore.markRecordingSaved("recording-delete-owner", { destination: outputPath, identity: outputIdentity, readable: true });
    const deletionArtifact = path.join(storeRoot, "managed-artifacts", sha256Text("recording-delete-owner"));
    await mkdir(deletionArtifact, { recursive: true });
    await writeFile(path.join(deletionArtifact, "timeline.wav"), bytes);
    const deletion = await deletionStore.deleteMeeting("meeting-delete-owner", {
      managedArtifactPaths: [{ recordingId: "recording-delete-owner", path: deletionArtifact }],
    });
    expect(deletion).toMatchObject({ outcome: "deleted" });
    await expect(stat(deletionArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await new MeetingStore({ root: storeRoot }).list()).toEqual([]);
  });

  test.each(["valid", "missing", "corrupt", "symlink"])("running-runtime deletion handles %s retained artifact metadata without a sweep", async (receiptState) => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-artifact-expiry-delete-"));
    roots.push(root);
    let now = START;
    const storeRoot = path.join(root, "store");
    const exportRoot = path.join(root, "exports");
    const meetingId = "meeting-expired-owner";
    const recordingId = "recording-expired-owner";
    const artifactRoot = path.join(storeRoot, "managed-artifacts");
    const sourcePath = path.join(root, "expired-source.wav");
    const bytes = wavBytes(16_000);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const owner = new ManagedTimelineArtifactStore(artifactRoot, { now: () => now });
    await owner.accept({
      path: sourcePath,
      recordingId,
      audioId: `recording:${recordingId}`,
      manifestSha256: sha256Text("expired-owner-manifest"),
      identity: identityOf(bytes),
      startMs: 0,
      endMs: 1_000,
      cleanup: async () => undefined,
    }, { meetingId });
    await rm(sourcePath);
    now += MANAGED_TEMPORARY_DATA_TTL_MS + 1;

    const store = new MeetingStore({
      root: storeRoot,
      approvedExportRoots: [exportRoot],
      now: () => new Date(now).toISOString(),
    });
    await store.create({ id: meetingId, title: "Expired artifact" });
    await store.startRecording({ id: recordingId, meetingId });
    await store.prepareInventoryRecovery(recordingId, "closed");
    await store.markInventoryScanning(recordingId);
    const inventoryPath = path.join(storeRoot, "sessions", recordingId, "inventory.ndjson");
    await mkdir(path.dirname(inventoryPath), { recursive: true, mode: 0o700 });
    await writeFile(inventoryPath, "{}\n", { mode: 0o600 });
    await store.publishInventory(recordingId, {
      storageKey: path.relative(storeRoot, inventoryPath),
      digest: "a".repeat(64),
      chunkCount: 1,
      microphoneCount: 1,
      systemCount: 0,
      publishedAt: new Date(now).toISOString(),
    });
    await mkdir(exportRoot, { recursive: true });
    const outputPath = path.join(exportRoot, "expired-owner.mp3");
    const output = Buffer.from("ID3-expired-owner");
    await writeFile(outputPath, output, { mode: 0o600 });
    const outputIdentity = identityOf(output);
    await store.beginFinalization(recordingId, {
      openChunksDurablyClosed: true,
      chunkSetDigest: "a".repeat(64),
      destination: outputPath,
      expectedIdentity: outputIdentity,
    });
    await store.markRecordingSaved(recordingId, { destination: outputPath, identity: outputIdentity, readable: true });

    const runtime = new RecordingService({
      storeRoot,
      helperPath: "/unused/helper",
      ffmpeg: "/unused/ffmpeg",
      ffprobe: "/unused/ffprobe",
      exportRoot,
      fixture: true,
      managedTimelineConsumer: owner,
    }, store);
    const foreign = path.join(root, "foreign");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "timeline.wav"), bytes);
    const metadataPath = path.join(owner.artifactDirectory(recordingId), "metadata.json");
    if (receiptState === "missing") await rm(metadataPath);
    if (receiptState === "corrupt") await writeFile(metadataPath, "{broken");
    if (receiptState === "symlink") {
      await rm(owner.artifactDirectory(recordingId), { recursive: true });
      await symlink(foreign, owner.artifactDirectory(recordingId));
    }
    const owned = await runtime.ownedManagedArtifactPaths(meetingId);
    expect(owned).toEqual([{ recordingId, path: owner.artifactDirectory(recordingId) }]);

    if (receiptState === "symlink") {
      await expect(store.deleteMeeting(meetingId, { managedArtifactPaths: owned })).rejects.toThrow("symlink");
      expect(await readFile(path.join(foreign, "timeline.wav"))).toEqual(bytes);
      expect(await readFile(outputPath)).toEqual(output);
      return;
    }
    const deletion = await store.deleteMeeting(meetingId, { managedArtifactPaths: owned });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(foreign, "timeline.wav"))).toEqual(bytes);
    expect(deletion).toMatchObject({ outcome: "deleted" });
    await expect(stat(owner.artifactDirectory(recordingId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list()).toEqual([]);
  });
});

async function* canonicalWav(sampleCount: number, chunkSize = 64 * 1024): AsyncIterable<Uint8Array> {
  yield wavHeader(sampleCount);
  let remaining = sampleCount * 2;
  let value = 0;
  while (remaining > 0) {
    const length = Math.min(remaining, chunkSize - (chunkSize % 2));
    const chunk = Buffer.alloc(length);
    for (let index = 0; index < chunk.length; index += 2) {
      chunk[index] = value & 0xff;
      chunk[index + 1] = (value >>> 8) & 0xff;
      value = (value + 1) & 0xffff;
    }
    yield chunk;
    remaining -= length;
  }
}

async function firstPartBytes(sampleCount: number, partSize: number): Promise<Buffer> {
  const source = canonicalWav(sampleCount);
  const bytes: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    const take = Math.min(partSize - length, chunk.byteLength);
    bytes.push(Buffer.from(chunk.subarray(0, take)));
    length += take;
    if (length === partSize) break;
  }
  return Buffer.concat(bytes, partSize);
}

function wavBytes(sampleCount: number): Buffer {
  const data = Buffer.alloc(sampleCount * 2);
  let value = 0;
  for (let index = 0; index < data.length; index += 2) {
    data[index] = value & 0xff;
    data[index + 1] = (value >>> 8) & 0xff;
    value = (value + 1) & 0xffff;
  }
  return Buffer.concat([wavHeader(sampleCount), data]);
}

function wavHeader(sampleCount: number): Buffer {
  const dataByteLength = sampleCount * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataByteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataByteLength, 40);
  return header;
}

function identityOf(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return { byteLength: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function writeSparseCanonicalWav(filePath: string, sampleCount: number): Promise<void> {
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.write(wavHeader(sampleCount), 0, 44, 0);
    await handle.truncate(44 + sampleCount * 2);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function containsAudioBytes(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsAudioBytes(item, seen));
  return Object.values(value).some((item) => containsAudioBytes(item, seen));
}
