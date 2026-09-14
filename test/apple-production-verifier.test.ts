import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { describe, expect, test } from "vitest";
import { verifySignedAppleTransaction } from "../convex/appleSubscriptionNode";
import { MANAGED_APPLE_BUNDLE_ID, readManagedRuntimeConfig } from "../convex/managedConfig";
import { validateManagedConvexDeploymentEnvironment } from "../scripts/validate-managed-convex-deploy.mjs";

// Local SDK constructor proof only: this trust root and ID are test inputs,
// not Meetless's verified Apple configuration or a real Apple transaction.
const root = new X509Certificate(rootCertificates[0]!).raw;
function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    MEETLESS_DEPLOYMENT_MODE: "production",
    MEETLESS_MANAGED_ALLOWANCE_SECONDS: "28800",
    MEETLESS_MANAGED_ALLOWANCE_SOURCE: "production-config",
    MEETLESS_MANAGED_PROVIDER_MODE: "real",
    OPENAI_API_KEY: "fixture-key",
    MEETLESS_APPLE_VERIFIER_MODE: "app-store-server-api",
    MEETLESS_APPLE_APP_ID: "123456789",
    MEETLESS_APPLE_ROOT_CERTIFICATES_BASE64: root.toString("base64"),
    MEETLESS_AUTH_ISSUER: "https://api.meetless.app",
    MEETLESS_AUTH_AUDIENCE: "meetless-managed",
    MEETLESS_AUTH_KEY_ID: "managed-production-key",
    MEETLESS_AUTH_PRIVATE_KEY_PKCS8: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    MEETLESS_AUTH_PUBLIC_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "managed-production-key", alg: "ES256", use: "sig" }),
    MEETLESS_REVENUECAT_AUTH_MODE: "hmac",
    MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET: "fixture-secret",
    MEETLESS_REVENUECAT_ENVIRONMENT: "PRODUCTION",
    ...overrides,
  };
}

describe("production Apple SDK configuration", () => {
  test.each([undefined, "", "0", "-1", "1.5", "1e9", "abc", "9007199254740992"])("rejects invalid or missing Apple ID %s in runtime and deploy preflight", (id) => {
    const source = environment({ MEETLESS_APPLE_APP_ID: id });
    expect(() => readManagedRuntimeConfig(source)).toThrow(/MEETLESS_APPLE_APP_ID/);
    expect(() => validateManagedConvexDeploymentEnvironment(source)).toThrow(/MEETLESS_APPLE_APP_ID/);
  });

  test("accepts an explicit numeric ID in both config boundaries", () => {
    expect(readManagedRuntimeConfig(environment()).appleAppId).toBe(123456789);
    expect(() => validateManagedConvexDeploymentEnvironment(environment())).not.toThrow();
  });

  test("preserves sandbox compatibility without an Apple ID", async () => {
    const source = environment({ MEETLESS_DEPLOYMENT_MODE: "hosted-development", MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test", MEETLESS_REVENUECAT_ENVIRONMENT: "SANDBOX", MEETLESS_APPLE_APP_ID: undefined });
    const config = readManagedRuntimeConfig(source);
    expect(config.appleAppId).toBeNull();
    expect(() => validateManagedConvexDeploymentEnvironment(source)).not.toThrow();
    await expect(verifySignedAppleTransaction("a.b.c", config)).rejects.toThrow(/could not be cryptographically verified/);
  });

  test("reproduces old constructor failure and reaches real SDK verification with the configured ID", async () => {
    expect(() => new SignedDataVerifier([root], true, Environment.PRODUCTION, MANAGED_APPLE_BUNDLE_ID)).toThrow("appAppleId is required when the environment is Production");
    await expect(verifySignedAppleTransaction("a.b.c", readManagedRuntimeConfig(environment()))).rejects.toThrow(/could not be cryptographically verified/);
  });
});
