"use node";

import { AppStoreServerAPIClient, Environment, SignedDataVerifier, Status, type StatusResponse, type JWSRenewalInfoDecodedPayload } from "@apple/app-store-server-library";
import { AppleVerificationError, normalizeVerifiedAppleTransaction, type AppleVerifiedTransactionPayload, type VerifiedAppleSubscriptionLineage } from "./appleSubscription";
import { MANAGED_APPLE_BUNDLE_ID, type ManagedRuntimeConfig } from "./managedConfig";

// Transport deadline only. RevenueCat owns redelivery; nothing raw is scheduled.
const APPLE_RECONCILIATION_TIMEOUT_MS = 20_000;

export async function verifyCurrentAppleSubscription(originalTransactionId: string, config: ManagedRuntimeConfig, nowMs = Date.now()): Promise<VerifiedAppleSubscriptionLineage> {
  if (config.appleVerifierMode !== "app-store-server-api" || !config.appleApiIssuerId || !config.appleApiKeyId || !config.appleApiPrivateKeyPkcs8 || !config.appleRootCertificatesBase64) {
    throw new AppleVerificationError("Apple status service is not configured");
  }
  if (!/^[0-9]{1,256}$/u.test(originalTransactionId)) throw new AppleVerificationError("Apple lookup identifier is invalid");
  const environment = config.revenueCatEnvironment === "PRODUCTION" ? Environment.PRODUCTION : Environment.SANDBOX;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const client = new AppStoreServerAPIClient(config.appleApiPrivateKeyPkcs8!, config.appleApiKeyId!, config.appleApiIssuerId!, MANAGED_APPLE_BUNDLE_ID, environment);
        const roots = config.appleRootCertificatesBase64!.split(",").map(value => Buffer.from(value.trim(), "base64"));
        const verifier = new SignedDataVerifier(roots, true, environment, MANAGED_APPLE_BUNDLE_ID, config.appleAppId ?? undefined);
        const response = await client.getAllSubscriptionStatuses(originalTransactionId);
        return normalizeAppleSubscriptionStatus(response, originalTransactionId, config, verifier, nowMs);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppleVerificationError("Apple status service timed out")), APPLE_RECONCILIATION_TIMEOUT_MS); }),
    ]);
  } catch {
    // SDK errors can contain raw request identifiers or signed payloads.
    throw new AppleVerificationError("Apple status reconciliation unavailable or unverified");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam verifies response normalization; production supplies Apple's verifier. */
export async function normalizeAppleSubscriptionStatus(
  response: StatusResponse,
  originalTransactionId: string,
  config: Pick<ManagedRuntimeConfig, "revenueCatEnvironment" | "appleAppId">,
  verifier: {
    verifyAndDecodeTransaction(value: string): Promise<AppleVerifiedTransactionPayload>;
    verifyAndDecodeRenewalInfo(value: string): Promise<JWSRenewalInfoDecodedPayload>;
  },
  nowMs: number,
): Promise<VerifiedAppleSubscriptionLineage> {
  const environment = config.revenueCatEnvironment === "PRODUCTION" ? "Production" : "Sandbox";
  if (response.environment !== environment || response.bundleId !== MANAGED_APPLE_BUNDLE_ID
    || (config.appleAppId !== null && response.appAppleId !== config.appleAppId)) throw new AppleVerificationError("Apple status application or environment mismatch");
  const matches = (response.data ?? []).flatMap(group => group.lastTransactions ?? []).filter(item => item.originalTransactionId === originalTransactionId);
  if (matches.length !== 1) throw new AppleVerificationError("Apple status lineage is missing or ambiguous");
  const item = matches[0]!;
  if (!item.signedTransactionInfo || !item.signedRenewalInfo) throw new AppleVerificationError("Apple status signed evidence is missing");
  const [transaction, renewal] = await Promise.all([
    verifier.verifyAndDecodeTransaction(item.signedTransactionInfo), verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo),
  ]);
  if (transaction.originalTransactionId !== originalTransactionId || renewal.originalTransactionId !== originalTransactionId
    || renewal.environment !== environment || renewal.productId !== transaction.productId) throw new AppleVerificationError("Apple signed status lineage or product mismatch");
  const verified = await normalizeVerifiedAppleTransaction(transaction, nowMs, environment);
  if (!Number.isSafeInteger(renewal.signedDate) || renewal.signedDate! < 0 || renewal.signedDate! > nowMs + 5 * 60 * 1_000) throw new AppleVerificationError("Apple renewal signed date is invalid");
  let currentState = verified.currentState;
  let gracePeriodExpiresAtMs: number | undefined;
  switch (item.status) {
    case Status.ACTIVE:
      if (currentState !== "active") throw new AppleVerificationError("Apple active status conflicts with transaction");
      break;
    case Status.BILLING_GRACE_PERIOD:
      gracePeriodExpiresAtMs = renewal.gracePeriodExpiresDate;
      if (currentState === "refunded" || !Number.isSafeInteger(gracePeriodExpiresAtMs) || gracePeriodExpiresAtMs! <= verified.expiresAtMs) throw new AppleVerificationError("Apple grace bounds are invalid");
      currentState = gracePeriodExpiresAtMs! > nowMs ? "grace" : "expired";
      break;
    case Status.EXPIRED:
    case Status.BILLING_RETRY:
      if (currentState !== "expired") throw new AppleVerificationError("Apple expired status conflicts with transaction");
      break;
    case Status.REVOKED:
      if (currentState !== "refunded") throw new AppleVerificationError("Apple revoked status lacks signed revocation");
      break;
    default: throw new AppleVerificationError("Apple subscription status is unsupported");
  }
  return { ...verified, currentState, renewalSignedAtMs: renewal.signedDate!, ...(gracePeriodExpiresAtMs === undefined ? {} : { gracePeriodExpiresAtMs }) };
}
