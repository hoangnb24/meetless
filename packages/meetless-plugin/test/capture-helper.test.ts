import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CaptureHelper } from "../src/capture-helper.js";

describe("capture helper supervision", () => {
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
