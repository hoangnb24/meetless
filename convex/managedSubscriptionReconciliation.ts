import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { VerifiedAppleSubscriptionLineage, AppleSubscriptionState } from "./appleSubscription";
import { MANAGED_MAX_DEVICES, MANAGED_TRIAL_SECONDS, MANAGED_STORE_TESTING_ALLOWANCE_SOURCE, MANAGED_STORE_TESTING_ALLOWANCE_SECONDS } from "./managedConfig";
import { anchoredCalendarMonth, quotaPeriodForSchedule, quotaScheduleForTerm, verifiedQuotaPeriod, type ManagedQuotaSchedule } from "./managedQuotaPolicy";

type Allowance = { allowanceSeconds: number; allowanceSource: string };
type Lineage = Doc<"managedLineages">;

/** All subscription consumers share this mutation-local reconciliation owner. */
export async function reconcileVerifiedSubscription(
  ctx: MutationCtx, verified: VerifiedAppleSubscriptionLineage, allowance: Allowance, now: number,
  requiredAccountId?: string,
) {
  if (![verified.startedAtMs, verified.transactionPurchaseAtMs, verified.transactionSignedAtMs, verified.expiresAtMs, verified.verifiedAtMs, now].every(value => Number.isSafeInteger(value) && value >= 0)
    || verified.transactionPurchaseAtMs < verified.startedAtMs || verified.transactionPurchaseAtMs >= verified.expiresAtMs
    || verified.transactionPurchaseAtMs > now || verified.transactionSignedAtMs > verified.verifiedAtMs + 5 * 60 * 1_000) {
    throw new Error("Managed subscription evidence has invalid transaction dates");
  }
  if (!Number.isSafeInteger(allowance.allowanceSeconds) || allowance.allowanceSeconds <= 0 || !allowance.allowanceSource.trim()) {
    throw new Error("Managed subscription allowance configuration is invalid");
  }
  if (allowance.allowanceSource === MANAGED_STORE_TESTING_ALLOWANCE_SOURCE
    && (allowance.allowanceSeconds !== MANAGED_STORE_TESTING_ALLOWANCE_SECONDS || verified.environment !== "SANDBOX")) {
    throw new Error("Store-testing allowance requires verified SANDBOX evidence and exactly 1800 seconds");
  }
  if (requiredAccountId !== undefined && requiredAccountId !== verified.accountId) {
    throw new Error("Managed subscription proof does not match the enrolled account");
  }
  const previous = await ctx.db.query("managedLineages").withIndex("by_lineage", q => q.eq("lineageKey", verified.lineageKey)).unique();
  if (previous && previous.accountId !== verified.accountId) throw new Error("Verified Apple lineage changed account identity");
  const record = lineageRecord(verified);
  let lineage: Lineage;
  const order = previous ? evidenceOrder(previous, record) : "new";
  if (previous && order === "old") lineage = previous;
  else {
    if (previous) {
      await ctx.db.patch(previous._id, record);
      lineage = { ...previous, ...record };
    } else {
      const id = await ctx.db.insert("managedLineages", record);
      lineage = (await ctx.db.get(id))!;
    }
  }
  let account = await ctx.db.query("managedAccounts").withIndex("by_account", q => q.eq("accountId", verified.accountId)).unique();
  if (!account) {
    if (requiredAccountId !== undefined) throw new Error("Managed refresh cannot create a quota account");
    const window = verifiedQuotaPeriod(lineage, now);
    const id = await ctx.db.insert("managedAccounts", {
      accountId: lineage.accountId, currentPeriodStartAt: window.startAt, currentPeriodEndAt: window.endAt,
      nextPeriodLimitSeconds: allowance.allowanceSeconds, allowanceSource: allowance.allowanceSource, maxDevices: MANAGED_MAX_DEVICES,
      ...(lineage.product !== "trial" ? { quotaSchedule: quotaScheduleForTerm(lineage) } : {}),
    });
    await ctx.db.insert("managedPeriods", {
      accountId: lineage.accountId, product: lineage.product, ...window,
      limitSeconds: lineage.product === "trial" ? trialAllowanceSeconds(allowance.allowanceSource) : allowance.allowanceSeconds,
      usedSeconds: 0, reservedSeconds: 0,
    });
    account = (await ctx.db.get(id))!;
  } else {
    if (order !== "old" && lineage.product !== "trial" && ["active", "grace"].includes(normalizedEntitlement(lineage.currentState, lineage.expiresAt, now))) {
      const period = await ctx.db.query("managedPeriods").withIndex("by_account_start", q => q.eq("accountId", account!.accountId).eq("startAt", account!.currentPeriodStartAt)).unique();
      if (!period) throw new Error("Managed quota account has no current period; refuse reconciliation rather than resetting usage");
      const quotaSchedule = reconciledQuotaSchedule(account, period, previous, lineage, now);
      if (quotaSchedule) await ctx.db.patch(account._id, { quotaSchedule });
      account = (await ctx.db.get(account._id))!;
    }
    // Configuration changes affect the next allocation, never a started snapshot.
    if (order !== "old") {
      await ctx.db.patch(account._id, { nextPeriodLimitSeconds: allowance.allowanceSeconds, allowanceSource: allowance.allowanceSource });
      account = (await ctx.db.get(account._id))!;
    }
    await advanceVerifiedQuotaPeriod(ctx, account, lineage, now);
    account = (await ctx.db.get(account._id))!;
  }
  await applySubscriptionProjection(ctx, lineage, now);
  await reconcileMatchingEvents(ctx, lineage, now);
  return { account: (await ctx.db.get(account._id))!, lineage, entitlement: normalizedEntitlement(lineage.currentState, lineage.expiresAt, now) };
}

/** An annual allocation can advance within a verified term; time cannot invent a renewal. */
export async function advanceVerifiedQuotaPeriod(ctx: MutationCtx, account: Doc<"managedAccounts">, lineage: Lineage, now: number) {
  const period = await ctx.db.query("managedPeriods").withIndex("by_account_start", q => q.eq("accountId", account.accountId).eq("startAt", account.currentPeriodStartAt)).unique();
  if (!period) throw new Error("Managed quota account has no current period; refuse reconciliation rather than resetting usage");
  if (period.endAt !== account.currentPeriodEndAt) throw new Error("Managed quota account and period snapshot disagree");
  if (now < period.endAt) return period;
  const entitlement = normalizedEntitlement(lineage.currentState, lineage.expiresAt, now);
  if (entitlement !== "active" && entitlement !== "grace") return period;
  if (!account.quotaSchedule) return period;
  const window = quotaPeriodForSchedule(account.quotaSchedule, now);
  if (window.startAt < period.endAt) throw new Error("Managed quota schedule conflicts with the preserved current period");
  const startAt = window.startAt;
  if (startAt >= window.endAt) throw new Error("Managed quota period requires authoritative refresh");
  let next = await ctx.db.query("managedPeriods").withIndex("by_account_start", q => q.eq("accountId", account.accountId).eq("startAt", startAt)).unique();
  if (next && next.endAt !== window.endAt) throw new Error("Managed verified period conflicts with an existing quota snapshot");
  if (!next) {
    const id = await ctx.db.insert("managedPeriods", {
      accountId: account.accountId, product: lineage.product, startAt, endAt: window.endAt,
      limitSeconds: lineage.product === "trial" ? trialAllowanceSeconds(account.allowanceSource) : account.nextPeriodLimitSeconds,
      usedSeconds: 0, reservedSeconds: 0,
    });
    next = (await ctx.db.get(id))!;
  }
  await ctx.db.patch(account._id, { currentPeriodStartAt: next.startAt, currentPeriodEndAt: next.endAt });
  return next;
}

/** The purchase instant determines continuity, even when its proof arrives late. */
function reconciledQuotaSchedule(account: Doc<"managedAccounts">, period: Doc<"managedPeriods">, previous: Lineage | null, lineage: Lineage, now: number): ManagedQuotaSchedule | undefined {
  const purchase = lineage.transactionPurchaseAt;
  if (purchase === undefined) throw new Error("Managed quota schedule requires fresh authoritative subscription evidence");
  let priorPeriodEnd = period.endAt;
  if (previous && purchase > previous.expiresAt && account.quotaSchedule && previous.expiresAt > account.quotaSchedule.anchorAt) {
    // An unmaterialized final allocation still has its full reset window. A
    // subscription expiry inside that window does not make a new quota grant.
    priorPeriodEnd = Math.max(priorPeriodEnd, quotaPeriodForSchedule(account.quotaSchedule,
      Math.min(purchase - 1, previous.expiresAt - 1)).endAt);
  }
  const lapsed = previous !== null && lineage.transactionReason === "PURCHASE" && lineage.productId === previous.productId
    && purchase > previous.expiresAt && purchase >= priorPeriodEnd;
  if (lapsed && account.quotaSchedule) return quotaScheduleForTerm(lineage);
  if (account.quotaSchedule) return account.quotaSchedule;
  if (period.product === "trial") return quotaScheduleForTerm(lineage, lapsed ? purchase : period.endAt);
  // Legacy snapshots did not persist cadence. Reconstruct only when current
  // evidence proves it; never divide an original-start-to-latest-expiry span.
  if (lineage.environment === "PRODUCTION" && anchoredCalendarMonth(period.startAt, 1) === period.endAt) {
    return { kind: "calendar_month", anchorAt: period.startAt };
  }
  // Old initial monthly snapshots may lack explicit purchase timestamps. A
  // matching fresh renewal term proves their cadence only when its duration
  // agrees with that exact old snapshot and its original lineage bounds.
  if (previous && lineage.environment === "SANDBOX" && lineage.transactionReason === "RENEWAL"
    && period.product === "monthly" && lineage.product === "monthly" && previous.productId === lineage.productId
    && previous.startedAt === period.startAt && previous.expiresAt === period.endAt
    && lineage.expiresAt - purchase === period.endAt - period.startAt) {
    return quotaScheduleForTerm(lineage, period.startAt);
  }
  const candidate = quotaScheduleForTerm(lineage);
  if (period.startAt >= candidate.anchorAt) {
    const checked = quotaPeriodForSchedule(candidate, period.startAt);
    if (checked.startAt === period.startAt && checked.endAt === period.endAt) return candidate;
  }
  // No cadence was ever established for a malformed legacy snapshot. Once it
  // has ended, current verified evidence can establish the first cadence;
  // this does not claim the old subscription lapsed or reconstruct its span.
  const current = quotaPeriodForSchedule(candidate, now);
  if (now >= period.endAt && current.startAt >= period.endAt) return candidate;
  // Preserve active/overlapping legacy quota without blocking an authoritative
  // entitlement update. Admission remains closed after this snapshot expires.
  return undefined;
}

function lineageRecord(v: VerifiedAppleSubscriptionLineage) {
  return {
    lineageKey: v.lineageKey, accountId: v.accountId, appId: v.appId, bundleId: v.bundleId, productId: v.productId,
    product: v.product, environment: v.environment, periodType: v.periodType, startedAt: v.startedAtMs,
    transactionPurchaseAt: v.transactionPurchaseAtMs, transactionSignedAt: v.transactionSignedAtMs, transactionReason: v.transactionReason,
    expiresAt: v.expiresAtMs, currentState: v.currentState, verifiedAt: v.verifiedAtMs, adapter: v.adapter,
  };
}

function evidenceOrder(previous: Lineage, next: ReturnType<typeof lineageRecord>): "new" | "old" {
  if (previous.environment !== next.environment || previous.bundleId !== next.bundleId || previous.appId !== next.appId || previous.startedAt !== next.startedAt) {
    throw new Error("Managed subscription evidence changed immutable lineage facts");
  }
  if (previous.transactionPurchaseAt === undefined || previous.transactionSignedAt === undefined) {
    if (next.expiresAt < previous.expiresAt) throw new Error("Managed legacy subscription requires evidence that does not shorten its known term");
    // Legacy state has no signed ordering evidence; never resurrect its observed revocation with an old term.
    if ((previous.currentState === "refunded" || previous.currentState === "revoked") && next.transactionPurchaseAt < previous.expiresAt && next.currentState !== previous.currentState) {
      throw new Error("Managed legacy revocation requires a verified subsequent purchase");
    }
    return "new";
  }
  if (next.transactionPurchaseAt < previous.transactionPurchaseAt || next.transactionSignedAt < previous.transactionSignedAt) return "old";
  if (next.transactionPurchaseAt === previous.transactionPurchaseAt && (previous.currentState === "refunded" || previous.currentState === "revoked") && next.currentState !== previous.currentState) return "old";
  if (next.transactionPurchaseAt === previous.transactionPurchaseAt && next.transactionSignedAt === previous.transactionSignedAt) {
    // Verification time is not evidence of a newer subscription state.
    const facts = ["productId", "product", "periodType", "expiresAt"] as const;
    const naturalStates = new Set(["active", "expired"]);
    const sameState = previous.currentState === next.currentState || naturalStates.has(previous.currentState) && naturalStates.has(next.currentState);
    const conflictingReason = previous.transactionReason !== undefined && next.transactionReason !== undefined && previous.transactionReason !== next.transactionReason;
    if (!sameState || conflictingReason || facts.some(key => previous[key] !== next[key])) throw new Error("Managed subscription evidence conflicts at the same signed version");
  }
  return "new";
}

export function normalizedEntitlement(state: AppleSubscriptionState, expiry: number | null | undefined, now: number): AppleSubscriptionState {
  return (state === "active" || state === "grace") && expiry != null && expiry <= now ? "expired" : state;
}

export async function applySubscriptionProjection(ctx: MutationCtx, lineage: Lineage, now: number) {
  const entitlement = normalizedEntitlement(lineage.currentState, lineage.expiresAt, now);
  const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", q => q.eq("accountId", lineage.accountId)).collect();
  for (const principal of principals) if (principal.revokedAt === null) await ctx.db.patch(principal._id, { entitlement, naturalExpiryAt: lineage.expiresAt });
  if (entitlement !== "refunded" && entitlement !== "revoked") return;
  const jobs = await ctx.db.query("managedJobs").withIndex("by_timeline", q => q.eq("accountId", lineage.accountId)).collect();
  for (const job of jobs) {
    if (job.status !== "reserved" && job.status !== "running") continue;
    const period = await ctx.db.query("managedPeriods").withIndex("by_account_start", q => q.eq("accountId", job.accountId).eq("startAt", job.periodStartAt)).unique();
    if (!period || period.reservedSeconds < job.billableSeconds) throw new Error("Managed refund/revoke found an inconsistent reservation");
    await stopManagedJobParts(ctx, job._id, lineage.currentState);
    await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds - job.billableSeconds });
    await ctx.db.patch(job._id, { status: "stopped", executionToken: null, failureReason: lineage.currentState });
  }
}

async function reconcileMatchingEvents(ctx: MutationCtx, lineage: Lineage, now: number) {
  if (lineage.transactionSignedAt === undefined || lineage.transactionPurchaseAt === undefined) return;
  const events = await ctx.db.query("managedRevenueCatEvents").withIndex("by_lineage", q => q.eq("lineageKey", lineage.lineageKey)).order("desc").take(64);
  for (const event of events) {
    if (event.reconciliationStatus === "reconciled" || event.productId !== lineage.productId || event.environment !== lineage.environment || event.appId !== lineage.appId || event.eventTimestampMs > lineage.transactionSignedAt) continue;
    const purchase = (event.eventType === "INITIAL_PURCHASE" || event.eventType === "RENEWAL")
      && event.eventTimestampMs >= lineage.transactionPurchaseAt && lineage.currentState === "active";
    const expiration = event.eventType === "EXPIRATION" && event.eventTimestampMs >= lineage.expiresAt && normalizedEntitlement(lineage.currentState, lineage.expiresAt, now) === "expired";
    if (purchase || expiration) await ctx.db.patch(event._id, { reconciliationStatus: "reconciled", processedAt: now });
  }
}

/** Terminalize unfinished checkpoints, shared with transcription cancellation. */
export async function stopManagedJobParts(ctx: MutationCtx, jobId: Id<"managedJobs">, reason: string): Promise<void> {
  const parts = await ctx.db.query("managedJobParts").withIndex("by_job_part", q => q.eq("jobId", jobId)).collect();
  for (const part of parts) {
    if (part.status === "completed") continue;
    await ctx.db.patch(part._id, { status: "failed", executionToken: null, leaseExpiresAt: 0, failureReason: reason });
  }
}

/** Store-testing is an explicit deployment source, never inferred from Sandbox alone. */
function trialAllowanceSeconds(allowanceSource: string): number {
  return allowanceSource === MANAGED_STORE_TESTING_ALLOWANCE_SOURCE ? MANAGED_STORE_TESTING_ALLOWANCE_SECONDS : MANAGED_TRIAL_SECONDS;
}
