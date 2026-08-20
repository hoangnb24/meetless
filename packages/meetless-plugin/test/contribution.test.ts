import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paseo/plugin";
import contribute from "../index.js";

describe("Meetless plugin contribution", () => {
  test("publishes meeting and non-mutating readiness bootstrap without exposing recording control RPC", async () => {
    const handle = vi.fn();
    const addSurface = vi.fn();
    const addSidebarItem = vi.fn();
    const cleanup = contribute({ handle, addSurface, addSidebarItem } as unknown as PluginContext);

    expect(handle.mock.calls.map(([rpc]) => rpc.name)).toEqual([
      "meeting.create",
      "meeting.list",
      "meeting.transcript",
      "meeting.transcription.consent",
      "meeting.citation.resolve",
      "meeting.chat.providers",
      "meeting.chat.get",
      "meeting.chat.ask",
      "meeting.chat.retry",
      "runtime.readiness.bootstrap",
    ]);
    expect(addSurface).not.toHaveBeenCalled();
    expect(addSidebarItem).not.toHaveBeenCalled();
    await expect(cleanup()).resolves.toBeUndefined();
    expect(handle.mock.calls.map(([rpc]) => rpc.name)).not.toContain("recording.start");
    const readiness = handle.mock.calls.find(([rpc]) => rpc.name === "runtime.readiness.bootstrap")![0];
    expect(() => readiness.input.parse({ nonce: randomUUID() })).toThrow();
    expect(readiness.input.parse({ nonce: randomUUID(), deadlineEpochMs: Date.now() + 1_000 }))
      .toHaveProperty("deadlineEpochMs");
  });
});
