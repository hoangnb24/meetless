import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { providerAccess } from "../src/provider-access.js";

test.each(["cancelled", "granted", "mismatch", "secret"])("native provider access transport: %s", async (scenario) => {
  const timeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
  const root = await mkdtemp("/tmp/ml-pa-");
  const socketPath = path.join(root, "s");
  let received: unknown;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      received = request;
      socket.end(JSON.stringify({ version: 1, requestId: scenario === "mismatch" ? "wrong" : request.requestId, ok: true, type: "provider.access",
        outcome: scenario === "granted" ? "granted" : "cancelled",
        providers: [{ id: "codex", status: scenario === "granted" ? "restart_required" : "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }],
        ...(scenario === "secret" ? { token: "must-not-cross" } : {}),
      }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    if (["mismatch", "secret"].includes(scenario)) await expect(providerAccess(socketPath, "codex")).rejects.toThrow(/access is unavailable/);
    else {
      const result = await providerAccess(socketPath, "codex");
      expect(result.outcome).toBe(scenario);
      expect(result.providers[0].status).toBe(scenario === "granted" ? "restart_required" : "needs_access");
      expect(Object.keys(result).sort()).toEqual(["outcome", "providers"]);
    }
    expect(received).toMatchObject({ version: 1, operation: "providerAccessRequest", provider: "codex" });
    expect(timeoutSpy).toHaveBeenCalledWith(0, expect.any(Function));
  } finally {
    timeoutSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

import { ProviderAccessService } from "../src/provider-access.js";
import { vi } from "vitest";
import type { ProviderAccessResult } from "@meetless/meeting-contracts";
const initial: ProviderAccessResult = { outcome: "status", providers: [{ id: "codex", status: "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };

test("chooser outlives five minutes while request/status stay immediate and reconnect never opens a duplicate", async () => {
  vi.useFakeTimers();
  try {
    const granted: ProviderAccessResult = { ...initial, outcome: "granted", providers: initial.providers.map((entry) => entry.id === "codex" ? { ...entry, status: "restart_required" } : entry) };
    const transport = vi.fn((provider?: string) => provider
      ? new Promise<ProviderAccessResult>((resolve) => setTimeout(() => resolve(granted), 360_000))
      : Promise.resolve(initial));
    const service = new ProviderAccessService(transport);
    expect(await service.status()).toEqual(initial);
    expect(service.request("codex").outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await service.status()).outcome).toBe("pending");
    expect(service.request("codex").outcome).toBe("pending");
    expect(transport.mock.calls.filter(([provider]) => provider)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect((await service.status()).outcome).toBe("pending");
    expect(transport.mock.calls.filter(([provider]) => provider)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await service.status()).toEqual(granted);
    // A new/reconnected client observes the same terminal outcome; current access is revalidated.
    expect(await service.status()).toEqual({ ...initial, outcome: "granted" });
  } finally { vi.useRealTimers(); }
});

test("cancelled/failed terminal is retained and a new request clears the previous outcome", async () => {
  const transport = vi.fn(async (provider?: string) => provider ? { ...initial, outcome: "cancelled" as const } : initial);
  const service = new ProviderAccessService(transport);
  service.request("codex");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await service.status()).outcome).toBe("cancelled");
  expect((await service.status()).outcome).toBe("cancelled");
  transport.mockRejectedValueOnce(new Error("native unavailable"));
  expect(service.request("codex").outcome).toBe("pending");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await service.status()).outcome).toBe("failed");
});
