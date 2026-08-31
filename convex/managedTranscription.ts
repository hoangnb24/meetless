import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  AUTHORITY,
  LEASE_MS,
  MAX_DEVICES,
  MONTHLY_SECONDS,
  SAMPLE_RATE,
  TEMPORARY_TTL_MS,
  TRIAL_SECONDS,
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

const providerRangeValidator = v.object({
  startMs: v.number(),
  endMs: v.number(),
  text: v.string(),
});

const providerResultValidator = v.object({
  text: v.string(),
  ranges: v.array(providerRangeValidator),
  detectedLanguages: v.array(v.string()),
});

type PrincipalContext = QueryCtx | MutationCtx;

/**
 * Public functions derive the account from Convex auth plus a server-created
 * verified principal. No App User ID, client entitlement, or caller account
 * assertion is accepted at this boundary.
 */
export async function requirePrincipal(ctx: PrincipalContext) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier) {
    throw new Error(`Managed Convex request requires host-authenticated server identity (${AUTHORITY})`);
  }
  const principal = await ctx.db
    .query("managedPrincipals")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!principal || !principal.lineageVerified || principal.revokedAt !== null) {
    throw new Error(`Managed Convex identity is not backed by verified subscription lineage and device key (${AUTHORITY})`);
  }
  const device = await ctx.db
    .query("managedDevices")
    .withIndex("by_account_device", (q) => q.eq("accountId", principal.accountId).eq("deviceId", principal.deviceId))
    .unique();
  if (!device || device.keyId !== principal.keyId || device.revokedAt !== null) {
    throw new Error(`Managed Convex device credential is revoked or not server verified (${AUTHORITY})`);
  }
  const account = await ctx.db
    .query("managedAccounts")
    .withIndex("by_account", (q) => q.eq("accountId", principal.accountId))
    .unique();
  if (!account) throw new Error(`Managed Convex quota account is missing (${AUTHORITY})`);
  if (principal.entitlement !== "active" && principal.entitlement !== "grace") {
    throw new Error(`Managed Convex entitlement is ${principal.entitlement}; Ask and BYOK remain outside this gate (${AUTHORITY})`);
  }
  return { identity, principal, device, account };
}

export const beginUpload = mutation({
  args: { manifest: manifestValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal, account } = await requirePrincipal(ctx);
    const manifest = normalizeManifest(args.manifest as TimelineManifest);
    const uploadKey = uploadKeyFor(principal.accountId, manifest);
    const now = Date.now();
    const existing = await ctx.db
      .query("managedUploads")
      .withIndex("by_upload_key", (q) => q.eq("accountId", principal.accountId).eq("uploadKey", uploadKey))
      .unique();
    if (existing) {
      assertSameManifest(existing, manifest);
      if (existing.expiresAt <= now) {
        await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: existing._id });
        throw new Error(`Managed upload exceeded its accepted 24-hour TTL (${AUTHORITY})`);
      }
      return uploadView(ctx, existing);
    }
    const timelineKey = timelineKeyFor(principal.accountId, manifest);
    const existingUploadForTimeline = await ctx.db
      .query("managedUploads")
      .withIndex("by_timeline", (q) => q.eq("accountId", principal.accountId).eq("recordingId", manifest.recordingId).eq("audioId", manifest.audioId))
      .unique();
    if (existingUploadForTimeline) assertSameManifest(existingUploadForTimeline, manifest);
    const existingJob = await ctx.db
      .query("managedJobs")
      .withIndex("by_timeline", (q) => q.eq("accountId", principal.accountId).eq("timelineKey", timelineKey))
      .unique();
    if (existingJob && existingJob.fingerprint !== fingerprintFor(manifest)) {
      throw new Error(`Managed recording timeline is already bound to different immutable bytes (${AUTHORITY})`);
    }
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
      if (!sameStoredPart(existing, args)) throw new Error(`Managed part ${args.partNumber} was rebound to a different storage ID or digest (${AUTHORITY})`);
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
    return job;
  },
});

export const cancelUpload = mutation({
  args: { sessionId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    if (upload.jobId !== null) {
      const job = await ctx.db.get(upload.jobId);
      if (job && (job.status === "reserved" || job.status === "running")) {
        await releaseReservation(ctx, job);
        await ctx.db.patch(job._id, {
          status: "cancelled",
          failureReason: "managed upload cancelled",
        });
      }
    }
    if (upload.state !== "cleaned") await ctx.db.patch(upload._id, { state: "cancelled" });
    await ctx.scheduler.runAfter(0, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
    return { ...upload, state: "cancelled" as const };
  },
});

export const settleJob = mutation({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await requirePrincipal(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed job is not owned by the authenticated account (${AUTHORITY})`);
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
    const period = await periodFor(ctx, job.accountId, job.periodStartAt);
    if (period.reservedSeconds < job.billableSeconds) throw new Error(`Managed job lost its quota reservation before settlement (${AUTHORITY})`);
    const chargedAt = Date.now();
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
  },
});

export const readSealData = internalQuery({
  args: { sessionId: v.id("managedUploads"), tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principal = await principalForToken(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    const parts = await ctx.db
      .query("managedUploadParts")
      .withIndex("by_upload_part", (q) => q.eq("uploadId", upload._id))
      .collect();
    const job = upload.jobId === null ? null : await ctx.db.get(upload.jobId);
    return { upload, parts, job };
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
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal, account } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const upload = await ctx.db.get(args.sessionId);
    assertUploadOwner(upload, principal.accountId);
    const manifest = normalizeManifest(uploadToManifest(upload));
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
    const now = Date.now();
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error(`Managed timeline identity was rebound to different bytes or parts (${AUTHORITY})`);
      if (existing.status === "expired" || existing.status === "failed" || existing.status === "cancelled" || existing.status === "stopped") {
        if (now >= existing.expiresAt) throw new Error(`Managed job exceeded its accepted 24-hour TTL (${AUTHORITY})`);
        const period = await currentPeriod(ctx, account, now);
        assertEntitled(principal.entitlement);
        assertQuota(period.limitSeconds - period.usedSeconds - period.reservedSeconds, billableSeconds(manifest.sampleCount), period);
        await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds + billableSeconds(manifest.sampleCount) });
        const admissionId = crypto.randomUUID();
        await ctx.db.patch(existing._id, {
          deviceId: principal.deviceId,
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
        await ctx.db.patch(upload._id, { state: "sealed", jobId: existing._id, expiresAt: now + TEMPORARY_TTL_MS });
        await ctx.scheduler.runAfter(TEMPORARY_TTL_MS, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
        return (await ctx.db.get(existing._id))!;
      }
      await ctx.db.patch(upload._id, { state: "sealed", jobId: existing._id });
      return existing;
    }
    assertEntitled(principal.entitlement);
    const period = await currentPeriod(ctx, account, now);
    const seconds = billableSeconds(manifest.sampleCount);
    assertQuota(period.limitSeconds - period.usedSeconds - period.reservedSeconds, seconds, period);
    await ctx.db.patch(period._id, { reservedSeconds: period.reservedSeconds + seconds });
    const jobId = await ctx.db.insert("managedJobs", {
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      uploadId: upload._id,
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
      providerCompletedAt: null,
      settledAt: null,
      failureReason: null,
      providerResult: null,
      acknowledgedAt: null,
      cleanupState: "pending",
    });
    await ctx.db.patch(upload._id, { state: "sealed", jobId });
    return (await ctx.db.get(jobId))!;
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

export const claimProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider admission is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider admission is stale (${AUTHORITY})`);
    if (job.status === "provider_completed" || job.status === "succeeded") return job;
    if (job.status === "reserved") {
      if (job.leaseExpiresAt <= Date.now()) {
        await expireJob(ctx, job);
        throw new Error(`Managed job lease expired before provider execution (${AUTHORITY})`);
      }
      await ctx.db.patch(job._id, { status: "running" });
      return (await ctx.db.get(job._id))!;
    }
    if (job.status === "running") return job;
    throw new Error(`Managed job is ${job.status} and cannot start provider execution (${AUTHORITY})`);
  },
});

export const completeProvider = internalMutation({
  args: {
    jobId: v.id("managedJobs"),
    tokenIdentifier: v.string(),
    admissionId: v.string(),
    result: providerResultValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider result is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider result admission is stale (${AUTHORITY})`);
    if (job.status === "provider_completed" || job.status === "succeeded") return job;
    if (job.status !== "running") throw new Error(`Managed job is ${job.status}; provider result cannot be recorded (${AUTHORITY})`);
    if (job.leaseExpiresAt <= Date.now()) {
      await expireJob(ctx, job);
      throw new Error(`Managed job lease expired before provider completion (${AUTHORITY})`);
    }
    if (
      args.result.ranges.length !== 1 || args.result.ranges[0]?.startMs !== 0 ||
      args.result.ranges[0]?.endMs !== job.durationMs || args.result.ranges[0]?.text !== args.result.text
    ) throw new Error(`Managed provider result must cover one full timeline without diarization (${AUTHORITY})`);
    await ctx.db.patch(job._id, {
      status: "provider_completed",
      providerCompletedAt: Date.now(),
      providerResult: {
        text: args.result.text,
        ranges: args.result.ranges.map((range) => ({ ...range })),
        detectedLanguages: [...args.result.detectedLanguages],
      },
    });
    return (await ctx.db.get(job._id))!;
  },
});

export const failProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string(), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider failure is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) return job;
    if (job.status === "failed") return job;
    if (job.status === "provider_completed" || job.status === "succeeded") return job;
    if (job.status === "reserved" || job.status === "running") {
      await releaseReservation(ctx, job);
      await ctx.db.patch(job._id, { status: "failed", failureReason: args.reason });
    }
    return (await ctx.db.get(job._id))!;
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
      const job = await ctx.db.get(upload.jobId);
      if (job && job.expiresAt <= Date.now()) {
        await ctx.db.patch(job._id, { cleanupState: "cleaned", providerResult: null });
      }
    }
    return true;
  },
});

export const expiredUploads = internalQuery({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => ctx.db
    .query("managedUploads")
    .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
    .filter((q) => q.eq(q.field("accountId"), args.accountId))
    .collect(),
});

export const setNextPeriodLimit = internalMutation({
  args: { accountId: v.string(), limitSeconds: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.limitSeconds) || args.limitSeconds <= 0) throw new Error(`Managed allowance must be a positive whole-second value (${AUTHORITY})`);
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
    await ctx.db.patch(account._id, { nextPeriodLimitSeconds: args.limitSeconds });
    return { accountId: args.accountId, limitSeconds: args.limitSeconds };
  },
});

export const setEntitlement = internalMutation({
  args: {
    accountId: v.string(),
    entitlement: v.union(v.literal("active"), v.literal("grace"), v.literal("expired"), v.literal("refunded"), v.literal("revoked")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", args.accountId)).collect();
    await Promise.all(principals.map((principal) => ctx.db.patch(principal._id, { entitlement: args.entitlement })));
    if (args.entitlement === "refunded" || args.entitlement === "revoked") {
      const jobs = await ctx.db.query("managedJobs").withIndex("by_timeline", (q) => q.eq("accountId", args.accountId)).collect();
      for (const job of jobs) {
        if (job.status === "reserved" || job.status === "running") {
          await releaseReservation(ctx, job);
          await ctx.db.patch(job._id, { status: "stopped", failureReason: args.entitlement });
        }
      }
    }
    return true;
  },
});

/**
 * Internal-only seed for an anonymous deployment canary. It is not part of
 * the public API and takes no caller-selected entitlement or quota. Production
 * verified-lineage adapters must replace this test seed.
 */
export const seedLocalCanary = internalMutation({
  args: { tokenIdentifier: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const tokenIdentifier = args.tokenIdentifier.trim();
    if (!tokenIdentifier) throw new Error(`Local canary identity must be seeded by an internal test command (${AUTHORITY})`);
    const accountId = `local-canary:${tokenIdentifier}`;
    const existing = await ctx.db.query("managedPrincipals").withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", tokenIdentifier)).unique();
    if (existing) return { accountId: existing.accountId, deviceId: existing.deviceId, keyId: existing.keyId };
    const now = Date.now();
    const periodLength = 30 * 24 * 60 * 60 * 1_000;
    const deviceId = `local-device:${tokenIdentifier}`;
    const keyId = `local-key:${tokenIdentifier}`;
    await ctx.db.insert("managedAccounts", {
      accountId,
      currentPeriodStartAt: now,
      currentPeriodEndAt: now + periodLength,
      nextPeriodLimitSeconds: MONTHLY_SECONDS,
      maxDevices: MAX_DEVICES,
    });
    await ctx.db.insert("managedPeriods", {
      accountId,
      product: "monthly",
      startAt: now,
      endAt: now + periodLength,
      limitSeconds: MONTHLY_SECONDS,
      usedSeconds: 0,
      reservedSeconds: 0,
    });
    await ctx.db.insert("managedDevices", { accountId, deviceId, keyId, enrolledAt: now, revokedAt: null });
    await ctx.db.insert("managedPrincipals", {
      tokenIdentifier,
      accountId,
      deviceId,
      keyId,
      lineageVerified: true,
      entitlement: "active",
      revokedAt: null,
      enrolledAt: now,
    });
    return { accountId, deviceId, keyId, trialSeconds: TRIAL_SECONDS };
  },
});

async function principalForToken(ctx: PrincipalContext, tokenIdentifier: string) {
  const principal = await ctx.db
    .query("managedPrincipals")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  if (!principal || !principal.lineageVerified || principal.revokedAt !== null) throw new Error(`Internal managed identity is not verified (${AUTHORITY})`);
  return principal;
}

async function principalForTokenWithAccount(ctx: PrincipalContext, tokenIdentifier: string) {
  const principal = await principalForToken(ctx, tokenIdentifier);
  const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", principal.accountId)).unique();
  if (!account) throw new Error(`Managed quota account is missing (${AUTHORITY})`);
  assertEntitled(principal.entitlement);
  return { principal, account };
}

function assertEntitled(entitlement: string): void {
  if (entitlement !== "active" && entitlement !== "grace") throw new Error(`Managed entitlement is ${entitlement}; Ask and BYOK remain free (${AUTHORITY})`);
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

function sameStoredPart(left: { storageId: string; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }, right: { storageId: string; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }): boolean {
  return left.storageId === right.storageId && left.sampleOffset === right.sampleOffset && left.sampleCount === right.sampleCount && left.byteLength === right.byteLength && left.sha256 === right.sha256;
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
    await releaseReservation(ctx, job);
    await ctx.db.patch(job._id, { status: "expired", failureReason: "managed six-hour lease expired" });
  }
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
