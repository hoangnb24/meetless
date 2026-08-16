import { describe, expect, test, vi } from "vitest";
import type { PluginContext } from "@paseo/plugin";
import contribute from "../index.js";

describe("Meetless plugin contribution", () => {
  test("publishes RPC handlers without a second product surface", () => {
    const handle = vi.fn();
    const addSurface = vi.fn();
    const addSidebarItem = vi.fn();
    const cleanup = contribute({ handle, addSurface, addSidebarItem } as unknown as PluginContext);

    expect(handle.mock.calls.map(([rpc]) => rpc.name)).toEqual(["meeting.create", "meeting.list"]);
    expect(addSurface).not.toHaveBeenCalled();
    expect(addSidebarItem).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });
});
