/** Shared wire/storage contract only. Backend admission owns quota arithmetic. */
export interface ManagedQuotaFailure {
  readonly version: 1;
  readonly kind: "managed_quota_insufficient";
  readonly requiredSeconds: number;
  readonly remainingSeconds: number;
  readonly checkedAt: number;
  readonly resetAt: number | null;
}

export function validateManagedQuotaFailure(value: unknown): ManagedQuotaFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Managed quota failure must be an object");
  const record = value as Record<string, unknown>;
  const keys = ["version", "kind", "requiredSeconds", "remainingSeconds", "checkedAt", "resetAt"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) ||
    record.version !== 1 || record.kind !== "managed_quota_insufficient" ||
    !Number.isSafeInteger(record.requiredSeconds) || (record.requiredSeconds as number) <= 0 ||
    !Number.isSafeInteger(record.remainingSeconds) || (record.remainingSeconds as number) < 0 ||
    (record.remainingSeconds as number) >= (record.requiredSeconds as number) ||
    !Number.isSafeInteger(record.checkedAt) || (record.checkedAt as number) < 0 || (record.checkedAt as number) > 8_640_000_000_000_000 ||
    (record.resetAt !== null && (!Number.isSafeInteger(record.resetAt) || (record.resetAt as number) <= (record.checkedAt as number) || (record.resetAt as number) > 8_640_000_000_000_000))) {
    throw new Error("Managed quota failure has invalid or inconsistent fields");
  }
  return { version: 1, kind: "managed_quota_insufficient", requiredSeconds: record.requiredSeconds as number,
    remainingSeconds: record.remainingSeconds as number, checkedAt: record.checkedAt as number, resetAt: record.resetAt as number | null };
}
