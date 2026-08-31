import {
  MANAGED_ANNUAL_PRODUCT_ID,
  MANAGED_APPLE_BUNDLE_ID,
  MANAGED_ENVIRONMENT_VARIABLES,
  MANAGED_MONTHLY_PRODUCT_ID,
  MANAGED_REVENUECAT_APP_ID,
  type ManagedAppleVerifierMode,
} from "./managedConfig";

export {
  MANAGED_ANNUAL_PRODUCT_ID,
  MANAGED_APPLE_BUNDLE_ID,
  MANAGED_MONTHLY_PRODUCT_ID,
  MANAGED_REVENUECAT_APP_ID,
};

export type AppleSubscriptionState = "active" | "grace" | "expired" | "refunded" | "revoked";
export type AppleSubscriptionEnvironment = "SANDBOX" | "PRODUCTION";
export type AppleSubscriptionPeriodType = "normal" | "trial";

/** Plain-data input accepted at the Apple adapter edge. */
export interface AppleVerificationMaterial {
  readonly adapter: "fixture" | "app-store-server-api";
  readonly bundleId: string;
  readonly environment: AppleSubscriptionEnvironment;
  readonly productId: string;
  readonly originalTransactionId: string;
  readonly periodType: AppleSubscriptionPeriodType;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly currentState: AppleSubscriptionState;
  readonly fixtureProof?: string;
  /** Real signed data is accepted only at the adapter boundary and is never persisted or logged. */
  readonly signedTransaction?: string;
}

export interface VerifiedAppleSubscriptionLineage {
  readonly lineageKey: string;
  readonly accountId: string;
  readonly appId: string;
  readonly bundleId: string;
  readonly productId: string;
  readonly product: "monthly" | "annual" | "trial";
  readonly environment: AppleSubscriptionEnvironment;
  readonly periodType: AppleSubscriptionPeriodType;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly currentState: AppleSubscriptionState;
  readonly verifiedAtMs: number;
}

export interface AppleSubscriptionLineageAdapter {
  verify(material: AppleVerificationMaterial, nowMs?: number): Promise<VerifiedAppleSubscriptionLineage>;
}

export class AppleVerificationError extends Error {
  constructor(message: string) {
    super(`Apple subscription verification failed: ${message}`);
    this.name = "AppleVerificationError";
  }
}

export class FixtureAppleSubscriptionLineageAdapter implements AppleSubscriptionLineageAdapter {
  constructor(private readonly now: () => number = () => Date.now()) {}

  verify(material: AppleVerificationMaterial, nowMs = this.now()): Promise<VerifiedAppleSubscriptionLineage> {
    return verifyAppleMaterial(material, "fixture", nowMs);
  }
}

/** Contract placeholder: production owns credentials/network and is not part of this candidate. */
export class AppleAppStoreServerLineageAdapter implements AppleSubscriptionLineageAdapter {
  verify(_material: AppleVerificationMaterial): Promise<VerifiedAppleSubscriptionLineage> {
    throw new AppleVerificationError("App Store Server API adapter is an external production gate");
  }
}

export async function verifyAppleMaterial(
  material: AppleVerificationMaterial,
  configuredMode: ManagedAppleVerifierMode,
  nowMs = Date.now(),
): Promise<VerifiedAppleSubscriptionLineage> {
  validateMaterialShape(material);
  if (material.adapter !== configuredMode) {
    throw new AppleVerificationError(`configured ${MANAGED_ENVIRONMENT_VARIABLES.appleVerifierMode} does not match the submitted adapter`);
  }
  if (material.adapter === "app-store-server-api") {
    throw new AppleVerificationError("App Store Server API verification is intentionally unconfigured in this local candidate");
  }
  if (material.bundleId !== MANAGED_APPLE_BUNDLE_ID) throw new AppleVerificationError("bundle identifier is not the Meetless application");
  if (material.environment !== "SANDBOX") throw new AppleVerificationError("fixture verification accepts only the SANDBOX environment");
  if (material.productId !== MANAGED_MONTHLY_PRODUCT_ID && material.productId !== MANAGED_ANNUAL_PRODUCT_ID) {
    throw new AppleVerificationError("subscription product is not in the exact managed catalog");
  }
  if (material.expiresAtMs <= material.startedAtMs || material.startedAtMs < 0 || material.expiresAtMs < 0) {
    throw new AppleVerificationError("subscription period bounds are invalid");
  }
  if (!Number.isSafeInteger(material.startedAtMs) || !Number.isSafeInteger(material.expiresAtMs) || !Number.isSafeInteger(nowMs)) {
    throw new AppleVerificationError("subscription timestamps are invalid");
  }
  if (material.currentState === "active" && material.expiresAtMs <= nowMs) {
    throw new AppleVerificationError("an active fixture subscription must not already be expired");
  }
  const expectedProof = await appleFixtureProof(material);
  if (material.fixtureProof !== expectedProof) throw new AppleVerificationError("fixture proof does not match the submitted Apple material");
  const lineageKey = await lineageKeyForOriginalTransactionId(material.originalTransactionId);
  return {
    lineageKey,
    accountId: `apple-account:${lineageKey.slice("apple-lineage:".length)}`,
    appId: MANAGED_REVENUECAT_APP_ID,
    bundleId: material.bundleId,
    productId: material.productId,
    product: material.periodType === "trial" ? "trial" : material.productId === MANAGED_ANNUAL_PRODUCT_ID ? "annual" : "monthly",
    environment: material.environment,
    periodType: material.periodType,
    startedAtMs: material.startedAtMs,
    expiresAtMs: material.expiresAtMs,
    currentState: material.currentState,
    verifiedAtMs: nowMs,
  };
}

/** The proof is local-fixture integrity only; it is not Apple authorization. */
export async function appleFixtureProof(material: AppleVerificationMaterial): Promise<string> {
  const payload = JSON.stringify({
    version: 1,
    adapter: material.adapter,
    bundleId: material.bundleId,
    environment: material.environment,
    productId: material.productId,
    originalTransactionId: material.originalTransactionId,
    periodType: material.periodType,
    startedAtMs: material.startedAtMs,
    expiresAtMs: material.expiresAtMs,
    currentState: material.currentState,
  });
  return hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
}

export async function lineageKeyForOriginalTransactionId(originalTransactionId: string): Promise<string> {
  const normalized = originalTransactionId.trim();
  if (!normalized || normalized.length > 256) throw new AppleVerificationError("original transaction lineage is missing or oversized");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return `apple-lineage:${hex(digest)}`;
}

function validateMaterialShape(material: AppleVerificationMaterial): void {
  if (!material || typeof material !== "object") throw new AppleVerificationError("verification material is not an object");
  if (material.adapter !== "fixture" && material.adapter !== "app-store-server-api") throw new AppleVerificationError("adapter is unsupported");
  if (typeof material.originalTransactionId !== "string" || !material.originalTransactionId.trim()) {
    throw new AppleVerificationError("original transaction lineage is required at the adapter boundary");
  }
  if (material.currentState !== "active" && material.currentState !== "grace" && material.currentState !== "expired" && material.currentState !== "refunded" && material.currentState !== "revoked") {
    throw new AppleVerificationError("subscription state is unsupported");
  }
  if (material.periodType !== "normal" && material.periodType !== "trial") throw new AppleVerificationError("period type is unsupported");
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
