import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
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
import {
  HOSTED_DEV_TARGET,
  HOSTED_CANARY_READ_ENVIRONMENT_NAMES,
  HOSTED_DEV_ENVIRONMENT_NAMES,
  assertHostedCliArguments,
  assertHostedDevTarget,
  assertHostedUrl,
  classifyHostedDiagnostic,
  formatHostedDotenv,
  formatHostedDotenvValue,
  formatHostedDiagnostic,
  parseHostedEnvironmentNames,
  parseHostedFunctionSpec,
  redactHostedDiagnostic,
  validateHostedEnvironmentNames,
} from "../scripts/prove-managed-convex-hosted-dev-target.mjs";
import { buildInlinePublicJwks } from "../convex/auth.config";
import { assertHostedCanaryInvocation, preserveHostedStageError } from "../scripts/prove-managed-convex-hosted-dev.mjs";
import {
  assertHostedCanaryAccountOwnership,
  MAX_HOSTED_CANARY_JANITOR_DEVICES,
  validateHostedCanaryDeviceIds,
} from "../convex/managedCanaryJanitor";

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
  test("parses and validates empty or exact approved environment-name fixtures", () => {
    const names = [
      "MEETLESS_APPLE_VERIFIER_MODE",
      "MEETLESS_AUTH_AUDIENCE",
      "MEETLESS_AUTH_ISSUER",
      "MEETLESS_AUTH_KEY_ID",
      "MEETLESS_AUTH_PRIVATE_KEY_PKCS8",
      "MEETLESS_AUTH_PUBLIC_JWK",
      "MEETLESS_DEPLOYMENT_MODE",
      "MEETLESS_MANAGED_ALLOWANCE_SECONDS",
      "MEETLESS_MANAGED_ALLOWANCE_SOURCE",
      "MEETLESS_MANAGED_PROVIDER_MODE",
      "MEETLESS_REVENUECAT_AUTH_MODE",
      "MEETLESS_REVENUECAT_ENVIRONMENT",
      "MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER",
    ];
    const empty = "No environment variables set (on dev deployment frugal-mandrill-646)";
    expect(parseHostedEnvironmentNames(empty)).toEqual([]);
    expect(validateHostedEnvironmentNames(names.join("\n"), names)).toEqual([...names].sort());
    expect(() => validateHostedEnvironmentNames(names.slice(1).join("\n"), names)).toThrow(/allowlist/i);
    expect(() => validateHostedEnvironmentNames([...names, names[0]].join("\n"), names)).toThrow(/allowlist/i);
    expect(() => parseHostedEnvironmentNames(`${names.join("\n")}\nMEETLESS BAD`)).toThrow(/malformed/i);
    expect(() => validateHostedEnvironmentNames(`${names.slice(0, -1).join("\n")}\nUNEXPECTED_NAME`, names)).toThrow(/allowlist/i);
    expect(HOSTED_DEV_ENVIRONMENT_NAMES).toEqual(names);
  });

  test("locks the hosted canary to the exact dev deployment and routes", () => {
    expect(assertHostedDevTarget()).toEqual(HOSTED_DEV_TARGET);
    expect(assertHostedUrl(HOSTED_DEV_TARGET.cloudUrl, "cloud").origin).toBe(HOSTED_DEV_TARGET.cloudUrl);
    expect(assertHostedUrl(`${HOSTED_DEV_TARGET.cloudUrl}/api/upload?token=fixture`, "cloud").origin).toBe(HOSTED_DEV_TARGET.cloudUrl);
    expect(() => assertHostedDevTarget({ deployment: "other-deployment" })).toThrow(/deployment/i);
    expect(() => assertHostedDevTarget({ reference: "prod/hoang-bang" })).toThrow(/reference/i);
    expect(() => assertHostedDevTarget({ cloudUrl: "https://evil.example/" })).toThrow(/cloud URL/i);
    expect(() => assertHostedUrl("https://frugal-mandrill-646.convex.cloud.evil.example/", "cloud")).toThrow(/outside/i);
    expect(() => assertHostedUrl("https://convex.cloud/", "cloud")).toThrow(/outside/i);
    expect(() => assertHostedUrl(`${HOSTED_DEV_TARGET.cloudUrl}/?username=bad`, "cloud")).not.toThrow();
    expect(() => assertHostedUrl("https://user:pass@frugal-mandrill-646.convex.cloud/", "cloud")).toThrow(/credentials/i);
    expect(() => assertHostedUrl(`${HOSTED_DEV_TARGET.siteUrl}/managed-auth/jwks.json?unexpected=1`, "site", { path: "/managed-auth/jwks.json", allowQuery: false })).toThrow(/query/i);
    expect(() => assertHostedUrl(`${HOSTED_DEV_TARGET.siteUrl}/managed-auth/jwks.json#fragment`, "site", { path: "/managed-auth/jwks.json", allowQuery: false })).toThrow(/fragment/i);
  });

  test("allows only the exact non-production CLI command shapes", () => {
    const envPath = "/private/tmp/hosted-dev-proof/selection.env";
    expect(() => assertHostedCliArguments("env-list", ["env", "list", "--deployment", HOSTED_DEV_TARGET.deployment, "--names-only"])).not.toThrow();
    expect(() => assertHostedCliArguments("env-set", ["env", "set", "--deployment", HOSTED_DEV_TARGET.deployment, "--from-file", envPath], envPath)).not.toThrow();
    expect(() => assertHostedCliArguments("env-set", ["env", "set", "--deployment", HOSTED_DEV_TARGET.deployment, "--from-file", envPath, "--force"], envPath)).not.toThrow();
    expect(() => assertHostedCliArguments("dev", ["deploy", "--prod"], envPath)).toThrow(/allowlist/i);
    expect(() => assertHostedCliArguments("dev", ["dev"])).not.toThrow();
    expect(() => assertHostedCliArguments("dev", ["dev", "--once"])).toThrow(/allowlist/i);
    for (const name of HOSTED_CANARY_READ_ENVIRONMENT_NAMES) {
      expect(() => assertHostedCliArguments("env-get", ["env", "get", name, "--deployment", HOSTED_DEV_TARGET.deployment], name)).not.toThrow();
    }
    expect(() => assertHostedCliArguments("env-get", ["env", "get", "MEETLESS_AUTH_PRIVATE_KEY_PKCS8", "--deployment", HOSTED_DEV_TARGET.deployment], "MEETLESS_AUTH_PRIVATE_KEY_PKCS8")).toThrow(/allowlist/i);
    expect(() => assertHostedCliArguments("env-get", ["env", "get", "MEETLESS_AUTH_PUBLIC_JWK", "--deployment", "other-deployment"], "MEETLESS_AUTH_PUBLIC_JWK")).toThrow(/allowlist/i);
    expect(() => assertHostedCliArguments("env-list", ["env", "list", "--deployment", "prod", "--names-only"])).toThrow(/allowlist/i);
    expect(() => assertHostedCliArguments("function-spec", ["function-spec", "--deployment", HOSTED_DEV_TARGET.deployment])).not.toThrow();
    expect(() => assertHostedCliArguments("function-spec", ["function-spec", "--deployment", "other-deployment"])).toThrow(/allowlist/i);
  });

  test("requires a nonempty function spec whose URL is the exact hosted target", () => {
    expect(parseHostedFunctionSpec(JSON.stringify({ url: HOSTED_DEV_TARGET.cloudUrl, functions: [{ name: "managedAuth:enroll" }] }))).toMatchObject({
      url: HOSTED_DEV_TARGET.cloudUrl,
      functionCount: 1,
    });
    expect(() => parseHostedFunctionSpec(JSON.stringify({ url: HOSTED_DEV_TARGET.cloudUrl, functions: [] }))).toThrow(/empty/i);
    expect(() => parseHostedFunctionSpec(JSON.stringify({ url: "https://other.convex.cloud", functions: [{ name: "x" }] }))).toThrow(/URL/i);
    expect(() => parseHostedFunctionSpec("not-json")).toThrow(/JSON/i);
  });

  test("builds the supported inline public JWKS data URI without private material", () => {
    const publicJwk = { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate", kid: "fixture-kid", alg: "ES256", use: "sig" };
    const uri = buildInlinePublicJwks(publicJwk, "fixture-kid");
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    const encoded = uri.slice("data:application/json;base64,".length);
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(decoded).toEqual({ keys: [publicJwk] });
    expect(decoded.keys[0]).not.toHaveProperty("d");
    expect(() => buildInlinePublicJwks({ ...publicJwk, d: "private" }, "fixture-kid")).toThrow(/public/i);
    expect(() => buildInlinePublicJwks(publicJwk, "other-kid")).toThrow(/identifier/i);
  });

  test("keeps the auth config environment surface limited to custom JWT inputs", () => {
    const source = readFileSync(path.resolve("convex/auth.config.ts"), "utf8");
    expect(source).not.toContain("readManagedRuntimeConfig");
    expect(source).not.toContain("MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET");
    expect(source).toContain("MEETLESS_AUTH_PUBLIC_JWK");
  });

  test("classifies and bounds deploy diagnostics without exposing secrets or headers", () => {
    const secret = "fixture-admin-token";
    const raw = `authorization: Bearer ${secret}\nschema push failed\n${"x".repeat(20_000)}`;
    const diagnostic = formatHostedDiagnostic(raw, [secret], 256);
    expect(diagnostic.classification).toBe("authorization");
    expect(Buffer.byteLength(diagnostic.stderr, "utf8")).toBeLessThanOrEqual(256);
    expect(diagnostic.stderr).not.toContain(secret);
    expect(diagnostic.stderr).not.toMatch(/authorization:\s*Bearer/i);
    expect(redactHostedDiagnostic("deadline exceeded", [], 256)).toBe("deadline exceeded");
    expect(classifyHostedDiagnostic("codegen failed")).toBe("codegen");
    expect(classifyHostedDiagnostic("schema deployment failed")).toBe("deployment");
    expect(classifyHostedDiagnostic("network redirect rejected")).toBe("network");
  });

  test("preserves the failing stage and redacts its diagnostic", () => {
    const secret = "Bearer fixture-webhook-token";
    const error = preserveHostedStageError("jwks-check", new Error(`authorization ${secret} failed`), [secret], 256);
    expect(error.stage).toBe("jwks-check");
    expect(error.diagnostic.classification).toBe("authorization");
    expect(error.diagnostic.stderr).not.toContain(secret);
    expect(error.diagnostic.stderr).not.toContain("fixture-webhook-token");
    expect(() => assertHostedCanaryInvocation(["--canary-only"])).not.toThrow();
    expect(() => assertHostedCanaryInvocation(["--run"])).not.toThrow();
    expect(() => assertHostedCanaryInvocation(["--deploy"])).toThrow(/opt-in/i);
  });

  test("bounds hosted canary janitor IDs and proves complete account ownership", () => {
    const first = "hosted-canary-device-00000000-0000-4000-8000-000000000001";
    const second = "hosted-canary-device-00000000-0000-4000-8000-000000000002";
    expect(validateHostedCanaryDeviceIds([first, second])).toEqual([first, second]);
    expect(assertHostedCanaryAccountOwnership([first, second], [
      { accountId: "fixture-account", deviceId: first },
      { accountId: "fixture-account", deviceId: second },
    ])).toEqual({ accountId: "fixture-account", deviceIds: [first, second] });
    expect(() => validateHostedCanaryDeviceIds([first, first])).toThrow(/duplicate/i);
    expect(() => validateHostedCanaryDeviceIds([])).toThrow(/non-empty/i);
    expect(() => validateHostedCanaryDeviceIds(["device-real"])).toThrow(/canonical/i);
    expect(() => validateHostedCanaryDeviceIds(Array.from({ length: MAX_HOSTED_CANARY_JANITOR_DEVICES + 1 }, (_, index) => `hosted-canary-device-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`))).toThrow(/bounded|limit/i);
    expect(() => assertHostedCanaryAccountOwnership([first], [
      { accountId: "fixture-account", deviceId: first },
      { accountId: "fixture-account", deviceId: second },
    ])).toThrow(/unrequested|missing/i);
    expect(() => assertHostedCanaryAccountOwnership([first], [
      { accountId: "fixture-account", deviceId: first },
      { accountId: "fixture-account", deviceId: "real-device" },
    ])).toThrow(/non-canary/i);
    expect(() => assertHostedCanaryAccountOwnership([first], [
      { accountId: "fixture-account", deviceId: first },
      { accountId: "other-account", deviceId: first },
    ])).toThrow(/ambiguous|duplicate/i);
    const authSource = readFileSync(path.resolve("convex/managedAuth.ts"), "utf8");
    expect(authSource).toContain('config.mode !== "hosted-development"');
    expect(authSource).toContain("deleteFixtureAccount(ctx, target.accountId, target.lineageKey)");
    expect(authSource).toContain('ctx.db.system.query("_storage")');
  });

  test("formats hosted environment values for an exact dotenv round-trip without logging secrets", async () => {
    const dotenv = await import("dotenv");
    const values = {
      JSON_VALUE: '{"kty":"EC","kid":"fixture"}',
      PEM_VALUE: "-----BEGIN PRIVATE KEY-----\nfixture\\nline\n-----END PRIVATE KEY-----",
      QUOTED_VALUE: "both 'single' and \"double\" quotes",
      BACKSLASH_VALUE: "C:\\fixture\\path\\nliteral",
      NEWLINE_VALUE: "first\nsecond",
      SCALAR_VALUE: "hosted-development",
    };
    const formatted = formatHostedDotenv(values);
    const parsed = dotenv.parse(formatted);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(parsed).toEqual(values);
    expect(formatted).toContain(`JSON_VALUE=${values.JSON_VALUE}`);
    expect(formatted).not.toContain('JSON_VALUE="{\\"');
    expect(() => formatHostedDotenvValue("line\rbreak")).toThrow(/control character/i);
    expect(() => formatHostedDotenv({ "BAD NAME": "value" })).toThrow(/malformed/i);
    expect(() => formatHostedDotenvValue("'`\"\nvalue")).toThrow(/represented safely/i);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

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
