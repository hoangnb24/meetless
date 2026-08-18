import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CommittedRecordingChunk, RecordingInventoryPointer, RecordingSession } from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import { RecordingChunkWireSchema } from "@meetless/meeting-contracts";
import { z } from "zod";
import { validateCommittedWavChunk } from "./chunk-validator.js";

const execFileAsync = promisify(execFile);

interface InventoryLine extends CommittedRecordingChunk { sortKey: string }
const InventoryLineSchema = RecordingChunkWireSchema.extend({ sortKey: z.string().min(1) }).strict();

export interface InventoryReconcileHooks {
  afterValidated?(count: number): Promise<void> | void;
  afterSidecarPublished?(pointer: RecordingInventoryPointer): Promise<void> | void;
}

export class RecordingInventoryReconciler {
  constructor(
    private readonly storeRoot: string,
    private readonly store: MeetingStore,
    private readonly sortExecutable = "/usr/bin/sort",
  ) {}

  async reconcile(recordingInput: RecordingSession, options: {
    signal?: AbortSignal;
    hooks?: InventoryReconcileHooks;
  } = {}): Promise<RecordingInventoryPointer> {
    const recording = await this.store.markInventoryScanning(recordingInput.id);
    const sessionDirectory = path.join(this.storeRoot, "sessions", recording.id);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const token = `${process.pid}.${randomUUID()}`;
    const unsortedPath = path.join(sessionDirectory, `.inventory.${token}.candidate`);
    const sortedPath = path.join(sessionDirectory, `.inventory.${token}.sorted`);
    const known = new Map(recording.chunks.map((chunk) => [chunk.id, chunk]));
    const candidateHandle = await open(unsortedPath, "wx", 0o600);
    let buffered = "";
    let chunkCount = 0;
    let microphoneCount = 0;
    let systemCount = 0;
    try {
      const [resolvedSessionDirectory, resolvedStoreRoot] = await Promise.all([
        realpath(sessionDirectory), realpath(this.storeRoot),
      ]);
      const directory = await opendir(sessionDirectory);
      for await (const entry of directory) {
        throwIfAborted(options.signal);
        if (!entry.name.endsWith(".wav")) continue;
        const chunk = await validateCommittedWavChunk({
          filePath: path.join(sessionDirectory, entry.name), sessionDirectory, storeRoot: this.storeRoot,
          resolvedSessionDirectory, resolvedStoreRoot,
        });
        const expected = known.get(chunk.id);
        if (expected && !sameChunkIdentity(expected, chunk)) {
          throw new Error(`Known committed media changed identity: ${chunk.id}`);
        }
        known.delete(chunk.id);
        const line: InventoryLine = { sortKey: inventorySortKey(chunk), ...chunk };
        buffered += `${JSON.stringify(line)}\n`;
        if (buffered.length >= 1024 * 1024) {
          await candidateHandle.write(buffered);
          buffered = "";
        }
        chunkCount += 1;
        if (chunk.source === "microphone") microphoneCount += 1;
        else systemCount += 1;
        await options.hooks?.afterValidated?.(chunkCount);
      }
      if (known.size > 0) {
        throw new Error(`Previously committed media is missing: ${[...known.keys()].slice(0, 3).join(", ")}`);
      }
      if (chunkCount === 0) throw new Error("No readable committed WAV files survived inventory reconciliation");
      if (buffered) await candidateHandle.write(buffered);
      await candidateHandle.sync();
      await candidateHandle.close();
      throwIfAborted(options.signal);
      await execFileAsync(this.sortExecutable, ["-o", sortedPath, unsortedPath], {
        env: { PATH: process.env.PATH, LC_ALL: "C" }, timeout: 30 * 60_000, maxBuffer: 1024 * 1024,
        signal: options.signal,
      });
      await syncFile(sortedPath);
      const digest = await sha256File(sortedPath);
      const finalPath = path.join(sessionDirectory, `inventory-${digest}.ndjson`);
      try {
        await rename(sortedPath, finalPath);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        await rm(sortedPath, { force: true });
      }
      await syncDirectory(sessionDirectory);
      const pointer: RecordingInventoryPointer = {
        storageKey: path.relative(this.storeRoot, finalPath), digest, chunkCount,
        microphoneCount, systemCount, publishedAt: new Date().toISOString(),
      };
      await options.hooks?.afterSidecarPublished?.(pointer);
      throwIfAborted(options.signal);
      await this.store.publishInventory(recording.id, pointer);
      return pointer;
    } catch (error) {
      await candidateHandle.close().catch(() => undefined);
      if (!isAbort(error)) {
        await this.store.blockInventory(recording.id, describe(error)).catch(() => undefined);
      }
      throw error;
    } finally {
      await Promise.all([
        rm(unsortedPath, { force: true }).catch(() => undefined),
        rm(sortedPath, { force: true }).catch(() => undefined),
      ]);
    }
  }
}

export async function* readInventory(storeRoot: string, pointer: RecordingInventoryPointer): AsyncGenerator<CommittedRecordingChunk> {
  const filePath = resolveStorePath(storeRoot, pointer.storageKey);
  const actualDigest = createHash("sha256");
  const input = createReadStream(filePath);
  input.on("data", (data) => actualDigest.update(data));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  let microphoneCount = 0;
  let systemCount = 0;
  let previousSortKey = "";
  for await (const line of lines) {
    if (!line) continue;
    const { sortKey, ...chunk } = InventoryLineSchema.parse(JSON.parse(line));
    if (sortKey !== inventorySortKey(chunk) || (previousSortKey && sortKey < previousSortKey)) {
      throw new Error(`Inventory sidecar timeline order is invalid: ${pointer.storageKey}`);
    }
    previousSortKey = sortKey;
    count += 1;
    if (chunk.source === "microphone") microphoneCount += 1;
    else systemCount += 1;
    yield chunk;
  }
  if (count !== pointer.chunkCount || microphoneCount !== pointer.microphoneCount ||
      systemCount !== pointer.systemCount || actualDigest.digest("hex") !== pointer.digest) {
    throw new Error(`Inventory sidecar identity changed: ${pointer.storageKey}`);
  }
}

export function resolveStorePath(storeRoot: string, storageKey: string): string {
  const root = path.resolve(storeRoot);
  const candidate = path.resolve(root, storageKey);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Inventory path escapes MeetingStore: ${storageKey}`);
  return candidate;
}

function inventorySortKey(chunk: CommittedRecordingChunk): string {
  return `${chunk.source}:${String(chunk.logicalStartMs).padStart(16, "0")}:${chunk.id}`;
}

function sameChunkIdentity(left: CommittedRecordingChunk, right: CommittedRecordingChunk): boolean {
  return left.id === right.id && left.source === right.source && left.storageKey === right.storageKey &&
    left.byteLength === right.byteLength && left.sha256 === right.sha256 &&
    left.logicalStartMs === right.logicalStartMs && left.durationMs === right.durationMs &&
    left.sampleRate === right.sampleRate && left.channels === right.channels && left.format === right.format;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Inventory reconciliation cancelled", "AbortError");
}

function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
