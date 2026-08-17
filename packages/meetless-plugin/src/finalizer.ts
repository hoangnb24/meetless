import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, link, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommittedRecordingChunk, OutputIdentity } from "@meetless/meeting-domain";

const execFileAsync = promisify(execFile);

export interface FinalizerConfig {
  ffmpeg: string;
  ffprobe: string;
  exportRoot: string;
  storeRoot: string;
}

export class Mp3Finalizer {
  constructor(readonly config: FinalizerConfig) {}

  async stage(recordingId: string, chunks: readonly CommittedRecordingChunk[]): Promise<{
    stagePath: string;
    identity: OutputIdentity;
  }> {
    if (chunks.length === 0) throw new Error("Cannot finalize without committed chunks");
    await mkdir(this.config.exportRoot, { recursive: true, mode: 0o700 });
    const stagePath = path.join(this.config.exportRoot, `.meetless-${recordingId}-${randomUUID()}.mp3.stage`);
    const inputs = chunks.map((chunk) => this.resolveChunk(chunk));
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
    for (const input of inputs) args.push("-i", input.path);
    const delayed = chunks.map((chunk, index) =>
      `[${index}:a]adelay=${chunk.logicalStartMs}:all=1[a${index}]`,
    );
    const labels = chunks.map((_, index) => `[a${index}]`).join("");
    const filter = `${delayed.join(";")};${labels}amix=inputs=${chunks.length}:duration=longest:normalize=0[mix]`;
    args.push("-filter_complex", filter, "-map", "[mix]", "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2", "-f", "mp3", stagePath);
    try {
      await execFileAsync(this.config.ffmpeg, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      const verification = await this.verify(stagePath);
      return { stagePath, identity: verification.identity };
    } catch (error) {
      await rm(stagePath, { force: true }).catch(() => undefined);
      throw error;
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
    const candidate = path.resolve(this.config.storeRoot, chunk.storageKey);
    const sessionsRoot = path.resolve(this.config.storeRoot, "sessions");
    const relative = path.relative(sessionsRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Chunk path escapes daemon recording storage: ${chunk.storageKey}`);
    }
    return { path: candidate };
  }
}

export function exportBaseName(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(now.getHours())}-${two(now.getDate())}-${two(now.getMonth() + 1)}-${two(now.getFullYear() % 100)}`;
}

export async function fileIdentity(filePath: string): Promise<OutputIdentity> {
  const data = await readFile(filePath);
  const info = await stat(filePath);
  return { byteLength: info.size, sha256: createHash("sha256").update(data).digest("hex") };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
