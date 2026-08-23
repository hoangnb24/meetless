import { afterEach, describe, expect, test, vi } from "vitest";
import { Platform } from "react-native";
import { citationDataUrl, playCitationAudio } from "../src/playback";

const citation = {
  meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1",
  startMs: 2_000, endMs: 4_000, text: "hello",
  audio: { mimeType: "audio/mpeg" as const, base64: "AQID" },
};

const configureAudioSession = vi.fn(async () => undefined);

describe("citation playback", () => {
  afterEach(() => {
    Platform.OS = "web";
    configureAudioSession.mockClear();
    vi.useRealTimers();
  });
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

  test("settles browser playback as failed when media errors after start", async () => {
    const audio = {
      readyState: 1, currentTime: 0, onloadedmetadata: null, onerror: null,
      play: vi.fn(async () => undefined), pause: vi.fn(),
    };
    const onComplete = vi.fn();
    const onError = vi.fn();
    const handle = await playCitationAudio(citation, () => audio, undefined, { onComplete, onError });
    audio.onerror?.();
    audio.onerror?.();
    expect(onError).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalledOnce();
    handle.stop();
    expect(onError).toHaveBeenCalledOnce();
  });

  test("ignores a browser media error after the old selection is stopped", async () => {
    const audio = {
      readyState: 1, currentTime: 0, onloadedmetadata: null, onerror: null,
      play: vi.fn(async () => undefined), pause: vi.fn(),
    };
    const onError = vi.fn();
    const handle = await playCitationAudio(citation, () => audio, undefined, { onError });
    handle.stop();
    audio.onerror?.();
    expect(onError).not.toHaveBeenCalled();
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

  test("plays a bounded native MP3 and deletes temporary clip material on stop", async () => {
    Platform.OS = "ios";
    const remove = vi.fn();
    const pause = vi.fn();
    const deleteClip = vi.fn();
    const createTemporaryClip = vi.fn(async (_bytes, register) => {
      const clip = { uri: "file:///cache/cited.mp3", delete: deleteClip };
      register(clip);
      return clip;
    });
    const createPlayer = vi.fn(() => ({ play: vi.fn(), pause, remove }));
    const handle = await playCitationAudio(citation, undefined, { configureAudioSession, createTemporaryClip, createPlayer });

    expect(configureAudioSession).toHaveBeenCalledOnce();
    expect(createTemporaryClip.mock.calls[0]?.[0]).toEqual(Uint8Array.from([1, 2, 3]));
    expect(createPlayer).toHaveBeenCalledWith("file:///cache/cited.mp3");
    handle.stop();
    expect(pause).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(deleteClip).toHaveBeenCalledOnce();
  });

  test("cleans native clip material when player creation fails", async () => {
    Platform.OS = "ios";
    const deleteClip = vi.fn();
    await expect(playCitationAudio(citation, undefined, {
      configureAudioSession,
      createTemporaryClip: async (_bytes, register) => {
        const clip = { uri: "file:///cache/cited.mp3", delete: deleteClip };
        register(clip);
        return clip;
      },
      createPlayer: () => { throw new Error("native player failed"); },
    })).rejects.toThrow("native player failed");
    expect(deleteClip).toHaveBeenCalledOnce();
  });

  test("settles native playback as failed on a post-start player error", async () => {
    Platform.OS = "ios";
    const emitStatus: { current?: (status: unknown) => void } = {};
    const onComplete = vi.fn();
    const onError = vi.fn();
    const pause = vi.fn();
    const remove = vi.fn();
    const handle = await playCitationAudio(citation, undefined, {
      configureAudioSession,
      createTemporaryClip: async (_bytes, register) => {
        const clip = { uri: "file:///cache/cited.mp3", delete: vi.fn() };
        register(clip);
        return clip;
      },
      createPlayer: () => ({
        play: vi.fn(),
        pause,
        remove,
        addListener: (_event: "playbackStatusUpdate", listener: (status: unknown) => void) => {
          emitStatus.current = listener;
          return { remove: vi.fn() };
        },
      }),
    }, { onComplete, onError });
    emitStatus.current?.({ error: "native media failed" });
    emitStatus.current?.({ error: "native media failed again" });
    expect(onError).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    handle.stop();
    expect(pause).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  test("uses one cleanup guard for file creation and player play failures", async () => {
    Platform.OS = "ios";
    const deleteAfterCreateFailure = vi.fn();
    await expect(playCitationAudio(citation, undefined, {
      configureAudioSession,
      createTemporaryClip: async (_bytes, register) => {
        register({ uri: "file:///cache/partial.mp3", delete: deleteAfterCreateFailure });
        throw new Error("file write failed");
      },
      createPlayer: () => { throw new Error("must not create player"); },
    })).rejects.toThrow("file write failed");
    expect(deleteAfterCreateFailure).toHaveBeenCalledOnce();

    const deleteClip = vi.fn();
    const pause = vi.fn(() => { throw new Error("pause cleanup failed"); });
    const remove = vi.fn();
    await expect(playCitationAudio(citation, undefined, {
      configureAudioSession,
      createTemporaryClip: async (_bytes, register) => {
        const clip = { uri: "file:///cache/cited.mp3", delete: deleteClip };
        register(clip);
        return clip;
      },
      createPlayer: () => ({ play: () => { throw new Error("play failed"); }, pause, remove }),
    })).rejects.toThrow("play failed");
    expect(pause).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(deleteClip).toHaveBeenCalledOnce();
  });

  test("cleans native playback once on timeout and ignores a later cancel", async () => {
    Platform.OS = "ios";
    vi.useFakeTimers();
    const pause = vi.fn();
    const remove = vi.fn();
    const deleteClip = vi.fn();
    const handle = await playCitationAudio(citation, undefined, {
      configureAudioSession,
      createTemporaryClip: async (_bytes, register) => {
        const clip = { uri: "file:///cache/cited.mp3", delete: deleteClip };
        register(clip);
        return clip;
      },
      createPlayer: () => ({ play: vi.fn(), pause, remove }),
    });
    vi.advanceTimersByTime(2_000);
    handle.stop();
    expect(pause).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(deleteClip).toHaveBeenCalledOnce();
  });

  test("does not create clip material when native audio-session setup fails", async () => {
    Platform.OS = "ios";
    const createTemporaryClip = vi.fn();
    await expect(playCitationAudio(citation, undefined, {
      configureAudioSession: async () => { throw new Error("audio session failed"); },
      createTemporaryClip,
      createPlayer: vi.fn(),
    })).rejects.toThrow("audio session failed");
    expect(createTemporaryClip).not.toHaveBeenCalled();
  });
});
