import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CitationPlaybackService, FfmpegCitationClipEncoder } from "../src/citation-playback.js";

const execFileAsync = promisify(execFile);

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("bounded citation playback transport", () => {
  test("production encoder creates a short playable MP3 for the exact fixture range", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-citation-ffmpeg-"));
    roots.add(root);
    const fixture = path.resolve(import.meta.dirname, "../../../test/fixtures/m3/english.mp3");
    const encoder = new FfmpegCitationClipEncoder("ffmpeg", root);
    const clip = await encoder.encode(fixture, { startMs: 0, endMs: 1_000 });
    try {
      expect((await stat(clip.path)).size).toBeGreaterThan(1_000);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", clip.path,
      ]);
      expect(Number(stdout.trim())).toBeGreaterThanOrEqual(0.9);
      expect(Number(stdout.trim())).toBeLessThanOrEqual(1.2);
    } finally {
      await clip.cleanup();
    }
  });

  test("encodes only the authoritative known segment range and returns renderer-safe clip data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-citation-"));
    roots.add(root);
    const clipPath = path.join(root, "clip.mp3");
    await writeFile(clipPath, Buffer.from([1, 2, 3]));
    const resolveCitation = vi.fn(async (meetingId: string, segmentId: string) => {
      expect({ meetingId, segmentId }).toEqual({ meetingId: "m-1", segmentId: "segment-1" });
      return {
        meetingId, recordingId: "r-1", segmentId,
        audioPath: "/authoritative/saved-recording.mp3",
        audioIdentity: { byteLength: 128, sha256: "audio-sha" },
        startMs: 2_000, endMs: 4_000, text: "known evidence",
      };
    });
    const cleanup = vi.fn(async () => undefined);
    const sourceCleanup = vi.fn(async () => undefined);
    const createSnapshot = vi.fn(async () => ({ path: "/private/snapshots/verified.mp3", cleanup: sourceCleanup }));
    const encode = vi.fn(async () => ({ path: clipPath, cleanup }));
    const encoder = { initialize: async () => undefined, encode };
    const service = new CitationPlaybackService(
      { resolveCitation },
      encoder,
      {
        initialize: async () => undefined,
        create: createSnapshot,
      },
    );

    await expect(service.resolve({ meetingId: "m-1", segmentId: "segment-1" })).resolves.toEqual({
      meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
      startMs: 2_000, endMs: 4_000, text: "known evidence",
      audio: { mimeType: "audio/mpeg", base64: "AQID" },
    });
    expect(encode).toHaveBeenCalledWith(
      "/private/snapshots/verified.mp3",
      { startMs: 2_000, endMs: 4_000 },
    );
    expect(createSnapshot).toHaveBeenCalledWith(
      "/authoritative/saved-recording.mp3",
      { byteLength: 128, sha256: "audio-sha" },
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sourceCleanup).toHaveBeenCalledOnce();
  });

  test("unknown segment identity fails before any audio path is opened", async () => {
    const encode = vi.fn();
    const service = new CitationPlaybackService(
      { resolveCitation: vi.fn(async () => { throw new Error("Unknown transcript segment citation"); }) },
      { initialize: async () => undefined, encode },
      { initialize: async () => undefined, create: vi.fn() },
    );

    await expect(service.resolve({ meetingId: "m-1", segmentId: "../../etc/passwd" }))
      .rejects.toThrow(/Unknown transcript segment citation/);
    expect(encode).not.toHaveBeenCalled();
  });

  test("resolver identity substitution fails before encoding", async () => {
    const encode = vi.fn();
    const service = new CitationPlaybackService(
      { resolveCitation: vi.fn(async () => ({
        meetingId: "m-other", recordingId: "r-1", segmentId: "segment-other",
        audioPath: "/private/other.mp3", audioIdentity: { byteLength: 1, sha256: "other" },
        startMs: 0, endMs: 1_000, text: "other",
      })) },
      { initialize: async () => undefined, encode },
      { initialize: async () => undefined, create: vi.fn() },
    );

    await expect(service.resolve({ meetingId: "m-1", segmentId: "segment-1" }))
      .rejects.toThrow(/mismatched authoritative identity/);
    expect(encode).not.toHaveBeenCalled();
  });

  test("changed saved-audio bytes fail before clip encoding", async () => {
    const encode = vi.fn();
    const service = new CitationPlaybackService(
      { resolveCitation: vi.fn(async () => ({
        meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
        audioPath: "/private/recording.mp3", audioIdentity: { byteLength: 10, sha256: "expected" },
        startMs: 0, endMs: 1_000, text: "evidence",
      })) },
      { initialize: async () => undefined, encode },
      {
        initialize: async () => undefined,
        create: vi.fn(async () => { throw new Error("Saved MP3 identity changed before private snapshot"); }),
      },
    );

    await expect(service.resolve({ meetingId: "m-1", segmentId: "segment-1" }))
      .rejects.toThrow(/identity changed/);
    expect(encode).not.toHaveBeenCalled();
  });
});
