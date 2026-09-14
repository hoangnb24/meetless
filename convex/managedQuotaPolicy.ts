import { MANAGED_MAX_DEVICES } from "./managedConfig";

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

function requireInstant(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

export interface VerifiedQuotaTerm {
  readonly product: ManagedQuotaProduct;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly startedAt: number;
  readonly transactionPurchaseAt?: number;
  readonly transactionSignedAt?: number;
  readonly expiresAt: number;
}

/** Calendar months retain the purchase day, clamped independently at month end. */
export function anchoredCalendarMonth(anchor: number, offset: number): number {
  const date = new Date(anchor);
  const monthStart = new Date(anchor);
  monthStart.setUTCDate(1);
  monthStart.setUTCMonth(monthStart.getUTCMonth() + offset);
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
  monthStart.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return monthStart.getTime();
}

export type ManagedQuotaSchedule =
  | { readonly kind: "calendar_month"; readonly anchorAt: number }
  | { readonly kind: "sandbox"; readonly anchorAt: number; readonly termDurationMs: number; readonly periodsPerTerm: 1 | 12 };

function validateTerm(term: VerifiedQuotaTerm): number {
  const purchase = term.transactionPurchaseAt;
  if (purchase === undefined || term.transactionSignedAt === undefined) throw new Error("Managed quota period requires fresh authoritative subscription evidence");
  requireInstant(term.startedAt, "Apple subscription start");
  requireInstant(purchase, "Apple transaction purchase");
  requireInstant(term.transactionSignedAt, "Apple transaction signature");
  requireInstant(term.expiresAt, "Apple subscription expiry");
  if (purchase < term.startedAt || purchase >= term.expiresAt) throw new Error("Managed verified quota term bounds are invalid");
  return purchase;
}

/** Entitlement term and quota cadence are independent after the initial anchor. */
export function quotaScheduleForTerm(term: VerifiedQuotaTerm, anchorAt = term.transactionPurchaseAt): ManagedQuotaSchedule {
  const purchase = validateTerm(term);
  if (anchorAt === undefined || term.product === "trial") throw new Error("Managed paid quota schedule requires verified paid evidence");
  requireInstant(anchorAt, "quota anchor");
  if (term.environment === "PRODUCTION") return { kind: "calendar_month", anchorAt };
  const periodsPerTerm = term.product === "annual" ? 12 : 1;
  const termDurationMs = term.expiresAt - purchase;
  if (termDurationMs < periodsPerTerm) throw new Error("Managed sandbox quota term is too short for distinct allocation boundaries");
  return { kind: "sandbox", anchorAt, termDurationMs, periodsPerTerm };
}

export function quotaPeriodForSchedule(schedule: ManagedQuotaSchedule, now: number): { startAt: number; endAt: number } {
  requireInstant(schedule.anchorAt, "quota anchor");
  requireInstant(now, "quota time");
  if (now < schedule.anchorAt) throw new Error("Managed quota schedule has not started");
  let startAt: number;
  let endAt: number;
  if (schedule.kind === "calendar_month") {
    const anchor = new Date(schedule.anchorAt);
    const current = new Date(now);
    let offset = (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + current.getUTCMonth() - anchor.getUTCMonth();
    if (anchoredCalendarMonth(schedule.anchorAt, offset) > now) offset -= 1;
    startAt = anchoredCalendarMonth(schedule.anchorAt, offset);
    endAt = anchoredCalendarMonth(schedule.anchorAt, offset + 1);
  } else {
    const { termDurationMs, periodsPerTerm, anchorAt } = schedule;
    if (!Number.isSafeInteger(termDurationMs) || termDurationMs < periodsPerTerm || periodsPerTerm !== 1 && periodsPerTerm !== 12) throw new Error("Managed sandbox quota cadence is invalid");
    // Round absolute boundaries, never the interval. This partitions the exact
    // verified term without accumulated gaps, including beyond its first 12 slices.
    const boundary = (index: number) => Number(BigInt(anchorAt) + BigInt(index) * BigInt(termDurationMs) / BigInt(periodsPerTerm));
    let index = Number(BigInt(now - anchorAt) * BigInt(periodsPerTerm) / BigInt(termDurationMs));
    if (boundary(index + 1) <= now) index += 1;
    if (boundary(index) > now) index -= 1;
    startAt = boundary(index); endAt = boundary(index + 1);
  }
  requireInstant(startAt, "quota period start"); requireInstant(endAt, "quota period end");
  if (startAt > now || endAt <= now) throw new Error("Managed quota cadence cannot produce a valid current period");
  return { startAt, endAt };
}

/** Initial snapshots use verified evidence; expiry gates access, not the quota reset date. */
export function verifiedQuotaPeriod(term: VerifiedQuotaTerm, now: number): { startAt: number; endAt: number } {
  const purchase = validateTerm(term);
  requireInstant(now, "quota time");
  if (purchase > now) throw new Error("Managed verified quota term bounds are invalid");
  if (term.product === "trial") return { startAt: purchase, endAt: term.expiresAt };
  return quotaPeriodForSchedule(quotaScheduleForTerm(term), Math.min(now, term.expiresAt - 1));
}
