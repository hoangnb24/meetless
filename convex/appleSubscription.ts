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

/** Historical R4 fixture input. */
export interface AppleFixtureVerificationMaterial {
  readonly adapter: "fixture";
  readonly bundleId: string;
  readonly environment: "SANDBOX";
  readonly productId: string;
  readonly originalTransactionId: string;
  readonly periodType: AppleSubscriptionPeriodType;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly currentState: AppleSubscriptionState;
  readonly fixtureProof?: string;
}

/** Real Apple material is opaque until the trusted Node adapter verifies it. */
export interface AppleSignedTransactionMaterial {
  readonly adapter: "app-store-server-api";
  readonly signedTransaction: string;
}

export type AppleVerificationMaterial = AppleFixtureVerificationMaterial | AppleSignedTransactionMaterial;

export interface VerifiedAppleSubscriptionLineage {
  readonly adapter: "fixture" | "app-store-server-api";
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

/** Adapter seam used by the Node App Store Server Library boundary. */
export class AppleAppStoreServerLineageAdapter implements AppleSubscriptionLineageAdapter {
  constructor(
    private readonly verifySignedTransaction: (signedTransaction: string, nowMs: number) => Promise<AppleVerifiedTransactionPayload>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async verify(material: AppleVerificationMaterial, nowMs = this.now()): Promise<VerifiedAppleSubscriptionLineage> {
    if (material.adapter !== "app-store-server-api") {
      throw new AppleVerificationError(`configured ${MANAGED_ENVIRONMENT_VARIABLES.appleVerifierMode} does not match the submitted adapter`);
    }
    const payload = await this.verifySignedTransaction(material.signedTransaction, nowMs);
    return normalizeVerifiedAppleTransaction(payload, nowMs);
  }
}

export async function verifyAppleMaterial(
  material: AppleVerificationMaterial,
  configuredMode: ManagedAppleVerifierMode,
  nowMs = Date.now(),
): Promise<VerifiedAppleSubscriptionLineage> {
  if (material.adapter !== configuredMode) {
    throw new AppleVerificationError(`configured ${MANAGED_ENVIRONMENT_VARIABLES.appleVerifierMode} does not match the submitted adapter`);
  }
  if (material.adapter === "app-store-server-api") {
    throw new AppleVerificationError("real signed transactions must be verified by the Node App Store Server adapter");
  }
  validateFixtureMaterial(material);
  const expectedProof = await appleFixtureProof(material);
  if (material.fixtureProof !== expectedProof) throw new AppleVerificationError("fixture proof does not match the submitted Apple material");
  const lineageKey = await lineageKeyForOriginalTransactionId(material.originalTransactionId);
  return lineageFromFields({
    adapter: "fixture",
    lineageKey,
    bundleId: material.bundleId,
    environment: material.environment,
    productId: material.productId,
    periodType: material.periodType,
    startedAtMs: material.startedAtMs,
    expiresAtMs: material.expiresAtMs,
    currentState: material.currentState,
    verifiedAtMs: nowMs,
  });
}

/** Plain fields selected only after Apple signature verification. */
export interface AppleVerifiedTransactionPayload {
  readonly bundleId?: string;
  readonly environment?: string;
  readonly productId?: string;
  readonly originalTransactionId?: string;
  readonly purchaseDate?: number;
  readonly originalPurchaseDate?: number;
  readonly expiresDate?: number;
  readonly signedDate?: number;
  readonly type?: string;
  readonly appAccountToken?: string;
  readonly revocationDate?: number;
  readonly offerType?: number;
  readonly offerDiscountType?: string;
}

export async function normalizeVerifiedAppleTransaction(
  payload: AppleVerifiedTransactionPayload,
  nowMs = Date.now(),
  expectedEnvironment: "Sandbox" | "Production" = "Sandbox",
): Promise<VerifiedAppleSubscriptionLineage> {
  if (!payload || typeof payload !== "object") throw new AppleVerificationError("verified transaction payload is not an object");
  if (payload.bundleId !== MANAGED_APPLE_BUNDLE_ID) throw new AppleVerificationError("bundle identifier is not the Meetless application");
  if (payload.environment !== expectedEnvironment && !(expectedEnvironment === "Sandbox" && payload.environment === "SANDBOX")) {
    throw new AppleVerificationError(`Apple transaction environment must be ${expectedEnvironment}`);
  }
  if (payload.productId !== MANAGED_MONTHLY_PRODUCT_ID && payload.productId !== MANAGED_ANNUAL_PRODUCT_ID) {
    throw new AppleVerificationError("subscription product is not in the exact managed catalog");
  }
  if (payload.type !== "Auto-Renewable Subscription") {
    throw new AppleVerificationError("Apple transaction is not an auto-renewable subscription");
  }
  if (payload.appAccountToken) throw new AppleVerificationError("appAccountToken is not accepted by the V1 identity contract");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new AppleVerificationError("verification clock is invalid");
  const startedAtMs = payload.originalPurchaseDate ?? payload.purchaseDate;
  const expiresAtMs = payload.expiresDate;
  if (typeof startedAtMs !== "number" || !Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= startedAtMs) {
    throw new AppleVerificationError("Apple transaction period bounds are invalid");
  }
  if (payload.signedDate !== undefined && (!Number.isSafeInteger(payload.signedDate) || payload.signedDate < 0 || payload.signedDate > nowMs + 5 * 60 * 1_000)) {
    throw new AppleVerificationError("Apple transaction signed date is invalid or from the future");
  }
  const periodType: AppleSubscriptionPeriodType = payload.offerDiscountType === "FREE_TRIAL" ? "trial" : "normal";
  const currentState: AppleSubscriptionState = payload.revocationDate !== undefined
    ? "refunded"
    : expiresAtMs <= nowMs
      ? "expired"
      : "active";
  if (!payload.originalTransactionId?.trim()) throw new AppleVerificationError("Apple transaction has no original lineage identifier");
  const lineageKey = await lineageKeyForOriginalTransactionId(payload.originalTransactionId);
  return lineageFromFields({
    adapter: "app-store-server-api",
    lineageKey,
    bundleId: payload.bundleId,
    environment: expectedEnvironment === "Production" ? "PRODUCTION" : "SANDBOX",
    productId: payload.productId,
    periodType,
    startedAtMs,
    expiresAtMs,
    currentState,
    verifiedAtMs: nowMs,
  });
}

/** The proof is local-fixture integrity only; it is not Apple authorization. */
export async function appleFixtureProof(material: AppleFixtureVerificationMaterial): Promise<string> {
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

function validateFixtureMaterial(material: AppleFixtureVerificationMaterial): void {
  if (!material || typeof material !== "object") throw new AppleVerificationError("fixture material is not an object");
  if (material.adapter !== "fixture") throw new AppleVerificationError("fixture adapter is unsupported");
  if (typeof material.originalTransactionId !== "string" || !material.originalTransactionId.trim()) throw new AppleVerificationError("fixture original transaction lineage is required");
  if (material.bundleId !== MANAGED_APPLE_BUNDLE_ID) throw new AppleVerificationError("bundle identifier is not the Meetless application");
  if (material.environment !== "SANDBOX") throw new AppleVerificationError("fixture verification accepts only the SANDBOX environment");
  if (material.productId !== MANAGED_MONTHLY_PRODUCT_ID && material.productId !== MANAGED_ANNUAL_PRODUCT_ID) {
    throw new AppleVerificationError("subscription product is not in the exact managed catalog");
  }
  if (material.currentState !== "active" && material.currentState !== "grace" && material.currentState !== "expired" && material.currentState !== "refunded" && material.currentState !== "revoked") {
    throw new AppleVerificationError("subscription state is unsupported");
  }
  if (material.periodType !== "normal" && material.periodType !== "trial") throw new AppleVerificationError("period type is unsupported");
  if (!Number.isSafeInteger(material.startedAtMs) || !Number.isSafeInteger(material.expiresAtMs) || material.startedAtMs < 0 || material.expiresAtMs <= material.startedAtMs) {
    throw new AppleVerificationError("subscription period bounds are invalid");
  }
}

function lineageFromFields(fields: {
  adapter: "fixture" | "app-store-server-api";
  lineageKey: string;
  bundleId: string;
  environment: AppleSubscriptionEnvironment;
  productId: string;
  periodType: AppleSubscriptionPeriodType;
  startedAtMs: number;
  expiresAtMs: number;
  currentState: AppleSubscriptionState;
  verifiedAtMs: number;
}): VerifiedAppleSubscriptionLineage {
  return {
    adapter: fields.adapter,
    lineageKey: fields.lineageKey,
    accountId: `apple-account:${fields.lineageKey.slice("apple-lineage:".length)}`,
    appId: MANAGED_REVENUECAT_APP_ID,
    bundleId: fields.bundleId,
    productId: fields.productId,
    product: fields.periodType === "trial" ? "trial" : fields.productId === MANAGED_ANNUAL_PRODUCT_ID ? "annual" : "monthly",
    environment: fields.environment,
    periodType: fields.periodType,
    startedAtMs: fields.startedAtMs,
    expiresAtMs: fields.expiresAtMs,
    currentState: fields.currentState,
    verifiedAtMs: fields.verifiedAtMs,
  };
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
