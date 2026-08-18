import { randomUUID } from "node:crypto";
import net from "node:net";
import { z } from "zod";
import type { OutputIdentity, TranscriptRange, TranscriptUsage } from "@meetless/meeting-domain";

export const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions" as const;
export const OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe" as const;
export const OPENAI_TRANSCRIPTION_LANGUAGES = ["en", "vi"] as const;

export type TranscriptionProviderStatus = "configured" | "missing" | "invalid";

export interface TranscriptionRequest {
  recordingId: string;
  audioPath: string;
  audioIdentity: OutputIdentity;
  range: TranscriptRange;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguages: string[];
  usage: TranscriptUsage | null;
}

export interface TranscriptionProvider {
  status(): Promise<TranscriptionProviderStatus>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface NativeTranscriptionRequest {
  operation: "status" | "transcribe";
  recordingId?: string;
  audioPath?: string;
  audioByteLength?: number;
  audioSha256?: string;
  range?: TranscriptRange;
}

const NativeUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
}).strict();

export const NativeTranscriptionResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  ok: z.boolean(),
  status: z.enum(["configured", "missing", "invalid"]),
  text: z.string().optional(),
  detectedLanguages: z.array(z.string().trim().min(1)).optional(),
  usage: NativeUsageSchema.nullable().optional(),
  error: z.literal("transcription unavailable").nullable().optional(),
}).strict();

export type NativeTranscriptionResponse = z.infer<typeof NativeTranscriptionResponseSchema>;

export interface NativeTranscriptionTransport {
  request(input: NativeTranscriptionRequest): Promise<NativeTranscriptionResponse>;
}

export class TranscriptionProviderError extends Error {
  constructor(message = "Native transcription request failed") {
    super(message);
    this.name = "TranscriptionProviderError";
  }
}

export class UnixSocketNativeTranscriptionTransport implements NativeTranscriptionTransport {
  constructor(private readonly socketPath: string) {}

  request(input: NativeTranscriptionRequest): Promise<NativeTranscriptionResponse> {
    const requestId = randomUUID();
    const message = JSON.stringify({ version: 1, requestId, ...input });
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.setEncoding("utf8");
      socket.once("error", () => finish(() => reject(new TranscriptionProviderError())));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const responseText = buffer.slice(0, newline);
        try {
          const response = NativeTranscriptionResponseSchema.parse(JSON.parse(responseText));
          if (response.requestId !== requestId) throw new Error("native request identity mismatch");
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new TranscriptionProviderError()));
        }
      });
      socket.once("connect", () => socket.end(`${message}\n`));
    });
  }
}

export class NativeOpenAiTranscriptionProvider implements TranscriptionProvider {
  private readonly readinessAttempts: number;
  private readonly readinessDelayMs: number;
  private readonly readinessRequestTimeoutMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly transport: NativeTranscriptionTransport,
    options: {
      readinessAttempts?: number;
      readinessDelayMs?: number;
      readinessRequestTimeoutMs?: number;
      delay?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.readinessAttempts = Math.max(1, options.readinessAttempts ?? 20);
    this.readinessDelayMs = Math.max(0, options.readinessDelayMs ?? 25);
    this.readinessRequestTimeoutMs = Math.max(1, options.readinessRequestTimeoutMs ?? 250);
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async status(): Promise<TranscriptionProviderStatus> {
    return this.waitForNativeReadiness();
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (await this.waitForNativeReadiness() !== "configured") throw new TranscriptionProviderError();
    let response: NativeTranscriptionResponse;
    try {
      response = await this.transport.request({
        operation: "transcribe",
        recordingId: request.recordingId,
        audioPath: request.audioPath,
        audioByteLength: request.audioIdentity.byteLength,
        audioSha256: request.audioIdentity.sha256,
        range: request.range,
      });
    } catch {
      throw new TranscriptionProviderError();
    }
    if (!response.ok || response.status !== "configured" || response.text === undefined) {
      throw new TranscriptionProviderError();
    }
    return {
      text: response.text,
      detectedLanguages: response.detectedLanguages ?? [],
      usage: response.usage ?? null,
    };
  }

  private async waitForNativeReadiness(): Promise<TranscriptionProviderStatus> {
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt += 1) {
      try {
        const response = await withTimeout(
          this.transport.request({ operation: "status" }),
          this.readinessRequestTimeoutMs,
        );
        if (response.ok) return response.status;
      } catch {}
      if (attempt < this.readinessAttempts) await this.delay(this.readinessDelayMs);
    }
    return "invalid";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranscriptionProviderError()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
