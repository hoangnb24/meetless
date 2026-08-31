import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MANAGED_TEMPORARY_DATA_TTL_MS } from "@meetless/managed-transcription-foundation";
import { MeetingStore } from "@meetless/meeting-store";
import {
  FileManagedUploadPort,
  ManagedUploadAuthenticationError,
  ManagedUploadConflictError,
  ManagedUploadStateError,
  inspectCanonicalPcmWavStream,
  type ManagedUploadCredential,
  type ManagedUploadManifest,
} from "../src/managed-upload.js";
import {
  ManagedTimelineArtifactStore,
  type ManagedCanonicalTimeline,
} from "../src/managed-transcription.js";

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

  test("copies a meeting-owned private timeline with a 24-hour receipt and deletes it through MeetingStore", async () => {
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
    expect(metadata).toMatchObject({ meetingId: "meeting-owner", createdAt: START, expiresAt: START + MANAGED_TEMPORARY_DATA_TTL_MS });
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
    expect(await rehydrated.sweep({ recordings: [{ id: sourceArtifact.recordingId, meetingId: "meeting-owner" }], meetingIds: ["meeting-owner"] })).toBe(1);
    await expect(rehydrated.get(sourceArtifact.recordingId)).resolves.toBeNull();

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
