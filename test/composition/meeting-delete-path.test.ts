import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MeetingDeleteRpc } from "@meetless/meeting-contracts";
import { MeetingStore } from "@meetless/meeting-store";
import { MeetlessClient, type MeetlessDaemonPort } from "@meetless/client";
import { deleteMeetingSafely } from "../../packages/meetless-plugin/src/server.js";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("meeting deletion composition", () => {
  test("contract, client, server gate, and durable store delete only the requested meeting", async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-delete-composition-"));
    const store = new MeetingStore({ root });
    await store.create({ id: "m-delete", title: "Delete" });
    await store.create({ id: "m-keep", title: "Keep" });
    const daemon: MeetlessDaemonPort = {
      getLastServerInfoMessage: () => ({ features: { plugins: true } }),
      getPluginCatalog: async () => [{ id: "meetless", clientBundle: "bundle" }],
      invokePluginRpc: async (_pluginId, method, input) => {
        if (method !== MeetingDeleteRpc.name) throw new Error(`Unexpected RPC: ${method}`);
        const parsed = MeetingDeleteRpc.input.parse(input);
        return MeetingDeleteRpc.output.parse(await deleteMeetingSafely(store, parsed.meetingId));
      },
    };
    const client = new MeetlessClient(daemon);
    await client.initialize();

    await expect(client.deleteMeeting("m-delete")).resolves.toEqual({
      meetingId: "m-delete", outcome: "deleted", reason: null,
    });
    await expect(new MeetingStore({ root }).list()).resolves.toMatchObject([{ id: "m-keep" }]);
  });
});
