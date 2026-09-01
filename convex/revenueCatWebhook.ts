/** RevenueCat webhook transport boundary.  No raw webhook is persisted here. */

export const REVENUECAT_SIGNATURE_HEADER = "x-revenuecat-webhook-signature";
export const REVENUECAT_REPLAY_TOLERANCE_MS = 5 * 60 * 1_000;

export interface RevenueCatWebhookVerificationConfig {
  readonly mode: "hmac";
  readonly signingSecret: string;
  readonly replayToleranceMs?: number;
}

export interface RevenueCatWebhookEvent {
  readonly eventId: string;
  readonly appId: string;
  readonly productId: string;
  readonly environment: "SANDBOX" | "PRODUCTION";
  readonly eventType: string;
  readonly eventTimestampMs: number;
  readonly originalTransactionId: string;
}

export class RevenueCatWebhookError extends Error {
  constructor(message: string) {
    super(`RevenueCat webhook rejected: ${message}`);
    this.name = "RevenueCatWebhookError";
  }
}

export async function verifyRevenueCatWebhook(
  rawBody: Uint8Array,
  headers: Record<string, string | undefined>,
  config: RevenueCatWebhookVerificationConfig,
  nowMs = Date.now(),
): Promise<void> {
  if (rawBody.byteLength === 0 || rawBody.byteLength > 1_000_000) throw new RevenueCatWebhookError("raw body size is outside the accepted bound");
  if (config.mode !== "hmac") throw new RevenueCatWebhookError("authentication mode is unsupported");
  const secret = config.signingSecret.trim();
  if (!secret) throw new RevenueCatWebhookError("HMAC signing secret is not configured");
  const signature = header(headers, REVENUECAT_SIGNATURE_HEADER);
  if (!signature) throw new RevenueCatWebhookError("signature header is missing");
  const parsed = parseSignatureHeader(signature);
  const tolerance = config.replayToleranceMs ?? REVENUECAT_REPLAY_TOLERANCE_MS;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || !Number.isSafeInteger(nowMs) || Math.abs(nowMs - parsed.timestamp * 1_000) > tolerance) {
    throw new RevenueCatWebhookError("signature timestamp is outside the replay tolerance");
  }
  const prefix = new TextEncoder().encode(`${parsed.timestamp}.`);
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  message.set(prefix);
  message.set(rawBody, prefix.byteLength);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, message);
  const actualDigest = hex(digest);
  if (!constantTimeEqual(actualDigest, parsed.signature)) throw new RevenueCatWebhookError("signature does not match the raw body");
}

export function parseRevenueCatWebhook(
  rawBody: Uint8Array,
  expectedAppId: string,
  expectedProductIds: readonly string[],
  expectedEnvironment: "SANDBOX" | "PRODUCTION",
): RevenueCatWebhookEvent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new RevenueCatWebhookError("body is not valid UTF-8 JSON");
  }
  if (!isRecord(value) || !isRecord(value.event)) throw new RevenueCatWebhookError("event envelope is invalid");
  const event = value.event;
  const eventId = text(event.id, "event id");
  const appId = text(event.app_id, "app id");
  const productId = text(event.product_id, "product id");
  const originalTransactionId = text(event.original_transaction_id, "original transaction id");
  const eventType = text(event.type, "event type");
  const environment = text(event.environment, "environment");
  const eventTimestampMs = number(event.event_timestamp_ms, "event timestamp");
  if (appId !== expectedAppId) throw new RevenueCatWebhookError("app id is not the managed application");
  if (!expectedProductIds.includes(productId)) throw new RevenueCatWebhookError("product is outside the exact managed catalog");
  if (environment !== expectedEnvironment) throw new RevenueCatWebhookError("environment is outside the configured deployment");
  if (!Number.isSafeInteger(eventTimestampMs) || eventTimestampMs < 0) throw new RevenueCatWebhookError("event timestamp is invalid");
  return {
    eventId,
    appId,
    productId,
    environment,
    eventType,
    eventTimestampMs,
    originalTransactionId,
  };
}

export async function revenueCatHmacHeader(
  rawBody: Uint8Array,
  signingSecret: string,
  timestampSeconds: number,
): Promise<string> {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw new RevenueCatWebhookError("timestamp is invalid");
  const prefix = new TextEncoder().encode(`${timestampSeconds}.`);
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  message.set(prefix);
  message.set(rawBody, prefix.byteLength);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, message);
  return `t=${timestampSeconds},v1=${hex(digest)}`;
}

function header(headers: Record<string, string | undefined>, name: string): string | null {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1]?.trim() || null;
}

function parseSignatureHeader(value: string): { timestamp: number; signature: string } {
  const fields = new Map<string, string>();
  for (const part of value.split(",")) {
    const [name, ...rest] = part.trim().split("=");
    const fieldValue = rest.join("=");
    if ((name !== "t" && name !== "v1") || !fieldValue || fields.has(name)) {
      throw new RevenueCatWebhookError("signature header format is invalid");
    }
    fields.set(name, fieldValue);
  }
  const timestampText = fields.get("t");
  const signature = fields.get("v1");
  if (!timestampText || !signature || !/^[0-9]+$/u.test(timestampText) || !/^[a-f0-9]{64}$/u.test(signature)) {
    throw new RevenueCatWebhookError("signature header format is invalid");
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || timestamp > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) throw new RevenueCatWebhookError("signature timestamp is invalid");
  return { timestamp, signature };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new RevenueCatWebhookError(`${field} is invalid`);
  return value.trim();
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RevenueCatWebhookError(`${field} is invalid`);
  return value;
}
