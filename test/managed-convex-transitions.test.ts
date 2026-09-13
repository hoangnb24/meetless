import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  startManagedConvexHarness,
  twoPartManifest,
} from "./managed-convex-production-harness";

type Harness = Awaited<ReturnType<typeof startManagedConvexHarness>>;
let harness: Harness | null = null;

describe("managed Convex provider state machine", () => {
  beforeAll(async () => {
    harness = await startManagedConvexHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
    harness = null;
  }, 30_000);

  test("executes a real two-part manifest through ordered production handlers and settles once", async () => {
    const runtime = requireHarness();
    const fixture = twoPartManifest(`managed-state-positive-${Date.now()}`);
    const upload = await runtime.uploadAndRegister(fixture);
    const sealed = await runtime.invoke<any>("action", "managedTranscriptionActions:sealUpload", { sessionId: upload.sessionId }, runtime.device.token);

    expect(sealed.status).toBe("reserved");
    expect(sealed.durationMs).toBe(fixture.manifest.durationMs);
    expect(await runtime.checkpoints(sealed._id)).toMatchObject([
      { partNumber: 1, sampleOffset: 0, status: "pending", attempt: 0 },
      { partNumber: 2, sampleOffset: fixture.manifest.parts[1]!.sampleOffset, status: "pending", attempt: 0 },
    ]);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 1 });

    const first = await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: sealed._id }, runtime.device.token);
    expect(first).toMatchObject({ status: "reserved", providerInvocationCount: 1 });
    expect(await runtime.checkpoints(sealed._id)).toMatchObject([
      { partNumber: 1, status: "completed", attempt: 1, providerText: `Managed local provider transcript for ${fixture.manifest.recordingId}` },
      { partNumber: 2, status: "pending", attempt: 0 },
    ]);

    const second = await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: sealed._id }, runtime.device.token);
    const expectedText = [1, 2].map(() => `Managed local provider transcript for ${fixture.manifest.recordingId}`).join("\n");
    expect(second).toMatchObject({ status: "provider_completed", providerInvocationCount: 2 });
    expect(second.providerResult).toEqual({
      text: expectedText,
      ranges: [{ startMs: 0, endMs: fixture.manifest.durationMs, text: expectedText }],
      detectedLanguages: [],
    });
    const completedParts = await runtime.checkpoints(sealed._id);
    expect(completedParts).toHaveLength(2);
    expect(completedParts.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(completedParts.map((part) => part.status)).toEqual(["completed", "completed"]);
    expect(completedParts.map((part) => part.attempt)).toEqual([1, 1]);
    expect(new Set(completedParts.map((part) => part.requestId)).size).toBe(2);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 0, reservedSeconds: 1 });

    const duplicateProvider = await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: sealed._id }, runtime.device.token);
    expect(duplicateProvider).toMatchObject({ status: "provider_completed", providerInvocationCount: 2 });

    const settled = await runtime.invoke<any>("mutation", "managedTranscription:settleJob", { jobId: sealed._id }, runtime.device.token);
    expect(settled).toMatchObject({ status: "succeeded", providerInvocationCount: 2 });
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 1, reservedSeconds: 0 });
    const settledAgain = await runtime.invoke<any>("mutation", "managedTranscription:settleJob", { jobId: sealed._id }, runtime.device.token);
    expect(settledAgain).toMatchObject({ status: "succeeded", providerInvocationCount: 2 });
    expect(await runtime.quota()).toMatchObject({ usedSeconds: 1, reservedSeconds: 0 });
  }, 120_000);

  test("terminally fails an expired uncertain part, releases once, and never resubmits it", async () => {
    const runtime = requireHarness();
    const quotaBefore = await runtime.quota();
    const fixture = twoPartManifest(`managed-state-expired-${Date.now()}`);
    const upload = await runtime.uploadAndRegister(fixture);
    const sealed = await runtime.invoke<any>("action", "managedTranscriptionActions:sealUpload", { sessionId: upload.sessionId }, runtime.device.token);
    const claimed = await runtime.invoke<any>("mutation", "managedTranscription:claimProvider", {
      jobId: sealed._id,
      tokenIdentifier: runtime.device.tokenIdentifier,
      admissionId: sealed.admissionId,
    });

    expect(claimed).toMatchObject({ won: true, job: { status: "running", providerInvocationCount: 1 }, part: { partNumber: 1, status: "running", attempt: 1 } });
    const executionToken = claimed.job.executionToken as string;
    const expirationNow = claimed.part.leaseExpiresAt + 1;
    expect(await runtime.checkpoints(sealed._id)).toMatchObject([
      { partNumber: 1, status: "running", attempt: 1, executionToken },
      { partNumber: 2, status: "pending", attempt: 0 },
    ]);

    await runtime.invoke("mutation", "managedTranscription:reconcileManagedState", {
      accountId: runtime.device.accountId,
      now: expirationNow,
      limit: 50,
    });
    const failed = await runtime.invoke<any>("query", "managedTranscription:jobStatus", { jobId: sealed._id }, runtime.device.token);
    expect(failed).toMatchObject({
      status: "failed",
      providerInvocationCount: 1,
      failureReason: "managed provider part lease expired",
    });
    const failedParts = await runtime.checkpoints(sealed._id);
    expect(failedParts.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(failedParts.map((part) => part.status)).toEqual(["failed", "failed"]);
    expect(failedParts.map((part) => part.attempt)).toEqual([1, 0]);
    expect(failedParts.every((part) => part.executionToken === null)).toBe(true);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: quotaBefore.usedSeconds, reservedSeconds: quotaBefore.reservedSeconds });

    // A late provider failure callback and a repeated reconciliation are both
    // harmless after the durable terminal transition.
    await runtime.invoke("mutation", "managedTranscription:failProviderPart", {
      jobId: sealed._id,
      tokenIdentifier: runtime.device.tokenIdentifier,
      admissionId: sealed.admissionId,
      partNumber: 1,
      executionToken,
      reason: "late uncertain provider result",
    });
    await runtime.invoke("mutation", "managedTranscription:reconcileManagedState", {
      accountId: runtime.device.accountId,
      now: expirationNow,
      limit: 50,
    });
    expect(await runtime.quota()).toMatchObject({ usedSeconds: quotaBefore.usedSeconds, reservedSeconds: quotaBefore.reservedSeconds });

    const laterAction = await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: sealed._id }, runtime.device.token);
    const laterActionAgain = await runtime.invoke<any>("action", "managedTranscriptionActions:runProvider", { jobId: sealed._id }, runtime.device.token);
    const laterClaim = await runtime.invoke<any>("mutation", "managedTranscription:claimProvider", {
      jobId: sealed._id,
      tokenIdentifier: runtime.device.tokenIdentifier,
      admissionId: sealed.admissionId,
    });
    expect(laterAction).toMatchObject({ status: "failed", providerInvocationCount: 1 });
    expect(laterActionAgain).toMatchObject({ status: "failed", providerInvocationCount: 1 });
    expect(laterClaim).toMatchObject({ won: false, job: { status: "failed", providerInvocationCount: 1 } });
    expect(await runtime.invoke<any>("query", "managedTranscription:jobStatus", { jobId: sealed._id }, runtime.device.token)).toMatchObject({
      status: "failed",
      providerInvocationCount: 1,
    });
    expect(await runtime.checkpoints(sealed._id)).toEqual(failedParts);
    expect(await runtime.quota()).toMatchObject({ usedSeconds: quotaBefore.usedSeconds, reservedSeconds: quotaBefore.reservedSeconds });
  }, 120_000);
});

function requireHarness(): Harness {
  if (!harness) throw new Error("managed Convex production harness is not initialized");
  return harness;
}
