import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HostIdentity } from "./host.js";
import type { RuntimeConfig } from "./config.js";
import { readProcessStartInstance } from "./lifecycle.js";
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
  await ensureSecureRuntimeRoot(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ensureSecureRuntimeRoot(root);
  const target = uiTestEnvelopePath(root);
  await writeAtomic(target, UiTestEnvelopeSchema.parse(envelope), root);
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
    if (!markerBindsToCurrentDesktop(existing, hostIdentity)) {
      await rm(markerPath, { force: true });
      clearUiTestEnvironment(config);
    } else {
      if (hostIdentity) assertMarkerHost(existing, hostIdentity);
      applyUiTestEnvironment(config, existing);
      return existing;
    }
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
  await ensureSecureUiTestFile(markerPath, path.resolve(config.paths.root));
  await writeAtomic(markerPath, marker, path.resolve(config.paths.root));
  applyUiTestEnvironment(config, marker);
  return marker;
}

export function readConsumedUiTestMarkerSync(runtimeRoot: string): UiTestMarker | null {
  const root = path.resolve(runtimeRoot);
  const markerPath = uiTestMarkerPath(root);
  try {
    if (!isSecureRuntimeRootSync(root) || !isSecureUiTestFileSync(markerPath, root)) return null;
    const marker = UiTestMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, "utf8")));
    if (!marker.success || Date.parse(marker.data.expiresAt) <= Date.now()) return null;
    if (!markerBindsToLiveProcesses(marker.data)) {
      unlinkSync(markerPath);
      return null;
    }
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
    hostStartInstance: readProcessStartInstance(hostPid),
    desktopPid,
    desktopStartInstance: readProcessStartInstance(desktopPid),
    runId: envelope.runId,
    cdpAddress: envelope.cdpAddress,
    cdpPort: envelope.cdpPort,
    captureMode: envelope.captureMode,
    transcriptionMode: envelope.transcriptionMode,
    accessibility: envelope.forceAccessibility ? "forced-controlled-runtime" : "labels-only-controlled-runtime",
  });
}

function markerBindsToCurrentDesktop(marker: UiTestMarker, hostIdentity: HostIdentity | undefined): boolean {
  if (!markerBindsToLiveProcesses(marker)) return false;
  if (!hostIdentity) return true;
  return marker.identity.hostPid === process.ppid &&
    marker.identity.desktopPid === process.pid &&
    readStartInstanceOrNull(process.ppid) === marker.identity.hostStartInstance &&
    readStartInstanceOrNull(process.pid) === marker.identity.desktopStartInstance;
}

function markerBindsToLiveProcesses(marker: UiTestMarker): boolean {
  return readStartInstanceOrNull(marker.identity.hostPid) === marker.identity.hostStartInstance &&
    readStartInstanceOrNull(marker.identity.desktopPid) === marker.identity.desktopStartInstance;
}

function readStartInstanceOrNull(pid: number): string | null {
  try { return readProcessStartInstance(pid); } catch { return null; }
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
  return readRegularJson(filePath, UiTestEnvelopeSchema, path.dirname(filePath));
}

async function readUiTestMarker(filePath: string): Promise<UiTestMarker | null> {
  const root = path.dirname(filePath);
  const marker = await readRegularJson(filePath, UiTestMarkerSchema, root);
  if (!marker || Date.parse(marker.expiresAt) <= Date.now()) return null;
  if (!markerBindsToLiveProcesses(marker)) {
    await rm(filePath, { force: true });
    return null;
  }
  return marker;
}

async function readRegularJson<T>(filePath: string, schema: z.ZodType<T>, root: string): Promise<T | null> {
  try {
    await ensureSecureRuntimeRoot(root);
    await ensureSecureUiTestFile(filePath, root);
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

async function writeAtomic(filePath: string, value: unknown, root: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
    await ensureSecureUiTestFile(filePath, root);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureSecureRuntimeRoot(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (!isSecureDirectory(info)) throw new Error(`UI-test runtime root must be same-UID mode 0700: ${root}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function ensureSecureUiTestFile(filePath: string, root: string): Promise<void> {
  await ensureSecureRuntimeRoot(root);
  const info = await lstat(filePath);
  if (!isSecureRegularFile(info)) {
    throw new Error(`UI-test envelope/marker must be same-UID regular mode 0600: ${filePath}`);
  }
}

function isSecureRuntimeRootSync(root: string): boolean {
  try { return isSecureDirectory(lstatSync(root)); } catch { return false; }
}

function isSecureUiTestFileSync(filePath: string, root: string): boolean {
  try {
    if (!isSecureRuntimeRootSync(root)) return false;
    return isSecureRegularFile(lstatSync(filePath));
  } catch { return false; }
}

function isSecureDirectory(info: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && info.uid === currentUid();
}

function isSecureRegularFile(info: { isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): boolean {
  return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === currentUid();
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("UI-test file ownership cannot be verified on this platform");
  return process.getuid();
}
