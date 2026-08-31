import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DeviceLimitError,
  DurationClaimMismatchError,
  IdentityAuthorizationError,
  IdempotencyConflictError,
  MalformedPcmWavError,
  MANAGED_JOB_LEASE_MS,
  MANAGED_MAX_DEVICES,
  MANAGED_MONTHLY_ALLOWANCE_SECONDS,
  MANAGED_TEMPORARY_DATA_TTL_MS,
  MANAGED_TRIAL_ALLOWANCE_SECONDS,
  ManagedTranscriptionPolicy,
  QuotaExceededError,
  transcriptionAccess,
  type ManagedTimelineEvidence,
} from "../src/index.js";

const START = Date.parse("2026-08-31T00:00:00.000Z");

class FakeClock {
  private value: number;

  constructor(value = START) {
    this.value = value;
  }

  now = (): number => this.value;

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

describe("managed-transcription policy", () => {
  test("requires verified lineage, shares restore quota, caps Macs, and revokes credentials", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({
      lineageKey: "store-original-transaction-1",
      product: "monthly",
      startedAt: START,
    });

    expect(() => policy.enrollDevice({
      appUserId: "app-user-only",
      installationId: "install-a",
      deviceKeyId: "key-a",
    })).toThrow(IdentityAuthorizationError);
    expect(() => policy.enrollDevice({
      clientSubscriberId: "client-subscriber-only",
      installationId: "install-a",
      deviceKeyId: "key-a",
    })).toThrow(/server-verified subscription lineage/);

    const enrolled = [
      policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "install-a", deviceKeyId: "key-a" }),
      policy.restoreDevice({ verifiedLineageToken: lineage.token, installationId: "install-b", deviceKeyId: "key-b" }),
      policy.restoreDevice({ verifiedLineageToken: lineage.token, installationId: "install-c", deviceKeyId: "key-c" }),
    ];
    expect(enrolled[1]!.accountId).toBe(enrolled[0]!.accountId);
    expect(policy.accountSnapshot(enrolled[1]!.credential).devices).toHaveLength(MANAGED_MAX_DEVICES);
    const sharedReservation = policy.reserve(input(enrolled[0]!.credential, "recording-shared", "shared-audio", "shared-chunk", pcmWav(16_000)));
    expect(policy.accountSnapshot(enrolled[1]!.credential).period).toMatchObject({ reservedSeconds: 1 });
    policy.cancelJob(sharedReservation.job.jobId);

    expect(() => policy.restoreDevice({
      verifiedLineageToken: lineage.token,
      installationId: "install-d",
      deviceKeyId: "key-d",
    })).toThrow(DeviceLimitError);

    policy.revokeDevice({ verifiedLineageToken: lineage.token, deviceId: enrolled[1]!.device.deviceId });
    expect(policy.accountSnapshot(enrolled[0]!.credential).devices.find(
      (device) => device.deviceId === enrolled[1]!.device.deviceId,
    )).toMatchObject({ revokedAt: START });
    const restoredAfterRevoke = policy.restoreDevice({
      verifiedLineageToken: lineage.token,
      installationId: "install-d",
      deviceKeyId: "key-d",
    });
    expect(restoredAfterRevoke.accountId).toBe(enrolled[0]!.accountId);
    expect(() => policy.accountSnapshot(enrolled[1]!.credential)).not.toThrow();
    expect(() => policy.reserve(input(enrolled[1]!.credential, "recording-revoked", "audio-revoked", "chunk-revoked", pcmWav(16_000)))).toThrow(/invalid or revoked/);
  });

  test("derives canonical duration from PCM samples and rejects malformed or false claims", () => {
    const canonical = pcmWav(24_000);
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "duration-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "duration-install", deviceKeyId: "duration-key" });

    expect(() => policy.reserve(input(device.credential, "recording-duration", "audio-malformed", "chunk-malformed", new Uint8Array([1, 2, 3])))).toThrow(MalformedPcmWavError);
    expect(() => policy.reserve({
      ...input(device.credential, "recording-duration", "audio-duration", "chunk-duration", canonical),
      claimedDurationSeconds: 2,
    })).toThrow(DurationClaimMismatchError);
    const reservation = policy.reserve({
      ...input(device.credential, "recording-duration", "audio-duration", "chunk-duration", canonical),
      claimedDurationSeconds: 1.5,
    });
    expect(reservation.job.audio).toMatchObject({
      recordingId: "recording-duration",
      sampleCount: 24_000,
      durationSeconds: 1.5,
      durationMs: 1_500,
      billableSeconds: 2,
    });

    const wrongFormat = pcmWav(16_000, 0, { channels: 2 });
    expect(() => policy.reserve(input(device.credential, "recording-duration", "audio-wrong-format", "chunk-wrong-format", wrongFormat))).toThrow(/16 kHz, mono, 16-bit PCM/);
  });

  test("binds immutable SHA-256 timeline identity without conflating recordings or overlapping sources", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "identity-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "identity-install", deviceKeyId: "identity-key" });
    const wav = pcmWav(32_000);
    const firstInput = input(device.credential, "recording-a", "canonical-audio", "chunk-a", wav, { manifestSeed: "manifest-a" });
    const first = policy.reserve(firstInput);
    expect(policy.reserve(firstInput)).toMatchObject({ outcome: "duplicate", job: first.job });

    const sameShapeDifferentBytes = new Uint8Array(wav);
    sameShapeDifferentBytes[44] = 1;
    expect(() => policy.reserve(input(device.credential, "recording-a", "canonical-audio", "chunk-b", sameShapeDifferentBytes, { manifestSeed: "manifest-a" }))).toThrow(IdempotencyConflictError);
    expect(() => policy.reserve(input(device.credential, "recording-a", "canonical-audio", "chunk-c", wav, { manifestSeed: "manifest-b" }))).toThrow(IdempotencyConflictError);

    const distinctRecording = policy.reserve(input(device.credential, "recording-b", "canonical-audio", "chunk-a", wav, { manifestSeed: "manifest-a" }));
    expect(distinctRecording.outcome).toBe("reserved");
    policy.cancelJob(distinctRecording.job.jobId);

    expect(() => policy.reserve(input(device.credential, "recording-a", "system-source", "chunk-system", pcmWav(32_000, 2), {
      manifestSeed: "manifest-system",
      startMs: 0,
      endMs: 2_000,
    }))).toThrow(IdempotencyConflictError);
    policy.cancelJob(first.job.jobId);
  });

  test("re-admits expired identity only with active quota and a fresh lease, then settles once", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "lease-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "lease-install", deviceKeyId: "lease-key" });
    const jobInput = input(device.credential, "recording-lease", "lease-audio", "lease-chunk", pcmWav(16_000));
    const expired = policy.reserve(jobInput).job;
    policy.startProvider(expired.jobId, expired.admissionId);
    clock.advance(MANAGED_JOB_LEASE_MS);

    const fresh = policy.reserve(jobInput).job;
    expect(fresh).toMatchObject({ status: "reserved", admissionNumber: 2, createdAt: clock.now(), leaseExpiresAt: clock.now() + MANAGED_JOB_LEASE_MS });
    expect(fresh.admissionId).not.toBe(expired.admissionId);
    expect(() => policy.recordProviderSuccess(fresh.jobId, expired.admissionId, { text: "stale provider result" })).toThrow(/stale execution admission/);
    policy.startProvider(fresh.jobId, fresh.admissionId);
    policy.recordProviderSuccess(fresh.jobId, fresh.admissionId, { text: "fresh provider result" });
    policy.settleJob(fresh.jobId);
    policy.settleJob(fresh.jobId);
    expect(policy.ledger()).toHaveLength(1);
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 0, usedSeconds: 1 });

    const ttlInput = input(device.credential, "recording-ttl", "ttl-audio", "ttl-chunk", pcmWav(16_000, 7));
    const ttlJob = policy.reserve(ttlInput).job;
    policy.startProvider(ttlJob.jobId, ttlJob.admissionId);
    clock.advance(MANAGED_TEMPORARY_DATA_TTL_MS);
    expect(() => policy.reserve(ttlInput)).toThrow(/temporary-data TTL/);

    const unavailableClock = new FakeClock();
    const unavailablePolicy = new ManagedTranscriptionPolicy({
      now: unavailableClock.now,
      allowance: { monthlySeconds: 1, trialSeconds: 1 },
    });
    const unavailableLineage = unavailablePolicy.seedVerifiedSubscriptionLineage({
      lineageKey: "expired-entitlement-lineage",
      product: "monthly",
      startedAt: START,
      naturalExpiryAt: START + MANAGED_JOB_LEASE_MS,
    });
    const unavailableDevice = unavailablePolicy.enrollDevice({
      verifiedLineageToken: unavailableLineage.token,
      installationId: "expired-entitlement-install",
      deviceKeyId: "expired-entitlement-key",
    });
    const unavailableInput = input(unavailableDevice.credential, "recording-expired-entitlement", "expired-entitlement-audio", "expired-entitlement-chunk", pcmWav(16_000));
    const unavailableJob = unavailablePolicy.reserve(unavailableInput).job;
    unavailablePolicy.startProvider(unavailableJob.jobId, unavailableJob.admissionId);
    unavailableClock.advance(MANAGED_JOB_LEASE_MS);
    expect(unavailablePolicy.job(unavailableJob.jobId).status).toBe("expired");
    expect(() => unavailablePolicy.reserve(unavailableInput)).toThrow(/fresh admission with entitlement expired/);

    const quotaClock = new FakeClock();
    const quotaPolicy = new ManagedTranscriptionPolicy({
      now: quotaClock.now,
      allowance: { monthlySeconds: 1, trialSeconds: 1 },
    });
    const quotaLineage = quotaPolicy.seedVerifiedSubscriptionLineage({ lineageKey: "expired-quota-lineage", product: "monthly", startedAt: START });
    const quotaDevice = quotaPolicy.enrollDevice({ verifiedLineageToken: quotaLineage.token, installationId: "expired-quota-install", deviceKeyId: "expired-quota-key" });
    const quotaInput = input(quotaDevice.credential, "recording-expired-quota", "expired-quota-audio", "expired-quota-chunk", pcmWav(16_000));
    const quotaJob = quotaPolicy.reserve(quotaInput).job;
    quotaPolicy.startProvider(quotaJob.jobId, quotaJob.admissionId);
    quotaClock.advance(MANAGED_JOB_LEASE_MS);
    quotaPolicy.cleanup();
    quotaPolicy.reserve(input(quotaDevice.credential, "recording-quota-blocker", "quota-blocker-audio", "quota-blocker-chunk", pcmWav(16_000)));
    expect(() => quotaPolicy.reserve(quotaInput)).toThrow(QuotaExceededError);
  });

  test("releases or cleans success, failure, cancel, lease expiry, and orphan temporary data", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "cleanup-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "cleanup-install", deviceKeyId: "cleanup-key" });
    const reserve = (suffix: string) => policy.reserve(input(device.credential, `recording-${suffix}`, `audio-${suffix}`, `chunk-${suffix}`, pcmWav(16_000, suffix.charCodeAt(0)))).job;

    const success = reserve("success");
    policy.startProvider(success.jobId, success.admissionId);
    policy.recordProviderSuccess(success.jobId, success.admissionId, { text: "success" });
    policy.settleJob(success.jobId);
    expect(policy.temporaryArtifacts()).toMatchObject({ resultJobIds: [success.jobId], uploadIds: [] });
    policy.acknowledgePublication(success.jobId);

    const failure = reserve("failure");
    policy.startProvider(failure.jobId, failure.admissionId);
    policy.failJob(failure.jobId, "provider unavailable");
    expect(policy.job(failure.jobId).status).toBe("failed");
    expect(policy.accountSnapshot(device.credential).period.reservedSeconds).toBe(0);
    expect(policy.temporaryArtifacts().uploadIds).toContain(failure.jobId);
    const retried = policy.retryJob(failure.jobId);
    policy.startProvider(retried.jobId, retried.admissionId);
    policy.failJob(retried.jobId, "provider unavailable again");

    const cancelled = reserve("cancelled");
    policy.cancelJob(cancelled.jobId);
    expect(policy.job(cancelled.jobId).status).toBe("cancelled");
    expect(policy.temporaryArtifacts().uploadIds).not.toContain(cancelled.jobId);

    const expired = reserve("expired");
    policy.startProvider(expired.jobId, expired.admissionId);
    clock.advance(MANAGED_JOB_LEASE_MS);
    policy.cleanup();
    expect(policy.job(expired.jobId).status).toBe("expired");
    expect(policy.accountSnapshot(device.credential).period.reservedSeconds).toBe(0);

    policy.addOrphanUpload({ uploadId: "orphan-upload" });
    expect(policy.temporaryArtifacts().orphanUploadIds).toEqual(["orphan-upload"]);
    clock.advance(MANAGED_TEMPORARY_DATA_TTL_MS);
    expect(policy.cleanup()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
    expect(policy.job(retried.jobId).status).toBe("failed");
  });

  test("allows admitted work through natural expiry but stops work after refund or revocation", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const natural = policy.seedVerifiedSubscriptionLineage({
      lineageKey: "natural-expiry-lineage",
      product: "monthly",
      startedAt: START,
      naturalExpiryAt: START + 1_000,
    });
    const naturalDevice = policy.enrollDevice({ verifiedLineageToken: natural.token, installationId: "natural-install", deviceKeyId: "natural-key" });
    const admitted = policy.reserve(input(naturalDevice.credential, "recording-natural", "natural-audio", "natural-chunk", pcmWav(16_000))).job;
    policy.startProvider(admitted.jobId, admitted.admissionId);
    clock.advance(1_000);
    expect(policy.accountSnapshot(naturalDevice.credential).entitlement).toBe("expired");
    policy.recordProviderSuccess(admitted.jobId, admitted.admissionId, { text: "admitted before natural expiry" });
    policy.settleJob(admitted.jobId);
    expect(policy.ledger()).toHaveLength(1);
    expect(() => policy.reserve(input(naturalDevice.credential, "recording-new", "new-audio", "new-chunk", pcmWav(16_000, 2)))).toThrow(/current state is expired/);

    const revoked = policy.seedVerifiedSubscriptionLineage({ lineageKey: "revoked-lineage", product: "monthly", startedAt: START });
    const revokedDevice = policy.enrollDevice({ verifiedLineageToken: revoked.token, installationId: "revoked-install", deviceKeyId: "revoked-key" });
    const revokedJob = policy.reserve(input(revokedDevice.credential, "recording-revoked", "revoked-audio", "revoked-chunk", pcmWav(16_000))).job;
    policy.startProvider(revokedJob.jobId, revokedJob.admissionId);
    policy.revokeDevice({ verifiedLineageToken: revoked.token, deviceId: revokedDevice.device.deviceId });
    expect(policy.job(revokedJob.jobId)).toMatchObject({ status: "stopped", failureReason: "device revoked" });
    expect(() => policy.recordProviderSuccess(revokedJob.jobId, revokedJob.admissionId, { text: "must not run" })).toThrow(/not running/);

    const refundedDevice = policy.restoreDevice({ verifiedLineageToken: revoked.token, installationId: "refunded-install", deviceKeyId: "refunded-key" });
    const refundedJob = policy.reserve(input(refundedDevice.credential, "recording-refunded", "refunded-audio", "refunded-chunk", pcmWav(16_000, 3))).job;
    policy.startProvider(refundedJob.jobId, refundedJob.admissionId);
    policy.setEntitlement(revoked.token, "refunded");
    expect(policy.job(refundedJob.jobId)).toMatchObject({ status: "stopped", failureReason: "refunded" });
    expect(() => policy.recordProviderSuccess(refundedJob.jobId, refundedJob.admissionId, { text: "must not run" })).toThrow(/not running/);
    expect(policy.ledger()).toHaveLength(1);
  });

  test("snapshots and rehydrates provider-completed state for exactly-once settlement", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "snapshot-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "snapshot-install", deviceKeyId: "snapshot-key" });
    const jobInput = input(device.credential, "recording-snapshot", "snapshot-audio", "snapshot-chunk", pcmWav(16_000));
    const providerCompleted = policy.reserve(jobInput).job;
    policy.startProvider(providerCompleted.jobId, providerCompleted.admissionId);
    policy.recordProviderSuccess(providerCompleted.jobId, providerCompleted.admissionId, { text: "recover after restart" });

    const persisted = JSON.parse(JSON.stringify(policy.snapshot()));
    const restarted = ManagedTranscriptionPolicy.fromSnapshot(persisted, { now: clock.now });
    expect(restarted.reserve(jobInput)).toMatchObject({ outcome: "duplicate", job: { status: "provider_completed" } });
    restarted.settleJob(providerCompleted.jobId);
    restarted.settleJob(providerCompleted.jobId);
    expect(restarted.ledger()).toHaveLength(1);
    expect(restarted.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 0, usedSeconds: 1 });
  });

  test("snapshotted allowance is configurable per backend period and exhaustion fails closed", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({
      now: clock.now,
      allowance: { monthlySeconds: 2, trialSeconds: 1 },
    });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "allowance-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "allowance-install", deviceKeyId: "allowance-key" });
    const before = policy.accountSnapshot(device.credential);
    expect(before.period.limitSeconds).toBe(2);
    const first = policy.reserve(input(device.credential, "recording-allowance", "allowance-audio", "allowance-chunk", pcmWav(32_000)));
    expect(() => policy.reserve(input(device.credential, "recording-allowance-2", "allowance-audio-2", "allowance-chunk-2", pcmWav(16_000, 2)))).toThrow(QuotaExceededError);
    policy.cancelJob(first.job.jobId);

    policy.setAllowanceConfiguration({ monthlySeconds: 1, trialSeconds: 1 });
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ limitSeconds: 2 });
    clock.advance(before.period.endAt - clock.now());
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ limitSeconds: 1, usedSeconds: 0, reservedSeconds: 0 });
    const next = policy.reserve(input(device.credential, "recording-next-period", "next-period-audio", "next-period-chunk", pcmWav(16_000)));
    expect(next.job.audio.billableSeconds).toBe(1);
    expect(() => policy.reserve(input(device.credential, "recording-next-period-2", "next-period-audio-2", "next-period-chunk-2", pcmWav(16_000, 4)))).toThrow(QuotaExceededError);
  });

  test("free Ask and BYOK paths do not require Premium or managed quota", () => {
    expect(transcriptionAccess("ask")).toEqual({ allowed: true, requiresPremium: false, chargesManagedQuota: false });
    expect(transcriptionAccess("byok")).toEqual({ allowed: true, requiresPremium: false, chargesManagedQuota: false });
    expect(transcriptionAccess("managed")).toEqual({ allowed: false, requiresPremium: true, chargesManagedQuota: true });
    expect(MANAGED_MONTHLY_ALLOWANCE_SECONDS).toBe(180_000);
    expect(MANAGED_TRIAL_ALLOWANCE_SECONDS).toBe(18_000);
  });
});

function input(
  credential: { deviceId: string; keyId: string },
  recordingId: string,
  audioId: string,
  chunkId: string,
  wav: Uint8Array,
  options: { manifestSeed?: string; startMs?: number; endMs?: number } = {},
): {
  credential: { deviceId: string; keyId: string };
  timeline: ManagedTimelineEvidence;
  chunkId: string;
  wav: Uint8Array;
} {
  const durationMs = options.endMs ?? Math.max(1, Math.round(((wav.byteLength - 44) / 2 / 16_000) * 1_000));
  return {
    credential,
    timeline: {
      recordingId,
      audioId,
      manifestSha256: sha256(Buffer.from(`${recordingId}:${options.manifestSeed ?? audioId}`)),
      contentSha256: sha256(wav),
      byteLength: wav.byteLength,
      startMs: options.startMs ?? 0,
      endMs: durationMs,
    },
    chunkId,
    wav,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pcmWav(sampleCount: number, marker = 0, overrides: { channels?: number } = {}): Uint8Array {
  const channels = overrides.channels ?? 1;
  const bytesPerSample = 2;
  const dataByteLength = sampleCount * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 16_000 * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataByteLength, true);
  bytes[44] = marker;
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
