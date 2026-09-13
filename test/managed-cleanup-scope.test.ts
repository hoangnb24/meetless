import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupUpload } from "../convex/managedTranscriptionActions";
import { markUploadCleaned, readUploadForCleanup, reconcileManagedState } from "../convex/managedTranscription";

// Local boundary proof: real action/query/mutation handlers, in-memory DB/storage.
// This does not establish deployed Convex or hosted cleanup acceptance.
function fixture() {
  const now = 2_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const rows = new Map<string, any>();
  for (const accountId of ["owner", "foreign"]) {
    const uploadId = `${accountId}-upload`, jobId = `${accountId}-job`;
    for (const row of [
      { _id: uploadId, table: "managedUploads", accountId, state: "sealed", expiresAt: now - 1, jobId },
      { _id: jobId, table: "managedJobs", accountId, uploadId, status: "succeeded", expiresAt: now - 1,
        leaseExpiresAt: now - 1, cleanupState: "pending", providerResult: { text: accountId } },
      { _id: `${accountId}-part`, table: "managedUploadParts", uploadId, storageId: `${accountId}-blob` },
      { _id: `${accountId}-checkpoint`, table: "managedJobParts", jobId, status: "completed", leaseExpiresAt: now - 1 },
    ]) rows.set(row._id, row);
  }
  const scheduler = { runAfter: vi.fn(async () => "scheduled") };
  const db = {
    get: vi.fn(async (id: string) => rows.has(id) ? structuredClone(rows.get(id)) : null),
    patch: vi.fn(async (id: string, update: object) => Object.assign(rows.get(id), update)),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    query(table: string) {
      let selected = [...rows.values()].filter((row) => row.table === table);
      const chain = {
        withIndex(_name: string, build: (q: any) => unknown) {
          const q = {
            eq(field: string, value: unknown) { selected = selected.filter((row) => row[field] === value); return q; },
            lte(field: string, value: number) { selected = selected.filter((row) => row[field] <= value); return q; },
          };
          build(q); return chain;
        },
        filter(build: (q: any) => (row: any) => boolean) {
          selected = selected.filter(build({ field: (field: string) => field,
            eq: (field: string, value: unknown) => (row: any) => row[field] === value })); return chain;
        },
        take: async (limit: number) => structuredClone(selected.slice(0, limit)),
        collect: async () => structuredClone(selected),
      };
      return chain;
    },
  };
  const storage = { delete: vi.fn(async (_id: string) => {}) };
  const handlers: Record<string, any> = { readUploadForCleanup, reconcileManagedState, markUploadCleaned };
  const context = { db, scheduler, storage };
  const dispatch = async (reference: any, args: any) => {
    const name = getFunctionName(reference).split(":")[1]!;
    if (!handlers[name]) throw new Error(`Unexpected cleanup call ${name}`);
    return handlers[name]._handler(context, args);
  };
  const runQuery = vi.fn(dispatch), runMutation = vi.fn(dispatch);
  return { rows, db, scheduler, storage, runQuery, runMutation,
    run: () => cleanupUpload._handler({ runQuery, runMutation, storage } as never, { uploadId: "owner-upload" } as never) };
}

afterEach(() => vi.restoreAllMocks());

describe("account-owned scheduled upload cleanup", () => {
  test("missing scheduled upload returns false before any reconciliation or mutation", async () => {
    const f = fixture();
    f.rows.delete("owner-upload");
    const before = structuredClone([...f.rows]);
    expect(await f.run()).toBe(false);
    expect(f.runQuery).toHaveBeenCalledTimes(1);
    expect(f.runMutation.mock.calls.length, "missing-upload callback must perform zero reconciliation mutations").toBe(0);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.scheduler.runAfter).not.toHaveBeenCalled();
    expect([...f.rows]).toEqual(before);
  });

  test("expired owner cleanup removes its blobs/checkpoints without changing or scheduling foreign state", async () => {
    const f = fixture();
    const foreign = structuredClone([...f.rows].filter(([id]) => id.startsWith("foreign")));
    expect(await f.run()).toBe(true);
    expect([...f.rows].filter(([id]) => id.startsWith("foreign")), "cleanup must preserve foreign-account state").toEqual(foreign);
    expect(f.runQuery).toHaveBeenCalledTimes(2);
    expect(f.rows.get("owner-upload").state).toBe("cleaned");
    expect(f.rows.get("owner-job")).toMatchObject({ cleanupState: "cleaned", providerResult: null });
    expect(f.rows.has("owner-part")).toBe(false);
    expect(f.rows.has("owner-checkpoint")).toBe(false);
    expect(f.storage.delete.mock.calls).toEqual([["owner-blob"]]);
    expect([...f.rows].filter(([id]) => id.startsWith("foreign")), "cleanup must preserve foreign-account state").toEqual(foreign);
    expect(f.runMutation.mock.calls[0]![1]).toEqual({ accountId: "owner", limit: 100 });
    expect(f.scheduler.runAfter.mock.calls.length).toBeGreaterThan(0);
    for (const call of f.scheduler.runAfter.mock.calls as unknown as any[][]) expect(call[2]).toEqual({ uploadId: "owner-upload" });
    expect(await f.run()).toBe(true);
    expect(f.storage.delete).toHaveBeenCalledTimes(1);
  });

  test.each(["uploading", "sealed"])("unexpired %s upload retains temporary data", async (state) => {
    const f = fixture();
    Object.assign(f.rows.get("owner-upload"), { state, expiresAt: Date.now() + 1, jobId: null });
    f.rows.delete("owner-job");
    expect(await f.run()).toBe(false);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows.has("owner-part")).toBe(true);
    expect(f.runMutation).toHaveBeenCalledTimes(1);
  });

  test.each(["cancelled", "cleaned"])("unexpired %s upload still permits cleanup", async (state) => {
    const f = fixture();
    Object.assign(f.rows.get("owner-upload"), { state, expiresAt: Date.now() + 1, jobId: null });
    f.rows.delete("owner-job");
    expect(await f.run()).toBe(true);
    expect(f.storage.delete.mock.calls).toEqual([["owner-blob"]]);
    expect(f.rows.get("owner-upload").state).toBe("cleaned");
  });

  test("refreshes state after reconciliation and tolerates an upload removed between calls", async () => {
    const f = fixture();
    f.runMutation.mockImplementationOnce(async () => { f.rows.delete("owner-upload"); return {}; });
    expect(await f.run()).toBe(false);
    expect(f.runQuery).toHaveBeenCalledTimes(2);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.runMutation).toHaveBeenCalledTimes(1);
  });
});
