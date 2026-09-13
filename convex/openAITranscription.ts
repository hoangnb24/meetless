export const MEETLESS_OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const MEETLESS_OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
export const MEETLESS_OPENAI_TRANSCRIPTION_LANGUAGES = ["en", "vi"] as const;
export const MEETLESS_OPENAI_TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1_000;

export interface OpenAIManagedPart {
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly bytes: Uint8Array;
}

export interface OpenAIManagedPartResult {
  readonly text: string;
  readonly detectedLanguages: readonly string[];
}

/**
 * Convex/backend-only OpenAI adapter. The credential is accepted only as an
 * in-memory call dependency and is never returned or included in diagnostics.
 */
export async function transcribeManagedOpenAIPart(
  part: OpenAIManagedPart,
  options: {
    readonly apiKey: string;
    readonly requestId: string;
    readonly fetch?: typeof fetch;
    readonly endpoint?: string;
  },
): Promise<OpenAIManagedPartResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Meetless-managed OpenAI credential is not configured in the Convex backend");
  const requestId = options.requestId.trim();
  if (!requestId) throw new Error("Meetless-managed OpenAI transcription request identity is missing");
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? MEETLESS_OPENAI_TRANSCRIPTION_ENDPOINT;
  const languages = new Set<string>();
  if (part.partNumber <= 0 || !Number.isSafeInteger(part.partNumber) || part.sampleOffset < 0 || !Number.isSafeInteger(part.sampleOffset) || part.sampleCount <= 0 || !Number.isSafeInteger(part.sampleCount) || part.bytes.byteLength <= 44) {
    throw new Error("Meetless-managed OpenAI transcription received an invalid audio part");
  }

  const form = new FormData();
  form.append("model", MEETLESS_OPENAI_TRANSCRIPTION_MODEL);
  form.append("response_format", "json");
  for (const language of MEETLESS_OPENAI_TRANSCRIPTION_LANGUAGES) form.append("languages[]", language);
  const audio = new ArrayBuffer(part.bytes.byteLength);
  new Uint8Array(audio).set(part.bytes);
  form.append("file", new Blob([audio], { type: "audio/wav" }), `recording-part-${part.partNumber}.wav`);
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Client-Request-Id": requestId,
      },
      body: form,
      signal: AbortSignal.timeout(MEETLESS_OPENAI_TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Meetless-managed OpenAI transcription is unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Meetless-managed OpenAI credential is invalid");
  }
  if (!response.ok) {
    throw new Error(`Meetless-managed OpenAI transcription failed with status ${response.status}`);
  }
  let decoded: Record<string, unknown>;
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response object");
    decoded = value as Record<string, unknown>;
  } catch {
    throw new Error("Meetless-managed OpenAI transcription returned an invalid response");
  }
  const text = typeof decoded.text === "string" ? decoded.text.trim() : "";
  if (!text) throw new Error("Meetless-managed OpenAI transcription returned no text");
  const decodedLanguages = Array.isArray(decoded.languages) ? decoded.languages : [];
  for (const language of decodedLanguages) {
    const code = typeof language === "string"
      ? language
      : language && typeof language === "object" && "code" in language
        ? (language as { readonly code?: unknown }).code
        : undefined;
    if (typeof code === "string" && code.trim()) languages.add(code.trim());
  }
  if (typeof decoded.language === "string" && decoded.language.trim()) languages.add(decoded.language.trim());

  return {
    text,
    detectedLanguages: [...languages],
  };
}
