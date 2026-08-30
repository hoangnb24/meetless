import { describe, expect, test, vi } from "vitest";
import {
  PREMIUM_REQUIRED_MESSAGE,
  PremiumRequiredError,
  PremiumService,
  type PremiumAccessPort,
} from "../src/premium-service.js";

const activeAccess = {
  entitlement: "premium" as const,
  status: "active" as const,
  packages: [{
    packageId: "monthly" as const,
    productId: "com.meetless.app.premium.monthly",
    localizedPrice: "$9.99",
    trialEligible: true,
  }],
  reason: null,
};

function accessPort(overrides: Partial<PremiumAccessPort> = {}): PremiumAccessPort {
  return {
    status: vi.fn(async () => activeAccess),
    purchase: vi.fn(async () => ({ outcome: "active" as const, access: activeAccess })),
    restore: vi.fn(async () => ({ outcome: "active" as const, access: activeAccess })),
    ...overrides,
  };
}

describe("Premium service", () => {
  test("allows Ask only for an active Premium entitlement", async () => {
    const service = new PremiumService(accessPort());

    await expect(service.requireActive()).resolves.toBeUndefined();
  });

  test("fails closed with a stable user-safe error when Premium is inactive", async () => {
    const service = new PremiumService(accessPort({
      status: vi.fn(async () => ({
        entitlement: "premium", status: "inactive", packages: [], reason: null,
      })),
    }));

    await expect(service.requireActive()).rejects.toEqual(new PremiumRequiredError());
    await expect(service.requireActive()).rejects.toThrow(PREMIUM_REQUIRED_MESSAGE);
  });

  test("redacts native status failures as store unavailable", async () => {
    const service = new PremiumService(accessPort({
      status: vi.fn(async () => { throw new Error("RevenueCat secret diagnostic"); }),
    }));

    await expect(service.status()).resolves.toEqual({
      entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable",
    });
  });

  test.each(["purchase", "restore"] as const)("fails closed when %s returns an invalid result", async (operation) => {
    const service = new PremiumService(accessPort({
      [operation]: vi.fn(async () => ({ outcome: "active", access: { ...activeAccess, entitlement: "wrong" } })) as never,
    }));

    const result = operation === "purchase" ? await service.purchase("monthly") : await service.restore();
    expect(result).toEqual({
      outcome: "failed",
      access: { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
    });
  });
});
