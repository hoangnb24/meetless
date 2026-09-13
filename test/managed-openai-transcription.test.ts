import { describe, expect, test, vi } from "vitest";
import {
  MEETLESS_OPENAI_TRANSCRIPTION_ENDPOINT,
  MEETLESS_OPENAI_TRANSCRIPTION_LANGUAGES,
  MEETLESS_OPENAI_TRANSCRIPTION_MODEL,
  transcribeManagedOpenAIPart,
} from "../convex/openAITranscription";

function audioPart(partNumber: number, sampleOffset: number, sampleCount: number) {
  return {
    partNumber,
    sampleOffset,
    sampleCount,
    bytes: new Uint8Array(45).fill(partNumber),
  };
}

describe("Meetless-managed OpenAI transcription boundary", () => {
  test("posts one bounded WAV part from the backend with a stable diagnostic request identity", async () => {
    const requests: Array<{ url: string; authorization: string | null; requestId: string | null; form: FormData }> = [];
    const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        requestId: new Headers(init?.headers).get("x-client-request-id"),
        form,
      });
      return new Response(JSON.stringify({
        text: "part one",
        languages: [{ code: "en" }, { code: "vi" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await transcribeManagedOpenAIPart(audioPart(2, 16_000, 16_000), {
      apiKey: "backend-secret-value",
      requestId: "job-part-request-2",
      fetch: provider,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: MEETLESS_OPENAI_TRANSCRIPTION_ENDPOINT,
      authorization: "Bearer backend-secret-value",
      requestId: "job-part-request-2",
    });
    expect(requests[0]!.form.get("model")).toBe(MEETLESS_OPENAI_TRANSCRIPTION_MODEL);
    expect(requests[0]!.form.get("response_format")).toBe("json");
    expect(JSON.stringify(requests[0]!.form.getAll("languages[]"))).toBe(JSON.stringify(MEETLESS_OPENAI_TRANSCRIPTION_LANGUAGES));
    expect((requests[0]!.form.get("file") as File).name).toBe("recording-part-2.wav");
    expect(result).toEqual({
      text: "part one",
      detectedLanguages: ["en", "vi"],
    });
    expect(JSON.stringify(result)).not.toContain("backend-secret-value");
  });

  test("fails closed without disclosing provider secrets or response bodies", async () => {
    const provider = vi.fn(async () => new Response("sensitive upstream body", { status: 401 }));
    let message = "";
    try {
      await transcribeManagedOpenAIPart(audioPart(1, 0, 16_000), {
        apiKey: "backend-secret-value",
        requestId: "job-part-request-1",
        fetch: provider,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/credential is invalid/u);
    expect(message).not.toContain("backend-secret-value");
    expect(message).not.toContain("sensitive upstream body");
    await expect(transcribeManagedOpenAIPart(audioPart(1, 0, 16_000), {
      apiKey: " ",
      requestId: "job-part-request-1",
      fetch: provider,
    })).rejects.toThrow(/Convex backend/u);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
