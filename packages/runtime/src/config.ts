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

export const PINNED_PASEO_COMMIT = "7618cda71e2836f9ba7e821286504841203cb745";
export const DEFAULT_MEETLESS_LISTEN = "127.0.0.1:6777";
export const MEETLESS_INSTALLATION_PATH = "/Applications/Meetless.app";
export const MEETLESS_USER_SUPPORT_RELATIVE_PATH = "Library/Application Support/Meetless";
export const MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH = "Documents/meetings";
export const PACKAGED_RENDERER_ORIGIN = "http://127.0.0.1:18082";
const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(packageDirectory, "../../..");
const PACKAGED_MANIFEST_FILENAME = "meetless-package.json";
const PACKAGED_MANIFEST_SCHEMA = "MEETLESS_MACOS_PACKAGE v2";
const INSTALLATION_CONTRACT_SCHEMA = "MEETLESS_INSTALLATION_CONTRACT v1";
const INSTALLATION_CONTRACT_FILENAME = "installation-contract.json";
const HOST_CONFIG_SCHEMA = "MEETLESS_MACOS_HOST_CONFIG v2";
const MACOS_APP_STORE_CONTRACT_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
export const MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH =
  "Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless";
export const MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH =
  "Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless/recordings";
const MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH =
  "Library/Containers/com.meetless.app/Data/Library/Application Support";
const PACKAGED_MEDIA_CLOSURE_SCHEMA = "MEETLESS_PACKAGED_MEDIA_CLOSURE v1";
const PACKAGED_MEDIA_CLOSURE_DIRECTORY = "media-tools";
const PACKAGED_MEDIA_CLOSURE_MANIFEST = "media-tools.snapshot.json";
const PACKAGED_MEDIA_CLOSURE_OWNER = ".meetless-media-closure-owner.json";
const PACKAGED_MEDIA_CLOSURE_OWNER_SCHEMA = "MEETLESS_PACKAGED_MEDIA_CLOSURE_OWNER v1";
const PACKAGED_MEDIA_CLOSURE_STAGING_PREFIX = `${PACKAGED_MEDIA_CLOSURE_DIRECTORY}.staging-`;
const PACKAGED_MEDIA_CLOSURE_PREVIOUS_PREFIX = `${PACKAGED_MEDIA_CLOSURE_DIRECTORY}.previous-`;
const PACKAGED_MEDIA_CLOSURE_TRANSACTION = "media-tools.transaction.json";
const PACKAGED_MEDIA_CLOSURE_TRANSACTION_SCHEMA = "MEETLESS_PACKAGED_MEDIA_CLOSURE_TRANSACTION v1";

const RelativeContractPathSchema = z.string().min(1).refine((value) =>
  !path.isAbsolute(value) && !value.split("/").some((part) => part === ".." || part === ""),
  "must be a non-empty relative path without traversal",
);

const InstallationContractShape = {
  schema: z.literal(INSTALLATION_CONTRACT_SCHEMA),
  bundleIdentifier: z.literal("com.meetless.app"),
  installPath: z.literal(MEETLESS_INSTALLATION_PATH),
  userSupportRelativePath: RelativeContractPathSchema,
  recordingExportsRelativePath: RelativeContractPathSchema,
  identityRelativePath: RelativeContractPathSchema,
  runtime: z.object({
    paseoHomeRelativePath: RelativeContractPathSchema,
    electronUserDataRelativePath: RelativeContractPathSchema,
    meetingStoreRelativePath: RelativeContractPathSchema,
    logsRelativePath: RelativeContractPathSchema,
    daemonLogRelativePath: RelativeContractPathSchema,
    manifestRelativePath: RelativeContractPathSchema,
    recordingSocketRelativePath: RelativeContractPathSchema,
    transcriptionSocketRelativePath: RelativeContractPathSchema,
    transcriptionStagingRelativePath: RelativeContractPathSchema,
  }).strict(),
  listen: z.literal("127.0.0.1:16777"),
  rendererOrigin: z.literal(PACKAGED_RENDERER_ORIGIN),
  package: z.object({
    rootRelativeToBundle: RelativeContractPathSchema,
    markerFilename: z.literal(PACKAGED_MANIFEST_FILENAME),
    contractFilename: z.literal(INSTALLATION_CONTRACT_FILENAME),
    hostConfigRelativeToBundle: RelativeContractPathSchema,
    resources: z.object({
      rendererRoot: RelativeContractPathSchema,
      electronBinary: RelativeContractPathSchema,
      nodeBinary: RelativeContractPathSchema,
      captureHelper: RelativeContractPathSchema,
      ffmpeg: RelativeContractPathSchema,
      ffprobe: RelativeContractPathSchema,
    }).strict(),
  }).strict(),
  host: z.object({
    executableRelativeToBundle: RelativeContractPathSchema,
    configFilename: z.literal("host-config.json"),
  }).strict(),
  dmg: z.object({
    volumeName: z.literal("Meetless"),
    appName: z.literal("Meetless.app"),
    applicationsLinkName: z.literal("Applications"),
    applicationsLinkTarget: z.literal("/Applications"),
  }).strict(),
};

const InstallationContractSchema = z.union([
  z.object({
    ...InstallationContractShape,
    userSupportRelativePath: z.literal(MEETLESS_USER_SUPPORT_RELATIVE_PATH),
    recordingExportsRelativePath: z.literal(MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH),
  }).strict(),
  z.object({
    ...InstallationContractShape,
    userSupportRelativePath: z.literal(MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH),
    recordingExportsRelativePath: z.literal(MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH),
  }).strict(),
]);

const PackagedRuntimeManifestSchema = z.object({
  schema: z.literal(PACKAGED_MANIFEST_SCHEMA),
  target: z.literal("macos-arm64"),
  bundleIdentifier: z.literal("com.meetless.app"),
  paseoCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  rendererOrigin: z.literal(PACKAGED_RENDERER_ORIGIN),
  listen: z.literal("127.0.0.1:16777"),
  installationContract: z.literal(INSTALLATION_CONTRACT_FILENAME),
  installationContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  hostBundlePath: z.literal(MEETLESS_INSTALLATION_PATH),
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

export type MediaClosurePublicationFault =
  | "before-rename"
  | "after-rename"
  | "before-replacement"
  | "after-old-rename"
  | "after-new-rename"
  | "after-publication";

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

const PackagedMediaClosureTransactionSchema = z.object({
  schema: z.literal(PACKAGED_MEDIA_CLOSURE_TRANSACTION_SCHEMA),
  version: z.literal(1),
  phase: z.enum(["prepared", "quarantined", "published"]),
  runtimeRoot: z.string().startsWith("/"),
  targetRoot: z.string().startsWith("/"),
  previousRoot: z.string().startsWith("/"),
  stagingRoot: z.string().startsWith("/"),
  newSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  ownerUid: z.number().int().nonnegative().nullable(),
  previousDevice: z.number().int().nonnegative().optional(),
  previousInode: z.number().int().nonnegative().optional(),
}).strict();

type PackagedRuntimeManifest = z.infer<typeof PackagedRuntimeManifestSchema>;
type InstallationContract = z.infer<typeof InstallationContractSchema>;
type PackagedMediaClosureTransaction = z.infer<typeof PackagedMediaClosureTransactionSchema>;

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
      `${message}. Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. ` +
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
  const installationContract = packagedManifest
    ? readPackagedInstallationContract(repositoryRoot, packagedManifest)
    : readSourceInstallationContract(repositoryRoot);
  const packageResources = packagedManifest
    ? resolvePackagedRuntimeResources(repositoryRoot, packagedManifest, installationContract)
    : null;
  const macAppStore = isMacAppStoreInstallationContract(installationContract);
  const stateRoots = macAppStore
    ? resolveMacAppStoreStateRoots(userHome, sourceEnvironment, installationContract)
    : {
      runtimeRoot: resolveUserHomePath(userHome, installationContract.userSupportRelativePath, "user support root"),
      recordingExports: resolveUserHomePath(
        userHome,
        installationContract.recordingExportsRelativePath,
        "recording exports",
      ),
      containerSupportRoot: null,
    };
  const acceptedSupportRoot = stateRoots.runtimeRoot;
  const acceptedRecordingExports = stateRoots.recordingExports;
  const requestedRuntimeRoot = input.runtimeRoot ?? sourceEnvironment.MEETLESS_RUNTIME_ROOT;
  if (packagedManifest && requestedRuntimeRoot && path.resolve(requestedRuntimeRoot) !== acceptedSupportRoot) {
    throw new Error(
      `Packaged runtime root ${requestedRuntimeRoot} differs from the accepted per-user root ${acceptedSupportRoot}. ` +
        `Authority: ${macAppStore ? MACOS_APP_STORE_CONTRACT_AUTHORITY : "docs/decisions/0002-direct-notarized-macos-dmg.md"}. ` +
        `Next action: ${macAppStore
          ? "use the current Meetless app-container Application Support root; do not redirect MAS state to a builder or user Documents path."
          : "use ~/Library/Application Support/Meetless; do not redirect packaged state to a builder or temporary path."}`,
    );
  }
  const root = path.resolve(
    packaged ? acceptedSupportRoot : requestedRuntimeRoot ?? acceptedSupportRoot,
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
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. Next action: use the packaged renderer origin.",
    );
  }
  const requestedRecordingExports = sourceEnvironment.MEETLESS_EXPORT_ROOT?.trim();
  if (macAppStore && requestedRecordingExports) {
    throw new Error(
      `Mac App Store recording exports cannot be redirected to ${requestedRecordingExports}; writable state is app-container owned. ` +
        `Authority: ${MACOS_APP_STORE_CONTRACT_AUTHORITY}. ` +
        "Next action: keep the default recording inside the app container and implement the user-selected security-scoped export flow before external export.",
    );
  }
  if (packaged && !macAppStore && requestedRecordingExports && path.resolve(requestedRecordingExports) !== acceptedRecordingExports) {
    throw new Error(
      `Packaged recording exports ${requestedRecordingExports} differs from the accepted per-user path ${acceptedRecordingExports}. ` +
        "Authority: docs/product/recording.md and docs/decisions/0002-direct-notarized-macos-dmg.md. " +
        "Next action: keep final recordings under ~/Documents/meetings.",
    );
  }
  const supervisorEntrypoint = path.join(
    repositoryRoot,
    "vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  const runtimeLayout = installationContract.runtime;
  const paseoHome = path.join(root, runtimeLayout.paseoHomeRelativePath);
  const meetingStore = path.join(root, runtimeLayout.meetingStoreRelativePath);
  const logs = path.join(root, runtimeLayout.logsRelativePath);
  const paths: RuntimePaths = {
    root,
    paseoHome,
    electronUserData: path.join(root, runtimeLayout.electronUserDataRelativePath),
    meetingStore,
    logs,
    daemonLog: path.join(root, runtimeLayout.daemonLogRelativePath),
    identity: path.join(paseoHome, "server-id"),
    pidLock: path.join(paseoHome, "paseo.pid"),
    supervisorMarker: path.join(paseoHome, "meetless-supervisor-owner.json"),
    config: path.join(paseoHome, "config.json"),
    manifest: path.join(root, runtimeLayout.manifestRelativePath),
    plugin: path.join(repositoryRoot, "packages", "meetless-plugin"),
    captureHelper: packageResources?.captureHelper ??
      path.join(repositoryRoot, "native", "macos-capture", ".build", "release", "meetless-capture"),
    recordingSocket: resolveRecordingSocket(
      path.join(root, runtimeLayout.recordingSocketRelativePath),
      acceptedSupportRoot,
      { allowExternalShortPath: macAppStore },
    ),
    transcriptionSocket: path.join(root, runtimeLayout.transcriptionSocketRelativePath),
    transcriptionStaging: path.join(root, runtimeLayout.transcriptionStagingRelativePath),
    recordingExports: macAppStore || packaged
      ? acceptedRecordingExports
      : path.resolve(requestedRecordingExports || acceptedRecordingExports),
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
      bundle: MEETLESS_INSTALLATION_PATH,
      identity: path.join(acceptedSupportRoot, installationContract.identityRelativePath),
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
      ...(macAppStore && stateRoots.containerSupportRoot
        ? { MEETLESS_APP_CONTAINER_SUPPORT_ROOT: stateRoots.containerSupportRoot }
        : {}),
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
    if (manifest.hostBundlePath !== MEETLESS_INSTALLATION_PATH) {
      throw new Error(`Packaged host path ${manifest.hostBundlePath} is not the accepted ${MEETLESS_INSTALLATION_PATH}`);
    }
    return manifest;
  } catch (error) {
    throw new Error(
      `Packaged Meetless runtime marker is missing or invalid at ${markerPath}: ${describe(error)}. ` +
        "Authority: docs/specs/macos-artifact-validation.md. Next action: rebuild the complete macOS package; do not fall back to repository resources.",
    );
  }
}

function readSourceInstallationContract(repositoryRoot: string): InstallationContract {
  const sourcePath = path.join(repositoryRoot, "scripts", "lib", "macos-package-contract.json");
  return parseInstallationContract(sourcePath, "source");
}

function isMacAppStoreInstallationContract(contract: InstallationContract): boolean {
  return contract.userSupportRelativePath === MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH &&
    contract.recordingExportsRelativePath === MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH;
}

function resolveMacAppStoreStateRoots(
  userHome: string,
  environment: NodeJS.ProcessEnv,
  contract: InstallationContract,
): { runtimeRoot: string; recordingExports: string; containerSupportRoot: string } {
  const configuredSupportRoot = environment.MEETLESS_APP_CONTAINER_SUPPORT_ROOT?.trim();
  const containerSupportRoot = configuredSupportRoot
    ? resolveConfiguredMacAppStoreSupportRoot(configuredSupportRoot, userHome)
    : resolveUserHomePath(userHome, MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH, "Mac App Store container support root");
  const runtimeRoot = resolveUserHomePath(containerSupportRoot, "Meetless", "Mac App Store runtime root");
  const recordingExports = resolveUserHomePath(
    containerSupportRoot,
    "Meetless/recordings",
    "Mac App Store recording exports",
  );
  if (runtimeRoot !== path.resolve(userHome, contract.userSupportRelativePath) && !configuredSupportRoot) {
    throw new Error(
      `Mac App Store runtime root ${runtimeRoot} is not the accepted app-container path. ` +
        `Authority: ${MACOS_APP_STORE_CONTRACT_AUTHORITY}. ` +
        "Next action: resolve state from the sandboxed app-container Application Support directory.",
    );
  }
  return { runtimeRoot, recordingExports, containerSupportRoot };
}

function resolveConfiguredMacAppStoreSupportRoot(value: string, userHome: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(
      `Mac App Store container support root ${value} must be absolute. ` +
        `Authority: ${MACOS_APP_STORE_CONTRACT_AUTHORITY}. ` +
        "Next action: pass the sandboxed app-container Application Support directory.",
    );
  }
  const resolved = path.resolve(value);
  const expected = path.resolve(userHome, MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH);
  if (resolved !== expected && !resolved.endsWith(`/${MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH}`)) {
    throw new Error(
      `Mac App Store container support root ${resolved} differs from the app-container path ${expected}. ` +
        `Authority: ${MACOS_APP_STORE_CONTRACT_AUTHORITY}. ` +
        "Next action: use the current Meetless app container; do not redirect writable state to a builder or user Documents path.",
    );
  }
  return resolved;
}

function readPackagedInstallationContract(
  packageRoot: string,
  manifest: PackagedRuntimeManifest,
): InstallationContract {
  const contractPath = resolveRelativePackagePath(packageRoot, manifest.installationContract, "installation contract");
  const contract = parseInstallationContract(contractPath, "packaged");
  const digest = createHash("sha256").update(readFileSync(contractPath)).digest("hex");
  if (digest !== manifest.installationContractSha256) {
    throw new Error(
      `Packaged installation contract digest ${digest} differs from the marker ${manifest.installationContractSha256}. ` +
        "Authority: docs/decisions/0002-direct-notarized-macos-dmg.md. Next action: rebuild the package from one immutable contract.",
    );
  }
  return contract;
}

function parseInstallationContract(contractPath: string, source: string): InstallationContract {
  try {
    return InstallationContractSchema.parse(JSON.parse(readFileSync(contractPath, "utf8")));
  } catch (error) {
    throw new Error(
      `${source} Meetless installation contract is missing or invalid at ${contractPath}: ${describe(error)}. ` +
        "Authority: docs/decisions/0002-direct-notarized-macos-dmg.md. " +
        "Next action: restore the owner-approved plain-data contract; do not use a repository or builder fallback for a packaged runtime.",
    );
  }
}

function resolvePackagedRuntimeResources(
  repositoryRoot: string,
  manifest: PackagedRuntimeManifest,
  installationContract: InstallationContract,
): PackagedRuntimeResources {
  if (manifest.listen !== installationContract.listen || manifest.rendererOrigin !== installationContract.rendererOrigin) {
    throw new Error("Packaged marker listener/origin differs from the installation contract");
  }
  if (JSON.stringify(manifest.resources) !== JSON.stringify(installationContract.package.resources)) {
    throw new Error("Packaged marker resources differ from the installation contract");
  }
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

function resolveRelativePackagePath(packageRoot: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Packaged ${label} must be relative to ${packageRoot}`);
  }
  const resolved = path.resolve(packageRoot, relativePath);
  const relative = path.relative(packageRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Packaged ${label} escapes the package root: ${relativePath}`);
  }
  return resolved;
}

function resolveUserHomePath(userHome: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Installation contract ${label} is not a secure user-home-relative path: ${relativePath}`);
  }
  return path.resolve(userHome, ...relativePath.split("/"));
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
        "Authority: docs/specs/macos-artifact-validation.md. Next action: rebuild the macOS package with all emitted resources.",
    );
  }
}

function assertPackagedRegularFile(candidate: string, label: string): void {
  if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Packaged ${label} resource is missing: ${candidate}. ` +
        "Authority: docs/specs/macos-artifact-validation.md. Next action: rebuild the macOS package with the resource inside the artifact.",
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

function resolveRecordingSocket(
  recordingSocketPath: string,
  acceptedSupportRoot: string,
  { allowExternalShortPath = false }: { allowExternalShortPath?: boolean } = {},
): string {
  const inHome = path.resolve(recordingSocketPath);
  if (process.platform !== "darwin" || Buffer.byteLength(inHome) <= DARWIN_UNIX_SOCKET_PATH_BYTES) {
    return inHome;
  }
  if (!allowExternalShortPath && path.resolve(path.dirname(path.dirname(inHome))) === path.resolve(acceptedSupportRoot)) {
    throw new IsolationViolationError(
      `Meetless recording socket path is too long for the per-user support root: ${inHome}`,
    );
  }
  const identity = createHash("sha256").update(inHome).digest("hex").slice(0, 24);
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
      "Packaged media resources are missing. Authority: docs/decisions/0002-direct-notarized-macos-dmg.md. " +
        "Next action: rebuild the package with the complete signed media closure; do not use host tools.",
    );
  }
  const packageRoot = path.resolve(config.paths.plugin, "..", "..");
  const snapshot = await snapshotPackagedMediaClosure({
    runtimeRoot: config.paths.root,
    packageRoot,
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
  packageRoot: string;
  ffmpeg: string;
  ffprobe: string;
  faultAt?: MediaClosurePublicationFault;
}): Promise<PackagedMediaClosureSnapshot> {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  await assertSecureRuntimeDirectory(runtimeRoot);
  const source = derivePackagedMediaRoot(input.ffmpeg, input.ffprobe);
  await assertPackagedMediaSourceBoundToPackage(source, input.packageRoot);
  const targetRoot = path.join(runtimeRoot, PACKAGED_MEDIA_CLOSURE_DIRECTORY);
  const manifestPath = path.join(targetRoot, PACKAGED_MEDIA_CLOSURE_MANIFEST);
  assertContainedPath(targetRoot, runtimeRoot, "packaged media snapshot");
  assertContainedPath(manifestPath, runtimeRoot, "packaged media snapshot manifest");
  await recoverPackagedMediaReplacement(runtimeRoot, targetRoot, source);
  await cleanupOwnedMediaStaging(runtimeRoot, targetRoot);

  const legacyRoot = await stageLegacyDevelopmentMediaTools(runtimeRoot, targetRoot);
  const targetState = await inspectPath(targetRoot);
  try {
    if (targetState.exists) {
      if (targetState.kind !== "directory") {
        throw mediaClosureError(`packaged media snapshot ownership is invalid at ${targetRoot}`);
      }
      const manifest = await readValidatedMediaClosure(targetRoot, { runtimeRoot, targetRoot, sourceRoot: source.root }, "snapshot");
      const sourceTree = await inspectSourceIfPresent(source.root, source.ffmpeg, source.ffprobe);
      if (!sourceTree || sourceTree.fingerprint === manifest.sourceFingerprint) {
        return packagedMediaSnapshot(targetRoot, manifest.snapshotFingerprint);
      }
      const snapshot = await publishPackagedMediaClosure({
        runtimeRoot,
        targetRoot,
        source,
        sourceTree,
        faultAt: input.faultAt,
        replaceExisting: true,
      });
      if (legacyRoot) await rm(legacyRoot, { recursive: true, force: false });
      return snapshot;
    }

    const sourceTree = await inspectSourceRequired(source.root, source.ffmpeg, source.ffprobe);
    const snapshot = await publishPackagedMediaClosure({
      runtimeRoot,
      targetRoot,
      source,
      sourceTree,
      faultAt: input.faultAt,
      replaceExisting: false,
    });
    if (legacyRoot) await rm(legacyRoot, { recursive: true, force: false });
    return snapshot;
  } catch (error) {
    if (legacyRoot) {
      await recoverLegacyDevelopmentMediaToolsAfterFailure(legacyRoot, targetRoot, runtimeRoot, source.root);
    }
    throw error;
  }
}

async function publishPackagedMediaClosure(input: {
  runtimeRoot: string;
  targetRoot: string;
  source: { root: string; ffmpeg: string; ffprobe: string };
  sourceTree: MediaClosureTree;
  faultAt?: MediaClosurePublicationFault;
  replaceExisting: boolean;
}): Promise<PackagedMediaClosureSnapshot> {
  const transactionId = `${process.pid}-${randomUUID()}`;
  const temporaryRoot = path.join(input.runtimeRoot, `${PACKAGED_MEDIA_CLOSURE_STAGING_PREFIX}${transactionId}`);
  const previousRoot = path.join(input.runtimeRoot, `${PACKAGED_MEDIA_CLOSURE_PREVIOUS_PREFIX}${transactionId}`);
  assertContainedPath(temporaryRoot, input.runtimeRoot, "packaged media staging");
  assertContainedPath(previousRoot, input.runtimeRoot, "packaged media previous snapshot");
  let previousPublished = false;
  let newPublished = false;
  let preserveTransaction = false;
  let transaction: PackagedMediaClosureTransaction | null = null;
  try {
    await mkdir(temporaryRoot, { recursive: false, mode: input.sourceTree.rootMode });
    await writeMediaClosureOwner(temporaryRoot, { runtimeRoot: input.runtimeRoot, targetRoot: input.targetRoot });
    await chmod(temporaryRoot, input.sourceTree.rootMode);
    await copyMediaTree(input.source.root, temporaryRoot, input.sourceTree);
    const copiedTree = await inspectMediaTree(temporaryRoot, "staged snapshot", mediaClosureMetadataNames());
    if (copiedTree.fingerprint !== input.sourceTree.fingerprint) {
      throw mediaClosureError("packaged media closure changed during atomic snapshot");
    }
    const manifest: PackagedMediaClosureManifest = {
      schema: PACKAGED_MEDIA_CLOSURE_SCHEMA,
      version: 1,
      runtimeRoot: input.runtimeRoot,
      targetRoot: input.targetRoot,
      sourceRoot: input.source.root,
      sourceFingerprint: input.sourceTree.fingerprint,
      snapshotFingerprint: copiedTree.fingerprint,
      rootMode: copiedTree.rootMode,
      entries: copiedTree.entries,
      tools: { ffmpeg: "bin/ffmpeg", ffprobe: "bin/ffprobe" },
    };
    await writeJsonAtomic(path.join(temporaryRoot, PACKAGED_MEDIA_CLOSURE_MANIFEST), manifest);
    await syncDirectory(temporaryRoot);
    if (input.replaceExisting) {
      transaction = {
        schema: PACKAGED_MEDIA_CLOSURE_TRANSACTION_SCHEMA,
        version: 1,
        phase: "prepared",
        runtimeRoot: input.runtimeRoot,
        targetRoot: input.targetRoot,
        previousRoot,
        stagingRoot: temporaryRoot,
        newSnapshotFingerprint: copiedTree.fingerprint,
        ownerUid: typeof process.getuid === "function" ? process.getuid() : null,
      };
      await writeMediaClosureTransaction(transaction);
    }
    if (input.faultAt === "before-rename" || (input.replaceExisting && input.faultAt === "before-replacement")) {
      preserveTransaction = true;
      throw mediaClosureError("injected crash before media closure publication");
    }
    if (input.replaceExisting) {
      await rename(input.targetRoot, previousRoot);
      previousPublished = true;
      await syncDirectory(input.runtimeRoot);
      const previousStats = await lstat(previousRoot);
      if (!previousStats.isDirectory() || previousStats.isSymbolicLink()) {
        throw mediaClosureError(`packaged media replacement snapshot is not an owned directory at ${previousRoot}`);
      }
      transaction = {
        ...transaction!,
        phase: "quarantined",
        previousDevice: previousStats.dev,
        previousInode: previousStats.ino,
      };
      await writeMediaClosureTransaction(transaction);
      if (input.faultAt === "after-old-rename") {
        preserveTransaction = true;
        throw mediaClosureError("injected crash after old media closure was quarantined");
      }
    }
    await rename(temporaryRoot, input.targetRoot);
    newPublished = true;
    await syncDirectory(input.runtimeRoot);
    if (transaction) {
      transaction = { ...transaction, phase: "published" };
      await writeMediaClosureTransaction(transaction);
    }
    if (input.faultAt === "after-rename" || input.faultAt === "after-new-rename" || input.faultAt === "after-publication") {
      preserveTransaction = true;
      throw mediaClosureError("injected crash after media closure publication");
    }
    const publishedManifest = await readValidatedMediaClosure(
      input.targetRoot,
      { runtimeRoot: input.runtimeRoot, targetRoot: input.targetRoot, sourceRoot: input.source.root },
      "published snapshot",
    );
    if (transaction) {
      await removeAuthorizedPreviousMediaClosure(transaction);
      await removeMediaClosureTransaction(transaction);
    }
    return packagedMediaSnapshot(input.targetRoot, publishedManifest.snapshotFingerprint);
  } catch (error) {
    if (previousPublished && !newPublished && !preserveTransaction) {
      try {
        await rename(previousRoot, input.targetRoot);
        await syncDirectory(input.runtimeRoot);
      } catch (rollbackError) {
        preserveTransaction = true;
        throw new AggregateError([error, rollbackError], "media closure replacement rollback failed; recovery is required");
      }
    }
    throw error;
  } finally {
    if (!newPublished && !preserveTransaction) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function writeMediaClosureTransaction(transaction: PackagedMediaClosureTransaction): Promise<void> {
  const transactionPath = path.join(transaction.runtimeRoot, PACKAGED_MEDIA_CLOSURE_TRANSACTION);
  assertContainedPath(transactionPath, transaction.runtimeRoot, "packaged media transaction");
  await writeJsonAtomic(transactionPath, transaction);
  await syncDirectory(transaction.runtimeRoot);
}

async function readMediaClosureTransaction(
  runtimeRoot: string,
  targetRoot: string,
): Promise<PackagedMediaClosureTransaction | null> {
  const transactionPath = path.join(runtimeRoot, PACKAGED_MEDIA_CLOSURE_TRANSACTION);
  const state = await inspectPath(transactionPath);
  if (!state.exists) return null;
  if (state.kind !== "file") {
    throw mediaClosureError(`packaged media transaction ownership is invalid at ${transactionPath}`);
  }
  const stats = await lstat(transactionPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw mediaClosureError(`packaged media transaction is not a private owned file at ${transactionPath}`);
  }
  let transaction: PackagedMediaClosureTransaction;
  try {
    transaction = PackagedMediaClosureTransactionSchema.parse(JSON.parse(await readFile(transactionPath, "utf8")));
  } catch (error) {
    throw mediaClosureError(`packaged media transaction is invalid: ${describe(error)}`);
  }
  assertMediaClosureTransaction(transaction, runtimeRoot, targetRoot);
  return transaction;
}

function assertMediaClosureTransaction(
  transaction: PackagedMediaClosureTransaction,
  runtimeRoot: string,
  targetRoot: string,
): void {
  if (transaction.runtimeRoot !== runtimeRoot || transaction.targetRoot !== targetRoot) {
    throw mediaClosureError("packaged media transaction does not belong to this runtime");
  }
  assertContainedPath(transaction.previousRoot, runtimeRoot, "packaged media transaction previous snapshot");
  assertContainedPath(transaction.stagingRoot, runtimeRoot, "packaged media transaction staging snapshot");
  if (path.resolve(transaction.previousRoot) === path.resolve(targetRoot) || path.resolve(transaction.stagingRoot) === path.resolve(targetRoot)) {
    throw mediaClosureError("packaged media transaction aliases the published snapshot");
  }
  const previousName = path.basename(transaction.previousRoot);
  const stagingName = path.basename(transaction.stagingRoot);
  if (!previousName.startsWith(PACKAGED_MEDIA_CLOSURE_PREVIOUS_PREFIX)) {
    throw mediaClosureError("packaged media transaction previous snapshot name is not owner-bound");
  }
  const transactionId = previousName.slice(PACKAGED_MEDIA_CLOSURE_PREVIOUS_PREFIX.length);
  if (!transactionId || stagingName !== `${PACKAGED_MEDIA_CLOSURE_STAGING_PREFIX}${transactionId}`) {
    throw mediaClosureError("packaged media transaction staging snapshot name is not owner-bound");
  }
  if ((transaction.previousDevice === undefined) !== (transaction.previousInode === undefined)) {
    throw mediaClosureError("packaged media transaction previous snapshot identity is incomplete");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && transaction.ownerUid !== uid) {
    throw mediaClosureError("packaged media transaction owner differs from this runtime");
  }
}

async function removeMediaClosureTransaction(transaction: PackagedMediaClosureTransaction): Promise<void> {
  const current = await readMediaClosureTransaction(transaction.runtimeRoot, transaction.targetRoot);
  if (!current || JSON.stringify(current) !== JSON.stringify(transaction)) {
    throw mediaClosureError("packaged media transaction changed before cleanup");
  }
  const transactionPath = path.join(transaction.runtimeRoot, PACKAGED_MEDIA_CLOSURE_TRANSACTION);
  await rm(transactionPath, { force: false });
  await syncDirectory(transaction.runtimeRoot);
}

async function removeAuthorizedPreviousMediaClosure(transaction: PackagedMediaClosureTransaction): Promise<void> {
  if (transaction.phase !== "published" || transaction.previousDevice === undefined || transaction.previousInode === undefined) {
    throw mediaClosureError("packaged media previous cleanup lacks a durable publication authorization");
  }
  const state = await inspectPath(transaction.previousRoot);
  if (!state.exists) return;
  if (state.kind !== "directory") {
    throw mediaClosureError(`packaged media previous cleanup path is not a directory at ${transaction.previousRoot}`);
  }
  const stats = await lstat(transaction.previousRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    stats.isSymbolicLink() ||
    (uid !== undefined && stats.uid !== uid) ||
    (transaction.ownerUid !== null && stats.uid !== transaction.ownerUid) ||
    stats.dev !== transaction.previousDevice ||
    stats.ino !== transaction.previousInode
  ) {
    throw mediaClosureError(`packaged media previous cleanup path is not the authorized owner-bound directory at ${transaction.previousRoot}`);
  }
  await rm(transaction.previousRoot, { recursive: true, force: false });
  await syncDirectory(transaction.runtimeRoot);
}

async function removeAuthorizedMediaStaging(transaction: PackagedMediaClosureTransaction): Promise<void> {
  const state = await inspectPath(transaction.stagingRoot);
  if (!state.exists) return;
  if (state.kind !== "directory") {
    throw mediaClosureError(`packaged media transaction staging path is not a directory at ${transaction.stagingRoot}`);
  }
  await assertOwnedMediaDirectory(transaction.stagingRoot, "packaged media transaction staging");
  await assertMediaClosureOwner(transaction.stagingRoot, {
    runtimeRoot: transaction.runtimeRoot,
    targetRoot: transaction.targetRoot,
  });
  await rm(transaction.stagingRoot, { recursive: true, force: false });
  await syncDirectory(transaction.runtimeRoot);
}

async function recoverPackagedMediaReplacement(
  runtimeRoot: string,
  targetRoot: string,
  source: { root: string; ffmpeg: string; ffprobe: string },
): Promise<void> {
  const transaction = await readMediaClosureTransaction(runtimeRoot, targetRoot);
  const previousNames = (await readdir(runtimeRoot)).filter((name) => name.startsWith(PACKAGED_MEDIA_CLOSURE_PREVIOUS_PREFIX));
  if (previousNames.length > 1) {
    throw mediaClosureError(`multiple packaged media replacement snapshots require recovery in ${runtimeRoot}`);
  }
  if (transaction) {
    const previousRoot = path.join(runtimeRoot, previousNames[0] ?? path.basename(transaction.previousRoot));
    assertContainedPath(previousRoot, runtimeRoot, "packaged media previous snapshot");
    if (previousNames.length === 1 && path.resolve(previousRoot) !== path.resolve(transaction.previousRoot)) {
      throw mediaClosureError("packaged media previous snapshot is not the transaction-authorized path");
    }
    const targetState = await inspectPath(targetRoot);
    if (targetState.exists) {
      if (targetState.kind !== "directory") {
        throw mediaClosureError(`packaged media snapshot ownership is invalid at ${targetRoot}`);
      }
      const targetManifest = await readValidatedMediaClosure(
        targetRoot,
        { runtimeRoot, targetRoot, sourceRoot: source.root },
        "published snapshot",
      );
      if (targetManifest.snapshotFingerprint === transaction.newSnapshotFingerprint) {
        if (transaction.phase !== "published") {
          if (transaction.previousDevice === undefined || transaction.previousInode === undefined) {
            throw mediaClosureError("packaged media publication has no durable previous-directory identity");
          }
          const publishedTransaction = { ...transaction, phase: "published" as const };
          await writeMediaClosureTransaction(publishedTransaction);
          await removeAuthorizedPreviousMediaClosure(publishedTransaction);
          await removeAuthorizedMediaStaging(publishedTransaction);
          await removeMediaClosureTransaction(publishedTransaction);
          return;
        }
        await removeAuthorizedPreviousMediaClosure(transaction);
        await removeAuthorizedMediaStaging(transaction);
        await removeMediaClosureTransaction(transaction);
        return;
      }
      if ((transaction.phase === "prepared" || transaction.phase === "quarantined") && previousNames.length === 0) {
        await removeAuthorizedMediaStaging(transaction);
        await removeMediaClosureTransaction(transaction);
        return;
      }
      throw mediaClosureError("packaged media transaction does not match the published snapshot");
    }
    await readValidatedMediaClosure(previousRoot, { runtimeRoot, targetRoot }, "previous media snapshot");
    await rename(previousRoot, targetRoot);
    await syncDirectory(runtimeRoot);
    await removeAuthorizedMediaStaging(transaction);
    await removeMediaClosureTransaction(transaction);
    return;
  }
  if (previousNames.length === 0) return;
  const previousRoot = path.join(runtimeRoot, previousNames[0]!);
  assertContainedPath(previousRoot, runtimeRoot, "packaged media previous snapshot");
  const targetState = await inspectPath(targetRoot);
  if (targetState.exists) {
    throw mediaClosureError("packaged media previous snapshot has no durable cleanup authorization");
  }
  await readValidatedMediaClosure(previousRoot, { runtimeRoot, targetRoot }, "previous media snapshot");
  await rename(previousRoot, targetRoot);
  await syncDirectory(runtimeRoot);
}

async function stageLegacyDevelopmentMediaTools(runtimeRoot: string, targetRoot: string): Promise<string | null> {
  const state = await inspectPath(targetRoot);
  if (!state.exists || state.kind !== "directory") return null;
  const directory = await lstat(targetRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (directory.isSymbolicLink() || (uid !== undefined && directory.uid !== uid) || (directory.mode & 0o077) !== 0) return null;
  const names = (await readdir(targetRoot)).sort();
  if (names.join("\0") !== "ffmpeg\0ffprobe") return null;
  for (const name of names) {
    const tool = await lstat(path.join(targetRoot, name));
    if (!tool.isFile() || tool.isSymbolicLink() || tool.size <= 0 || (uid !== undefined && tool.uid !== uid) || (tool.mode & 0o077) !== 0) {
      return null;
    }
  }
  const legacyRoot = path.join(runtimeRoot, `${PACKAGED_MEDIA_CLOSURE_DIRECTORY}.legacy-${process.pid}-${randomUUID()}`);
  assertContainedPath(legacyRoot, runtimeRoot, "legacy development media quarantine");
  await rename(targetRoot, legacyRoot);
  return legacyRoot;
}

async function restoreLegacyDevelopmentMediaTools(legacyRoot: string, targetRoot: string, runtimeRoot: string): Promise<void> {
  assertContainedPath(legacyRoot, runtimeRoot, "legacy development media quarantine");
  const targetState = await inspectPath(targetRoot);
  if (targetState.exists) {
    await assertMediaClosureOwner(targetRoot, { runtimeRoot, targetRoot });
    await rm(targetRoot, { recursive: true, force: false });
  }
  await rename(legacyRoot, targetRoot);
}

async function recoverLegacyDevelopmentMediaToolsAfterFailure(
  legacyRoot: string,
  targetRoot: string,
  runtimeRoot: string,
  sourceRoot: string,
): Promise<void> {
  const targetState = await inspectPath(targetRoot);
  if (!targetState.exists) {
    await restoreLegacyDevelopmentMediaTools(legacyRoot, targetRoot, runtimeRoot);
    return;
  }
  if (targetState.kind === "directory") {
    try {
      await readValidatedMediaClosure(
        targetRoot,
        { runtimeRoot, targetRoot, sourceRoot },
        "published snapshot",
      );
      await rm(legacyRoot, { recursive: true, force: false });
      await syncDirectory(runtimeRoot);
      return;
    } catch {
      // A failed publication must not discard the exact legacy cache unless the
      // replacement directory is a complete runtime-owned snapshot.
    }
  }
  await restoreLegacyDevelopmentMediaTools(legacyRoot, targetRoot, runtimeRoot);
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

async function assertPackagedMediaSourceBoundToPackage(
  source: { root: string; ffmpeg: string; ffprobe: string },
  packageRootValue: string,
): Promise<void> {
  if (!path.isAbsolute(packageRootValue)) {
    throw mediaClosureError("packaged media package root must be an absolute verified package path");
  }
  const packageRoot = path.resolve(packageRootValue);
  for (const filename of [PACKAGED_MANIFEST_FILENAME, INSTALLATION_CONTRACT_FILENAME]) {
    const packageEntry = await lstat(path.join(packageRoot, filename)).catch((error: unknown) => {
      throw mediaClosureError(`verified packaged media root is missing ${filename}: ${describe(error)}`);
    });
    if (!packageEntry.isFile() || packageEntry.isSymbolicLink()) {
      throw mediaClosureError(`verified packaged media root has an invalid ${filename}`);
    }
  }
  const [packageRootReal, sourceRootReal] = await Promise.all([
    realpath(packageRoot).catch((error: unknown) => {
      throw mediaClosureError(`packaged media package root is unavailable: ${describe(error)}`);
    }),
    realpath(source.root).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return null;
      throw mediaClosureError(`packaged media source root is unavailable: ${describe(error)}`);
    }),
  ]);
  if (
    (!isSameOrDescendant(source.root, packageRoot) || path.resolve(source.root) === packageRoot) ||
    (sourceRootReal !== null && (!isSameOrDescendant(sourceRootReal, packageRootReal) || sourceRootReal === packageRootReal))
  ) {
    throw mediaClosureError(
      `packaged media source ${source.root} is not inside the verified package root ${packageRoot}; arbitrary source paths are rejected`,
    );
  }
  if (sourceRootReal === null) return;
  for (const [label, tool] of [["ffmpeg", source.ffmpeg], ["ffprobe", source.ffprobe]] as const) {
    const toolReal = await realpath(tool).catch((error: unknown) => {
      throw mediaClosureError(`packaged ${label} is unavailable: ${describe(error)}`);
    });
    if (!isSameOrDescendant(toolReal, packageRootReal)) {
      throw mediaClosureError(
        `packaged ${label} ${tool} is not inside the verified package root ${packageRoot}; arbitrary source paths are rejected`,
      );
    }
  }
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
  for (const name of names.filter((candidate) => candidate.startsWith(PACKAGED_MEDIA_CLOSURE_STAGING_PREFIX))) {
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

async function readValidatedMediaClosure(
  directory: string,
  expected: { runtimeRoot: string; targetRoot: string; sourceRoot?: string },
  label: string,
): Promise<PackagedMediaClosureManifest> {
  await assertOwnedMediaDirectory(directory, `${label} root`);
  await assertMediaClosureOwner(directory, expected);
  const manifest = await readMediaClosureManifest(path.join(directory, PACKAGED_MEDIA_CLOSURE_MANIFEST));
  assertMediaClosureManifestOwner(manifest, expected);
  const tree = await inspectMediaTree(directory, label, mediaClosureMetadataNames());
  assertMediaClosureTreeMatchesManifest(tree, manifest, directory);
  return manifest;
}

async function removeOwnedMediaClosure(directory: string, runtimeRoot: string, targetRoot: string): Promise<void> {
  const state = await inspectPath(directory);
  if (!state.exists) return;
  if (state.kind !== "directory") {
    throw mediaClosureError(`packaged media replacement snapshot ownership is invalid at ${directory}`);
  }
  await readValidatedMediaClosure(directory, { runtimeRoot, targetRoot }, "media replacement snapshot");
  await rm(directory, { recursive: true, force: false });
  await syncDirectory(runtimeRoot);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
  expected: { runtimeRoot: string; targetRoot: string; sourceRoot?: string },
): void {
  if (
    manifest.runtimeRoot !== expected.runtimeRoot ||
    manifest.targetRoot !== expected.targetRoot ||
    (expected.sourceRoot !== undefined && manifest.sourceRoot !== expected.sourceRoot) ||
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
    `${message}. Authority: docs/decisions/0002-direct-notarized-macos-dmg.md, packaged media-closure boundary. ` +
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
