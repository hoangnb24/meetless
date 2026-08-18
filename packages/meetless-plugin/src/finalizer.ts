import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommittedRecordingChunk, OutputIdentity, RecordingInventoryPointer } from "@meetless/meeting-domain";
import { readInventory, resolveStorePath } from "./inventory.js";

const execFileAsync = promisify(execFile);

export interface FinalizerConfig {
  ffmpeg: string;
  ffprobe: string;
  exportRoot: string;
  storeRoot: string;
  observeCommand?(executable: string, arguments_: readonly string[]): void;
}

export class Mp3Finalizer {
  constructor(readonly config: FinalizerConfig) {}

  async stage(recordingId: string, inventory: RecordingInventoryPointer): Promise<{
    stagePath: string;
    identity: OutputIdentity;
    timelineEvidence: Array<OutputIdentity & { source: string; frameCount: number }>;
  }> {
    if (inventory.chunkCount === 0) throw new Error("Cannot finalize without committed chunks");
    await mkdir(this.config.exportRoot, { recursive: true, mode: 0o700 });
    const stagePath = path.join(this.config.exportRoot, `.meetless-${recordingId}-${randomUUID()}.mp3.stage`);
    const timelineToken = randomUUID();
    const timelines = await this.stageSourceTimelines(recordingId, inventory, timelineToken);
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
    for (const timeline of timelines) args.push("-i", timeline.path);
    if (timelines.length === 2) {
      args.push("-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[mix]", "-map", "[mix]");
    } else {
      args.push("-map", "0:a");
    }
    args.push("-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2", "-f", "mp3", stagePath);
    try {
      this.config.observeCommand?.(this.config.ffmpeg, args);
      await execFileAsync(this.config.ffmpeg, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      const verification = await this.verify(stagePath);
      return {
        stagePath,
        identity: verification.identity,
        timelineEvidence: timelines.map(({ source, frameCount, identity }) => ({ source, frameCount, ...identity })),
      };
    } catch (error) {
      await rm(stagePath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await Promise.all(timelines.map((timeline) => rm(timeline.path, { force: true }).catch(() => undefined)));
    }
  }

  private async stageSourceTimelines(
    recordingId: string,
    inventory: RecordingInventoryPointer,
    token: string,
  ): Promise<Array<{ path: string; source: string; frameCount: number; identity: OutputIdentity }>> {
    const states = new Map<string, { path: string; handle: Awaited<ReturnType<typeof open>>; endFrame: number }>();
    try {
      for await (const chunk of readInventory(this.config.storeRoot, inventory)) {
        if (chunk.sampleRate !== 16_000 || chunk.channels !== 1 || chunk.format !== "wav") {
          throw new Error(`Finalizer requires validated 16 kHz mono PCM WAV: ${chunk.id}`);
        }
        let state = states.get(chunk.source);
        if (!state) {
          const timelinePath = path.join(this.config.exportRoot, `.meetless-${recordingId}-${token}-${chunk.source}.wav.stage`);
          const handle = await open(timelinePath, "wx", 0o600);
          await handle.write(Buffer.alloc(44), 0, 44, 0);
          state = { path: timelinePath, handle, endFrame: 0 };
          states.set(chunk.source, state);
        }
        const startFrame = chunkStartFrame(chunk.id);
        const frameCount = await this.copyVerifiedPcm(chunk, state.handle, 44 + startFrame * 2);
        state.endFrame = Math.max(state.endFrame, startFrame + frameCount);
      }
      for (const state of states.values()) {
        await state.handle.truncate(44 + state.endFrame * 2);
        await state.handle.write(wavHeader(state.endFrame), 0, 44, 0);
        await state.handle.sync();
      }
      return Promise.all([...states.entries()].map(async ([source, state]) => ({
        path: state.path,
        source,
        frameCount: state.endFrame,
        identity: await fileIdentity(state.path),
      })));
    } catch (error) {
      await Promise.all([...states.values()].map((state) => rm(state.path, { force: true }).catch(() => undefined)));
      throw error;
    } finally {
      await Promise.all([...states.values()].map((state) => state.handle.close().catch(() => undefined)));
    }
  }

  private async copyVerifiedPcm(
    chunk: CommittedRecordingChunk,
    target: Awaited<ReturnType<typeof open>>,
    targetPosition: number,
  ): Promise<number> {
    const sourcePath = this.resolveChunk(chunk).path;
    const source = await open(sourcePath, "r");
    try {
      const [initial, namedInitial] = await Promise.all([source.stat(), stat(sourcePath)]);
      if (!initial.isFile() || initial.size !== chunk.byteLength || !sameFile(initial, namedInitial)) {
        throw new Error(`Inventory WAV byte identity changed before finalization: ${chunk.id}`);
      }
      const pcm = await wavDataRange(source, initial.size, chunk.id);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < initial.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
        if (bytesRead === 0) throw new Error(`Inventory WAV became truncated during finalization: ${chunk.id}`);
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        const overlapStart = Math.max(position, pcm.start);
        const overlapEnd = Math.min(position + bytesRead, pcm.end);
        if (overlapStart < overlapEnd) {
          const payload = bytes.subarray(overlapStart - position, overlapEnd - position);
          await target.write(payload, 0, payload.length, targetPosition + overlapStart - pcm.start);
        }
        position += bytesRead;
      }
      const [final, namedFinal] = await Promise.all([source.stat(), stat(sourcePath)]);
      if (
        !sameStableFile(initial, final) || !sameFile(final, namedFinal) ||
        hash.digest("hex") !== chunk.sha256
      ) {
        throw new Error(`Inventory WAV byte identity changed before finalization: ${chunk.id}`);
      }
      return (pcm.end - pcm.start) / 2;
    } finally {
      await source.close();
    }
  }

  async verify(filePath: string): Promise<{ identity: OutputIdentity; durationSeconds: number }> {
    const { stdout } = await execFileAsync(
      this.config.ffprobe,
      ["-v", "error", "-show_entries", "format=duration,size,format_name:stream=codec_type,codec_name,sample_rate,channels", "-of", "json", filePath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const decoded = JSON.parse(stdout) as {
      format?: { duration?: string; size?: string; format_name?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string }>;
    };
    const durationSeconds = Number(decoded.format?.duration);
    if (
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !decoded.streams?.some((stream) => stream.codec_type === "audio" && stream.codec_name === "mp3")
    ) {
      throw new Error(`ffprobe rejected unreadable MP3 ${filePath}`);
    }
    return { identity: await fileIdentity(filePath), durationSeconds };
  }

  async publishNoReplace(stagePath: string, destination: string): Promise<void> {
    if (path.dirname(stagePath) !== path.dirname(destination)) {
      throw new Error("MP3 staging and publication must use the same destination filesystem directory");
    }
    await link(stagePath, destination);
    await rm(stagePath);
    await syncDirectory(path.dirname(destination));
  }

  async nextDestination(now = new Date(), startSuffix = 1): Promise<string> {
    await mkdir(this.config.exportRoot, { recursive: true, mode: 0o700 });
    const base = exportBaseName(now);
    for (let suffix = startSuffix; suffix < 10_000; suffix += 1) {
      const name = suffix === 1 ? `${base}.mp3` : `${base}-${suffix}.mp3`;
      const candidate = path.join(this.config.exportRoot, name);
      try { await access(candidate); } catch { return candidate; }
    }
    throw new Error("Could not allocate a collision-safe recording filename");
  }

  async prepareCollisionEvidence(input: {
    recordingId: string;
    runtimeInstanceId: string;
    now: Date;
  }): Promise<{
    path: string;
    byteLength: number;
    sha256: string;
    plannedPublishedPath: string;
    recordingId: string;
    runtimeInstanceId: string;
    exportRoot: string;
    exportStamp: string;
    preparedAt: string;
    validUntil: null;
  }> {
    const collisionPath = await this.nextDestination(input.now);
    const preparedAt = new Date().toISOString();
    const contents = Buffer.from(
      `Meetless pre-owner collision sentinel\nrecording=${input.recordingId}\nruntime=${input.runtimeInstanceId}\nexportStamp=${input.now.toISOString()}\nprepared=${preparedAt}\n`,
    );
    await writeFile(collisionPath, contents, { flag: "wx", mode: 0o600 });
    const handle = await open(collisionPath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(this.config.exportRoot);
    const identity = await fileIdentity(collisionPath);
    return {
      path: collisionPath,
      ...identity,
      plannedPublishedPath: await this.nextDestination(input.now),
      recordingId: input.recordingId,
      runtimeInstanceId: input.runtimeInstanceId,
      exportRoot: this.config.exportRoot,
      exportStamp: input.now.toISOString(),
      preparedAt,
      validUntil: null,
    };
  }

  private resolveChunk(chunk: CommittedRecordingChunk): { path: string } {
    const candidate = resolveStorePath(this.config.storeRoot, chunk.storageKey);
    const sessionsRoot = path.resolve(this.config.storeRoot, "sessions");
    const relative = path.relative(sessionsRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Chunk path escapes daemon recording storage: ${chunk.storageKey}`);
    }
    return { path: candidate };
  }
}

function chunkStartFrame(id: string): number {
  const match = /^chunk--(?:microphone|system)--\d{6}--(\d{12})--/u.exec(id);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Inventory chunk has invalid timeline identity: ${id}`);
  return value;
}

async function wavDataRange(
  handle: Awaited<ReturnType<typeof open>>,
  byteLength: number,
  id: string,
): Promise<{ start: number; end: number }> {
  const riff = await readExactly(handle, 12, 0, id);
  if (
    riff.subarray(0, 4).toString("ascii") !== "RIFF" ||
    riff.subarray(8, 12).toString("ascii") !== "WAVE" ||
    riff.readUInt32LE(4) + 8 !== byteLength
  ) throw new Error(`Inventory WAV lost its validated RIFF identity: ${id}`);
  let data: { start: number; end: number } | null = null;
  let offset = 12;
  while (offset + 8 <= byteLength) {
    const header = await readExactly(handle, 8, offset, id);
    const kind = header.subarray(0, 4).toString("ascii");
    const size = header.readUInt32LE(4);
    const start = offset + 8;
    const end = start + size;
    if (end > byteLength) throw new Error(`Inventory WAV contains a truncated ${kind} chunk: ${id}`);
    if (kind === "data") {
      if (data || size <= 0 || size % 2 !== 0) throw new Error(`Inventory WAV has invalid PCM payload: ${id}`);
      data = { start, end };
    }
    offset = end + (size % 2);
  }
  if (offset !== byteLength || !data) throw new Error(`Inventory WAV lost its PCM payload: ${id}`);
  return data;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
  id: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error(`Inventory WAV became truncated during finalization: ${id}`);
  return buffer;
}

function sameFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameStableFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function wavHeader(frameCount: number): Buffer {
  const dataBytes = frameCount * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function exportBaseName(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(now.getHours())}-${two(now.getDate())}-${two(now.getMonth() + 1)}-${two(now.getFullYear() % 100)}`;
}

export async function fileIdentity(filePath: string): Promise<OutputIdentity> {
  const before = await stat(filePath);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const data of createReadStream(filePath)) {
    hash.update(data as Buffer);
    byteLength += (data as Buffer).length;
  }
  const after = await stat(filePath);
  if (!sameStableFile(before, after) || byteLength !== after.size) {
    throw new Error(`File identity changed while hashing: ${filePath}`);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
