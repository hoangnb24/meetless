import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { validateManagedQuotaFailure } from "../packages/meeting-domain/src/managed-quota";
import { startManagedConvexHarness, twoPartManifest } from "./managed-convex-production-harness";

type Harness = Awaited<ReturnType<typeof startManagedConvexHarness>>;
let runtime: Harness;
describe("managed quota preflight through local Convex production handlers", () => {
  beforeAll(async () => { runtime = await startManagedConvexHarness(); }, 120_000);
  afterAll(async () => { await runtime?.stop(); }, 30_000);
  test("checks exact allowance without reserving, denies insufficiency, and atomically rechecks stale concurrent preflights", async () => {
    const begin = (manifest: ReturnType<typeof twoPartManifest>["manifest"]) => runtime.invoke<any>("mutation", "managedTranscription:beginUpload", { manifest }, runtime.device.token);
    const exact = await begin(twoPartManifest(`quota-exact-${Date.now()}`, [160_000, 160_000]).manifest);
    expect(exact.sessionId).toEqual(expect.any(String));
    expect(await runtime.quota()).toMatchObject({ limitSeconds: 20, usedSeconds: 0, reservedSeconds: 0 });
    const denied = await begin(twoPartManifest(`quota-denied-${Date.now()}`, [168_000, 168_000]).manifest);
    expect(validateManagedQuotaFailure(denied)).toMatchObject({ requiredSeconds: 21, remainingSeconds: 20 });
    expect(denied.sessionId).toBeUndefined();
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 0 });
    const fixtures = [0, 1].map((i) => twoPartManifest(`quota-race-${Date.now()}-${i}`, [96_000, 96_000]));
    const uploads = await Promise.all(fixtures.map((fixture) => runtime.uploadAndRegister(fixture)));
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 0 });
    const outcomes = await Promise.all(uploads.map((upload) => runtime.invoke<any>("action", "managedTranscriptionActions:sealUpload", upload, runtime.device.token)));
    const winner = outcomes.findIndex((outcome) => outcome.status === "reserved");
    expect(winner).toBeGreaterThanOrEqual(0);
    const loser = 1 - winner;
    expect(validateManagedQuotaFailure(outcomes[loser])).toMatchObject({ requiredSeconds: 12, remainingSeconds: 8 });
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 12 });
    const deferred = await runtime.invoke<any>("query", "managedTranscription:readUploadForCleanup", { uploadId: uploads[loser]!.sessionId });
    expect(deferred.upload.quotaDeferredAt).toEqual(expect.any(Number));
    expect(deferred.upload.jobId).toBeNull();
    expect(validateManagedQuotaFailure(await begin(fixtures[loser]!.manifest))).toMatchObject({ requiredSeconds: 12, remainingSeconds: 8 });
    // Existing reserved work does not need another reservation.
    expect((await begin(fixtures[winner]!.manifest)).sessionId).toBe(uploads[winner]!.sessionId);
    const jobId = outcomes[winner]._id;
    await runtime.invoke("action", "managedTranscriptionActions:runProvider", { jobId }, runtime.device.token);
    expect(await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId }, runtime.device.token)).toMatchObject({ status: "provider_completed" });
    expect((await begin(fixtures[winner]!.manifest)).sessionId).toBe(uploads[winner]!.sessionId);
    await runtime.invoke("mutation", "managedTranscription:settleJob", { jobId }, runtime.device.token);
    await runtime.invoke("mutation", "managedTranscription:settleJob", { jobId }, runtime.device.token);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 12, reservedSeconds: 0 });
  }, 120_000);
});
