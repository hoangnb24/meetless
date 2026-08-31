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
  transcriptionAccess,
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
    const sharedReservation = policy.reserve({
      credential: enrolled[0]!.credential,
      audioId: "shared-audio",
      chunkId: "shared-chunk",
      wav: pcmWav(16_000),
    });
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
    expect(() => policy.reserve({
      credential: enrolled[1]!.credential,
      audioId: "audio-revoked",
      chunkId: "chunk-revoked",
      wav: pcmWav(16_000),
    })).toThrow(/invalid or revoked/);
  });

  test("derives canonical duration from PCM samples and rejects malformed or false claims", () => {
    const canonical = pcmWav(24_000);
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "duration-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "duration-install", deviceKeyId: "duration-key" });

    expect(() => policy.reserve({
      credential: device.credential,
      audioId: "audio-malformed",
      chunkId: "chunk-malformed",
      wav: new Uint8Array([1, 2, 3]),
    })).toThrow(MalformedPcmWavError);

    expect(() => policy.reserve({
      credential: device.credential,
      audioId: "audio-duration",
      chunkId: "chunk-duration",
      wav: canonical,
      claimedDurationSeconds: 2,
    })).toThrow(DurationClaimMismatchError);
    const reservation = policy.reserve({
      credential: device.credential,
      audioId: "audio-duration",
      chunkId: "chunk-duration",
      wav: canonical,
      claimedDurationSeconds: 1.5,
    });
    expect(reservation.job.audio).toMatchObject({
      sampleCount: 24_000,
      durationSeconds: 1.5,
      durationMs: 1_500,
      billableSeconds: 2,
    });

    const wrongFormat = pcmWav(16_000, 0, { channels: 2 });
    expect(() => policy.reserve({
      credential: device.credential,
      audioId: "audio-wrong-format",
      chunkId: "chunk-wrong-format",
      wav: wrongFormat,
    })).toThrow(/16 kHz, mono, 16-bit PCM/);
  });

  test("atomically reserves and settles one charge across duplicate requests and a crash after provider success", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "idempotency-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "idempotency-install", deviceKeyId: "idempotency-key" });
    const input = { credential: device.credential, audioId: "stable-audio", chunkId: "stable-chunk", wav: pcmWav(32_000) };

    const first = policy.reserve(input);
    const duplicate = policy.reserve(input);
    expect(first.outcome).toBe("reserved");
    expect(duplicate).toEqual({ outcome: "duplicate", job: first.job });
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 2, usedSeconds: 0 });

    policy.startProvider(first.job.jobId);
    policy.recordProviderSuccess(first.job.jobId, { text: "The meeting chose the local store.", detectedLanguages: ["en"] });
    // A process crash here leaves the temporary result and reservation outcome
    // durable in the fake policy state, but has not charged the ledger yet.
    expect(policy.job(first.job.jobId).status).toBe("provider_completed");
    expect(policy.ledger()).toHaveLength(0);
    expect(policy.reserve(input).job.status).toBe("provider_completed");

    const settled = policy.settleJob(first.job.jobId);
    expect(policy.settleJob(first.job.jobId)).toEqual(settled);
    expect(policy.ledger()).toEqual([expect.objectContaining({ jobId: first.job.jobId, seconds: 2 })]);
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ reservedSeconds: 0, usedSeconds: 2 });
    const sameShapeDifferentBytes = new Uint8Array(input.wav);
    sameShapeDifferentBytes[44] = 1;
    expect(() => policy.reserve({ ...input, wav: sameShapeDifferentBytes })).toThrow(IdempotencyConflictError);
    expect(() => policy.reserve({ ...input, wav: pcmWav(16_000) })).toThrow(IdempotencyConflictError);
    expect(() => policy.reserve({ ...input, chunkId: "overlapping-system-source" })).toThrow(IdempotencyConflictError);
    policy.acknowledgePublication(first.job.jobId);
    expect(policy.temporaryArtifacts()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
  });

  test("releases or cleans success, failure, cancel, lease expiry, and orphan temporary data", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "cleanup-lineage", product: "monthly", startedAt: START });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "cleanup-install", deviceKeyId: "cleanup-key" });
    const reserve = (suffix: string) => policy.reserve({
      credential: device.credential,
      audioId: `audio-${suffix}`,
      chunkId: `chunk-${suffix}`,
      wav: pcmWav(16_000, suffix.charCodeAt(0)),
    }).job;

    const success = reserve("success");
    policy.startProvider(success.jobId);
    policy.recordProviderSuccess(success.jobId, { text: "success" });
    policy.settleJob(success.jobId);
    expect(policy.temporaryArtifacts()).toMatchObject({ resultJobIds: [success.jobId], uploadIds: [] });
    policy.acknowledgePublication(success.jobId);

    const failure = reserve("failure");
    policy.startProvider(failure.jobId);
    policy.failJob(failure.jobId, "provider unavailable");
    expect(policy.job(failure.jobId).status).toBe("failed");
    expect(policy.temporaryArtifacts().uploadIds).toContain(failure.jobId);
    policy.retryJob(failure.jobId);
    policy.startProvider(failure.jobId);
    policy.failJob(failure.jobId, "provider unavailable again");

    const cancelled = reserve("cancelled");
    policy.cancelJob(cancelled.jobId);
    expect(policy.job(cancelled.jobId).status).toBe("cancelled");
    expect(policy.temporaryArtifacts().uploadIds).not.toContain(cancelled.jobId);

    const expired = reserve("expired");
    policy.startProvider(expired.jobId);
    clock.advance(MANAGED_JOB_LEASE_MS);
    policy.cleanup();
    expect(policy.job(expired.jobId).status).toBe("expired");
    expect(policy.accountSnapshot(device.credential).period.reservedSeconds).toBe(0);

    policy.addOrphanUpload({ uploadId: "orphan-upload" });
    expect(policy.temporaryArtifacts().orphanUploadIds).toEqual(["orphan-upload"]);
    clock.advance(MANAGED_TEMPORARY_DATA_TTL_MS);
    expect(policy.cleanup()).toEqual({ uploadIds: [], resultJobIds: [], orphanUploadIds: [] });
    expect(policy.job(failure.jobId).status).toBe("failed");
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
    const admitted = policy.reserve({ credential: naturalDevice.credential, audioId: "natural-audio", chunkId: "natural-chunk", wav: pcmWav(16_000) }).job;
    policy.startProvider(admitted.jobId);
    clock.advance(1_000);
    expect(policy.accountSnapshot(naturalDevice.credential).entitlement).toBe("expired");
    policy.recordProviderSuccess(admitted.jobId, { text: "admitted before natural expiry" });
    policy.settleJob(admitted.jobId);
    expect(policy.ledger()).toHaveLength(1);
    expect(() => policy.reserve({ credential: naturalDevice.credential, audioId: "new-audio", chunkId: "new-chunk", wav: pcmWav(16_000, 2) })).toThrow(/current state is expired/);

    const revoked = policy.seedVerifiedSubscriptionLineage({ lineageKey: "revoked-lineage", product: "monthly", startedAt: START });
    const revokedDevice = policy.enrollDevice({ verifiedLineageToken: revoked.token, installationId: "revoked-install", deviceKeyId: "revoked-key" });
    const revokedJob = policy.reserve({ credential: revokedDevice.credential, audioId: "revoked-audio", chunkId: "revoked-chunk", wav: pcmWav(16_000) }).job;
    policy.startProvider(revokedJob.jobId);
    policy.revokeDevice({ verifiedLineageToken: revoked.token, deviceId: revokedDevice.device.deviceId });
    expect(policy.job(revokedJob.jobId)).toMatchObject({ status: "stopped", failureReason: "device revoked" });
    expect(() => policy.recordProviderSuccess(revokedJob.jobId, { text: "must not run" })).toThrow(/not running/);

    const refundedDevice = policy.restoreDevice({ verifiedLineageToken: revoked.token, installationId: "refunded-install", deviceKeyId: "refunded-key" });
    const refundedJob = policy.reserve({ credential: refundedDevice.credential, audioId: "refunded-audio", chunkId: "refunded-chunk", wav: pcmWav(16_000, 3) }).job;
    policy.startProvider(refundedJob.jobId);
    policy.setEntitlement(revoked.token, "refunded");
    expect(policy.job(refundedJob.jobId)).toMatchObject({ status: "stopped", failureReason: "refunded" });
    expect(() => policy.recordProviderSuccess(refundedJob.jobId, { text: "must not run" })).toThrow(/not running/);
    expect(policy.ledger()).toHaveLength(1);
  });

  test("free Ask and BYOK paths do not require Premium or managed quota", () => {
    expect(transcriptionAccess("ask")).toEqual({ allowed: true, requiresPremium: false, chargesManagedQuota: false });
    expect(transcriptionAccess("byok")).toEqual({ allowed: true, requiresPremium: false, chargesManagedQuota: false });
    expect(transcriptionAccess("managed")).toEqual({ allowed: false, requiresPremium: true, chargesManagedQuota: true });
  });

  test("freezes a period snapshot and starts the next period without rollover", () => {
    const clock = new FakeClock();
    const policy = new ManagedTranscriptionPolicy({ now: clock.now });
    const lineage = policy.seedVerifiedSubscriptionLineage({ lineageKey: "period-lineage", product: "trial", startedAt: START, naturalExpiryAt: null });
    const device = policy.enrollDevice({ verifiedLineageToken: lineage.token, installationId: "period-install", deviceKeyId: "period-key" });
    const before = policy.accountSnapshot(device.credential);
    expect(before.period).toMatchObject({ product: "trial", limitSeconds: MANAGED_TRIAL_ALLOWANCE_SECONDS });
    policy.changeProduct(lineage.token, "monthly");
    clock.advance(1_000);
    expect(policy.accountSnapshot(device.credential).period).toMatchObject({ product: "trial", limitSeconds: MANAGED_TRIAL_ALLOWANCE_SECONDS });
    clock.advance(before.period.endAt - clock.now());
    const after = policy.accountSnapshot(device.credential);
    expect(after.period).toMatchObject({ product: "monthly", limitSeconds: MANAGED_MONTHLY_ALLOWANCE_SECONDS, usedSeconds: 0, reservedSeconds: 0 });
  });
});

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
