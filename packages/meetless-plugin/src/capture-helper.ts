import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { CommittedRecordingChunk } from "@meetless/meeting-domain";
import { validateCommittedWavChunk } from "./chunk-validator.js";

const HelperEventSchema = z.object({
  version: z.literal(1),
  event: z.enum(["started", "chunkCommitted", "paused", "resumed", "stopped", "interrupted", "captureFailed", "error"]),
  source: z.enum(["microphone", "system"]).optional(),
  id: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  byteLength: z.number().int().positive().optional(),
  sha256: z.string().min(1).optional(),
  logicalStartMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  format: z.literal("wav").optional(),
  error: z.string().min(1).optional(),
}).strict();

type HelperEvent = z.infer<typeof HelperEventSchema>;

export interface CaptureHelperOptions {
  executable: string;
  sessionDirectory: string;
  storeRoot: string;
  fixture: boolean;
  arguments?: string[];
  onChunk(chunk: CommittedRecordingChunk): Promise<void>;
  onFailure(reason: string): Promise<void>;
  onDiagnostic?(line: string): void;
}

export class CaptureHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = "";
  private stderr = "";
  private eventTail: Promise<void> = Promise.resolve();
  private waiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  private expectedExit = false;
  private failed = false;

  constructor(private readonly options: CaptureHelperOptions) {}

  get pid(): number | null { return this.child?.pid ?? null; }

  async start(): Promise<void> {
    if (this.child) throw new Error("Capture helper is already running");
    const child = spawn(this.options.executable, this.options.arguments ?? (this.options.fixture ? ["--fixture"] : []), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receiveStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
      for (const line of chunk.split(/\r?\n/u).filter(Boolean)) this.options.onDiagnostic?.(line);
    });
    child.on("error", (error) => void this.fail(`capture helper spawn failed: ${error.message}`));
    child.on("close", (code, signal) => {
      void this.eventTail.finally(() => {
        this.child = null;
        this.rejectWaiters(new Error(`Capture helper exited (${code ?? signal ?? "unknown"})`));
        if (!this.expectedExit) void this.fail(`capture helper exited unexpectedly (${code ?? signal ?? "unknown"}): ${this.stderr}`);
      });
    });
    await this.commandAndWait("started", { version: 1, command: "start", sessionDirectory: this.options.sessionDirectory, elapsedMs: 0 });
  }

  pause(): Promise<void> { return this.commandAndWait("paused", { version: 1, command: "pause" }); }
  resume(elapsedMs: number): Promise<void> { return this.commandAndWait("resumed", { version: 1, command: "resume", elapsedMs }); }

  async stop(): Promise<void> {
    this.expectedExit = true;
    await this.commandAndWait("stopped", { version: 1, command: "stop" });
    await this.waitForExit(3_000);
  }

  async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    child.stdin.end();
    if (await this.waitForExit(3_000)) return;
    child.kill("SIGTERM");
    if (await this.waitForExit(2_000)) return;
    child.kill("SIGKILL");
    await this.waitForExit(2_000);
  }

  private commandAndWait(event: string, command: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Capture helper is unavailable"));
    const pending = new Promise<void>((resolve, reject) => {
      const entries = this.waiters.get(event) ?? [];
      entries.push({ resolve, reject });
      this.waiters.set(event, entries);
    });
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return withTimeout(pending, 30_000, `Timed out waiting for helper ${event}`);
  }

  private receiveStdout(chunk: string): void {
    this.stdout += chunk;
    while (true) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      this.eventTail = this.eventTail.then(() => this.handleEvent(line)).catch((error) => this.fail(String(error)));
    }
  }

  private async handleEvent(line: string): Promise<void> {
    const event = HelperEventSchema.parse(JSON.parse(line));
    if (event.event === "chunkCommitted") await this.options.onChunk(await this.chunk(event));
    if (event.event === "captureFailed" || event.event === "error") {
      await this.fail(event.error ?? event.event);
    }
    const waiter = this.waiters.get(event.event)?.shift();
    if (waiter) waiter.resolve();
  }

  private async chunk(event: HelperEvent): Promise<CommittedRecordingChunk> {
    const required = [event.id, event.source, event.path, event.byteLength, event.sha256, event.logicalStartMs, event.durationMs, event.sampleRate, event.channels, event.format];
    if (required.some((value) => value === undefined)) throw new Error("Incomplete chunkCommitted helper event");
    return validateCommittedWavChunk({
      filePath: event.path!, sessionDirectory: this.options.sessionDirectory, storeRoot: this.options.storeRoot,
      claim: {
        id: event.id!, source: event.source!, path: event.path!, byteLength: event.byteLength!, sha256: event.sha256!,
        logicalStartMs: event.logicalStartMs!, durationMs: event.durationMs!, sampleRate: event.sampleRate!,
        channels: event.channels!, format: event.format!,
      },
    });
  }

  private async fail(reason: string): Promise<void> {
    if (this.failed) return;
    this.failed = true;
    this.expectedExit = true;
    this.rejectWaiters(new Error(reason));
    this.child?.kill("SIGTERM");
    await this.options.onFailure(reason);
  }

  private rejectWaiters(error: Error): void {
    for (const entries of this.waiters.values()) for (const waiter of entries) waiter.reject(error);
    this.waiters.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("close", () => { clearTimeout(timer); resolve(true); });
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
