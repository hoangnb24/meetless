export const HOSTED_CANARY_DEVICE_PREFIX = "hosted-canary-device-";
export const MAX_HOSTED_CANARY_JANITOR_DEVICES = 4;

const HOSTED_CANARY_DEVICE_ID = /^hosted-canary-device-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface HostedCanaryDeviceRecord {
  readonly accountId: string;
  readonly deviceId: string;
}
/**
 * Validate the operator-supplied deletion set before any database lookup.
 * Device IDs are the only durable identity accepted by the hosted-dev janitor.
 */
export function validateHostedCanaryDeviceIds(value: readonly unknown[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Hosted canary janitor requires a non-empty device ID list");
  }
  if (value.length > MAX_HOSTED_CANARY_JANITOR_DEVICES) {
    throw new Error("Hosted canary janitor device list exceeds the bounded request limit");
  }
  const deviceIds = value.map((deviceId) => {
    if (typeof deviceId !== "string" || !HOSTED_CANARY_DEVICE_ID.test(deviceId)) {
      throw new Error("Hosted canary janitor accepts only canonical hosted-canary-device UUIDs");
    }
    return deviceId;
  });
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new Error("Hosted canary janitor refuses duplicate device IDs");
  }
  return deviceIds;
}

/**
 * Prove that an account is entirely represented by the requested canary IDs.
 * The caller passes the account's complete device projection, not a filtered
 * subset, so a real or mixed account cannot be mistaken for a canary account.
 */
export function assertHostedCanaryAccountOwnership(
  requestedDeviceIds: readonly string[],
  accountDevices: readonly HostedCanaryDeviceRecord[],
): { accountId: string; deviceIds: string[] } {
  const requested = validateHostedCanaryDeviceIds(requestedDeviceIds);
  if (!Array.isArray(accountDevices) || accountDevices.length === 0) {
    throw new Error("Hosted canary janitor found no complete device projection for the account");
  }
  const accountIds = new Set<string>();
  const deviceIds: string[] = [];
  for (const device of accountDevices) {
    if (!device || typeof device.accountId !== "string" || !device.accountId || typeof device.deviceId !== "string") {
      throw new Error("Hosted canary janitor found an ambiguous account/device projection");
    }
    accountIds.add(device.accountId);
    if (!HOSTED_CANARY_DEVICE_ID.test(device.deviceId)) {
      throw new Error("Hosted canary janitor refuses an account containing a non-canary device");
    }
    if (deviceIds.includes(device.deviceId)) {
      throw new Error("Hosted canary janitor found duplicate device ownership");
    }
    deviceIds.push(device.deviceId);
  }
  if (accountIds.size !== 1) throw new Error("Hosted canary janitor found ambiguous account ownership");
  const requestedSet = new Set(requested);
  if (deviceIds.length !== requested.length || deviceIds.some((deviceId) => !requestedSet.has(deviceId))) {
    throw new Error("Hosted canary janitor refuses an account with an unrequested or missing device");
  }
  return { accountId: [...accountIds][0]!, deviceIds: [...deviceIds].sort() };
}
