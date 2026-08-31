import { anyApi } from "convex/server";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  assertNonProductionFixture,
  MANAGED_ANNUAL_PRODUCT_ID,
  MANAGED_ENVIRONMENT_VARIABLES,
  MANAGED_MAX_DEVICES,
  MANAGED_MONTHLY_PRODUCT_ID,
  MANAGED_REVENUECAT_APP_ID,
  MANAGED_TRIAL_SECONDS,
  readManagedRuntimeConfig,
} from "./managedConfig";
import {
  verifyAppleMaterial,
  type AppleSubscriptionState,
  type AppleVerificationMaterial,
} from "./appleSubscription";
import {
  challengeSigningPayload,
  createDeviceChallenge as makeDeviceChallenge,
  encodeBase64Url,
  stableDeviceSubject,
  tokenIdentifierFor,
  verifyP256Signature,
} from "./deviceAuth";
import { appleMaterialValidatorForAction, revenueCatEventValidatorForMutation } from "./managedAuthValidators";

type PrincipalContext = QueryCtx | MutationCtx;

/**
 * The Convex identity is only the cryptographic device subject.  Entitlement
 * admission is deliberately checked by the managed lifecycle separately.
 */
export async function requirePrincipal(ctx: PrincipalContext) {
  const config = readManagedRuntimeConfig();
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier || !identity.subject || identity.issuer !== config.authIssuer) {
    throw new Error(`Managed Convex request requires the deployment's host-authenticated device identity (${MANAGED_ENVIRONMENT_VARIABLES.authIssuer})`);
  }
  const principal = await ctx.db
    .query("managedPrincipals")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!principal || !principal.lineageVerified || principal.revokedAt !== null) {
    throw new Error("Managed Convex identity is not backed by verified subscription lineage and an active device key");
  }
  if (identity.subject !== stableDeviceSubject(principal.deviceId) || identity.tokenIdentifier !== tokenIdentifierFor(config.authIssuer, identity.subject)) {
    throw new Error("Managed Convex JWT subject is not bound to the enrolled device");
  }
  const device = await ctx.db
    .query("managedDevices")
    .withIndex("by_account_device", (q) => q.eq("accountId", principal.accountId).eq("deviceId", principal.deviceId))
    .unique();
  if (!device || device.keyId !== principal.keyId || device.keyVersion !== principal.keyVersion || device.revokedAt !== null) {
    throw new Error("Managed Convex device credential is revoked or no longer matches the server key projection");
  }
  const account = await ctx.db
    .query("managedAccounts")
    .withIndex("by_account", (q) => q.eq("accountId", principal.accountId))
    .unique();
  if (!account) throw new Error("Managed Convex quota account is missing");
  return { identity, principal, device, account, config };
}

export const createDeviceChallenge = mutation({
  args: {
    purpose: v.union(v.literal("enrollment"), v.literal("refresh")),
    deviceId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    // Device IDs are deployment-scoped and may be unknown during enrollment.
    // Refresh performs the authoritative account lookup below by key ID.
    if (args.purpose === "refresh") {
      const candidates = await ctx.db.query("managedDevices").withIndex("by_device_key", (q) => q.eq("deviceId", args.deviceId).eq("keyId", args.keyId)).collect();
      if (candidates.length !== 1 || candidates[0]!.revokedAt !== null || candidates[0]!.publicKey !== args.publicKey) {
        throw new Error("Managed refresh challenge requires the currently enrolled, non-revoked device key");
      }
    }
    const challenge = makeDeviceChallenge({
      challengeId: crypto.randomUUID(),
      purpose: args.purpose,
      deviceId: args.deviceId,
      keyId: args.keyId,
      publicKey: args.publicKey,
      nowMs: Date.now(),
    });
    await ctx.db.insert("managedDeviceChallenges", {
      challengeId: challenge.challengeId,
      purpose: challenge.purpose,
      deviceId: challenge.deviceId,
      keyId: challenge.keyId,
      keyVersion: challenge.keyId,
      publicKey: challenge.publicKey,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      consumedAt: null,
    });
    return {
      challengeId: challenge.challengeId,
      purpose: challenge.purpose,
      deviceId: challenge.deviceId,
      keyId: challenge.keyId,
      expiresAt: challenge.expiresAt,
      signingPayload: encodeBase64Url(challengeSigningPayload(challenge)),
      issuer: config.authIssuer,
      audience: config.authAudience,
    };
  },
});

export const readChallenge = internalQuery({
  args: { challengeId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => ctx.db.query("managedDeviceChallenges").withIndex("by_challenge", (q) => q.eq("challengeId", args.challengeId)).unique(),
});

export const consumeEnrollment = internalMutation({
  args: {
    challengeId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    signature: v.string(),
    apple: appleMaterialValidatorForAction,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    const challenge = await challengeForConsume(ctx, args.challengeId, "enrollment", args.deviceId, args.keyId, args.publicKey);
    if (!(await verifyP256Signature(challenge.publicKey, args.signature, challengeSigningPayload(challenge)))) {
      throw new Error("Managed enrollment signature does not prove device-key possession");
    }
    const verified = await verifyAppleMaterial(args.apple as AppleVerificationMaterial, config.appleVerifierMode, Date.now());
    const now = Date.now();
    const existingLineage = await ctx.db.query("managedLineages").withIndex("by_lineage", (q) => q.eq("lineageKey", verified.lineageKey)).unique();
    if (existingLineage && existingLineage.accountId !== verified.accountId) throw new Error("Verified Apple lineage changed account identity");
    if (!existingLineage) {
      await ctx.db.insert("managedLineages", lineageRecord(verified));
    } else {
      await ctx.db.patch(existingLineage._id, lineageRecord(verified));
    }
    let account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", verified.accountId)).unique();
    if (!account) {
      const periodLength = verified.product === "trial" ? 7 * 24 * 60 * 60 * 1_000 : verified.product === "annual" ? 365 * 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000;
      const periodEnd = now + periodLength;
      const allowance = verified.product === "trial" ? MANAGED_TRIAL_SECONDS : config.allowanceSeconds;
      await ctx.db.insert("managedAccounts", {
        accountId: verified.accountId,
        currentPeriodStartAt: now,
        currentPeriodEndAt: periodEnd,
        nextPeriodLimitSeconds: config.allowanceSeconds,
        allowanceSource: verified.product === "trial" ? "product-trial-fixed" : config.allowanceSource,
        maxDevices: MANAGED_MAX_DEVICES,
      });
      await ctx.db.insert("managedPeriods", {
        accountId: verified.accountId,
        product: verified.product,
        startAt: now,
        endAt: periodEnd,
        limitSeconds: allowance,
        usedSeconds: 0,
        reservedSeconds: 0,
      });
      account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", verified.accountId)).unique();
    }
    if (!account) throw new Error("Managed quota account disappeared during enrollment");
    const accountDevices = await ctx.db.query("managedDevices").withIndex("by_account", (q) => q.eq("accountId", verified.accountId)).collect();
    const currentDevice = accountDevices.find((device) => device.deviceId === args.deviceId);
    if (currentDevice && (currentDevice.keyId !== args.keyId || currentDevice.publicKey !== args.publicKey)) {
      throw new Error("Managed device identity cannot be rebound to a different key");
    }
    const restored = currentDevice !== undefined;
    const activeDevices = accountDevices.filter((device) => device.revokedAt === null);
    if (!restored && activeDevices.length >= Math.min(account.maxDevices, MANAGED_MAX_DEVICES)) {
      throw new Error("Managed account has reached its three active-device enrollment limit");
    }
    const device = currentDevice ?? await ctx.db.insert("managedDevices", {
      accountId: verified.accountId,
      deviceId: args.deviceId,
      keyId: args.keyId,
      keyVersion: args.keyId,
      publicKey: args.publicKey,
      enrolledAt: now,
      revokedAt: null,
    }).then((id) => ctx.db.get(id));
    if (!device) throw new Error("Managed device disappeared during enrollment");
    const subject = stableDeviceSubject(args.deviceId);
    const tokenIdentifier = tokenIdentifierFor(config.authIssuer, subject);
    const principal = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", verified.accountId).eq("deviceId", args.deviceId)).unique();
    const entitlement = verified.currentState;
    const naturalExpiryAt = verified.expiresAtMs;
    if (principal) {
      await ctx.db.patch(principal._id, {
        tokenIdentifier,
        keyId: args.keyId,
        keyVersion: args.keyId,
        lineageVerified: true,
        entitlement,
        revokedAt: device.revokedAt,
        naturalExpiryAt,
        enrolledAt: principal.enrolledAt,
      });
    } else {
      await ctx.db.insert("managedPrincipals", {
        tokenIdentifier,
        accountId: verified.accountId,
        deviceId: args.deviceId,
        keyId: args.keyId,
        keyVersion: args.keyId,
        lineageVerified: true,
        entitlement,
        revokedAt: device.revokedAt,
        naturalExpiryAt,
        enrolledAt: now,
      });
    }
    await ctx.db.patch(challenge._id, { consumedAt: now });
    return { subject, keyId: args.keyId, deviceId: args.deviceId, restored, accountId: verified.accountId };
  },
});

export const consumeRefresh = internalMutation({
  args: {
    challengeId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    signature: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    const challenge = await challengeForConsume(ctx, args.challengeId, "refresh", args.deviceId, args.keyId, args.publicKey);
    if (!(await verifyP256Signature(challenge.publicKey, args.signature, challengeSigningPayload(challenge)))) {
      throw new Error("Managed refresh signature does not prove device-key possession");
    }
    const devices = await ctx.db.query("managedDevices").withIndex("by_device_key", (q) => q.eq("deviceId", args.deviceId).eq("keyId", args.keyId)).collect();
    const device = devices.length === 1 ? devices[0] : null;
    if (!device || device.revokedAt !== null || device.publicKey !== args.publicKey) throw new Error("Managed refresh device is revoked or unknown");
    const principal = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", device.accountId).eq("deviceId", device.deviceId)).unique();
    if (!principal || principal.revokedAt !== null || !principal.lineageVerified) throw new Error("Managed refresh principal is revoked or not verified");
    await ctx.db.patch(challenge._id, { consumedAt: Date.now() });
    return { subject: stableDeviceSubject(device.deviceId), keyId: device.keyId, deviceId: device.deviceId, accountId: device.accountId, issuer: config.authIssuer };
  },
});

export const setFixtureAppleState = internalMutation({
  args: {
    lineageKey: v.string(),
    currentState: v.union(v.literal("active"), v.literal("grace"), v.literal("expired"), v.literal("refunded"), v.literal("revoked")),
    expiresAt: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    assertNonProductionFixture(config, "fixture Apple state mutation");
    const lineage = await ctx.db.query("managedLineages").withIndex("by_lineage", (q) => q.eq("lineageKey", args.lineageKey)).unique();
    if (!lineage) throw new Error("Managed fixture lineage is missing");
    await ctx.db.patch(lineage._id, { currentState: args.currentState, expiresAt: args.expiresAt });
    return { lineageKey: args.lineageKey, currentState: args.currentState };
  },
});

export const reconcileFixtureLineage = internalMutation({
  args: { lineageKey: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    assertNonProductionFixture(config, "fixture Apple reconciliation");
    const lineage = await ctx.db.query("managedLineages").withIndex("by_lineage", (q) => q.eq("lineageKey", args.lineageKey)).unique();
    if (!lineage) return { outcome: "unknown-lineage" };
    await applyLineageProjection(ctx, lineage);
    return { outcome: "reconciled", lineageKey: lineage.lineageKey, currentState: lineage.currentState };
  },
});

export const receiveRevenueCatEvent = internalMutation({
  args: { event: revenueCatEventValidatorForMutation },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    if (args.event.appId !== MANAGED_REVENUECAT_APP_ID || args.event.productId !== MANAGED_MONTHLY_PRODUCT_ID && args.event.productId !== MANAGED_ANNUAL_PRODUCT_ID || args.event.environment !== config.revenueCatEnvironment) {
      throw new Error("RevenueCat event is outside the exact managed catalog or environment");
    }
    const existing = await ctx.db.query("managedRevenueCatEvents").withIndex("by_event", (q) => q.eq("eventId", args.event.eventId)).unique();
    if (existing) {
      if (existing.lineageKey !== args.event.lineageKey || existing.eventType !== args.event.eventType) throw new Error("RevenueCat event ID was rebound to different data");
      if (existing.processedAt === null) await ctx.scheduler.runAfter(0, anyApi.managedAuthActions.processRevenueCatEvent, { eventId: existing.eventId });
      return { outcome: "duplicate", eventId: existing.eventId };
    }
    const event = await ctx.db.insert("managedRevenueCatEvents", {
      ...args.event,
      receivedAt: Date.now(),
      processedAt: null,
    });
    await ctx.scheduler.runAfter(0, anyApi.managedAuthActions.processRevenueCatEvent, { eventId: args.event.eventId });
    return { outcome: "received", eventId: args.event.eventId, receiptId: event };
  },
});

export const readRevenueCatEvent = internalQuery({
  args: { eventId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => ctx.db.query("managedRevenueCatEvents").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).unique(),
});

export const markRevenueCatEventProcessed = internalMutation({
  args: { eventId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const event = await ctx.db.query("managedRevenueCatEvents").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).unique();
    if (!event) return false;
    if (event.processedAt === null) await ctx.db.patch(event._id, { processedAt: Date.now() });
    return true;
  },
});

export const expireLocalChallenge = internalMutation({
  args: { challengeId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    assertNonProductionFixture(config, "local challenge expiry");
    const challenge = await ctx.db.query("managedDeviceChallenges").withIndex("by_challenge", (q) => q.eq("challengeId", args.challengeId)).unique();
    if (!challenge) throw new Error("Managed challenge is missing");
    await ctx.db.patch(challenge._id, { expiresAt: Date.now() - 1 });
    return true;
  },
});

async function challengeForConsume(
  ctx: MutationCtx,
  challengeId: string,
  purpose: "enrollment" | "refresh",
  deviceId: string,
  keyId: string,
  publicKey: string,
) {
  const challenge = await ctx.db.query("managedDeviceChallenges").withIndex("by_challenge", (q) => q.eq("challengeId", challengeId)).unique();
  if (!challenge || challenge.purpose !== purpose || challenge.deviceId !== deviceId || challenge.keyId !== keyId || challenge.publicKey !== publicKey) throw new Error("Managed device challenge is missing or not bound to this key");
  if (challenge.consumedAt !== null) throw new Error("Managed device challenge was already consumed; replay is rejected");
  if (challenge.expiresAt <= Date.now()) throw new Error("Managed device challenge expired; replay is rejected");
  return challenge;
}

function lineageRecord(lineage: {
  lineageKey: string;
  accountId: string;
  appId: string;
  bundleId: string;
  productId: string;
  product: "monthly" | "annual" | "trial";
  environment: "SANDBOX" | "PRODUCTION";
  periodType: "normal" | "trial";
  startedAtMs: number;
  expiresAtMs: number;
  currentState: AppleSubscriptionState;
  verifiedAtMs: number;
}) {
  return {
    lineageKey: lineage.lineageKey,
    accountId: lineage.accountId,
    appId: lineage.appId,
    bundleId: lineage.bundleId,
    productId: lineage.productId,
    product: lineage.product,
    environment: lineage.environment,
    periodType: lineage.periodType,
    startedAt: lineage.startedAtMs,
    expiresAt: lineage.expiresAtMs,
    currentState: lineage.currentState,
    verifiedAt: lineage.verifiedAtMs,
    adapter: "fixture" as const,
  };
}

async function applyLineageProjection(ctx: MutationCtx, lineage: any): Promise<void> {
  const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", lineage.accountId)).collect();
  for (const principal of principals) {
    await ctx.db.patch(principal._id, { entitlement: lineage.currentState, naturalExpiryAt: lineage.expiresAt });
  }
  if (lineage.currentState !== "refunded" && lineage.currentState !== "revoked") return;
  const jobs = await ctx.db.query("managedJobs").withIndex("by_timeline", (q) => q.eq("accountId", lineage.accountId)).collect();
  for (const job of jobs) {
    if (job.status !== "reserved" && job.status !== "running") continue;
    const period = await ctx.db.query("managedPeriods").withIndex("by_account_start", (q) => q.eq("accountId", job.accountId).eq("startAt", job.periodStartAt)).unique();
    if (!period || period.reservedSeconds < job.billableSeconds) throw new Error("Managed refund/revoke found an inconsistent reservation");
    await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds - job.billableSeconds });
    await ctx.db.patch(job._id, { status: "stopped", executionToken: null, failureReason: lineage.currentState });
  }
}
