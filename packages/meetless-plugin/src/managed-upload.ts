import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  MANAGED_MAX_UPLOAD_PART_SAMPLES,
  MANAGED_SAMPLE_RATE,
  MANAGED_TEMPORARY_DATA_TTL_MS,
  validateManagedLogicalTimelineManifest,
  type ManagedLogicalTimelineManifest,
} from "@meetless/managed-transcription-foundation";
import type { OutputIdentity } from "@meetless/meeting-domain";
import { z } from "zod";

/**
 * The host proves this credential at the edge. An App User ID or client
 * subscriber ID is deliberately not a field in this contract.
 */
export interface ManagedUploadCredential {
  readonly deviceId: string;
  readonly keyId: string;
  readonly hostProof: string;
}

export interface ManagedUploadPrincipal {
  readonly accountId: string;
  readonly deviceId: string;
}

export interface ManagedUploadAuthenticator {
  authenticate(credential: ManagedUploadCredential): Promise<ManagedUploadPrincipal>;
}

export interface ManagedUploadManifest {
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly durationMs: number;
}

export type ManagedUploadState = "uploading" | "completed" | "cancelled";

export interface ManagedUploadSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly manifest: ManagedUploadManifest;
  readonly state: ManagedUploadState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly receivedPartNumbers: number[];
  readonly completedAt: number | null;
}

export interface ManagedUploadReceipt {
  readonly sessionId: string;
  readonly uploadId: string;
  readonly manifest: ManagedUploadManifest;
  readonly completedAt: number;
}

export interface ManagedUploadPartResult {
  readonly sessionId: string;
  readonly partNumber: number;
  readonly outcome: "stored" | "duplicate";
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ManagedUploadPort {
  initialize(): Promise<void>;
  begin(input: {
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
  }): Promise<ManagedUploadSession>;
  uploadPart(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
    partNumber: number;
    byteLength: number;
    sha256: string;
    source: AsyncIterable<Uint8Array>;
  }): Promise<ManagedUploadPartResult>;
  complete(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
  }): Promise<ManagedUploadReceipt>;
  status(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
  }): Promise<ManagedUploadSession>;
  cancel(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
  }): Promise<ManagedUploadSession>;
  acknowledge(input: {
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
  }): Promise<boolean>;
  cleanupExpired(now?: number): Promise<number>;
  uploadCanonicalTimeline(input: {
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
    source: AsyncIterable<Uint8Array>;
  }): Promise<ManagedUploadReceipt>;
}

export class ManagedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedUploadError";
  }
}

export class ManagedUploadAuthenticationError extends ManagedUploadError {}
export class ManagedUploadConflictError extends ManagedUploadError {}
export class ManagedUploadStateError extends ManagedUploadError {}

const ManifestSchema = z.object({
  recordingId: z.string().trim().min(1),
  audioId: z.string().trim().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byteLength: z.number().int().positive(),
  durationMs: z.number().int().positive(),
}).strict();

const StoredPartSchema = z.object({
  partNumber: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const StoredReceiptSchema = z.object({
  sessionId: z.string().uuid(),
  uploadId: z.string().min(1),
  manifest: ManifestSchema,
  completedAt: z.number().int().nonnegative(),
}).strict();

const StoredSessionSchema = z.object({
  sessionId: z.string().uuid(),
  uploadKey: z.string().regex(/^[a-f0-9]{64}$/u),
  accountId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  manifest: ManifestSchema,
  state: z.enum(["uploading", "completed", "cancelled"]),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  parts: z.array(StoredPartSchema),
  receipt: StoredReceiptSchema.nullable(),
}).strict().superRefine((session, context) => {
  if (session.expiresAt <= session.createdAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Managed upload TTL must follow creation" });
  } else if (session.expiresAt !== session.createdAt + MANAGED_TEMPORARY_DATA_TTL_MS) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Managed upload TTL must be exactly 24 hours" });
  }
  if (session.state === "completed" && session.receipt === null) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Completed upload requires a durable receipt" });
  }
  if (session.state !== "completed" && session.receipt !== null) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Only completed upload may own a receipt" });
  }
  const numbers = new Set<number>();
  for (const [index, part] of session.parts.entries()) {
    if (numbers.has(part.partNumber)) {
      context.addIssue({ code: "custom", path: ["parts", index, "partNumber"], message: "Managed upload part numbers must be unique" });
    }
    numbers.add(part.partNumber);
  }
});

const SnapshotSchema = z.object({
  version: z.literal(1),
  sessions: z.array(StoredSessionSchema),
}).strict();

type StoredPart = z.infer<typeof StoredPartSchema>;
type StoredSession = z.infer<typeof StoredSessionSchema>;
type UploadSnapshot = z.infer<typeof SnapshotSchema>;

const EMPTY_SNAPSHOT: UploadSnapshot = { version: 1, sessions: [] };

/** Files are private temporary transport state, never MeetingStore truth. */
export class FileManagedUploadRepository {
  readonly statePath: string;
  readonly partsDirectory: string;

  constructor(readonly directory: string) {
    this.directory = path.resolve(directory);
    this.statePath = path.join(this.directory, "sessions.json");
    this.partsDirectory = path.join(this.directory, "parts");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.partsDirectory, { recursive: true, mode: 0o700 });
  }

  async load(): Promise<UploadSnapshot> {
    await this.initialize();
    try {
      return SnapshotSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return structuredClone(EMPTY_SNAPSHOT);
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ManagedUploadError(`Managed upload state is invalid at ${this.statePath}`);
      }
      throw error;
    }
  }

  async save(snapshot: UploadSnapshot): Promise<void> {
    const checked = SnapshotSchema.parse(snapshot);
    await this.initialize();
    const temporaryPath = path.join(this.directory, `.sessions.${process.pid}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.statePath);
      created = false;
      await syncDirectory(this.directory);
    } finally {
      if (created) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  partPath(sessionId: string, partNumber: number): string {
    return path.join(this.partsDirectory, `${sha256Text(sessionId)}-${String(partNumber).padStart(10, "0")}.part`);
  }

  temporaryPartPath(sessionId: string, partNumber: number): string {
    return `${this.partPath(sessionId, partNumber)}.${process.pid}.${randomUUID()}.tmp`;
  }

  async sweepUnreferencedParts(snapshot: UploadSnapshot): Promise<void> {
    const referenced = new Set<string>();
    for (const session of snapshot.sessions) {
      for (const part of session.parts) referenced.add(path.basename(this.partPath(session.sessionId, part.partNumber)));
    }
    let names: string[];
    try {
      names = await readdir(this.partsDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names) {
      if (!referenced.has(name)) await rm(path.join(this.partsDirectory, name), { force: true });
    }
    await syncDirectory(this.partsDirectory);
  }

  async readPart(sessionId: string, partNumber: number): Promise<AsyncIterable<Uint8Array>> {
    const partPath = this.partPath(sessionId, partNumber);
    await stat(partPath);
    return readFileChunks(partPath);
  }
}

export class FileManagedUploadPort implements ManagedUploadPort {
  private readonly repository: FileManagedUploadRepository;
  private readonly partSize: number;
  private readonly now: () => number;
  private snapshot: UploadSnapshot = structuredClone(EMPTY_SNAPSHOT);
  private initialized: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    directoryOrRepository: string | FileManagedUploadRepository,
    private readonly authenticator: ManagedUploadAuthenticator,
    options: { partSize?: number; now?: () => number } = {},
  ) {
    this.repository = typeof directoryOrRepository === "string"
      ? new FileManagedUploadRepository(directoryOrRepository)
      : directoryOrRepository;
    this.partSize = checkedPartSize(options.partSize ?? 1024 * 1024);
    this.now = options.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      this.snapshot = await this.repository.load();
      await this.cleanupExpiredInternal(this.now());
      await this.repository.sweepUnreferencedParts(this.snapshot);
    })();
    await this.initialized;
  }

  begin(input: {
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
  }): Promise<ManagedUploadSession> {
    return this.mutate(async () => {
      // A caller may resume after the 24-hour boundary without first asking
      // for status. Remove the expired session before idempotency lookup so a
      // new valid upload is not handed an unusable session object.
      await this.cleanupExpiredInternal(this.now());
      const manifest = normalizeManifest(input.manifest);
      const principal = await this.authenticate(input.credential);
      const uploadKey = makeUploadKey(principal.accountId, manifest);
      const timeline = this.snapshot.sessions.find((session) =>
        session.accountId === principal.accountId &&
        session.manifest.recordingId === manifest.recordingId &&
        session.manifest.audioId === manifest.audioId);
      if (timeline && !sameManifest(timeline.manifest, manifest)) {
        throw new ManagedUploadConflictError("Managed recording timeline is already bound to different bytes or manifest");
      }
      const existing = this.snapshot.sessions.find((session) => session.uploadKey === uploadKey);
      if (existing) {
        this.assertPrincipal(existing, principal);
        return publicSession(existing);
      }
      const createdAt = this.now();
      const session: StoredSession = {
        sessionId: randomUUID(),
        uploadKey,
        accountId: principal.accountId,
        deviceId: principal.deviceId,
        manifest,
        state: "uploading",
        createdAt,
        expiresAt: createdAt + MANAGED_TEMPORARY_DATA_TTL_MS,
        parts: [],
        receipt: null,
      };
      this.snapshot.sessions.push(session);
      await this.repository.save(this.snapshot);
      return publicSession(session);
    });
  }

  uploadPart(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
    partNumber: number;
    byteLength: number;
    sha256: string;
    source: AsyncIterable<Uint8Array>;
  }): Promise<ManagedUploadPartResult> {
    return this.mutate(async () => {
      const partNumber = checkedPartNumber(input.partNumber);
      const expectedLength = checkedPartLength(input.byteLength, this.partSize);
      const expectedSha = checkedSha256(input.sha256, "part sha256");
      const principal = await this.authenticate(input.credential);
      const session = this.requireSession(input.sessionId);
      this.assertPrincipal(session, principal);
      if (session.state === "cancelled") throw new ManagedUploadStateError("Managed upload is cancelled");
      const existing = session.parts.find((part) => part.partNumber === partNumber);
      if (existing) {
        if (existing.byteLength !== expectedLength || existing.sha256 !== expectedSha) {
          throw new ManagedUploadConflictError(`Managed upload part ${partNumber} changed identity`);
        }
        return { sessionId: session.sessionId, partNumber, outcome: "duplicate" as const, byteLength: existing.byteLength, sha256: existing.sha256 };
      }
      if (session.state === "completed") throw new ManagedUploadStateError("Managed upload is already completed");
      const partPath = this.repository.partPath(session.sessionId, partNumber);
      const temporaryPath = this.repository.temporaryPartPath(session.sessionId, partNumber);
      const identity = await writeBoundedPart(temporaryPath, input.source, expectedLength, expectedSha, this.partSize);
      let moved = false;
      try {
        await rename(temporaryPath, partPath);
        moved = true;
        const next: StoredPart = { partNumber, ...identity };
        session.parts.push(next);
        session.parts.sort((left, right) => left.partNumber - right.partNumber);
        await this.repository.save(this.snapshot);
        return { sessionId: session.sessionId, partNumber, outcome: "stored" as const, ...identity };
      } catch (error) {
        if (moved) await rm(partPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  complete(input: {
    sessionId: string;
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
  }): Promise<ManagedUploadReceipt> {
    return this.mutate(async () => {
      const manifest = normalizeManifest(input.manifest);
      const principal = await this.authenticate(input.credential);
      const session = this.requireSession(input.sessionId);
      this.assertPrincipal(session, principal);
      if (!sameManifest(session.manifest, manifest)) throw new ManagedUploadConflictError("Managed upload completion manifest changed");
      if (session.state === "cancelled") throw new ManagedUploadStateError("Managed upload is cancelled");
      if (session.receipt) return { ...session.receipt, manifest: { ...session.receipt.manifest } };
      const parts = [...session.parts].sort((left, right) => left.partNumber - right.partNumber);
      if (parts.length === 0 || parts.some((part, index) => part.partNumber !== index + 1)) {
        throw new ManagedUploadStateError("Managed upload completion requires contiguous parts starting at one");
      }
      const canonical = await inspectCanonicalPcmWavStream(this.readParts(session));
      if (
        canonical.byteLength !== manifest.byteLength ||
        canonical.contentSha256 !== manifest.contentSha256 ||
        canonical.durationMs !== manifest.durationMs
      ) {
        throw new ManagedUploadConflictError("Managed canonical WAV identity or sample-count duration does not match its manifest");
      }
      const completedAt = this.now();
      const receipt: ManagedUploadReceipt = {
        sessionId: session.sessionId,
        uploadId: session.sessionId,
        manifest: { ...manifest },
        completedAt,
      };
      session.state = "completed";
      session.receipt = receipt;
      await this.repository.save(this.snapshot);
      return { ...receipt, manifest: { ...receipt.manifest } };
    });
  }

  status(input: { sessionId: string; credential: ManagedUploadCredential }): Promise<ManagedUploadSession> {
    return this.read(async () => {
      const principal = await this.authenticate(input.credential);
      const session = this.requireSession(input.sessionId);
      this.assertPrincipal(session, principal);
      return publicSession(session);
    });
  }

  cancel(input: { sessionId: string; credential: ManagedUploadCredential }): Promise<ManagedUploadSession> {
    return this.mutate(async () => {
      const principal = await this.authenticate(input.credential);
      const session = this.requireSession(input.sessionId);
      this.assertPrincipal(session, principal);
      if (session.state === "completed") throw new ManagedUploadStateError("Completed managed upload is settled and cannot be cancelled");
      if (session.state === "cancelled") return publicSession(session);
      session.state = "cancelled";
      const parts = [...session.parts];
      session.parts = [];
      await this.repository.save(this.snapshot);
      await Promise.all(parts.map((part) => rm(this.repository.partPath(session.sessionId, part.partNumber), { force: true })));
      await syncDirectory(this.repository.partsDirectory);
      return publicSession(session);
    });
  }

  acknowledge(input: { credential: ManagedUploadCredential; manifest: ManagedUploadManifest }): Promise<boolean> {
    return this.mutate(async () => {
      const manifest = normalizeManifest(input.manifest);
      const principal = await this.authenticate(input.credential);
      const uploadKey = makeUploadKey(principal.accountId, manifest);
      const index = this.snapshot.sessions.findIndex((session) => session.uploadKey === uploadKey);
      if (index < 0) return false;
      const session = this.snapshot.sessions[index]!;
      this.assertPrincipal(session, principal);
      if (session.state !== "completed") return false;
      if (!sameManifest(session.manifest, manifest)) throw new ManagedUploadConflictError("Managed upload acknowledgement manifest changed");
      this.snapshot.sessions.splice(index, 1);
      await this.repository.save(this.snapshot);
      await Promise.all(session.parts.map((part) => rm(this.repository.partPath(session.sessionId, part.partNumber), { force: true })));
      await syncDirectory(this.repository.partsDirectory);
      return true;
    });
  }

  cleanupExpired(now = this.now()): Promise<number> {
    return this.mutate(() => this.cleanupExpiredInternal(now));
  }

  uploadCanonicalTimeline(input: {
    credential: ManagedUploadCredential;
    manifest: ManagedUploadManifest;
    source: AsyncIterable<Uint8Array>;
  }): Promise<ManagedUploadReceipt> {
    return (async () => {
      const session = await this.begin({ credential: input.credential, manifest: input.manifest });
      if (session.state === "cancelled") throw new ManagedUploadStateError("Managed upload is cancelled");
      if (session.state === "completed") {
        const receipt = await this.complete({ sessionId: session.sessionId, credential: input.credential, manifest: input.manifest });
        return receipt;
      }
      const partBufferSize = this.partSize;
      let part = Buffer.allocUnsafe(partBufferSize);
      let filled = 0;
      let partNumber = 1;
      for await (const chunk of input.source) {
        if (!(chunk instanceof Uint8Array)) throw new ManagedUploadError("Managed upload source yielded a non-byte value");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const copied = Math.min(partBufferSize - filled, chunk.byteLength - offset);
          part.set(chunk.subarray(offset, offset + copied), filled);
          filled += copied;
          offset += copied;
          if (filled === partBufferSize) {
            await this.uploadAccumulatedPart(input.credential, session.sessionId, partNumber, part.subarray(0, filled));
            partNumber += 1;
            part = Buffer.allocUnsafe(partBufferSize);
            filled = 0;
          }
        }
      }
      if (filled > 0) {
        await this.uploadAccumulatedPart(input.credential, session.sessionId, partNumber, part.subarray(0, filled));
      }
      return this.complete({ sessionId: session.sessionId, credential: input.credential, manifest: input.manifest });
    })();
  }

  private uploadAccumulatedPart(
    credential: ManagedUploadCredential,
    sessionId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<ManagedUploadPartResult> {
    return this.uploadPart({
      sessionId,
      credential,
      partNumber,
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      source: oneChunk(bytes),
    });
  }

  private readParts(session: StoredSession): AsyncIterable<Uint8Array> {
    const repository = this.repository;
    return (async function* () {
      for (const part of [...session.parts].sort((left, right) => left.partNumber - right.partNumber)) {
        for await (const chunk of readFileChunks(repository.partPath(session.sessionId, part.partNumber))) yield chunk;
      }
    })();
  }

  private async cleanupExpiredInternal(now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) throw new ManagedUploadError("Managed upload cleanup time must be a non-negative epoch millisecond");
    const expired = this.snapshot.sessions.filter((session) => session.expiresAt <= now);
    if (expired.length === 0) return 0;
    this.snapshot.sessions = this.snapshot.sessions.filter((session) => session.expiresAt > now);
    await this.repository.save(this.snapshot);
    await Promise.all(expired.flatMap((session) => session.parts.map((part) => rm(this.repository.partPath(session.sessionId, part.partNumber), { force: true }))));
    await syncDirectory(this.repository.partsDirectory);
    return expired.length;
  }

  private requireSession(sessionId: string): StoredSession {
    if (!/^[0-9a-f-]{36}$/u.test(sessionId)) throw new ManagedUploadStateError("Managed upload session identity is invalid");
    const session = this.snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new ManagedUploadStateError(`Managed upload session not found: ${sessionId}`);
    if (session.expiresAt <= this.now()) throw new ManagedUploadStateError("Managed upload session exceeded its 24-hour TTL");
    return session;
  }

  private assertPrincipal(session: StoredSession, principal: ManagedUploadPrincipal): void {
    if (session.accountId !== principal.accountId || session.deviceId !== principal.deviceId) {
      throw new ManagedUploadAuthenticationError("Managed upload credential is not authorized for this session");
    }
  }

  private async authenticate(credential: ManagedUploadCredential): Promise<ManagedUploadPrincipal> {
    if (!credential || !credential.deviceId?.trim() || !credential.keyId?.trim() || !credential.hostProof?.trim()) {
      throw new ManagedUploadAuthenticationError("Managed upload requires a host-authenticated device credential; App User ID is not accepted");
    }
    const principal = await this.authenticator.authenticate(credential);
    if (!principal?.accountId?.trim() || !principal.deviceId?.trim()) {
      throw new ManagedUploadAuthenticationError("Managed upload host authentication did not establish an account and device");
    }
    return { accountId: principal.accountId.trim(), deviceId: principal.deviceId.trim() };
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const next = this.mutationTail.then(operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    await this.mutationTail;
    return operation();
  }
}

function normalizeManifest(input: ManagedUploadManifest): ManagedUploadManifest {
  const manifest = ManifestSchema.parse(input);
  const expectedAudioId = `recording:${manifest.recordingId}`;
  if (manifest.audioId !== expectedAudioId) {
    throw new ManagedUploadConflictError("Managed upload audio identity is bound to its recording; caller overrides are rejected");
  }
  return { ...manifest };
}

function sameManifest(left: ManagedUploadManifest, right: ManagedUploadManifest): boolean {
  return left.recordingId === right.recordingId && left.audioId === right.audioId &&
    left.manifestSha256 === right.manifestSha256 && left.contentSha256 === right.contentSha256 &&
    left.byteLength === right.byteLength && left.durationMs === right.durationMs;
}

function makeUploadKey(accountId: string, manifest: ManagedUploadManifest): string {
  return sha256Text(JSON.stringify([
    accountId, manifest.recordingId, manifest.audioId, manifest.manifestSha256,
    manifest.contentSha256, manifest.byteLength, manifest.durationMs,
  ]));
}

function publicSession(session: StoredSession): ManagedUploadSession {
  return {
    sessionId: session.sessionId,
    accountId: session.accountId,
    deviceId: session.deviceId,
    manifest: { ...session.manifest },
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    receivedPartNumbers: session.parts.map((part) => part.partNumber).sort((left, right) => left - right),
    completedAt: session.receipt?.completedAt ?? null,
  };
}

async function writeBoundedPart(
  temporaryPath: string,
  source: AsyncIterable<Uint8Array>,
  expectedLength: number,
  expectedSha: string,
  maxLength: number,
): Promise<OutputIdentity> {
  const handle = await open(temporaryPath, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let completed = false;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new ManagedUploadError("Managed upload source yielded a non-byte value");
      byteLength += chunk.byteLength;
      if (byteLength > maxLength || byteLength > expectedLength) throw new ManagedUploadConflictError("Managed upload part exceeds its bounded transport size");
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    const sha256 = hash.digest("hex");
    if (byteLength !== expectedLength || sha256 !== expectedSha) {
      throw new ManagedUploadConflictError("Managed upload part byte identity does not match its declared identity");
    }
    completed = true;
    return { byteLength, sha256 };
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function checkedPartSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw new ManagedUploadError("Managed upload part size must be a positive bounded transport value");
  }
  return value;
}

function checkedPartNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ManagedUploadError("Managed upload part number must be positive");
  return value;
}

function checkedPartLength(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new ManagedUploadError("Managed upload part length exceeds its bounded transport size");
  return value;
}

function checkedSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new ManagedUploadError(`${field} must be a lowercase SHA-256 identity`);
  return value;
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function* readFileChunks(filePath: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) yield chunk as Buffer;
}

export interface ManagedCanonicalPcmWavStreamIdentity extends OutputIdentity {
  readonly contentSha256: string;
  readonly sampleCount: number;
  readonly durationSeconds: number;
  readonly durationMs: number;
}

/** Streaming edge validation for the canonical 16 kHz mono PCM WAV. */
export async function inspectCanonicalPcmWavStream(
  source: AsyncIterable<Uint8Array>,
): Promise<ManagedCanonicalPcmWavStreamIdentity> {
  const cursor = new ByteCursor(source);
  const riff = await cursor.read(12, "WAV container header is incomplete");
  if (ascii(riff, 0, 4) !== "RIFF" || ascii(riff, 8, 4) !== "WAVE") throw new ManagedUploadConflictError("Managed upload requires a RIFF/WAVE container");
  const containerEnd = 8 + riff.readUInt32LE(4);
  if (containerEnd < 44) throw new ManagedUploadConflictError("Managed upload WAV container is too small");
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | null = null;
  let dataByteLength: number | null = null;
  while (offset < containerEnd) {
    if (offset + 8 > containerEnd) throw new ManagedUploadConflictError("Managed upload WAV chunk header is truncated");
    const header = await cursor.read(8, "Managed upload WAV chunk header is truncated");
    const kind = ascii(header, 0, 4);
    const size = header.readUInt32LE(4);
    const payloadEnd = offset + 8 + size;
    const paddedEnd = payloadEnd + (size % 2);
    if (payloadEnd > containerEnd || paddedEnd > containerEnd) throw new ManagedUploadConflictError("Managed upload WAV chunk exceeds its RIFF container");
    if (kind === "fmt ") {
      if (format || size < 16) throw new ManagedUploadConflictError("Managed upload WAV has an invalid fmt chunk");
      const fmt = await cursor.read(16, "Managed upload WAV fmt chunk is incomplete");
      format = {
        audioFormat: fmt.readUInt16LE(0), channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4),
        byteRate: fmt.readUInt32LE(8), blockAlign: fmt.readUInt16LE(12), bitsPerSample: fmt.readUInt16LE(14),
      };
      await cursor.skip(size - 16, "Managed upload WAV fmt chunk is truncated");
    } else if (kind === "data") {
      if (dataByteLength !== null) throw new ManagedUploadConflictError("Managed upload WAV contains more than one data timeline");
      dataByteLength = size;
      await cursor.skip(size, "Managed upload WAV data is truncated");
    } else {
      await cursor.skip(size, `Managed upload WAV ${kind} chunk is truncated`);
    }
    if (size % 2) await cursor.skip(1, "Managed upload WAV padding is truncated");
    offset = paddedEnd;
  }
  if (offset !== containerEnd) throw new ManagedUploadConflictError("Managed upload WAV RIFF size is inconsistent");
  if (await cursor.hasMore()) throw new ManagedUploadConflictError("Managed upload WAV has bytes beyond its RIFF container");
  if (!format || dataByteLength === null) throw new ManagedUploadConflictError("Managed upload WAV requires one fmt and one data chunk");
  if (
    format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 ||
    format.byteRate !== 32_000 || format.blockAlign !== 2 || format.bitsPerSample !== 16
  ) throw new ManagedUploadConflictError("Managed upload WAV must be 16 kHz, mono, 16-bit PCM");
  if (dataByteLength <= 0 || dataByteLength % 2 !== 0) throw new ManagedUploadConflictError("Managed upload WAV data does not contain complete PCM samples");
  const sampleCount = dataByteLength / 2;
  const durationSeconds = sampleCount / 16_000;
  return {
    byteLength: cursor.total,
    sha256: cursor.digest,
    contentSha256: cursor.digest,
    sampleCount,
    durationSeconds,
    durationMs: Math.max(1, Math.ceil(durationSeconds * 1_000)),
  };
}

class ByteCursor {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;
  private readonly hash = createHash("sha256");
  total = 0;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  get digest(): string {
    return this.hash.copy().digest("hex");
  }

  async read(length: number, message: string): Promise<Buffer> {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffer.length) await this.pull(message);
      if (this.ended) throw new ManagedUploadConflictError(message);
      const copied = Math.min(length - written, this.buffer.length - this.offset);
      this.buffer.copy(result, written, this.offset, this.offset + copied);
      this.offset += copied;
      written += copied;
    }
    return result;
  }

  async skip(length: number, message: string): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.buffer.length) await this.pull(message);
      if (this.ended) throw new ManagedUploadConflictError(message);
      const skipped = Math.min(remaining, this.buffer.length - this.offset);
      this.offset += skipped;
      remaining -= skipped;
    }
  }

  async hasMore(): Promise<boolean> {
    if (this.offset < this.buffer.length) return true;
    if (this.ended) return false;
    await this.pull("Managed upload WAV stream ended unexpectedly");
    return !this.ended && this.offset < this.buffer.length;
  }

  private async pull(message: string): Promise<void> {
    while (!this.ended && this.offset >= this.buffer.length) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return;
      }
      if (!(next.value instanceof Uint8Array)) throw new ManagedUploadConflictError(message);
      if (next.value.byteLength === 0) continue;
      this.hash.update(next.value);
      this.total += next.value.byteLength;
      this.buffer = Buffer.from(next.value);
      this.offset = 0;
    }
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Auth for the Convex adapter is the host-issued access token itself. It is
 * installed on the client and is never sent as a mutation/action argument.
 * The server derives account and device ownership from this identity.
 */
export interface ManagedConvexCredential {
  readonly authToken: string;
}

export interface ManagedConvexFunctionClient {
  setAuth?(token: string): void;
  mutation(functionName: string, args: Record<string, unknown>): Promise<unknown>;
  query(functionName: string, args: Record<string, unknown>): Promise<unknown>;
  action(functionName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ManagedConvexPendingPart {
  readonly sessionId: string;
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storageId: string;
}

export interface ManagedConvexUploadJournal {
  pending(sessionId: string): Promise<readonly ManagedConvexPendingPart[]>;
  record(part: ManagedConvexPendingPart): Promise<void>;
  remove(sessionId: string, partNumber: number): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

const PendingConvexPartSchema = z.object({
  sessionId: z.string().min(1),
  partNumber: z.number().int().positive(),
  sampleOffset: z.number().int().nonnegative(),
  sampleCount: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  storageId: z.string().min(1),
}).strict();

const PendingConvexSnapshotSchema = z.object({
  version: z.literal(1),
  parts: z.array(PendingConvexPartSchema),
}).strict();

type PendingConvexSnapshot = z.infer<typeof PendingConvexSnapshotSchema>;

/**
 * Durable client receipt for the POST/register ambiguity. It contains no
 * audio bytes: a restarted adapter can register a storage ID that was already
 * returned by Convex without uploading the bounded part again.
 */
export class FileManagedConvexUploadJournal implements ManagedConvexUploadJournal {
  private readonly statePath: string;
  private initialized: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {
    this.directory = path.resolve(directory);
    this.statePath = path.join(this.directory, "pending-parts.json");
  }

  pending(sessionId: string): Promise<readonly ManagedConvexPendingPart[]> {
    return this.read(async () => (await this.loadSnapshot()).parts
      .filter((part) => part.sessionId === sessionId)
      .map((part) => ({ ...part })));
  }

  record(part: ManagedConvexPendingPart): Promise<void> {
    return this.mutate(async () => {
      const checked = PendingConvexPartSchema.parse(part);
      const snapshot = await this.loadSnapshot();
      const existing = snapshot.parts.find((candidate) =>
        candidate.sessionId === checked.sessionId && candidate.partNumber === checked.partNumber);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(checked)) {
          throw new ManagedUploadConflictError("Managed Convex upload journal rebound a part to a different storage identity");
        }
        return;
      }
      snapshot.parts.push(checked);
      await this.saveSnapshot(snapshot);
    });
  }

  remove(sessionId: string, partNumber: number): Promise<void> {
    return this.mutate(async () => {
      const snapshot = await this.loadSnapshot();
      const next = snapshot.parts.filter((part) => part.sessionId !== sessionId || part.partNumber !== partNumber);
      if (next.length !== snapshot.parts.length) await this.saveSnapshot({ version: 1, parts: next });
    });
  }

  clear(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      const snapshot = await this.loadSnapshot();
      const next = snapshot.parts.filter((part) => part.sessionId !== sessionId);
      if (next.length !== snapshot.parts.length) await this.saveSnapshot({ version: 1, parts: next });
    });
  }

  private async initialize(): Promise<void> {
    this.initialized ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.initialized;
  }

  private async loadSnapshot(): Promise<PendingConvexSnapshot> {
    await this.initialize();
    try {
      return PendingConvexSnapshotSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { version: 1, parts: [] };
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ManagedUploadError(`Managed Convex upload journal is invalid at ${this.statePath}`);
      }
      throw error;
    }
  }

  private async saveSnapshot(snapshot: PendingConvexSnapshot): Promise<void> {
    const checked = PendingConvexSnapshotSchema.parse(snapshot);
    await this.initialize();
    const temporaryPath = path.join(this.directory, `.pending-parts.${process.pid}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.statePath);
      created = false;
      await syncDirectory(this.directory);
    } finally {
      if (created) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const next = this.mutationTail.then(operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    await this.mutationTail;
    return operation();
  }
}

export interface ManagedConvexJob {
  readonly _id: string;
  readonly uploadId: string;
  readonly recordingId: string;
  readonly audioId: string;
  readonly admissionId: string;
  readonly admissionNumber: number;
  readonly status: string;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly billableSeconds: number;
  readonly providerResult: {
    readonly text: string;
    readonly ranges: readonly { startMs: number; endMs: number; text: string }[];
    readonly detectedLanguages: readonly string[];
  } | null;
  readonly [key: string]: unknown;
}

export interface ManagedConvexUploadSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly receivedPartNumbers: readonly number[];
  readonly completedAt: number | null;
  readonly jobId: string | null;
}

export interface ManagedConvexUploadResult {
  readonly session: ManagedConvexUploadSession;
  readonly job: ManagedConvexJob;
  readonly manifest: ManagedLogicalTimelineManifest;
}

export interface ManagedConvexUploadFunctionNames {
  readonly begin: string;
  readonly generateUploadUrl: string;
  readonly registerPart: string;
  readonly status: string;
  readonly cancel: string;
  readonly seal: string;
  readonly runProvider: string;
  readonly settle: string;
  readonly jobStatus: string;
  readonly acknowledge: string;
}

const DEFAULT_CONVEX_FUNCTIONS: ManagedConvexUploadFunctionNames = {
  begin: "managedTranscription:beginUpload",
  generateUploadUrl: "managedTranscription:generateUploadUrl",
  registerPart: "managedTranscription:registerPart",
  status: "managedTranscription:status",
  cancel: "managedTranscription:cancelUpload",
  seal: "managedTranscriptionActions:sealUpload",
  runProvider: "managedTranscriptionActions:runProvider",
  settle: "managedTranscription:settleJob",
  jobStatus: "managedTranscription:jobStatus",
  acknowledge: "managedTranscriptionActions:acknowledge",
};

/**
 * Region-neutral desktop adapter for the Convex generated-upload-url flow.
 * Convex owns the session/job state; this adapter owns only bounded local
 * reads and direct POSTs to the generated storage URL.
 */
export class ConvexManagedUploadPort {
  private readonly functions: ManagedConvexUploadFunctionNames;
  private readonly post: typeof fetch;

  constructor(
    private readonly client: ManagedConvexFunctionClient,
    options: {
      journal: ManagedConvexUploadJournal;
      functions?: Partial<ManagedConvexUploadFunctionNames>;
      fetch?: typeof fetch;
    },
  ) {
    if (!options.journal) throw new ManagedUploadError("Managed Convex upload requires a durable POST/register journal");
    this.functions = { ...DEFAULT_CONVEX_FUNCTIONS, ...options.functions };
    this.post = options.fetch ?? globalThis.fetch;
    this.journal = options.journal;
  }

  private readonly journal: ManagedConvexUploadJournal;

  async begin(input: {
    credential: ManagedConvexCredential;
    manifest: ManagedLogicalTimelineManifest;
  }): Promise<ManagedConvexUploadSession> {
    this.authenticate(input.credential);
    const manifest = validateManagedLogicalTimelineManifest(input.manifest);
    return parseConvexSession(await this.client.mutation(this.functions.begin, { manifest }));
  }

  async status(input: {
    credential: ManagedConvexCredential;
    sessionId: string;
  }): Promise<ManagedConvexUploadSession> {
    this.authenticate(input.credential);
    return parseConvexSession(await this.client.query(this.functions.status, { sessionId: input.sessionId }));
  }

  async cancel(input: {
    credential: ManagedConvexCredential;
    sessionId: string;
  }): Promise<ManagedConvexUploadSession> {
    this.authenticate(input.credential);
    const session = parseConvexSession(await this.client.mutation(this.functions.cancel, { sessionId: input.sessionId }));
    await this.journal.clear(session.sessionId);
    return session;
  }

  async uploadCanonicalTimelineFromPath(input: {
    credential: ManagedConvexCredential;
    manifest: ManagedLogicalTimelineManifest;
    sourcePath: string;
  }): Promise<ManagedConvexUploadResult> {
    const manifest = validateManagedLogicalTimelineManifest(input.manifest);
    let session = await this.begin({ credential: input.credential, manifest });
    if (session.state === "cancelled") throw new ManagedUploadStateError("Managed Convex upload is cancelled");
    if (session.state === "cleaned") {
      await this.journal.clear(session.sessionId);
      if (!session.jobId) throw new ManagedUploadStateError("Managed Convex upload temporary state was cleaned before admission");
      return {
        session,
        job: await this.jobStatus({ credential: input.credential, jobId: session.jobId }),
        manifest,
      };
    }
    if (session.state === "uploading") {
      await this.recoverPendingParts(input.credential, session, manifest);
      session = await this.status({ credential: input.credential, sessionId: session.sessionId });
      const received = new Set(session.receivedPartNumbers);
      for (const part of manifest.parts) {
        if (received.has(part.partNumber)) continue;
        const uploadUrl = await this.generatedUploadUrl(input.credential, session.sessionId);
        const storageId = await this.postBoundedPart(uploadUrl, canonicalPartChunks(input.sourcePath, part.sampleOffset, part.sampleCount));
        await this.journal.record({
          sessionId: session.sessionId,
          partNumber: part.partNumber,
          sampleOffset: part.sampleOffset,
          sampleCount: part.sampleCount,
          byteLength: part.byteLength,
          sha256: part.sha256,
          storageId,
        });
        await this.registerPart(input.credential, session.sessionId, part, storageId);
        await this.journal.remove(session.sessionId, part.partNumber);
      }
      session = await this.status({ credential: input.credential, sessionId: session.sessionId });
    }
    if (session.state !== "uploading" && session.state !== "sealed") {
      throw new ManagedUploadStateError(`Managed Convex upload is ${session.state} before seal`);
    }
    const job = parseConvexJob(await this.client.action(this.functions.seal, { sessionId: session.sessionId }));
    // The seal action owns the uploading -> sealed transition. Re-read the
    // session so a caller that persists this receipt never mistakes an
    // admitted upload for an upload that is still accepting parts.
    session = await this.status({ credential: input.credential, sessionId: session.sessionId });
    return { session, job, manifest };
  }

  private async recoverPendingParts(
    credential: ManagedConvexCredential,
    session: ManagedConvexUploadSession,
    manifest: ManagedLogicalTimelineManifest,
  ): Promise<void> {
    for (const pending of await this.journal.pending(session.sessionId)) {
      const expected = manifest.parts[pending.partNumber - 1];
      if (!expected || expected.partNumber !== pending.partNumber || expected.sampleOffset !== pending.sampleOffset ||
        expected.sampleCount !== pending.sampleCount || expected.byteLength !== pending.byteLength || expected.sha256 !== pending.sha256) {
        throw new ManagedUploadConflictError(`Managed Convex upload journal part ${pending.partNumber} does not match its immutable manifest`);
      }
      if (session.receivedPartNumbers.includes(pending.partNumber)) {
        await this.journal.remove(session.sessionId, pending.partNumber);
        continue;
      }
      await this.registerPart(credential, session.sessionId, expected, pending.storageId);
      await this.journal.remove(session.sessionId, pending.partNumber);
    }
  }

  async runProvider(input: {
    credential: ManagedConvexCredential;
    jobId: string;
  }): Promise<ManagedConvexJob> {
    this.authenticate(input.credential);
    return parseConvexJob(await this.client.action(this.functions.runProvider, { jobId: input.jobId }));
  }

  async settle(input: {
    credential: ManagedConvexCredential;
    jobId: string;
  }): Promise<ManagedConvexJob> {
    this.authenticate(input.credential);
    return parseConvexJob(await this.client.mutation(this.functions.settle, { jobId: input.jobId }));
  }

  async jobStatus(input: {
    credential: ManagedConvexCredential;
    jobId: string;
  }): Promise<ManagedConvexJob> {
    this.authenticate(input.credential);
    return parseConvexJob(await this.client.query(this.functions.jobStatus, { jobId: input.jobId }));
  }

  async acknowledge(input: {
    credential: ManagedConvexCredential;
    jobId: string;
  }): Promise<boolean> {
    this.authenticate(input.credential);
    const result = await this.client.action(this.functions.acknowledge, { jobId: input.jobId });
    if (result !== true) throw new ManagedUploadStateError("Managed Convex acknowledgement did not complete");
    return true;
  }

  private async generatedUploadUrl(credential: ManagedConvexCredential, sessionId: string): Promise<string> {
    this.authenticate(credential);
    const value = await this.client.mutation(this.functions.generateUploadUrl, { sessionId });
    if (typeof value !== "string" || value.length === 0) throw new ManagedUploadError("Convex did not return a generated upload URL");
    return value;
  }

  private async registerPart(
    credential: ManagedConvexCredential,
    sessionId: string,
    part: ManagedLogicalTimelineManifest["parts"][number],
    storageId: string,
  ): Promise<void> {
    this.authenticate(credential);
    await this.client.mutation(this.functions.registerPart, {
      sessionId,
      partNumber: part.partNumber,
      sampleOffset: part.sampleOffset,
      sampleCount: part.sampleCount,
      byteLength: part.byteLength,
      sha256: part.sha256,
      storageId,
    });
  }

  private async postBoundedPart(url: string, source: AsyncIterable<Uint8Array>): Promise<string> {
    const readable = Readable.from(source);
    const response = await this.post(url, {
      method: "POST",
      body: Readable.toWeb(readable) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new ManagedUploadError(`Convex generated upload URL rejected a part (${response.status})`);
    const payload: unknown = await response.json();
    const storageId = isRecord(payload) ? payload.storageId : undefined;
    if (typeof storageId !== "string" || storageId.length === 0) throw new ManagedUploadError("Convex upload response did not contain a storage ID");
    return storageId;
  }

  private authenticate(credential: ManagedConvexCredential): void {
    if (!credential || typeof credential.authToken !== "string" || credential.authToken.trim().length === 0) {
      throw new ManagedUploadAuthenticationError("Managed Convex upload requires a host-issued access token; client subscriber identity is not accepted");
    }
    this.client.setAuth?.(credential.authToken);
  }
}

/**
 * Optional concrete client for desktop/runtime composition. Generated
 * function names remain in the adapter, while the Convex SDK stays outside
 * policy and MeetingStore.
 */
export class ConvexHttpManagedFunctionClient implements ManagedConvexFunctionClient {
  private readonly client: ConvexHttpClient;

  constructor(address: string, options: { authToken?: string } = {}) {
    this.client = new ConvexHttpClient(address, { logger: false });
    if (options.authToken) this.client.setAuth(options.authToken);
  }

  setAuth(token: string): void { this.client.setAuth(token); }

  mutation(functionName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.client.mutation(makeFunctionReference<"mutation", Record<string, unknown>>(functionName), args as never);
  }

  query(functionName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.client.query(makeFunctionReference<"query", Record<string, unknown>>(functionName), args as never);
  }

  action(functionName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.client.action(makeFunctionReference<"action", Record<string, unknown>>(functionName), args as never);
  }
}

function parseConvexSession(value: unknown): ManagedConvexUploadSession {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.accountId !== "string" || typeof value.deviceId !== "string" || typeof value.state !== "string" || typeof value.createdAt !== "number" || typeof value.expiresAt !== "number" || !Array.isArray(value.receivedPartNumbers) || !value.receivedPartNumbers.every((part) => typeof part === "number") || (value.completedAt !== null && typeof value.completedAt !== "number") || (value.jobId !== null && typeof value.jobId !== "string")) {
    throw new ManagedUploadError("Convex managed upload session response is invalid");
  }
  return {
    sessionId: value.sessionId,
    accountId: value.accountId,
    deviceId: value.deviceId,
    state: value.state,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    receivedPartNumbers: [...value.receivedPartNumbers],
    completedAt: value.completedAt,
    jobId: value.jobId,
  };
}

function parseConvexJob(value: unknown): ManagedConvexJob {
  if (!isRecord(value) || typeof value._id !== "string" || typeof value.uploadId !== "string" || typeof value.recordingId !== "string" || typeof value.audioId !== "string" || typeof value.admissionId !== "string" || typeof value.admissionNumber !== "number" || typeof value.status !== "string" || typeof value.durationMs !== "number" || typeof value.sampleCount !== "number" || typeof value.billableSeconds !== "number" || (value.providerResult !== null && !isRecord(value.providerResult))) {
    throw new ManagedUploadError("Convex managed job response is invalid");
  }
  return value as unknown as ManagedConvexJob;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

export async function buildManagedLogicalTimelineManifest(input: {
  recordingId: string;
  manifestSha256: string;
  sourcePath: string;
}): Promise<ManagedLogicalTimelineManifest> {
  const inspected = await inspectCanonicalPcmWavFile(input.sourcePath);
  const parts: Array<ManagedLogicalTimelineManifest["parts"][number]> = [];
  for (let offset = 0; offset < inspected.sampleCount;) {
    const sampleCount = Math.min(MANAGED_MAX_UPLOAD_PART_SAMPLES, inspected.sampleCount - offset);
    const identity = await identityOfStream(canonicalPartChunks(input.sourcePath, offset, sampleCount));
    parts.push({
      partNumber: parts.length + 1,
      sampleOffset: offset,
      sampleCount,
      byteLength: identity.byteLength,
      sha256: identity.sha256,
    });
    offset += sampleCount;
  }
  const partsManifestSha256 = sha256Text(JSON.stringify({
    version: 1,
    recordingId: input.recordingId,
    audioId: `recording:${input.recordingId}`,
    sampleCount: inspected.sampleCount,
    parts,
  }));
  return validateManagedLogicalTimelineManifest({
    recordingId: input.recordingId,
    audioId: `recording:${input.recordingId}`,
    manifestSha256: input.manifestSha256,
    contentSha256: inspected.contentSha256,
    byteLength: inspected.byteLength,
    durationMs: inspected.durationMs,
    sampleCount: inspected.sampleCount,
    partsManifestSha256,
    parts,
  });
}

async function identityOfStream(source: AsyncIterable<Uint8Array>): Promise<OutputIdentity> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new ManagedUploadError("Managed canonical part source yielded a non-byte value");
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { byteLength, sha256: hash.digest("hex") };
}

interface CanonicalWavFileLayout {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly dataOffset: number;
  readonly dataByteLength: number;
}

/**
 * FFmpeg may add a metadata chunk before `data`. The durable recording is
 * still a valid canonical PCM WAV, but transport parts deliberately normalize
 * to a 44-byte header plus the validated PCM samples. This pass reads only
 * chunk headers and hashes PCM incrementally.
 */
async function inspectCanonicalPcmWavFile(filePath: string): Promise<CanonicalWavFileLayout> {
  const handle = await open(filePath, "r");
  try {
    const file = await handle.stat();
    const riff = await readFileRange(handle, 12, 0, "Managed canonical WAV header is incomplete");
    if (ascii(riff, 0, 4) !== "RIFF" || ascii(riff, 8, 4) !== "WAVE") {
      throw new ManagedUploadConflictError("Managed canonical timeline requires a RIFF/WAVE container");
    }
    const containerEnd = 8 + riff.readUInt32LE(4);
    if (containerEnd !== file.size || containerEnd < 44) {
      throw new ManagedUploadConflictError("Managed canonical WAV container length is inconsistent");
    }
    let offset = 12;
    let format: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | null = null;
    let dataOffset: number | null = null;
    let dataByteLength: number | null = null;
    while (offset < containerEnd) {
      if (offset + 8 > containerEnd) throw new ManagedUploadConflictError("Managed canonical WAV chunk header is truncated");
      const chunk = await readFileRange(handle, 8, offset, "Managed canonical WAV chunk header is truncated");
      const kind = ascii(chunk, 0, 4);
      const size = chunk.readUInt32LE(4);
      const payloadEnd = offset + 8 + size;
      const paddedEnd = payloadEnd + (size % 2);
      if (payloadEnd > containerEnd || paddedEnd > containerEnd) {
        throw new ManagedUploadConflictError(`Managed canonical WAV ${kind} chunk exceeds its RIFF container`);
      }
      if (kind === "fmt ") {
        if (format || size < 16) throw new ManagedUploadConflictError("Managed canonical WAV has an invalid fmt chunk");
        const fmt = await readFileRange(handle, 16, offset + 8, "Managed canonical WAV fmt metadata is incomplete");
        format = {
          audioFormat: fmt.readUInt16LE(0), channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4),
          byteRate: fmt.readUInt32LE(8), blockAlign: fmt.readUInt16LE(12), bitsPerSample: fmt.readUInt16LE(14),
        };
      } else if (kind === "data") {
        if (dataOffset !== null) throw new ManagedUploadConflictError("Managed canonical WAV contains more than one PCM data timeline");
        dataOffset = offset + 8;
        dataByteLength = size;
      }
      offset = paddedEnd;
    }
    if (offset !== containerEnd || !format || dataOffset === null || dataByteLength === null) {
      throw new ManagedUploadConflictError("Managed canonical WAV requires one fmt and one data chunk");
    }
    if (
      format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== MANAGED_SAMPLE_RATE ||
      format.byteRate !== MANAGED_SAMPLE_RATE * 2 || format.blockAlign !== 2 || format.bitsPerSample !== 16
    ) throw new ManagedUploadConflictError("Managed canonical WAV must be 16 kHz, mono, 16-bit PCM");
    if (dataByteLength <= 0 || dataByteLength % 2 !== 0) {
      throw new ManagedUploadConflictError("Managed canonical WAV data does not contain complete PCM samples");
    }
    const sampleCount = dataByteLength / 2;
    const hash = createHash("sha256");
    hash.update(canonicalWavHeader(sampleCount));
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = dataByteLength;
    let position = dataOffset;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position);
      if (bytesRead === 0) throw new ManagedUploadConflictError("Managed canonical WAV PCM data is truncated");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    const final = await handle.stat();
    if (!sameStableFile(file, final)) throw new ManagedUploadConflictError("Managed canonical WAV changed while its PCM identity was derived");
    return {
      sampleCount,
      durationMs: Math.max(1, Math.ceil(sampleCount / MANAGED_SAMPLE_RATE * 1_000)),
      byteLength: 44 + dataByteLength,
      contentSha256: hash.digest("hex"),
      dataOffset,
      dataByteLength,
    };
  } finally {
    await handle.close();
  }
}

async function* canonicalPartChunks(filePath: string, sampleOffset: number, sampleCount: number): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(sampleOffset) || sampleOffset < 0 || !Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > MANAGED_MAX_UPLOAD_PART_SAMPLES) {
    throw new ManagedUploadConflictError("Managed canonical part boundaries are invalid");
  }
  const handle = await open(filePath, "r");
  try {
    const initial = await handle.stat();
    const layout = await inspectCanonicalPcmWavFile(filePath);
    if (sampleOffset + sampleCount > layout.sampleCount) {
      throw new ManagedUploadConflictError("Managed canonical part exceeds the validated PCM timeline");
    }
    yield canonicalWavHeader(sampleCount);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = sampleCount * 2;
    let position = layout.dataOffset + sampleOffset * 2;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position);
      if (bytesRead === 0) throw new ManagedUploadConflictError("Managed canonical WAV became truncated while segmenting");
      yield buffer.subarray(0, bytesRead);
      position += bytesRead;
      remaining -= bytesRead;
    }
    const final = await handle.stat();
    if (!sameStableFile(initial, final)) throw new ManagedUploadConflictError("Managed canonical WAV changed while a transport part was read");
  } finally {
    await handle.close();
  }
}

async function readFileRange(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
  message: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new ManagedUploadConflictError(message);
  return buffer;
}

function canonicalWavHeader(sampleCount: number): Buffer {
  const dataBytes = sampleCount * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MANAGED_SAMPLE_RATE, 24); header.writeUInt32LE(MANAGED_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function sameStableFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
