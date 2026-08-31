import { v } from "convex/values";

export const appleMaterialValidatorForAction = v.object({
  adapter: v.union(v.literal("fixture"), v.literal("app-store-server-api")),
  bundleId: v.string(),
  environment: v.union(v.literal("SANDBOX"), v.literal("PRODUCTION")),
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
  signedTransaction: v.optional(v.string()),
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
