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
    keyVersion: v.string(),
    lineageVerified: v.boolean(),
    entitlement: v.union(
      v.literal("active"),
      v.literal("grace"),
      v.literal("expired"),
      v.literal("refunded"),
      v.literal("revoked"),
    ),
    revokedAt: v.union(v.number(), v.null()),
    naturalExpiryAt: v.optional(v.union(v.number(), v.null())),
    enrolledAt: v.number(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_account_device", ["accountId", "deviceId"]),

  managedDevices: defineTable({
    accountId: v.string(),
    deviceId: v.string(),
    keyId: v.string(),
    keyVersion: v.string(),
    publicKey: v.string(),
    enrolledAt: v.number(),
    lastActiveAt: v.optional(v.number()),
    revokedAt: v.union(v.number(), v.null()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_device", ["accountId", "deviceId"])
    .index("by_device_key", ["deviceId", "keyId"]),

  managedAccounts: defineTable({
    accountId: v.string(),
    currentPeriodStartAt: v.number(),
    currentPeriodEndAt: v.number(),
    nextPeriodLimitSeconds: v.number(),
    allowanceSource: v.string(),
    maxDevices: v.number(),
  }).index("by_account", ["accountId"]),

  /** Apple/App Store Server API is the authority for this normalized lineage projection. */
  managedLineages: defineTable({
    lineageKey: v.string(),
    accountId: v.string(),
    appId: v.string(),
    bundleId: v.string(),
    productId: v.string(),
    product: v.union(v.literal("monthly"), v.literal("annual"), v.literal("trial")),
    environment: v.union(v.literal("SANDBOX"), v.literal("PRODUCTION")),
    periodType: v.union(v.literal("normal"), v.literal("trial")),
    startedAt: v.number(),
    expiresAt: v.number(),
    currentState: v.union(
      v.literal("active"),
      v.literal("grace"),
      v.literal("expired"),
      v.literal("refunded"),
      v.literal("revoked"),
    ),
    verifiedAt: v.number(),
    adapter: v.union(v.literal("fixture"), v.literal("app-store-server-api")),
  })
    .index("by_lineage", ["lineageKey"])
    .index("by_account", ["accountId"]),

  /** One-use, short-lived possession challenges; the nonce is never reused. */
  managedDeviceChallenges: defineTable({
    challengeId: v.string(),
    purpose: v.union(v.literal("enrollment"), v.literal("refresh")),
    deviceId: v.string(),
    keyId: v.string(),
    keyVersion: v.string(),
    publicKey: v.string(),
    nonce: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.union(v.number(), v.null()),
  })
    .index("by_challenge", ["challengeId"])
    .index("by_device_key", ["deviceId", "keyId"]),

  /** Safe webhook receipt projection. Raw RevenueCat payloads are not stored. */
  managedRevenueCatEvents: defineTable({
    eventId: v.string(),
    lineageKey: v.string(),
    appId: v.string(),
    productId: v.string(),
    environment: v.union(v.literal("SANDBOX"), v.literal("PRODUCTION")),
    eventType: v.string(),
    eventTimestampMs: v.number(),
    receivedAt: v.number(),
    processedAt: v.union(v.number(), v.null()),
    reconciliationStatus: v.optional(v.union(
      v.literal("pending"),
      v.literal("reconciled"),
      v.literal("awaiting-apple-verification"),
    )),
  })
    .index("by_event", ["eventId"])
    .index("by_lineage", ["lineageKey"]),

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
    cancelGeneration: v.optional(v.number()),
    jobId: v.union(v.id("managedJobs"), v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
  })
    .index("by_upload_key", ["accountId", "uploadKey"])
    .index("by_timeline", ["accountId", "recordingId", "audioId"])
    .index("by_account", ["accountId"])
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
    executionToken: v.optional(v.union(v.string(), v.null())),
    executionAttempt: v.optional(v.number()),
    providerInvocationCount: v.optional(v.number()),
    providerCompletedAt: v.union(v.number(), v.null()),
    settledAt: v.union(v.number(), v.null()),
    failureReason: v.union(v.string(), v.null()),
    providerResult: v.union(providerResult, v.null()),
    acknowledgedAt: v.union(v.number(), v.null()),
    cleanupState: v.union(v.literal("pending"), v.literal("cleaned")),
  })
    .index("by_timeline", ["accountId", "timelineKey"])
    .index("by_upload", ["uploadId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_lease", ["leaseExpiresAt"])
    .index("by_account_recording", ["accountId", "recordingId"]),

  managedCharges: defineTable({
    jobId: v.id("managedJobs"),
    accountId: v.string(),
    periodStartAt: v.number(),
    seconds: v.number(),
    chargedAt: v.number(),
  }).index("by_job", ["jobId"]),
});
