import { afterEach, describe, expect, test, vi } from "vitest";
import { beginUpload, repairCorruptUpload } from "../convex/managedTranscription";
import { twoPartManifest } from "./managed-convex-production-harness";

// Only authentication is stubbed; the actual mutation and transport lineage run below.
vi.mock("../convex/managedAuth", () => ({ requirePrincipal: async (ctx: any) => ({ principal: ctx.principal, account: ctx.account }) }));
afterEach(() => vi.restoreAllMocks());
const TTL = 86_400_000;
function fixture() {
  const now = 10 * TTL;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const manifest = twoPartManifest("quota-ttl").manifest;
  const principal = { accountId: "account", deviceId: "device", tokenIdentifier: "token", keyId: "key", keyVersion: "v1", lineageVerified: true, entitlement: "active", revokedAt: null };
  const account = { _id: "account", accountId: "account", currentPeriodStartAt: now - 1, currentPeriodEndAt: now + TTL, nextPeriodLimitSeconds: 20 };
  const upload: any = { _id: "upload", ...manifest, accountId: "account", deviceId: "device",
    uploadKey: `account\u0000${manifest.recordingId}\u0000${manifest.audioId}\u0000${manifest.manifestSha256}\u0000${manifest.contentSha256}\u0000${manifest.sampleCount}`,
    state: "cleaned", jobId: null, createdAt: now - TTL, expiresAt: now, quotaDeferredAt: now - 1000, cancelGeneration: 0 };
  const tables: Record<string, any[]> = { managedUploads: [upload], managedJobs: [], managedUploadParts: [], managedJobParts: [],
    managedPrincipals: [principal], managedDevices: [principal], managedAccounts: [account],
    managedPeriods: [{ _id: "period", accountId: "account", startAt: now - 1, endAt: now + TTL, limitSeconds: 20, usedSeconds: 0, reservedSeconds: 0 }] };
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
  Object.assign(ctx, { principal, account });
  return { now, manifest, upload, tables, scheduled, account, ctx, begin: () => beginUpload._handler(ctx as never, { manifest } as never) };
}
describe("quota deferred cleanup boundary fixtures (not production acceptance)", () => {
  test("creates one idempotent successor after complete cleanup with a fresh TTL and unchanged old expiry", async () => {
    const f = fixture();
    const first: any = await f.begin();
    const second: any = await f.begin();
    expect(second.sessionId).toBe(first.sessionId);
    expect(f.tables.managedUploads).toHaveLength(2);
    expect(f.upload.expiresAt).toBe(f.now);
    expect(f.tables.managedUploads[1]).toMatchObject({ quotaPredecessorId: "upload", createdAt: f.now, expiresAt: f.now + TTL, jobId: null });
    expect(f.tables.managedJobs).toHaveLength(0);
    expect(f.tables.managedPeriods[0].reservedSeconds).toBe(0);
    expect(f.scheduled).toHaveBeenCalledTimes(1);
  });
  test.each(["reserved", "running", "provider_completed", "succeeded", "failed", "expired", "cancelled", "stopped"])("refuses a fresh transport when any %s job exists", async (status) => {
    const f = fixture();
    f.tables.managedJobs.push({ _id: "job", accountId: "account", timelineKey: `account\u0000${f.manifest.recordingId}\u0000${f.manifest.audioId}`, status,
      fingerprint: `${f.manifest.manifestSha256}:${f.manifest.contentSha256}:${f.manifest.byteLength}:${f.manifest.sampleCount}:${f.manifest.partsManifestSha256}`,
      leaseExpiresAt: f.now + TTL, expiresAt: f.now + TTL });
    await expect(f.begin()).rejects.toThrow("24-hour TTL");
    expect(f.tables.managedUploads).toHaveLength(1);
  });
  test.each(["not-quota", "not-cleaned", "remaining-part", "job-pointer"])("refuses incomplete or ineligible cleanup (%s)", async (boundary) => {
    const f = fixture();
    if (boundary === "not-quota") delete f.upload.quotaDeferredAt;
    if (boundary === "not-cleaned") f.upload.state = "expired";
    if (boundary === "remaining-part") f.tables.managedUploadParts.push({ uploadId: "upload" });
    if (boundary === "job-pointer") f.upload.jobId = "missing-job";
    await expect(f.begin()).rejects.toThrow("24-hour TTL");
    expect(f.tables.managedUploads).toHaveLength(1);
  });
  test("quota renewal permits one corruption repair and duplicate repair keeps its identity and expiry", async () => {
    const f = fixture();
    await f.begin();
    const next = f.tables.managedUploads[1]!;
    const part = { _id: "part", ...f.manifest.parts[0], uploadId: next._id, storageId: "storage" };
    f.tables.managedUploadParts.push(part);
    const args = { sessionId: next._id, tokenIdentifier: "token", cancelGeneration: 0,
      parts: [{ ...part, partId: part._id }], mismatch: { partNumber: part.partNumber, storageId: part.storageId,
        expectedSha256: part.sha256, observedSha256: "0".repeat(64), observedByteLength: part.byteLength } };
    const result: any = await repairCorruptUpload._handler(f.ctx as never, args as never);
    expect(result.expiresAt).toBe(next.expiresAt);
    expect(f.tables.managedUploads).toHaveLength(3);
    expect((await repairCorruptUpload._handler(f.ctx as never, args as never) as any).sessionId).toBe(result.sessionId);
    expect(f.tables.managedUploads).toHaveLength(3);
  });
  test("a corruption repair before quota renewal prevents a second corruption repair", async () => {
    const f = fixture();
    const repaired = { ...f.upload, _id: "previous-repair", transportPredecessorId: f.upload._id };
    delete repaired.quotaSuccessorId;
    f.upload.transportSuccessorId = repaired._id;
    f.tables.managedUploads.push(repaired);
    await f.begin();
    const next = f.tables.managedUploads[2]!;
    await expect(repairCorruptUpload._handler(f.ctx as never, { sessionId: next._id, tokenIdentifier: "token", cancelGeneration: 0, parts: [], mismatch: {} } as never)).rejects.toThrow("another repair generation");
    expect(f.tables.managedUploads).toHaveLength(3);
  });
  test.each(["double-edge", "wrong-predecessor", "wrong-expiry", "wrong-device", "disconnected"])("rejects malformed transport lineage (%s)", async (boundary) => {
    const f = fixture();
    await f.begin();
    const next = f.tables.managedUploads[1]!;
    if (boundary === "double-edge") f.upload.transportSuccessorId = next._id;
    if (boundary === "wrong-predecessor") next.quotaPredecessorId = "missing";
    if (boundary === "wrong-expiry") next.expiresAt += 1;
    if (boundary === "wrong-device") next.deviceId = "other";
    if (boundary === "disconnected") f.tables.managedUploads.push({ ...next, _id: "disconnected" });
    await expect(f.begin()).rejects.toThrow("transport history");
  });
  test.each(["future-start", "expired-end"])("refuses an unverified current period before claiming availability (%s)", async (boundary) => {
    const f = fixture();
    if (boundary === "future-start") {
      f.account.currentPeriodStartAt = f.now + 1;
      f.tables.managedPeriods[0].startAt = f.now + 1;
    } else f.tables.managedPeriods[0].endAt = f.now;
    await expect(f.begin()).rejects.toThrow("authoritative refresh");
    expect(f.tables.managedUploads).toHaveLength(1);
  });
  test("refuses stale multi-period availability", async () => {
    const f = fixture();
    f.account.currentPeriodStartAt = f.now - 4 * TTL;
    f.account.currentPeriodEndAt = f.now - 3 * TTL;
    f.tables.managedPeriods[0].startAt = f.account.currentPeriodStartAt;
    f.tables.managedPeriods[0].endAt = f.account.currentPeriodEndAt;
    await expect(f.begin()).rejects.toThrow("authoritative refresh");
    expect(f.tables.managedPeriods).toHaveLength(1);
    expect(f.tables.managedUploads).toHaveLength(1);
  });
});
