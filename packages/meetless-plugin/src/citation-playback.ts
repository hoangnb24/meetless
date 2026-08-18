import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { TranscriptCitation } from "@meetless/meeting-domain";
import type { AudioSnapshotStore } from "./private-audio-snapshot.js";
import { sweepOwnedAudioCandidates } from "./private-audio-snapshot.js";

const execFileAsync = promisify(execFile);
const MAXIMUM_CITATION_CLIP_BYTES = 2_000_000;

export interface CitationResolver {
  resolveCitation(meetingId: string, segmentId: string): Promise<TranscriptCitation>;
}

export interface CitationClipEncoder {
  initialize(): Promise<void>;
  encode(audioPath: string, range: { startMs: number; endMs: number }): Promise<{
    path: string;
    cleanup(): Promise<void>;
  }>;
}

export class FfmpegCitationClipEncoder implements CitationClipEncoder {
  private initialization: Promise<void> | null = null;
  constructor(
    private readonly ffmpeg: string,
    private readonly stagingDirectory: string,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= sweepOwnedAudioCandidates(this.stagingDirectory, /^[0-9a-f-]{36}\.mp3$/);
    return this.initialization;
  }

  async encode(audioPath: string, range: { startMs: number; endMs: number }) {
    await this.initialize();
    const target = path.join(this.stagingDirectory, `${randomUUID()}.mp3`);
    try {
      await execFileAsync(this.ffmpeg, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", audioPath,
        "-ss", String(range.startMs / 1_000),
        "-t", String((range.endMs - range.startMs) / 1_000),
        "-vn", "-ar", "16000", "-ac", "1",
        "-codec:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", target,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      return { path: target, cleanup: () => rm(target, { force: true }) };
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export class CitationPlaybackService {
  constructor(
    private readonly resolver: CitationResolver,
    private readonly encoder: CitationClipEncoder,
    private readonly sourceSnapshots: AudioSnapshotStore,
  ) {}

  async resolve(input: { meetingId: string; segmentId: string }) {
    await Promise.all([this.sourceSnapshots.initialize(), this.encoder.initialize()]);
    const citation = await this.resolver.resolveCitation(input.meetingId, input.segmentId);
    if (citation.meetingId !== input.meetingId || citation.segmentId !== input.segmentId) {
      throw new Error("Citation resolver returned a mismatched authoritative identity");
    }
    const sourceSnapshot = await this.sourceSnapshots.create(citation.audioPath, citation.audioIdentity);
    try {
      const clip = await this.encoder.encode(sourceSnapshot.path, {
        startMs: citation.startMs,
        endMs: citation.endMs,
      });
      try {
        const bytes = await readBoundedRegularFile(clip.path, MAXIMUM_CITATION_CLIP_BYTES);
        return {
          meetingId: citation.meetingId,
          recordingId: citation.recordingId,
          segmentId: citation.segmentId,
          startMs: citation.startMs,
          endMs: citation.endMs,
          text: citation.text,
          audio: { mimeType: "audio/mpeg" as const, base64: bytes.toString("base64") },
        };
      } finally {
        await clip.cleanup().catch(() => undefined);
      }
    } finally {
      await sourceSnapshot.cleanup().catch(() => undefined);
    }
  }
}

async function readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size <= 0 || stats.size > maximumBytes) {
      throw new Error("Citation clip must be a bounded regular file");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size) throw new Error("Citation clip changed while being read");
    return bytes;
  } finally {
    await handle.close();
  }
}
