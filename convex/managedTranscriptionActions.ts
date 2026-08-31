"use node";

import { createHash } from "node:crypto";
import { action, internalAction } from "./_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import {
  AUTHORITY,
  MAX_PART_BYTES,
  canonicalWavHeader,
  parseCanonicalPart,
  partsDigestPayload,
  type TimelineManifest,
} from "./shared";

export const sealUpload = action({
  args: { sessionId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireActionIdentity(ctx);
    const data = await ctx.runQuery(anyApi.managedTranscription.readSealData, {
      sessionId: args.sessionId,
      tokenIdentifier,
    });
    const manifest = uploadToManifest(data.upload);
    if (data.job && (data.job.status === "provider_completed" || data.job.status === "succeeded")) return publicJob(data.job);
    const parts = [...data.parts].sort((left, right) => left.partNumber - right.partNumber);
    if (parts.length !== manifest.parts.length || parts.some((part, index) => part.partNumber !== index + 1)) {
      throw new Error(`Managed seal requires every physical part exactly once and in order (${AUTHORITY})`);
    }
    const contentHash = createHash("sha256");
    contentHash.update(Buffer.from(canonicalWavHeader(manifest.sampleCount)));
    let sampleCount = 0;
    let byteLength = 44;
    for (const stored of parts) {
      const expected = manifest.parts[stored.partNumber - 1];
      if (!expected || !sameDescriptor(expected, stored)) {
        throw new Error(`Managed stored part ${stored.partNumber} changed its immutable offset, length, or digest (${AUTHORITY})`);
      }
      const blob = await ctx.storage.get(stored.storageId);
      if (!blob) throw new Error(`Managed storage object is missing for part ${stored.partNumber} (${AUTHORITY})`);
      if (blob.size > MAX_PART_BYTES) throw new Error(`Managed storage Blob exceeds the accepted physical WAV part bound before materialization (${AUTHORITY})`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.byteLength !== stored.byteLength) throw new Error(`Managed stored part ${stored.partNumber} byte length does not match the manifest (${AUTHORITY})`);
      const partHash = createHash("sha256").update(bytes).digest("hex");
      if (partHash !== stored.sha256) throw new Error(`Managed stored part ${stored.partNumber} digest does not match the manifest (${AUTHORITY})`);
      const parsed = parseCanonicalPart(bytes);
      if (parsed.sampleCount !== stored.sampleCount) throw new Error(`Managed stored part ${stored.partNumber} PCM sample count does not match the manifest (${AUTHORITY})`);
      contentHash.update(Buffer.from(parsed.pcm));
      sampleCount += parsed.sampleCount;
      byteLength += bytes.byteLength - 44;
    }
    const contentSha256 = contentHash.digest("hex");
    const partsManifestSha256 = createHash("sha256").update(partsDigestPayload(manifest)).digest("hex");
    if (
      sampleCount !== manifest.sampleCount || byteLength !== manifest.byteLength ||
      contentSha256 !== manifest.contentSha256 || partsManifestSha256 !== manifest.partsManifestSha256
    ) throw new Error(`Managed seal rejected stored WAV metadata, sample count, or digest against the immutable manifest (${AUTHORITY})`);
    return await ctx.runMutation(anyApi.managedTranscription.admitSealedUpload, {
      sessionId: args.sessionId,
      tokenIdentifier,
      contentSha256,
      sampleCount,
      byteLength,
      durationMs: manifest.durationMs,
      partsManifestSha256,
      cancelGeneration: data.upload.cancelGeneration ?? 0,
    });
  },
});

/** The provider action is deliberately a replaceable local fake in this frontier. */
export const runProvider = action({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireActionIdentity(ctx);
    const data = await ctx.runQuery(anyApi.managedTranscription.readJobForAction, {
      jobId: args.jobId,
      tokenIdentifier,
    });
    if (data.job.status === "provider_completed" || data.job.status === "succeeded") return publicJob(data.job);
    let admissionId = data.job.admissionId;
    let executionToken: string | null = null;
    try {
      const claimed = await ctx.runMutation(anyApi.managedTranscription.claimProvider, {
        jobId: args.jobId,
        tokenIdentifier,
        admissionId,
      });
      admissionId = claimed.job.admissionId;
      if (!claimed.won) return publicJob(claimed.job);
      executionToken = claimed.job.executionToken;
      if (!executionToken) throw new Error(`Managed provider winner did not receive an execution token (${AUTHORITY})`);
      await ctx.runMutation(anyApi.managedTranscription.recordProviderInvocation, {
        jobId: args.jobId,
        tokenIdentifier,
        admissionId,
        executionToken,
      });
      // Read each storage object in manifest order. This is the provider
      // execution seam: a real backend action can replace this block without
      // changing admission, quota, manifest, or local publication state.
      const parts = [...data.parts].sort((left, right) => left.partNumber - right.partNumber);
      let sampleOffset = 0;
      for (const part of parts) {
        const blob = await ctx.storage.get(part.storageId);
        if (!blob) throw new Error(`Managed provider input disappeared before execution (${AUTHORITY})`);
        if (blob.size > MAX_PART_BYTES) throw new Error(`Managed provider input Blob exceeds the accepted physical WAV part bound (${AUTHORITY})`);
        const parsed = parseCanonicalPart(new Uint8Array(await blob.arrayBuffer()));
        if (part.sampleOffset !== sampleOffset || parsed.sampleCount !== part.sampleCount) {
          throw new Error(`Managed provider received non-contiguous physical chunks (${AUTHORITY})`);
        }
        sampleOffset += part.sampleCount;
      }
      const text = `Managed local provider transcript for ${claimed.job.recordingId}`;
      const result = {
        text,
        ranges: [{ startMs: 0, endMs: claimed.job.durationMs, text }],
        detectedLanguages: [],
      };
      return await ctx.runMutation(anyApi.managedTranscription.completeProvider, {
        jobId: args.jobId,
        tokenIdentifier,
        admissionId: claimed.job.admissionId,
        executionToken,
        result,
      });
    } catch (error) {
      // A failed action is not an exactly-once signal. Release the reservation
      // in a mutation when the admission is still current; a provider success
      // already committed by completeProvider remains idempotently terminal.
      // A rejected claim has no winner token and must not let a sibling clean
      // up the admitting device's reserved job.
      if (executionToken !== null) {
        await ctx.runMutation(anyApi.managedTranscription.failProvider, {
          jobId: args.jobId,
          tokenIdentifier,
          admissionId,
          executionToken,
          reason: error instanceof Error ? error.message : "managed provider action failed",
        }).catch(() => undefined);
      }
      throw error;
    }
  },
});

/**
 * Acknowledgement is durable before object deletion. Repeating this action is
 * safe if a process dies after one or more storage deletes.
 */
export const acknowledge = action({
  args: { jobId: v.id("managedJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireActionIdentity(ctx);
    const data = await ctx.runQuery(anyApi.managedTranscription.readJobForAction, {
      jobId: args.jobId,
      tokenIdentifier,
    });
    if (data.job.status !== "succeeded") throw new Error(`Managed local publication must be durable before acknowledgement (${AUTHORITY})`);
    if (data.job.cleanupState === "cleaned") return true;
    const acknowledged = await ctx.runMutation(anyApi.managedTranscription.markAcknowledged, {
      jobId: args.jobId,
      tokenIdentifier,
    });
    if (acknowledged.cleanupState === "cleaned") return true;
    for (const part of data.parts) await ctx.storage.delete(part.storageId);
    await ctx.runMutation(anyApi.managedTranscription.markCleaned, { jobId: args.jobId });
    return true;
  },
});

export const cleanupUpload = internalAction({
  args: { uploadId: v.id("managedUploads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await ctx.runMutation(anyApi.managedTranscription.reconcileManagedState, { limit: 100 });
    const data = await ctx.runQuery(anyApi.managedTranscription.readUploadForCleanup, { uploadId: args.uploadId });
    if (!data) return false;
    if (data.upload.state !== "cancelled" && data.upload.state !== "cleaned" && data.upload.expiresAt > Date.now()) return false;
    for (const part of data.parts) await ctx.storage.delete(part.storageId);
    await ctx.runMutation(anyApi.managedTranscription.markUploadCleaned, { uploadId: args.uploadId });
    return true;
  },
});

/** Scheduled reconciliation is intentionally at-least-once and delegates all
 * state transitions to an idempotent mutation. */
export const reconcileManagedState = internalAction({
  args: { accountId: v.optional(v.string()), now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(5 * 60 * 1_000, anyApi.managedTranscriptionActions.reconcileManagedState, {});
    return await ctx.runMutation(anyApi.managedTranscription.reconcileManagedState, {
      accountId: args.accountId,
      now: args.now,
      limit: args.limit,
    });
  },
});

export const reconcileExpired = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const tokenIdentifier = await requireActionIdentity(ctx);
    const identity = await ctx.runQuery(anyApi.managedTranscription.identityAccount, { tokenIdentifier });
    const uploads = await ctx.runQuery(anyApi.managedTranscription.expiredUploads, { accountId: identity.accountId, limit: 50 });
    for (const upload of uploads) {
      await ctx.runAction(anyApi.managedTranscriptionActions.cleanupUpload, { uploadId: upload._id });
    }
    return uploads.length;
  },
});

async function requireActionIdentity(ctx: { auth: { getUserIdentity(): Promise<{ tokenIdentifier: string } | null> } }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier) throw new Error(`Managed Convex action requires server-authenticated identity (${AUTHORITY})`);
  return identity.tokenIdentifier;
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

function publicJob(job: any): any {
  if (!job) return job;
  const { executionToken: _executionToken, ...safe } = job;
  return safe;
}

function sameDescriptor(left: { partNumber: number; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }, right: { partNumber: number; sampleOffset: number; sampleCount: number; byteLength: number; sha256: string }): boolean {
  return left.partNumber === right.partNumber && left.sampleOffset === right.sampleOffset && left.sampleCount === right.sampleCount && left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
