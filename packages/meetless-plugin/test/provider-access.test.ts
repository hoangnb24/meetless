import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { providerAccess } from "../src/provider-access.js";

test.each(["cancelled", "granted", "mismatch", "secret"])("native provider access transport: %s", async (scenario) => {
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
