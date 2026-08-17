import { describe, expect, test, vi } from "vitest";
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
      "runtime.readiness.bootstrap",
    ]);
    expect(addSurface).not.toHaveBeenCalled();
    expect(addSidebarItem).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
    expect(handle.mock.calls.map(([rpc]) => rpc.name)).not.toContain("recording.start");
  });
});
