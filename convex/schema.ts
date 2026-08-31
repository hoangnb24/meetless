import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const part = v.object({
  partNumber: v.number(),
  sampleOffset: v.number(),
  sampleCount: v.number(),
  byteLength: v.number(),
  sha256: v.string(),
});

const providerRange = v.object({
  startMs: v.number(),
  endMs: v.number(),
  text: v.string(),
});

const providerResult = v.object({
  text: v.string(),
  ranges: v.array(providerRange),
  detectedLanguages: v.array(v.string()),
});

export default defineSchema({
  /** Only a future verified-lineage adapter may create production principals. */
  managedPrincipals: defineTable({
    tokenIdentifier: v.string(),
    accountId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    lineageVerified: v.boolean(),
    entitlement: v.union(
      v.literal("active"),
      v.literal("grace"),
      v.literal("expired"),
      v.literal("refunded"),
      v.literal("revoked"),
    ),
    revokedAt: v.union(v.number(), v.null()),
    enrolledAt: v.number(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_account_device", ["accountId", "deviceId"]),

  managedDevices: defineTable({
    accountId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    enrolledAt: v.number(),
    revokedAt: v.union(v.number(), v.null()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_device", ["accountId", "deviceId"]),

  managedAccounts: defineTable({
    accountId: v.string(),
    currentPeriodStartAt: v.number(),
    currentPeriodEndAt: v.number(),
    nextPeriodLimitSeconds: v.number(),
    maxDevices: v.number(),
  }).index("by_account", ["accountId"]),

  /** Period rows snapshot the allowance; changing nextPeriodLimit is not retroactive. */
  managedPeriods: defineTable({
    accountId: v.string(),
    product: v.union(v.literal("monthly"), v.literal("annual"), v.literal("trial")),
    startAt: v.number(),
    endAt: v.number(),
    limitSeconds: v.number(),
    usedSeconds: v.number(),
    reservedSeconds: v.number(),
  })
    .index("by_account_start", ["accountId", "startAt"])
    .index("by_account", ["accountId"]),

  /** Upload metadata is private temporary state, never MeetingStore transcript truth. */
  managedUploads: defineTable({
    accountId: v.string(),
    deviceId: v.string(),
    uploadKey: v.string(),
    recordingId: v.string(),
    audioId: v.string(),
    manifestSha256: v.string(),
    contentSha256: v.string(),
    partsManifestSha256: v.string(),
    byteLength: v.number(),
    durationMs: v.number(),
    sampleCount: v.number(),
    parts: v.array(part),
    state: v.union(v.literal("uploading"), v.literal("sealed"), v.literal("cancelled"), v.literal("cleaned")),
    createdAt: v.number(),
    expiresAt: v.number(),
    jobId: v.union(v.id("managedJobs"), v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
  })
    .index("by_upload_key", ["accountId", "uploadKey"])
    .index("by_timeline", ["accountId", "recordingId", "audioId"])
    .index("by_expiry", ["expiresAt"]),

  managedUploadParts: defineTable({
    uploadId: v.id("managedUploads"),
    accountId: v.string(),
    partNumber: v.number(),
    sampleOffset: v.number(),
    sampleCount: v.number(),
    byteLength: v.number(),
    sha256: v.string(),
    storageId: v.id("_storage"),
  })
    .index("by_upload_part", ["uploadId", "partNumber"])
    .index("by_storage", ["storageId"]),

  managedJobs: defineTable({
    accountId: v.string(),
    deviceId: v.string(),
    uploadId: v.id("managedUploads"),
    timelineKey: v.string(),
    fingerprint: v.string(),
    recordingId: v.string(),
    audioId: v.string(),
    manifestSha256: v.string(),
    contentSha256: v.string(),
    sampleCount: v.number(),
    durationMs: v.number(),
    billableSeconds: v.number(),
    periodStartAt: v.number(),
    admissionId: v.string(),
    admissionNumber: v.number(),
    status: v.union(
      v.literal("reserved"),
      v.literal("running"),
      v.literal("provider_completed"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("expired"),
      v.literal("stopped"),
    ),
    createdAt: v.number(),
    leaseExpiresAt: v.number(),
    expiresAt: v.number(),
    providerCompletedAt: v.union(v.number(), v.null()),
    settledAt: v.union(v.number(), v.null()),
    failureReason: v.union(v.string(), v.null()),
    providerResult: v.union(providerResult, v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
    cleanupState: v.union(v.literal("pending"), v.literal("cleaned")),
  })
    .index("by_timeline", ["accountId", "timelineKey"])
    .index("by_upload", ["uploadId"])
    .index("by_expiry", ["expiresAt"]),

  managedCharges: defineTable({
    jobId: v.id("managedJobs"),
    accountId: v.string(),
    periodStartAt: v.number(),
    seconds: v.number(),
    chargedAt: v.number(),
  }).index("by_job", ["jobId"]),
});
