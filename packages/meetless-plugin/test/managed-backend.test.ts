import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ManagedBackendRouter, type AppleEnvironment } from "../src/managed-backend.js";
import { ConvexManagedCredentialSource } from "../src/managed-auth.js";
import { ConvexManagedUploadPort, FileManagedConvexUploadJournal, type ManagedConvexFunctionClient } from "../src/managed-upload.js";

const endpoints = { SANDBOX: "https://sandbox.example.test", PRODUCTION: "https://production.example.test" };
function harness() {
  let environment: AppleEnvironment = "SANDBOX";
  let fail: string | null = null;
  const calls: { endpoint: string; name: string; args: Record<string, unknown>; token?: string }[] = [];
  const client = (endpoint: string): ManagedConvexFunctionClient => {
    let token: string | undefined;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      calls.push({ endpoint, name, args, token });
      if (endpoint === fail) throw new Error("backend unavailable");
      if (name === "managedAuth:createDeviceChallenge") return { purpose: args.purpose, deviceId: args.deviceId, keyId: args.keyId, challengeId: "same-challenge", expiresAt: Date.now() + 60_000, signingPayload: "YQ", issuer: endpoint, audience: "meetless" };
      if (name.includes("Device")) return { version: 1, authToken: `token:${endpoint}`, expiresAt: Date.now() + 60_000, deviceId: "device", keyId: "key", state: "active", naturalExpiryAt: Date.now() + 60_000 };
      return null;
    };
    return { setAuth(value) { token = value; }, mutation: invoke, action: invoke, query: invoke };
  };
  const signer = { identity: async () => ({ deviceId: "device", keyId: "key", publicKey: "cHVibGlj" }), signChallenge: async () => ({ deviceId: "device", keyId: "key", publicKey: "cHVibGlj", signature: "c2ln" }) };
  const router = new ManagedBackendRouter(endpoints, (endpoint) => new ConvexManagedCredentialSource(client(endpoint), signer), async () => ({ signedTransaction: `opaque-${environment}`, environment }));
  return { router, client, calls, switchTo: (value: AppleEnvironment) => { environment = value; }, failAt: (value: string) => { fail = value; } };
}

describe("immutable Store backend operation", () => {
  test.each(["SANDBOX", "PRODUCTION"] as const)("%s enroll, authorization and upload recovery stay on selected endpoint", async (environment) => {
    const h = harness(); h.switchTo(environment);
    const op = await h.router.select();
    h.switchTo(environment === "SANDBOX" ? "PRODUCTION" : "SANDBOX");
    const credential = await h.router.authorize(op, { enroll: true });
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-backend-test-"));
    try {
      const upload = new ConvexManagedUploadPort(h.client(op.context.endpoint), { journal: new FileManagedConvexUploadJournal(path.join(root, op.context.namespace)) });
      await upload.jobStatusForRecording({ credential, recordingId: "same-recording" });
      expect(h.calls.every((call) => call.endpoint === endpoints[environment])).toBe(true);
      expect(h.calls.at(-1)?.token).toBe(`token:${endpoints[environment]}`);
      expect(h.calls.find((call) => call.name === "managedAuthActions:enrollDevice")?.args.apple).toEqual({ adapter: "app-store-server-api", signedTransaction: `opaque-${environment}` });
      expect(credential.state).toBe("active");
      expect(Object.isFrozen(op.context)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("backend failure never retries enrollment or refresh on the other backend", async () => {
    const h = harness(); h.failAt(endpoints.SANDBOX);
    const op = await h.router.select();
    await expect(h.router.authorize(op, { enroll: true })).rejects.toThrow("backend unavailable");
    await expect(h.router.authorize(op, { refresh: true })).rejects.toThrow("backend unavailable");
    expect(h.calls.every((call) => call.endpoint === endpoints.SANDBOX)).toBe(true);
  });

  test("environment switches isolate cached credentials and reject supplied cross-backend credentials", async () => {
    const h = harness(); const sandbox = await h.router.select();
    const sandboxToken = await h.router.authorize(sandbox);
    h.switchTo("PRODUCTION"); const production = await h.router.select();
    await expect(h.router.authorize(production, { credential: sandboxToken })).rejects.toThrow("not bound");
    const productionToken = await h.router.authorize(production);
    expect(productionToken.authToken).not.toBe(sandboxToken.authToken);
    const count = h.calls.length;
    h.switchTo("SANDBOX");
    expect(await h.router.authorize(await h.router.select())).toBe(sandboxToken);
    expect(h.calls).toHaveLength(count);
  });

  test("identical upload/session IDs persist and resume independently across backend namespaces", async () => {
    const h = harness(); const sandbox = await h.router.select();
    h.switchTo("PRODUCTION"); const production = await h.router.select();
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-backend-journal-"));
    const part = { sessionId: "same-session", partNumber: 1, sampleOffset: 0, sampleCount: 1, byteLength: 46, sha256: "a".repeat(64), storageId: "sandbox-storage" };
    try {
      const sandboxDir = path.join(root, sandbox.context.namespace); const productionDir = path.join(root, production.context.namespace);
      await new FileManagedConvexUploadJournal(sandboxDir).record(part);
      expect(await new FileManagedConvexUploadJournal(productionDir).pending(part.sessionId)).toEqual([]);
      await new FileManagedConvexUploadJournal(productionDir).record({ ...part, storageId: "production-storage" });
      expect((await new FileManagedConvexUploadJournal(sandboxDir).pending(part.sessionId))[0]?.storageId).toBe("sandbox-storage");
      expect((await new FileManagedConvexUploadJournal(productionDir).pending(part.sessionId))[0]?.storageId).toBe("production-storage");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("missing proof, unsupported Store environment, mismatched proof and duplicate endpoints fail closed", async () => {
    const h = harness();
    await expect(h.router.select({ environment: "XCODE" as AppleEnvironment, signedTransaction: "opaque" })).rejects.toThrow("Verified Store environment");
    await expect(h.router.select({ environment: "SANDBOX", signedTransaction: "opaque" }, { adapter: "app-store-server-api", signedTransaction: "different" })).rejects.toThrow("does not belong");
    const absent = new ManagedBackendRouter(endpoints, () => { throw new Error("must not reach backend"); }, async () => null);
    await expect(absent.select()).rejects.toThrow("Verified Store environment");
    expect(() => new ManagedBackendRouter({ SANDBOX: endpoints.SANDBOX, PRODUCTION: `${endpoints.SANDBOX}/` }, () => { throw new Error(); }, async () => null)).toThrow("distinct");
  });

  test("development single endpoint preserves explicit credential and legacy journal namespace", async () => {
    const router = new ManagedBackendRouter({ development: endpoints.SANDBOX }, () => ({}) as ConvexManagedCredentialSource, async () => { throw new Error("development must not require Store proof"); });
    const op = await router.select(); const credential = { authToken: "development-token" };
    expect(op.context.namespace).toBe("");
    expect(await router.authorize(op, { credential })).toBe(credential);
  });
});
