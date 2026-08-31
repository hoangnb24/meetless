import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  MANAGED_ANNUAL_PRODUCT_ID,
  MANAGED_APPLE_BUNDLE_ID,
  MANAGED_MONTHLY_PRODUCT_ID,
  MANAGED_REVENUECAT_APP_ID,
  appleFixtureProof,
  verifyAppleMaterial,
} from "../convex/appleSubscription";
import {
  challengeSigningPayload,
  createDeviceChallenge,
  encodeBase64Url,
  verifyP256Signature,
} from "../convex/deviceAuth";
import { readManagedRuntimeConfig } from "../convex/managedConfig";
import {
  parseRevenueCatWebhook,
  revenueCatHmacHeader,
  verifyRevenueCatWebhook,
} from "../convex/revenueCatWebhook";
import { validateManagedConvexDeploymentEnvironment } from "../scripts/validate-managed-convex-deploy.mjs";

const publicKeyPlaceholder = JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "hosted-development-fixture", alg: "ES256", use: "sig" });

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MEETLESS_DEPLOYMENT_MODE: "hosted-development",
    MEETLESS_MANAGED_ALLOWANCE_SECONDS: "42",
    MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test",
    MEETLESS_MANAGED_PROVIDER_MODE: "fake",
    MEETLESS_APPLE_VERIFIER_MODE: "fixture",
    MEETLESS_AUTH_ISSUER: "https://meetless.invalid/hosted-development",
    MEETLESS_AUTH_AUDIENCE: "meetless-managed",
    MEETLESS_AUTH_KEY_ID: "hosted-development-fixture",
    MEETLESS_AUTH_PRIVATE_KEY_PKCS8: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    MEETLESS_AUTH_PUBLIC_JWK: publicKeyPlaceholder,
    MEETLESS_REVENUECAT_AUTH_MODE: "authorization",
    MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER: "fixture-webhook-token",
    MEETLESS_REVENUECAT_ENVIRONMENT: "SANDBOX",
    ...overrides,
  };
}

describe("hosted-development Convex boundaries", () => {
  test("requires explicit labeled allowance and fails closed for production fakes", () => {
    expect(readManagedRuntimeConfig(environment()).allowanceSeconds).toBe(42);
    expect(() => readManagedRuntimeConfig(environment({ MEETLESS_MANAGED_ALLOWANCE_SECONDS: "" }))).toThrow(/allowance/i);
    expect(() => readManagedRuntimeConfig(environment({ MEETLESS_MANAGED_ALLOWANCE_SOURCE: "production-config" }))).toThrow(/source label/);
    expect(() => readManagedRuntimeConfig(environment({
      MEETLESS_DEPLOYMENT_MODE: "production",
      MEETLESS_MANAGED_ALLOWANCE_SOURCE: "production-config",
      MEETLESS_MANAGED_PROVIDER_MODE: "fake",
      MEETLESS_APPLE_VERIFIER_MODE: "fixture",
      MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION",
      MEETLESS_AUTH_ISSUER: "https://meetless.invalid/production",
      MEETLESS_AUTH_KEY_ID: "production-key",
      MEETLESS_REVENUECAT_AUTH_MODE: "authorization",
    }))).toThrow(/real provider/);
    expect(readManagedRuntimeConfig(environment({
      MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test",
    })).mode).toBe("hosted-development");
  });

  test("creates a bound one-use challenge and verifies a nonpersistent P-256 signature", async () => {
    const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = encodeBase64Url(new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey)));
    const challenge = createDeviceChallenge({
      challengeId: "challenge-1",
      purpose: "enrollment",
      deviceId: "device-1",
      keyId: "key-1",
      publicKey,
      nowMs: 100,
      nonce: "01234567890123456789012345678901",
    });
    const payload = challengeSigningPayload(challenge);
    const signature = encodeBase64Url(new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, payload)));
    expect(await verifyP256Signature(publicKey, signature, payload)).toBe(true);
    expect(await verifyP256Signature(publicKey, signature, new TextEncoder().encode("wrong"))).toBe(false);
    expect(() => createDeviceChallenge({ ...challenge, nowMs: 100, challengeId: "", nonce: challenge.nonce })).toThrow(/identifiers/);
  });

  test("verifies fixture Apple material while the real adapter remains an explicit external contract", async () => {
    const material = {
      adapter: "fixture" as const,
      bundleId: MANAGED_APPLE_BUNDLE_ID,
      environment: "SANDBOX" as const,
      productId: MANAGED_MONTHLY_PRODUCT_ID,
      originalTransactionId: "fixture-original-1",
      periodType: "normal" as const,
      startedAtMs: 1_000,
      expiresAtMs: 10_000,
      currentState: "active" as const,
    };
    const checked = { ...material, fixtureProof: await appleFixtureProof(material) };
    await expect(verifyAppleMaterial(checked, "fixture", 2_000)).resolves.toMatchObject({ product: "monthly", lineageKey: expect.stringMatching(/^apple-lineage:/u) });
    await expect(verifyAppleMaterial({ ...checked, productId: MANAGED_ANNUAL_PRODUCT_ID }, "fixture", 2_000)).rejects.toThrow(/fixture proof/);
    await expect(verifyAppleMaterial({ ...checked, adapter: "app-store-server-api" }, "app-store-server-api", 2_000)).rejects.toThrow(/external|unconfigured/);
  });

  test("authenticates the current RevenueCat raw-body mechanism and filters exact catalog/environment", async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      api_version: "1.0",
      event: {
        id: "event-1",
        app_id: MANAGED_REVENUECAT_APP_ID,
        product_id: MANAGED_MONTHLY_PRODUCT_ID,
        environment: "SANDBOX",
        original_transaction_id: "fixture-original-1",
        type: "CANCELLATION",
        event_timestamp_ms: 3_000,
      },
    }));
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await revenueCatHmacHeader(body, "secret", timestamp);
    await expect(verifyRevenueCatWebhook(body, { "X-RevenueCat-Webhook-Signature": signature }, { mode: "hmac", signingSecret: "secret" })).resolves.toBeUndefined();
    await expect(verifyRevenueCatWebhook(new TextEncoder().encode(`${new TextDecoder().decode(body)} `), { "X-RevenueCat-Webhook-Signature": signature }, { mode: "hmac", signingSecret: "secret" })).rejects.toThrow(/signature/);
    await expect(verifyRevenueCatWebhook(body, { Authorization: "fixture-token" }, { mode: "authorization", authorizationHeader: "fixture-token" })).resolves.toBeUndefined();
    expect(parseRevenueCatWebhook(body, MANAGED_REVENUECAT_APP_ID, [MANAGED_MONTHLY_PRODUCT_ID, MANAGED_ANNUAL_PRODUCT_ID], "SANDBOX")).toMatchObject({ eventId: "event-1", eventType: "CANCELLATION" });
    expect(() => parseRevenueCatWebhook(body, "other-app", [MANAGED_MONTHLY_PRODUCT_ID], "SANDBOX")).toThrow(/app id/);
    expect(() => parseRevenueCatWebhook(body, MANAGED_REVENUECAT_APP_ID, [MANAGED_ANNUAL_PRODUCT_ID], "SANDBOX")).toThrow(/catalog/);
  });

  test("deployment preflight has positive and negative executable proof", () => {
    const script = path.resolve("scripts/validate-managed-convex-deploy.mjs");
    const positive = spawnSync(process.execPath, [script, "--check-only"], { cwd: path.resolve("."), env: environment(), encoding: "utf8" });
    expect(positive.status).toBe(0);
    expect(positive.stdout).toContain('"result":"passed"');
    const negative = spawnSync(process.execPath, [script, "--production", "--check-only"], { cwd: path.resolve("."), env: environment(), encoding: "utf8" });
    expect(negative.status).not.toBe(0);
    expect(negative.stderr).toContain("production deployment preflight");
    expect(() => validateManagedConvexDeploymentEnvironment(environment({ MEETLESS_MANAGED_ALLOWANCE_SECONDS: "43" }))).not.toThrow();
  });
});
