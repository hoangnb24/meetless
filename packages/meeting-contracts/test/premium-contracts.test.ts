import { describe, expect, test } from "vitest";
import {
  ManagedDeviceWireSchema,
  MeetingManagedDeviceRevokeRpc,
  MeetingManagedDevicesRpc,
  MeetingPremiumPurchaseRpc,
  PremiumAccessWireSchema,
  PremiumMutationResultWireSchema,
} from "../src/index.js";

describe("Premium wire contracts", () => {
  test("accepts store-localized packages and an active entitlement", () => {
    expect(PremiumAccessWireSchema.parse({
      entitlement: "premium",
      status: "active",
      packages: [{
        packageId: "monthly",
        productId: "com.meetless.app.premium.monthly",
        localizedPrice: "$9.99",
        trialEligible: true,
      }],
      reason: null,
    })).toMatchObject({ status: "active" });
    expect(MeetingPremiumPurchaseRpc.input.parse({ packageId: "annual" })).toEqual({ packageId: "annual" });
  });

  test("rejects contradictory access states and raw store diagnostics", () => {
    expect(() => PremiumAccessWireSchema.parse({
      entitlement: "premium", status: "unavailable", packages: [], reason: null,
    })).toThrow();
    expect(() => PremiumAccessWireSchema.parse({
      entitlement: "premium", status: "inactive", packages: [], reason: "store_unavailable",
    })).toThrow();
    expect(() => PremiumMutationResultWireSchema.parse({
      outcome: "failed",
      access: {
        entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable",
        rawError: "RevenueCat private diagnostic",
      },
    })).toThrow();
  });

  test("keeps anonymous Mac management to the approved public fields", () => {
    const device = {
      deviceId: "device-hash-1",
      label: "This Mac",
      enrolledAt: 1_000,
      lastActiveAt: 2_000,
      revokedAt: null,
      current: true,
    };
    expect(ManagedDeviceWireSchema.parse(device)).toEqual(device);
    expect(MeetingManagedDevicesRpc.output.parse({ devices: [device] })).toEqual({ devices: [device] });
    expect(MeetingManagedDeviceRevokeRpc.input.parse({ deviceId: "device-hash-1" })).toEqual({ deviceId: "device-hash-1" });
    expect(MeetingManagedDeviceRevokeRpc.output.parse({ deviceId: "device-hash-1", outcome: "revoked" })).toEqual({ deviceId: "device-hash-1", outcome: "revoked" });
    expect(() => ManagedDeviceWireSchema.parse({ ...device, computerName: "Alice's Mac" })).toThrow();
    expect(() => MeetingManagedDeviceRevokeRpc.input.parse({ deviceId: "device-hash-1", originalTransactionId: "secret" })).toThrow();
  });
});
