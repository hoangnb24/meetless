import { describe, expect, test, vi } from "vitest";
import { citationDataUrl, playCitationAudio } from "../src/playback";

const citation = {
  meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
  startMs: 2_000, endMs: 4_000, text: "hello",
  audio: { mimeType: "audio/mpeg" as const, base64: "AQID" },
};

describe("citation playback", () => {
  test("plays the bounded citation clip from zero without a renderer filesystem path", async () => {
    const audio = {
      readyState: 1, currentTime: 0, onloadedmetadata: null, onerror: null,
      play: vi.fn(async () => undefined), pause: vi.fn(),
    };
    const source = vi.fn(() => audio);
    const handle = await playCitationAudio(citation, source);

    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledWith("data:audio/mpeg;base64,AQID");
    handle.stop();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(citationDataUrl(citation)).not.toContain("file://");
  });

  test("rejects an unbounded citation interval", async () => {
    await expect(playCitationAudio({ ...citation, endMs: citation.startMs }, () => {
      throw new Error("must not create audio");
    })).rejects.toThrow(/not bounded/);
  });

  test("rejects malformed clip data before creating an audio element", async () => {
    await expect(playCitationAudio({ ...citation, audio: { ...citation.audio, base64: "../../etc/passwd" } }, () => {
      throw new Error("must not create audio");
    })).rejects.toThrow(/payload is invalid/);
  });
});
