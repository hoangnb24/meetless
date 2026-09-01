import { MANAGED_MAX_DEVICES, MANAGED_TRIAL_SECONDS } from "./managedConfig";

export interface ManagedDeviceAdmissionRecord {
  readonly deviceId: string;
  readonly revokedAt: number | null;
}

export interface ManagedDeviceAdmissionDecision {
  readonly restored: boolean;
  readonly reactivating: boolean;
  readonly activeDeviceCount: number;
  readonly activeDeviceLimit: number;
}

/**
 * A revoked installation is a new active-slot admission even when its device
 * identifier is known. An already-active identifier is idempotent and does
 * not consume another slot.
 */
export function planManagedDeviceEnrollment(
  devices: readonly ManagedDeviceAdmissionRecord[],
  requestedDeviceId: string,
  configuredMaxDevices: number,
): ManagedDeviceAdmissionDecision {
  if (!requestedDeviceId.trim()) throw new Error("Managed device enrollment requires a non-empty device identifier");
  if (!Number.isSafeInteger(configuredMaxDevices) || configuredMaxDevices < 1) {
    throw new Error("Managed account active-device limit is invalid; refuse enrollment rather than weakening the three-device policy");
  }
  const activeDeviceLimit = Math.min(configuredMaxDevices, MANAGED_MAX_DEVICES);
  const currentDevice = devices.find((device) => device.deviceId === requestedDeviceId);
  const reactivating = currentDevice !== undefined && currentDevice.revokedAt !== null;
  const requiresActiveSlot = currentDevice === undefined || reactivating;
  const activeDeviceCount = devices.filter((device) => device.revokedAt === null).length;
  if (requiresActiveSlot && activeDeviceCount >= activeDeviceLimit) {
    throw new Error("Managed account has reached its three active-device enrollment limit; revoke an active Mac before enrolling or reactivating this device");
  }
  return {
    restored: currentDevice !== undefined,
    reactivating,
    activeDeviceCount,
    activeDeviceLimit,
  };
}

export type ManagedQuotaProduct = "monthly" | "annual" | "trial";

export interface VerifiedQuotaPeriodInput {
  readonly accountId: string;
  readonly product: ManagedQuotaProduct;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ManagedQuotaAccountRecord {
  readonly accountId: string;
  readonly currentPeriodStartAt: number;
  readonly currentPeriodEndAt: number;
  readonly nextPeriodLimitSeconds: number;
  readonly allowanceSource: string;
  readonly maxDevices: number;
}

export interface ManagedQuotaPeriodRecord {
  readonly accountId: string;
  readonly product: ManagedQuotaProduct;
  readonly startAt: number;
  readonly endAt: number;
  readonly limitSeconds: number;
  readonly usedSeconds: number;
  readonly reservedSeconds: number;
}

export interface ManagedQuotaProjection {
  readonly account: ManagedQuotaAccountRecord;
  readonly period: ManagedQuotaPeriodRecord;
}

export type ManagedQuotaEnrollmentPlan =
  | { readonly kind: "create"; readonly projection: ManagedQuotaProjection }
  | { readonly kind: "preserve"; readonly projection: ManagedQuotaProjection };

/**
 * The first quota snapshot is anchored to the verified Apple transaction.
 * Re-enrollment/restoration preserves the existing snapshot and its ledger;
 * it never resets usage or moves a reset date to enrollment time.
 */
export function planManagedQuotaEnrollment(
  existing: ManagedQuotaProjection | null,
  verified: VerifiedQuotaPeriodInput,
  allowanceSeconds: number,
  allowanceSource: string,
  enrolledAtMs: number,
): ManagedQuotaEnrollmentPlan {
  if (existing) {
    if (existing.account.accountId !== verified.accountId || existing.period.accountId !== verified.accountId) {
      throw new Error("Managed quota replay account identity does not match the verified Apple lineage; refuse to reset or merge ledgers");
    }
    if (existing.account.currentPeriodStartAt !== existing.period.startAt || existing.account.currentPeriodEndAt !== existing.period.endAt) {
      throw new Error("Managed quota account and period snapshot disagree; refuse replay rather than resetting usage");
    }
    return { kind: "preserve", projection: existing };
  }
  requireInstant(verified.startedAtMs, "Apple subscription start");
  requireInstant(verified.expiresAtMs, "Apple subscription expiry");
  if (verified.expiresAtMs <= verified.startedAtMs) throw new Error("Apple-anchored quota period must have a positive duration");
  requireInstant(enrolledAtMs, "enrollment time");
  if (!Number.isSafeInteger(allowanceSeconds) || allowanceSeconds <= 0) throw new Error("Managed quota allowance must be a positive safe integer");
  if (!allowanceSource.trim()) throw new Error("Managed quota allowance source is required");

  const limitSeconds = verified.product === "trial" ? MANAGED_TRIAL_SECONDS : allowanceSeconds;
  const projection: ManagedQuotaProjection = {
    account: {
      accountId: verified.accountId,
      currentPeriodStartAt: verified.startedAtMs,
      currentPeriodEndAt: verified.expiresAtMs,
      nextPeriodLimitSeconds: allowanceSeconds,
      allowanceSource: verified.product === "trial" ? "product-trial-fixed" : allowanceSource,
      maxDevices: MANAGED_MAX_DEVICES,
    },
    period: {
      accountId: verified.accountId,
      product: verified.product,
      startAt: verified.startedAtMs,
      endAt: verified.expiresAtMs,
      limitSeconds,
      usedSeconds: 0,
      reservedSeconds: 0,
    },
  };
  return { kind: "create", projection };
}

function requireInstant(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
