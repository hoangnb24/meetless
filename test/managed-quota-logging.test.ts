import { afterEach, describe, expect, test, vi } from "vitest";
import { beginUpload, admitSealedUpload } from "../convex/managedTranscription";
import { twoPartManifest } from "./managed-convex-production-harness";

// The authentication boundary is independent of quota diagnostics. The actual
// mutation handlers and their period/admission logic run against this local DB.
vi.mock("../convex/managedAuth", () => ({ requirePrincipal: async (ctx: any) => ctx.authenticated }));
afterEach(() => vi.restoreAllMocks());

function setup(retry: boolean) {
  const now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const manifest = twoPartManifest("private-recording").manifest;
  const principal = { accountId: "private-account", deviceId: "private-device", tokenIdentifier: "private-token",
    keyId: "private-key", keyVersion: "v1", lineageVerified: true, revokedAt: null, entitlement: "active" };
  const account = { _id: "account", accountId: principal.accountId, currentPeriodStartAt: now - 1000, currentPeriodEndAt: now + 1000 };
  const period = { _id: "period", accountId: principal.accountId, startAt: account.currentPeriodStartAt, endAt: account.currentPeriodEndAt,
    limitSeconds: 100, usedSeconds: 0, reservedSeconds: 0 };
  const upload = { _id: "upload", ...manifest, accountId: principal.accountId, deviceId: principal.deviceId,
    uploadKey: `${principal.accountId}\u0000${manifest.recordingId}\u0000${manifest.audioId}\u0000${manifest.manifestSha256}\u0000${manifest.contentSha256}\u0000${manifest.sampleCount}`,
    state: "uploading", jobId: retry ? "job" : null, expiresAt: now + 100_000, cancelGeneration: 0 };
  const job = { _id: "job", accountId: principal.accountId, deviceId: principal.deviceId, uploadId: "upload", status: "failed",
    admissionNumber: 1, leaseExpiresAt: now + 100_000, expiresAt: now + 100_000,
    fingerprint: `${manifest.manifestSha256}:${manifest.contentSha256}:${manifest.byteLength}:${manifest.sampleCount}:${manifest.partsManifestSha256}`,
    timelineKey: `${principal.accountId}\u0000${manifest.recordingId}\u0000${manifest.audioId}` };
  const tables: Record<string, any[]> = {
    managedPrincipals: [principal], managedDevices: [principal], managedAccounts: [account], managedPeriods: [period],
    managedUploads: [upload], managedJobs: retry ? [job] : [], managedJobParts: [],
    managedUploadParts: manifest.parts.map((part) => ({ ...part, uploadId: "upload", storageId: `private-storage-${part.partNumber}` })),
  };
  const ctx = { authenticated: { principal, account }, db: {
    get: async (id: string) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
    patch: vi.fn(async (id: string, patch: any) => Object.assign(Object.values(tables).flat().find((row) => row._id === id)!, patch)),
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
  }, scheduler: { runAfter: vi.fn(async () => undefined) } };
  const invoke = (stage: string) => stage === "begin_upload"
    ? beginUpload._handler(ctx as never, { manifest } as never)
    : admitSealedUpload._handler(ctx as never, { sessionId: "upload", tokenIdentifier: principal.tokenIdentifier,
      cancelGeneration: 0, contentSha256: manifest.contentSha256, sampleCount: manifest.sampleCount,
      byteLength: manifest.byteLength, durationMs: manifest.durationMs, partsManifestSha256: manifest.partsManifestSha256 } as never);
  return { now, log, account, period, tables, invoke, ctx };
}

describe.each(["begin_upload", "new_admission", "retry_admission"])("quota diagnostic %s", (stage) => {
  test.each([
    ["stale_account_period", "requires authoritative refresh"],
    ["missing_period", "period is missing"],
    ["invalid_ledger", "ledger is invalid"],
    ["invalid_or_expired_period", "requires authoritative refresh"],
    ["insufficient", null],
    ["allowed", null],
  ])("records %s and preserves handler result", async (outcome, errorMessage) => {
    const state = setup(stage === "retry_admission");
    if (outcome === "stale_account_period") state.account.currentPeriodEndAt = state.now - 600;
    if (outcome === "missing_period") state.tables.managedPeriods = [];
    if (outcome === "invalid_ledger") state.period.usedSeconds = -1;
    if (outcome === "invalid_or_expired_period") state.period.endAt = state.now;
    if (outcome === "insufficient") state.period.limitSeconds = 0;
    if (errorMessage) await expect(state.invoke(stage)).rejects.toThrow(errorMessage);
    else {
      const result = await state.invoke(stage);
      if (outcome === "insufficient") expect(result.kind).toBe("managed_quota_insufficient");
      else expect(stage === "begin_upload" ? result.sessionId : result.status).toBe(stage === "begin_upload" ? "upload" : "reserved");
    }
    expect(state.log).toHaveBeenCalledWith("managed_quota_check", expect.objectContaining({ stage, outcome }));
    const serialized = JSON.stringify(state.log.mock.calls);
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("Error");
    if (outcome !== "allowed") expect(state.period.reservedSeconds).toBe(0);
  });
});

test("unknown database failures are rethrown unchanged and arbitrary text is excluded", async () => {
  const state = setup(false);
  const originalQuery = state.ctx.db.query;
  const failure = new Error("private-receipt private-token private-transcript");
  state.ctx.db.query = (table) => { if (table === "managedPeriods") throw failure; return originalQuery(table); };
  await expect(state.invoke("begin_upload")).rejects.toBe(failure);
  expect(state.log).toHaveBeenLastCalledWith("managed_quota_check", expect.objectContaining({ outcome: "period_resolution_failed" }));
  expect(JSON.stringify(state.log.mock.calls)).not.toContain("private-");
});

test.each([NaN, Infinity, "private-ledger-data"])("sanitizes malformed ledger values (%s)", async (value) => {
  const state = setup(false);
  state.period.usedSeconds = value as number;
  await expect(state.invoke("begin_upload")).rejects.toThrow("ledger is invalid");
  expect(state.log).toHaveBeenLastCalledWith("managed_quota_check", expect.objectContaining({ outcome: "invalid_ledger", usedSeconds: null }));
  expect(JSON.stringify(state.log.mock.calls)).not.toContain("private-");
});
