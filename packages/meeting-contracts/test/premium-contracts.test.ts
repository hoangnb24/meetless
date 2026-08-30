import { describe, expect, test } from "vitest";
import {
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
});
