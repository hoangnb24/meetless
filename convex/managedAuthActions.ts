"use node";

import { importPKCS8, SignJWT } from "jose";
import { action, internalAction } from "./_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import { DEVICE_JWT_TTL_SECONDS } from "./deviceAuth";
import { readManagedRuntimeConfig } from "./managedConfig";
import { verifyAppleMaterial } from "./appleSubscription";
import { verifySignedAppleTransaction } from "./appleSubscriptionNode";
import { verifyCurrentAppleSubscription } from "./appleSubscriptionStatusNode";
import { lineageKeyForOriginalTransactionId } from "./appleSubscription";
import { appleMaterialValidatorForAction, revenueCatEventValidatorForMutation } from "./managedAuthValidators";

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
    const config = readManagedRuntimeConfig();
    const verified = args.apple.adapter === "fixture"
      ? await verifyAppleMaterial(args.apple, config.appleVerifierMode, Date.now())
      : await verifySignedAppleTransaction(args.apple.signedTransaction, config, Date.now());
    const enrolled = await ctx.runMutation(anyApi.managedAuth.consumeEnrollment, {
      challengeId: args.challengeId,
      deviceId: args.deviceId,
      keyId: args.keyId,
      publicKey: args.publicKey,
      signature: args.signature,
      apple: verified,
    });
    return issueDeviceToken(
      enrolled.subject,
      enrolled.deviceId,
      enrolled.keyId,
      enrolled.entitlement,
      enrolled.naturalExpiryAt,
    );
  },
});

export const refreshDevice = action({
  args: {
    challengeId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    signature: v.string(),
    apple: v.optional(appleMaterialValidatorForAction),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    const apple = args.apple === undefined ? undefined : args.apple.adapter === "fixture"
      ? await verifyAppleMaterial(args.apple, config.appleVerifierMode, Date.now())
      : await verifySignedAppleTransaction(args.apple.signedTransaction, config, Date.now());
    const { apple: _material, ...possession } = args;
    const refreshed = await ctx.runMutation(anyApi.managedAuth.consumeRefresh, { ...possession, ...(apple ? { apple } : {}) });
    return issueDeviceToken(
      refreshed.subject,
      refreshed.deviceId,
      refreshed.keyId,
      refreshed.entitlement,
      refreshed.naturalExpiryAt,
    );
  },
});

/** Direct HTTP action call only: raw lookup data never enters a scheduler or mutation. */
export const processRevenueCatEvent = internalAction({
  args: { event: revenueCatEventValidatorForMutation, originalTransactionId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    try {
      if (await lineageKeyForOriginalTransactionId(args.originalTransactionId) !== args.event.lineageKey) throw new Error("Webhook lineage mismatch");
      const config = readManagedRuntimeConfig();
      const apple = config.appleVerifierMode === "fixture" ? undefined
        : await verifyCurrentAppleSubscription(args.originalTransactionId, config);
      return await ctx.runMutation(anyApi.managedAuth.receiveRevenueCatEvent, {
        event: args.event, ...(apple ? { apple } : {}),
      });
    } catch {
      // Catch before the action boundary so SDK errors cannot expose raw data.
      return { outcome: "retry" };
    }
  },
});

async function issueDeviceToken(
  subject: string,
  deviceId: string,
  keyId: string,
  state: "active" | "grace" | "expired" | "refunded" | "revoked",
  naturalExpiryAt: number | null,
) {
  const config = readManagedRuntimeConfig();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresAt = nowSeconds + DEVICE_JWT_TTL_SECONDS;
  const normalizedState = (state === "active" || state === "grace")
    && naturalExpiryAt !== null
    && naturalExpiryAt <= nowSeconds * 1_000
    ? "expired"
    : state;
  const key = await importPKCS8(config.authPrivateKeyPkcs8, "ES256");
  const authToken = await new SignJWT({ sub: subject, deviceId, keyId })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: config.authKeyId })
    .setIssuer(config.authIssuer)
    .setAudience(config.authAudience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(key);
  return {
    version: 1,
    authToken,
    expiresAt: expiresAt * 1_000,
    deviceId,
    keyId,
    state: normalizedState,
    naturalExpiryAt,
  };
}
