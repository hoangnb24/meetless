import { v } from "convex/values";

const appleFixtureMaterialValidator = v.object({
  adapter: v.literal("fixture"),
  bundleId: v.string(),
  environment: v.literal("SANDBOX"),
  productId: v.string(),
  originalTransactionId: v.string(),
  periodType: v.union(v.literal("normal"), v.literal("trial")),
  startedAtMs: v.number(),
  expiresAtMs: v.number(),
  currentState: v.union(
    v.literal("active"),
    v.literal("grace"),
    v.literal("expired"),
    v.literal("refunded"),
    v.literal("revoked"),
  ),
  fixtureProof: v.optional(v.string()),
});

const appleSignedTransactionValidator = v.object({
  adapter: v.literal("app-store-server-api"),
  signedTransaction: v.string(),
});

/** Public action input is either historical fixture data or opaque signed data. */
export const appleMaterialValidatorForAction = v.union(appleFixtureMaterialValidator, appleSignedTransactionValidator);

/** Only normalized, Apple-verified fields may cross into a Convex mutation. */
export const verifiedAppleLineageValidatorForMutation = v.object({
  adapter: v.union(v.literal("fixture"), v.literal("app-store-server-api")),
  lineageKey: v.string(),
  accountId: v.string(),
  appId: v.string(),
  bundleId: v.string(),
  productId: v.string(),
  product: v.union(v.literal("monthly"), v.literal("annual"), v.literal("trial")),
  environment: v.union(v.literal("SANDBOX"), v.literal("PRODUCTION")),
  periodType: v.union(v.literal("normal"), v.literal("trial")),
  startedAtMs: v.number(),
  expiresAtMs: v.number(),
  currentState: v.union(
    v.literal("active"),
    v.literal("grace"),
    v.literal("expired"),
    v.literal("refunded"),
    v.literal("revoked"),
  ),
  verifiedAtMs: v.number(),
});

export const revenueCatEventValidatorForMutation = v.object({
  eventId: v.string(),
  lineageKey: v.string(),
  appId: v.string(),
  productId: v.string(),
  environment: v.union(v.literal("SANDBOX"), v.literal("PRODUCTION")),
  eventType: v.string(),
  eventTimestampMs: v.number(),
});
