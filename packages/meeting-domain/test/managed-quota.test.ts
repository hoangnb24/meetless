import { describe, expect, test } from "vitest";
import { validateManagedQuotaFailure } from "../src/managed-quota.js";

const denied = { version: 1, kind: "managed_quota_insufficient", requiredSeconds: 23, remainingSeconds: 12, checkedAt: 1_000, resetAt: 2_000 };
describe("shared managed quota failure contract", () => {
  test("accepts only a consistent server snapshot, including unknown reset", () => {
    expect(validateManagedQuotaFailure(denied)).toEqual(denied);
    expect(validateManagedQuotaFailure({ ...denied, resetAt: null }).resetAt).toBeNull();
  });
  test.each([
    { requiredSeconds: 0 }, { remainingSeconds: 23 }, { remainingSeconds: -1 }, { remainingSeconds: 1.5 },
    { checkedAt: Infinity }, { resetAt: 999 }, { resetAt: 1_000 }, { accountId: "renderer-claimed" }, { version: 2 },
  ])("rejects malformed or inconsistent snapshot %j", (change) => {
    expect(() => validateManagedQuotaFailure({ ...denied, ...change })).toThrow("invalid or inconsistent");
  });
});
