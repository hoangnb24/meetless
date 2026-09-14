import { describe, expect, test } from "vitest";
import { readManagedRuntimeConfig } from "../convex/managedConfig";
import { validateManagedConvexDeploymentEnvironment } from "../scripts/validate-managed-convex-deploy.mjs";

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    MEETLESS_DEPLOYMENT_MODE: "hosted-development",
    MEETLESS_MANAGED_ALLOWANCE_SECONDS: "1800",
    MEETLESS_MANAGED_ALLOWANCE_SOURCE: "store-testing-sandbox",
    MEETLESS_MANAGED_PROVIDER_MODE: "real",
    OPENAI_API_KEY: "fixture-key",
    MEETLESS_APPLE_VERIFIER_MODE: "app-store-server-api",
    MEETLESS_APPLE_APP_ID: "123456789",
    MEETLESS_APPLE_ROOT_CERTIFICATES_BASE64: "fixture-root",
    MEETLESS_AUTH_ISSUER: "https://api.meetless.app",
    MEETLESS_AUTH_AUDIENCE: "meetless-managed",
    MEETLESS_AUTH_KEY_ID: "managed-production-key",
    MEETLESS_AUTH_PRIVATE_KEY_PKCS8: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    MEETLESS_AUTH_PUBLIC_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "managed-production-key", alg: "ES256", use: "sig" }),
    MEETLESS_REVENUECAT_AUTH_MODE: "hmac",
    MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET: "fixture-secret",
    MEETLESS_REVENUECAT_ENVIRONMENT: "SANDBOX",
    ...overrides,
  };
}

describe("explicit store-testing allowance configuration", () => {
  test("accepts the approved source and amount with real adapters", () => {
    expect(readManagedRuntimeConfig(environment())).toMatchObject({ allowanceSeconds: 1800, allowanceSource: "store-testing-sandbox" });
    expect(validateManagedConvexDeploymentEnvironment(environment())).toMatchObject({ allowanceSeconds: 1800, allowanceSource: "store-testing-sandbox" });
  });
  test.each([
    { MEETLESS_MANAGED_ALLOWANCE_SECONDS: undefined },
    { MEETLESS_MANAGED_ALLOWANCE_SECONDS: "28800" },
    { MEETLESS_MANAGED_ALLOWANCE_SOURCE: undefined },
    { MEETLESS_MANAGED_PROVIDER_MODE: "fake" },
    { MEETLESS_APPLE_VERIFIER_MODE: "fixture" },
    { MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION" },
    { MEETLESS_DEPLOYMENT_MODE: "production", MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION" },
    { MEETLESS_DEPLOYMENT_MODE: "test" },
  ])("rejects incompatible or incomplete config %j", overrides => {
    expect(() => readManagedRuntimeConfig(environment(overrides))).toThrow();
    expect(() => validateManagedConvexDeploymentEnvironment(environment(overrides))).toThrow();
  });
  test("retains explicit hosted-development and production amounts", () => {
    for (const overrides of [
      { MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test", MEETLESS_MANAGED_ALLOWANCE_SECONDS: "42" },
      { MEETLESS_DEPLOYMENT_MODE: "production", MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION", MEETLESS_MANAGED_ALLOWANCE_SOURCE: "production-config", MEETLESS_MANAGED_ALLOWANCE_SECONDS: "28800" },
    ]) {
      expect(readManagedRuntimeConfig(environment(overrides)).allowanceSeconds).toBe(Number(overrides.MEETLESS_MANAGED_ALLOWANCE_SECONDS));
      expect(() => validateManagedConvexDeploymentEnvironment(environment(overrides))).not.toThrow();
    }
  });
});
