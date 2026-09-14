import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { AppStoreServerAPIClient, SignedDataVerifier, Status } from "@apple/app-store-server-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyCurrentAppleSubscription, normalizeAppleSubscriptionStatus } from "../convex/appleSubscriptionStatusNode";
import { MANAGED_APPLE_BUNDLE_ID, MANAGED_MONTHLY_PRODUCT_ID, MANAGED_ANNUAL_PRODUCT_ID, MANAGED_REVENUECAT_APP_ID, readManagedRuntimeConfig } from "../convex/managedConfig";
import { lineageKeyForOriginalTransactionId } from "../convex/appleSubscription";
import { reconcileVerifiedSubscription, applySubscriptionProjection } from "../convex/managedSubscriptionReconciliation";
import { receiveRevenueCatEvent } from "../convex/managedAuth";
import { processRevenueCatEvent } from "../convex/managedAuthActions";
import http from "../convex/http";
import { revenueCatHmacHeader } from "../convex/revenueCatWebhook";

// Local fixtures and controlled SDK transport only; no real Apple credential,
// Apple trust chain, RevenueCat delivery, or production acceptance is asserted.
const now = Date.UTC(2026, 8, 14);
const original = "1234567890";
const root = new X509Certificate(rootCertificates[0]!).raw.toString("base64");
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
function environment() {
  return { MEETLESS_DEPLOYMENT_MODE: "production", MEETLESS_MANAGED_ALLOWANCE_SECONDS: "28800", MEETLESS_MANAGED_ALLOWANCE_SOURCE: "production-config", MEETLESS_MANAGED_PROVIDER_MODE: "real", OPENAI_API_KEY: "fixture",
    MEETLESS_APPLE_VERIFIER_MODE: "app-store-server-api", MEETLESS_APPLE_APP_ID: "6807070739", MEETLESS_APPLE_ROOT_CERTIFICATES_BASE64: root,
    MEETLESS_APPLE_API_ISSUER_ID: "fixture-issuer", MEETLESS_APPLE_API_KEY_ID: "fixture-key", MEETLESS_APPLE_API_PRIVATE_KEY_PKCS8: key,
    MEETLESS_AUTH_ISSUER: "https://api.meetless.app", MEETLESS_AUTH_AUDIENCE: "managed", MEETLESS_AUTH_KEY_ID: "managed-key", MEETLESS_AUTH_PRIVATE_KEY_PKCS8: key,
    MEETLESS_AUTH_PUBLIC_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y", alg: "ES256", use: "sig", kid: "managed-key" }),
    MEETLESS_REVENUECAT_AUTH_MODE: "hmac", MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET: "fixture-secret", MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION" };
}
const config = () => readManagedRuntimeConfig(environment());
const transaction = (overrides = {}) => ({ bundleId: MANAGED_APPLE_BUNDLE_ID, productId: MANAGED_MONTHLY_PRODUCT_ID, environment: "Production", originalTransactionId: original,
  type: "Auto-Renewable Subscription", originalPurchaseDate: now - 100_000, purchaseDate: now - 100_000, signedDate: now - 1000, expiresDate: now + 100_000, ...overrides });
const renewal = (overrides = {}) => ({ environment: "Production", originalTransactionId: original, productId: MANAGED_MONTHLY_PRODUCT_ID, signedDate: now, ...overrides });
const response = (status = Status.ACTIVE, overrides = {}) => ({ environment: "Production", bundleId: MANAGED_APPLE_BUNDLE_ID, appAppleId: 6807070739,
  data: [{ subscriptionGroupIdentifier: "group", lastTransactions: [{ originalTransactionId: original, status, signedTransactionInfo: "a.b.c", signedRenewalInfo: "d.e.f" }] }], ...overrides });
const verifier = (tx = {}, rn = {}) => ({ verifyAndDecodeTransaction: async () => transaction(tx), verifyAndDecodeRenewalInfo: async () => renewal(rn) });
async function proof(status = Status.ACTIVE, tx = {}, rn = {}) { return normalizeAppleSubscriptionStatus(response(status), original, config(), verifier(tx, rn), now); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function database() {
  const tables: Record<string, any[]> = Object.fromEntries(["managedLineages", "managedAccounts", "managedPeriods", "managedPrincipals", "managedJobs", "managedJobParts", "managedRevenueCatEvents"].map(name => [name, []]));
  let nextId = 0;
  const db = {
    get: async (id: string) => structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null),
    insert: async (table: string, value: any) => { const _id = `id-${++nextId}`; tables[table]!.push({ _id, ...value }); return _id; },
    patch: async (id: string, patch: any) => Object.assign(Object.values(tables).flat().find(row => row._id === id)!, patch),
    query: (table: string) => {
      let rows = structuredClone(tables[table]!);
      const query: any = { withIndex: (_name: string, choose: any) => { const q = { eq: (field: string, value: any) => { rows = rows.filter(row => row[field] === value); return q; } }; choose(q); return query; },
        unique: async () => { if (rows.length > 1) throw new Error("duplicate"); return rows[0] ?? null; }, collect: async () => rows, take: async (count: number) => rows.slice(0, count), order: () => query };
      return query;
    },
  };
  return { tables, ctx: { db } as never };
}
async function event() { return { eventId: "event", lineageKey: await lineageKeyForOriginalTransactionId(original), appId: MANAGED_REVENUECAT_APP_ID, productId: MANAGED_MONTHLY_PRODUCT_ID, environment: "PRODUCTION" as const, eventType: "RENEWAL", eventTimestampMs: now }; }
function stubEnvironment() { for (const [name, value] of Object.entries(environment())) vi.stubEnv(name, value); vi.spyOn(Date, "now").mockReturnValue(now); }

describe("Apple current subscription normalization", () => {
  test("active and plan-switch proof contain only normalized fields", async () => {
    const result = await proof(Status.ACTIVE, { productId: MANAGED_ANNUAL_PRODUCT_ID }, { productId: MANAGED_ANNUAL_PRODUCT_ID });
    expect(result).toMatchObject({ product: "annual", currentState: "active", renewalSignedAtMs: now });
    expect(JSON.stringify(result)).not.toContain(original);
    expect(result).not.toHaveProperty("signedTransactionInfo");
  });
  test("signed grace expiry is separate from the paid term and expires naturally", async () => {
    const result = await proof(Status.BILLING_GRACE_PERIOD, { expiresDate: now - 100 }, { gracePeriodExpiresDate: now + 20_000 });
    expect(result).toMatchObject({ currentState: "grace", expiresAtMs: now - 100, gracePeriodExpiresAtMs: now + 20_000 });
    expect(await proof(Status.BILLING_GRACE_PERIOD, { expiresDate: now - 2000 }, { gracePeriodExpiresDate: now - 1000 })).toMatchObject({ currentState: "expired" });
  });
  test.each([Status.EXPIRED, Status.BILLING_RETRY, Status.REVOKED])("normalizes terminal status %s from signed evidence", async status => {
    expect(await proof(status, status === Status.REVOKED ? { revocationDate: now - 1 } : { expiresDate: now - 1 })).toMatchObject({ currentState: status === Status.REVOKED ? "refunded" : "expired" });
  });
  test.each([{ environment: "Sandbox" }, { bundleId: "other" }, { appAppleId: 1 }, { data: [] }])("rejects response mismatch %j", async override => {
    await expect(normalizeAppleSubscriptionStatus(response(Status.ACTIVE, override), original, config(), verifier(), now)).rejects.toThrow();
  });
  test.each([{ originalTransactionId: "other" }, { environment: "Sandbox" }, { productId: "other" }, { signedDate: now + 400_000 }])("rejects signed renewal mismatch %j", async override => { await expect(proof(Status.ACTIVE, {}, override)).rejects.toThrow(); });
  test("rejects missing grace and unsigned revocation", async () => {
    await expect(proof(Status.BILLING_GRACE_PERIOD)).rejects.toThrow("grace bounds");
    await expect(proof(Status.REVOKED)).rejects.toThrow("signed revocation");
  });
});

describe("official SDK boundary with controlled transport", () => {
  test("runs SDK request signing, status response validation, and both verifier calls", async () => {
    const transport = vi.spyOn(AppStoreServerAPIClient.prototype as any, "makeFetchRequest").mockResolvedValue(new Response(JSON.stringify(response())));
    const tx = vi.spyOn(SignedDataVerifier.prototype, "verifyAndDecodeTransaction").mockResolvedValue(transaction() as any);
    const rn = vi.spyOn(SignedDataVerifier.prototype, "verifyAndDecodeRenewalInfo").mockResolvedValue(renewal() as any);
    expect(await verifyCurrentAppleSubscription(original, config(), now)).toMatchObject({ currentState: "active" });
    expect(transport.mock.calls[0]![0]).toBe(`/inApps/v1/subscriptions/${original}`);
    expect((transport.mock.calls[0]![4] as any).Authorization).toMatch(/^Bearer /);
    expect(tx).toHaveBeenCalledWith("a.b.c"); expect(rn).toHaveBeenCalledWith("d.e.f");
  });
  test("real verifier rejects bogus JWS and SDK failure never echoes raw payload", async () => {
    vi.spyOn(AppStoreServerAPIClient.prototype as any, "makeFetchRequest").mockResolvedValue(new Response(JSON.stringify(response())));
    await expect(verifyCurrentAppleSubscription(original, config(), now)).rejects.toThrow("unavailable or unverified");
    vi.spyOn(AppStoreServerAPIClient.prototype as any, "makeFetchRequest").mockRejectedValue(new Error(`secret ${original} a.b.c`));
    await expect(verifyCurrentAppleSubscription(original, config(), now)).rejects.toThrow(/^Apple subscription verification failed: Apple status reconciliation unavailable or unverified$/);
  });
  test("deadline returns failure while transport hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(AppStoreServerAPIClient.prototype as any, "makeFetchRequest").mockReturnValue(new Promise(() => {}));
    const attempt = expect(verifyCurrentAppleSubscription(original, config(), now)).rejects.toThrow("unavailable or unverified");
    await vi.advanceTimersByTimeAsync(20_000); await attempt;
  });
});

describe("synchronous webhook and atomic mutation handlers (local DB adapter)", () => {
  test("Apple failure produces retry and no mutation", async () => {
    stubEnvironment(); vi.spyOn(AppStoreServerAPIClient.prototype as any, "makeFetchRequest").mockRejectedValue(new Error("private"));
    const runMutation = vi.fn();
    expect(await processRevenueCatEvent._handler({ runMutation } as never, { event: await event(), originalTransactionId: original })).toEqual({ outcome: "retry" });
    expect(runMutation).not.toHaveBeenCalled();
  });
  test("pending legacy receipt is reconciled, duplicate preserves quota, and stale event accepts verified plan switch", async () => {
    stubEnvironment(); const f = database(); const e = await event();
    f.tables.managedRevenueCatEvents!.push({ _id: "legacy", ...e, receivedAt: now - 1, processedAt: now - 1, reconciliationStatus: "awaiting-apple-verification" });
    await expect(receiveRevenueCatEvent._handler(f.ctx, { event: e })).rejects.toThrow("requires verified Apple");
    expect(f.tables.managedRevenueCatEvents![0]!.reconciliationStatus).toBe("awaiting-apple-verification");
    const apple = await proof(Status.ACTIVE, { productId: MANAGED_ANNUAL_PRODUCT_ID }, { productId: MANAGED_ANNUAL_PRODUCT_ID });
    expect(await receiveRevenueCatEvent._handler(f.ctx, { event: e, apple })).toMatchObject({ outcome: "reconciled" });
    f.tables.managedPeriods![0]!.usedSeconds = 123;
    expect(await receiveRevenueCatEvent._handler(f.ctx, { event: e, apple })).toMatchObject({ outcome: "duplicate" });
    expect(f.tables.managedPeriods).toHaveLength(1); expect(f.tables.managedPeriods![0]!.usedSeconds).toBe(123);
    await expect(receiveRevenueCatEvent._handler(f.ctx, { event: { ...e, eventType: "EXPIRATION" }, apple })).rejects.toThrow("rebound");
  });
  test("grace projects access without changing Sandbox cadence and older enrollment cannot erase it", async () => {
    const f = database();
    const paid = { ...await proof(), environment: "SANDBOX" as const, renewalSignedAtMs: undefined };
    const allowance = { allowanceSeconds: 1800, allowanceSource: "store-testing-sandbox" };
    await reconcileVerifiedSubscription(f.ctx, paid, allowance, now);
    const duration = f.tables.managedAccounts![0]!.quotaSchedule.termDurationMs;
    f.tables.managedPrincipals!.push({ _id: "principal", accountId: paid.accountId, revokedAt: null });
    const grace = { ...paid, currentState: "grace" as const, renewalSignedAtMs: now + 200_000,
      gracePeriodExpiresAtMs: now + 400_000, verifiedAtMs: now + 200_000 };
    await reconcileVerifiedSubscription(f.ctx, grace, allowance, now + 200_000);
    expect(f.tables.managedAccounts![0]!.quotaSchedule.termDurationMs).toBe(duration);
    expect(f.tables.managedLineages![0]!.expiresAt).toBe(paid.expiresAtMs);
    expect(f.tables.managedPrincipals![0]).toMatchObject({ entitlement: "grace", naturalExpiryAt: now + 400_000 });
    await reconcileVerifiedSubscription(f.ctx, { ...paid, currentState: "expired", verifiedAtMs: now + 210_000 }, allowance, now + 210_000);
    expect(f.tables.managedPrincipals![0]!.entitlement).toBe("grace");
    // Enrollment can re-sign the same transaction after the renewal JWS. It
    // still contains no authoritative information about billing grace.
    await reconcileVerifiedSubscription(f.ctx, { ...paid, currentState: "expired", transactionSignedAtMs: now + 220_000, verifiedAtMs: now + 220_000 }, allowance, now + 220_000);
    expect(f.tables.managedPrincipals![0]).toMatchObject({ entitlement: "grace", naturalExpiryAt: now + 400_000 });
    expect(f.tables.managedLineages![0]!.renewalSignedAt).toBe(grace.renewalSignedAtMs);
    await applySubscriptionProjection(f.ctx, f.tables.managedLineages![0]!, now + 400_000);
    expect(f.tables.managedPrincipals![0]!.entitlement).toBe("expired");
  });
  test("the same signed grace evidence expires naturally only after its unchanged bound", async () => {
    const f = database();
    const allowance = { allowanceSeconds: 28_800, allowanceSource: "production-config" };
    const grace = await proof(Status.BILLING_GRACE_PERIOD, { expiresDate: now - 100 }, { gracePeriodExpiresDate: now + 20_000 });
    await reconcileVerifiedSubscription(f.ctx, grace, allowance, now);
    f.tables.managedPrincipals!.push({ _id: "principal", accountId: grace.accountId, revokedAt: null });
    await expect(reconcileVerifiedSubscription(f.ctx, { ...grace, currentState: "expired", verifiedAtMs: now + 10_000 }, allowance, now + 10_000)).rejects.toThrow("conflicts at the same signed version");
    const afterGrace = await normalizeAppleSubscriptionStatus(response(Status.BILLING_GRACE_PERIOD), original, config(),
      verifier({ expiresDate: now - 100 }, { gracePeriodExpiresDate: now + 20_000 }), now + 20_000);
    expect(afterGrace.currentState).toBe("expired");
    await reconcileVerifiedSubscription(f.ctx, afterGrace, allowance, now + 20_000);
    expect(f.tables.managedLineages![0]!.currentState).toBe("expired");
    expect(f.tables.managedPrincipals![0]!.entitlement).toBe("expired");
    await reconcileVerifiedSubscription(f.ctx, afterGrace, allowance, now + 20_001);
    expect(f.tables.managedPeriods).toHaveLength(1);
  });
  test("signed revocation and a new paid term can supersede grace", async () => {
    for (const kind of ["revocation", "new-term"] as const) {
      const f = database(); const allowance = { allowanceSeconds: 28_800, allowanceSource: "production-config" };
      const grace = await proof(Status.BILLING_GRACE_PERIOD, { expiresDate: now - 100 }, { gracePeriodExpiresDate: now + 20_000 });
      await reconcileVerifiedSubscription(f.ctx, grace, allowance, now);
      const next = { ...grace, gracePeriodExpiresAtMs: undefined, renewalSignedAtMs: undefined,
        currentState: kind === "revocation" ? "refunded" as const : "active" as const,
        transactionSignedAtMs: now + 1, verifiedAtMs: now + 1,
        ...(kind === "new-term" ? { transactionPurchaseAtMs: now, expiresAtMs: now + 100_000 } : {}) };
      await reconcileVerifiedSubscription(f.ctx, next, allowance, now + 1);
      expect(f.tables.managedLineages![0]!.currentState).toBe(next.currentState);
    }
  });
  test("HTTP success waits for reconciliation; failure gives503 and authenticated redelivery can succeed", async () => {
    stubEnvironment(); const body = JSON.stringify({ event: { id: "event", app_id: MANAGED_REVENUECAT_APP_ID, product_id: MANAGED_MONTHLY_PRODUCT_ID, original_transaction_id: original, environment: "PRODUCTION", type: "RENEWAL", event_timestamp_ms: now } });
    const signature = await revenueCatHmacHeader(new TextEncoder().encode(body), "fixture-secret", now / 1000);
    const handler = (http.lookup("/webhooks/revenuecat", "POST")![0] as any)._handler;
    const request = () => new Request("https://example.com/webhooks/revenuecat", { method: "POST", body, headers: { "x-revenuecat-webhook-signature": signature } });
    const runAction = vi.fn().mockResolvedValueOnce({ outcome: "retry" }).mockResolvedValueOnce({ outcome: "reconciled" });
    expect((await handler({ runAction }, request())).status).toBe(503);
    expect((await handler({ runAction }, request())).status).toBe(200);
    expect(runAction.mock.calls[0]![1]).toMatchObject({ originalTransactionId: original, event: { lineageKey: await lineageKeyForOriginalTransactionId(original) } });
    const invalid = new Request("https://example.com/webhooks/revenuecat", { method: "POST", body });
    expect((await handler({ runAction }, invalid)).status).toBe(401); expect(runAction).toHaveBeenCalledTimes(2);
  });
});
