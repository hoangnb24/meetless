import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { HostIdentity } from "./host.js";
import { REPOSITORY_ROOT, type RuntimeConfig } from "./config.js";
import { readProcessStartInstance } from "./lifecycle.js";
import {
  MEETLESS_DESKTOP_LOGICAL_ID,
  UiTestIdentitySchema,
  type UiTestIdentity,
} from "@meetless/plugin/readiness-protocol";

export const UI_TEST_ENVELOPE_FILENAME = "ui-test-envelope.json";
export const UI_TEST_MARKER_FILENAME = "ui-test-run.json";
export const UI_TEST_ENVELOPE_VERSION = 2 as const;
export const UI_TEST_EXPORT_LEASE_VERSION = 1 as const;
export const UI_TEST_EXPORT_LEASE_PARENT = "/private/tmp/meetless-package-proof-exports";
export const UI_TEST_EXPORT_LEASE_FILENAME = "meetless-export-lease.json";
export const UI_TEST_EXPORT_LEASE_TTL_MS = 15 * 60_000;

const RunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u);
const AbsolutePathSchema = z.string().refine((value) => path.isAbsolute(value), "path must be absolute");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const UiTestExportLeaseSchema = z.object({
  version: z.literal(UI_TEST_EXPORT_LEASE_VERSION),
  proofSessionId: RunIdSchema,
  restartGeneration: z.number().int().positive(),
  exportRoot: AbsolutePathSchema,
  leaseId: z.string().uuid(),
  ownerUid: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const UiTestEnvelopeSchema = z.object({
  version: z.literal(UI_TEST_ENVELOPE_VERSION),
  logicalDesktopId: z.literal(MEETLESS_DESKTOP_LOGICAL_ID),
  runId: RunIdSchema,
  proofSessionId: RunIdSchema,
  restartGeneration: z.number().int().positive(),
  exportRoot: AbsolutePathSchema,
  exportLeasePath: AbsolutePathSchema,
  exportLeaseId: z.string().uuid(),
  exportLeaseSha256: Sha256Schema,
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

export type UiTestExportLease = z.infer<typeof UiTestExportLeaseSchema>;
export type UiTestExportLeaseBinding = Pick<
  UiTestExportLease,
  "proofSessionId" | "restartGeneration" | "exportRoot" | "expiresAt"
> & {
  exportLeasePath: string;
  exportLeaseId: string;
  exportLeaseSha256: string;
};
export type UiTestEnvelope = z.infer<typeof UiTestEnvelopeSchema>;
export type UiTestMarker = z.infer<typeof UiTestMarkerSchema>;

type LeaseValidationOptions = {
  runtimeRoot: string;
  repositoryRoot?: string;
  now?: Date;
};

const exportBaselines = new WeakMap<RuntimeConfig, {
  recordingExports: string;
  environmentExportRoot: string | undefined;
}>();

export function uiTestEnvelopePath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), UI_TEST_ENVELOPE_FILENAME);
}

export function uiTestMarkerPath(runtimeRoot: string): string {
  return path.join(path.resolve(runtimeRoot), UI_TEST_MARKER_FILENAME);
}

export function uiTestExportLeasePath(exportRoot: string): string {
  return path.join(path.resolve(exportRoot), UI_TEST_EXPORT_LEASE_FILENAME);
}

export function newUiTestExportLease(input: {
  proofSessionId: string;
  restartGeneration: number;
  exportRoot?: string;
  now?: Date;
  ttlMs?: number;
  leaseId?: string;
}): UiTestExportLease {
  const now = input.now ?? new Date();
  const exportRoot = path.resolve(input.exportRoot ?? path.join(UI_TEST_EXPORT_LEASE_PARENT, input.proofSessionId));
  return UiTestExportLeaseSchema.parse({
    version: UI_TEST_EXPORT_LEASE_VERSION,
    proofSessionId: input.proofSessionId,
    restartGeneration: input.restartGeneration,
    exportRoot,
    leaseId: input.leaseId ?? randomUUID(),
    ownerUid: currentUid(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? UI_TEST_EXPORT_LEASE_TTL_MS)).toISOString(),
  });
}

/**
 * Create a secure runner-owned export root and its current lease record.
 * Reuse is allowed only for the same session and the next restart generation.
 */
export async function createUiTestExportLease(input: {
  proofSessionId: string;
  restartGeneration: number;
  runtimeRoot: string;
  repositoryRoot?: string;
  exportRoot?: string;
  now?: Date;
  ttlMs?: number;
  allowExistingRoot?: boolean;
}): Promise<UiTestExportLeaseBinding> {
  const repositoryRoot = path.resolve(input.repositoryRoot ?? REPOSITORY_ROOT);
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const lease = newUiTestExportLease(input);
  await ensureSecureLeaseParent();
  await assertLeaseRootPath(lease.exportRoot, {
    runtimeRoot,
    repositoryRoot,
    proofSessionId: lease.proofSessionId,
  });

  const existing = await readLeaseIfPresent(lease.exportRoot);
  if (existing) {
    if (!input.allowExistingRoot) {
      throw new Error(`proof export root already exists: ${lease.exportRoot}`);
    }
    if (
      existing.proofSessionId !== lease.proofSessionId ||
      existing.restartGeneration + 1 !== lease.restartGeneration ||
      existing.exportRoot !== lease.exportRoot ||
      Date.parse(existing.expiresAt) <= Date.now()
    ) {
      throw new Error("proof export lease reuse requires the same session, an active lease, and the next generation");
    }
    await ensureSecureExportRoot(lease.exportRoot);
  } else {
    await mkdir(lease.exportRoot, { recursive: false, mode: 0o700 });
    await chmod(lease.exportRoot, 0o700);
    await ensureSecureExportRoot(lease.exportRoot);
  }

  const leaseBytes = serializeLease(lease);
  const leasePath = uiTestExportLeasePath(lease.exportRoot);
  await writeBytesAtomic(leasePath, leaseBytes, lease.exportRoot);
  return bindingForLease(lease, leasePath, leaseBytes);
}

export async function validateUiTestExportLease(
  binding: UiTestExportLeaseBinding,
  options: LeaseValidationOptions,
): Promise<UiTestExportLease> {
  const root = path.resolve(options.runtimeRoot);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  await assertLeaseRootPath(binding.exportRoot, {
    runtimeRoot: root,
    repositoryRoot,
    proofSessionId: binding.proofSessionId,
  });
  await ensureSecureExportRoot(binding.exportRoot);
  const leasePath = path.resolve(binding.exportLeasePath);
  if (leasePath !== uiTestExportLeasePath(binding.exportRoot)) {
    throw new Error("proof export lease path is outside its export root");
  }
  await ensureSecureUiTestFile(leasePath, binding.exportRoot);
  const bytes = await readFile(leasePath);
  return assertLeaseBytes(binding, bytes, options.now ?? new Date());
}

export function newUiTestEnvelope(input: {
  runId?: string;
  cdpPort: number;
  transcriptionMode: "fake" | "native";
  forceAccessibility?: boolean;
  exportLease: UiTestExportLeaseBinding;
  now?: Date;
}): UiTestEnvelope {
  const now = input.now ?? new Date();
  const lease = input.exportLease;
  if (Date.parse(lease.expiresAt) <= now.getTime()) throw new Error("cannot create an envelope for an expired export lease");
  return UiTestEnvelopeSchema.parse({
    version: UI_TEST_ENVELOPE_VERSION,
    logicalDesktopId: MEETLESS_DESKTOP_LOGICAL_ID,
    runId: input.runId ?? `post-m3-${Date.now()}-${randomUUID().slice(0, 8)}`,
    proofSessionId: lease.proofSessionId,
    restartGeneration: lease.restartGeneration,
    exportRoot: lease.exportRoot,
    exportLeasePath: lease.exportLeasePath,
    exportLeaseId: lease.exportLeaseId,
    exportLeaseSha256: lease.exportLeaseSha256,
    createdAt: now.toISOString(),
    expiresAt: lease.expiresAt,
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
  rememberExportBaseline(config);
  const markerPath = uiTestMarkerPath(config.paths.root);
  const repositoryRoot = path.resolve(config.paths.plugin, "../..");
  const existing = await readUiTestMarker(markerPath, {
    runtimeRoot: config.paths.root,
    repositoryRoot,
  });
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
  const envelope = await readUiTestEnvelope(envelopePath, {
    runtimeRoot: config.paths.root,
    repositoryRoot,
  });
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
    validateUiTestExportLeaseSync(marker.data, {
      runtimeRoot: root,
      repositoryRoot: REPOSITORY_ROOT,
    });
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
  return readUiTestMarker(uiTestMarkerPath(runtimeRoot), {
    runtimeRoot: path.resolve(runtimeRoot),
    repositoryRoot: REPOSITORY_ROOT,
  });
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
  config.paths.recordingExports = marker.exportRoot;
  config.environment.MEETLESS_CAPTURE_MODE = "fixture";
  config.environment.MEETLESS_TRANSCRIPTION_MODE = marker.transcriptionMode;
  config.environment.MEETLESS_UI_TEST_MODE = "1";
  config.environment.MEETLESS_UI_TEST_RUN_ID = marker.runId;
  config.environment.MEETLESS_UI_TEST_MARKER = uiTestMarkerPath(config.paths.root);
  config.environment.MEETLESS_UI_TEST_IDENTITY = JSON.stringify(identity);
  config.environment.MEETLESS_EXPORT_ROOT = marker.exportRoot;
  config.environment.PASEO_ELECTRON_FLAGS =
    `--remote-debugging-address=${marker.cdpAddress} --remote-debugging-port=${marker.cdpPort}`;
}

function clearUiTestEnvironment(config: RuntimeConfig): void {
  const baseline = exportBaselines.get(config);
  if (baseline) {
    config.paths.recordingExports = baseline.recordingExports;
    if (baseline.environmentExportRoot === undefined) delete config.environment.MEETLESS_EXPORT_ROOT;
    else config.environment.MEETLESS_EXPORT_ROOT = baseline.environmentExportRoot;
  }
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

function rememberExportBaseline(config: RuntimeConfig): void {
  if (!exportBaselines.has(config)) {
    exportBaselines.set(config, {
      recordingExports: config.paths.recordingExports,
      environmentExportRoot: config.environment.MEETLESS_EXPORT_ROOT,
    });
  }
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

async function readUiTestEnvelope(filePath: string, options: LeaseValidationOptions): Promise<UiTestEnvelope | null> {
  const envelope = await readRegularJson(filePath, UiTestEnvelopeSchema, path.dirname(filePath));
  if (!envelope) return null;
  try {
    await validateUiTestExportLease(envelopeBinding(envelope), options);
    return envelope;
  } catch {
    return null;
  }
}

async function readUiTestMarker(filePath: string, options: LeaseValidationOptions): Promise<UiTestMarker | null> {
  const root = path.dirname(filePath);
  const marker = await readRegularJson(filePath, UiTestMarkerSchema, root);
  if (!marker || Date.parse(marker.expiresAt) <= Date.now()) return null;
  try {
    await validateUiTestExportLease(envelopeBinding(marker), options);
  } catch {
    await rm(filePath, { force: true });
    return null;
  }
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
  await writeBytesAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, root);
}

async function writeBytesAtomic(filePath: string, bytes: string | Uint8Array, root: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
    await ensureSecureUiTestFile(filePath, root);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function serializeLease(lease: UiTestExportLease): string {
  return `${JSON.stringify(lease, null, 2)}\n`;
}

function bindingForLease(lease: UiTestExportLease, leasePath: string, leaseBytes: string): UiTestExportLeaseBinding {
  return {
    proofSessionId: lease.proofSessionId,
    restartGeneration: lease.restartGeneration,
    exportRoot: lease.exportRoot,
    exportLeasePath: path.resolve(leasePath),
    exportLeaseId: lease.leaseId,
    exportLeaseSha256: createHash("sha256").update(leaseBytes).digest("hex"),
    expiresAt: lease.expiresAt,
  };
}

function envelopeBinding(envelope: UiTestEnvelope | UiTestMarker): UiTestExportLeaseBinding {
  return {
    proofSessionId: envelope.proofSessionId,
    restartGeneration: envelope.restartGeneration,
    exportRoot: envelope.exportRoot,
    exportLeasePath: envelope.exportLeasePath,
    exportLeaseId: envelope.exportLeaseId,
    exportLeaseSha256: envelope.exportLeaseSha256,
    expiresAt: envelope.expiresAt,
  };
}

function assertLeaseBytes(
  binding: UiTestExportLeaseBinding,
  bytes: Uint8Array,
  now: Date,
): UiTestExportLease {
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  if (expectedHash !== binding.exportLeaseSha256) throw new Error("proof export lease integrity hash mismatch");
  const lease = UiTestExportLeaseSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (
    lease.proofSessionId !== binding.proofSessionId ||
    lease.restartGeneration !== binding.restartGeneration ||
    lease.exportRoot !== path.resolve(binding.exportRoot) ||
    lease.leaseId !== binding.exportLeaseId ||
    lease.expiresAt !== binding.expiresAt
  ) throw new Error("proof export lease does not match the consumed envelope");
  if (Date.parse(lease.expiresAt) <= now.getTime()) throw new Error("proof export lease is expired");
  return lease;
}

function validateUiTestExportLeaseSync(binding: UiTestExportLeaseBinding, options: LeaseValidationOptions): UiTestExportLease {
  const root = path.resolve(options.runtimeRoot);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  assertLeaseRootPathSync(binding.exportRoot, {
    runtimeRoot: root,
    repositoryRoot,
    proofSessionId: binding.proofSessionId,
  });
  ensureSecureExportRootSync(binding.exportRoot);
  const leasePath = path.resolve(binding.exportLeasePath);
  if (leasePath !== uiTestExportLeasePath(binding.exportRoot)) throw new Error("proof export lease path is invalid");
  if (!isSecureUiTestFileSync(leasePath, binding.exportRoot)) throw new Error("proof export lease file is insecure");
  return assertLeaseBytes(binding, readFileSync(leasePath), options.now ?? new Date());
}

async function assertLeaseRootPath(
  exportRoot: string,
  input: { runtimeRoot: string; repositoryRoot: string; proofSessionId: string },
): Promise<void> {
  assertLeaseRootPathSync(exportRoot, input);
  const parent = path.dirname(path.resolve(exportRoot));
  const parentInfo = await lstat(parent);
  if (!isSecureDirectory(parentInfo)) throw new Error(`proof export parent must be same-UID mode 0700: ${parent}`);
}

function assertLeaseRootPathSync(
  exportRoot: string,
  input: { runtimeRoot: string; repositoryRoot: string; proofSessionId: string },
): void {
  const root = path.resolve(exportRoot);
  const parent = path.dirname(root);
  if (!path.isAbsolute(exportRoot) || parent !== UI_TEST_EXPORT_LEASE_PARENT) {
    throw new Error(`proof export root must be a direct child of ${UI_TEST_EXPORT_LEASE_PARENT}`);
  }
  if (path.basename(root) !== input.proofSessionId) throw new Error("proof export root must be named for the proof session");
  for (const forbidden of [
    path.resolve(input.runtimeRoot),
    path.resolve(input.repositoryRoot),
    path.resolve(homedir(), "Documents"),
    path.resolve(homedir(), "Documents", "meetings"),
  ]) {
    if (root === forbidden || root.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`proof export root is inside a forbidden path: ${root}`);
    }
  }
}

async function ensureSecureLeaseParent(): Promise<void> {
  await mkdir(UI_TEST_EXPORT_LEASE_PARENT, { recursive: true, mode: 0o700 });
  await chmod(UI_TEST_EXPORT_LEASE_PARENT, 0o700);
  const info = await lstat(UI_TEST_EXPORT_LEASE_PARENT);
  if (!isSecureDirectory(info)) throw new Error("proof export parent is not a secure owned directory");
}

async function ensureSecureExportRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (!isSecureDirectory(info)) throw new Error(`proof export root must be same-UID mode 0700: ${root}`);
}

function ensureSecureExportRootSync(root: string): void {
  if (!isSecureDirectory(lstatSync(root))) throw new Error(`proof export root must be same-UID mode 0700: ${root}`);
}

async function readLeaseIfPresent(exportRoot: string): Promise<UiTestExportLease | null> {
  try {
    const leasePath = uiTestExportLeasePath(exportRoot);
    await ensureSecureUiTestFile(leasePath, exportRoot);
    return UiTestExportLeaseSchema.parse(JSON.parse(await readFile(leasePath, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
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
    if (!isSecureDirectory(lstatSync(root))) return false;
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
