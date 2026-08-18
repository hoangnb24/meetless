import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommittedRecordingChunk } from "@meetless/meeting-domain";

export interface CommittedChunkClaim {
  id: string;
  source: "microphone" | "system";
  path: string;
  byteLength: number;
  sha256: string;
  logicalStartMs: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: "wav";
}

export async function validateCommittedWavChunk(input: {
  filePath: string;
  sessionDirectory: string;
  storeRoot: string;
  claim?: CommittedChunkClaim;
  resolvedSessionDirectory?: string;
  resolvedStoreRoot?: string;
}): Promise<CommittedRecordingChunk> {
  const [candidate, sessionDirectory, storeRoot] = await Promise.all([
    realpath(input.filePath),
    input.resolvedSessionDirectory ?? realpath(input.sessionDirectory),
    input.resolvedStoreRoot ?? realpath(input.storeRoot),
  ]);
  const relativeToSession = path.relative(sessionDirectory, candidate);
  if (relativeToSession.startsWith("..") || path.isAbsolute(relativeToSession)) {
    throw new Error(`Committed chunk escapes its daemon-allocated session: ${candidate}`);
  }
  const relativeToStore = path.relative(storeRoot, candidate);
  if (relativeToStore.startsWith("..") || path.isAbsolute(relativeToStore)) {
    throw new Error(`Committed chunk escapes daemon recording storage: ${candidate}`);
  }

  const metadata = parseChunkFilename(path.basename(candidate));
  const candidateInfo = await lstat(candidate);
  if (!candidateInfo.isFile()) throw new Error(`Committed chunk is not a regular file: ${candidate}`);
  const handle = await open(candidate, "r");
  let data: Buffer;
  let info;
  try {
    info = await handle.stat();
    if (!info.isFile()) throw new Error(`Committed chunk is not a regular file: ${candidate}`);
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (info.size !== data.length) throw new Error(`Committed chunk changed while it was being validated: ${candidate}`);
  const wav = parsePcmWav(data, candidate);
  if (
    wav.sampleRate !== metadata.sampleRate || wav.channels !== metadata.channels ||
    wav.frameCount !== metadata.frameCount
  ) {
    throw new Error(`Committed WAV bytes do not match filename metadata: ${candidate}`);
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  const chunk: CommittedRecordingChunk = {
    id: metadata.id,
    source: metadata.source,
    storageKey: relativeToStore,
    byteLength: info.size,
    sha256,
    committedAt: info.mtime.toISOString(),
    logicalStartMs: Math.floor(metadata.startFrame * 1_000 / metadata.sampleRate),
    durationMs: Math.max(1, Math.floor(metadata.frameCount * 1_000 / metadata.sampleRate)),
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    format: "wav",
  };
  if (input.claim) assertClaimMatches(input.claim, await realpath(input.claim.path), candidate, chunk);
  return chunk;
}

function parseChunkFilename(name: string): {
  id: string;
  source: "microphone" | "system";
  startFrame: number;
  frameCount: number;
  sampleRate: number;
  channels: number;
} {
  const match = /^(chunk--(microphone|system)--\d{6}--(\d{12})--(\d{12})--(\d+)--(\d+))\.wav$/u.exec(name);
  if (!match) throw new Error(`Committed chunk filename is invalid: ${name}`);
  const values = match.slice(3).map(Number);
  if (!values.every(Number.isSafeInteger)) throw new Error(`Committed chunk filename metadata is unsafe: ${name}`);
  const [startFrame, frameCount, sampleRate, channels] = values as [number, number, number, number];
  if (startFrame < 0 || frameCount <= 0 || sampleRate <= 0 || channels <= 0) {
    throw new Error(`Committed chunk filename metadata is invalid: ${name}`);
  }
  return {
    id: match[1]!, source: match[2]! as "microphone" | "system",
    startFrame, frameCount, sampleRate, channels,
  };
}

function parsePcmWav(data: Buffer, filePath: string): { sampleRate: number; channels: number; frameCount: number } {
  if (
    data.length < 44 || data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WAVE" || data.readUInt32LE(4) + 8 !== data.length
  ) {
    throw new Error(`Committed chunk is not a complete RIFF/WAVE file: ${filePath}`);
  }
  let format: { sampleRate: number; channels: number; blockAlign: number } | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  for (; offset + 8 <= data.length;) {
    const kind = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`Committed WAV contains a truncated ${kind} chunk: ${filePath}`);
    if (kind === "fmt ") {
      if (format !== null) throw new Error(`Committed WAV contains multiple format chunks: ${filePath}`);
      if (size < 16) throw new Error(`Committed WAV has a truncated format chunk: ${filePath}`);
      const audioFormat = data.readUInt16LE(start);
      const channels = data.readUInt16LE(start + 2);
      const sampleRate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8);
      const blockAlign = data.readUInt16LE(start + 12);
      const bitsPerSample = data.readUInt16LE(start + 14);
      if (
        audioFormat !== 1 || channels <= 0 || sampleRate <= 0 || bitsPerSample !== 16 ||
        blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign
      ) {
        throw new Error(`Committed WAV must be 16-bit PCM with coherent format metadata: ${filePath}`);
      }
      format = { sampleRate, channels, blockAlign };
    } else if (kind === "data") {
      if (dataBytes !== null) throw new Error(`Committed WAV contains multiple data chunks: ${filePath}`);
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (offset !== data.length) throw new Error(`Committed WAV has trailing malformed bytes: ${filePath}`);
  if (!format || dataBytes === null || dataBytes <= 0 || dataBytes % format.blockAlign !== 0) {
    throw new Error(`Committed WAV has no complete aligned PCM payload: ${filePath}`);
  }
  return { sampleRate: format.sampleRate, channels: format.channels, frameCount: dataBytes / format.blockAlign };
}

function assertClaimMatches(
  claim: CommittedChunkClaim,
  claimedPath: string,
  candidate: string,
  chunk: CommittedRecordingChunk,
): void {
  const mismatches = [
    claimedPath === candidate,
    claim.id === chunk.id,
    claim.source === chunk.source,
    claim.byteLength === chunk.byteLength,
    claim.sha256 === chunk.sha256,
    claim.logicalStartMs === chunk.logicalStartMs,
    claim.durationMs === chunk.durationMs,
    claim.sampleRate === chunk.sampleRate,
    claim.channels === chunk.channels,
    claim.format === chunk.format,
  ];
  if (mismatches.some((matches) => !matches)) {
    throw new Error(`chunkCommitted event does not match validated WAV bytes and filename: ${candidate}`);
  }
}
