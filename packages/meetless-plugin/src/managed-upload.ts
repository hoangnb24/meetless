import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { MANAGED_TEMPORARY_DATA_TTL_MS } from "@meetless/managed-transcription-foundation";
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
