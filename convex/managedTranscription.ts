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
  return { identity, principal, device, account };
}

export const beginUpload = mutation({
  args: { manifest: manifestValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal, account } = await requirePrincipal(ctx);
    const manifest = normalizeManifest(args.manifest as TimelineManifest);
    const now = Date.now();
    await reconcileManagedStateForAccount(ctx, principal.accountId, now, 32);
    const uploadKey = uploadKeyFor(principal.accountId, manifest);
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
        await ctx.db.patch(currentUpload._id, { state: "sealed", jobId: existing._id, expiresAt: now + TEMPORARY_TTL_MS });
        await ctx.scheduler.runAfter(TEMPORARY_TTL_MS, anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: currentUpload._id });
        return publicJob((await ctx.db.get(existing._id))!);
      }
      await ctx.db.patch(currentUpload._id, { state: "sealed", jobId: existing._id });
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

export const claimProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider admission is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider admission is stale (${AUTHORITY})`);
    if (job.status === "provider_completed" || job.status === "succeeded") return { won: false, job };
    if (job.deviceId !== principal.deviceId) throw new Error(`Managed provider execution requires the enrolled device that admitted the job (${AUTHORITY})`);
    assertExecutionEntitlement(principal);
    if (job.status === "reserved") {
      if (job.leaseExpiresAt <= Date.now() || job.expiresAt <= Date.now()) {
        await expireJob(ctx, job);
        throw new Error(`Managed job lease expired before provider execution (${AUTHORITY})`);
      }
      const executionToken = crypto.randomUUID();
      await ctx.db.patch(job._id, {
        status: "running",
        executionToken,
        executionAttempt: (job.executionAttempt ?? 0) + 1,
      });
      return { won: true, job: (await ctx.db.get(job._id))! };
    }
    if (job.status === "running") return { won: false, job };
    throw new Error(`Managed job is ${job.status} and cannot start provider execution (${AUTHORITY})`);
  },
});

export const recordProviderInvocation = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string(), executionToken: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider invocation is not account-owned (${AUTHORITY})`);
    if (job.deviceId !== principal.deviceId || job.admissionId !== args.admissionId || job.executionToken !== args.executionToken || job.status !== "running") {
      throw new Error(`Managed provider invocation token is stale or not owned by the admitting device (${AUTHORITY})`);
    }
    await ctx.db.patch(job._id, { providerInvocationCount: (job.providerInvocationCount ?? 0) + 1 });
    return (await ctx.db.get(job._id))!;
  },
});

export const completeProvider = internalMutation({
  args: {
    jobId: v.id("managedJobs"),
    tokenIdentifier: v.string(),
    admissionId: v.string(),
    executionToken: v.string(),
    result: providerResultValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider result is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) throw new Error(`Managed provider result admission is stale (${AUTHORITY})`);
    if (job.status === "provider_completed" || job.status === "succeeded") return publicJob(job);
    if (job.status !== "running") throw new Error(`Managed job is ${job.status}; provider result cannot be recorded (${AUTHORITY})`);
    if (job.deviceId !== principal.deviceId || job.executionToken !== args.executionToken) throw new Error(`Managed provider result token is stale (${AUTHORITY})`);
    if (job.leaseExpiresAt <= Date.now()) {
      await expireJob(ctx, job);
      throw new Error(`Managed job lease expired before provider completion (${AUTHORITY})`);
    }
    if (
      args.result.ranges.length !== 1 || args.result.ranges[0]?.startMs !== 0 ||
      args.result.ranges[0]?.endMs !== job.durationMs || args.result.ranges[0]?.text !== args.result.text
    ) throw new Error(`Managed provider result must cover one full timeline without diarization (${AUTHORITY})`);
    return publicJob(await settleCompletedProvider(ctx, job, {
      text: args.result.text,
      ranges: args.result.ranges.map((range) => ({ ...range })),
      detectedLanguages: [...args.result.detectedLanguages],
    }, Date.now(), args.executionToken));
  },
});

export const failProvider = internalMutation({
  args: { jobId: v.id("managedJobs"), tokenIdentifier: v.string(), admissionId: v.string(), executionToken: v.union(v.string(), v.null()), reason: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { principal } = await principalForTokenWithAccount(ctx, args.tokenIdentifier);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.accountId !== principal.accountId) throw new Error(`Managed provider failure is not account-owned (${AUTHORITY})`);
    if (job.admissionId !== args.admissionId) return job;
    if (job.status === "failed") return publicJob(job);
    if (job.status === "provider_completed" || job.status === "succeeded") return job;
    if (job.status === "reserved" || job.status === "running") {
      if (job.status === "running" && (args.executionToken === null || job.executionToken !== args.executionToken)) return publicJob(job);
      await releaseReservation(ctx, job);
      await ctx.db.patch(job._id, { status: "failed", failureReason: args.reason, executionToken: null });
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
      if (job && (job.status === "reserved" || job.status === "running")) {
        if (job.expiresAt <= Date.now() || job.leaseExpiresAt <= Date.now()) {
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
      const charges = await ctx.db.query("managedCharges").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect();
      for (const charge of charges) await ctx.db.delete(charge._id);
      await ctx.db.delete(job._id);
    }
    const periods = await ctx.db.query("managedPeriods").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const period of periods) await ctx.db.delete(period._id);
    const principals = await ctx.db.query("managedPrincipals").withIndex("by_account_device", (q) => q.eq("accountId", args.accountId)).collect();
    for (const principal of principals) await ctx.db.delete(principal._id);
    const devices = await ctx.db.query("managedDevices").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    for (const device of devices) await ctx.db.delete(device._id);
    const account = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).unique();
    if (account) await ctx.db.delete(account._id);
    return { accountId: args.accountId, uploads: uploads.length, jobs: jobs.length, storageObjects };
  },
});

/**
 * Internal-only seed for an anonymous deployment canary. It is not part of
 * the public API and takes no caller-selected entitlement or quota. Production
 * verified-lineage adapters must replace this test seed.
 */
export const seedLocalCanary = internalMutation({
  args: { tokenIdentifier: v.string(), accountId: v.optional(v.string()), deviceId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const tokenIdentifier = args.tokenIdentifier.trim();
    if (!tokenIdentifier) throw new Error(`Local canary identity must be seeded by an internal test command (${AUTHORITY})`);
    const accountId = args.accountId?.trim() || `local-canary:${tokenIdentifier}`;
    const existing = await ctx.db.query("managedPrincipals").withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", tokenIdentifier)).unique();
    if (existing) return { accountId: existing.accountId, deviceId: existing.deviceId, keyId: existing.keyId };
    const now = Date.now();
    const periodLength = 30 * 24 * 60 * 60 * 1_000;
    const deviceId = args.deviceId?.trim() || `local-device:${tokenIdentifier}`;
    const keyId = `local-key:${tokenIdentifier}`;
    const existingAccount = await ctx.db.query("managedAccounts").withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    if (!existingAccount) {
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
    }
    const enrolled = await ctx.db.query("managedDevices").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    if (enrolled.length >= MAX_DEVICES) throw new Error(`Managed account has reached its three-device enrollment limit (${AUTHORITY})`);
    await ctx.db.insert("managedDevices", { accountId, deviceId, keyId, enrolledAt: now, revokedAt: null });
    await ctx.db.insert("managedPrincipals", {
      tokenIdentifier,
      accountId,
      deviceId,
      keyId,
      lineageVerified: true,
      entitlement: "active",
      revokedAt: null,
      naturalExpiryAt: null,
      enrolledAt: now,
    });
    await ctx.scheduler.runAfter(5 * 60 * 1_000, anyApi.managedTranscriptionActions.reconcileManagedState, {});
    return { accountId, deviceId, keyId, trialSeconds: TRIAL_SECONDS };
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
  if (!device || device.keyId !== principal.keyId || device.revokedAt !== null) throw new Error(`Internal managed device credential is revoked or not current (${AUTHORITY})`);
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
    await ctx.db.patch(job._id, { status: "expired", executionToken: null, failureReason: "managed six-hour lease expired" });
  }
}

async function settleCompletedProvider(
  ctx: MutationCtx,
  job: any,
  result: { text: string; ranges: readonly { startMs: number; endMs: number; text: string }[]; detectedLanguages: readonly string[] },
  now: number,
  executionToken: string,
): Promise<any> {
  if (job.status === "succeeded") return job;
  if (job.status !== "running") throw new Error(`Managed job is ${job.status}; provider result cannot be recorded (${AUTHORITY})`);
  if (job.executionToken !== executionToken) throw new Error(`Managed provider result token is stale (${AUTHORITY})`);
  await ctx.db.patch(job._id, {
    status: "provider_completed",
    providerCompletedAt: now,
    providerResult: {
      text: result.text,
      ranges: result.ranges.map((range) => ({ ...range })),
      detectedLanguages: [...result.detectedLanguages],
    },
    executionToken: null,
  });
  const completed = await ctx.db.get(job._id);
  if (!completed) throw new Error(`Managed provider job disappeared before settlement (${AUTHORITY})`);
  return settleProviderCompleted(ctx, completed, now);
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
  const stopped = await accountHasStop(ctx, accountId);
  for (const job of jobs.values()) await reconcileJob(ctx, job, now, stopped);
}

async function reconcileJob(ctx: MutationCtx, job: any, now: number, stopped: boolean): Promise<boolean> {
  if (job.status === "reserved" || job.status === "running") {
    if (!stopped && job.leaseExpiresAt > now && job.expiresAt > now) return false;
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
