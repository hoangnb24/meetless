#!/usr/bin/env node

const names = {
  mode: "MEETLESS_DEPLOYMENT_MODE",
  allowanceSeconds: "MEETLESS_MANAGED_ALLOWANCE_SECONDS",
  allowanceSource: "MEETLESS_MANAGED_ALLOWANCE_SOURCE",
  providerMode: "MEETLESS_MANAGED_PROVIDER_MODE",
  appleVerifierMode: "MEETLESS_APPLE_VERIFIER_MODE",
  authIssuer: "MEETLESS_AUTH_ISSUER",
  authAudience: "MEETLESS_AUTH_AUDIENCE",
  authKeyId: "MEETLESS_AUTH_KEY_ID",
  authPrivateKey: "MEETLESS_AUTH_PRIVATE_KEY_PKCS8",
  authPublicJwk: "MEETLESS_AUTH_PUBLIC_JWK",
  appleRootCertificates: "MEETLESS_APPLE_ROOT_CERTIFICATES_BASE64",
  revenueCatAuthMode: "MEETLESS_REVENUECAT_AUTH_MODE",
  revenueCatSigningSecret: "MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET",
  revenueCatEnvironment: "MEETLESS_REVENUECAT_ENVIRONMENT",
};

export function validateManagedConvexDeploymentEnvironment(env = process.env, options = {}) {
  const required = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value) throw new Error(`${name} is required; no production fallback exists`);
    return value;
  };
  const mode = required(names.mode);
  if (mode !== "production" && mode !== "hosted-development" && mode !== "test") throw new Error(`${names.mode} is unsupported`);
  if (options.production === true && mode !== "production") throw new Error("production deployment preflight requires MEETLESS_DEPLOYMENT_MODE=production");
  const allowanceText = required(names.allowanceSeconds);
  if (!/^[1-9][0-9]*$/u.test(allowanceText) || !Number.isSafeInteger(Number(allowanceText))) throw new Error(`${names.allowanceSeconds} must be a positive safe whole-second value`);
  const allowanceSource = required(names.allowanceSource);
  const providerMode = required(names.providerMode);
  const appleVerifierMode = required(names.appleVerifierMode);
  const issuer = required(names.authIssuer);
  const audience = required(names.authAudience);
  const keyId = required(names.authKeyId);
  const privateKey = required(names.authPrivateKey);
  const publicJwkText = required(names.authPublicJwk);
  const appleRootCertificates = String(env[names.appleRootCertificates] ?? "").trim();
  const revenueCatAuthMode = required(names.revenueCatAuthMode);
  const environment = required(names.revenueCatEnvironment);
  const signingSecret = String(env[names.revenueCatSigningSecret] ?? "").trim();
  if (providerMode !== "fake" && providerMode !== "real") throw new Error(`${names.providerMode} is unsupported`);
  if (appleVerifierMode !== "fixture" && appleVerifierMode !== "app-store-server-api") throw new Error(`${names.appleVerifierMode} is unsupported`);
  if (revenueCatAuthMode !== "hmac") throw new Error(`${names.revenueCatAuthMode} must be hmac; authorization headers are not accepted`);
  if (environment !== "SANDBOX" && environment !== "PRODUCTION") throw new Error(`${names.revenueCatEnvironment} is unsupported`);
  if (!signingSecret) throw new Error(`${names.revenueCatSigningSecret} is required for HMAC webhook verification`);
  if (appleVerifierMode === "app-store-server-api" && !appleRootCertificates) throw new Error(`${names.appleRootCertificates} is required for Apple signed transaction verification`);
  if (!privateKey.includes("BEGIN PRIVATE KEY")) throw new Error(`${names.authPrivateKey} must contain a PKCS8 private key`);
  let publicJwk;
  try { publicJwk = JSON.parse(publicJwkText); } catch { throw new Error(`${names.authPublicJwk} must be valid JSON`); }
  if (!publicJwk || publicJwk.kty !== "EC" || publicJwk.crv !== "P-256" || typeof publicJwk.x !== "string" || typeof publicJwk.y !== "string" || publicJwk.alg !== "ES256" || publicJwk.use !== "sig" || publicJwk.kid !== keyId || Object.hasOwn(publicJwk, "d")) {
    throw new Error(`${names.authPublicJwk} must contain only the configured ES256 public key`);
  }
  if (mode === "production") {
    if (allowanceSource !== "production-config") throw new Error("production allowance source must be production-config");
    if (providerMode !== "real") throw new Error("production provider mode must be real");
    if (appleVerifierMode !== "app-store-server-api") throw new Error("production Apple verifier must be app-store-server-api");
    if (environment !== "PRODUCTION") throw new Error("production RevenueCat environment must be PRODUCTION");
    if (!/^https:\/\//u.test(issuer) || /(?:dev|test|local|fixture|sandbox|invalid)/iu.test(issuer) || /(?:dev|test|local|fixture|sandbox|invalid)/iu.test(keyId)) {
      throw new Error("production JWT issuer and key identifier must not be development identifiers");
    }
  } else {
    if (allowanceSource !== (mode === "hosted-development" ? "hosted-development-test" : "local-test")) throw new Error("non-production allowance source label is invalid");
    if (providerMode !== "fake") throw new Error("non-production deployment must select the fake transcription provider");
    if (environment !== "SANDBOX") throw new Error("non-production RevenueCat environment must be SANDBOX");
  }
  return { mode, allowanceSeconds: Number(allowanceText), allowanceSource, providerMode, appleVerifierMode, issuer, audience, keyId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = validateManagedConvexDeploymentEnvironment(process.env, { production: process.argv.includes("--production") });
    if (process.argv.includes("--check-only")) {
      console.log(JSON.stringify({ preflight: "managed-convex-deploy", result: "passed", mode: result.mode, allowanceSource: result.allowanceSource }));
    }
  } catch (error) {
    console.error(JSON.stringify({ preflight: "managed-convex-deploy", result: "failed", error: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
