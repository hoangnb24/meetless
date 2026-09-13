import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readUploadForRepair, admitSealedUpload } from "../convex/managedTranscription";
import { repairUpload } from "../convex/managedTranscriptionActions";
import { startManagedConvexHarness, twoPartManifest, type ManagedConvexManifestFixture } from "./managed-convex-production-harness";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Runtime = Awaited<ReturnType<typeof startManagedConvexHarness>>;

/** Local HTTP proof invokes the actual production functions with synthetic bytes. */
describe("managed upload transport repair through production handlers", () => {
  let runtime: Runtime;
  beforeAll(async () => { runtime = await startManagedConvexHarness(); }, 120_000);
  afterAll(async () => { await runtime?.stop(); }, 30_000);
  const fixture = () => twoPartManifest(`transport-repair-${crypto.randomUUID()}`);
  const invoke = (kind: "query" | "mutation" | "action", name: string, args: Record<string, unknown>) => runtime.invoke<any>(kind, name, args, runtime.device.token);
  const repair = (sessionId: string) => invoke("action", "managedTranscriptionActions:repairUpload", { sessionId });
  const read = (sessionId: string) => runtime.invoke<any>("query", "managedTranscription:readUploadForRepair", { sessionId, tokenIdentifier: runtime.device.tokenIdentifier });
  const commit = (args: Record<string, unknown>) => runtime.invoke<any>("mutation", "managedTranscription:repairCorruptUpload", args);

  async function register(sessionId: string, source: ManagedConvexManifestFixture, index: number, corrupt = false) {
    const bytes = Uint8Array.from(source.bytes[index]!);
    if (corrupt) bytes[44] = bytes[44]! ^ 0xff;
    const url = await invoke("mutation", "managedTranscription:generateUploadUrl", { sessionId });
    const response = await fetch(url, { method: "POST", body: bytes as BodyInit });
    expect(response.ok).toBe(true);
    const { storageId } = await response.json() as { storageId: string };
    await invoke("mutation", "managedTranscription:registerPart", { sessionId, ...source.manifest.parts[index]!, storageId });
    return bytes;
  }

  async function corrupted(source: ManagedConvexManifestFixture, all = true) {
    const session = await invoke("mutation", "managedTranscription:beginUpload", { manifest: source.manifest });
    const bad = await register(session.sessionId, source, 0, true);
    if (all) await register(session.sessionId, source, 1);
    return { session, bad };
  }

  function verifiedArgs(data: any, bad: Uint8Array) {
    const first = data.parts.find((part: any) => part.partNumber === 1);
    return {
      sessionId: data.upload._id, tokenIdentifier: runtime.device.tokenIdentifier,
      cancelGeneration: data.upload.cancelGeneration ?? 0,
      parts: data.parts.map((part: any) => ({ partId: part._id, partNumber: part.partNumber, sampleOffset: part.sampleOffset,
        sampleCount: part.sampleCount, byteLength: part.byteLength, sha256: part.sha256, storageId: part.storageId })),
      mismatch: { partNumber: first.partNumber, storageId: first.storageId, expectedSha256: first.sha256,
        observedSha256: digest(bad), observedByteLength: bad.byteLength },
    };
  }

  test("repairs verified corruption once, preserves evidence/expiry, fences old calls, and settles once", async () => {
    const source = fixture();
    const quotaBefore = await runtime.quota();
    const { session } = await corrupted(source);
    const before = await read(session.sessionId);
    await expect(invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: session.sessionId })).rejects.toThrow("digest does not match");
    const repaired = await Promise.all([repair(session.sessionId), repair(session.sessionId)]);
    expect(repaired[0].sessionId).not.toBe(session.sessionId);
    expect(repaired[1].sessionId).toBe(repaired[0].sessionId);
    const successorId = repaired[0].sessionId;
    expect(repaired[0]).toMatchObject({ state: "uploading", expiresAt: session.expiresAt, receivedPartNumbers: [], jobId: null });
    expect(await runtime.quota()).toEqual(quotaBefore);
    await runtime.invoke("action", "managedTranscriptionActions:cleanupUpload", { uploadId: session.sessionId });
    const old = await runtime.invoke<any>("query", "managedTranscription:readUploadForCleanup", { uploadId: session.sessionId });
    expect(old.parts).toEqual([]);
    expect(old.upload).toMatchObject({ state: "cleaned", transportSuccessorId: successorId,
      transportRepairEvidence: { partNumber: 1, expectedSha256: source.manifest.parts[0]!.sha256 } });
    expect(old.upload.transportRepairEvidence.observedSha256).not.toBe(old.upload.transportRepairEvidence.expectedSha256);
    expect((await repair(session.sessionId)).sessionId).toBe(successorId);
    expect((await invoke("mutation", "managedTranscription:beginUpload", { manifest: source.manifest })).sessionId).toBe(successorId);
    await expect(invoke("mutation", "managedTranscription:registerPart", {
      sessionId: session.sessionId, ...source.manifest.parts[0]!, storageId: before.parts[0].storageId,
    })).rejects.toThrow("immutable part manifest is closed");
    await expect(runtime.invoke("mutation", "managedTranscription:admitSealedUpload", {
      sessionId: session.sessionId, tokenIdentifier: runtime.device.tokenIdentifier, cancelGeneration: 0,
      contentSha256: source.manifest.contentSha256, sampleCount: source.manifest.sampleCount,
      byteLength: source.manifest.byteLength, durationMs: source.manifest.durationMs, partsManifestSha256: source.manifest.partsManifestSha256,
    })).rejects.toThrow("stale after upload cancellation");
    await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: session.sessionId });
    expect((await invoke("query", "managedTranscription:status", { sessionId: successorId })).state).toBe("uploading");
    // A healthy partial successor can resume; verifying it creates no third generation.
    await register(successorId, source, 0);
    expect((await repair(successorId)).sessionId).toBe(successorId);
    await register(successorId, source, 1);
    const jobs = await Promise.all([1, 2].map(() => invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: successorId })));
    expect(jobs[0]._id).toBe(jobs[1]._id);
    expect(jobs[0]).toMatchObject({ admissionNumber: 1, providerInvocationCount: 0 });
    expect((await runtime.quota()).reservedSeconds).toBe(quotaBefore.reservedSeconds + 1);
    // Local provider stub only; no external provider request occurs in this harness.
    await invoke("action", "managedTranscriptionActions:runProvider", { jobId: jobs[0]._id });
    await invoke("action", "managedTranscriptionActions:runProvider", { jobId: jobs[0]._id });
    await invoke("mutation", "managedTranscription:settleJob", { jobId: jobs[0]._id });
    await invoke("mutation", "managedTranscription:settleJob", { jobId: jobs[0]._id });
    expect(await runtime.quota()).toMatchObject({ usedSeconds: quotaBefore.usedSeconds + 1, reservedSeconds: quotaBefore.reservedSeconds });
  }, 120_000);

  test("binds duplicate repair to the direct successor and rejects corrupt successor repair", async () => {
    const source = fixture();
    const { session } = await corrupted(source);
    const successor = await repair(session.sessionId);
    await register(successor.sessionId, source, 0, true);
    await expect(repair(successor.sessionId)).rejects.toThrow("another repair generation");
    expect((await repair(session.sessionId)).sessionId).toBe(successor.sessionId);
    expect((await invoke("mutation", "managedTranscription:beginUpload", { manifest: source.manifest })).sessionId).toBe(successor.sessionId);
  }, 120_000);

  test("leaves healthy bytes unchanged and rejects changed immutable manifests", async () => {
    const source = fixture();
    const original = await runtime.uploadAndRegister(source);
    const before = await runtime.quota();
    expect((await repair(original.sessionId)).sessionId).toBe(original.sessionId);
    expect(await runtime.quota()).toEqual(before);
    await expect(invoke("mutation", "managedTranscription:beginUpload", {
      manifest: { ...source.manifest, manifestSha256: "f".repeat(64) },
    })).rejects.toThrow("immutable");
  }, 120_000);

  test("rejects a verification snapshot when registration or cancellation wins the race", async () => {
    const source = fixture();
    const { session, bad } = await corrupted(source, false);
    const checked = verifiedArgs(await read(session.sessionId), bad);
    await register(session.sessionId, source, 1);
    await expect(commit(checked)).rejects.toThrow("changed during integrity verification");
    const latest = verifiedArgs(await read(session.sessionId), bad);
    await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: session.sessionId });
    await expect(commit(latest)).rejects.toThrow("unadmitted uploading attempt");
  }, 120_000);

  test("rechecks entitlement after byte verification before creating a successor", async () => {
    const source = fixture();
    const { session, bad } = await corrupted(source);
    const checked = verifiedArgs(await read(session.sessionId), bad);
    await runtime.invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId: runtime.device.accountId, naturalExpiryAt: Date.now() - 1 });
    try { await expect(commit(checked)).rejects.toThrow("naturally expired"); }
    finally { await runtime.invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId: runtime.device.accountId, naturalExpiryAt: null }); }
    expect((await read(session.sessionId)).successor).toBeNull();
  }, 120_000);
});

/** Adversarial boundary fixtures call actual handlers; these are not production acceptance. */
describe("transport repair guards", () => {
  function context(overrides: { upload?: Record<string, unknown>; job?: unknown; principal?: Record<string, unknown> } = {}) {
    const principal = { accountId: "account", deviceId: "device", keyId: "key", keyVersion: "v1", lineageVerified: true,
      revokedAt: null, entitlement: "active", ...overrides.principal };
    const upload = { _id: "upload", accountId: "account", deviceId: "device", state: "uploading", jobId: null,
      expiresAt: Date.now() + 100_000, recordingId: "recording", audioId: "audio", ...overrides.upload };
    const tables: Record<string, unknown> = { managedPrincipals: principal, managedDevices: principal, managedJobs: overrides.job ?? null };
    const write = vi.fn(async () => { throw new Error("unexpected write"); });
    return { db: { get: async () => upload, query: (table: string) => ({ withIndex: () => ({ unique: async () => tables[table] ?? null, collect: async () => [] }) }),
      insert: write, patch: write }, scheduler: { runAfter: write }, write };
  }

  test.each(["reserved", "running", "provider_completed", "succeeded", "failed", "expired", "cancelled", "stopped"])("never resets an existing %s timeline job", async (status) => {
    const ctx = context({ job: { status } });
    await expect(readUploadForRepair._handler(ctx as never, { sessionId: "upload", tokenIdentifier: "token" } as never)).rejects.toThrow("admitted or uncertain");
    expect(ctx.write).not.toHaveBeenCalled();
  });

  test.each([
    [{ upload: { expiresAt: 0 } }, "unexpired"],
    [{ upload: { accountId: "other" } }, "not owned"],
    [{ upload: { deviceId: "other" } }, "enrolled device"],
    [{ principal: { revokedAt: 1 } }, "not verified"],
  ] as const)("fails closed at ownership and expiry boundaries (%j)", async (overrides, message) => {
    const ctx = context(overrides);
    await expect(readUploadForRepair._handler(ctx as never, { sessionId: "upload", tokenIdentifier: "token" } as never)).rejects.toThrow(message);
    expect(ctx.write).not.toHaveBeenCalled();
  });

  test.each([false, true])("preserves repaired transport expiry during existing-job Retry (successor=%s)", async (successor) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const manifest = twoPartManifest("repair-ttl").manifest;
    const expiry = now + 5_000;
    const principal = { _id: "principal", tokenIdentifier: "token", accountId: "account", deviceId: "device", keyId: "key", keyVersion: "v1",
      lineageVerified: true, revokedAt: null, entitlement: "active" };
    const upload: any = { _id: "upload", ...manifest, accountId: "account", deviceId: "device", uploadKey: "key",
      state: "sealed", jobId: "job", expiresAt: expiry, cancelGeneration: 0,
      ...(successor ? { transportPredecessorId: "predecessor" } : {}) };
    const job: any = { _id: "job", accountId: "account", deviceId: "device", uploadId: "upload", status: "failed",
      admissionNumber: 1, leaseExpiresAt: now + 100_000, expiresAt: now + 100_000,
      fingerprint: `${manifest.manifestSha256}:${manifest.contentSha256}:${manifest.byteLength}:${manifest.sampleCount}:${manifest.partsManifestSha256}`,
      timelineKey: `account\u0000${manifest.recordingId}\u0000${manifest.audioId}` };
    const tables: Record<string, any[]> = {
      managedPrincipals: [principal], managedDevices: [principal], managedUploads: [upload], managedJobs: [job],
      managedAccounts: [{ _id: "account-row", accountId: "account", currentPeriodStartAt: now - 1, currentPeriodEndAt: now + 100_000 }],
      managedPeriods: [{ _id: "period", accountId: "account", startAt: now - 1, endAt: now + 100_000, limitSeconds: 100, usedSeconds: 0, reservedSeconds: 0 }],
      managedUploadParts: manifest.parts.map((part) => ({ _id: `part-${part.partNumber}`, ...part, uploadId: "upload", storageId: `storage-${part.partNumber}` })),
      managedJobParts: [],
    };
    const scheduled = vi.fn(async () => undefined);
    const ctx = { db: {
      get: async (id: string) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
      patch: async (id: string, patch: any) => Object.assign(Object.values(tables).flat().find((row) => row._id === id)!, patch),
      insert: async (table: string, row: any) => { const id = `${table}-${tables[table]!.length}`; tables[table]!.push({ _id: id, ...row }); return id; },
      query: (table: string) => {
        let selected = [...(tables[table] ?? [])];
        const selection: any = {
          withIndex: (_name: string, select: (q: any) => unknown) => {
            const q = { eq: (field: string, value: unknown) => { selected = selected.filter((row) => row[field] === value); return q; },
              lte: (field: string, value: number) => { selected = selected.filter((row) => row[field] <= value); return q; } };
            select(q); return selection;
          },
          filter: (select: (q: any) => (row: any) => boolean) => { selected = selected.filter(select({ field: (name: string) => name, eq: (field: string, value: unknown) => (row: any) => row[field] === value })); return selection; },
          unique: async () => selected[0] ?? null, collect: async () => selected, take: async (limit: number) => selected.slice(0, limit),
        };
        return selection;
      },
    }, scheduler: { runAfter: scheduled } };
    const args = { sessionId: "upload", tokenIdentifier: "token", cancelGeneration: 0,
      contentSha256: manifest.contentSha256, sampleCount: manifest.sampleCount, byteLength: manifest.byteLength,
      durationMs: manifest.durationMs, partsManifestSha256: manifest.partsManifestSha256 };
    try {
      const result = await admitSealedUpload._handler(ctx as never, args as never);
      expect(result).toMatchObject({ _id: "job", admissionNumber: 2, status: "reserved" });
      expect(upload.expiresAt).toBe(successor ? expiry : now + 24 * 60 * 60 * 1_000);
      expect(scheduled).toHaveBeenLastCalledWith(upload.expiresAt - now, expect.anything(), { uploadId: "upload" });
      if (successor) {
        clock.mockReturnValue(expiry);
        await expect(admitSealedUpload._handler(ctx as never, args as never)).rejects.toThrow("24-hour TTL");
        expect(upload.expiresAt).toBe(expiry);
      }
    } finally { clock.mockRestore(); }
  });

  test.each(["missing", "network", "permission"])("does not repair when stored bytes are %s", async (failure) => {
    const mutate = vi.fn();
    const descriptor = { partNumber: 1, sampleOffset: 0, sampleCount: 1, byteLength: 46, sha256: "a".repeat(64), storageId: "storage" };
    const ctx = { auth: { getUserIdentity: async () => ({ tokenIdentifier: "token" }) },
      runQuery: async () => ({ upload: { parts: [descriptor] }, parts: [descriptor], successor: null }),
      runMutation: mutate, storage: { get: async () => { if (failure === "missing") return null; throw new Error(failure); } } };
    await expect(repairUpload._handler(ctx as never, { sessionId: "upload" } as never)).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });
});
