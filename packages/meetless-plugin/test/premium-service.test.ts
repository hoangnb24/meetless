import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  NativePremiumAccessPort,
  PREMIUM_REQUIRED_MESSAGE,
  PremiumRequiredError,
  PremiumService,
  type PremiumAuthorizationSnapshot,
  type PremiumAccessPort,
} from "../src/premium-service.js";

const activeAccess = {
  entitlement: "premium" as const,
  status: "active" as const,
  packages: [{
    packageId: "monthly" as const,
    productId: "com.meetless.app.premium.monthly",
    localizedPrice: "$9.99",
    trialEligible: true,
  }],
  reason: null,
};

function activeAuthorization(): PremiumAuthorizationSnapshot {
  return { state: "active", naturalExpiryAt: Date.now() + 60_000 };
}

function accessPort(overrides: Partial<PremiumAccessPort> = {}): PremiumAccessPort {
  return {
    status: vi.fn(async () => activeAccess),
    purchase: vi.fn(async () => ({ outcome: "active" as const, access: activeAccess })),
    restore: vi.fn(async () => ({ outcome: "active" as const, access: activeAccess })),
    recover: vi.fn(async () => null),
    ...overrides,
  };
}

describe("Premium service", () => {
  test("allows Ask only for an active Premium entitlement", async () => {
    const service = new PremiumService(accessPort());

    await expect(service.requireActive()).resolves.toBeUndefined();
  });

  test("fails closed with a stable user-safe error when Premium is inactive", async () => {
    const service = new PremiumService(accessPort({
      status: vi.fn(async () => ({
        entitlement: "premium", status: "inactive", packages: [], reason: null,
      })),
    }));

    await expect(service.requireActive()).rejects.toEqual(new PremiumRequiredError());
    await expect(service.requireActive()).rejects.toThrow(PREMIUM_REQUIRED_MESSAGE);
  });

  test("redacts native status failures as store unavailable", async () => {
    const service = new PremiumService(accessPort({
      status: vi.fn(async () => { throw new Error("RevenueCat secret diagnostic"); }),
    }));

    await expect(service.status()).resolves.toEqual({
      entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable",
    });
  });

  test.each(["purchase", "restore"] as const)("fails closed when %s returns an invalid result", async (operation) => {
    const service = new PremiumService(accessPort({
      [operation]: vi.fn(async () => ({ outcome: "active", access: { ...activeAccess, entitlement: "wrong" } })) as never,
    }));

    const result = operation === "purchase" ? await service.purchase("monthly") : await service.restore();
    expect(result).toEqual({
      outcome: "failed",
      access: { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
    });
  });

  test("consumes a signed transaction inside the plugin and returns only the public Premium result", async () => {
    const onAppleSignedTransaction = vi.fn(async () => activeAuthorization());
    const service = new PremiumService(accessPort({
      purchase: vi.fn(async () => ({ outcome: "active" as const, access: activeAccess, appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature" })),
    }), { onAppleSignedTransaction, requireAppleSignedTransaction: true });

    const result = await service.purchase("monthly");

    expect(onAppleSignedTransaction).toHaveBeenCalledWith("eyJhbGciOiJFUzI1NiJ9.synthetic.signature");
    expect(result).toEqual({ outcome: "active", access: activeAccess });
    expect(result).not.toHaveProperty("appleSignedTransaction");
  });

  test("fails closed when enrollment does not return backend authorization", async () => {
    const service = new PremiumService(accessPort({
      purchase: vi.fn(async () => ({
        outcome: "active" as const,
        access: activeAccess,
        appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature",
      })),
    }), {
      onAppleSignedTransaction: vi.fn(async () => undefined),
      requireAppleSignedTransaction: true,
    });

    await expect(service.purchase("monthly")).resolves.toEqual({
      outcome: "failed",
      access: { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
    });
  });

  test("fails closed when an active real purchase has no signed transaction", async () => {
    const service = new PremiumService(accessPort(), { requireAppleSignedTransaction: true });

    await expect(service.purchase("monthly")).resolves.toEqual({
      outcome: "failed",
      access: { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
    });
  });

  test("gates RevenueCat active status on the backend authorization snapshot", async () => {
    const nativeActive = { ...activeAccess, packages: [] };
    const native = accessPort({ status: vi.fn(async () => nativeActive) });
    const revoked = new PremiumService(native, {
      readAuthorization: async () => ({ state: "revoked", naturalExpiryAt: Date.now() + 60_000 }),
    });
    await expect(revoked.status()).resolves.toEqual({ ...nativeActive, status: "inactive", reason: null });

    const active = new PremiumService(native, {
      readAuthorization: async () => ({ state: "grace", naturalExpiryAt: Date.now() + 60_000 }),
    });
    await expect(active.status()).resolves.toEqual(nativeActive);

    const expired = new PremiumService(native, {
      readAuthorization: async () => ({ state: "active", naturalExpiryAt: Date.now() - 1 }),
    });
    await expect(expired.status()).resolves.toEqual({ ...nativeActive, status: "inactive", reason: null });
  });

  test("forces a fresh backend authorization snapshot after active access", async () => {
    const nativeStatus = vi.fn(async () => activeAccess);
    let authorization: PremiumAuthorizationSnapshot = activeAuthorization();
    const service = new PremiumService(accessPort({ status: nativeStatus }), {
      readAuthorization: async () => authorization,
    });

    await expect(service.status()).resolves.toEqual(activeAccess);
    authorization = { state: "refunded", naturalExpiryAt: Date.now() + 60_000 };
    await expect(service.status()).resolves.toEqual({ ...activeAccess, status: "inactive", reason: null });
    authorization = { state: "revoked", naturalExpiryAt: Date.now() + 60_000 };
    await expect(service.status()).resolves.toEqual({ ...activeAccess, status: "inactive", reason: null });
    expect(nativeStatus).toHaveBeenCalledTimes(3);
  });

  test("recovers a retained native terminal on status after a plugin restart", async () => {
    const signedTransaction = "eyJhbGciOiJFUzI1NiJ9.restart.signature";
    const recover = vi.fn()
      .mockResolvedValueOnce({ outcome: "active" as const, access: activeAccess, appleSignedTransaction: signedTransaction })
      .mockResolvedValueOnce(null);
    const nativeStatus = vi.fn(async () => activeAccess);
    const enroll = vi.fn(async () => activeAuthorization());
    const port = accessPort({ recover, status: nativeStatus });
    const options = { onAppleSignedTransaction: enroll, requireAppleSignedTransaction: true };

    await expect(new PremiumService(port, options).status()).resolves.toEqual(activeAccess);
    await expect(new PremiumService(port, options).status()).resolves.toEqual(activeAccess);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(enroll).toHaveBeenCalledOnce();
    expect(nativeStatus).toHaveBeenCalledOnce();
  });

  test.each(["active", "cancelled", "failed"] as const)("drains an old %s result under its UUID before a new explicit Restore", async (outcome) => {
    const oldId = "12345678-1234-4123-8123-123456789abc";
    const newId = "12345678-1234-4123-8123-123456789abd";
    const signedTransaction = "eyJhbGciOiJFUzI1NiJ9.restore.signature";
    const restore = vi.fn(async () => ({ outcome: "active" as const, access: activeAccess, appleSignedTransaction: signedTransaction, operationId: newId }));
    const recover = vi.fn().mockResolvedValueOnce({ outcome, access: activeAccess, operationId: oldId,
      ...(outcome === "active" ? { appleSignedTransaction: signedTransaction } : {}),
    }).mockResolvedValue(null);
    const enroll = vi.fn(async () => activeAuthorization());
    const service = new PremiumService(accessPort({ recover, restore }), {
      onAppleSignedTransaction: enroll, requireAppleSignedTransaction: true,
    });
    await expect(service.restore(newId)).resolves.toEqual({ outcome: "active", access: activeAccess });
    await expect(service.operationResult(oldId)).resolves.toMatchObject({ outcome });
    await expect(service.operationResult(newId)).resolves.toMatchObject({ outcome: "active" });
    expect(recover).toHaveBeenCalledOnce();
    expect(enroll).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledExactlyOnceWith(newId);
  });

  test("retains only the latest bounded transaction digest for dedupe", async () => {
    const signedTransaction = (index: number) => `eyJhbGciOiJFUzI1NiJ9.transaction-${index}.signature`;
    const recover = vi.fn();
    const enroll = vi.fn(async () => activeAuthorization());
    const service = new PremiumService(accessPort({ recover }), {
      onAppleSignedTransaction: enroll,
      requireAppleSignedTransaction: true,
    });

    for (let index = 0; index < 32; index += 1) {
      recover.mockResolvedValueOnce({
        outcome: "active" as const,
        access: activeAccess,
        appleSignedTransaction: signedTransaction(index),
      });
      await expect(service.status()).resolves.toEqual(activeAccess);
    }
    expect(enroll).toHaveBeenCalledTimes(32);

    recover.mockResolvedValueOnce({
      outcome: "active" as const,
      access: activeAccess,
      appleSignedTransaction: signedTransaction(31),
    });
    await expect(service.status()).resolves.toEqual(activeAccess);
    expect(enroll).toHaveBeenCalledTimes(32);

    recover.mockResolvedValueOnce({
      outcome: "active" as const,
      access: activeAccess,
      appleSignedTransaction: signedTransaction(0),
    });
    await expect(service.status()).resolves.toEqual(activeAccess);
    expect(enroll).toHaveBeenCalledTimes(33);
  });

  test("coalesces concurrent retained-terminal recovery and enrolls once", async () => {
    const recovery = deferred<{
      outcome: "active";
      access: typeof activeAccess;
      appleSignedTransaction: string;
    } | null>();
    const recover = vi.fn(() => recovery.promise);
    const enroll = vi.fn(async () => activeAuthorization());
    const service = new PremiumService(accessPort({ recover }), {
      onAppleSignedTransaction: enroll,
      requireAppleSignedTransaction: true,
    });

    const first = service.status();
    const second = service.status();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
    recovery.resolve({
      outcome: "active",
      access: activeAccess,
      appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.concurrent.signature",
    });
    await expect(first).resolves.toEqual(activeAccess);
    await expect(second).resolves.toEqual(activeAccess);
    expect(enroll).toHaveBeenCalledOnce();
  });

  test("does not start two mutations when concurrent calls finish recovery together", async () => {
    const recovery = deferred<null>();
    const nativeResult = deferred<{
      outcome: "pending";
      access: typeof activeAccess;
    }>();
    const recover = vi.fn(() => recovery.promise);
    const purchase = vi.fn(() => nativeResult.promise);
    const service = new PremiumService(accessPort({ recover, purchase }));

    const first = service.purchase("monthly");
    const second = service.purchase("monthly");
    recovery.resolve(null);
    await vi.waitFor(() => expect(purchase).toHaveBeenCalledOnce());
    await expect(second).resolves.toMatchObject({ outcome: "failed" });
    expect(purchase).toHaveBeenCalledOnce();
    nativeResult.resolve({ outcome: "pending", access: activeAccess });
    await expect(first).resolves.toMatchObject({ outcome: "pending" });
  });

  test("converges a native terminal transaction through operation polling without redispatch", async () => {
    const signedTransaction = "eyJhbGciOiJFUzI1NiJ9.synthetic.signature";
    const enroll = vi.fn(async () => activeAuthorization());
    const purchase = vi.fn().mockResolvedValue({ outcome: "pending" as const, access: activeAccess });
    const recover = vi.fn().mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ outcome: "pending" as const, access: activeAccess, appleSignedTransaction: signedTransaction });
    const service = new PremiumService(accessPort({ purchase, recover }), {
      onAppleSignedTransaction: enroll,
      requireAppleSignedTransaction: true,
    });

    await expect(service.purchase("monthly")).resolves.toMatchObject({ outcome: "pending" });
    expect(enroll).not.toHaveBeenCalled();
    await expect(service.status()).resolves.toMatchObject({ status: "inactive" });
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({ status: "active" }));
    expect(purchase).toHaveBeenCalledOnce();
    expect(enroll).toHaveBeenCalledOnce();
  });

  test("keeps trusted enrollment pending and suppresses a duplicate mutation", async () => {
    const enrollment = deferred<PremiumAuthorizationSnapshot>();
    const purchase = vi.fn(async () => ({
      outcome: "pending" as const,
      access: activeAccess,
      appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature",
    }));
    const onAppleSignedTransaction = vi.fn(() => enrollment.promise);
    const service = new PremiumService(accessPort({ purchase }), {
      onAppleSignedTransaction,
      requireAppleSignedTransaction: true,
    });

    await expect(service.purchase("monthly", "12345678-1234-4123-8123-123456789abc")).resolves.toEqual({
      outcome: "pending",
      access: { ...activeAccess, status: "inactive", reason: null },
    });
    await expect(service.status()).resolves.toMatchObject({ status: "inactive" });
    await expect(service.purchase("monthly", "12345678-1234-4123-8123-123456789abc")).resolves.toEqual({
      outcome: "pending",
      access: { ...activeAccess, status: "inactive", reason: null },
    });
    expect(purchase).toHaveBeenCalledOnce();
    expect(onAppleSignedTransaction).toHaveBeenCalledOnce();

    enrollment.resolve(activeAuthorization());
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({ status: "active" }));
    expect(onAppleSignedTransaction).toHaveBeenCalledOnce();
  });

  test("does not redispatch a retained native operation across concurrent status refreshes", async () => {
    const terminal = deferred<{
      outcome: "cancelled";
      access: typeof activeAccess;
    }>();
    const purchase = vi.fn().mockResolvedValue({ outcome: "pending" as const, access: activeAccess });
    const recover = vi.fn().mockResolvedValueOnce(null).mockImplementation(() => terminal.promise);
    const service = new PremiumService(accessPort({
      purchase, recover,
      status: vi.fn(async () => ({ ...activeAccess, status: "inactive" as const, reason: null })),
    }));

    await expect(service.purchase("monthly")).resolves.toMatchObject({ outcome: "pending" });
    const firstRefresh = service.status();
    const secondRefresh = service.status();
    expect(purchase).toHaveBeenCalledOnce();

    terminal.resolve({ outcome: "cancelled", access: activeAccess });
    await expect(firstRefresh).resolves.toMatchObject({ status: "inactive" });
    await expect(secondRefresh).resolves.toMatchObject({ status: "inactive" });
    expect(purchase).toHaveBeenCalledOnce();
  });

  test("keeps status pending while the native callback is delayed", async () => {
    const nativeResult = deferred<{
      outcome: "pending";
      access: typeof activeAccess;
      appleSignedTransaction: string;
    }>();
    const enrollment = deferred<PremiumAuthorizationSnapshot>();
    const service = new PremiumService(accessPort({
      purchase: vi.fn(() => nativeResult.promise),
    }), {
      onAppleSignedTransaction: vi.fn(() => enrollment.promise),
      requireAppleSignedTransaction: true,
    });

    const purchase = service.purchase("monthly");
    await Promise.resolve();
    await expect(service.status()).resolves.toMatchObject({ status: "inactive" });

    nativeResult.resolve({
      outcome: "pending",
      access: activeAccess,
      appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature",
    });
    await expect(purchase).resolves.toMatchObject({ outcome: "pending" });
    await expect(service.status()).resolves.toMatchObject({ status: "inactive" });

    enrollment.resolve(activeAuthorization());
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({ status: "active" }));
  });

  test("reports a categorical retryable state after pending enrollment fails", async () => {
    const enrollment = deferred<void>();
    const service = new PremiumService(accessPort({
      purchase: vi.fn(async () => ({
        outcome: "pending" as const,
        access: activeAccess,
        appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature",
      })),
    }), {
      onAppleSignedTransaction: vi.fn(() => enrollment.promise),
      requireAppleSignedTransaction: true,
    });

    await expect(service.purchase("monthly")).resolves.toMatchObject({ outcome: "pending" });
    enrollment.reject(new Error("private verification detail"));
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({
      status: "unavailable",
      reason: "store_unavailable",
    }));
    await expect(service.status()).resolves.toEqual({
      entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable",
    });
  });

  test.each(["cancelled", "failed"] as const)("retains late %s after ordinary status consumes native recovery", async (outcome) => {
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recover = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ outcome, access: activeAccess, operationId }).mockResolvedValue(null);
    const purchase = vi.fn(async () => ({ outcome: "pending" as const, access: activeAccess, operationId }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const service = new PremiumService(accessPort({ purchase, recover }));
      await expect(service.purchase("monthly", operationId)).resolves.toMatchObject({ outcome: "pending" });
      await expect(service.operationResult(operationId)).resolves.toMatchObject({ outcome: "pending" });
      await service.status();
      await expect(service.operationResult(operationId)).resolves.toMatchObject({ outcome });
      await service.status();
      await expect(service.purchase("monthly", operationId)).resolves.toMatchObject({ outcome });
      expect(purchase).toHaveBeenCalledOnce();
      const completions = info.mock.calls.map(([line]) => JSON.parse(line.replace("[meetless-premium] ", "")))
        .filter((event) => event.stage === "plugin_completion");
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ outcome, operationId });
    } finally { info.mockRestore(); }
  });

  test("waits for old verified enrollment before dispatching a fresh UUID and enrolls each transaction once", async () => {
    const oldId = "12345678-1234-4123-8123-123456789abc";
    const newId = "12345678-1234-4123-8123-123456789abd";
    const enrollment = deferred<PremiumAuthorizationSnapshot>();
    const oldTransaction = "eyJhbGciOiJFUzI1NiJ9.old.signature";
    const newTransaction = "eyJhbGciOiJFUzI1NiJ9.new.signature";
    const enroll = vi.fn().mockReturnValueOnce(enrollment.promise).mockResolvedValue(activeAuthorization());
    const restore = vi.fn(async () => ({ outcome: "pending" as const, access: activeAccess, appleSignedTransaction: newTransaction, operationId: newId }));
    const recover = vi.fn().mockResolvedValueOnce({ outcome: "pending", access: activeAccess, appleSignedTransaction: oldTransaction, operationId: oldId }).mockResolvedValue(null);
    const service = new PremiumService(accessPort({ recover, restore }), { onAppleSignedTransaction: enroll, requireAppleSignedTransaction: true });
    const requested = service.restore(newId);
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce());
    expect(restore).not.toHaveBeenCalled();
    await expect(service.operationResult(newId)).resolves.toMatchObject({ outcome: "pending" });
    enrollment.resolve(activeAuthorization());
    await requested;
    await vi.waitFor(async () => expect(await service.operationResult(newId)).toMatchObject({ outcome: "active" }));
    await expect(service.operationResult(oldId)).resolves.toMatchObject({ outcome: "active" });
    await service.status();
    await service.restore(newId);
    expect(restore).toHaveBeenCalledExactlyOnceWith(newId);
    expect(enroll.mock.calls).toEqual([[oldTransaction], [newTransaction]]);
  });

  test("recovers through the real native socket after losing the dispatched purchase response", async () => {
    const directory = await mkdtemp("/private/tmp/meetless-premium-rpc-");
    const socketPath = `${directory}/p.sock`;
    const operationId = "12345678-1234-4123-8123-123456789abc";
    let purchased = 0;
    let recovered = false;
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.trim());
        if (request.operation === "premiumPurchase") {
          purchased += 1;
          expect(request.operationId).toBe(operationId);
          socket.destroy(); // StoreKit already owns the action; RPC response is lost.
          return;
        }
        const hasTerminal = request.operation === "premiumRecover" && purchased === 1 && !recovered;
        if (hasTerminal) recovered = true;
        socket.end(JSON.stringify({ version: 1, requestId: request.requestId, type: "premium.access",
          ok: hasTerminal, outcome: hasTerminal ? "cancelled" : "failed", access: activeAccess,
          ...(hasTerminal ? { operationId } : {}),
        }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const service = new PremiumService(new NativePremiumAccessPort(socketPath));
      await expect(service.purchase("monthly", operationId)).resolves.toMatchObject({ outcome: "pending" });
      await expect(service.operationResult(operationId)).resolves.toMatchObject({ outcome: "cancelled" });
      await expect(service.purchase("monthly", operationId)).resolves.toMatchObject({ outcome: "cancelled" });
      expect(purchased).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps a pending operation owned across a failed recovery observation", async () => {
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recover = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("private native detail"))
      .mockResolvedValueOnce({ outcome: "cancelled", access: activeAccess, operationId });
    const purchase = vi.fn(async () => ({ outcome: "pending" as const, access: activeAccess, operationId }));
    const service = new PremiumService(accessPort({ purchase, recover }));
    await service.purchase("monthly", operationId);
    await expect(service.operationResult(operationId)).resolves.toMatchObject({ outcome: "pending" });
    await expect(service.operationResult(operationId)).resolves.toMatchObject({ outcome: "cancelled" });
    expect(purchase).toHaveBeenCalledOnce();
  });

  test("emits categorical plugin completion diagnostics without exposing purchase data", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const service = new PremiumService(accessPort({
        purchase: vi.fn(async () => ({ outcome: "cancelled" as const, access: activeAccess })),
      }));

      await expect(service.purchase("monthly")).resolves.toEqual({
        outcome: "cancelled",
        access: { ...activeAccess, status: "inactive", reason: null },
      });
      const lines = info.mock.calls.map(([line]) => line);
      const events = lines.map((line) => JSON.parse(line.replace("[meetless-premium] ", "")));
      expect(events).toEqual([
        { stage: "plugin_rpc_dispatch", outcome: "started", operationId: expect.any(String), timestampMs: expect.any(Number) },
        { stage: "plugin_completion", outcome: "cancelled", operationId: events[0].operationId, timestampMs: expect.any(Number) },
      ]);
      expect(lines.join(" ")).not.toMatch(/monthly|premium\.monthly|receipt|signed|secret/u);
    } finally {
      info.mockRestore();
    }
  });

  test("does not emit native RPC purchase diagnostics for ordinary Premium status refresh", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const access = new NativePremiumAccessPort(`/private/tmp/meetless-premium-status-${Date.now()}.sock`);
      await expect(access.status()).rejects.toThrow();
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  test("separates plugin and native RPC dispatch diagnostics for a mutation", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const service = new PremiumService(new NativePremiumAccessPort(`/private/tmp/meetless-premium-purchase-${Date.now()}.sock`));
      await expect(service.purchase("monthly")).resolves.toEqual({
        outcome: "failed",
        access: { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
      });
      const events = info.mock.calls.map(([line]) => JSON.parse(line.replace("[meetless-premium] ", "")));
      expect(events).toEqual([
        { stage: "plugin_rpc_dispatch", outcome: "started", operationId: expect.any(String), timestampMs: expect.any(Number) },
        { stage: "native_rpc_dispatch", outcome: "started", operationId: events[0].operationId, timestampMs: expect.any(Number) },
        { stage: "plugin_completion", outcome: "failed", operationId: events[0].operationId, timestampMs: expect.any(Number) },
      ]);
    } finally {
      info.mockRestore();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}


describe("private Store environment transport", () => {
  test.each(["SANDBOX", "PRODUCTION"] as const)("passes %s enrollment context internally and strips it from renderer", async (environment) => {
    const onAppleSignedTransaction = vi.fn(async () => activeAuthorization());
    const access: PremiumAccessPort = {
      status: async () => activeAccess,
      purchase: async () => ({ outcome: "active", access: activeAccess, appleSignedTransaction: "opaque-proof", appleEnvironment: environment }),
      restore: async () => ({ outcome: "active", access: activeAccess, appleSignedTransaction: "opaque-restore", appleEnvironment: environment }),
      recover: async () => null,
    };
    const service = new PremiumService(access, { requireAppleSignedTransaction: true, onAppleSignedTransaction });
    const result = await service.purchase("monthly");
    expect(onAppleSignedTransaction).toHaveBeenCalledWith("opaque-proof", environment);
    expect(result).not.toHaveProperty("appleSignedTransaction");
    expect(result).not.toHaveProperty("appleEnvironment");
  });

  test.each(["SANDBOX", "PRODUCTION", undefined, "XCODE"])("requires matched environment on read-only proof (%s)", async (environment) => {
    const directory = await mkdtemp("/private/tmp/meetless-environment-rpc-");
    const socketPath = `${directory}/p.sock`;
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.trim());
        socket.end(JSON.stringify({ version: 1, requestId: request.requestId, type: "premium.access", ok: true, outcome: "status", access: activeAccess, appleSignedTransaction: "opaque-proof", ...(environment ? { appleEnvironment: environment } : {}) }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = new NativePremiumAccessPort(socketPath).readVerifiedTransaction();
      if (environment === "SANDBOX" || environment === "PRODUCTION") await expect(result).resolves.toEqual({ signedTransaction: "opaque-proof", environment });
      else await expect(result).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("private read-only Apple evidence transport", () => {
  test.each(["opaque-signed-proof", undefined])("returns optional evidence only to trusted caller (%s)", async (proof) => {
    const directory = await mkdtemp("/private/tmp/meetless-proof-rpc-");
    const socketPath = `${directory}/p.sock`;
    const operations: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.trim());
        operations.push(request.operation);
        socket.end(JSON.stringify({ version: 1, requestId: request.requestId, type: "premium.access",
          ok: true, outcome: "status", access: activeAccess,
          ...(proof ? { appleSignedTransaction: proof } : {}),
        }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(new NativePremiumAccessPort(socketPath).readSignedTransaction()).resolves.toBe(proof ?? null);
      expect(operations).toEqual(["premiumTransaction"]);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each(["eof", "legacy-unsupported", "denied", "malformed"])("fails closed on %s rather than treating it as missing evidence", async (mode) => {
    const directory = await mkdtemp("/private/tmp/meetless-proof-denied-");
    const socketPath = `${directory}/p.sock`;
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.trim());
        if (mode === "eof") { socket.destroy(); return; }
        const response = mode === "legacy-unsupported"
          ? { version: 1, requestId: request.requestId, ok: false, status: "invalid", error: "transcription unavailable" }
          : { version: 1, requestId: request.requestId, type: "premium.access", ok: mode !== "denied",
              outcome: "status", access: activeAccess, ...(mode === "malformed" ? { appleSignedTransaction: { private: "secret-proof" } } : {}) };
        socket.end(JSON.stringify(response) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = new NativePremiumAccessPort(socketPath).readSignedTransaction();
      await expect(result).rejects.toThrow(/Premium .* unavailable/);
      await expect(result).rejects.not.toThrow("secret-proof");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

});
