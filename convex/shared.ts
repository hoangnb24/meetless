export const AUTHORITY = "docs/product/monetization.md; docs/decisions/0005-mac-app-store-and-revenuecat.md";
export const SAMPLE_RATE = 16_000;
export const MAX_PART_SAMPLES = 9_600_000;
export const MONTHLY_SECONDS = 180_000;
export const TRIAL_SECONDS = 18_000;
export const MAX_DEVICES = 3;
export const LEASE_MS = 6 * 60 * 60 * 1_000;
export const TEMPORARY_TTL_MS = 24 * 60 * 60 * 1_000;

export type UploadState = "uploading" | "sealed" | "cancelled" | "cleaned";
export type JobState =
  | "reserved"
  | "running"
  | "provider_completed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "stopped";

export interface PartDescriptor {
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface TimelineManifest {
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly partsManifestSha256: string;
  readonly parts: readonly PartDescriptor[];
}

export interface ProviderRange {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface ProviderResult {
  readonly text: string;
  readonly ranges: readonly ProviderRange[];
  readonly detectedLanguages: readonly string[];
}

export function normalizeManifest(input: TimelineManifest): TimelineManifest {
  const recordingId = nonEmpty(input.recordingId, "recording id");
  const audioId = nonEmpty(input.audioId, "audio id");
  if (audioId !== `recording:${recordingId}`) {
    fail("Managed upload audio identity is not recording-bound; caller overrides are rejected");
  }
  for (const [name, value] of [
    ["manifest", input.manifestSha256],
    ["content", input.contentSha256],
    ["parts manifest", input.partsManifestSha256],
  ] as const) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`Managed ${name} digest must be lowercase SHA-256`);
  }
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount <= 0) fail("Managed manifest sample count is invalid");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength !== 44 + input.sampleCount * 2) {
    fail("Managed manifest byte length does not match canonical PCM sample count");
  }
  const durationMs = Math.max(1, Math.ceil(input.sampleCount / SAMPLE_RATE * 1_000));
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs !== durationMs) {
    fail("Managed manifest duration must be derived from canonical PCM sample count");
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) fail("Managed manifest requires physical parts");
  let nextOffset = 0;
  const parts = input.parts.map((part, index) => {
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber !== index + 1) {
      fail("Managed parts must be ordered and numbered contiguously from one");
    }
    if (!Number.isSafeInteger(part.sampleOffset) || part.sampleOffset !== nextOffset) {
      fail("Managed parts must have contiguous sample offsets with no gaps or overlap");
    }
    if (!Number.isSafeInteger(part.sampleCount) || part.sampleCount <= 0 || part.sampleCount > MAX_PART_SAMPLES) {
      fail("Managed physical part exceeds the accepted ten-minute sample bound");
    }
    if (!Number.isSafeInteger(part.byteLength) || part.byteLength !== 44 + part.sampleCount * 2) {
      fail("Managed part byte length does not match its sample count");
    }
    if (typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(part.sha256)) {
      fail("Managed part digest must be lowercase SHA-256");
    }
    nextOffset += part.sampleCount;
    return { ...part };
  });
  if (nextOffset !== input.sampleCount) fail("Managed parts do not cover the logical timeline exactly once");
  return {
    ...input,
    recordingId,
    audioId,
    parts,
  };
}

export function partsDigestPayload(manifest: TimelineManifest): string {
  return JSON.stringify({
    version: 1,
    recordingId: manifest.recordingId,
    audioId: manifest.audioId,
    sampleCount: manifest.sampleCount,
    parts: manifest.parts.map((part) => ({
      partNumber: part.partNumber,
      sampleOffset: part.sampleOffset,
      sampleCount: part.sampleCount,
      byteLength: part.byteLength,
      sha256: part.sha256,
    })),
  });
}

export function canonicalWavHeader(sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

export function parseCanonicalPart(bytes: Uint8Array): { sampleCount: number; pcm: Uint8Array } {
  if (bytes.byteLength < 44) fail("Stored managed part is not a complete WAV");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") fail("Stored managed part is not a RIFF/WAVE container");
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) fail("Stored managed WAV container length is invalid");
  if (ascii(bytes, 12, 4) !== "fmt " || view.getUint32(16, true) !== 16) fail("Stored managed WAV fmt metadata is invalid");
  if (
    view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== SAMPLE_RATE || view.getUint32(28, true) !== SAMPLE_RATE * 2 ||
    view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || ascii(bytes, 36, 4) !== "data"
  ) fail("Stored managed WAV must be 16 kHz mono PCM16");
  const dataLength = view.getUint32(40, true);
  if (dataLength <= 0 || dataLength % 2 !== 0 || 44 + dataLength !== bytes.byteLength) fail("Stored managed WAV PCM payload is invalid");
  return { sampleCount: dataLength / 2, pcm: bytes.subarray(44) };
}

export function fail(message: string): never {
  throw new Error(`${message} (${AUTHORITY})`);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`Managed ${name} must be non-empty`);
  return value.trim();
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0);
  return value;
}
