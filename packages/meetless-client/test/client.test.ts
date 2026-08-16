import { describe, expect, test, vi } from "vitest";
import {
  MeetlessClient,
  MeetlessFeatureUnavailableError,
  type MeetlessDaemonPort,
} from "../src/index.js";

function daemon(overrides: Partial<MeetlessDaemonPort> = {}): MeetlessDaemonPort {
  return {
    getLastServerInfoMessage: () => ({ features: { plugins: true } }),
    getPluginCatalog: async () => [{ id: "meetless", clientBundle: "bundle" }],
    invokePluginRpc: vi.fn(async (_id, method) =>
      method === "meeting.list"
        ? { meetings: [] }
        : {
            id: "m-1",
            title: "Design sync",
            status: "draft",
            createdAt: "2026-08-16T10:00:00.000Z",
            updatedAt: "2026-08-16T10:00:00.000Z",
          },
    ),
    ...overrides,
  };
}

describe("Meetless capability gate", () => {
  test("validates the feature and catalog once before focused methods", async () => {
    const port = daemon();
    const client = new MeetlessClient(port);
    await client.initialize();
    await client.initialize();
    await expect(client.createMeeting({ title: "Design sync" })).resolves.toMatchObject({
      id: "m-1",
      status: "draft",
    });
    await expect(client.listMeetings()).resolves.toEqual([]);
    expect(port.invokePluginRpc).toHaveBeenNthCalledWith(
      1,
      "meetless",
      "meeting.create",
      { title: "Design sync" },
    );
  });

  test("does not fall back when plugins are unsupported", async () => {
    const client = new MeetlessClient(
      daemon({ getLastServerInfoMessage: () => ({ features: { plugins: false } }) }),
    );
    await expect(client.initialize()).rejects.toThrow(MeetlessFeatureUnavailableError);
    await expect(client.createMeeting({ title: "No fallback" })).rejects.toThrow(
      "not initialized",
    );
  });

  test("does not invoke RPC when the meetless catalog entry is absent", async () => {
    const port = daemon({ getPluginCatalog: async () => [] });
    const client = new MeetlessClient(port);
    await expect(client.initialize()).rejects.toThrow('required "meetless" plugin');
    expect(port.invokePluginRpc).not.toHaveBeenCalled();
  });
});
