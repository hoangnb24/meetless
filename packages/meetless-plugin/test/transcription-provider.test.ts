import { describe, expect, test, vi } from "vitest";
import {
  NativeOpenAiTranscriptionProvider,
  OPENAI_TRANSCRIPTION_ENDPOINT,
  OPENAI_TRANSCRIPTION_LANGUAGES,
  OPENAI_TRANSCRIPTION_MODEL,
  type NativeTranscriptionResponse,
  type NativeTranscriptionTransport,
} from "../src/transcription-provider.js";

const range = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-a" };
const audioIdentity = { byteLength: 128, sha256: "a".repeat(64) };

function response(overrides: Partial<NativeTranscriptionResponse> = {}): NativeTranscriptionResponse {
  return {
    version: 1, requestId: "native-request", ok: true, status: "configured",
    text: "hello xin chào", detectedLanguages: ["en", "vi"],
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, durationSeconds: 1 },
    ...overrides,
  };
}

describe("native OpenAI transcription boundary", () => {
  test("keeps the official endpoint/model/language contract at the signed-host edge", async () => {
    expect(OPENAI_TRANSCRIPTION_ENDPOINT).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(OPENAI_TRANSCRIPTION_MODEL).toBe("gpt-transcribe");
    expect(OPENAI_TRANSCRIPTION_LANGUAGES).toEqual(["en", "vi"]);

    const request = vi.fn(async (input) => input.operation === "status"
      ? response({ requestId: "status", text: undefined, usage: undefined, detectedLanguages: undefined })
      : response({ requestId: "transcribe" }));
    const transport: NativeTranscriptionTransport = { request };
    const provider = new NativeOpenAiTranscriptionProvider(transport);

    await expect(provider.status()).resolves.toBe("configured");
    await expect(provider.transcribe({ recordingId: "r-1", audioPath: "/tmp/range.mp3", audioIdentity, range })).resolves.toEqual({
      text: "hello xin chào", detectedLanguages: ["en", "vi"],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, durationSeconds: 1 },
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "transcribe", recordingId: "r-1", audioPath: "/tmp/range.mp3",
      audioByteLength: 128, audioSha256: "a".repeat(64), range,
    });
  });

  test("redacts injected native/provider failures", async () => {
    const secret = "sk-test-never-crosses-the-boundary";
    const transport: NativeTranscriptionTransport = {
      request: vi.fn(async () => { throw new Error(secret); }),
    };
    const provider = new NativeOpenAiTranscriptionProvider(transport);

    await expect(provider.status()).resolves.toBe("invalid");
    const failure = await provider.transcribe({ recordingId: "r-1", audioPath: "/tmp/range.mp3", audioIdentity, range })
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("Native transcription request failed");
    expect(String(failure)).not.toContain(secret);
  });

  test("normalizes native authentication rejection without provider details", async () => {
    const transport: NativeTranscriptionTransport = {
      request: vi.fn(async (input) => response({
        requestId: input.operation,
        ok: false,
        status: "invalid",
        text: undefined,
        detectedLanguages: undefined,
        usage: undefined,
        error: "transcription unavailable",
      })),
    };
    const provider = new NativeOpenAiTranscriptionProvider(transport);

    await expect(provider.status()).resolves.toBe("invalid");
    await expect(provider.transcribe({ recordingId: "r-1", audioPath: "/tmp/range.mp3", audioIdentity, range }))
      .rejects.toThrow("Native transcription request failed");
  });

  test("retries only transient native authorization startup and remains bounded", async () => {
    const delays: number[] = [];
    const request = vi.fn(async () => {
      if (request.mock.calls.length < 3) throw new Error("runtime PID not published yet");
      return response({ requestId: "ready" });
    });
    const provider = new NativeOpenAiTranscriptionProvider(
      { request },
      { readinessAttempts: 3, readinessDelayMs: 7, readinessRequestTimeoutMs: 50, delay: async (ms) => { delays.push(ms); } },
    );

    await expect(provider.status()).resolves.toBe("configured");
    expect(request).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([7, 7]);

    const neverReady = vi.fn(() => new Promise<NativeTranscriptionResponse>(() => undefined));
    const bounded = new NativeOpenAiTranscriptionProvider(
      { request: neverReady },
      { readinessAttempts: 2, readinessDelayMs: 0, readinessRequestTimeoutMs: 5, delay: async () => undefined },
    );
    await expect(bounded.status()).resolves.toBe("invalid");
    expect(neverReady).toHaveBeenCalledTimes(2);
  });

  test.each(["missing", "invalid"] as const)("surfaces configured credential state %s without readiness retries", async (status) => {
    const request = vi.fn(async () => response({
      requestId: "credential-status", ok: true, status,
      text: undefined, detectedLanguages: undefined, usage: undefined,
    }));
    const delay = vi.fn(async () => undefined);
    const provider = new NativeOpenAiTranscriptionProvider(
      { request },
      { readinessAttempts: 5, readinessDelayMs: 1, readinessRequestTimeoutMs: 50, delay },
    );

    await expect(provider.status()).resolves.toBe(status);
    expect(request).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });
});
