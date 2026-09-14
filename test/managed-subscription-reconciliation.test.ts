import { describe, expect, test } from "vitest";
import { anchoredCalendarMonth, quotaPeriodForSchedule, quotaScheduleForTerm, verifiedQuotaPeriod } from "../convex/managedQuotaPolicy";
import { advanceVerifiedQuotaPeriod, reconcileVerifiedSubscription } from "../convex/managedSubscriptionReconciliation";
import { normalizeVerifiedAppleTransaction, MANAGED_APPLE_BUNDLE_ID, MANAGED_MONTHLY_PRODUCT_ID, type VerifiedAppleSubscriptionLineage } from "../convex/appleSubscription";

const JAN = Date.UTC(2026, 0, 31, 12);
const FEB = Date.UTC(2026, 1, 28, 12);
const MAR = Date.UTC(2026, 2, 31, 12);
const APR = Date.UTC(2026, 3, 30, 12);
const allowance = { allowanceSeconds: 28_800, allowanceSource: "product-approved" };
function proof(overrides: Partial<VerifiedAppleSubscriptionLineage> = {}): VerifiedAppleSubscriptionLineage {
  return { adapter: "app-store-server-api", accountId: "apple-account:private-hash", lineageKey: "apple-lineage:private-hash",
    appId: "app", bundleId: "bundle", productId: "monthly", product: "monthly", environment: "PRODUCTION", periodType: "normal",
    startedAtMs: JAN, transactionPurchaseAtMs: JAN, transactionSignedAtMs: JAN, transactionReason: "PURCHASE", expiresAtMs: FEB,
    currentState: "active", verifiedAtMs: JAN, ...overrides };
}
function database() {
  const tables: Record<string, any[]> = Object.fromEntries(["managedLineages", "managedAccounts", "managedPeriods", "managedPrincipals", "managedJobs", "managedJobParts", "managedRevenueCatEvents", "managedCharges"].map(name => [name, []]));
  let nextId = 0;
  const db = {
    get: async (id: string) => structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null),
    insert: async (table: string, value: any) => { const _id = `id-${++nextId}`; tables[table]!.push({ _id, ...value }); return _id; },
    patch: async (id: string, patch: any) => Object.assign(Object.values(tables).flat().find(row => row._id === id)!, patch),
    query: (table: string) => {
      let selected = structuredClone(tables[table]!);
      const selection: any = {
        withIndex: (_name: string, choose: (q: any) => unknown) => {
          const q = { eq: (field: string, value: unknown) => { selected = selected.filter(row => row[field] === value); return q; } };
          choose(q); return selection;
        },
        order: (direction: string) => { if (direction === "desc") selected.reverse(); return selection; },
        unique: async () => { if (selected.length > 1) throw new Error("duplicate indexed row"); return selected[0] ?? null; },
        collect: async () => selected, take: async (count: number) => selected.slice(0, count),
      };
      return selection;
    },
  };
  const ctx = { db } as never;
  return { tables, ctx, reconcile: (value: VerifiedAppleSubscriptionLineage, now: number, requiredAccountId?: string) => reconcileVerifiedSubscription(ctx, value, allowance, now, requiredAccountId) };
}

describe("verified quota allocation boundaries", () => {
  test("annual allocation uses independently clamped calendar months and catches up without backfilling", () => {
    expect(anchoredCalendarMonth(JAN, 1)).toBe(FEB);
    expect(anchoredCalendarMonth(JAN, 2)).toBe(MAR);
    const term = { product: "annual" as const, environment: "PRODUCTION" as const, startedAt: JAN,
      transactionPurchaseAt: JAN, transactionSignedAt: JAN, expiresAt: Date.UTC(2027, 0, 31, 12) };
    expect(verifiedQuotaPeriod(term, FEB - 1)).toEqual({ startAt: JAN, endAt: FEB });
    expect(verifiedQuotaPeriod(term, FEB)).toEqual({ startAt: FEB, endAt: MAR });
    expect(verifiedQuotaPeriod(term, APR)).toEqual({ startAt: APR, endAt: Date.UTC(2026, 4, 31, 12) });
    expect(() => verifiedQuotaPeriod({ ...term, transactionSignedAt: undefined }, FEB)).toThrow("fresh authoritative");
  });
  test("monthly and trial allocations are bounded by verified purchase and expiry", () => {
    for (const product of ["monthly", "trial"] as const) expect(verifiedQuotaPeriod({ product, environment: "SANDBOX", startedAt: JAN,
      transactionPurchaseAt: FEB, transactionSignedAt: FEB, expiresAt: MAR }, FEB)).toEqual({ startAt: FEB, endAt: MAR });
  });
});

describe("atomic subscription reconciliation logic (local DB adapter)", () => {
  test("purchase, repeated renewal, missed periods, and out-of-order evidence preserve historical accounting", async () => {
    const f = database();
    await f.reconcile(proof(), JAN);
    const oldPeriod = f.tables.managedPeriods[0]!;
    oldPeriod.usedSeconds = 23; oldPeriod.reservedSeconds = 12;
    f.tables.managedCharges.push({ _id: "charge", accountId: proof().accountId, chargedSeconds: 23 });
    const renewal = proof({ transactionPurchaseAtMs: FEB, transactionSignedAtMs: FEB, expiresAtMs: MAR, verifiedAtMs: FEB });
    await f.reconcile(renewal, FEB);
    await f.reconcile(renewal, FEB + 1);
    expect(f.tables.managedPeriods).toHaveLength(2);
    expect(oldPeriod).toMatchObject({ usedSeconds: 23, reservedSeconds: 12 });
    f.tables.managedPeriods[1]!.usedSeconds = 42;
    await f.reconcile(proof({ verifiedAtMs: FEB + 2 }), FEB + 2);
    expect(f.tables.managedPeriods).toHaveLength(2);
    expect(f.tables.managedAccounts[0]).toMatchObject({ currentPeriodStartAt: FEB, currentPeriodEndAt: MAR });
    expect(f.tables.managedLineages[0]).toMatchObject({ transactionPurchaseAt: FEB, transactionSignedAt: FEB, expiresAt: MAR });
    const missed = proof({ transactionPurchaseAtMs: APR, transactionSignedAtMs: APR, expiresAtMs: Date.UTC(2026, 4, 31, 12), verifiedAtMs: APR });
    await f.reconcile(missed, APR);
    expect(f.tables.managedPeriods).toHaveLength(3);
    expect(f.tables.managedPeriods[1]).toMatchObject({ usedSeconds: 42 });
    expect(f.tables.managedCharges).toHaveLength(1);
  });
  test("a lapse anchors the new quota to the new verified purchase, not original start or refresh time", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    const purchase = MAR + 100_000;
    await f.reconcile(proof({ transactionPurchaseAtMs: purchase, transactionSignedAtMs: purchase, expiresAtMs: APR, verifiedAtMs: purchase }), purchase + 25_000);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: purchase, endAt: anchoredCalendarMonth(purchase, 1), usedSeconds: 0, reservedSeconds: 0 });
  });
  test("product change and trial conversion preserve the active period and snapshot", async () => {
    const f = database(); await f.reconcile(proof({ product: "trial", periodType: "trial" }), JAN);
    const old = f.tables.managedPeriods[0]!; old.usedSeconds = 500;
    expect(old.limitSeconds).toBe(18_000);
    const purchase = JAN + 1000;
    const annual = proof({ product: "annual", productId: "annual", transactionPurchaseAtMs: purchase, transactionSignedAtMs: purchase,
      expiresAtMs: Date.UTC(2027, 0, 31, 12) + 1000, verifiedAtMs: purchase });
    await f.reconcile(annual, purchase);
    expect(f.tables.managedPeriods).toHaveLength(1);
    expect(old).toMatchObject({ startAt: JAN, endAt: FEB, usedSeconds: 500, limitSeconds: 18_000 });
    await f.reconcile({ ...annual, verifiedAtMs: FEB }, FEB);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: FEB, endAt: Date.UTC(2026, 2, 28, 12), limitSeconds: 28_800 });
    expect(old.usedSeconds).toBe(500);
  });
  test("a stored verified annual term releases only the current month's allowance", async () => {
    const f = database();
    await f.reconcile(proof({ product: "annual", productId: "annual", expiresAtMs: Date.UTC(2027, 0, 31, 12) }), JAN);
    const old = f.tables.managedPeriods[0]!; old.reservedSeconds = 9;
    await advanceVerifiedQuotaPeriod(f.ctx, f.tables.managedAccounts[0], f.tables.managedLineages[0], APR);
    expect(f.tables.managedPeriods).toHaveLength(2);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: APR, endAt: Date.UTC(2026, 4, 31, 12) });
    expect(old.reservedSeconds).toBe(9);
  });
  test("a configured allowance change never modifies a started snapshot", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    await reconcileVerifiedSubscription(f.ctx, proof(), { allowanceSeconds: 30_000, allowanceSource: "later-approved" }, JAN + 1);
    expect(f.tables.managedPeriods[0]!.limitSeconds).toBe(28_800);
    await reconcileVerifiedSubscription(f.ctx, proof({ transactionPurchaseAtMs: FEB, transactionSignedAtMs: FEB, expiresAtMs: MAR, verifiedAtMs: FEB }), { allowanceSeconds: 31_000, allowanceSource: "next-approved" }, FEB);
    expect(f.tables.managedPeriods[1]!.limitSeconds).toBe(31_000);
  });
  test("same signed-version conflicting facts and malformed dates fail closed", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    await expect(f.reconcile(proof({ expiresAtMs: MAR }), JAN)).rejects.toThrow("conflicts at the same signed version");
    await expect(f.reconcile(proof({ transactionPurchaseAtMs: NaN }), JAN)).rejects.toThrow("invalid transaction dates");
    await expect(f.reconcile(proof({ transactionSignedAtMs: JAN + 1_000_000 }), JAN)).rejects.toThrow("invalid transaction dates");
    expect(f.tables.managedPeriods).toHaveLength(1);
  });
  test("natural expiration of unchanged signed evidence does not invent a conflicting version or renew quota", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    const result = await f.reconcile(proof({ currentState: "expired", verifiedAtMs: FEB }), FEB);
    expect(result.entitlement).toBe("expired"); expect(f.tables.managedPeriods).toHaveLength(1);
  });
  test("refresh proof cannot change account or create an enrollment", async () => {
    const f = database();
    await expect(f.reconcile(proof(), JAN, "different-account")).rejects.toThrow("does not match the enrolled account");
    expect(f.tables.managedLineages).toHaveLength(0);
    await expect(f.reconcile(proof(), JAN, proof().accountId)).rejects.toThrow("cannot create a quota account");
  });
  test("legacy rows upgrade through verified evidence without shortening their known term", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    delete f.tables.managedLineages[0]!.transactionPurchaseAt; delete f.tables.managedLineages[0]!.transactionSignedAt;
    delete f.tables.managedAccounts[0]!.quotaSchedule;
    await expect(f.reconcile(proof({ expiresAtMs: JAN + 1000 }), JAN)).rejects.toThrow("does not shorten");
    await f.reconcile(proof({ transactionPurchaseAtMs: FEB, transactionSignedAtMs: FEB, expiresAtMs: MAR, verifiedAtMs: FEB }), FEB);
    expect(f.tables.managedLineages[0]).toMatchObject({ transactionPurchaseAt: FEB, transactionSignedAt: FEB });
    expect(f.tables.managedPeriods).toHaveLength(2);
  });
  test("refund stops active jobs and unfinished parts, releases once, and cannot be resurrected by an old transaction", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    const period = f.tables.managedPeriods[0]!; period.reservedSeconds = 10; period.usedSeconds = 7;
    f.tables.managedJobs.push({ _id: "job", accountId: proof().accountId, status: "running", periodStartAt: JAN, billableSeconds: 10, executionToken: "private-token" });
    f.tables.managedJobParts.push({ _id: "part", jobId: "job", status: "running", executionToken: "private-token" }, { _id: "done", jobId: "job", status: "completed" });
    f.tables.managedPrincipals.push({ _id: "active", accountId: proof().accountId, revokedAt: null }, { _id: "other", accountId: proof().accountId, revokedAt: null }, { _id: "revoked", accountId: proof().accountId, revokedAt: JAN, entitlement: "revoked" });
    const refund = proof({ transactionSignedAtMs: JAN + 1, verifiedAtMs: JAN + 1, currentState: "refunded" });
    await f.reconcile(refund, JAN + 1); await f.reconcile(refund, JAN + 2);
    expect(period).toMatchObject({ usedSeconds: 7, reservedSeconds: 0 });
    expect(f.tables.managedJobs[0]).toMatchObject({ status: "stopped", executionToken: null });
    expect(f.tables.managedJobParts[0]).toMatchObject({ status: "failed", executionToken: null, leaseExpiresAt: 0 });
    expect(f.tables.managedJobParts[1]!.status).toBe("completed");
    expect(f.tables.managedPrincipals.map(row => row.entitlement)).toEqual(["refunded", "refunded", "revoked"]);
    expect((await f.reconcile(proof({ transactionSignedAtMs: JAN + 5, verifiedAtMs: JAN + 5 }), JAN + 5)).entitlement).toBe("refunded");
  });
  test("only matching purchase events proven by signed dates resolve; unrelated/later events remain pending", async () => {
    const f = database();
    const event = { lineageKey: proof().lineageKey, productId: "monthly", appId: "app", environment: "PRODUCTION", eventTimestampMs: JAN, reconciliationStatus: "awaiting-apple-verification", processedAt: null };
    f.tables.managedRevenueCatEvents.push(...[
      { _id: "purchase", ...event, eventType: "INITIAL_PURCHASE" }, { _id: "cancel", ...event, eventType: "CANCELLATION" },
      { _id: "future", ...event, eventType: "RENEWAL", eventTimestampMs: JAN + 1 }, { _id: "other", ...event, eventType: "RENEWAL", productId: "annual" },
    ]);
    await f.reconcile(proof({ verifiedAtMs: JAN + 5000 }), JAN + 5000);
    expect(f.tables.managedRevenueCatEvents.map(row => row.reconciliationStatus)).toEqual(["reconciled", "awaiting-apple-verification", "awaiting-apple-verification", "awaiting-apple-verification"]);
    const serialized = JSON.stringify(f.tables);
    expect(serialized).not.toContain("signedTransaction"); expect(serialized).not.toContain("originalTransactionId");
  });
});


test("the same verified Apple payload before and after natural expiry reconciles without a signed-version conflict", async () => {
  const f = database();
  const payload = { bundleId: MANAGED_APPLE_BUNDLE_ID, productId: MANAGED_MONTHLY_PRODUCT_ID, environment: "Production",
    type: "Auto-Renewable Subscription", originalTransactionId: "private-original-transaction", originalPurchaseDate: JAN,
    purchaseDate: JAN, signedDate: JAN, expiresDate: FEB };
  const before = await normalizeVerifiedAppleTransaction(payload, JAN, "Production");
  const after = await normalizeVerifiedAppleTransaction(payload, FEB, "Production");
  expect(before.currentState).toBe("active"); expect(after.currentState).toBe("expired");
  await f.reconcile(before, JAN);
  expect((await f.reconcile(after, FEB)).entitlement).toBe("expired");
  expect(f.tables.managedPeriods).toHaveLength(1);
  expect(JSON.stringify(f.tables)).not.toContain("private-original-transaction");
});

describe("approved durable quota schedules", () => {
  test.each([false, true])("monthly-to-annual preserves September 10 schedule and remaining hours (delayed=%s)", async (delayed) => {
    const f = database();
    const sep10 = Date.UTC(2026, 8, 10), sep25 = Date.UTC(2026, 8, 25), oct10 = Date.UTC(2026, 9, 10), oct15 = Date.UTC(2026, 9, 15), nov10 = Date.UTC(2026, 10, 10);
    const initial = proof({ startedAtMs: sep10, transactionPurchaseAtMs: sep10, transactionSignedAtMs: sep10, expiresAtMs: oct10, verifiedAtMs: sep10 });
    await f.reconcile(initial, sep10);
    f.tables.managedPeriods[0]!.usedSeconds = 5 * 3600;
    const upgrade = { ...initial, product: "annual" as const, productId: "annual", transactionPurchaseAtMs: sep25, transactionSignedAtMs: sep25,
      expiresAtMs: Date.UTC(2027, 8, 25), verifiedAtMs: delayed ? oct15 : sep25 };
    await f.reconcile(upgrade, delayed ? oct15 : sep25);
    expect(f.tables.managedPeriods[0]).toMatchObject({ startAt: sep10, endAt: oct10, limitSeconds: 28_800, usedSeconds: 18_000 });
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toEqual({ kind: "calendar_month", anchorAt: sep10 });
    if (!delayed) await advanceVerifiedQuotaPeriod(f.ctx, f.tables.managedAccounts[0], f.tables.managedLineages[0], oct10);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: oct10, endAt: nov10, limitSeconds: 28_800, usedSeconds: 0 });
  });
  test("quota windows are not shortened by entitlement expiry", async () => {
    const f = database();
    const midMonth = JAN + 5 * 86400_000;
    await f.reconcile(proof({ expiresAtMs: midMonth }), JAN);
    expect(f.tables.managedPeriods[0]).toMatchObject({ startAt: JAN, endAt: FEB });
    expect((await f.reconcile(proof({ expiresAtMs: midMonth, currentState: "expired", verifiedAtMs: midMonth }), midMonth)).entitlement).toBe("expired");
    expect(f.tables.managedPeriods).toHaveLength(1);
  });
  test("repurchase while the old quota window remains active keeps that window even with delayed evidence", async () => {
    const f = database();
    const expiry = JAN + 5 * 86400_000, repurchase = JAN + 10 * 86400_000;
    await f.reconcile(proof({ expiresAtMs: expiry }), JAN);
    f.tables.managedPeriods[0]!.usedSeconds = 123;
    await f.reconcile(proof({ transactionPurchaseAtMs: repurchase, transactionSignedAtMs: repurchase, expiresAtMs: APR, verifiedAtMs: FEB + 1 }), FEB + 1);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toEqual({ kind: "calendar_month", anchorAt: JAN });
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: FEB, endAt: MAR });
    expect(f.tables.managedPeriods[0]!.usedSeconds).toBe(123);
  });
  test("an unmaterialized final quota window prevents a short extra grant after subscription expiry", async () => {
    const f = database();
    const expiry = Date.UTC(2026, 2, 10), repurchase = Date.UTC(2026, 2, 20);
    await f.reconcile(proof({ product: "annual", productId: "annual", expiresAtMs: expiry }), JAN);
    await f.reconcile(proof({ product: "annual", productId: "annual", transactionPurchaseAtMs: repurchase, transactionSignedAtMs: repurchase,
      expiresAtMs: Date.UTC(2027, 2, 20), verifiedAtMs: repurchase }), repurchase);
    expect(f.tables.managedAccounts[0]!.quotaSchedule.anchorAt).toBe(JAN);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: FEB, endAt: MAR });
  });
  test("standalone sandbox annual term has twelve exact rational slices with no rounding drift beyond twelve", () => {
    const schedule = quotaScheduleForTerm({ product: "annual", environment: "SANDBOX", startedAt: JAN,
      transactionPurchaseAt: JAN, transactionSignedAt: JAN, expiresAt: JAN + 1001 });
    let previousEnd = JAN;
    for (let n = 0; n < 36; n += 1) {
      const startAt = JAN + Math.floor(n * 1001 / 12), endAt = JAN + Math.floor((n + 1) * 1001 / 12);
      expect(startAt).toBe(previousEnd);
      expect(quotaPeriodForSchedule(schedule, startAt)).toEqual({ startAt, endAt });
      expect(quotaPeriodForSchedule(schedule, endAt - 1)).toEqual({ startAt, endAt });
      previousEnd = endAt;
    }
    expect(previousEnd).toBe(JAN + 3003);
    expect(quotaPeriodForSchedule(schedule, JAN + 1001).startAt).toBe(JAN + 1001);
  });
  test.each([false, true])("sandbox active change preserves the established accelerated cadence (delayed=%s)", async (delayed) => {
    const f = database();
    const initial = proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 });
    await f.reconcile(initial, JAN);
    f.tables.managedPeriods[0]!.usedSeconds = 100;
    const next = { ...initial, product: "annual" as const, productId: "annual", transactionPurchaseAtMs: JAN + 500, transactionSignedAtMs: JAN + 500,
      expiresAtMs: JAN + 12500, verifiedAtMs: JAN + (delayed ? 1300 : 500) };
    await f.reconcile(next, JAN + (delayed ? 1300 : 500));
    if (!delayed) await advanceVerifiedQuotaPeriod(f.ctx, f.tables.managedAccounts[0], f.tables.managedLineages[0], JAN + 1200);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: JAN + 1200, endAt: JAN + 2400 });
    expect(f.tables.managedPeriods[0]!.usedSeconds).toBe(100);
  });
  test("contiguous sandbox renewal preserves cadence but a later purchase after both ended reanchors", async () => {
    const f = database(); await f.reconcile(proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 }), JAN);
    await f.reconcile(proof({ environment: "SANDBOX", transactionPurchaseAtMs: JAN + 1200, transactionSignedAtMs: JAN + 1200,
      expiresAtMs: JAN + 2700, verifiedAtMs: JAN + 1200 }), JAN + 1200);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: JAN + 1200, endAt: JAN + 2400 });
    // The last covered allocation is 2400–3600 even if never materialized.
    await f.reconcile(proof({ environment: "SANDBOX", transactionPurchaseAtMs: JAN + 4000, transactionSignedAtMs: JAN + 4000,
      expiresAtMs: JAN + 5500, verifiedAtMs: JAN + 4000 }), JAN + 4000);
    expect(f.tables.managedPeriods[2]).toMatchObject({ startAt: JAN + 4000, endAt: JAN + 5500 });
  });
  test("calendar cadence preserves leap-day and month-end anchors", () => {
    const leap = Date.UTC(2024, 1, 29, 12, 34, 56, 789);
    const schedule = { kind: "calendar_month" as const, anchorAt: leap };
    expect(quotaPeriodForSchedule(schedule, Date.UTC(2025, 1, 28, 12, 34, 56, 789))).toEqual({
      startAt: Date.UTC(2025, 1, 28, 12, 34, 56, 789), endAt: Date.UTC(2025, 2, 29, 12, 34, 56, 789),
    });
  });
  test("legacy sandbox cadence is upgraded only from matching fresh evidence", async () => {
    const f = database(); const initial = proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 });
    await f.reconcile(initial, JAN); delete f.tables.managedAccounts[0]!.quotaSchedule;
    await f.reconcile(initial, JAN + 1);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toMatchObject({ kind: "sandbox", termDurationMs: 1200, periodsPerTerm: 1 });
    delete f.tables.managedAccounts[0]!.quotaSchedule;
    await f.reconcile({ ...initial, transactionPurchaseAtMs: JAN + 100, transactionSignedAtMs: JAN + 100,
      expiresAtMs: JAN + 1300, verifiedAtMs: JAN + 100 }, JAN + 100);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toBeUndefined();
    expect(f.tables.managedPeriods).toHaveLength(1);
  });
});


describe("signed purchase reason and legacy cadence evidence", () => {
  test.each(["RENEWAL", undefined] as const)("missed automatic renewal or unknown reason (%s) preserves the January31 anchor", async (transactionReason) => {
    const f = database(); await f.reconcile(proof(), JAN);
    const purchase = Date.UTC(2026, 2, 28, 12);
    await f.reconcile(proof({ transactionPurchaseAtMs: purchase, transactionSignedAtMs: purchase,
      transactionReason, expiresAtMs: Date.UTC(2026, 3, 28, 12), verifiedAtMs: purchase }), purchase);
    expect(f.tables.managedAccounts[0]!.quotaSchedule.anchorAt).toBe(JAN);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: FEB, endAt: MAR });
  });
  test("a changed-product PURCHASE after missed coverage does not claim that an active upgrade was a lapse", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    const purchase = Date.UTC(2026, 2, 28, 12);
    await f.reconcile(proof({ product: "annual", productId: "annual", transactionPurchaseAtMs: purchase,
      transactionSignedAtMs: purchase, expiresAtMs: Date.UTC(2027, 2, 28, 12), verifiedAtMs: purchase }), purchase);
    expect(f.tables.managedAccounts[0]!.quotaSchedule.anchorAt).toBe(JAN);
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: FEB, endAt: MAR });
  });
  test("reason contradictions at the same signed version are rejected", async () => {
    const f = database(); await f.reconcile(proof(), JAN);
    await expect(f.reconcile(proof({ transactionReason: "RENEWAL" }), JAN)).rejects.toThrow("conflicts at the same signed version");
  });
  test("matching legacy initial monthly snapshot migrates using fresh renewal cadence and preserves its accounting", async () => {
    const f = database(); await f.reconcile(proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 }), JAN);
    delete f.tables.managedAccounts[0]!.quotaSchedule;
    delete f.tables.managedLineages[0]!.transactionPurchaseAt; delete f.tables.managedLineages[0]!.transactionSignedAt; delete f.tables.managedLineages[0]!.transactionReason;
    f.tables.managedPeriods[0]!.usedSeconds = 11; f.tables.managedPeriods[0]!.reservedSeconds = 5;
    await f.reconcile(proof({ environment: "SANDBOX", transactionPurchaseAtMs: JAN + 4800, transactionSignedAtMs: JAN + 4800,
      transactionReason: "RENEWAL", expiresAtMs: JAN + 6000, verifiedAtMs: JAN + 4900 }), JAN + 4900);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toEqual({ kind: "sandbox", anchorAt: JAN, termDurationMs: 1200, periodsPerTerm: 1 });
    expect(f.tables.managedPeriods[0]).toMatchObject({ usedSeconds: 11, reservedSeconds: 5 });
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: JAN + 4800, endAt: JAN + 6000 });
  });
  test("legacy initial duration cannot be assumed when the fresh renewal has a different cadence", async () => {
    const f = database(); await f.reconcile(proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 }), JAN);
    delete f.tables.managedAccounts[0]!.quotaSchedule;
    await f.reconcile(proof({ environment: "SANDBOX", transactionPurchaseAtMs: JAN + 4800, transactionSignedAtMs: JAN + 4800,
      transactionReason: "RENEWAL", expiresAtMs: JAN + 6500, verifiedAtMs: JAN + 4900 }), JAN + 4900);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toEqual({ kind: "sandbox", anchorAt: JAN + 4800, termDurationMs: 1700, periodsPerTerm: 1 });
    expect(f.tables.managedPeriods[0]!.endAt).toBe(JAN + 1200);
  });
});


describe("legacy malformed snapshot recovery", () => {
  test("actual historical timing establishes first cadence from fresh renewal without changing the historical ledger", async () => {
    const f = database();
    const startedAt = 1788699230000, oldStart = 1788842946000, oldEnd = 1788986662000;
    const purchase = 1789306654000, expiry = 1789307554000;
    await f.reconcile(proof({ environment: "SANDBOX", startedAtMs: startedAt, transactionPurchaseAtMs: oldStart,
      transactionSignedAtMs: oldStart, expiresAtMs: oldEnd, verifiedAtMs: oldStart }), oldStart);
    const account = f.tables.managedAccounts[0]!, old = f.tables.managedPeriods[0]!, lineage = f.tables.managedLineages[0]!;
    delete account.quotaSchedule;
    delete lineage.transactionPurchaseAt; delete lineage.transactionSignedAt; delete lineage.transactionReason;
    lineage.expiresAt = expiry;
    old.usedSeconds = 17; old.reservedSeconds = 5;
    await f.reconcile(proof({ environment: "SANDBOX", startedAtMs: startedAt, transactionPurchaseAtMs: purchase,
      transactionSignedAtMs: purchase, transactionReason: "RENEWAL", expiresAtMs: expiry, verifiedAtMs: purchase + 1 }), purchase + 1);
    expect(old).toMatchObject({ startAt: oldStart, endAt: oldEnd, usedSeconds: 17, reservedSeconds: 5 });
    expect(account.quotaSchedule).toEqual({ kind: "sandbox", anchorAt: purchase, termDurationMs: 900000, periodsPerTerm: 1 });
    expect(f.tables.managedPeriods[1]).toMatchObject({ startAt: purchase, endAt: expiry, usedSeconds: 0, reservedSeconds: 0 });
    await f.reconcile(proof({ environment: "SANDBOX", startedAtMs: startedAt, transactionPurchaseAtMs: purchase,
      transactionSignedAtMs: purchase, transactionReason: "RENEWAL", expiresAtMs: expiry, verifiedAtMs: purchase + 2 }), purchase + 2);
    expect(f.tables.managedPeriods).toHaveLength(2);
  });
  test("active malformed legacy period preserves quota but does not block verified refund projection", async () => {
    const f = database(); const initial = proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 });
    await f.reconcile(initial, JAN); const account = f.tables.managedAccounts[0]!; delete account.quotaSchedule;
    f.tables.managedPeriods[0]!.endAt = JAN + 2400; account.currentPeriodEndAt = JAN + 2400;
    f.tables.managedPrincipals.push({ _id: "principal", accountId: initial.accountId, revokedAt: null, entitlement: "active" });
    const result = await f.reconcile({ ...initial, currentState: "refunded", transactionSignedAtMs: JAN + 100, verifiedAtMs: JAN + 100 }, JAN + 100);
    expect(result.entitlement).toBe("refunded");
    expect(f.tables.managedPrincipals[0]!.entitlement).toBe("refunded");
    expect(f.tables.managedPeriods).toHaveLength(1);
    expect(account.quotaSchedule).toBeUndefined();
  });
  test("overlapping fresh term does not truncate or grant a short bridge for a legacy snapshot", async () => {
    const f = database(); const initial = proof({ environment: "SANDBOX", expiresAtMs: JAN + 1200 });
    await f.reconcile(initial, JAN); delete f.tables.managedAccounts[0]!.quotaSchedule;
    const next = { ...initial, transactionPurchaseAtMs: JAN + 500, transactionSignedAtMs: JAN + 500,
      transactionReason: "RENEWAL" as const, expiresAtMs: JAN + 2000, verifiedAtMs: JAN + 1300 };
    await f.reconcile(next, JAN + 1300);
    expect(f.tables.managedAccounts[0]!.quotaSchedule).toBeUndefined();
    expect(f.tables.managedPeriods).toHaveLength(1);
  });
});


test("explicit paid repurchase after an ended trial uses the approved lapse anchor", async () => {
  const f = database(); await f.reconcile(proof({ product: "trial", periodType: "trial" }), JAN);
  const purchase = MAR + 1000;
  await f.reconcile(proof({ transactionPurchaseAtMs: purchase, transactionSignedAtMs: purchase,
    expiresAtMs: APR, verifiedAtMs: purchase }), purchase);
  expect(f.tables.managedAccounts[0]!.quotaSchedule.anchorAt).toBe(purchase);
  expect(f.tables.managedPeriods[1]!.startAt).toBe(purchase);
});
