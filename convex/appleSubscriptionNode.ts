"use node";

import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import {
  AppleVerificationError,
  normalizeVerifiedAppleTransaction,
  type AppleVerifiedTransactionPayload,
  type VerifiedAppleSubscriptionLineage,
} from "./appleSubscription";
import { MANAGED_APPLE_BUNDLE_ID, type ManagedRuntimeConfig } from "./managedConfig";

const MAX_SIGNED_TRANSACTION_LENGTH = 64 * 1024;

/**
 * Trusted Node-only Apple boundary. The JWS and decoded original transaction
 * ID remain in this action's memory; only the normalized lineage is returned.
 */
export async function verifySignedAppleTransaction(
  signedTransaction: string,
  config: ManagedRuntimeConfig,
  nowMs = Date.now(),
): Promise<VerifiedAppleSubscriptionLineage> {
  if (config.appleVerifierMode !== "app-store-server-api") {
    throw new AppleVerificationError("the signed transaction path requires the App Store Server API verifier");
  }
  if (typeof signedTransaction !== "string" || signedTransaction.length === 0 || signedTransaction.length > MAX_SIGNED_TRANSACTION_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(signedTransaction)) {
    throw new AppleVerificationError("signed transaction format is invalid");
  }
  const roots = decodeRootCertificates(config.appleRootCertificatesBase64);
  const environment = config.revenueCatEnvironment === "PRODUCTION" ? Environment.PRODUCTION : Environment.SANDBOX;
  const verifier = new SignedDataVerifier(roots, true, environment, MANAGED_APPLE_BUNDLE_ID);
  let decoded;
  try {
    decoded = await verifier.verifyAndDecodeTransaction(signedTransaction);
  } catch {
    throw new AppleVerificationError("Apple signed transaction could not be cryptographically verified");
  }
  const payload: AppleVerifiedTransactionPayload = {
    bundleId: decoded.bundleId,
    environment: decoded.environment,
    productId: decoded.productId,
    originalTransactionId: decoded.originalTransactionId,
    purchaseDate: decoded.purchaseDate,
    originalPurchaseDate: decoded.originalPurchaseDate,
    expiresDate: decoded.expiresDate,
    signedDate: decoded.signedDate,
    type: decoded.type,
    appAccountToken: decoded.appAccountToken,
    revocationDate: decoded.revocationDate,
    offerType: typeof decoded.offerType === "number" ? decoded.offerType : undefined,
    offerDiscountType: decoded.offerDiscountType,
  };
  return normalizeVerifiedAppleTransaction(
    payload,
    nowMs,
    environment === Environment.PRODUCTION ? "Production" : "Sandbox",
  );
}

function decodeRootCertificates(value: string | null): Buffer[] {
  if (!value) throw new AppleVerificationError("Apple root certificates are not configured");
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 8) throw new AppleVerificationError("Apple root certificate configuration is empty or oversized");
  return entries.map((entry) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(entry)) throw new AppleVerificationError("Apple root certificate is not base64 encoded");
    const decoded = Buffer.from(entry, "base64");
    if (decoded.length < 256 || decoded.length > 16 * 1024) throw new AppleVerificationError("Apple root certificate size is invalid");
    return decoded;
  });
}
