import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HostIdentity } from "./host.js";
import type { RuntimeConfig } from "./config.js";
import {
  MEETLESS_DESKTOP_LOGICAL_ID,
  UiTestIdentitySchema,
  type UiTestIdentity,
} from "@meetless/plugin/readiness-protocol";

export const UI_TEST_ENVELOPE_FILENAME = "ui-test-envelope.json";
export const UI_TEST_MARKER_FILENAME = "ui-test-run.json";
export const UI_TEST_ENVELOPE_VERSION = 1 as const;

const UiTestEnvelopeSchema = z.object({
  version: z.literal(UI_TEST_ENVELOPE_VERSION),
  logicalDesktopId: z.literal(MEETLESS_DESKTOP_LOGICAL_ID),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  cdpAddress: z.literal("127.0.0.1"),
  cdpPort: z.number().int().min(1024).max(65535),
  captureMode: z.literal("fixture"),
  transcriptionMode: z.enum(["fake", "native"]),
  forceAccessibility: z.boolean(),
}).strict();

const UiTestMarkerSchema = UiTestEnvelopeSchema.extend({
  consumedAt: z.string().datetime({ offset: true }),
  identity: UiTestIdentitySchema,
}).strict();

export type UiTestEnvelope = z.infer<typeof UiTestEnvelopeSchema>;
export type UiTestMarker = z.infer<typeof UiTestMarkerSchema>;

export function uiTestEnvelopePath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), UI_TEST_ENVELOPE_FILENAME);
}

export function uiTestMarkerPath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), UI_TEST_MARKER_FILENAME);
}

export function newUiTestEnvelope(input: {
  runId?: string;
  cdpPort: number;
  transcriptionMode: "fake" | "native";
  forceAccessibility?: boolean;
  now?: Date;
  ttlMs?: number;
}): UiTestEnvelope {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000));
  return UiTestEnvelopeSchema.parse({
    version: UI_TEST_ENVELOPE_VERSION,
    logicalDesktopId: MEETLESS_DESKTOP_LOGICAL_ID,
    runId: input.runId ?? `post-m3-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    cdpAddress: "127.0.0.1",
    cdpPort: input.cdpPort,
    captureMode: "fixture",
    transcriptionMode: input.transcriptionMode,
    forceAccessibility: input.forceAccessibility ?? true,
  });
}

export async function writeUiTestEnvelope(runtimeRoot: string, envelope: UiTestEnvelope): Promise<string> {
  const root = path.resolve(runtimeRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = uiTestEnvelopePath(root);
  await writeAtomic(target, UiTestEnvelopeSchema.parse(envelope));
  return target;
}

/**
 * Consume exactly one valid envelope. Invalid or missing envelopes deliberately
 * return production mode and remain inert; they never enable CDP, fixtures, or AX.
 */
export async function activateUiTestRun(
  config: RuntimeConfig,
  hostIdentity?: HostIdentity,
): Promise<UiTestMarker | null> {
  const markerPath = uiTestMarkerPath(config.paths.root);
  const existing = await readUiTestMarker(markerPath);
  if (existing) {
    if (hostIdentity) assertMarkerHost(existing, hostIdentity);
    applyUiTestEnvironment(config, existing);
    return existing;
  }

  const envelopePath = uiTestEnvelopePath(config.paths.root);
  const envelope = await readUiTestEnvelope(envelopePath);
  if (!envelope || Date.parse(envelope.expiresAt) <= Date.now() || !hostIdentity) {
    clearUiTestEnvironment(config);
    return null;
  }

  const hostPid = process.ppid;
  if (!Number.isInteger(hostPid) || hostPid <= 1) {
    clearUiTestEnvironment(config);
    return null;
  }
  const marker = UiTestMarkerSchema.parse({
    ...envelope,
    consumedAt: new Date().toISOString(),
    identity: buildIdentity(envelope, hostIdentity, hostPid, process.pid),
  });

  // Rename first so a crash cannot leave a reusable envelope. The subsequent
  // atomic replacement is intentionally allowed to leave an invalid marker;
  // invalid markers fail closed on the next process.
  await rename(envelopePath, markerPath);
  await writeAtomic(markerPath, marker);
  applyUiTestEnvironment(config, marker);
  return marker;
}

export function readConsumedUiTestMarkerSync(runtimeRoot: string): UiTestMarker | null {
  const markerPath = uiTestMarkerPath(runtimeRoot);
  try {
    const info = lstatSync(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const marker = UiTestMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, "utf8")));
    if (!marker.success || Date.parse(marker.data.expiresAt) <= Date.now()) return null;
    return marker.data;
  } catch {
    return null;
  }
}

export async function readConsumedUiTestMarker(runtimeRoot: string): Promise<UiTestMarker | null> {
  return readUiTestMarker(uiTestMarkerPath(runtimeRoot));
}

export async function removeUiTestRunState(runtimeRoot: string): Promise<void> {
  const root = path.resolve(runtimeRoot);
  await Promise.all([
    rm(uiTestEnvelopePath(root), { force: true }),
    rm(uiTestMarkerPath(root), { force: true }),
    rm(path.join(root, "ui-test-exports"), { recursive: true, force: true }),
  ]);
}

function applyUiTestEnvironment(config: RuntimeConfig, marker: UiTestMarker): void {
  const identity: UiTestIdentity = marker.identity;
  config.paths.recordingExports = path.join(config.paths.root, "ui-test-exports");
  config.environment.MEETLESS_CAPTURE_MODE = "fixture";
  config.environment.MEETLESS_TRANSCRIPTION_MODE = marker.transcriptionMode;
  config.environment.MEETLESS_UI_TEST_MODE = "1";
  config.environment.MEETLESS_UI_TEST_RUN_ID = marker.runId;
  config.environment.MEETLESS_UI_TEST_MARKER = uiTestMarkerPath(config.paths.root);
  config.environment.MEETLESS_UI_TEST_IDENTITY = JSON.stringify(identity);
  config.environment.MEETLESS_EXPORT_ROOT = config.paths.recordingExports;
  config.environment.PASEO_ELECTRON_FLAGS =
    `--remote-debugging-address=${marker.cdpAddress} --remote-debugging-port=${marker.cdpPort}`;
}

function clearUiTestEnvironment(config: RuntimeConfig): void {
  for (const key of [
    "MEETLESS_CAPTURE_MODE",
    "MEETLESS_TRANSCRIPTION_MODE",
    "MEETLESS_UI_TEST_MODE",
    "MEETLESS_UI_TEST_RUN_ID",
    "MEETLESS_UI_TEST_MARKER",
    "MEETLESS_UI_TEST_IDENTITY",
    "PASEO_ELECTRON_FLAGS",
  ]) delete config.environment[key];
}

function buildIdentity(
  envelope: UiTestEnvelope,
  hostIdentity: HostIdentity,
  hostPid: number,
  desktopPid: number,
): UiTestIdentity {
  return UiTestIdentitySchema.parse({
    version: 1,
    logicalDesktopId: MEETLESS_DESKTOP_LOGICAL_ID,
    hostBundleIdentifier: hostIdentity.bundleIdentifier,
    hostBundlePath: hostIdentity.bundleRealPath,
    hostCdHash: hostIdentity.cdHash,
    hostPid,
    desktopPid,
    runId: envelope.runId,
    cdpAddress: envelope.cdpAddress,
    cdpPort: envelope.cdpPort,
    captureMode: envelope.captureMode,
    transcriptionMode: envelope.transcriptionMode,
    accessibility: envelope.forceAccessibility ? "forced-controlled-runtime" : "labels-only-controlled-runtime",
  });
}

function assertMarkerHost(marker: UiTestMarker, hostIdentity: HostIdentity): void {
  if (
    marker.identity.hostBundleIdentifier !== hostIdentity.bundleIdentifier ||
    path.resolve(marker.identity.hostBundlePath) !== path.resolve(hostIdentity.bundleRealPath) ||
    marker.identity.hostCdHash !== hostIdentity.cdHash
  ) {
    throw new Error(
      `UI-test envelope host identity mismatch: expected ${hostIdentity.bundleRealPath} CDHash ${hostIdentity.cdHash}, ` +
        `received ${marker.identity.hostBundlePath} CDHash ${marker.identity.hostCdHash}`,
    );
  }
}

async function readUiTestEnvelope(filePath: string): Promise<UiTestEnvelope | null> {
  return readRegularJson(filePath, UiTestEnvelopeSchema);
}

async function readUiTestMarker(filePath: string): Promise<UiTestMarker | null> {
  const marker = await readRegularJson(filePath, UiTestMarkerSchema);
  return marker && Date.parse(marker.expiresAt) > Date.now() ? marker : null;
}

async function readRegularJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
