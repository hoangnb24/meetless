const MONO_PCM_WAV_AUTHORITY = "docs/product/monetization.md; docs/decisions/0005-mac-app-store-and-revenuecat.md";

export const MANAGED_TRIAL_ALLOWANCE_SECONDS = 18_000;
export const MANAGED_TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MANAGED_JOB_LEASE_MS = 6 * 60 * 60 * 1_000;
export const MANAGED_TEMPORARY_DATA_TTL_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_MAX_DEVICES = 3;
export const MANAGED_SAMPLE_RATE = 16_000;
export const MANAGED_CHANNELS = 1;
export const MANAGED_BITS_PER_SAMPLE = 16;
/** Ten-minute physical transport/provider bound; it is not a job or quota bound. */
export const MANAGED_MAX_UPLOAD_PART_SAMPLES = MANAGED_SAMPLE_RATE * 10 * 60;

export interface ManagedUploadPartDescriptor {
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * The immutable edge manifest used by the local Convex adapter. Parts are
 * canonical WAVs containing adjacent slices of one logical PCM timeline.
 * This data-only contract is intentionally independent of Convex and storage.
 */
export interface ManagedLogicalTimelineManifest {
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly partsManifestSha256: string;
  readonly parts: readonly ManagedUploadPartDescriptor[];
}

export function validateManagedLogicalTimelineManifest(
  input: ManagedLogicalTimelineManifest,
): ManagedLogicalTimelineManifest {
  const recordingId = requireManifestText(input.recordingId, "recording id");
  const audioId = requireManifestText(input.audioId, "audio id");
  if (audioId !== `recording:${recordingId}`) {
    throw new ManagedTimelineIdentityError("Managed upload audio identity must be bound to its recording");
  }
  for (const [field, value] of [
    ["manifest SHA-256", input.manifestSha256],
    ["content SHA-256", input.contentSha256],
    ["parts manifest SHA-256", input.partsManifestSha256],
  ] as const) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
      throw new ManagedTimelineIdentityError(`Managed upload ${field} must be a lowercase SHA-256 identity`);
    }
  }
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount <= 0) {
    throw new ManagedTimelineIdentityError("Managed upload sample count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength !== 44 + input.sampleCount * 2) {
    throw new ManagedTimelineIdentityError("Managed upload byte length must match the canonical PCM sample count");
  }
  const durationMs = Math.max(1, Math.ceil(input.sampleCount / MANAGED_SAMPLE_RATE * 1_000));
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs !== durationMs) {
    throw new ManagedTimelineIdentityError("Managed upload duration must be derived from canonical PCM samples");
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    throw new ManagedTimelineIdentityError("Managed upload requires at least one physical part");
  }
  let expectedOffset = 0;
  for (const [index, part] of input.parts.entries()) {
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber !== index + 1) {
      throw new ManagedTimelineIdentityError("Managed upload parts must be numbered contiguously from one");
    }
    if (!Number.isSafeInteger(part.sampleOffset) || part.sampleOffset !== expectedOffset) {
      throw new ManagedTimelineIdentityError("Managed upload parts must have contiguous sample offsets");
    }
    if (!Number.isSafeInteger(part.sampleCount) || part.sampleCount <= 0 || part.sampleCount > MANAGED_MAX_UPLOAD_PART_SAMPLES) {
      throw new ManagedTimelineIdentityError("Managed upload parts must not exceed the ten-minute sample bound");
    }
    if (!Number.isSafeInteger(part.byteLength) || part.byteLength !== 44 + part.sampleCount * 2) {
      throw new ManagedTimelineIdentityError("Managed upload part byte length must match its sample count");
    }
    if (typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(part.sha256)) {
      throw new ManagedTimelineIdentityError("Managed upload part must carry a lowercase SHA-256 identity");
    }
    expectedOffset += part.sampleCount;
  }
  if (expectedOffset !== input.sampleCount) {
    throw new ManagedTimelineIdentityError("Managed upload parts must cover the logical timeline exactly once");
  }
  return {
    ...input,
    recordingId,
    audioId,
    manifestSha256: input.manifestSha256,
    contentSha256: input.contentSha256,
    partsManifestSha256: input.partsManifestSha256,
    parts: input.parts.map((part) => ({ ...part })),
  };
}

export const MANAGED_TRANSCRIPTION_MODES = ["managed", "ask", "byok"] as const;
export type ManagedTranscriptionMode = (typeof MANAGED_TRANSCRIPTION_MODES)[number];

export type ManagedSubscriptionProduct = "monthly" | "annual" | "trial";
export type ManagedEntitlementStatus = "active" | "grace" | "expired" | "refunded" | "revoked";
export type ManagedJobStatus =
  | "reserved"
  | "running"
  | "provider_completed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "stopped";

export interface ManagedDeviceCredential {
  readonly deviceId: string;
  readonly keyId: string;
}

export interface ManagedDevice {
  readonly deviceId: string;
  readonly installationId: string;
  readonly keyId: string;
  readonly enrolledAt: number;
  readonly revokedAt: number | null;
}

export interface VerifiedLineageReceipt {
  readonly token: string;
  readonly accountId: string;
  readonly lineageKey: string;
}

export interface ManagedPeriodSnapshot {
  readonly product: ManagedSubscriptionProduct;
  readonly startAt: number;
  readonly endAt: number;
  readonly limitSeconds: number;
  readonly usedSeconds: number;
  readonly reservedSeconds: number;
  readonly remainingSeconds: number;
}

export interface ManagedAccountSnapshot {
  readonly accountId: string;
  readonly entitlement: ManagedEntitlementStatus;
  readonly product: ManagedSubscriptionProduct;
  readonly devices: readonly ManagedDevice[];
  readonly period: ManagedPeriodSnapshot;
}

export interface CanonicalPcmWav {
  readonly byteLength: number;
  readonly dataByteLength: number;
  readonly sampleCount: number;
  readonly sampleRate: typeof MANAGED_SAMPLE_RATE;
  readonly channels: typeof MANAGED_CHANNELS;
  readonly bitsPerSample: typeof MANAGED_BITS_PER_SAMPLE;
  /** Exact duration derived from sample count, before whole-second billing. */
  readonly durationSeconds: number;
  /** Integer timeline used by the local transcript contract. */
  readonly durationMs: number;
  /** Whole seconds charged to the managed quota ledger. */
  readonly billableSeconds: number;
}

export interface ManagedAudioIdentity {
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly sampleCount: number;
  readonly durationSeconds: number;
  readonly durationMs: number;
  readonly billableSeconds: number;
}

export interface ManagedProviderResult {
  readonly text: string;
  readonly detectedLanguages?: readonly string[];
}

export interface ManagedJob {
  readonly jobId: string;
  /** Changes whenever expired/failed work receives a fresh admission. */
  readonly admissionId: string;
  readonly admissionNumber: number;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly audio: ManagedAudioIdentity;
  readonly chunkId: string;
  readonly status: ManagedJobStatus;
  readonly createdAt: number;
  readonly leaseExpiresAt: number;
  readonly expiresAt: number;
  readonly providerCompletedAt: number | null;
  readonly settledAt: number | null;
  readonly failureReason: string | null;
  readonly providerResult: ManagedProviderResult | null;
}

export interface ManagedLedgerCharge {
  readonly jobId: string;
  readonly accountId: string;
  readonly periodStartAt: number;
  readonly seconds: number;
  readonly chargedAt: number;
}

export interface ManagedTemporaryArtifacts {
  readonly uploadIds: readonly string[];
  readonly resultJobIds: readonly string[];
  readonly orphanUploadIds: readonly string[];
}

export interface ManagedAccessDecision {
  readonly allowed: boolean;
  readonly requiresPremium: boolean;
  readonly chargesManagedQuota: boolean;
}

export type ManagedReservationOutcome = "reserved" | "duplicate";

export interface ManagedReservation {
  readonly outcome: ManagedReservationOutcome;
  readonly job: ManagedJob;
}

interface LineageState {
  readonly token: string;
  readonly lineageKey: string;
  readonly accountId: string;
  readonly startedAt: number;
  readonly naturalExpiryAt: number | null;
  product: ManagedSubscriptionProduct;
  nextProduct: ManagedSubscriptionProduct | null;
  entitlementOverride: "active" | "grace" | "refunded" | "revoked";
  readonly devices: Map<string, ManagedDeviceState>;
  readonly periods: Map<number, PeriodState>;
}

interface ManagedDeviceState extends ManagedDevice {
  readonly token: string;
}

interface PeriodState {
  readonly product: ManagedSubscriptionProduct;
  readonly startAt: number;
  readonly endAt: number;
  readonly limitSeconds: number;
  usedSeconds: number;
  reservedSeconds: number;
}

interface JobState extends Omit<ManagedJob, "admissionId" | "admissionNumber" | "deviceId" | "status" | "createdAt" | "leaseExpiresAt" | "expiresAt" | "providerCompletedAt" | "settledAt" | "failureReason" | "providerResult"> {
  admissionId: string;
  admissionNumber: number;
  deviceId: string;
  createdAt: number;
  leaseExpiresAt: number;
  expiresAt: number;
  periodStartAt: number;
  readonly timelineKey: string;
  readonly timelineFingerprint: string;
  status: ManagedJobStatus;
  providerCompletedAt: number | null;
  settledAt: number | null;
  failureReason: string | null;
  providerResult: ManagedProviderResult | null;
}

interface UploadState {
  readonly uploadId: string;
  readonly jobId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface OrphanUploadState {
  readonly uploadId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class ManagedTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedTranscriptionError";
  }
}

export class IdentityAuthorizationError extends ManagedTranscriptionError {
  constructor() {
    super(
      `Managed transcription requires server-verified subscription lineage and device-key possession ` +
      `(${MONO_PCM_WAV_AUTHORITY}). App User ID or client-selected subscriber ID is not authorization proof.`,
    );
    this.name = "IdentityAuthorizationError";
  }
}

export class DeviceLimitError extends ManagedTranscriptionError {
  constructor() {
    super(
      `A verified subscription may enroll at most ${MANAGED_MAX_DEVICES} Macs ` +
      `(${MONO_PCM_WAV_AUTHORITY}). Revoke an enrolled Mac before adding another.`,
    );
    this.name = "DeviceLimitError";
  }
}

export class DeviceCredentialError extends ManagedTranscriptionError {
  constructor(message = "The managed device credential is invalid or revoked") {
    super(`${message} (${MONO_PCM_WAV_AUTHORITY}). Re-enroll or restore this Mac with verified lineage.`);
    this.name = "DeviceCredentialError";
  }
}

export class QuotaExceededError extends ManagedTranscriptionError {
  constructor(requestedSeconds: number, remainingSeconds: number) {
    super(
      `Managed transcription needs ${requestedSeconds} seconds but only ${remainingSeconds} remain in the frozen quota period ` +
      `(${MONO_PCM_WAV_AUTHORITY}). Start a new period or use Ask/BYOK.`,
    );
    this.name = "QuotaExceededError";
  }
}

export class MalformedPcmWavError extends ManagedTranscriptionError {
  constructor(reason: string) {
    super(`Managed audio rejected: ${reason} (${MONO_PCM_WAV_AUTHORITY}). Provide one 16 kHz mono PCM WAV timeline.`);
    this.name = "MalformedPcmWavError";
  }
}

export class DurationClaimMismatchError extends ManagedTranscriptionError {
  constructor(claimedSeconds: number, serverSeconds: number) {
    super(
      `Client duration claim ${claimedSeconds} seconds conflicts with server sample-count duration ${serverSeconds} seconds ` +
      `(${MONO_PCM_WAV_AUTHORITY}). Use the validated WAV timeline.`,
    );
    this.name = "DurationClaimMismatchError";
  }
}

export class IdempotencyConflictError extends ManagedTranscriptionError {
  constructor() {
    super(
      `Managed transcription reused a canonical timeline identity with different bytes, manifest, or overlapping source window ` +
      `(${MONO_PCM_WAV_AUTHORITY}). Reuse the validated meeting timeline for retries.`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class ManagedTimelineIdentityError extends ManagedTranscriptionError {
  constructor(message: string) {
    super(`${message} (${MONO_PCM_WAV_AUTHORITY}). Rebuild the canonical timeline at the trusted edge.`);
    this.name = "ManagedTimelineIdentityError";
  }
}

export class ManagedJobStateError extends ManagedTranscriptionError {
  constructor(message: string) {
    super(`${message} (${MONO_PCM_WAV_AUTHORITY}). Inspect the persisted job state before retrying.`);
    this.name = "ManagedJobStateError";
  }
}

export interface ManagedTranscriptionPolicyOptions {
  now?: () => number;
  createDeviceId?: (installationId: string) => string;
  createJobId?: () => string;
  createAdmissionId?: () => string;
  allowance?: Partial<ManagedAllowanceConfiguration>;
  snapshot?: ManagedTranscriptionSnapshot;
}

export interface ManagedAllowanceConfiguration {
  readonly monthlySeconds: number;
  readonly trialSeconds: number;
}

export interface ManagedTimelineEvidence {
  /** Recording identity is part of the key: identical bytes from two meetings are distinct. */
  readonly recordingId: string;
  /** One canonical meeting timeline, never a microphone/system source identity. */
  readonly audioId: string;
  /** SHA-256 of the validated chunk manifest computed at the trusted edge. */
  readonly manifestSha256: string;
  /** SHA-256 of the exact canonical WAV bytes computed at the trusted edge. */
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface ManagedJobSnapshot extends ManagedJob {
  readonly periodStartAt: number;
  readonly timelineKey: string;
  readonly timelineFingerprint: string;
}

export interface ManagedTranscriptionSnapshot {
  readonly version: 1;
  readonly allowance: ManagedAllowanceConfiguration;
  readonly lineages: ReadonlyArray<{
    readonly token: string;
    readonly lineageKey: string;
    readonly accountId: string;
    readonly startedAt: number;
    readonly naturalExpiryAt: number | null;
    readonly product: ManagedSubscriptionProduct;
    readonly nextProduct: ManagedSubscriptionProduct | null;
    readonly entitlementOverride: "active" | "grace" | "refunded" | "revoked";
    readonly devices: readonly ManagedDevice[];
    readonly periods: readonly ManagedPeriodSnapshot[];
  }>;
  readonly jobs: readonly ManagedJobSnapshot[];
  readonly uploads: readonly UploadSnapshot[];
  readonly orphans: readonly OrphanUploadSnapshot[];
  readonly ledgerCharges: readonly ManagedLedgerCharge[];
  readonly nextDeviceSequence: number;
  readonly nextJobSequence: number;
  readonly nextAdmissionSequence: number;
}

export interface UploadSnapshot {
  readonly uploadId: string;
  readonly jobId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface OrphanUploadSnapshot {
  readonly uploadId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SeedVerifiedLineageInput {
  readonly lineageKey: string;
  readonly product: ManagedSubscriptionProduct;
  readonly startedAt: number;
  readonly naturalExpiryAt?: number | null;
  readonly entitlement?: "active" | "grace";
}

export interface EnrollDeviceInput {
  readonly verifiedLineageToken?: string;
  readonly installationId: string;
  readonly deviceKeyId: string;
  readonly appUserId?: string;
  readonly clientSubscriberId?: string;
}

export interface EnrolledDevice {
  readonly accountId: string;
  readonly device: ManagedDevice;
  readonly credential: ManagedDeviceCredential;
  readonly restored: boolean;
}

export interface ReserveManagedJobInput {
  readonly credential: ManagedDeviceCredential;
  /** Identity evidence produced after the edge validates the recording manifest and WAV bytes. */
  readonly timeline: ManagedTimelineEvidence;
  /** Stable upload chunk identity used to make retries idempotent. */
  readonly chunkId: string;
  readonly wav: Uint8Array;
  readonly claimedDurationSeconds?: number;
}

export interface ManagedPolicyClock {
  now(): number;
}

/**
 * Fake-backed policy owner for the managed-transcription foundation.
 *
 * Fake-backed policy owner for the managed-transcription contract. The policy
 * owns transitions over ordinary data only. `snapshot()` and the constructor's
 * `snapshot` option are the fake durable-state boundary used to rehearse a
 * process restart without claiming a production database or Convex latency.
 */
export class ManagedTranscriptionPolicy {
  private readonly now: () => number;
  private readonly createDeviceId: (installationId: string) => string;
  private readonly createJobId: () => string;
  private readonly createAdmissionId: () => string;
  private allowance: ManagedAllowanceConfiguration;
  private readonly lineages = new Map<string, LineageState>();
  private readonly jobs = new Map<string, JobState>();
  private readonly jobsByIdempotency = new Map<string, JobState>();
  private readonly jobsByTimeline = new Map<string, JobState>();
  private readonly uploads = new Map<string, UploadState>();
  private readonly orphans = new Map<string, OrphanUploadState>();
  private readonly ledgerCharges: ManagedLedgerCharge[] = [];
  private deviceSequence = 0;
  private jobSequence = 0;
  private admissionSequence = 0;

  constructor(options: ManagedTranscriptionPolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const monthlySeconds = options.allowance?.monthlySeconds ?? options.snapshot?.allowance.monthlySeconds;
    if (monthlySeconds === undefined) {
      throw new ManagedTranscriptionError("Managed monthly allowance requires explicit deployment/test configuration; no production fallback exists");
    }
    this.allowance = checkedAllowance({
      monthlySeconds,
      trialSeconds: options.allowance?.trialSeconds ?? options.snapshot?.allowance.trialSeconds ?? MANAGED_TRIAL_ALLOWANCE_SECONDS,
    });
    this.createDeviceId = options.createDeviceId ?? (() => `managed-device-${++this.deviceSequence}`);
    this.createJobId = options.createJobId ?? (() => `managed-job-${++this.jobSequence}`);
    this.createAdmissionId = options.createAdmissionId ?? (() => `managed-admission-${++this.admissionSequence}`);
    if (options.snapshot) this.restoreSnapshot(options.snapshot);
  }

  static fromSnapshot(
    snapshot: ManagedTranscriptionSnapshot,
    options: Omit<ManagedTranscriptionPolicyOptions, "snapshot" | "allowance"> = {},
  ): ManagedTranscriptionPolicy {
    return new ManagedTranscriptionPolicy({ ...options, snapshot });
  }

  setAllowanceConfiguration(input: ManagedAllowanceConfiguration): void {
    this.allowance = checkedAllowance(input);
  }

  snapshot(): ManagedTranscriptionSnapshot {
    return {
      version: 1,
      allowance: { ...this.allowance },
      lineages: [...this.lineages.values()].map((lineage) => ({
        token: lineage.token,
        lineageKey: lineage.lineageKey,
        accountId: lineage.accountId,
        startedAt: lineage.startedAt,
        naturalExpiryAt: lineage.naturalExpiryAt,
        product: lineage.product,
        nextProduct: lineage.nextProduct,
        entitlementOverride: lineage.entitlementOverride,
        devices: [...lineage.devices.values()].map(publicDevice),
        periods: [...lineage.periods.values()].map(publicPeriod),
      })),
      jobs: [...this.jobs.values()].map((job) => ({
        ...publicJob(job),
        periodStartAt: job.periodStartAt,
        timelineKey: job.timelineKey,
        timelineFingerprint: job.timelineFingerprint,
      })),
      uploads: [...this.uploads.values()].map((upload) => ({ ...upload })),
      orphans: [...this.orphans.values()].map((orphan) => ({ ...orphan })),
      ledgerCharges: this.ledgerCharges.map((charge) => ({ ...charge })),
      nextDeviceSequence: this.deviceSequence,
      nextJobSequence: this.jobSequence,
      nextAdmissionSequence: this.admissionSequence,
    };
  }

  private restoreSnapshot(snapshot: ManagedTranscriptionSnapshot): void {
    if (!snapshot || snapshot.version !== 1) throw new ManagedTranscriptionError("Managed policy snapshot version is unsupported");
    this.allowance = checkedAllowance(snapshot.allowance);
    this.deviceSequence = checkedSequence(snapshot.nextDeviceSequence, "device sequence");
    this.jobSequence = checkedSequence(snapshot.nextJobSequence, "job sequence");
    this.admissionSequence = checkedSequence(snapshot.nextAdmissionSequence, "admission sequence");

    for (const saved of snapshot.lineages) {
      const lineageKey = requireText(saved.lineageKey, "lineage key");
      if (this.lineages.has(lineageKey)) throw new ManagedTranscriptionError(`Duplicate managed lineage in snapshot: ${lineageKey}`);
      const token = requireText(saved.token, "lineage token");
      const devices = new Map<string, ManagedDeviceState>();
      for (const savedDevice of saved.devices) {
        const deviceId = requireText(savedDevice.deviceId, "device id");
        if (devices.has(deviceId)) throw new ManagedTranscriptionError(`Duplicate managed device in snapshot: ${deviceId}`);
        devices.set(deviceId, { ...savedDevice, token });
      }
      const periods = new Map<number, PeriodState>();
      for (const savedPeriod of saved.periods) {
        if (periods.has(savedPeriod.startAt)) throw new ManagedTranscriptionError(`Duplicate managed period in snapshot: ${savedPeriod.startAt}`);
        periods.set(savedPeriod.startAt, {
          product: requireProduct(savedPeriod.product),
          startAt: requireInstant(savedPeriod.startAt, "period start"),
          endAt: requireInstant(savedPeriod.endAt, "period end"),
          limitSeconds: checkedSeconds(savedPeriod.limitSeconds, "period allowance"),
          usedSeconds: checkedNonNegativeSeconds(savedPeriod.usedSeconds, "period usage"),
          reservedSeconds: checkedNonNegativeSeconds(savedPeriod.reservedSeconds, "period reservation"),
        });
      }
      if (periods.size === 0) throw new ManagedTranscriptionError(`Managed lineage has no quota period: ${lineageKey}`);
      this.lineages.set(lineageKey, {
        token,
        lineageKey,
        accountId: requireText(saved.accountId, "account id"),
        startedAt: requireInstant(saved.startedAt, "lineage start"),
        naturalExpiryAt: saved.naturalExpiryAt === null ? null : requireInstant(saved.naturalExpiryAt, "lineage expiry"),
        product: requireProduct(saved.product),
        nextProduct: saved.nextProduct === null ? null : requireProduct(saved.nextProduct),
        entitlementOverride: saved.entitlementOverride,
        devices,
        periods,
      });
    }

    for (const saved of snapshot.jobs) {
      const timeline = checkedTimeline(saved.audio, saved.audio.byteLength);
      const expectedTimelineKey = makeTimelineKey(saved.accountId, timeline);
      const expectedIdempotencyKey = makeIdempotencyKey(saved.accountId, timeline, saved.chunkId);
      if (
        saved.timelineKey !== expectedTimelineKey ||
        saved.timelineFingerprint !== timelineFingerprint(timeline) ||
        saved.idempotencyKey !== expectedIdempotencyKey
      ) {
        throw new ManagedTranscriptionError(`Managed job identity is inconsistent in snapshot: ${saved.jobId}`);
      }
      if (this.jobs.has(saved.jobId) || this.jobsByIdempotency.has(saved.idempotencyKey)) {
        throw new ManagedTranscriptionError(`Duplicate managed job in snapshot: ${saved.jobId}`);
      }
      const job: JobState = {
        jobId: requireText(saved.jobId, "job id"),
        admissionId: requireText(saved.admissionId, "admission id"),
        admissionNumber: checkedSequence(saved.admissionNumber, "admission number"),
        idempotencyKey: saved.idempotencyKey,
        accountId: requireText(saved.accountId, "account id"),
        deviceId: requireText(saved.deviceId, "device id"),
        audio: {
          ...timeline,
          sampleCount: checkedNonNegativeInteger(saved.audio.sampleCount, "sample count"),
          durationSeconds: saved.audio.durationSeconds,
          durationMs: checkedPositiveInteger(saved.audio.durationMs, "duration"),
          billableSeconds: checkedPositiveInteger(saved.audio.billableSeconds, "billable duration"),
        },
        chunkId: requireText(saved.chunkId, "chunk id"),
        status: saved.status,
        createdAt: requireInstant(saved.createdAt, "job creation"),
        leaseExpiresAt: requireInstant(saved.leaseExpiresAt, "job lease expiry"),
        expiresAt: requireInstant(saved.expiresAt, "job TTL expiry"),
        providerCompletedAt: saved.providerCompletedAt === null ? null : requireInstant(saved.providerCompletedAt, "provider completion"),
        settledAt: saved.settledAt === null ? null : requireInstant(saved.settledAt, "job settlement"),
        failureReason: saved.failureReason === null ? null : requireText(saved.failureReason, "failure reason"),
        providerResult: saved.providerResult === null ? null : {
          text: requireText(saved.providerResult.text, "provider result text"),
          detectedLanguages: [...(saved.providerResult.detectedLanguages ?? [])],
        },
        periodStartAt: requireInstant(saved.periodStartAt, "job quota period"),
        timelineKey: saved.timelineKey,
        timelineFingerprint: saved.timelineFingerprint,
      };
      this.jobs.set(job.jobId, job);
      this.jobsByIdempotency.set(job.idempotencyKey, job);
      const existingTimeline = this.jobsByTimeline.get(job.timelineKey);
      if (existingTimeline && existingTimeline.jobId !== job.jobId) {
        throw new ManagedTranscriptionError(`Duplicate managed timeline in snapshot: ${job.timelineKey}`);
      }
      this.jobsByTimeline.set(job.timelineKey, job);
    }
    for (const upload of snapshot.uploads) this.uploads.set(requireText(upload.uploadId, "upload id"), { ...upload });
    for (const orphan of snapshot.orphans) this.orphans.set(requireText(orphan.uploadId, "orphan upload id"), { ...orphan });
    for (const charge of snapshot.ledgerCharges) {
      if (this.ledgerCharges.some((existing) => existing.jobId === charge.jobId)) {
        throw new ManagedTranscriptionError(`Duplicate managed ledger charge in snapshot: ${charge.jobId}`);
      }
      this.ledgerCharges.push({ ...charge });
    }
  }

  /**
   * Test/fake authority boundary. A real adapter would call this policy only
   * after server-side StoreKit/App Store subscription verification.
   */
  seedVerifiedSubscriptionLineage(input: SeedVerifiedLineageInput): VerifiedLineageReceipt {
    const lineageKey = requireText(input.lineageKey, "lineage key");
    const startedAt = requireInstant(input.startedAt, "lineage start");
    const current = this.lineages.get(lineageKey);
    if (current) return { token: current.token, accountId: current.accountId, lineageKey };
    if (startedAt > this.now()) throw new ManagedTranscriptionError("Verified subscription lineage cannot start in the future");
    const product = requireProduct(input.product);
    const token = `verified-lineage:${lineageKey}`;
    const accountId = `quota-account:${lineageKey}`;
    const naturalExpiryAt = input.naturalExpiryAt === undefined
      ? product === "trial" ? startedAt + MANAGED_TRIAL_DURATION_MS : null
      : input.naturalExpiryAt;
    if (naturalExpiryAt !== null && naturalExpiryAt !== undefined && naturalExpiryAt <= startedAt) {
      throw new ManagedTranscriptionError("Verified subscription lineage expiry must follow its start");
    }
    const initialPeriod = makePeriod(product, startedAt, this.allowance);
    const lineage: LineageState = {
      token,
      lineageKey,
      accountId,
      startedAt,
      naturalExpiryAt: naturalExpiryAt ?? null,
      product,
      nextProduct: null,
      entitlementOverride: input.entitlement ?? "active",
      devices: new Map(),
      periods: new Map([[initialPeriod.startAt, initialPeriod]]),
    };
    this.lineages.set(lineageKey, lineage);
    return { token, accountId, lineageKey };
  }

  enrollDevice(input: EnrollDeviceInput): EnrolledDevice {
    return this.enroll(input, false);
  }

  restoreDevice(input: EnrollDeviceInput): EnrolledDevice {
    return this.enroll(input, true);
  }

  revokeDevice(input: { verifiedLineageToken: string; deviceId: string }): void {
    const lineage = this.requireLineage(input.verifiedLineageToken);
    const device = lineage.devices.get(requireText(input.deviceId, "device id"));
    if (!device) throw new DeviceCredentialError("The device does not belong to this verified subscription");
    if (device.revokedAt !== null) return;
    const revokedAt = this.now();
    const revoked = { ...device, revokedAt };
    lineage.devices.set(device.deviceId, revoked);
    for (const job of this.jobs.values()) {
      if (job.deviceId === device.deviceId && job.accountId === lineage.accountId) this.stopIfInFlight(job, "device revoked");
    }
  }

  setEntitlement(
    verifiedLineageToken: string,
    status: "active" | "grace" | "refunded" | "revoked",
  ): void {
    const lineage = this.requireLineage(verifiedLineageToken);
    lineage.entitlementOverride = status;
    if (status === "refunded" || status === "revoked") {
      for (const job of this.jobs.values()) {
        if (job.accountId === lineage.accountId) this.stopIfInFlight(job, status);
      }
    }
  }

  changeProduct(verifiedLineageToken: string, product: ManagedSubscriptionProduct): void {
    const lineage = this.requireLineage(verifiedLineageToken);
    lineage.nextProduct = requireProduct(product);
  }

  accountSnapshot(credential: ManagedDeviceCredential): ManagedAccountSnapshot {
    const { lineage } = this.resolveCredential(credential, true);
    this.advancePeriods(lineage, this.now());
    const period = this.currentPeriod(lineage);
    return {
      accountId: lineage.accountId,
      entitlement: this.entitlement(lineage, this.now()),
      product: period.product,
      devices: [...lineage.devices.values()].map((device) => publicDevice(device)),
      period: publicPeriod(period),
    };
  }

  accessFor(mode: ManagedTranscriptionMode): ManagedAccessDecision {
    if (mode === "managed") return { allowed: false, requiresPremium: true, chargesManagedQuota: true };
    return { allowed: true, requiresPremium: false, chargesManagedQuota: false };
  }

  reserve(input: ReserveManagedJobInput): ManagedReservation {
    const { lineage, device } = this.resolveCredential(input.credential, false);
    const now = this.now();
    this.advancePeriods(lineage, now);
    // Admission is the recovery boundary: a caller may return after the
    // previous six-hour lease without first observing the expired state.
    // Reconcile before idempotency lookup so that the same timeline can only
    // restart through reAdmit(), with a fresh lease and fresh quota reserve.
    this.reconcileLeases(now);
    const timeline = checkedTimeline(input.timeline, input.wav.byteLength);
    const chunkId = requireText(input.chunkId, "chunk id");
    const canonical = parseCanonicalPcmWav(input.wav);
    if (input.claimedDurationSeconds !== undefined) {
      const claimed = input.claimedDurationSeconds;
      if (!Number.isFinite(claimed) || claimed < 0 || claimed !== canonical.durationSeconds) {
        throw new DurationClaimMismatchError(claimed, canonical.durationSeconds);
      }
    }
    if (timeline.endMs - timeline.startMs !== canonical.durationMs) {
      throw new ManagedTimelineIdentityError("Canonical timeline window does not match PCM sample duration");
    }
    const idempotencyKey = `${lineage.accountId}\u0000${timeline.recordingId}\u0000${timeline.audioId}\u0000${chunkId}`;
    const timelineKey = `${lineage.accountId}\u0000${timeline.recordingId}\u0000${timeline.audioId}`;
    const fingerprint = timelineFingerprint(timeline);
    const existing = this.jobsByIdempotency.get(idempotencyKey);
    if (existing) {
      if (existing.timelineFingerprint !== fingerprint) throw new IdempotencyConflictError();
      if (existing.status === "expired") {
        return { outcome: "reserved", job: publicJob(this.reAdmit(existing, lineage, device, this.now())) };
      }
      return { outcome: "duplicate", job: publicJob(existing) };
    }
    const existingTimeline = this.jobsByTimeline.get(timelineKey);
    if (existingTimeline) {
      if (existingTimeline.timelineFingerprint !== fingerprint) throw new IdempotencyConflictError();
      if (existingTimeline.status === "expired") {
        return { outcome: "reserved", job: publicJob(this.reAdmit(existingTimeline, lineage, device, this.now())) };
      }
      return { outcome: "duplicate", job: publicJob(existingTimeline) };
    }
    for (const candidate of this.jobs.values()) {
      if (
        candidate.accountId === lineage.accountId &&
        candidate.audio.recordingId === timeline.recordingId &&
        candidate.timelineKey !== timelineKey &&
        rangesOverlap(candidate.audio.startMs, candidate.audio.endMs, timeline.startMs, timeline.endMs)
      ) {
        throw new IdempotencyConflictError();
      }
    }
    const entitlement = this.entitlement(lineage, this.now());
    if (entitlement !== "active" && entitlement !== "grace") {
      throw new ManagedTranscriptionError(
        `Managed transcription requires active Premium entitlement; current state is ${entitlement} ` +
        `(${MONO_PCM_WAV_AUTHORITY}). Ask and BYOK remain available.`,
      );
    }
    const period = this.currentPeriod(lineage);
    if (period.limitSeconds - period.usedSeconds - period.reservedSeconds < canonical.billableSeconds) {
      throw new QuotaExceededError(
        canonical.billableSeconds,
        Math.max(0, period.limitSeconds - period.usedSeconds - period.reservedSeconds),
      );
    }
    const createdAt = this.now();
    const jobId = this.createJobId();
    const job: JobState = {
      jobId,
      admissionId: this.createAdmissionId(),
      admissionNumber: 1,
      idempotencyKey,
      accountId: lineage.accountId,
      deviceId: device.deviceId,
      audio: {
        recordingId: timeline.recordingId,
        audioId: timeline.audioId,
        manifestSha256: timeline.manifestSha256,
        contentSha256: timeline.contentSha256,
        byteLength: timeline.byteLength,
        startMs: timeline.startMs,
        endMs: timeline.endMs,
        sampleCount: canonical.sampleCount,
        durationSeconds: canonical.durationSeconds,
        durationMs: canonical.durationMs,
        billableSeconds: canonical.billableSeconds,
      },
      chunkId,
      status: "reserved",
      createdAt,
      leaseExpiresAt: createdAt + MANAGED_JOB_LEASE_MS,
      expiresAt: createdAt + MANAGED_TEMPORARY_DATA_TTL_MS,
      providerCompletedAt: null,
      settledAt: null,
      failureReason: null,
      providerResult: null,
      periodStartAt: period.startAt,
      timelineKey,
      timelineFingerprint: fingerprint,
    };
    period.reservedSeconds += canonical.billableSeconds;
    this.jobs.set(jobId, job);
    this.jobsByIdempotency.set(idempotencyKey, job);
    this.jobsByTimeline.set(timelineKey, job);
    this.uploads.set(jobId, {
      uploadId: jobId,
      jobId,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
    });
    return { outcome: "reserved", job: publicJob(job) };
  }

  startProvider(jobId: string, admissionId: string): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    this.requireAdmission(job, admissionId);
    if (job.status === "reserved") {
      job.status = "running";
      return publicJob(job);
    }
    if (job.status === "running" || job.status === "provider_completed" || job.status === "succeeded") {
      if (job.status === "running") throw new ManagedJobStateError("Managed provider execution is already claimed for this job");
      return publicJob(job);
    }
    throw new ManagedJobStateError(`Managed job ${jobId} is ${job.status} and cannot start provider work`);
  }

  recordProviderSuccess(jobId: string, admissionId: string, result: ManagedProviderResult): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    this.requireAdmission(job, admissionId);
    if (job.status === "provider_completed" || job.status === "succeeded") return publicJob(job);
    if (job.status !== "running") throw new ManagedJobStateError(`Managed job ${jobId} is not running`);
    const text = requireText(result.text, "provider result text");
    const completedAt = this.now();
    job.status = "provider_completed";
    job.providerCompletedAt = completedAt;
    job.providerResult = {
      text,
      detectedLanguages: [...new Set((result.detectedLanguages ?? []).map((language) => language.trim()).filter(Boolean))].sort(),
    };
    this.uploads.delete(job.jobId);
    return publicJob(job);
  }

  settleJob(jobId: string): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    if (job.status === "succeeded") return publicJob(job);
    if (job.status !== "provider_completed") {
      throw new ManagedJobStateError(`Managed job ${jobId} is ${job.status}; only provider-completed work can settle`);
    }
    const lineage = this.lineageForAccount(job.accountId);
    const period = lineage.periods.get(job.periodStartAt);
    if (!period) throw new ManagedJobStateError(`Managed job ${jobId} lost its reserved quota period`);
    period.reservedSeconds -= job.audio.billableSeconds;
    period.usedSeconds += job.audio.billableSeconds;
    const settledAt = this.now();
    job.status = "succeeded";
    job.settledAt = settledAt;
    this.ledgerCharges.push({
      jobId: job.jobId,
      accountId: job.accountId,
      periodStartAt: period.startAt,
      seconds: job.audio.billableSeconds,
      chargedAt: settledAt,
    });
    return publicJob(job);
  }

  failJob(jobId: string, reason = "provider failed"): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    if (job.status === "failed") return publicJob(job);
    if (job.status === "provider_completed" || job.status === "succeeded") return this.settleJob(jobId);
    if (job.status !== "reserved" && job.status !== "running") {
      throw new ManagedJobStateError(`Managed job ${jobId} is ${job.status}; it cannot fail`);
    }
    this.releaseReservation(job);
    job.status = "failed";
    job.failureReason = requireText(reason, "failure reason");
    return publicJob(job);
  }

  retryJob(jobId: string): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    if (job.status !== "failed") {
      throw new ManagedJobStateError(`Managed job ${jobId} is ${job.status}; only failed work can retry`);
    }
    const lineage = this.lineageForAccount(job.accountId);
    const device = lineage.devices.get(job.deviceId);
    if (!device || device.revokedAt !== null) throw new DeviceCredentialError();
    return publicJob(this.reAdmit(job, lineage, device, this.now()));
  }

  cancelJob(jobId: string): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
    if (job.status === "cancelled") return publicJob(job);
    if (job.status === "provider_completed" || job.status === "succeeded") return this.settleJob(jobId);
    if (job.status !== "reserved" && job.status !== "running") {
      throw new ManagedJobStateError(`Managed job ${jobId} is ${job.status}; it cannot cancel`);
    }
    this.releaseReservation(job);
    this.uploads.delete(job.jobId);
    job.status = "cancelled";
    return publicJob(job);
  }

  acknowledgePublication(jobId: string): ManagedJob {
    const job = this.requireJob(jobId);
    if (job.status !== "succeeded") throw new ManagedJobStateError("Only a settled managed result can be acknowledged");
    this.uploads.delete(job.jobId);
    job.providerResult = null;
    return publicJob(job);
  }

  job(jobId: string): ManagedJob {
    this.reconcileLeases(this.now());
    return publicJob(this.requireJob(jobId));
  }

  ledger(): readonly ManagedLedgerCharge[] {
    return this.ledgerCharges.map((charge) => ({ ...charge }));
  }

  addOrphanUpload(input: { uploadId: string; createdAt?: number }): void {
    const uploadId = requireText(input.uploadId, "orphan upload id");
    if (this.uploads.has(uploadId) || this.orphans.has(uploadId)) return;
    const createdAt = input.createdAt ?? this.now();
    this.orphans.set(uploadId, {
      uploadId,
      createdAt,
      expiresAt: createdAt + MANAGED_TEMPORARY_DATA_TTL_MS,
    });
  }

  cleanup(nowInput = this.now()): ManagedTemporaryArtifacts {
    this.reconcileLeases(nowInput);
    for (const [uploadId, upload] of this.uploads) {
      if (upload.expiresAt <= nowInput) this.uploads.delete(uploadId);
    }
    for (const job of this.jobs.values()) {
      if (job.providerResult && job.expiresAt <= nowInput) job.providerResult = null;
    }
    for (const [uploadId, upload] of this.orphans) {
      if (upload.expiresAt <= nowInput) this.orphans.delete(uploadId);
    }
    return this.temporaryArtifacts();
  }

  temporaryArtifacts(): ManagedTemporaryArtifacts {
    return {
      uploadIds: [...this.uploads.keys()].sort(),
      resultJobIds: [...this.jobs.values()]
        .filter((job) => job.providerResult !== null)
        .map((job) => job.jobId)
        .sort(),
      orphanUploadIds: [...this.orphans.keys()].sort(),
    };
  }

  private enroll(input: EnrollDeviceInput, restored: boolean): EnrolledDevice {
    const token = input.verifiedLineageToken?.trim();
    if (!token) throw new IdentityAuthorizationError();
    const lineage = this.requireLineage(token);
    const installationId = requireText(input.installationId, "installation id");
    const keyId = requireText(input.deviceKeyId, "device key id");
    const existing = [...lineage.devices.values()].find((device) => device.installationId === installationId);
    if (existing) {
      if (existing.keyId !== keyId || existing.revokedAt !== null) {
        throw new DeviceCredentialError("This installation does not possess its enrolled device key");
      }
      return {
        accountId: lineage.accountId,
        device: publicDevice(existing),
        credential: { deviceId: existing.deviceId, keyId: existing.keyId },
        restored,
      };
    }
    if ([...lineage.devices.values()].filter((device) => device.revokedAt === null).length >= MANAGED_MAX_DEVICES) {
      throw new DeviceLimitError();
    }
    for (const candidate of this.lineages.values()) {
      if ([...candidate.devices.values()].some((device) => device.keyId === keyId && device.revokedAt === null)) {
        throw new DeviceCredentialError("A device key must identify one enrolled Mac");
      }
    }
    const enrolledAt = this.now();
    const deviceId = this.createDeviceId(installationId);
    const device: ManagedDeviceState = {
      deviceId,
      installationId,
      keyId,
      enrolledAt,
      revokedAt: null,
      token,
    };
    lineage.devices.set(deviceId, device);
    return {
      accountId: lineage.accountId,
      device: publicDevice(device),
      credential: { deviceId, keyId },
      restored,
    };
  }

  private resolveCredential(
    credential: ManagedDeviceCredential,
    allowRevoked: boolean,
  ): { lineage: LineageState; device: ManagedDeviceState } {
    const deviceId = typeof credential?.deviceId === "string" ? credential.deviceId.trim() : "";
    const keyId = typeof credential?.keyId === "string" ? credential.keyId.trim() : "";
    if (!deviceId || !keyId) {
      throw new DeviceCredentialError();
    }
    for (const lineage of this.lineages.values()) {
      const device = lineage.devices.get(deviceId);
      if (!device) continue;
      if (device.keyId !== keyId || (!allowRevoked && device.revokedAt !== null)) {
        throw new DeviceCredentialError();
      }
      return { lineage, device };
    }
    throw new DeviceCredentialError();
  }

  private requireLineage(token: string): LineageState {
    const normalized = typeof token === "string" ? token.trim() : "";
    const lineage = [...this.lineages.values()].find((candidate) => candidate.token === normalized);
    if (!lineage) throw new IdentityAuthorizationError();
    return lineage;
  }

  private requireJob(jobId: string): JobState {
    const job = this.jobs.get(requireText(jobId, "job id"));
    if (!job) throw new ManagedJobStateError(`Managed job not found: ${jobId}`);
    return job;
  }

  private requireAdmission(job: JobState, admissionId: string): void {
    if (typeof admissionId !== "string" || admissionId.trim() !== job.admissionId) {
      throw new ManagedJobStateError(`Managed job ${job.jobId} has a stale execution admission`);
    }
  }

  private reAdmit(
    job: JobState,
    lineage: LineageState,
    device: ManagedDeviceState,
    now: number,
  ): JobState {
    if (now >= job.expiresAt) {
      throw new ManagedJobStateError(`Managed job ${job.jobId} exceeded its temporary-data TTL`);
    }
    this.advancePeriods(lineage, now);
    const entitlement = this.entitlement(lineage, now);
    if (entitlement !== "active" && entitlement !== "grace") {
      throw new ManagedJobStateError(`Managed job ${job.jobId} cannot receive a fresh admission with entitlement ${entitlement}`);
    }
    const period = this.currentPeriod(lineage);
    const remaining = period.limitSeconds - period.usedSeconds - period.reservedSeconds;
    if (remaining < job.audio.billableSeconds) {
      throw new QuotaExceededError(job.audio.billableSeconds, Math.max(0, remaining));
    }
    period.reservedSeconds += job.audio.billableSeconds;
    job.deviceId = device.deviceId;
    job.admissionId = this.createAdmissionId();
    job.admissionNumber += 1;
    job.periodStartAt = period.startAt;
    job.createdAt = now;
    job.leaseExpiresAt = now + MANAGED_JOB_LEASE_MS;
    job.expiresAt = now + MANAGED_TEMPORARY_DATA_TTL_MS;
    job.status = "reserved";
    job.providerCompletedAt = null;
    job.settledAt = null;
    job.failureReason = null;
    job.providerResult = null;
    this.uploads.set(job.jobId, {
      uploadId: job.jobId,
      jobId: job.jobId,
      createdAt: now,
      expiresAt: job.expiresAt,
    });
    return job;
  }

  private lineageForAccount(accountId: string): LineageState {
    const lineage = [...this.lineages.values()].find((candidate) => candidate.accountId === accountId);
    if (!lineage) throw new ManagedJobStateError(`Managed quota account not found: ${accountId}`);
    return lineage;
  }

  private entitlement(lineage: LineageState, now: number): ManagedEntitlementStatus {
    if (lineage.entitlementOverride === "refunded" || lineage.entitlementOverride === "revoked") return lineage.entitlementOverride;
    if (lineage.naturalExpiryAt !== null && now >= lineage.naturalExpiryAt) return "expired";
    return lineage.entitlementOverride;
  }

  private currentPeriod(lineage: LineageState): PeriodState {
    let current: PeriodState | undefined;
    for (const period of lineage.periods.values()) {
      if (!current || period.startAt > current.startAt) current = period;
    }
    if (!current) throw new ManagedJobStateError("Managed quota account has no current period");
    return current;
  }

  private advancePeriods(lineage: LineageState, now: number): void {
    let current = this.currentPeriod(lineage);
    while (now >= current.endAt) {
      const product = lineage.nextProduct ?? current.product;
      const next = makePeriod(product, current.endAt, this.allowance);
      if (lineage.nextProduct !== null) lineage.nextProduct = null;
      lineage.periods.set(next.startAt, next);
      current = next;
    }
  }

  private reconcileLeases(now: number): void {
    for (const job of this.jobs.values()) {
      if ((job.status === "reserved" || job.status === "running") && now >= job.leaseExpiresAt) {
        this.releaseReservation(job);
        job.status = "expired";
      }
    }
  }

  private releaseReservation(job: JobState): void {
    const lineage = this.lineageForAccount(job.accountId);
    const period = lineage.periods.get(job.periodStartAt);
    if (!period || period.reservedSeconds < job.audio.billableSeconds) {
      throw new ManagedJobStateError(`Managed job ${job.jobId} has no matching quota reservation`);
    }
    period.reservedSeconds -= job.audio.billableSeconds;
  }

  private stopIfInFlight(job: JobState, reason: string): void {
    if (job.status !== "reserved" && job.status !== "running") return;
    this.releaseReservation(job);
    this.uploads.delete(job.jobId);
    job.status = "stopped";
    job.failureReason = reason;
  }
}

export function parseCanonicalPcmWav(bytes: Uint8Array): CanonicalPcmWav {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) throw new MalformedPcmWavError("WAV container header is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new MalformedPcmWavError("expected RIFF/WAVE container");
  }
  const riffSize = view.getUint32(4, true);
  const containerEnd = 8 + riffSize;
  if (containerEnd !== bytes.byteLength) throw new MalformedPcmWavError("RIFF size does not match the received bytes");
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | null = null;
  let dataByteLength: number | null = null;
  while (offset < containerEnd) {
    if (offset + 8 > containerEnd) throw new MalformedPcmWavError("WAV chunk header is truncated");
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    const paddedEnd = payloadEnd + (chunkSize % 2);
    if (payloadEnd > containerEnd || paddedEnd > containerEnd) throw new MalformedPcmWavError("WAV chunk exceeds the RIFF container");
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new MalformedPcmWavError("WAV fmt chunk is incomplete");
      format = {
        audioFormat: view.getUint16(payloadStart, true),
        channels: view.getUint16(payloadStart + 2, true),
        sampleRate: view.getUint32(payloadStart + 4, true),
        byteRate: view.getUint32(payloadStart + 8, true),
        blockAlign: view.getUint16(payloadStart + 12, true),
        bitsPerSample: view.getUint16(payloadStart + 14, true),
      };
    } else if (chunkId === "data") {
      if (dataByteLength !== null) throw new MalformedPcmWavError("WAV contains more than one data timeline");
      dataByteLength = chunkSize;
    }
    offset = paddedEnd;
  }
  if (!format || dataByteLength === null) throw new MalformedPcmWavError("WAV needs one fmt chunk and one data chunk");
  if (
    format.audioFormat !== 1 ||
    format.channels !== MANAGED_CHANNELS ||
    format.sampleRate !== MANAGED_SAMPLE_RATE ||
    format.bitsPerSample !== MANAGED_BITS_PER_SAMPLE ||
    format.blockAlign !== 2 ||
    format.byteRate !== MANAGED_SAMPLE_RATE * 2
  ) {
    throw new MalformedPcmWavError("WAV must be 16 kHz, mono, 16-bit PCM");
  }
  if (dataByteLength <= 0 || dataByteLength % format.blockAlign !== 0) {
    throw new MalformedPcmWavError("WAV data does not contain complete PCM samples");
  }
  const sampleCount = dataByteLength / format.blockAlign;
  const durationSeconds = sampleCount / MANAGED_SAMPLE_RATE;
  return {
    byteLength: bytes.byteLength,
    dataByteLength,
    sampleCount,
    sampleRate: MANAGED_SAMPLE_RATE,
    channels: MANAGED_CHANNELS,
    bitsPerSample: MANAGED_BITS_PER_SAMPLE,
    durationSeconds,
    durationMs: Math.max(1, Math.ceil(durationSeconds * 1_000)),
    billableSeconds: Math.max(1, Math.ceil(durationSeconds)),
  };
}

export function transcriptionAccess(mode: ManagedTranscriptionMode): ManagedAccessDecision {
  if (mode === "managed") return { allowed: false, requiresPremium: true, chargesManagedQuota: true };
  return { allowed: true, requiresPremium: false, chargesManagedQuota: false };
}

function makePeriod(
  product: ManagedSubscriptionProduct,
  startAt: number,
  allowance: ManagedAllowanceConfiguration,
): PeriodState {
  return {
    product,
    startAt,
    endAt: product === "trial" ? startAt + MANAGED_TRIAL_DURATION_MS : addCalendarMonth(startAt),
    limitSeconds: product === "trial" ? allowance.trialSeconds : allowance.monthlySeconds,
    usedSeconds: 0,
    reservedSeconds: 0,
  };
}

function addCalendarMonth(timestamp: number): number {
  const date = new Date(timestamp);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return date.valueOf();
}

function requireProduct(product: ManagedSubscriptionProduct): ManagedSubscriptionProduct {
  if (product !== "monthly" && product !== "annual" && product !== "trial") {
    throw new ManagedTranscriptionError("Unsupported managed subscription product");
  }
  return product;
}

function checkedAllowance(input: ManagedAllowanceConfiguration): ManagedAllowanceConfiguration {
  if (input.trialSeconds !== MANAGED_TRIAL_ALLOWANCE_SECONDS) {
    throw new ManagedTranscriptionError(`Managed trial allowance is fixed at ${MANAGED_TRIAL_ALLOWANCE_SECONDS} seconds`);
  }
  return {
    monthlySeconds: checkedPositiveInteger(input.monthlySeconds, "monthly allowance"),
    trialSeconds: checkedPositiveInteger(input.trialSeconds, "trial allowance"),
  };
}

function checkedTimeline(
  input: ManagedTimelineEvidence | ManagedAudioIdentity,
  actualByteLength: number,
): ManagedTimelineEvidence {
  const timeline = {
    recordingId: requireText(input.recordingId, "recording id"),
    audioId: requireText(input.audioId, "audio id"),
    manifestSha256: requireSha256(input.manifestSha256, "manifest sha256"),
    contentSha256: requireSha256(input.contentSha256, "content sha256"),
    byteLength: checkedPositiveInteger(input.byteLength, "canonical WAV byte length"),
    startMs: checkedNonNegativeInteger(input.startMs, "timeline start"),
    endMs: checkedPositiveInteger(input.endMs, "timeline end"),
  };
  if (timeline.byteLength !== actualByteLength) {
    throw new ManagedTimelineIdentityError("Canonical timeline byte identity does not match the received WAV");
  }
  if (timeline.endMs <= timeline.startMs) {
    throw new ManagedTimelineIdentityError("Canonical timeline window must be non-empty");
  }
  return timeline;
}

function timelineFingerprint(timeline: ManagedTimelineEvidence): string {
  return [
    timeline.manifestSha256,
    timeline.contentSha256,
    timeline.byteLength,
    timeline.startMs,
    timeline.endMs,
  ].join("\u0000");
}

function makeTimelineKey(accountId: string, timeline: ManagedTimelineEvidence): string {
  return `${accountId}\u0000${timeline.recordingId}\u0000${timeline.audioId}`;
}

function makeIdempotencyKey(accountId: string, timeline: ManagedTimelineEvidence, chunkId: string): string {
  return `${accountId}\u0000${timeline.recordingId}\u0000${timeline.audioId}\u0000${chunkId}`;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ManagedTimelineIdentityError(`${field} must be a lowercase SHA-256 identity`);
  }
  return value;
}

function checkedPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ManagedTranscriptionError(`${field} must be a positive integer`);
  return value;
}

function checkedNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ManagedTranscriptionError(`${field} must be a non-negative integer`);
  return value;
}

function checkedSeconds(value: number, field: string): number {
  return checkedPositiveInteger(value, field);
}

function checkedNonNegativeSeconds(value: number, field: string): number {
  return checkedNonNegativeInteger(value, field);
}

function checkedSequence(value: number, field: string): number {
  return checkedNonNegativeInteger(value, field);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ManagedTranscriptionError(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized) throw new ManagedTranscriptionError(`${field} must not be empty`);
  return normalized;
}

function requireManifestText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManagedTimelineIdentityError(`Managed upload ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireInstant(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ManagedTranscriptionError(`${field} must be a non-negative epoch millisecond`);
  return value;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function publicDevice(device: ManagedDevice): ManagedDevice {
  return { ...device };
}

function publicPeriod(period: PeriodState): ManagedPeriodSnapshot {
  return {
    product: period.product,
    startAt: period.startAt,
    endAt: period.endAt,
    limitSeconds: period.limitSeconds,
    usedSeconds: period.usedSeconds,
    reservedSeconds: period.reservedSeconds,
    remainingSeconds: Math.max(0, period.limitSeconds - period.usedSeconds - period.reservedSeconds),
  };
}

function publicJob(job: JobState): ManagedJob {
  return {
    jobId: job.jobId,
    admissionId: job.admissionId,
    admissionNumber: job.admissionNumber,
    idempotencyKey: job.idempotencyKey,
    accountId: job.accountId,
    deviceId: job.deviceId,
    audio: { ...job.audio },
    chunkId: job.chunkId,
    status: job.status,
    createdAt: job.createdAt,
    leaseExpiresAt: job.leaseExpiresAt,
    expiresAt: job.expiresAt,
    providerCompletedAt: job.providerCompletedAt,
    settledAt: job.settledAt,
    failureReason: job.failureReason,
    providerResult: job.providerResult
      ? { text: job.providerResult.text, detectedLanguages: [...(job.providerResult.detectedLanguages ?? [])] }
      : null,
  };
}
