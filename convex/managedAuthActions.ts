"use node";

import { importPKCS8, SignJWT } from "jose";
import { action, internalAction } from "./_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import { DEVICE_JWT_TTL_SECONDS } from "./deviceAuth";
import { readManagedRuntimeConfig } from "./managedConfig";
import { appleMaterialValidatorForAction } from "./managedAuthValidators";

export const enrollDevice = action({
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
    const enrolled = await ctx.runMutation(anyApi.managedAuth.consumeEnrollment, args);
    return issueDeviceToken(enrolled.subject, enrolled.deviceId, enrolled.keyId);
  },
});

export const refreshDevice = action({
  args: {
    challengeId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    signature: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const refreshed = await ctx.runMutation(anyApi.managedAuth.consumeRefresh, args);
    return issueDeviceToken(refreshed.subject, refreshed.deviceId, refreshed.keyId);
  },
});

export const processRevenueCatEvent = internalAction({
  args: { eventId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const event = await ctx.runQuery(anyApi.managedAuth.readRevenueCatEvent, args);
    if (!event || event.processedAt !== null) return true;
    const config = readManagedRuntimeConfig();
    if (config.appleVerifierMode !== "fixture") {
      throw new Error("RevenueCat receipt is only a reconciliation trigger; the production Apple adapter remains an external gate");
    }
    await ctx.runMutation(anyApi.managedAuth.reconcileFixtureLineage, { lineageKey: event.lineageKey });
    await ctx.runMutation(anyApi.managedAuth.markRevenueCatEventProcessed, args);
    return true;
  },
});

async function issueDeviceToken(subject: string, deviceId: string, keyId: string) {
  const config = readManagedRuntimeConfig();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresAt = nowSeconds + DEVICE_JWT_TTL_SECONDS;
  const key = await importPKCS8(config.authPrivateKeyPkcs8, "ES256");
  const authToken = await new SignJWT({ sub: subject, deviceId, keyId })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: config.authKeyId })
    .setIssuer(config.authIssuer)
    .setAudience(config.authAudience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(key);
  return {
    authToken,
    expiresAt: expiresAt * 1_000,
    deviceId,
    keyId,
  };
}
