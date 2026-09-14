import { describe, expect, test, vi } from "vitest";
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


describe("existing-device Apple refresh", () => {
  function setup(supplier?: () => Promise<import("../src/managed-auth.js").ManagedAppleSignedTransactionMaterial | null>) {
    const action = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ version: 1, authToken: "opaque-token", expiresAt: Date.now() + 60_000,
      deviceId: identity.deviceId, keyId: identity.keyId, state: "active", naturalExpiryAt: Date.now() + 60_000 }));
    const mutation = vi.fn(async () => ({ challengeId: "challenge", purpose: "refresh", deviceId: identity.deviceId,
      keyId: identity.keyId, expiresAt: Date.now() + 30_000, signingPayload: "YQ", issuer: "issuer", audience: "audience" }));
    const signer = { identity: async () => identity, signChallenge: async () => ({ ...identity, signature: "signature" }) };
    const source = new ConvexManagedCredentialSource({ action, mutation, query: async () => undefined }, signer, {}, supplier);
    return { source, action, mutation };
  }
  const apple = { adapter: "app-store-server-api" as const, signedTransaction: "opaque-apple-proof" };
  test("attaches fresh evidence on each refresh without enrollment or retaining proof in credential", async () => {
    const supplier = vi.fn(async () => apple);
    const { source, action } = setup(supplier);
    const credential = await source.refresh();
    await source.refresh();
    expect(supplier).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledWith("managedAuthActions:refreshDevice", expect.objectContaining({ apple }));
    expect(action.mock.calls.every(([name]) => name === "managedAuthActions:refreshDevice")).toBe(true);
    expect(JSON.stringify(credential)).not.toContain(apple.signedTransaction);
  });
  test("missing evidence preserves credential-only refresh", async () => {
    const { source, action } = setup(async () => null);
    await source.refresh();
    expect(action).toHaveBeenCalledWith("managedAuthActions:refreshDevice", expect.not.objectContaining({ apple: expect.anything() }));
  });
  test("explicit proof bypasses supplier and failed authentication is never retried as enrollment", async () => {
    const supplier = vi.fn(async () => null);
    const { source, action } = setup(supplier);
    action.mockRejectedValueOnce(new Error("Account mismatch"));
    await expect(source.refresh(apple)).rejects.toThrow("Account mismatch");
    expect(supplier).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });
  test("supplier failure is not treated as absent evidence or retried without proof", async () => {
    const { source, action, mutation } = setup(async () => { throw new Error("Native proof unavailable"); });
    await expect(source.refresh()).rejects.toThrow("Native proof unavailable");
    expect(action).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

});
