/** Framework-free device challenge and P-256 verification helpers. */

export const DEVICE_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const DEVICE_JWT_TTL_SECONDS = 5 * 60;

export type DeviceChallengePurpose = "enrollment" | "refresh";

export interface DeviceChallengeInput {
  readonly challengeId: string;
  readonly purpose: DeviceChallengePurpose;
  readonly deviceId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly nowMs: number;
  readonly nonce?: string;
}

export interface DeviceChallenge {
  readonly challengeId: string;
  readonly purpose: DeviceChallengePurpose;
  readonly deviceId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(`Managed device authentication failed: ${message}`);
    this.name = "DeviceAuthError";
  }
}

export function createDeviceChallenge(input: DeviceChallengeInput): DeviceChallenge {
  if (!input.challengeId.trim() || !input.deviceId.trim() || !input.keyId.trim()) {
    throw new DeviceAuthError("challenge, device, and key identifiers must be non-empty");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new DeviceAuthError("challenge time is invalid");
  validateP256PublicKey(input.publicKey);
  const nonce = input.nonce ?? randomNonce();
  if (!nonce || nonce.length < 32) throw new DeviceAuthError("challenge nonce is too short");
  return {
    challengeId: input.challengeId,
    purpose: input.purpose,
    deviceId: input.deviceId,
    keyId: input.keyId,
    publicKey: input.publicKey,
    nonce,
    issuedAt: input.nowMs,
    expiresAt: input.nowMs + DEVICE_CHALLENGE_TTL_MS,
  };
}

/**
 * The exact bytes signed by the native host.  Keep this canonical and plain:
 * it is the contract across Swift, Convex, and the local fake signer.
 */
export function challengeSigningPayload(challenge: DeviceChallenge): Uint8Array {
  const canonical = [
    "meetless-device-challenge-v1",
    challenge.challengeId,
    challenge.purpose,
    challenge.deviceId,
    challenge.keyId,
    challenge.publicKey,
    challenge.nonce,
    String(challenge.expiresAt),
  ].join("\n");
  return new TextEncoder().encode(canonical);
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new DeviceAuthError("base64url data is malformed");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function validateP256PublicKey(value: string): void {
  const bytes = decodeBase64Url(value);
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new DeviceAuthError("device public key must be an uncompressed P-256 point");
  }
}

export function validateP256Signature(value: string): void {
  if (decodeBase64Url(value).length !== 64) throw new DeviceAuthError("device signature must be a raw P-256 signature");
}

export async function verifyP256Signature(
  publicKey: string,
  signature: string,
  payload: Uint8Array,
): Promise<boolean> {
  validateP256PublicKey(publicKey);
  validateP256Signature(signature);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    arrayBuffer(decodeBase64Url(publicKey)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    arrayBuffer(decodeBase64Url(signature)),
    arrayBuffer(payload),
  );
}

export function stableDeviceSubject(deviceId: string): string {
  if (!deviceId.trim()) throw new DeviceAuthError("device identifier is empty");
  return `managed-device:${deviceId}`;
}

export function tokenIdentifierFor(issuer: string, subject: string): string {
  if (!issuer.trim() || !subject.trim()) throw new DeviceAuthError("JWT issuer and subject are required");
  return `${issuer}|${subject}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as unknown as ArrayBuffer;
}
