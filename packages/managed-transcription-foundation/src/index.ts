const MONO_PCM_WAV_AUTHORITY = "docs/product/monetization.md; docs/decisions/0005-mac-app-store-and-revenuecat.md";

export const MANAGED_MONTHLY_ALLOWANCE_SECONDS = 180_000;
export const MANAGED_TRIAL_ALLOWANCE_SECONDS = 18_000;
export const MANAGED_TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MANAGED_JOB_LEASE_MS = 6 * 60 * 60 * 1_000;
export const MANAGED_TEMPORARY_DATA_TTL_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_MAX_DEVICES = 3;
export const MANAGED_SAMPLE_RATE = 16_000;
export const MANAGED_CHANNELS = 1;
export const MANAGED_BITS_PER_SAMPLE = 16;

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
  readonly audioId: string;
  readonly byteLength: number;
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

interface JobState extends Omit<ManagedJob, "status" | "providerCompletedAt" | "settledAt" | "failureReason" | "providerResult"> {
  readonly periodStartAt: number;
  readonly audioFingerprint: string;
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
      `Managed transcription reused a subscriber/audio/chunk identity with different audio ` +
      `(${MONO_PCM_WAV_AUTHORITY}). Use one stable identity for retries.`,
    );
    this.name = "IdempotencyConflictError";
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
  /** Identity of the one canonical meeting timeline, not a microphone/system source. */
  readonly audioId: string;
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
 * This state is intentionally process-local. It models the accepted backend
 * contracts without pretending to be a Convex database or a production
 * provider adapter. External data is converted at `reserve`; all state
 * transitions below use ordinary values and an injected clock.
 */
export class ManagedTranscriptionPolicy {
  private readonly now: () => number;
  private readonly createDeviceId: (installationId: string) => string;
  private readonly createJobId: () => string;
  private readonly lineages = new Map<string, LineageState>();
  private readonly jobs = new Map<string, JobState>();
  private readonly jobsByIdempotency = new Map<string, JobState>();
  private readonly jobsByAudioTimeline = new Map<string, JobState>();
  private readonly uploads = new Map<string, UploadState>();
  private readonly orphans = new Map<string, OrphanUploadState>();
  private readonly ledgerCharges: ManagedLedgerCharge[] = [];
  private deviceSequence = 0;
  private jobSequence = 0;

  constructor(options: ManagedTranscriptionPolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createDeviceId = options.createDeviceId ?? (() => `managed-device-${++this.deviceSequence}`);
    this.createJobId = options.createJobId ?? (() => `managed-job-${++this.jobSequence}`);
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
    const initialPeriod = makePeriod(product, startedAt);
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
    this.advancePeriods(lineage, this.now());
    const audioId = requireText(input.audioId, "audio id");
    const chunkId = requireText(input.chunkId, "chunk id");
    const canonical = parseCanonicalPcmWav(input.wav);
    if (input.claimedDurationSeconds !== undefined) {
      const claimed = input.claimedDurationSeconds;
      if (!Number.isFinite(claimed) || claimed < 0 || claimed !== canonical.durationSeconds) {
        throw new DurationClaimMismatchError(claimed, canonical.durationSeconds);
      }
    }
    const idempotencyKey = `${lineage.accountId}\u0000${audioId}\u0000${chunkId}`;
    const bytesDigest = stableBytesDigest(input.wav);
    const timelineKey = `${lineage.accountId}\u0000${bytesDigest}`;
    const fingerprint = `${audioId}\u0000${bytesDigest}`;
    const existing = this.jobsByIdempotency.get(idempotencyKey);
    if (existing) {
      if (existing.audioFingerprint !== fingerprint) throw new IdempotencyConflictError();
      return { outcome: "duplicate", job: publicJob(existing) };
    }
    const existingTimeline = this.jobsByAudioTimeline.get(timelineKey);
    if (existingTimeline) throw new IdempotencyConflictError();
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
      idempotencyKey,
      accountId: lineage.accountId,
      deviceId: device.deviceId,
      audio: {
        audioId,
        byteLength: input.wav.byteLength,
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
      audioFingerprint: fingerprint,
    };
    period.reservedSeconds += canonical.billableSeconds;
    this.jobs.set(jobId, job);
    this.jobsByIdempotency.set(idempotencyKey, job);
    this.jobsByAudioTimeline.set(timelineKey, job);
    this.uploads.set(jobId, {
      uploadId: jobId,
      jobId,
      createdAt,
      expiresAt: job.expiresAt,
    });
    return { outcome: "reserved", job: publicJob(job) };
  }

  startProvider(jobId: string): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
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

  recordProviderSuccess(jobId: string, result: ManagedProviderResult): ManagedJob {
    const job = this.requireJob(jobId);
    this.reconcileLeases(this.now());
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
    const now = this.now();
    if (now >= job.expiresAt) throw new ManagedJobStateError(`Managed job ${jobId} exceeded its temporary-data TTL`);
    const lineage = this.lineageForAccount(job.accountId);
    this.advancePeriods(lineage, now);
    const entitlement = this.entitlement(lineage, now);
    if (entitlement !== "active" && entitlement !== "grace") {
      throw new ManagedJobStateError(`Managed job ${jobId} cannot retry with entitlement ${entitlement}`);
    }
    const period = lineage.periods.get(job.periodStartAt);
    if (!period) throw new ManagedJobStateError(`Managed job ${jobId} lost its reserved quota period`);
    if (period.limitSeconds - period.usedSeconds - period.reservedSeconds < job.audio.billableSeconds) {
      throw new QuotaExceededError(
        job.audio.billableSeconds,
        Math.max(0, period.limitSeconds - period.usedSeconds - period.reservedSeconds),
      );
    }
    period.reservedSeconds += job.audio.billableSeconds;
    job.status = "reserved";
    job.failureReason = null;
    this.uploads.set(job.jobId, {
      uploadId: job.jobId,
      jobId: job.jobId,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
    });
    return publicJob(job);
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
      const next = makePeriod(product, current.endAt);
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

function makePeriod(product: ManagedSubscriptionProduct, startAt: number): PeriodState {
  return {
    product,
    startAt,
    endAt: product === "trial" ? startAt + MANAGED_TRIAL_DURATION_MS : addCalendarMonth(startAt),
    limitSeconds: product === "trial" ? MANAGED_TRIAL_ALLOWANCE_SECONDS : MANAGED_MONTHLY_ALLOWANCE_SECONDS,
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

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ManagedTranscriptionError(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized) throw new ManagedTranscriptionError(`${field} must not be empty`);
  return normalized;
}

function requireInstant(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ManagedTranscriptionError(`${field} must be a non-negative epoch millisecond`);
  return value;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function stableBytesDigest(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let c = 0x9e3779b9;
  let d = 0x85ebca6b;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index]!;
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul(b ^ (value + index), 0x85ebca6b);
    c = Math.imul(c ^ (value * 31 + index), 0xc2b2ae35);
    d = Math.imul(d ^ (value * 17 + index * 13), 0x27d4eb2d);
  }
  return [a, b, c, d].map((lane) => (lane >>> 0).toString(16).padStart(8, "0")).join("");
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
