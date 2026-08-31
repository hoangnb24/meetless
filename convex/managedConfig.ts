/**
 * Deployment-owned configuration for the managed Convex seam.
 *
 * This module intentionally has no Convex or vendor dependency.  A missing
 * value is an error; an allowance is never inferred from a client, a seed, or
 * a development default.  The deployment preflight in scripts/ mirrors these
 * rules because it runs before the project-owned deploy command.
 */

export const MANAGED_TRIAL_SECONDS = 18_000;
export const MANAGED_MAX_DEVICES = 3;
export const MANAGED_LEASE_MS = 6 * 60 * 60 * 1_000;
export const MANAGED_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_SAMPLE_RATE = 16_000;
export const MANAGED_MAX_PART_SAMPLES = MANAGED_SAMPLE_RATE * 10 * 60;
export const MANAGED_MAX_PART_BYTES = 44 + MANAGED_MAX_PART_SAMPLES * 2;

export const MANAGED_APPLE_BUNDLE_ID = "com.meetless.app";
export const MANAGED_REVENUECAT_APP_ID = "appe0ef526253";
export const MANAGED_MONTHLY_PRODUCT_ID = "com.meetless.app.premium.monthly";
export const MANAGED_ANNUAL_PRODUCT_ID = "com.meetless.app.premium.annual";

export const MANAGED_ENVIRONMENT_VARIABLES = {
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
  revenueCatAuthMode: "MEETLESS_REVENUECAT_AUTH_MODE",
  revenueCatAuthorization: "MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER",
  revenueCatSigningSecret: "MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET",
  revenueCatEnvironment: "MEETLESS_REVENUECAT_ENVIRONMENT",
} as const;

export type ManagedDeploymentMode = "hosted-development" | "test" | "production";
export type ManagedProviderMode = "fake" | "real";
export type ManagedAppleVerifierMode = "fixture" | "app-store-server-api";
export type ManagedRevenueCatAuthMode = "authorization" | "hmac";
export type ManagedRevenueCatEnvironment = "SANDBOX" | "PRODUCTION";

export interface ManagedRuntimeConfig {
  readonly mode: ManagedDeploymentMode;
  readonly allowanceSeconds: number;
  readonly allowanceSource: string;
  readonly providerMode: ManagedProviderMode;
  readonly appleVerifierMode: ManagedAppleVerifierMode;
  readonly authIssuer: string;
  readonly authAudience: string;
  readonly authKeyId: string;
  readonly authPrivateKeyPkcs8: string;
  readonly authPublicJwk: string;
  readonly revenueCatAuthMode: ManagedRevenueCatAuthMode;
  readonly revenueCatAuthorizationHeader: string | null;
  readonly revenueCatSigningSecret: string | null;
  readonly revenueCatEnvironment: ManagedRevenueCatEnvironment;
}

export class ManagedConfigurationError extends Error {
  constructor(message: string) {
    super(`Managed deployment configuration is invalid: ${message}`);
    this.name = "ManagedConfigurationError";
  }
}

export function readManagedRuntimeConfig(
  source: Record<string, string | undefined> = environment(),
): ManagedRuntimeConfig {
  const mode = required(source, MANAGED_ENVIRONMENT_VARIABLES.mode);
  if (mode !== "hosted-development" && mode !== "test" && mode !== "production") {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.mode} must be hosted-development, test, or production`);
  }

  const allowanceSeconds = positiveInteger(source, MANAGED_ENVIRONMENT_VARIABLES.allowanceSeconds);
  const allowanceSource = required(source, MANAGED_ENVIRONMENT_VARIABLES.allowanceSource);
  const providerMode = required(source, MANAGED_ENVIRONMENT_VARIABLES.providerMode);
  const appleVerifierMode = required(source, MANAGED_ENVIRONMENT_VARIABLES.appleVerifierMode);
  const authIssuer = required(source, MANAGED_ENVIRONMENT_VARIABLES.authIssuer);
  const authAudience = required(source, MANAGED_ENVIRONMENT_VARIABLES.authAudience);
  const authKeyId = required(source, MANAGED_ENVIRONMENT_VARIABLES.authKeyId);
  const authPrivateKeyPkcs8 = required(source, MANAGED_ENVIRONMENT_VARIABLES.authPrivateKey);
  const authPublicJwk = required(source, MANAGED_ENVIRONMENT_VARIABLES.authPublicJwk);
  const revenueCatAuthMode = required(source, MANAGED_ENVIRONMENT_VARIABLES.revenueCatAuthMode);
  const revenueCatAuthorizationHeader = optional(source, MANAGED_ENVIRONMENT_VARIABLES.revenueCatAuthorization);
  const revenueCatSigningSecret = optional(source, MANAGED_ENVIRONMENT_VARIABLES.revenueCatSigningSecret);
  const revenueCatEnvironment = required(source, MANAGED_ENVIRONMENT_VARIABLES.revenueCatEnvironment);

  if (providerMode !== "fake" && providerMode !== "real") {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.providerMode} must be fake or real`);
  }
  if (appleVerifierMode !== "fixture" && appleVerifierMode !== "app-store-server-api") {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.appleVerifierMode} is unsupported`);
  }
  if (revenueCatAuthMode !== "authorization" && revenueCatAuthMode !== "hmac") {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.revenueCatAuthMode} must be authorization or hmac`);
  }
  if (revenueCatEnvironment !== "SANDBOX" && revenueCatEnvironment !== "PRODUCTION") {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.revenueCatEnvironment} must be SANDBOX or PRODUCTION`);
  }
  if (revenueCatAuthMode === "authorization" && !revenueCatAuthorizationHeader) {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.revenueCatAuthorization} is required for authorization webhook verification`);
  }
  if (revenueCatAuthMode === "hmac" && !revenueCatSigningSecret) {
    throw new ManagedConfigurationError(`${MANAGED_ENVIRONMENT_VARIABLES.revenueCatSigningSecret} is required for HMAC webhook verification`);
  }

  if (mode === "production") {
    if (allowanceSource !== "production-config") {
      throw new ManagedConfigurationError("production allowance must use the production-config source label");
    }
    if (providerMode !== "real") {
      throw new ManagedConfigurationError("production must select a real provider mode");
    }
    if (appleVerifierMode !== "app-store-server-api") {
      throw new ManagedConfigurationError("production must select the App Store Server API verifier");
    }
    if (revenueCatEnvironment !== "PRODUCTION") {
      throw new ManagedConfigurationError("production must select the PRODUCTION RevenueCat environment");
    }
    if (!/^https:\/\//u.test(authIssuer) || containsDevelopmentMarker(authIssuer) || containsDevelopmentMarker(authKeyId)) {
      throw new ManagedConfigurationError("production issuer and key identifier must be production HTTPS identifiers");
    }
  } else {
    if (allowanceSource !== (mode === "hosted-development" ? "hosted-development-test" : "local-test")) {
      throw new ManagedConfigurationError(`${mode} must use its explicit non-production allowance source label`);
    }
    if (providerMode !== "fake" || appleVerifierMode !== "fixture") {
      throw new ManagedConfigurationError(`${mode} may use only the deterministic fake provider and fixture Apple verifier`);
    }
    if (revenueCatEnvironment !== "SANDBOX") {
      throw new ManagedConfigurationError(`${mode} must use the SANDBOX RevenueCat environment`);
    }
  }

  if (!authIssuer || !authAudience || !authKeyId || !authPrivateKeyPkcs8 || !authPublicJwk) {
    throw new ManagedConfigurationError("custom JWT issuer, key, and public JWKS material are required");
  }

  return {
    mode,
    allowanceSeconds,
    allowanceSource,
    providerMode,
    appleVerifierMode,
    authIssuer,
    authAudience,
    authKeyId,
    authPrivateKeyPkcs8,
    authPublicJwk,
    revenueCatAuthMode,
    revenueCatAuthorizationHeader,
    revenueCatSigningSecret,
    revenueCatEnvironment,
  };
}

export function assertNonProductionFixture(config: ManagedRuntimeConfig, operation: string): void {
  if (config.mode === "production") {
    throw new ManagedConfigurationError(`${operation} is available only in hosted-development or test mode`);
  }
}

function environment(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new ManagedConfigurationError(`${name} is required; no production fallback exists`);
  return value;
}

function optional(source: Record<string, string | undefined>, name: string): string | null {
  const value = source[name]?.trim();
  return value || null;
}

function positiveInteger(source: Record<string, string | undefined>, name: string): number {
  const value = required(source, name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ManagedConfigurationError(`${name} must be a positive whole-second value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ManagedConfigurationError(`${name} exceeds the safe integer range`);
  return parsed;
}

function containsDevelopmentMarker(value: string): boolean {
  return /(?:dev|test|local|fixture|sandbox|invalid)/iu.test(value);
}
