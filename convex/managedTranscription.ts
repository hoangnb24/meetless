import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requirePrincipal } from "./managedAuth";
export { requirePrincipal } from "./managedAuth";
import { assertNonProductionFixture, readManagedRuntimeConfig } from "./managedConfig";
import {
  AUTHORITY,
  LEASE_MS,
  MAX_DEVICES,
  SAMPLE_RATE,
  TEMPORARY_TTL_MS,
  type JobState,
  type TimelineManifest,
  normalizeManifest,
} from "./shared";

const partValidator = v.object({
  partNumber: v.number(),
  sampleOffset: v.number(),
  sampleCount: v.number(),
  byteLength: v.number(),
  sha256: v.string(),
});

const manifestValidator = v.object({
  recordingId: v.string(),
  audioId: v.string(),
  manifestSha256: v.string(),
  contentSha256: v.string(),
  byteLength: v.number(),
  durationMs: v.number(),
  sampleCount: v.number(),
  partsManifestSha256: v.string(),
  parts: v.array(partValidator),
});

const providerPartResultValidator = v.object({
  text: v.string(),
  detectedLanguages: v.array(v.string()),
});

/** Five-minute provider requests need a bounded lease with recovery headroom. */
const PROVIDER_PART_LEASE_MS = 10 * 60 * 1_000;

const PROVIDER_PART_LEASE_EXPIRED_REASON = "managed provider part lease expired";
const PROVIDER_PART_FAILED_REASON = "managed provider part failed";

export interface ManagedProviderPartCheckpointState {
  readonly partNumber: number;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly executionToken: string | null;
  readonly leaseExpiresAt: number;
  readonly providerText: string | null;
  readonly detectedLanguages: readonly string[];
}

export interface ManagedProviderJobFailureState {
  readonly status: JobState;
  readonly executionToken?: string | null;
}

/**
 * A provider-part timeout is terminal for the current admission.  Returning
 * null is important: a completed/pending part, or a live lease, is never
 * silently converted into another provider attempt.
 */
export function expiredManagedProviderPartTransition(
  job: ManagedProviderJobFailureState,
  part: ManagedProviderPartCheckpointState,
  now: number,
): { readonly partStatus: "failed"; readonly jobStatus: "failed"; readonly releaseReservation: true; readonly reason: string } | null {
  if ((job.status !== "reserved" && job.status !== "running") || part.status !== "running" || part.leaseExpiresAt > now) return null;
  return {
    partStatus: "failed",
    jobStatus: "failed",
    releaseReservation: true,
    reason: PROVIDER_PART_LEASE_EXPIRED_REASON,
  };
}

/** Selects the next immutable physical part without revisiting a checkpoint. */
export function nextManagedProviderPart<T extends ManagedProviderPartCheckpointState>(parts: readonly T[]): T | null {
  return [...parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .find((part) => part.status === "pending") ?? null;
}

type PrincipalContext = QueryCtx | MutationCtx;

export const beginUpload = mutation({
  args: { manifest: manifestValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal, account } = await requirePrincipal(ctx);
    const manifest = normalizeManifest(args.manifest as TimelineManifest);
    const now = Date.now();
    await reconcileManagedStateForAccount(ctx, principal.accountId, now, 32);
    const uploadKey = uploadKeyFor(principal.accountId, manifest);
    const existing = currentTransportUpload(await ctx.db
      .query("managedUploads")
      .withIndex("by_upload_key", (q) => q.eq("accountId", principal.accountId).eq("uploadKey", uploadKey))
      .collect());
    if (existing) {
      assertSameManifest(existing, manifest);
      if (existing.expiresAt <= now) {
        await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: existing._id });
        throw new Error(`Managed upload exceeded its accepted 24-hour TTL (${AUTHORITY})`);
      }
      return uploadView(ctx, existing);
    }
    const timelineKey = timelineKeyFor(principal.accountId, manifest);
    const existingUploadForTimeline = currentTransportUpload(await ctx.db
      .query("managedUploads")
      .withIndex("by_timeline", (q) => q.eq("accountId", principal.accountId).eq("recordingId", manifest.recordingId).eq("audioId", manifest.audioId))
      .collect());
    if (existingUploadForTimeline) assertSameManifest(existingUploadForTimeline, manifest);
    const existingJob = await ctx.db
      .query("managedJobs")
      .withIndex("by_timeline", (q) => q.eq("accountId", principal.accountId).eq("timelineKey", timelineKey))
      .unique();
    if (existingJob && existingJob.fingerprint !== fingerprintFor(manifest)) {
      throw new Error(`Managed recording timeline is already bound to different immutable bytes (${AUTHORITY})`);
    }
    assertCurrentEntitlement(principal, now);
    const createdAt = now;
    const uploadId = await ctx.db.insert("managedUploads", {
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      uploadKey,
      recordingId: manifest.recordingId,
      audioId: manifest.audioId,
      manifestSha256: manifest.manifestSha256,
      contentSha256: manifest.contentSha256,
      partsManifestSha256: manifest.partsManifestSha256,
      byteLength: manifest.byteLength,
      durationMs: manifest.durationMs,
      sampleCount: manifest.sampleCount,
      parts: manifest.parts.map((part) => ({ ...part })),
      state: existingJob ? "sealed" : "uploading",
      createdAt,
      expiresAt: createdAt + TEMPORARY_TTL_MS,
      cancelGeneration: 0,
      jobId: existingJob?._id ?? null,
      acknowledgedAt: null,
    });
    await ctx.scheduler.runAfter(TEMPORARY_TTL_MS, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId });
    const upload = await ctx.db.get(uploadId);
    if (!upload) throw new Error(`Managed upload disappeared during creation (${AUTHORITY})`);
    // `account` is read above as part of the authenticated boundary. Keeping
    // the reference here makes it explicit that the upload is account-owned.
    void account.accountId;
    return uploadView(ctx, upload);
  },
});

export const generateUploadUrl = mutation({
  args: { sessionId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    if (upload.state !== "uploading") throw new Error(`Managed upload is ${upload.state}; no more parts may be added (${AUTHORITY})`);
    if (upload.expiresAt <= Date.now()) {
      await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
      throw new Error(`Managed upload exceeded its accepted 24-hour TTL (${AUTHORITY})`);
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerPart = mutation({
  args: {
    sessionId: v.id("managedUploads"),
    partNumber: v.number(),
    sampleOffset: v.number(),
    sampleCount: v.number(),
    byteLength: v.number(),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    if (upload.state !== "uploading") throw new Error(`Managed upload is ${upload.state}; its immutable part manifest is closed (${AUTHORITY})`);
    if (upload.expiresAt <= Date.now()) {
      await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
      throw new Error(`Managed upload exceeded its accepted 24-hour TTL (${AUTHORITY})`);
    }
    const expected = upload.parts[args.partNumber - 1];
    if (!expected || !samePart(expected, args)) {
      throw new Error(`Managed part ${args.partNumber} does not match the immutable sample-offset manifest (${AUTHORITY})`);
    }
    const existing = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id).eq("partNumber", args.partNumber))
      .unique();
    if (existing) {
      if (!sameStoredPartDescriptor(existing, args)) throw new Error(`Managed part ${args.partNumber} was rebound to a different storage ID or digest (${AUTHORITY})`);
      if (existing.storageId !== args.storageId) await ctx.storage.delete(args.storageId);
      return { outcome: "duplicate", partNumber: args.partNumber, storageId: existing.storageId };
    }
    const rebound = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (rebound) throw new Error(`Managed storage ID is already bound to another immutable part (${AUTHORITY})`);
    const partId = await ctx.db.insert("managedUploadParts", {
      uploadId: upload._id,
      accountId: principal.accountId,
      partNumber: args.partNumber,
      sampleOffset: args.sampleOffset,
      sampleCount: args.sampleCount,
      byteLength: args.byteLength,
      sha256: args.sha256,
      storageId: args.storageId,
    });
    return { outcome: "stored", partNumber: args.partNumber, storageId: args.storageId, partId };
  },
});

export const status = query({
  args: { sessionId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id))
      .collect();
    return uploadView(ctx, upload, parts);
  },
});

export const jobStatus = query({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
    return publicJob(job);
  },
});

export const jobStatusByRecording = query({
  args: { recordingId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const job = await ctx.db
      .query("managedJobs")
      .withIndex("by_account_recording", (q) => q.eq("accountId", principal.accountId).eq("recordingId", args.recordingId))
      .unique();
    return job ? publicJob(job) : null;
  },
});

export const cancelUpload = mutation({
  args: { sessionId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    const now = Date.now();
    await reconcileManagedStateForAccount(ctx, principal.accountId, now, 32);
    const currentUpload = await ctx.db.get(args.sessionId);
    assertUploadOwner(currentUpload, principal.accountId);
    if (currentUpload.state === "cleaned") return uploadView(ctx, currentUpload);
    const job = currentUpload.jobId === null ? null : await ctx.db.get(currentUpload.jobId);
    const nextGeneration = (currentUpload.cancelGeneration ?? 0) + 1;
    if (job) {
      if (job.status === "reserved" || job.status === "running") {
        await stopJobParts(ctx, job._id, "managed upload cancelled");
        await releaseReservation(ctx, job);
        await ctx.db.patch(job._id, {
          status: "cancelled",
          failureReason: "managed upload cancelled",
          executionToken: null,
        });
      }
    }
    if (currentUpload.state !== "cancelled") {
      await ctx.db.patch(currentUpload._id, { state: "cancelled", cancelGeneration: nextGeneration });
    }
    await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: currentUpload._id });
    return uploadView(ctx, (await ctx.db.get(currentUpload._id))!);
  },
});

export const settleJob = mutation({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
    await reconcileManagedStateForAccount(ctx, principal.accountId, Date.now(), 32);
    const current = await ctx.db.get(args.jobId);
    if (!current || current.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
    if (current.status === "succeeded") return publicJob(current);
    if (current.status !== "provider_completed") throw new Error(`Managed job is ${current.status}; only provider-completed work can settle (${AUTHORITY})`);
    return publicJob(await settleProviderCompleted(ctx, current, Date.now()));
  },
});

export const readSealData = internalQuery({
  args: { sessionId: v.id("managedUploads"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id))
      .collect();
    const job = upload.jobId === null ? null : await ctx.db.get(upload.jobId);
    return { upload, parts, job };
  },
});

/** Read-only preparation; only the explicit Retry action invokes this seam. */
export const readUploadForRepair = internalQuery({
  args: { sessionId: v.id("managedUploads"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    assertCurrentEntitlement(principal, Date.now());
    const successor = await directTransportSuccessor(ctx, upload);
    if (successor) return { upload, parts: [], successor: await uploadView(ctx, successor) };
    await assertUnadmittedTransport(ctx, upload);
    const parts = await ctx.db.query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id)).collect();
    return { upload, parts, successor: null };
  },
});

/** Atomically retire one proven-invalid, unadmitted transport attempt. */
export const repairCorruptUpload = internalMutation({
  args: {
    sessionId: v.id("managedUploads"), tokenIdentifier: v.string(), cancelGeneration: v.number(),
    parts: v.array(v.object({
      partId: v.id("managedUploadParts"), partNumber: v.number(), sampleOffset: v.number(),
      sampleCount: v.number(), byteLength: v.number(), sha256: v.string(), storageId: v.id("_storage"),
    })),
    mismatch: v.object({
      partNumber: v.number(), storageId: v.id("_storage"), expectedSha256: v.string(),
      observedSha256: v.string(), observedByteLength: v.number(),
    }),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    const now = Date.now();
    assertCurrentEntitlement(principal, now);
    // Bind duplicate requests to this predecessor's direct successor, even
    // after cleanup. A successor is never repaired into another generation.
    const successor = await directTransportSuccessor(ctx, upload);
    if (successor) return uploadView(ctx, successor);
    if (upload.transportPredecessorId) throw new Error("Managed transport successor cannot create another repair generation");
    await assertUnadmittedTransport(ctx, upload);
    if ((upload.cancelGeneration ?? 0) !== args.cancelGeneration) throw new Error("Managed transport repair lost its cancellation fence");
    const parts = await ctx.db.query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id)).collect();
    if (parts.length !== args.parts.length || parts.some((part) => {
      const checked = args.parts.find((candidate) => candidate.partId === part._id);
      return !checked || part.partNumber !== checked.partNumber || part.storageId !== checked.storageId || !sameStoredPartDescriptor(part, checked);
    })) throw new Error("Managed transport parts changed during integrity verification");
    const invalid = parts.find((part) => part.partNumber === args.mismatch.partNumber);
    if (!invalid || invalid.storageId !== args.mismatch.storageId || invalid.sha256 !== args.mismatch.expectedSha256 ||
      !/^[a-f0-9]{64}$/u.test(args.mismatch.observedSha256) || args.mismatch.observedSha256 === invalid.sha256 ||
      !Number.isSafeInteger(args.mismatch.observedByteLength) || args.mismatch.observedByteLength < 0) {
      throw new Error("Managed transport repair requires a verified stored-byte digest mismatch");
    }
    const manifest = normalizeManifest(uploadToManifest(upload));
    const successorId = await ctx.db.insert("managedUploads", {
      accountId: upload.accountId, deviceId: upload.deviceId, uploadKey: upload.uploadKey,
      ...manifest, parts: manifest.parts.map((part) => ({ ...part })), state: "uploading", createdAt: now, expiresAt: upload.expiresAt,
      cancelGeneration: 0, jobId: null, acknowledgedAt: null, transportPredecessorId: upload._id,
    });
    await ctx.db.patch(upload._id, {
      state: "cancelled", cancelGeneration: (upload.cancelGeneration ?? 0) + 1,
      transportSuccessorId: successorId, transportRepairEvidence: { verifiedAt: now, ...args.mismatch },
    });
    await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
    await ctx.scheduler.runAfter(upload.expiresAt - now, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: successorId });
    return uploadView(ctx, (await ctx.db.get(successorId))!);
  },
});

export const identityAccount = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    return { accountId: principal.accountId };
  },
});

export const admitSealedUpload = internalMutation({
  args: {
    sessionId: v.id("managedUploads"),
    tokenIdentifier: v.string(),
    contentSha256: v.string(),
    sampleCount: v.number(),
    byteLength: v.number(),
    durationMs: v.number(),
    partsManifestSha256: v.string(),
    cancelGeneration: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal, account } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    assertDeviceOwner(upload, principal.deviceId);
    const now = Date.now();
    await reconcileManagedStateForAccount(ctx, principal.accountId, now, 32);
    const currentUpload = await ctx.db.get(args.sessionId);
    assertUploadOwner(currentUpload, principal.accountId);
    assertDeviceOwner(currentUpload, principal.deviceId);
    if ((currentUpload.cancelGeneration ?? 0) !== args.cancelGeneration || currentUpload.state === "cancelled" || currentUpload.state === "cleaned") {
      throw new Error(`Managed seal is stale after upload cancellation; the immutable admission was not created (${AUTHORITY})`);
    }
    if (currentUpload.state !== "uploading" && currentUpload.state !== "sealed") {
      throw new Error(`Managed seal cannot admit upload state ${currentUpload.state} (${AUTHORITY})`);
    }
    if (currentUpload.expiresAt <= now) {
      await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: currentUpload._id });
      throw new Error(`Managed upload exceeded its accepted 24-hour TTL (${AUTHORITY})`);
    }
    const manifest = normalizeManifest(uploadToManifest(currentUpload));
    if (
      args.contentSha256 !== manifest.contentSha256 || args.sampleCount !== manifest.sampleCount ||
      args.byteLength !== manifest.byteLength || args.durationMs !== manifest.durationMs ||
      args.partsManifestSha256 !== manifest.partsManifestSha256
    ) throw new Error(`Stored managed WAV metadata does not match its immutable manifest (${AUTHORITY})`);
    const timelineKey = timelineKeyFor(principal.accountId, manifest);
    const fingerprint = fingerprintFor(manifest);
    const existing = await ctx.db
      .query("managedJobs")
      .withIndex("by_timeline", (q) => q.eq("accountId", principal.accountId).eq("timelineKey", timelineKey))
      .unique();
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Managed timeline identity was rebound to different bytes or parts (${AUTHORITY})`);
      if (existing.status === "expired" || existing.status === "failed" || existing.status === "cancelled" || existing.status === "stopped") {
        if (now >= existing.expiresAt) throw new Error(`Managed job exceeded its accepted 24-hour TTL (${AUTHORITY})`);
        const period = await currentPeriod(ctx, account, now);
        assertCurrentEntitlement(principal, now);
        assertQuota(period.limitSeconds - period.usedSeconds - period.reservedSeconds, billableSeconds(manifest.sampleCount), period);
        await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds + billableSeconds(manifest.sampleCount) });
        const admissionId = crypto.randomUUID();
        await ctx.db.patch(existing._id, {
          deviceId: principal.deviceId,
          uploadId: currentUpload._id,
          admissionId,
          admissionNumber: existing.admissionNumber + 1,
          status: "reserved",
          createdAt: now,
          leaseExpiresAt: now + LEASE_MS,
          expiresAt: now + TEMPORARY_TTL_MS,
          providerCompletedAt: null,
          settledAt: null,
          failureReason: null,
          providerResult: null,
          periodStartAt: period.startAt,
          cleanupState: "pending",
          acknowledgedAt: null,
        });
        await ensureJobPartCheckpoints(ctx, existing._id, currentUpload._id, principal.accountId, principal.deviceId, manifest, true);
        const uploadExpiresAt = currentUpload.transportPredecessorId ? currentUpload.expiresAt : now + TEMPORARY_TTL_MS;
        await ctx.db.patch(currentUpload._id, { state: "sealed", jobId: existing._id, expiresAt: uploadExpiresAt });
        await ctx.scheduler.runAfter(uploadExpiresAt - now, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: currentUpload._id });
        return publicJob((await ctx.db.get(existing._id))!);
      }
      await ctx.db.patch(currentUpload._id, { state: "sealed", jobId: existing._id });
      await ensureJobPartCheckpoints(ctx, existing._id, existing.uploadId, existing.accountId, existing.deviceId, manifest, false);
      return publicJob(existing);
    }
    assertCurrentEntitlement(principal, now);
    const period = await currentPeriod(ctx, account, now);
    const seconds = billableSeconds(manifest.sampleCount);
    assertQuota(period.limitSeconds - period.usedSeconds - period.reservedSeconds, seconds, period);
    await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds + seconds });
    const jobId = await ctx.db.insert("managedJobs", {
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      uploadId: currentUpload._id,
      timelineKey,
      fingerprint,
      recordingId: manifest.recordingId,
      audioId: manifest.audioId,
      manifestSha256: manifest.manifestSha256,
      contentSha256: manifest.contentSha256,
      sampleCount: manifest.sampleCount,
      durationMs: manifest.durationMs,
      billableSeconds: seconds,
      periodStartAt: period.startAt,
      admissionId: crypto.randomUUID(),
      admissionNumber: 1,
      status: "reserved",
      createdAt: now,
      leaseExpiresAt: now + LEASE_MS,
      expiresAt: now + TEMPORARY_TTL_MS,
      executionToken: null,
      executionAttempt: 0,
      providerInvocationCount: 0,
      providerCompletedAt: null,
      settledAt: null,
      failureReason: null,
      providerResult: null,
      acknowledgedAt: null,
      cleanupState: "pending",
    });
    await ensureJobPartCheckpoints(ctx, jobId, currentUpload._id, principal.accountId, principal.deviceId, manifest, false);
    await ctx.db.patch(currentUpload._id, { state: "sealed", jobId });
    return publicJob((await ctx.db.get(jobId))!);
  },
});

export const readJobForAction = internalQuery({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", job.uploadId))
      .collect();
    return { job, parts };
  },
});

/** Provider actions receive only the job before they claim one bounded part. */
export const readJobForProvider = internalQuery({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
    return { job };
  },
});

/**
 * Internal state inspection for the production-faithful transition proof.
 * Checkpoint rows stay backend-only; this query deliberately omits storage
 * identity and returns only the durable state needed to verify the state
 * machine without reimplementing it in a test fixture.
 */
export const readJobPartCheckpoints = internalQuery({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const parts = await jobPartCheckpoints(ctx, args.jobId);
    return parts.map((part) => ({
      partNumber: part.partNumber,
      sampleOffset: part.sampleOffset,
      sampleCount: part.sampleCount,
      byteLength: part.byteLength,
      status: part.status,
      executionToken: part.executionToken,
      leaseExpiresAt: part.leaseExpiresAt,
      attempt: part.attempt,
      requestId: part.requestId,
      providerText: part.providerText,
      detectedLanguages: part.detectedLanguages,
      completedAt: part.completedAt,
      failureReason: part.failureReason,
    }));
  },
});

export const claimProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    let job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider admission is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider admission is stale (${AUTHORITY})`);
    if (job.status === "provider_completed" || job.status === "succeeded") return { won: false, job };
    if (job.deviceId !== principal.deviceId) throw new Error(`Managed provider execution requires the enrolled device that admitted the job (${AUTHORITY})`);
    assertExecutionEntitlement(principal);

    const now = Date.now();
    let parts = await jobPartCheckpoints(ctx, job._id);
    if (parts.length === 0) throw new Error(`Managed provider job has no durable part checkpoints (${AUTHORITY})`);
    const active = parts.find((part) => part.status === "running");
    if (active) {
      const expired = expiredManagedProviderPartTransition(job, active, now);
      if (expired) {
        await failExpiredProviderPart(ctx, job, active, now);
        return { won: false, job: (await ctx.db.get(job._id))! };
      }
      if (active.leaseExpiresAt > now) {
        if (job.status !== "running" || job.executionToken !== active.executionToken) {
          await ctx.db.patch(job._id, { status: "running", executionToken: active.executionToken });
          job = (await ctx.db.get(job._id))!;
        }
        return { won: false, job };
      }
    }

    if (job.leaseExpiresAt <= now || job.expiresAt <= now) {
      await expireJob(ctx, job);
      return { won: false, job: (await ctx.db.get(job._id))! };
    }

    const completed = await completeJobIfAllPartsDone(ctx, job, now);
    if (completed) return { won: false, job: completed };
    job = (await ctx.db.get(job._id))!;
    if (job.status !== "reserved") return { won: false, job };
    const next = nextManagedProviderPart(parts);
    if (!next) throw new Error(`Managed provider job has no resumable part checkpoint (${AUTHORITY})`);
    const executionToken = crypto.randomUUID();
    const attempt = next.attempt + 1;
    await ctx.db.patch(next._id, {
      status: "running",
      executionToken,
      leaseExpiresAt: now + PROVIDER_PART_LEASE_MS,
      attempt,
      failureReason: null,
    });
    await ctx.db.patch(job._id, {
      status: "running",
      executionToken,
      executionAttempt: (job.executionAttempt ?? 0) + 1,
      providerInvocationCount: (job.providerInvocationCount ?? 0) + 1,
    });
    // Ensure an abandoned provider action reaches the terminal failure
    // transition even when no client status query or periodic sweep arrives.
    // cleanupUpload first reconciles the expired part; it never resubmits it.
    await ctx.scheduler.runAfter(PROVIDER_PART_LEASE_MS, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: next.uploadId });
    const claimedJob = (await ctx.db.get(job._id))!;
    const claimedPart = (await ctx.db.get(next._id))!;
    return { won: true, job: claimedJob, part: claimedPart };
  },
});

/** Checkpoints exactly one provider response and resumes the next part. */
export const completeProviderPart = internalMutation({
  args: {
    jobId: v.id("managedJobs"),
    tokenIdentifier: v.string(),
    admissionId: v.string(),
    partNumber: v.number(),
    executionToken: v.string(),
    result: providerPartResultValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider result is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider result admission is stale (${AUTHORITY})`);
    const part = await ctx.db
      .query("managedJobParts")
      .withIndex("by_job_part", (q) => q.eq("jobId", job._id).eq("partNumber", args.partNumber))
      .unique();
    if (!part) throw new Error(`Managed provider part checkpoint is missing (${AUTHORITY})`);
    // A provider response can race the mutation that already checkpointed the
    // same part. The durable checkpoint is the idempotency boundary; do not
    // turn a duplicate into a new provider attempt.
    if (part.status === "completed") return publicJob(await completeJobIfAllPartsDone(ctx, job, Date.now()) ?? job);
    if (job.status === "provider_completed" || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || job.status === "expired" || job.status === "stopped") return publicJob(job);
    if (job.status !== "running") throw new Error(`Managed job is ${job.status}; provider part cannot be recorded (${AUTHORITY})`);
    if (job.deviceId !== principal.deviceId || job.executionToken !== args.executionToken) throw new Error(`Managed provider result token is stale (${AUTHORITY})`);
    if (part.status !== "running" || part.executionToken !== args.executionToken) throw new Error(`Managed provider part token is stale (${AUTHORITY})`);
    const now = Date.now();
    if (part.leaseExpiresAt <= now) {
      await failExpiredProviderPart(ctx, job, part, now);
      throw new Error(`Managed provider part lease expired before completion (${AUTHORITY})`);
    }
    if (job.leaseExpiresAt <= now || job.expiresAt <= now) {
      await expireJob(ctx, job);
      throw new Error(`Managed provider lease expired before completion (${AUTHORITY})`);
    }
    const text = args.result.text.trim();
    if (!text) throw new Error(`Managed provider part returned no text (${AUTHORITY})`);
    const detectedLanguages = args.result.detectedLanguages
      .filter((language) => language.trim().length > 0)
      .map((language) => language.trim());
    await ctx.db.patch(part._id, {
      status: "completed",
      executionToken: null,
      leaseExpiresAt: 0,
      providerText: text,
      detectedLanguages,
      completedAt: now,
      failureReason: null,
    });
    const current = (await ctx.db.get(job._id))!;
    const completed = await completeJobIfAllPartsDone(ctx, current, now);
    if (completed) return publicJob(completed);
    // Exactly one physical part is owned by this invocation. Once its
    // checkpoint is durable, release the invocation token so the next action
    // can claim the next pending part instead of observing a permanently
    // running job with no active part.
    await ctx.db.patch(job._id, { status: "reserved", executionToken: null });
    return publicJob((await ctx.db.get(job._id))!);
  },
});

/** Provider failures release one admission while retaining completed checkpoints for retry. */
export const failProviderPart = internalMutation({
  args: {
    jobId: v.id("managedJobs"),
    tokenIdentifier: v.string(),
    admissionId: v.string(),
    partNumber: v.number(),
    executionToken: v.union(v.string(), v.null()),
    reason: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider failure is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) return publicJob(job);
    if (job.status === "failed" || job.status === "provider_completed" || job.status === "succeeded") return publicJob(job);
    if (job.deviceId !== principal.deviceId) throw new Error(`Managed provider failure requires the enrolled device that admitted the job (${AUTHORITY})`);
    const part = await ctx.db
      .query("managedJobParts")
      .withIndex("by_job_part", (q) => q.eq("jobId", job._id).eq("partNumber", args.partNumber))
      .unique();
    if (!part || part.status !== "running" || args.executionToken === null || part.executionToken !== args.executionToken || job.executionToken !== args.executionToken) {
      return publicJob(job);
    }
    await stopJobParts(ctx, job._id, PROVIDER_PART_FAILED_REASON);
    await releaseReservation(ctx, job);
    await ctx.db.patch(job._id, {
      status: "failed",
      failureReason: PROVIDER_PART_FAILED_REASON,
      executionToken: null,
    });
    return publicJob((await ctx.db.get(job._id))!);
  },
});

/** Legacy admission failure seam retained for upload/setup errors; its reason is always redacted. */
export const failProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string(), executionToken: v.union(v.string(), v.null()), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider failure is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) return publicJob(job);
    if (job.status === "failed" || job.status === "provider_completed" || job.status === "succeeded") return publicJob(job);
    if ((job.status === "reserved" || job.status === "running") && job.deviceId !== principal.deviceId) {
      throw new Error(`Managed provider failure requires the enrolled device that admitted the job (${AUTHORITY})`);
    }
    if (job.status === "running" && (args.executionToken === null || job.executionToken !== args.executionToken)) return publicJob(job);
    if (job.status === "reserved" || job.status === "running") {
      await stopJobParts(ctx, job._id, PROVIDER_PART_FAILED_REASON);
      await releaseReservation(ctx, job);
      await ctx.db.patch(job._id, { status: "failed", failureReason: PROVIDER_PART_FAILED_REASON, executionToken: null });
    }
    return publicJob((await ctx.db.get(job._id))!);
  },
});

export const markAcknowledged = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed publication acknowledgement is not account-owned (${AUTHORITY})`);
    if (job.status !== "succeeded") throw new Error(`Managed job is not settled; publication cannot be acknowledged (${AUTHORITY})`);
    if (job.acknowledgedAt !== null) return job;
    await ctx.db.patch(job._id, { acknowledgedAt: Date.now() });
    const upload = await ctx.db.get(job.uploadId);
    if (upload) await ctx.db.patch(upload._id, { acknowledgedAt: Date.now() });
    return (await ctx.db.get(job._id))!;
  },
});

export const markCleaned = internalMutation({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const checkpoints = await ctx.db
      .query("managedJobParts")
      .withIndex("by_job_part", (q) => q.eq("jobId", job._id))
      .collect();
    await Promise.all(checkpoints.map((part) => ctx.db.delete(part._id)));
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", job.uploadId))
      .collect();
    await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
    const upload = await ctx.db.get(job.uploadId);
    if (upload) await ctx.db.patch(upload._id, { state: "cleaned" });
    await ctx.db.patch(job._id, { cleanupState: "cleaned", providerResult: null });
    return (await ctx.db.get(job._id))!;
  },
});

export const readUploadForCleanup = internalQuery({
  args: { uploadId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload) return null;
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id))
      .collect();
    return { upload, parts };
  },
});

export const markUploadCleaned = internalMutation({
  args: { uploadId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload) return null;
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id))
      .collect();
    await Promise.all(parts.map((part) => ctx.db.delete(part._id)));
    await ctx.db.patch(upload._id, { state: "cleaned" });
    if (upload.jobId !== null) {
      let job = await ctx.db.get(upload.jobId);
      if (job && (job.status === "reserved" || job.status === "running")) {
        const now = Date.now();
        const expiredPart = (await jobPartCheckpoints(ctx, job._id)).find((part) =>
          expiredManagedProviderPartTransition(job!, part, now) !== null,
        );
        if (expiredPart && await failExpiredProviderPart(ctx, job, expiredPart, now)) {
          job = await ctx.db.get(job._id);
        }
      }
      if (job && (job.status === "reserved" || job.status === "running")) {
        if (job.expiresAt <= Date.now() || job.leaseExpiresAt <= Date.now()) {
          await stopJobParts(ctx, job._id, "managed temporary data TTL expired");
          await releaseReservation(ctx, job);
          await ctx.db.patch(job._id, {
            status: "expired",
            executionToken: null,
            failureReason: "managed temporary data TTL expired",
            cleanupState: "cleaned",
            providerResult: null,
          });
        }
      } else if (job && job.status === "provider_completed" && job.expiresAt <= Date.now()) {
        await releaseReservation(ctx, job);
        await ctx.db.patch(job._id, {
          status: "expired",
          executionToken: null,
          failureReason: "managed temporary data TTL expired before settlement",
          cleanupState: "cleaned",
          providerResult: null,
        });
      } else if (job && job.expiresAt <= Date.now()) {
        await ctx.db.patch(job._id, { cleanupState: "cleaned", providerResult: null });
      }
      if (job) {
        const checkpoints = await ctx.db
          .query("managedJobParts")
          .withIndex("by_job_part", (q) => q.eq("jobId", job._id))
          .collect();
        await Promise.all(checkpoints.map((part) => ctx.db.delete(part._id)));
      }
    }
    return true;
  },
});

/**
 * At-least-once reconciliation. The indexed reads are deliberately bounded;
 * Convex OCC makes concurrent callers retry against the committed ledger and
 * the charge-by-job lookup makes the retry idempotent.
 */
export const reconcileManagedState = internalMutation({
  args: { accountId: v.optional(v.string()), now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.min(100, Math.max(1, args.limit ?? 50));
    const stoppedAccounts = new Map<string, boolean>();
    const jobs = new Map<string, any>();
    const expiredLeases = await ctx.db.query("managedJobs").withIndex("by_lease", (q) => q.lte("leaseExpiresAt", now)).take(limit);
    const expiredResults = await ctx.db.query("managedJobs").withIndex("by_expiry", (q) => q.lte("expiresAt", now)).take(limit);
    for (const job of [...expiredLeases, ...expiredResults]) {
      if (!args.accountId || job.accountId === args.accountId) jobs.set(String(job._id), job);
    }
    const expiredPartLeases = await ctx.db
      .query("managedJobParts")
      .withIndex("by_lease", (q) => q.lte("leaseExpiresAt", now))
      .filter((q) => q.eq(q.field("status"), "running"))
      .take(limit);
    for (const part of expiredPartLeases) {
      if (part.status !== "running") continue;
      const job = await ctx.db.get(part.jobId);
      if (job && (!args.accountId || job.accountId === args.accountId)) jobs.set(String(job._id), job);
    }
    let changedJobs = 0;
    for (const original of jobs.values()) {
      let stopped = stoppedAccounts.get(original.accountId);
      if (stopped === undefined) {
        stopped = await accountHasStop(ctx, original.accountId);
        stoppedAccounts.set(original.accountId, stopped);
      }
      const changed = await reconcileJob(ctx, original, now, stopped);
      if (changed) changedJobs += 1;
    }
    const uploads = await ctx.db.query("managedUploads").withIndex("by_expiry", (q) => q.lte("expiresAt", now)).take(limit);
    let scheduledUploads = 0;
    for (const upload of uploads) {
      if (args.accountId && upload.accountId !== args.accountId) continue;
      if (upload.state === "cleaned") continue;
      await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
      scheduledUploads += 1;
    }
    return { changedJobs, scheduledUploads, examined: jobs.size };
  },
});

export const expiredUploads = internalQuery({
  args: { accountId: v.string(), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => ctx.db
    .query("managedUploads")
    .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
    .filter((q) => q.eq(q.field("accountId"), args.accountId))
    .take(Math.min(100, Math.max(1, args.limit ?? 50))),
});

export const setLocalCanaryNextPeriodAllowance = internalMutation({
  args: { accountId: v.string(), limitSeconds: v.number(), allowanceSource: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = readManagedRuntimeConfig();
    assertNonProductionFixture(config, "local canary allowance mutation");
    if (config.mode === "production" || args.allowanceSource !== config.allowanceSource) {
      throw new Error(`Local canary allowance changes require the explicitly labeled deployment allowance source (${AUTHORITY})`);
    }
    if (!Number.isSafeInteger(args.limitSeconds) || args.limitSeconds <= 0) throw new Error(`Managed allowance must be a positive whole-second value (${AUTHORITY})`);
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
    await ctx.db.patch(account._id, { nextPeriodLimitSeconds: args.limitSeconds, allowanceSource: args.allowanceSource });
    return { accountId: args.accountId, limitSeconds: args.limitSeconds, allowanceSource: args.allowanceSource };
  },
});

export const setEntitlement = internalMutation({
  args: {
    accountId: v.string(),
    entitlement: v.union(v.literal("active"), v.literal("grace"), v.literal("expired"), v.literal("refunded"), v.literal("revoked")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertNonProductionFixture(readManagedRuntimeConfig(), "fixture entitlement mutation");
    const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", args.accountId)).collect();
    await Promise.all(principals.map((principal) => ctx.db.patch(principal._id, { entitlement: args.entitlement })));
    if (args.entitlement === "refunded" || args.entitlement === "revoked") {
      const jobs = await ctx.db.query("managedJobs").withIndex("by_timeline", (q) => q.eq("accountId", args.accountId)).collect();
      for (const job of jobs) {
        if (job.status === "reserved" || job.status === "running") {
          await stopJobParts(ctx, job._id, args.entitlement);
          await releaseReservation(ctx, job);
          await ctx.db.patch(job._id, { status: "stopped", failureReason: args.entitlement, executionToken: null });
        }
      }
    }
    return true;
  },
});

export const setNaturalExpiry = internalMutation({
  args: { accountId: v.string(), naturalExpiryAt: v.union(v.number(), v.null()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertNonProductionFixture(readManagedRuntimeConfig(), "fixture natural-expiry mutation");
    const principals = await ctx.db
      .query("managedPrincipals")
      .withIndex("by_account_device", (q) => q.eq("accountId", args.accountId))
      .collect();
    if (principals.length === 0) throw new Error(`Managed subscription account is missing (${AUTHORITY})`);
    await Promise.all(principals.map((principal) => ctx.db.patch(principal._id, { naturalExpiryAt: args.naturalExpiryAt })));
    return { accountId: args.accountId, naturalExpiryAt: args.naturalExpiryAt };
  },
});

export const setCurrentPeriodEnd = internalMutation({
  args: { accountId: v.string(), endAt: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertNonProductionFixture(readManagedRuntimeConfig(), "local period mutation");
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (!account || args.endAt <= account.currentPeriodStartAt) throw new Error(`Managed period end is invalid (${AUTHORITY})`);
    await ctx.db.patch(account._id, { currentPeriodEndAt: args.endAt });
    return { accountId: args.accountId, endAt: args.endAt };
  },
});

export const prepareNextCanaryPeriod = internalMutation({
  args: { accountId: v.string(), durationMs: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertNonProductionFixture(readManagedRuntimeConfig(), "local period preparation");
    if (!Number.isSafeInteger(args.durationMs) || args.durationMs <= 0) throw new Error(`Managed test period duration is invalid (${AUTHORITY})`);
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
    const now = Date.now();
    const startAt = now - args.durationMs;
    const endAt = now - 1;
    const oldPeriod = await periodFor(ctx, args.accountId, account.currentPeriodStartAt);
    const existing = await periodFor(ctx, args.accountId, startAt, true);
    if (!existing) {
      await ctx.db.insert("managedPeriods", {
        accountId: args.accountId,
        product: oldPeriod.product,
        startAt,
        endAt,
        limitSeconds: oldPeriod.limitSeconds,
        usedSeconds: 0,
        reservedSeconds: 0,
      });
    }
    await ctx.db.patch(account._id, { currentPeriodStartAt: startAt, currentPeriodEndAt: endAt });
    return { accountId: args.accountId, startAt, endAt };
  },
});

export const readLocalCanaryQuota = internalQuery({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
    const period = await periodFor(ctx, args.accountId, account.currentPeriodStartAt);
    return {
      currentPeriodStartAt: account.currentPeriodStartAt,
      currentPeriodEndAt: account.currentPeriodEndAt,
      nextPeriodLimitSeconds: account.nextPeriodLimitSeconds,
      allowanceSource: account.allowanceSource,
      limitSeconds: period.limitSeconds,
      usedSeconds: period.usedSeconds,
      reservedSeconds: period.reservedSeconds,
    };
  },
});

export const revokeDevice = internalMutation({
  args: { accountId: v.string(), deviceId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("managedDevices")
      .withIndex("by_account_device", (q) => q.eq("accountId", args.accountId).eq("deviceId", args.deviceId))
      .unique();
    if (!device) throw new Error(`Managed device is not enrolled in the account (${AUTHORITY})`);
    const revokedAt = Date.now();
    await ctx.db.patch(device._id, { revokedAt });
    const principals = await ctx.db
      .query("managedPrincipals")
      .withIndex("by_account_device", (q) => q.eq("accountId", args.accountId).eq("deviceId", args.deviceId))
      .collect();
    await Promise.all(principals.map((principal) => ctx.db.patch(principal._id, { revokedAt, entitlement: "revoked" })));
    const jobs = await ctx.db
      .query("managedJobs")
      .withIndex("by_timeline", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const job of jobs) {
      if (job.deviceId !== args.deviceId || (job.status !== "reserved" && job.status !== "running")) continue;
      await stopJobParts(ctx, job._id, "device revoked");
      await releaseReservation(ctx, job);
      await ctx.db.patch(job._id, { status: "stopped", failureReason: "device revoked", executionToken: null });
    }
    return { accountId: args.accountId, deviceId: args.deviceId, revokedAt };
  },
});

export const clearLocalCanary = internalMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertNonProductionFixture(readManagedRuntimeConfig(), "local canary cleanup");
    const uploads = await ctx.db.query("managedUploads").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    let storageObjects = 0;
    for (const upload of uploads) {
      const parts = await ctx.db.query("managedUploadParts").withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id)).collect();
      for (const part of parts) {
        await ctx.storage.delete(part.storageId);
        await ctx.db.delete(part._id);
        storageObjects += 1;
      }
      await ctx.db.delete(upload._id);
    }
    const jobs = await ctx.db.query("managedJobs").withIndex("by_timeline", (q) => q.eq("accountId", args.accountId)).collect();
    for (const job of jobs) {
      const checkpoints = await ctx.db
        .query("managedJobParts")
        .withIndex("by_job_part", (q) => q.eq("jobId", job._id))
        .collect();
      for (const checkpoint of checkpoints) await ctx.db.delete(checkpoint._id);
      const charges = await ctx.db.query("managedCharges").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect();
      for (const charge of charges) await ctx.db.delete(charge._id);
      await ctx.db.delete(job._id);
    }
    const periods = await ctx.db.query("managedPeriods").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const period of periods) await ctx.db.delete(period._id);
    const lineages = await ctx.db.query("managedLineages").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const lineage of lineages) {
      const events = await ctx.db.query("managedRevenueCatEvents").withIndex("by_lineage", (q) => q.eq("lineageKey", lineage.lineageKey)).collect();
      for (const event of events) await ctx.db.delete(event._id);
      await ctx.db.delete(lineage._id);
    }
    const devicesForCleanup = await ctx.db.query("managedDevices").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const device of devicesForCleanup) {
      const challenges = await ctx.db.query("managedDeviceChallenges").withIndex("by_device_key", (q) => q.eq("deviceId", device.deviceId).eq("keyId", device.keyId)).collect();
      for (const challenge of challenges) await ctx.db.delete(challenge._id);
    }
    const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", args.accountId)).collect();
    for (const principal of principals) await ctx.db.delete(principal._id);
    const devices = await ctx.db.query("managedDevices").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const device of devices) await ctx.db.delete(device._id);
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (account) await ctx.db.delete(account._id);
    return { accountId: args.accountId, uploads: uploads.length, jobs: jobs.length, storageObjects };
  },
});

async function principalForToken(ctx: PrincipalContext, tokenIdentifier: string) {
  const principal = await ctx.db
    .query("managedPrincipals")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  if (!principal || !principal.lineageVerified || principal.revokedAt !== null) throw new Error(`Internal managed identity is not verified (${AUTHORITY})`);
  const device = await ctx.db
    .query("managedDevices")
    .withIndex("by_account_device", (q) => q.eq("accountId", principal.accountId).eq("deviceId", principal.deviceId))
    .unique();
  if (!device || device.keyId !== principal.keyId || device.keyVersion !== principal.keyVersion || device.revokedAt !== null) throw new Error(`Internal managed device credential is revoked or not current (${AUTHORITY})`);
  return principal;
}

async function principalForTokenWithAccount(ctx: PrincipalContext, tokenIdentifier: string) {
  const principal = await principalForToken(ctx, tokenIdentifier);
  const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", principal.accountId)).unique();
  if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
  return { principal, account };
}

function assertDeviceOwner(upload: any, deviceId: string): void {
  if (upload?.deviceId !== deviceId) throw new Error(`Managed upload action requires its current enrolled device (${AUTHORITY})`);
}

function publicJob(job: any): any {
  if (!job) return job;
  const { executionToken: _executionToken, ...safe } = job;
  return safe;
}

function assertCurrentEntitlement(principal: { entitlement: string; naturalExpiryAt?: number | null }, now: number): void {
  if (principal.entitlement !== "active" && principal.entitlement !== "grace") {
    throw new Error(`Managed entitlement is ${principal.entitlement}; Ask and BYOK remain free (${AUTHORITY})`);
  }
  if (principal.naturalExpiryAt !== null && principal.naturalExpiryAt !== undefined && principal.naturalExpiryAt <= now) {
    throw new Error(`Managed subscription naturally expired; only already-admitted work may recover within its lease and TTL (${AUTHORITY})`);
  }
}

function assertExecutionEntitlement(principal: { entitlement: string }): void {
  if (principal.entitlement === "refunded" || principal.entitlement === "revoked") {
    throw new Error(`Managed ${principal.entitlement} entitlement stops new provider execution (${AUTHORITY})`);
  }
}

function assertSameManifest(upload: { recordingId: string; audioId: string; manifestSha256: string; contentSha256: string; byteLength: number; durationMs: number; sampleCount: number; partsManifestSha256: string; parts: readonly TimelineManifest["parts"][number][] }, manifest: TimelineManifest): void {
  if (
    upload.recordingId !== manifest.recordingId || upload.audioId !== manifest.audioId ||
    upload.manifestSha256 !== manifest.manifestSha256 || upload.contentSha256 !== manifest.contentSha256 ||
    upload.byteLength !== manifest.byteLength || upload.durationMs !== manifest.durationMs ||
    upload.sampleCount !== manifest.sampleCount || upload.partsManifestSha256 !== manifest.partsManifestSha256 ||
    JSON.stringify(upload.parts) !== JSON.stringify(manifest.parts)
  ) throw new Error(`Managed upload reused an immutable timeline identity with different bytes or parts (${AUTHORITY})`);
}

function assertUploadOwner(upload: any, accountId: string): asserts upload {
  if (!upload || upload.accountId !== accountId) throw new Error(`Managed upload is not owned by the authenticated account (${AUTHORITY})`);
}

function samePart(left: TimelineManifest["parts"][number], right: { partNumber: number; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }): boolean {
  return left.partNumber === right.partNumber && left.sampleOffset === right.sampleOffset && left.sampleCount === right.sampleCount && left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function sameStoredPartDescriptor(left: { sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }, right: { sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }): boolean {
  return left.sampleOffset === right.sampleOffset && left.sampleCount === right.sampleCount && left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function uploadToManifest(upload: any): TimelineManifest {
  return {
    recordingId: upload.recordingId,
    audioId: upload.audioId,
    manifestSha256: upload.manifestSha256,
    contentSha256: upload.contentSha256,
    byteLength: upload.byteLength,
    durationMs: upload.durationMs,
    sampleCount: upload.sampleCount,
    partsManifestSha256: upload.partsManifestSha256,
    parts: upload.parts,
  };
}

function uploadKeyFor(accountId: string, manifest: TimelineManifest): string {
  return `${accountId}\u0000${manifest.recordingId}\u0000${manifest.audioId}\u0000${manifest.manifestSha256}\u0000${manifest.contentSha256}\u0000${manifest.sampleCount}`;
}

function timelineKeyFor(accountId: string, manifest: TimelineManifest): string {
  return `${accountId}\u0000${manifest.recordingId}\u0000${manifest.audioId}`;
}

function fingerprintFor(manifest: TimelineManifest): string {
  return `${manifest.manifestSha256}:${manifest.contentSha256}:${manifest.byteLength}:${manifest.sampleCount}:${manifest.partsManifestSha256}`;
}

function billableSeconds(sampleCount: number): number {
  return Math.max(1, Math.ceil(sampleCount / SAMPLE_RATE));
}

function assertQuota(remaining: number, seconds: number, period: { limitSeconds: number; usedSeconds: number; reservedSeconds: number }): void {
  if (remaining < seconds) throw new Error(`Managed quota exhausted: requested ${seconds}, remaining ${Math.max(0, remaining)} in the snapshotted period (${AUTHORITY})`);
  if (period.limitSeconds < 0 || period.usedSeconds < 0 || period.reservedSeconds < 0) throw new Error(`Managed quota ledger is invalid (${AUTHORITY})`);
}

async function currentPeriod(ctx: MutationCtx, account: any, now: number) {
  let period = await periodFor(ctx, account.accountId, account.currentPeriodStartAt);
  if (now < account.currentPeriodEndAt) return period;
  const nextStart = account.currentPeriodEndAt;
  const nextEnd = nextStart + (account.currentPeriodEndAt - account.currentPeriodStartAt);
  const existing = await periodFor(ctx, account.accountId, nextStart, true);
  if (existing) {
    await ctx.db.patch(account._id, { currentPeriodStartAt: existing.startAt, currentPeriodEndAt: existing.endAt });
    return existing;
  }
  const nextId = await ctx.db.insert("managedPeriods", {
    accountId: account.accountId,
    product: period.product,
    startAt: nextStart,
    endAt: nextEnd,
    limitSeconds: account.nextPeriodLimitSeconds,
    usedSeconds: 0,
    reservedSeconds: 0,
  });
  await ctx.db.patch(account._id, { currentPeriodStartAt: nextStart, currentPeriodEndAt: nextEnd });
  period = await ctx.db.get(nextId);
  if (!period) throw new Error(`Managed quota period disappeared during rollover (${AUTHORITY})`);
  return period;
}

async function periodFor(ctx: PrincipalContext, accountId: string, startAt: number, optional = false): Promise<any> {
  const period = await ctx.db
    .query("managedPeriods")
    .withIndex("by_account_start", (q) => q.eq("accountId", accountId).eq("startAt", startAt))
    .unique();
  if (!period && !optional) throw new Error(`Managed quota period is missing (${AUTHORITY})`);
  return period;
}

async function releaseReservation(ctx: MutationCtx, job: { accountId: string; periodStartAt: number; billableSeconds: number }) {
  const period = await periodFor(ctx, job.accountId, job.periodStartAt);
  if (period.reservedSeconds < job.billableSeconds) throw new Error(`Managed job reservation is inconsistent (${AUTHORITY})`);
  await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds - job.billableSeconds });
}

async function expireJob(ctx: MutationCtx, job: { _id: any; status: JobState; accountId: string; periodStartAt: number; billableSeconds: number }) {
  if (job.status === "reserved" || job.status === "running") {
    await stopJobParts(ctx, job._id, "managed six-hour lease expired");
    await releaseReservation(ctx, job);
    await ctx.db.patch(job._id, { status: "expired", executionToken: null, failureReason: "managed six-hour lease expired" });
  }
}

async function jobPartCheckpoints(ctx: PrincipalContext, jobId: any): Promise<any[]> {
  const parts = await ctx.db
    .query("managedJobParts")
    .withIndex("by_job_part", (q) => q.eq("jobId", jobId))
    .collect();
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

async function ensureJobPartCheckpoints(
  ctx: MutationCtx,
  jobId: any,
  uploadId: any,
  accountId: string,
  deviceId: string,
  manifest: TimelineManifest,
  resetNoncompleted: boolean,
): Promise<void> {
  const stored = (await ctx.db
    .query("managedUploadParts")
    .withIndex("by_upload_part", (q) => q.eq("uploadId", uploadId))
    .collect()).sort((left, right) => left.partNumber - right.partNumber);
  if (stored.length !== manifest.parts.length || stored.some((part, index) => part.partNumber !== index + 1)) {
    throw new Error(`Managed provider requires every immutable upload part before admission (${AUTHORITY})`);
  }
  const existing = await jobPartCheckpoints(ctx, jobId);
  if (existing.length > manifest.parts.length) throw new Error(`Managed provider checkpoint manifest has unexpected extra parts (${AUTHORITY})`);
  const existingByPart = new Map(existing.map((part) => [part.partNumber, part]));
  for (const descriptor of manifest.parts) {
    const uploadPart = stored[descriptor.partNumber - 1];
    if (!uploadPart || !samePart(descriptor, uploadPart)) {
      throw new Error(`Managed provider part ${descriptor.partNumber} changed its immutable storage identity (${AUTHORITY})`);
    }
    const checkpoint = existingByPart.get(descriptor.partNumber);
    if (checkpoint) {
      if (!sameCheckpointDescriptor(checkpoint, descriptor)) {
        throw new Error(`Managed provider checkpoint ${descriptor.partNumber} changed its immutable descriptor (${AUTHORITY})`);
      }
      const patch: Record<string, unknown> = {};
      if (checkpoint.uploadId !== uploadId) patch.uploadId = uploadId;
      if (checkpoint.storageId !== uploadPart.storageId) patch.storageId = uploadPart.storageId;
      if (checkpoint.accountId !== accountId) patch.accountId = accountId;
      if (checkpoint.deviceId !== deviceId) patch.deviceId = deviceId;
      if (resetNoncompleted && checkpoint.status !== "completed") {
        patch.status = "pending";
        patch.executionToken = null;
        patch.leaseExpiresAt = 0;
        patch.providerText = null;
        patch.detectedLanguages = [];
        patch.completedAt = null;
        patch.failureReason = null;
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(checkpoint._id, patch);
      continue;
    }
    await ctx.db.insert("managedJobParts", {
      jobId,
      uploadId,
      accountId,
      deviceId,
      partNumber: descriptor.partNumber,
      sampleOffset: descriptor.sampleOffset,
      sampleCount: descriptor.sampleCount,
      byteLength: descriptor.byteLength,
      sha256: descriptor.sha256,
      storageId: uploadPart.storageId,
      status: "pending",
      executionToken: null,
      leaseExpiresAt: 0,
      attempt: 0,
      requestId: crypto.randomUUID(),
      providerText: null,
      detectedLanguages: [],
      completedAt: null,
      failureReason: null,
    });
  }
}

function sameCheckpointDescriptor(
  checkpoint: { partNumber: number; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string },
  descriptor: TimelineManifest["parts"][number],
): boolean {
  return checkpoint.partNumber === descriptor.partNumber && checkpoint.sampleOffset === descriptor.sampleOffset &&
    checkpoint.sampleCount === descriptor.sampleCount && checkpoint.byteLength === descriptor.byteLength &&
    checkpoint.sha256 === descriptor.sha256;
}

async function completeJobIfAllPartsDone(ctx: MutationCtx, job: any, now: number): Promise<any | null> {
  if (job.status !== "reserved" && job.status !== "running") return job.status === "provider_completed" || job.status === "succeeded" ? job : null;
  const parts = await jobPartCheckpoints(ctx, job._id);
  if (parts.length === 0 || parts.some((part) => part.status !== "completed")) return null;
  const result = aggregateManagedProviderParts(job, parts);
  await ctx.db.patch(job._id, {
    status: "provider_completed",
    providerCompletedAt: now,
    providerResult: result,
    executionToken: null,
  });
  return (await ctx.db.get(job._id))!;
}

export function aggregateManagedProviderParts(
  job: { durationMs: number },
  parts: readonly { status: string; providerText: string | null; detectedLanguages: readonly string[] }[],
): { text: string; ranges: [{ startMs: number; endMs: number; text: string }]; detectedLanguages: string[] } {
  if (parts.some((part) => part.status !== "completed" || part.providerText === null)) {
    throw new Error(`Managed provider cannot aggregate incomplete part checkpoints (${AUTHORITY})`);
  }
  const text = parts.map((part) => part.providerText!).join("\n");
  return {
    text,
    ranges: [{ startMs: 0, endMs: job.durationMs, text }],
    detectedLanguages: [...new Set(parts.flatMap((part) => part.detectedLanguages.filter((language) => language.trim().length > 0)))],
  };
}

async function stopJobParts(ctx: MutationCtx, jobId: any, reason: string): Promise<void> {
  const parts = await jobPartCheckpoints(ctx, jobId);
  for (const part of parts) {
    if (part.status === "completed") continue;
    await ctx.db.patch(part._id, {
      status: "failed",
      executionToken: null,
      leaseExpiresAt: 0,
      failureReason: reason,
    });
  }
}

async function failExpiredProviderPart(ctx: MutationCtx, job: any, part: any, now: number): Promise<boolean> {
  const transition = expiredManagedProviderPartTransition(job, part, now);
  if (!transition) return false;
  // Terminalize every unfinished checkpoint for this admission. Completed
  // checkpoints remain durable, while pending/running parts cannot be
  // reclaimed or resent until an explicit new user Retry creates an admission.
  await stopJobParts(ctx, job._id, transition.reason);
  await releaseReservation(ctx, job);
  await ctx.db.patch(job._id, {
    status: transition.jobStatus,
    executionToken: null,
    failureReason: transition.reason,
  });
  return true;
}

async function failExpiredProviderParts(ctx: MutationCtx, job: any, now: number): Promise<boolean> {
  const parts = await jobPartCheckpoints(ctx, job._id);
  for (const part of parts) {
    if (await failExpiredProviderPart(ctx, job, part, now)) return true;
  }
  return false;
}

async function settleProviderCompleted(ctx: MutationCtx, job: any, now: number): Promise<any> {
  if (job.status === "succeeded") return job;
  if (job.status !== "provider_completed") throw new Error(`Managed job is ${job.status}; only provider-completed work can settle (${AUTHORITY})`);
  const existingCharge = await ctx.db
    .query("managedCharges")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .unique();
  if (existingCharge) {
    await ctx.db.patch(job._id, { status: "succeeded", settledAt: existingCharge.chargedAt });
    return (await ctx.db.get(job._id))!;
  }
  if (job.expiresAt <= now) throw new Error(`Managed provider result exceeded its accepted 24-hour TTL before settlement (${AUTHORITY})`);
  const period = await periodFor(ctx, job.accountId, job.periodStartAt);
  if (period.reservedSeconds < job.billableSeconds) throw new Error(`Managed job lost its quota reservation before settlement (${AUTHORITY})`);
  const chargedAt = now;
  await ctx.db.patch(period._id, {
    reservedSeconds: period.reservedSeconds - job.billableSeconds,
    usedSeconds: period.usedSeconds + job.billableSeconds,
  });
  await ctx.db.insert("managedCharges", {
    jobId: job._id,
    accountId: job.accountId,
    periodStartAt: period.startAt,
    seconds: job.billableSeconds,
    chargedAt,
  });
  await ctx.db.patch(job._id, { status: "succeeded", settledAt: chargedAt });
  return (await ctx.db.get(job._id))!;
}

async function accountHasStop(ctx: MutationCtx, accountId: string): Promise<boolean> {
  const principals = await ctx.db
    .query("managedPrincipals")
    .withIndex("by_account_device", (q) => q.eq("accountId", accountId))
    .take(MAX_DEVICES + 1);
  return principals.some((principal) => principal.entitlement === "refunded" || (principal.entitlement === "revoked" && principal.revokedAt === null));
}

async function reconcileManagedStateForAccount(ctx: MutationCtx, accountId: string, now: number, limit: number): Promise<void> {
  const jobs = new Map<string, any>();
  const expiredLeases = await ctx.db.query("managedJobs").withIndex("by_lease", (q) => q.lte("leaseExpiresAt", now)).take(limit);
  const expiredResults = await ctx.db.query("managedJobs").withIndex("by_expiry", (q) => q.lte("expiresAt", now)).take(limit);
  for (const job of [...expiredLeases, ...expiredResults]) if (job.accountId === accountId) jobs.set(String(job._id), job);
  const expiredPartLeases = await ctx.db
    .query("managedJobParts")
    .withIndex("by_lease", (q) => q.lte("leaseExpiresAt", now))
    .filter((q) => q.eq(q.field("status"), "running"))
    .take(limit);
  for (const part of expiredPartLeases) {
    if (part.status !== "running") continue;
    const job = await ctx.db.get(part.jobId);
    if (job?.accountId === accountId) jobs.set(String(job._id), job);
  }
  const stopped = await accountHasStop(ctx, accountId);
  for (const job of jobs.values()) await reconcileJob(ctx, job, now, stopped);
}

async function reconcileJob(ctx: MutationCtx, job: any, now: number, stopped: boolean): Promise<boolean> {
  const failedExpiredPart = await failExpiredProviderParts(ctx, job, now);
  const currentJob = await ctx.db.get(job._id);
  if (!currentJob) return failedExpiredPart;
  job = currentJob;
  if (failedExpiredPart) return true;
  if (job.status === "reserved" || job.status === "running") {
    if (!stopped && job.leaseExpiresAt > now && job.expiresAt > now) return false;
    await stopJobParts(ctx, job._id, stopped ? "managed entitlement or device revoked" : "managed six-hour lease expired");
    await releaseReservation(ctx, job);
    await ctx.db.patch(job._id, {
      status: stopped ? "stopped" : "expired",
      executionToken: null,
      failureReason: stopped ? "managed entitlement or device revoked" : "managed six-hour lease expired",
    });
    if (job.expiresAt <= now) await scheduleUploadCleanup(ctx, job.uploadId);
    return true;
  }
  if (job.status === "provider_completed") {
    if (job.expiresAt <= now) {
      await releaseReservation(ctx, job);
      await ctx.db.patch(job._id, {
        status: "expired",
        executionToken: null,
        providerResult: null,
        failureReason: "managed temporary data TTL expired before settlement",
      });
      await scheduleUploadCleanup(ctx, job.uploadId);
      return true;
    }
    await settleProviderCompleted(ctx, job, now);
    return true;
  }
  if (job.expiresAt <= now && job.cleanupState !== "cleaned") {
    await ctx.db.patch(job._id, { providerResult: null });
    await scheduleUploadCleanup(ctx, job.uploadId);
    return true;
  }
  return false;
}

async function scheduleUploadCleanup(ctx: MutationCtx, uploadId: any): Promise<void> {
  await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId });
}

/** Legacy rows form a one-node chain; repairs must form one unambiguous chain. */
function currentTransportUpload(uploads: readonly Doc<"managedUploads">[]): Doc<"managedUploads"> | null {
  if (uploads.length === 0) return null;
  const roots = uploads.filter((upload) => !upload.transportPredecessorId);
  if (roots.length !== 1) throw new Error("Managed transport history has ambiguous roots");
  const visited = new Set<string>();
  let current = roots[0]!;
  while (current) {
    if (visited.has(current._id)) throw new Error("Managed transport history contains a cycle");
    visited.add(current._id);
    if (!current.transportSuccessorId) break;
    const next = uploads.find((upload) => upload._id === current.transportSuccessorId);
    if (!next || next.transportPredecessorId !== current._id || next.uploadKey !== current.uploadKey ||
      next.expiresAt !== current.expiresAt) throw new Error("Managed transport history is inconsistent");
    assertSameManifest(next, uploadToManifest(current));
    current = next;
  }
  if (visited.size !== uploads.length) throw new Error("Managed transport history has disconnected attempts");
  return current;
}

async function directTransportSuccessor(ctx: QueryCtx | MutationCtx, upload: Doc<"managedUploads">) {
  if (!upload.transportSuccessorId) return null;
  const successor = await ctx.db.get(upload.transportSuccessorId);
  if (!successor || successor.transportPredecessorId !== upload._id ||
    successor.accountId !== upload.accountId || successor.deviceId !== upload.deviceId ||
    successor.uploadKey !== upload.uploadKey || successor.expiresAt !== upload.expiresAt) {
    throw new Error("Managed transport successor identity is inconsistent");
  }
  assertSameManifest(successor, uploadToManifest(upload));
  return successor;
}

async function assertUnadmittedTransport(ctx: QueryCtx | MutationCtx, upload: Doc<"managedUploads">): Promise<void> {
  if (upload.state !== "uploading" || upload.expiresAt <= Date.now() || upload.jobId !== null) {
    throw new Error("Managed transport repair requires an unexpired, unadmitted uploading attempt");
  }
  const job = await ctx.db.query("managedJobs")
    .withIndex("by_timeline", (q) => q.eq("accountId", upload.accountId).eq("timelineKey", timelineKeyFor(upload.accountId, uploadToManifest(upload))))
    .unique();
  if (job) throw new Error("Managed transport repair cannot reset admitted or uncertain provider work");
}

async function uploadView(ctx: QueryCtx | MutationCtx, upload: any, parts?: readonly any[]) {
  const received = parts ?? await ctx.db.query("managedUploadParts").withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id)).collect();
  return {
    sessionId: upload._id,
    accountId: upload.accountId,
    deviceId: upload.deviceId,
    state: upload.state,
    createdAt: upload.createdAt,
    expiresAt: upload.expiresAt,
    receivedPartNumbers: received.map((part) => part.partNumber).sort((left, right) => left - right),
    completedAt: upload.acknowledgedAt,
    jobId: upload.jobId,
  };
}
