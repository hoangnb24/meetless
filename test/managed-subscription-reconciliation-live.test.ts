import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startManagedConvexHarness, twoPartManifest } from "./managed-convex-production-harness";

type Harness = Awaited<ReturnType<typeof startManagedConvexHarness>>;
let runtime: Harness;

// Real localhost Convex mutations/actions and transaction retries. Apple proof
// and provider output remain explicitly fixture-only, not purchase acceptance.
describe("subscription reconciliation through the actual local Convex handlers", () => {
  beforeAll(async () => {
    runtime = await startManagedConvexHarness({ initialSubscriptionDurationMs: 10_000 });
  }, 120_000);
  afterAll(async () => { await runtime?.stop(); }, 30_000);

  test("reopens an expired subscription once, preserves old settlement, and refuses identity/replay regressions", async () => {
    const oldUpload = await runtime.uploadAndRegister(twoPartManifest("old-period-reserved", [96_000, 96_000]));
    const oldJob = await runtime.invoke<any>("action", "managedTranscriptionActions:sealUpload", oldUpload, runtime.device.token);
    expect(oldJob.status).toBe("reserved");
    expect(await runtime.quota()).toMatchObject({ limitSeconds: 20, usedSeconds: 0, reservedSeconds: 12 });

    // Re-verifying the same purchase must not replenish its available balance.
    await runtime.refreshApple();
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 12 });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, runtime.apple.expiresAtMs - Date.now() + 30)));

    const purchaseAt = Date.now();
    const renewal = {
      transactionReason: "PURCHASE" as const,
      transactionPurchaseAtMs: purchaseAt,
      transactionSignedAtMs: purchaseAt,
      expiresAtMs: purchaseAt + 86_400_000,
      currentState: "active" as const,
    };
    // Two devices/events racing the same period must create one allowance.
    const refreshed = await Promise.all([runtime.refreshApple(renewal), runtime.refreshApple(renewal)]);
    expect(refreshed.map((value) => value.state)).toEqual(["active", "active"]);
    const currentToken = refreshed[0]!.authToken;
    expect(await runtime.quota()).toMatchObject({ limitSeconds: 20, usedSeconds: 0, reservedSeconds: 0 });

    // Work admitted in the old period settles against that old reservation.
    await runtime.invoke("action", "managedTranscriptionActions:runProvider", { jobId: oldJob._id }, currentToken);
    expect(await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: oldJob._id }, currentToken))
      .toMatchObject({ status: "provider_completed" });
    await runtime.invoke("mutation", "managedTranscription:settleJob", { jobId: oldJob._id }, currentToken);
    await runtime.invoke("mutation", "managedTranscription:settleJob", { jobId: oldJob._id }, currentToken);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 0 });

    const newUpload = await runtime.uploadAndRegister(twoPartManifest("new-period-charge", [96_000, 96_000]));
    const newJob = await runtime.invoke<any>("action", "managedTranscriptionActions:sealUpload", newUpload, currentToken);
    await runtime.invoke("action", "managedTranscriptionActions:runProvider", { jobId: newJob._id }, currentToken);
    expect(await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: newJob._id }, currentToken))
      .toMatchObject({ status: "provider_completed" });
    await runtime.invoke("mutation", "managedTranscription:settleJob", { jobId: newJob._id }, currentToken);
    expect(await runtime.quota()).toMatchObject({ limitSeconds: 20, usedSeconds: 12, reservedSeconds: 0 });

    await runtime.refreshApple(renewal);
    const older = await runtime.refreshApple();
    expect(older.state).toBe("active");
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 12, reservedSeconds: 0 });

    await expect(runtime.refreshApple({
      ...renewal, originalTransactionId: "different-verified-fixture-lineage",
    })).rejects.toThrow(/account|lineage/i);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 12, reservedSeconds: 0 });

    const denied = await runtime.invoke<any>("mutation", "managedTranscription:beginUpload", {
      manifest: twoPartManifest("remaining-quota-denial", [96_000, 96_000]).manifest,
    }, currentToken);
    expect(denied).toMatchObject({ kind: "managed_quota_insufficient", requiredSeconds: 12, remainingSeconds: 8 });
  }, 120_000);
});
