import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import { CaptureHelper } from "../src/capture-helper.js";

describe("capture helper supervision", () => {
  test("interrupts to recoverable when a live chunk event lies, without storing the invalid chunk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-invalid-live-chunk-"));
    const store = new MeetingStore({ root });
    const meeting = await store.create({ title: "Invalid event" });
    const recording = await store.startRecording({ meetingId: meeting.id });
    const sessionDirectory = path.join(root, "sessions", recording.id);
    let resolveFailure!: () => void;
    const failure = new Promise<void>((resolve) => { resolveFailure = resolve; });
    const helper = new CaptureHelper({
      executable: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      sessionDirectory, storeRoot: root, fixture: true, arguments: ["--invalid-claim-fixture"],
      onChunk: (chunk) => store.commitChunk(recording.id, chunk).then(() => undefined),
      onFailure: async (reason) => {
        const interrupted = await store.interruptRecording(recording.id, reason);
        await store.assessInterruption(recording.id, { recoverable: interrupted.chunks.length > 0 });
        resolveFailure();
      },
    });
    try {
      await helper.start();
      await failure;
      const recovered = (await store.listRecordings())[0]!;
      expect(recovered.status).toBe("recoverable");
      expect(recovered.chunks.length).toBeGreaterThanOrEqual(2);
      expect(recovered.chunks.some((chunk) => chunk.id === "chunk--microphone--000001--000000016000--000000016000--16000--1")).toBe(false);
    } finally {
      await helper.terminate();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("uses one PTS timeline for source offset, discontinuity gap, and pause exclusion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-timeline-helper-"));
    const sessionDirectory = path.join(root, "sessions", "timeline");
    const child = spawn(path.resolve("native/macos-capture/.build/release/meetless-capture"), ["--timeline-fixture"], {
      stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH },
    });
    const events: Array<Record<string, unknown>> = [];
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      while (stdout.includes("\n")) {
        const newline = stdout.indexOf("\n");
        const line = stdout.slice(0, newline).trim(); stdout = stdout.slice(newline + 1);
        if (line) events.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    try {
      send(child, { version: 1, command: "start", sessionDirectory, elapsedMs: 0 });
      await waitFor(() => events.some((event) => event.event === "started"));
      await waitFor(() => chunkStarts(events, "microphone").includes(500) && chunkStarts(events, "system").includes(125));

      send(child, { version: 1, command: "pause" });
      await waitFor(() => events.some((event) => event.event === "paused"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      send(child, { version: 1, command: "resume", elapsedMs: 2_000 });
      await waitFor(() => events.some((event) => event.event === "resumed"));
      await new Promise((resolve) => setTimeout(resolve, 80));
      send(child, { version: 1, command: "stop" });
      await waitFor(() => events.some((event) => event.event === "stopped"));

      expect(chunkStarts(events, "microphone")).toEqual(expect.arrayContaining([0, 500, 2_125]));
      expect(chunkStarts(events, "system")).toEqual(expect.arrayContaining([125, 2_000]));
      expect(events.filter((event) => event.event === "chunkCommitted").every((event) =>
        String(event.id).includes(`--${String(Number(event.logicalStartMs) * 16).padStart(12, "0")}--`),
      )).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("commits source-labelled timeline chunks and bounded cleanup leaves no helper process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-helper-test-"));
    const sessionDirectory = path.join(root, "sessions", "r-1");
    const chunks: Array<{ source: string; logicalStartMs: number }> = [];
    const failures: string[] = [];
    const helper = new CaptureHelper({
      executable: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      sessionDirectory, storeRoot: root, fixture: true,
      onChunk: async (chunk) => { chunks.push(chunk); },
      onFailure: async (reason) => { failures.push(reason); },
    });
    try {
      await helper.start();
      const pid = helper.pid!;
      await waitFor(() => chunks.length >= 2);
      expect(new Set(chunks.map((chunk) => chunk.source))).toEqual(new Set(["microphone", "system"]));
      expect(chunks.every((chunk) => chunk.logicalStartMs === 0)).toBe(true);
      await helper.terminate();
      await waitFor(() => !isRunning(pid));
      expect(failures).toEqual([]);
    } finally { await helper.terminate(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);
});

function send(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function chunkStarts(events: Array<Record<string, unknown>>, source: string): number[] {
  return events
    .filter((event) => event.event === "chunkCommitted" && event.source === source)
    .map((event) => Number(event.logicalStartMs));
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for helper cleanup proof");
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
