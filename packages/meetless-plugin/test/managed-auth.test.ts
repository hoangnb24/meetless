import { describe, expect, test } from "vitest";
import {
  ConvexManagedCredentialSource,
  type ManagedDeviceSigner,
} from "../src/managed-auth.js";
import type { ManagedConvexFunctionClient } from "../src/managed-upload.js";

const identity = {
  deviceId: "device-test",
  keyId: "key-test",
  publicKey: "public-key-test",
} as const;

function sourceWithActionResult(actionResult: unknown) {
  const client: ManagedConvexFunctionClient = {
    mutation: async () => ({
      challengeId: "challenge-test",
      purpose: "refresh",
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      expiresAt: Date.now() + 30_000,
      signingPayload: Buffer.from("challenge-test").toString("base64url"),
      issuer: "https://issuer.test",
      audience: "meetless",
    }),
    query: async () => undefined,
    action: async () => actionResult,
  };
  const signer: ManagedDeviceSigner = {
    identity: async () => identity,
    signChallenge: async () => ({ ...identity, signature: "signature-test" }),
  };
  return new ConvexManagedCredentialSource(client, signer);
}

describe("managed auth private snapshot", () => {
  test.each([
    ["active", Date.now() + 60_000],
    ["grace", Date.now() + 60_000],
    ["expired", Date.now() - 1],
    ["refunded", Date.now() + 60_000],
    ["revoked", Date.now() + 60_000],
  ] as const)("preserves the backend %s state and natural expiry metadata", async (state, naturalExpiryAt) => {
    const source = sourceWithActionResult({
      version: 1,
      authToken: "token-test",
      expiresAt: Date.now() + 60_000,
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      state,
      naturalExpiryAt,
    });

    await expect(source.refresh()).resolves.toEqual({
      authToken: "token-test",
      expiresAt: expect.any(Number),
      state,
      naturalExpiryAt,
    });
  });

  test("rejects an unversioned or extra-field action response", async () => {
    const source = sourceWithActionResult({
      version: 1,
      authToken: "token-test",
      expiresAt: Date.now() + 60_000,
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      state: "active",
      naturalExpiryAt: Date.now() + 60_000,
      entitlement: "active",
    });

    await expect(source.refresh()).rejects.toThrow();
  });
});
