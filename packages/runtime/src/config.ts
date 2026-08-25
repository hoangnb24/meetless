import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  open,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PINNED_PASEO_COMMIT = "c81cb84735043c281a5a2d23d456d3708ce5d94e";
export const DEFAULT_MEETLESS_LISTEN = "127.0.0.1:6777";
export const PACKAGED_RUNTIME_ROOT = "/private/tmp/meetless-package-runtime";
export const PACKAGED_RECORDING_EXPORTS = `${PACKAGED_RUNTIME_ROOT}/exports`;
export const PACKAGED_IDENTITY_PATH = "/private/tmp/meetless-package-host-identity.json";
export const PACKAGED_RENDERER_ORIGIN = "http://127.0.0.1:18082";
const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(packageDirectory, "../../..");
const PACKAGED_MANIFEST_FILENAME = "meetless-package.json";
const PACKAGED_MANIFEST_SCHEMA = "MEETLESS_MACOS_PACKAGE v1";
const PACKAGED_MEDIA_CLOSURE_SCHEMA = "MEETLESS_PACKAGED_MEDIA_CLOSURE v1";
const PACKAGED_MEDIA_CLOSURE_DIRECTORY = "media-tools";
const PACKAGED_MEDIA_CLOSURE_MANIFEST = "media-tools.snapshot.json";
const PACKAGED_MEDIA_CLOSURE_OWNER = ".meetless-media-closure-owner.json";
const PACKAGED_MEDIA_CLOSURE_OWNER_SCHEMA = "MEETLESS_PACKAGED_MEDIA_CLOSURE_OWNER v1";

const PackagedRuntimeManifestSchema = z.object({
  schema: z.literal(PACKAGED_MANIFEST_SCHEMA),
  target: z.literal("macos-arm64"),
  bundleIdentifier: z.literal("com.meetless.app"),
  paseoCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  rendererOrigin: z.literal(PACKAGED_RENDERER_ORIGIN),
  runtimeRoot: z.literal(PACKAGED_RUNTIME_ROOT),
  recordingExports: z.literal(PACKAGED_RECORDING_EXPORTS),
  identityPath: z.literal(PACKAGED_IDENTITY_PATH),
  hostBundlePath: z.string().startsWith("/"),
  resources: z.object({
    rendererRoot: z.string().min(1),
    electronBinary: z.string().min(1),
    nodeBinary: z.string().min(1),
    captureHelper: z.string().min(1),
    ffmpeg: z.string().min(1),
    ffprobe: z.string().min(1),
  }).strict(),
}).strict();

export type PackagedRuntimeResources = {
  rendererRoot: string;
  electronBinary: string;
  nodeBinary: string;
  captureHelper: string;
  ffmpeg: string;
  ffprobe: string;
  paseoCommit: string;
};

export interface PackagedMediaClosureSnapshot {
  root: string;
  ffmpeg: string;
  ffprobe: string;
  fingerprint: string;
}

export type MediaClosurePublicationFault = "before-rename" | "after-rename";

type MediaClosureEntry = {
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
};

type MediaClosureTree = {
  rootMode: number;
  entries: MediaClosureEntry[];
  fingerprint: string;
};

type PackagedMediaClosureManifest = {
  schema: typeof PACKAGED_MEDIA_CLOSURE_SCHEMA;
  version: 1;
  runtimeRoot: string;
  targetRoot: string;
  sourceRoot: string;
  sourceFingerprint: string;
  snapshotFingerprint: string;
  rootMode: number;
  entries: MediaClosureEntry[];
  tools: {
    ffmpeg: "bin/ffmpeg";
    ffprobe: "bin/ffprobe";
  };
};

const MediaClosureEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["directory", "file", "symlink"]),
  mode: z.number().int().min(0).max(0o7777),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  target: z.string().optional(),
}).strict();

const PackagedMediaClosureManifestSchema = z.object({
  schema: z.literal(PACKAGED_MEDIA_CLOSURE_SCHEMA),
  version: z.literal(1),
  runtimeRoot: z.string().startsWith("/"),
  targetRoot: z.string().startsWith("/"),
  sourceRoot: z.string().startsWith("/"),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  rootMode: z.number().int().min(0).max(0o7777),
  entries: z.array(MediaClosureEntrySchema),
  tools: z.object({
    ffmpeg: z.literal("bin/ffmpeg"),
    ffprobe: z.literal("bin/ffprobe"),
  }).strict(),
}).strict();

type PackagedRuntimeManifest = z.infer<typeof PackagedRuntimeManifestSchema>;

export interface RuntimePaths {
  root: string;
  paseoHome: string;
  electronUserData: string;
  meetingStore: string;
  logs: string;
  daemonLog: string;
  identity: string;
  pidLock: string;
  supervisorMarker: string;
  config: string;
  manifest: string;
  plugin: string;
  captureHelper: string;
  recordingSocket: string;
  transcriptionSocket: string;
  transcriptionStaging: string;
  recordingExports: string;
}

export interface RuntimeConfig {
  packaged: boolean;
  packageResources: PackagedRuntimeResources | null;
  listen: string;
  rendererOrigin: string;
  supervisorEntrypoint: string;
  paths: RuntimePaths;
  host: {
    bundle: string;
    identity: string;
  };
  companion: {
    relayEnabled: true;
    directPasswordConfigured: boolean;
  };
  environment: NodeJS.ProcessEnv;
}

export class IsolationViolationError extends Error {
  constructor(message: string) {
    super(
      `${message}. Authority: docs/plans/active/v1-paseo-foundation.md, M6 foundation gate and Lead ruling. ` +
        "Next action: keep the Meetless runtime isolated, use a non-6767 endpoint, and configure Paseo direct authentication for LAN exposure.",
    );
    this.name = "IsolationViolationError";
  }
}

export function resolveRuntimeConfig(input: {
  runtimeRoot?: string;
  listen?: string;
  userHome?: string;
  repositoryRoot?: string;
  rendererOrigin?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): RuntimeConfig {
  const sourceEnvironment = input.environment ?? process.env;
  const userHome = path.resolve(input.userHome ?? homedir());
  const repositoryRoot = path.resolve(input.repositoryRoot ?? REPOSITORY_ROOT);
  const packagedManifest = readPackagedRuntimeManifest(repositoryRoot);
  const packaged = packagedManifest !== null;
  const packageResources = packagedManifest
    ? resolvePackagedRuntimeResources(repositoryRoot, packagedManifest)
    : null;
  const requestedRuntimeRoot = input.runtimeRoot ?? sourceEnvironment.MEETLESS_RUNTIME_ROOT;
  if (packagedManifest && requestedRuntimeRoot && path.resolve(requestedRuntimeRoot) !== packagedManifest.runtimeRoot) {
    throw new Error(
      `Packaged runtime root ${requestedRuntimeRoot} differs from the accepted ${packagedManifest.runtimeRoot}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: use the package-owned runtime root.",
    );
  }
  const root = path.resolve(
    packagedManifest?.runtimeRoot ?? requestedRuntimeRoot ?? path.join(repositoryRoot, ".meetless-runtime"),
  );
  const listen = (input.listen ?? DEFAULT_MEETLESS_LISTEN).trim();
  const listenAddress = parseMeetlessListen(listen);
  const configuredDirectPassword = sourceEnvironment.MEETLESS_DIRECT_PASSWORD ?? sourceEnvironment.PASEO_PASSWORD;
  const directPassword = configuredDirectPassword?.trim();
  if (configuredDirectPassword !== undefined && !directPassword) {
    throw new IsolationViolationError(
      "Meetless direct password is blank. Set MEETLESS_DIRECT_PASSWORD to a non-blank daemon secret",
    );
  }
  if (!listenAddress.loopback && !directPassword) {
    throw new IsolationViolationError(
      `Meetless LAN listener ${listen} has no direct password. ` +
      "Set MEETLESS_DIRECT_PASSWORD before exposing the isolated daemon",
    );
  }
  const requestedRendererOrigin = input.rendererOrigin ?? sourceEnvironment.MEETLESS_RENDERER_ORIGIN;
  const rendererOrigin = resolveRendererOrigin(
    packagedManifest?.rendererOrigin ?? requestedRendererOrigin ?? "http://127.0.0.1:8082",
  );
  if (packagedManifest && requestedRendererOrigin && resolveRendererOrigin(requestedRendererOrigin) !== rendererOrigin) {
    throw new Error(
      `Packaged renderer origin ${requestedRendererOrigin} differs from the host-configured ${rendererOrigin}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: use the packaged renderer origin.",
    );
  }
  const supervisorEntrypoint = path.join(
    repositoryRoot,
    "vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  const paths: RuntimePaths = {
    root,
    paseoHome: path.join(root, "paseo-home"),
    electronUserData: path.join(root, "electron-user-data"),
    meetingStore: path.join(root, "meeting-store"),
    logs: path.join(root, "logs"),
    daemonLog: path.join(root, "logs", "daemon.log"),
    identity: path.join(root, "paseo-home", "server-id"),
    pidLock: path.join(root, "paseo-home", "paseo.pid"),
    supervisorMarker: path.join(root, "paseo-home", "meetless-supervisor-owner.json"),
    config: path.join(root, "paseo-home", "config.json"),
    manifest: path.join(root, "runtime.json"),
    plugin: path.join(repositoryRoot, "packages", "meetless-plugin"),
    captureHelper: packageResources?.captureHelper ??
      path.join(repositoryRoot, "native", "macos-capture", ".build", "release", "meetless-capture"),
    recordingSocket: resolveRecordingSocket(path.join(root, "paseo-home")),
    transcriptionSocket: path.join(root, "transcription.sock"),
    transcriptionStaging: path.join(root, "meeting-store", "transcription-ranges"),
    recordingExports: packagedManifest?.recordingExports ??
      path.resolve(sourceEnvironment.MEETLESS_EXPORT_ROOT?.trim() || path.join(userHome, "Documents", "meetings")),
  };
  assertIsolated(paths, listen, userHome);
  const inheritedEnvironment = copyEnvironmentWithoutUiTestControls(
    copyEnvironmentWithoutDirectPasswordSecrets(copyEnvironmentWithoutOpenAiSecrets(sourceEnvironment)),
  );
  return {
    packaged,
    packageResources,
    listen,
    rendererOrigin,
    supervisorEntrypoint,
    paths,
    host: {
      bundle: packagedManifest?.hostBundlePath ?? path.join(userHome, "Applications", "Meetless.app"),
      identity: packagedManifest?.identityPath ?? path.join(userHome, "Library", "Application Support", "Meetless", "host-identity.json"),
    },
    companion: {
      relayEnabled: true,
      directPasswordConfigured: Boolean(directPassword),
    },
    environment: {
      ...inheritedEnvironment,
      PASEO_HOME: paths.paseoHome,
      PASEO_LISTEN: listen,
      PASEO_ELECTRON_USER_DATA_DIR: paths.electronUserData,
      PASEO_LOG_FILE_PATH: paths.daemonLog,
      PASEO_RELAY_ENABLED: "true",
      ...(directPassword ? { PASEO_PASSWORD: directPassword } : {}),
      PASEO_MCP_ENABLED: "false",
      PASEO_DESKTOP_MANAGED: "1",
      MEETLESS_RUNTIME_ROOT: paths.root,
      MEETLESS_STORE_ROOT: paths.meetingStore,
      MEETLESS_RENDERER_ORIGIN: rendererOrigin,
      MEETLESS_PINNED_SUPERVISOR_ENTRYPOINT: supervisorEntrypoint,
      PASEO_TEST_APP_NAME: "Meetless",
      MEETLESS_CAPTURE_HELPER: paths.captureHelper,
      MEETLESS_RECORDING_SOCKET: paths.recordingSocket,
      MEETLESS_TRANSCRIPTION_SOCKET: paths.transcriptionSocket,
      MEETLESS_TRANSCRIPTION_STAGING: paths.transcriptionStaging,
      MEETLESS_EXPORT_ROOT: paths.recordingExports,
      MEETLESS_FFMPEG: resolveHostTool("MEETLESS_FFMPEG", "ffmpeg", sourceEnvironment, packageResources?.ffmpeg),
      MEETLESS_FFPROBE: resolveHostTool("MEETLESS_FFPROBE", "ffprobe", sourceEnvironment, packageResources?.ffprobe),
    },
  };
}

export function copyEnvironmentWithoutOpenAiSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => !isOpenAiSecretEnvironmentEntry(key, value)),
  );
}

export function copyEnvironmentWithoutUiTestControls(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const controls = new Set([
    "MEETLESS_CAPTURE_MODE",
    "MEETLESS_TRANSCRIPTION_MODE",
    "MEETLESS_UI_TEST_MODE",
    "MEETLESS_UI_TEST_RUN_ID",
    "MEETLESS_UI_TEST_MARKER",
    "MEETLESS_UI_TEST_IDENTITY",
    "PASEO_ELECTRON_FLAGS",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !controls.has(key)));
}

export function copyEnvironmentWithoutDirectPasswordSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      key !== "MEETLESS_DIRECT_PASSWORD" && key !== "PASEO_PASSWORD"),
  );
}

export function isOpenAiSecretEnvironmentEntry(key: string, value: string | undefined): boolean {
  const normalizedKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const openAiSecretName = normalizedKey.includes("OPENAI") &&
    ["KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD"].some((marker) => normalizedKey.includes(marker));
  const openAiSecretValue = /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}$/.test(value?.trim() ?? "");
  return openAiSecretName || openAiSecretValue;
}

function readPackagedRuntimeManifest(repositoryRoot: string): PackagedRuntimeManifest | null {
  const markerPath = path.join(repositoryRoot, PACKAGED_MANIFEST_FILENAME);
  if (!existsSync(markerPath)) return null;
  try {
    const manifest = PackagedRuntimeManifestSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));
    const acceptedHost = path.resolve(homedir(), "Applications", "Meetless.app");
    if (manifest.hostBundlePath !== acceptedHost) {
      throw new Error(`Packaged host path ${manifest.hostBundlePath} is not the accepted ${acceptedHost}`);
    }
    return manifest;
  } catch (error) {
    throw new Error(
      `Packaged Meetless runtime marker is missing or invalid at ${markerPath}: ${describe(error)}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: rebuild the complete macOS package; do not fall back to repository resources.",
    );
  }
}

function resolvePackagedRuntimeResources(
  repositoryRoot: string,
  manifest: PackagedRuntimeManifest,
): PackagedRuntimeResources {
  const resources = Object.fromEntries(
    Object.entries(manifest.resources).map(([name, relativePath]) => {
      if (path.isAbsolute(relativePath)) {
        throw new Error(`Packaged resource ${name} must be relative to ${repositoryRoot}`);
      }
      const resolved = path.resolve(repositoryRoot, relativePath);
      const relative = path.relative(repositoryRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Packaged resource ${name} escapes the package root: ${relativePath}`);
      }
      assertPackagedResourceResolution(resolved, repositoryRoot, name);
      return [name, resolved];
    }),
  ) as Record<keyof PackagedRuntimeManifest["resources"], string>;
  assertPackagedDirectory(resources.rendererRoot, "renderer");
  for (const [name, resourcePath] of Object.entries(resources)) {
    if (name === "rendererRoot") continue;
    assertPackagedRegularFile(resourcePath, name);
  }
  return { ...resources, paseoCommit: manifest.paseoCommit };
}

function assertPackagedResourceResolution(candidate: string, packageRoot: string, label: string): void {
  let packageRootReal;
  try {
    packageRootReal = realpathSync(packageRoot);
  } catch (error) {
    throw new Error(`Packaged package root is unavailable: ${describe(error)}`);
  }
  const stats = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(`Packaged ${label} resource is missing: ${candidate}`);
  }
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(candidate);
    if (path.isAbsolute(target)) {
      throw new Error(`Packaged ${label} resource uses an absolute symlink target: ${target}`);
    }
    const lexicalTarget = path.resolve(path.dirname(candidate), target);
    if (!isSameOrDescendant(lexicalTarget, packageRoot)) {
      throw new Error(`Packaged ${label} resource symlink escapes the package root: ${target}`);
    }
  }
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    throw new Error(`Packaged ${label} resource symlink is dangling or unavailable: ${describe(error)}`);
  }
  if (!isSameOrDescendant(resolved, packageRootReal)) {
    throw new Error(`Packaged ${label} resource resolves outside the package root: ${resolved}`);
  }
}

function assertPackagedDirectory(candidate: string, label: string): void {
  if (!statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Packaged ${label} resource is missing: ${candidate}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: rebuild the macOS package with all emitted resources.",
    );
  }
}

function assertPackagedRegularFile(candidate: string, label: string): void {
  if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Packaged ${label} resource is missing: ${candidate}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: rebuild the macOS package with the resource inside the artifact.",
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveHostTool(
  environmentName: string,
  executable: string,
  environment = process.env,
  packagedPath?: string,
): string {
  if (packagedPath) {
    assertPackagedRegularFile(packagedPath, executable);
    return packagedPath;
  }
  const configured = environment[environmentName]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`${environmentName} must be an absolute path`);
    return configured;
  }
  const resolved = execFileSync("which", [executable], {
    encoding: "utf8",
    env: copyEnvironmentWithoutOpenAiSecrets(environment),
  }).trim();
  if (!path.isAbsolute(resolved)) throw new Error(`Could not resolve an absolute ${executable} path`);
  return resolved;
}

function resolveRendererOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new IsolationViolationError(`Meetless renderer origin must be loopback HTTP, received ${value}`);
  }
  return url.origin;
}

export function assertIsolated(paths: RuntimePaths, listen: string, userHome = homedir()): void {
  const parsed = parseMeetlessListen(listen);
  if (parsed.port === 6767) {
    throw new IsolationViolationError(`Refusing production Paseo port 6767 (${listen})`);
  }
  if (parsed.port < 1024 || parsed.port > 65535) {
    throw new IsolationViolationError(`Refusing invalid Meetless daemon port (${listen})`);
  }
  const productionHome = path.resolve(userHome, ".paseo");
  if (isSameOrDescendant(paths.root, productionHome) || isSameOrDescendant(productionHome, paths.root)) {
    throw new IsolationViolationError(`Refusing production Paseo home ${productionHome}`);
  }
  const productionUserData = productionElectronPaths(path.resolve(userHome));
  for (const candidate of Object.values(paths)) {
    if (
      candidate === paths.plugin || candidate === paths.captureHelper ||
      candidate === paths.recordingSocket || candidate === paths.transcriptionSocket || candidate === paths.recordingExports
    ) continue;
    if (!isSameOrDescendant(candidate, paths.root)) {
      throw new IsolationViolationError(`Runtime path escapes the isolated root: ${candidate}`);
    }
    if (productionUserData.some((production) => isSameOrDescendant(candidate, production))) {
      throw new IsolationViolationError(`Refusing production Paseo Electron user-data ${candidate}`);
    }
  }
}

function resolveRecordingSocket(paseoHome: string): string {
  const inHome = path.join(paseoHome, "recording-control.sock");
  if (process.platform !== "darwin" || Buffer.byteLength(inHome) <= DARWIN_UNIX_SOCKET_PATH_BYTES) {
    return inHome;
  }
  const identity = createHash("sha256").update(paseoHome).digest("hex").slice(0, 24);
  return `/private/tmp/meetless-recording-${identity}.sock`;
}

function parseMeetlessListen(listen: string): { host: string; port: number; loopback: boolean } {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)$/.exec(listen);
  if (!match) {
    throw new IsolationViolationError(
      `Meetless host listener must use loopback or the password-protected 0.0.0.0 wildcard, received "${listen}"`,
    );
  }
  const host = match[1] ?? "";
  for (const octet of host.split(".")) {
    if (/^\d+$/u.test(octet) && Number(octet) > 255) {
      throw new IsolationViolationError(`Meetless companion listener has an invalid IPv4 address: "${listen}"`);
    }
  }
  return {
    host,
    port: Number(match[2]),
    loopback: host === "127.0.0.1" || host === "localhost" || host === "[::1]",
  };
}

function productionElectronPaths(userHome: string): string[] {
  return [
    path.join(userHome, "Library", "Application Support", "Paseo"),
    path.join(userHome, ".config", "Paseo"),
    path.join(userHome, "AppData", "Roaming", "Paseo"),
  ].map((candidate) => path.resolve(candidate));
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function prepareRuntime(config: RuntimeConfig): Promise<void> {
  if (config.packaged) assertPackagedPaseo(config);
  else assertPinnedPaseo(config.paths.plugin);
  await Promise.all(
    [
      config.paths.root,
      config.paths.paseoHome,
      config.paths.electronUserData,
      config.paths.meetingStore,
      config.paths.logs,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  const [ffmpeg, ffprobe] = config.packaged
    ? await packagedMediaTools(config)
    : await developmentMediaTools(config);
  config.environment.MEETLESS_FFMPEG = ffmpeg;
  config.environment.MEETLESS_FFPROBE = ffprobe;
  await assertExistingConfigReadable(config.paths.config);
  const daemonConfig = {
    version: 1,
    daemon: {
      listen: config.listen,
      cors: { allowedOrigins: [config.rendererOrigin] },
      relay: { enabled: true },
      mcp: { enabled: false, injectIntoAgents: false },
      browserTools: { enabled: false },
    },
    pluginsEnabled: true,
    plugins: {
      meetless: {
        source: "directory",
        path: config.paths.plugin,
        enabled: true,
      },
    },
    log: { file: { path: config.paths.daemonLog } },
  };
  const manifest = {
    version: 1,
    paseoCommit: PINNED_PASEO_COMMIT,
    listen: config.listen,
    paths: config.paths,
  };
  await writeJsonAtomic(config.paths.config, daemonConfig);
  await writeJsonAtomic(config.paths.manifest, manifest);
}

async function packagedMediaTools(config: RuntimeConfig): Promise<[string, string]> {
  if (!config.packageResources) {
    throw new Error(
      "Packaged media resources are missing. Authority: docs/plans/active/v1-paseo-foundation.md. " +
        "Next action: rebuild the package with the complete signed media closure; do not use host tools.",
    );
  }
  const snapshot = await snapshotPackagedMediaClosure({
    runtimeRoot: config.paths.root,
    ffmpeg: config.packageResources.ffmpeg,
    ffprobe: config.packageResources.ffprobe,
  });
  return [snapshot.ffmpeg, snapshot.ffprobe];
}

async function developmentMediaTools(config: RuntimeConfig): Promise<[string, string]> {
  const toolDirectory = path.join(config.paths.root, PACKAGED_MEDIA_CLOSURE_DIRECTORY);
  return Promise.all([
    snapshotRuntimeTool(config.environment.MEETLESS_FFMPEG, path.join(toolDirectory, "ffmpeg"), "ffmpeg"),
    snapshotRuntimeTool(config.environment.MEETLESS_FFPROBE, path.join(toolDirectory, "ffprobe"), "ffprobe"),
  ]);
}

/**
 * Snapshot the complete packaged ffmpeg/ffprobe closure before the daemon starts.
 * The returned paths are runtime-owned and remain usable if the canonical package
 * is later replaced. A present but invalid snapshot is never repaired silently.
 */
export async function snapshotPackagedMediaClosure(input: {
  runtimeRoot: string;
  ffmpeg: string;
  ffprobe: string;
  faultAt?: MediaClosurePublicationFault;
}): Promise<PackagedMediaClosureSnapshot> {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  await assertSecureRuntimeDirectory(runtimeRoot);
  const source = derivePackagedMediaRoot(input.ffmpeg, input.ffprobe);
  const targetRoot = path.join(runtimeRoot, PACKAGED_MEDIA_CLOSURE_DIRECTORY);
  const manifestPath = path.join(targetRoot, PACKAGED_MEDIA_CLOSURE_MANIFEST);
  assertContainedPath(targetRoot, runtimeRoot, "packaged media snapshot");
  assertContainedPath(manifestPath, runtimeRoot, "packaged media snapshot manifest");
  await cleanupOwnedMediaStaging(runtimeRoot, targetRoot);

  const targetState = await inspectPath(targetRoot);
  if (targetState.exists) {
    if (targetState.kind !== "directory") {
      throw mediaClosureError(`packaged media snapshot ownership is invalid at ${targetRoot}`);
    }
    await assertOwnedMediaDirectory(targetRoot, "packaged media snapshot");
    await assertMediaClosureOwner(targetRoot, { runtimeRoot, targetRoot });
    const manifest = await readMediaClosureManifest(manifestPath);
    assertMediaClosureManifestOwner(manifest, { runtimeRoot, targetRoot, sourceRoot: source.root });
    const snapshotTree = await inspectMediaTree(targetRoot, "snapshot", mediaClosureMetadataNames());
    assertMediaClosureTreeMatchesManifest(snapshotTree, manifest, targetRoot);
    const sourceTree = await inspectSourceIfPresent(source.root, source.ffmpeg, source.ffprobe);
    if (sourceTree && sourceTree.fingerprint !== manifest.sourceFingerprint) {
      throw mediaClosureError(
        `packaged media source changed for ${source.root}; refusing a wrong-source snapshot`,
      );
    }
    return packagedMediaSnapshot(targetRoot, manifest.snapshotFingerprint);
  }

  const sourceTree = await inspectSourceRequired(source.root, source.ffmpeg, source.ffprobe);
  const temporaryRoot = path.join(
    runtimeRoot,
    `${PACKAGED_MEDIA_CLOSURE_DIRECTORY}.staging-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporaryRoot, { recursive: false, mode: sourceTree.rootMode });
  await writeMediaClosureOwner(temporaryRoot, { runtimeRoot, targetRoot });
  let published = false;
  let preserveStaging = false;
  try {
    await chmod(temporaryRoot, sourceTree.rootMode);
    await copyMediaTree(source.root, temporaryRoot, sourceTree);
    const copiedTree = await inspectMediaTree(temporaryRoot, "staged snapshot", mediaClosureMetadataNames());
    if (copiedTree.fingerprint !== sourceTree.fingerprint) {
      throw mediaClosureError("packaged media closure changed during atomic snapshot");
    }
    const manifest: PackagedMediaClosureManifest = {
      schema: PACKAGED_MEDIA_CLOSURE_SCHEMA,
      version: 1,
      runtimeRoot,
      targetRoot,
      sourceRoot: source.root,
      sourceFingerprint: sourceTree.fingerprint,
      snapshotFingerprint: copiedTree.fingerprint,
      rootMode: copiedTree.rootMode,
      entries: copiedTree.entries,
      tools: { ffmpeg: "bin/ffmpeg", ffprobe: "bin/ffprobe" },
    };
    await writeJsonAtomic(path.join(temporaryRoot, PACKAGED_MEDIA_CLOSURE_MANIFEST), manifest);
    if (input.faultAt === "before-rename") {
      preserveStaging = true;
      throw mediaClosureError("injected crash before media closure publication");
    }
    await rename(temporaryRoot, targetRoot);
    published = true;
    if (input.faultAt === "after-rename") {
      throw mediaClosureError("injected crash after media closure publication");
    }
    const publishedManifest = await readMediaClosureManifest(manifestPath);
    await assertMediaClosureOwner(targetRoot, { runtimeRoot, targetRoot });
    assertMediaClosureManifestOwner(publishedManifest, { runtimeRoot, targetRoot, sourceRoot: source.root });
    const publishedTree = await inspectMediaTree(targetRoot, "published snapshot", mediaClosureMetadataNames());
    assertMediaClosureTreeMatchesManifest(publishedTree, publishedManifest, targetRoot);
    return packagedMediaSnapshot(targetRoot, publishedManifest.snapshotFingerprint);
  } finally {
    if (!published && !preserveStaging) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function derivePackagedMediaRoot(ffmpegValue: string, ffprobeValue: string): {
  root: string;
  ffmpeg: string;
  ffprobe: string;
} {
  if (!path.isAbsolute(ffmpegValue) || !path.isAbsolute(ffprobeValue)) {
    throw mediaClosureError("packaged ffmpeg and ffprobe resources must be absolute paths");
  }
  const ffmpeg = path.resolve(ffmpegValue);
  const ffprobe = path.resolve(ffprobeValue);
  const bin = path.dirname(ffmpeg);
  if (
    path.basename(ffmpeg) !== "ffmpeg" ||
    path.basename(ffprobe) !== "ffprobe" ||
    path.dirname(ffprobe) !== bin ||
    path.basename(bin) !== "bin"
  ) {
    throw mediaClosureError(
      "packaged ffmpeg and ffprobe must be sibling resources under one media/bin directory",
    );
  }
  const root = path.dirname(bin);
  if (path.basename(root) !== "media") {
    throw mediaClosureError(`packaged media root must be the package media directory, received ${root}`);
  }
  return { root, ffmpeg, ffprobe };
}

async function inspectSourceRequired(sourceRoot: string, ffmpeg: string, ffprobe: string): Promise<MediaClosureTree> {
  const sourceState = await inspectPath(sourceRoot);
  if (!sourceState.exists) {
    throw mediaClosureError(`packaged media closure is missing at ${sourceRoot}`);
  }
  return inspectSourceTree(sourceRoot, ffmpeg, ffprobe);
}

async function inspectSourceIfPresent(
  sourceRoot: string,
  ffmpeg: string,
  ffprobe: string,
): Promise<MediaClosureTree | null> {
  const sourceState = await inspectPath(sourceRoot);
  if (!sourceState.exists) return null;
  return inspectSourceTree(sourceRoot, ffmpeg, ffprobe);
}

async function inspectSourceTree(sourceRoot: string, ffmpeg: string, ffprobe: string): Promise<MediaClosureTree> {
  const tree = await inspectMediaTree(sourceRoot, "packaged source");
  const rootReal = await realpath(sourceRoot);
  for (const [label, tool] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]] as const) {
    const toolEntry = tree.entries.find((entry) => entry.path === `bin/${label}`);
    if (!toolEntry || !["file", "symlink"].includes(toolEntry.kind)) {
      throw mediaClosureError(`packaged ${label} is not a file in ${sourceRoot}/bin`);
    }
    const resolvedTool = await realpath(tool).catch((error: unknown) => {
      throw mediaClosureError(`packaged ${label} cannot be resolved: ${describe(error)}`);
    });
    if (!isSameOrDescendant(resolvedTool, rootReal)) {
      throw mediaClosureError(`packaged ${label} resolves outside the media closure`);
    }
    const toolStats = await stat(resolvedTool);
    if (!toolStats.isFile() || toolStats.size <= 0) {
      throw mediaClosureError(`packaged ${label} must resolve to a non-empty regular file`);
    }
  }
  const binEntry = tree.entries.find((entry) => entry.path === "bin");
  const libEntry = tree.entries.find((entry) => entry.path === "lib");
  if (binEntry?.kind !== "directory" || libEntry?.kind !== "directory") {
    throw mediaClosureError(
      `packaged media closure must contain sibling bin and lib directories under ${sourceRoot}`,
    );
  }
  return tree;
}

async function inspectMediaTree(root: string, label: string, ignoredNames = new Set<string>()): Promise<MediaClosureTree> {
  const rootStats = await lstat(root).catch((error: unknown) => {
    throw mediaClosureError(`${label} root ${root} is unavailable: ${describe(error)}`);
  });
  if (!rootStats.isDirectory()) {
    throw mediaClosureError(`${label} root ${root} is not a directory`);
  }
  const entries: MediaClosureEntry[] = [];
  await collectMediaEntries(root, root, entries, label, ignoredNames);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const rootMode = rootStats.mode & 0o7777;
  return {
    rootMode,
    entries,
    fingerprint: fingerprintMediaTree(rootMode, entries),
  };
}

async function collectMediaEntries(
  root: string,
  current: string,
  entries: MediaClosureEntry[],
  label: string,
  ignoredNames: Set<string>,
): Promise<void> {
  const names = await readdir(current);
  for (const name of names) {
    if (current === root && ignoredNames.has(name)) continue;
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute);
    assertRelativeClosurePath(relative, `${label} entry`);
    const stats = await lstat(absolute).catch((error: unknown) => {
      throw mediaClosureError(`${label} entry ${absolute} is unavailable: ${describe(error)}`);
    });
    const mode = stats.mode & 0o7777;
    if (stats.isDirectory()) {
      entries.push({ path: relative, kind: "directory", mode });
      await collectMediaEntries(root, absolute, entries, label, ignoredNames);
      continue;
    }
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolute).catch((error: unknown) => {
        throw mediaClosureError(`${label} symlink ${absolute} cannot be read: ${describe(error)}`);
      });
      if (path.isAbsolute(target)) {
        throw mediaClosureError(`${label} symlink ${absolute} uses an absolute target`);
      }
      const resolvedTarget = await realpath(absolute).catch((error: unknown) => {
        throw mediaClosureError(`${label} symlink ${absolute} is dangling: ${describe(error)}`);
      });
      const rootReal = await realpath(root);
      if (!isSameOrDescendant(resolvedTarget, rootReal)) {
        throw mediaClosureError(`${label} symlink ${absolute} escapes ${root}`);
      }
      entries.push({ path: relative, kind: "symlink", mode, target });
      continue;
    }
    if (stats.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({
        path: relative,
        kind: "file",
        mode,
        size: stats.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      continue;
    }
    throw mediaClosureError(`${label} entry ${absolute} has an unsupported file type`);
  }
}

function fingerprintMediaTree(rootMode: number, entries: MediaClosureEntry[]): string {
  return createHash("sha256").update(JSON.stringify({ rootMode, entries })).digest("hex");
}

async function copyMediaTree(sourceRoot: string, targetRoot: string, tree: MediaClosureTree): Promise<void> {
  const directories = tree.entries
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => left.path.split(path.sep).length - right.path.split(path.sep).length);
  for (const entry of directories) {
    const target = path.join(targetRoot, entry.path);
    await mkdir(target, { recursive: false, mode: entry.mode });
    await chmod(target, entry.mode);
  }
  for (const entry of tree.entries.filter((candidate) => candidate.kind !== "directory")) {
    const source = path.join(sourceRoot, entry.path);
    const target = path.join(targetRoot, entry.path);
    if (entry.kind === "symlink") {
      await symlink(entry.target!, target);
    } else {
      await copyFile(source, target);
      await chmod(target, entry.mode);
    }
  }
}

async function inspectPath(candidate: string): Promise<{ exists: boolean; kind?: "directory" | "file" | "other" }> {
  try {
    const stats = await lstat(candidate);
    return {
      exists: true,
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    throw error;
  }
}

async function assertSecureRuntimeDirectory(runtimeRoot: string): Promise<void> {
  const stats = await lstat(runtimeRoot).catch((error: unknown) => {
    throw mediaClosureError(`runtime root ${runtimeRoot} is unavailable: ${describe(error)}`);
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw mediaClosureError(`runtime root ${runtimeRoot} is not an owned secure directory`);
  }
}

function mediaClosureMetadataNames(): Set<string> {
  return new Set([PACKAGED_MEDIA_CLOSURE_MANIFEST, PACKAGED_MEDIA_CLOSURE_OWNER]);
}

async function cleanupOwnedMediaStaging(runtimeRoot: string, targetRoot: string): Promise<void> {
  const names = await readdir(runtimeRoot);
  const prefix = `${PACKAGED_MEDIA_CLOSURE_DIRECTORY}.staging-`;
  for (const name of names.filter((candidate) => candidate.startsWith(prefix))) {
    const stagingRoot = path.join(runtimeRoot, name);
    assertContainedPath(stagingRoot, runtimeRoot, "packaged media staging");
    const state = await inspectPath(stagingRoot);
    if (!state.exists || state.kind !== "directory") continue;
    const stats = await lstat(stagingRoot);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) continue;
    try {
      await assertMediaClosureOwner(stagingRoot, { runtimeRoot, targetRoot });
    } catch {
      continue;
    }
    await rm(stagingRoot, { recursive: true, force: false });
  }
}

async function assertOwnedMediaDirectory(directory: string, label: string): Promise<void> {
  const stats = await lstat(directory).catch((error: unknown) => {
    throw mediaClosureError(`${label} is unavailable: ${describe(error)}`);
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
    throw mediaClosureError(`${label} is not an owned directory`);
  }
}

async function writeMediaClosureOwner(directory: string, expected: { runtimeRoot: string; targetRoot: string }): Promise<void> {
  await writeJsonAtomic(path.join(directory, PACKAGED_MEDIA_CLOSURE_OWNER), {
    schema: PACKAGED_MEDIA_CLOSURE_OWNER_SCHEMA,
    runtimeRoot: expected.runtimeRoot,
    targetRoot: expected.targetRoot,
    ownerUid: typeof process.getuid === "function" ? process.getuid() : null,
  });
}

async function assertMediaClosureOwner(directory: string, expected: { runtimeRoot: string; targetRoot: string }): Promise<void> {
  const ownerPath = path.join(directory, PACKAGED_MEDIA_CLOSURE_OWNER);
  const stats = await lstat(ownerPath).catch((error: unknown) => {
    throw mediaClosureError(`packaged media closure owner marker is unavailable: ${describe(error)}`);
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw mediaClosureError(`packaged media closure owner marker is not private and owned: ${ownerPath}`);
  }
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (
      owner.schema !== PACKAGED_MEDIA_CLOSURE_OWNER_SCHEMA ||
      owner.runtimeRoot !== expected.runtimeRoot ||
      owner.targetRoot !== expected.targetRoot ||
      (uid !== undefined && owner.ownerUid !== uid)
    ) throw new Error("owner marker identity differs");
  } catch (error) {
    throw mediaClosureError(`packaged media closure owner marker is invalid: ${describe(error)}`);
  }
}

function assertContainedPath(candidate: string, parent: string, label: string): void {
  if (!isSameOrDescendant(candidate, parent) || path.resolve(candidate) === path.resolve(parent)) {
    throw mediaClosureError(`${label} escapes its owned runtime root`);
  }
}

function assertRelativeClosurePath(candidate: string, label: string): void {
  if (
    !candidate ||
    path.isAbsolute(candidate) ||
    candidate === "." ||
    candidate.split(path.sep).some((part) => part === ".." || part === "")
  ) {
    throw mediaClosureError(`${label} is not a secure relative path: ${candidate}`);
  }
}

async function readMediaClosureManifest(manifestPath: string): Promise<PackagedMediaClosureManifest> {
  const stats = await lstat(manifestPath).catch((error: unknown) => {
    throw mediaClosureError(`packaged media snapshot manifest is unavailable: ${describe(error)}`);
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw mediaClosureError(`packaged media snapshot manifest is not an owned private file: ${manifestPath}`);
  }
  try {
    return PackagedMediaClosureManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    throw mediaClosureError(`packaged media snapshot manifest is invalid: ${describe(error)}`);
  }
}

function assertMediaClosureManifestOwner(
  manifest: PackagedMediaClosureManifest,
  expected: { runtimeRoot: string; targetRoot: string; sourceRoot: string },
): void {
  if (
    manifest.runtimeRoot !== expected.runtimeRoot ||
    manifest.targetRoot !== expected.targetRoot ||
    manifest.sourceRoot !== expected.sourceRoot ||
    manifest.tools.ffmpeg !== "bin/ffmpeg" ||
    manifest.tools.ffprobe !== "bin/ffprobe" ||
    manifest.rootMode !== (manifest.rootMode & 0o7777) ||
    manifest.entries.some((entry) => {
      try {
        assertRelativeClosurePath(entry.path, "media snapshot manifest entry");
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw mediaClosureError("packaged media snapshot ownership or layout does not match this runtime");
  }
}

function assertMediaClosureTreeMatchesManifest(
  tree: MediaClosureTree,
  manifest: PackagedMediaClosureManifest,
  targetRoot: string,
): void {
  if (
    tree.rootMode !== manifest.rootMode ||
    tree.fingerprint !== manifest.snapshotFingerprint ||
    fingerprintMediaTree(manifest.rootMode, manifest.entries) !== manifest.snapshotFingerprint
  ) {
    throw mediaClosureError(`packaged media snapshot is missing, tampered, or partial at ${targetRoot}`);
  }
}

function packagedMediaSnapshot(targetRoot: string, fingerprint: string): PackagedMediaClosureSnapshot {
  return {
    root: targetRoot,
    ffmpeg: path.join(targetRoot, "bin", "ffmpeg"),
    ffprobe: path.join(targetRoot, "bin", "ffprobe"),
    fingerprint,
  };
}

function mediaClosureError(message: string): Error {
  return new Error(
    `${message}. Authority: docs/plans/active/v1-paseo-foundation.md, packaged media-closure boundary. ` +
      "Next action: rebuild or remove only the owned proof runtime; do not fall back to source or host tools.",
  );
}

async function snapshotRuntimeTool(sourceValue: string | undefined, target: string, label: string): Promise<string> {
  if (!sourceValue || !path.isAbsolute(sourceValue)) throw new Error(`Resolved ${label} path must be absolute`);
  const source = await realpath(sourceValue);
  if (source === target) return target;
  const sourceStats = await stat(source);
  if (!sourceStats.isFile() || sourceStats.size <= 0) throw new Error(`${label} must resolve to a regular non-empty file`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o700);
    const [sourceBytes, copiedBytes] = await Promise.all([readFile(source), readFile(temporary)]);
    const identity = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (sourceBytes.byteLength !== copiedBytes.byteLength || identity(sourceBytes) !== identity(copiedBytes)) {
      throw new Error(`${label} runtime snapshot identity changed during copy`);
    }
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertPinnedPaseo(pluginPath: string): void {
  const paseoRoot = path.resolve(pluginPath, "..", "..", "vendor", "paseo");
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: paseoRoot,
    encoding: "utf8",
    env: copyEnvironmentWithoutOpenAiSecrets(process.env),
  }).trim();
  if (actual !== PINNED_PASEO_COMMIT) {
    throw new Error(
      `Pinned Paseo mismatch: expected ${PINNED_PASEO_COMMIT}, found ${actual}. ` +
        "Restore the accepted vendor/paseo submodule before launching Meetless.",
    );
  }
}

function assertPackagedPaseo(config: RuntimeConfig): void {
  if (config.packageResources?.paseoCommit !== PINNED_PASEO_COMMIT) {
    throw new Error(
      `Packaged Paseo identity is ${config.packageResources?.paseoCommit ?? "missing"}, expected ${PINNED_PASEO_COMMIT}. ` +
        "Authority: docs/decisions/0001-maintained-paseo-fork.md. Next action: rebuild from the accepted pinned Paseo output; repository Git metadata is not a packaged runtime dependency.",
    );
  }
}

async function assertExistingConfigReadable(configPath: string): Promise<void> {
  try {
    const existing = await readFile(configPath, "utf8");
    z.record(z.string(), z.unknown()).parse(JSON.parse(existing));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new IsolationViolationError(
      `Existing isolated daemon config is unreadable at ${configPath}; it was not replaced`,
    );
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    created = false;
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
