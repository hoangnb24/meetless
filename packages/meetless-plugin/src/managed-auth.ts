import { randomUUID } from "node:crypto";
import net from "node:net";
import { z } from "zod";
import type { ManagedConvexCredential, ManagedConvexFunctionClient } from "./managed-upload.js";

export interface ManagedDeviceIdentity {
  readonly deviceId: string;
  readonly keyId: string;
  readonly publicKey: string;
}

export interface ManagedDeviceSigner {
  identity(): Promise<ManagedDeviceIdentity>;
  signChallenge(payload: Uint8Array): Promise<ManagedDeviceIdentity & { readonly signature: string }>;
}

export interface ManagedAppleVerificationMaterial {
  readonly adapter: "fixture" | "app-store-server-api";
  readonly bundleId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly productId: string;
  readonly originalTransactionId: string;
  readonly periodType: "normal" | "trial";
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly currentState: "active" | "grace" | "expired" | "refunded" | "revoked";
  readonly fixtureProof?: string;
  readonly signedTransaction?: string;
}

export interface ManagedAuthFunctionNames {
  readonly createChallenge: string;
  readonly enroll: string;
  readonly refresh: string;
}

const DEFAULT_FUNCTIONS: ManagedAuthFunctionNames = {
  createChallenge: "managedAuth:createDeviceChallenge",
  enroll: "managedAuthActions:enrollDevice",
  refresh: "managedAuthActions:refreshDevice",
};

const IdentitySchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1),
  ok: z.literal(true),
  type: z.literal("managed.auth.identity"),
  deviceId: z.string().trim().min(1),
  keyId: z.string().trim().min(1),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/u),
}).strict();

const SignedChallengeSchema = IdentitySchema.extend({
  type: z.literal("managed.auth.challenge"),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/u),
}).strict();

const ChallengeSchema = z.object({
  challengeId: z.string().min(1),
  purpose: z.enum(["enrollment", "refresh"]),
  deviceId: z.string().min(1),
  keyId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  signingPayload: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  issuer: z.string().min(1),
  audience: z.string().min(1),
}).strict();

const TokenSchema = z.object({
  authToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  deviceId: z.string().min(1),
  keyId: z.string().min(1),
}).strict();

/**
 * Native host transport. The private key never crosses this boundary: only a
 * challenge byte string enters and a P-256 signature leaves.
 */
export class UnixSocketManagedAuthTransport implements ManagedDeviceSigner {
  constructor(private readonly socketPath: string) {}

  async identity(): Promise<ManagedDeviceIdentity> {
    const response = await this.request({ operation: "managedAuthIdentity" });
    return IdentitySchema.parse(response);
  }

  async signChallenge(payload: Uint8Array): Promise<ManagedDeviceIdentity & { readonly signature: string }> {
    const response = await this.request({ operation: "managedAuthSignChallenge", challenge: encodeBase64Url(payload) });
    return SignedChallengeSchema.parse(response);
  }

  private request(input: { operation: "managedAuthIdentity" | "managedAuthSignChallenge"; challenge?: string }): Promise<unknown> {
    const requestId = randomUUID();
    const message = JSON.stringify({ version: 1, requestId, ...input });
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.setEncoding("utf8");
      socket.once("error", () => finish(() => reject(new Error("Managed native auth transport is unavailable"))));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          if (response.requestId !== requestId || response.ok !== true) throw new Error("invalid native auth response");
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new Error("Managed native auth response is invalid")));
        }
      });
      socket.once("connect", () => socket.end(`${message}\n`));
    });
  }
}

export class ConvexManagedCredentialSource {
  private readonly functions: ManagedAuthFunctionNames;

  constructor(
    private readonly client: ManagedConvexFunctionClient,
    private readonly signer: ManagedDeviceSigner,
    functions: Partial<ManagedAuthFunctionNames> = {},
  ) {
    this.functions = { ...DEFAULT_FUNCTIONS, ...functions };
  }

  /** Explicit user-selected enrollment; this does not run during startup. */
  async enroll(apple: ManagedAppleVerificationMaterial): Promise<ManagedConvexCredential> {
    const identity = await this.signer.identity();
    const challenge = await this.createChallenge(identity, "enrollment");
    const signed = await this.signer.signChallenge(decodeBase64Url(challenge.signingPayload));
    assertSameIdentity(identity, signed, challenge);
    return this.issue(this.functions.enroll, {
      challengeId: challenge.challengeId,
      deviceId: signed.deviceId,
      keyId: signed.keyId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      apple,
    });
  }

  /** Refresh proves the enrolled private key and never changes entitlement. */
  async refresh(): Promise<ManagedConvexCredential> {
    const identity = await this.signer.identity();
    const challenge = await this.createChallenge(identity, "refresh");
    const signed = await this.signer.signChallenge(decodeBase64Url(challenge.signingPayload));
    assertSameIdentity(identity, signed, challenge);
    return this.issue(this.functions.refresh, {
      challengeId: challenge.challengeId,
      deviceId: signed.deviceId,
      keyId: signed.keyId,
      publicKey: signed.publicKey,
      signature: signed.signature,
    });
  }

  private async createChallenge(identity: ManagedDeviceIdentity, purpose: "enrollment" | "refresh") {
    const value = await this.client.mutation(this.functions.createChallenge, {
      purpose,
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      publicKey: identity.publicKey,
    });
    const challenge = ChallengeSchema.parse(value);
    if (challenge.purpose !== purpose || challenge.deviceId !== identity.deviceId || challenge.keyId !== identity.keyId) {
      throw new Error("Managed Convex challenge is not bound to the native device identity");
    }
    if (challenge.expiresAt <= Date.now()) throw new Error("Managed Convex challenge is already expired");
    return challenge;
  }

  private async issue(functionName: string, args: Record<string, unknown>): Promise<ManagedConvexCredential> {
    const credential = TokenSchema.parse(await this.client.action(functionName, args));
    if (credential.expiresAt <= Date.now()) throw new Error("Managed Convex returned an expired device token");
    return { authToken: credential.authToken };
  }
}

function assertSameIdentity(
  identity: ManagedDeviceIdentity,
  signed: ManagedDeviceIdentity,
  challenge: { readonly deviceId: string; readonly keyId: string },
): void {
  if (signed.deviceId !== identity.deviceId || signed.keyId !== identity.keyId || signed.publicKey !== identity.publicKey || signed.deviceId !== challenge.deviceId || signed.keyId !== challenge.keyId) {
    throw new Error("Managed native signer returned an identity different from the challenged key");
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
