import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH, type RuntimeConfig } from "./config.js";
import {
  formatSpawnSyncDiagnostic,
  inspectNativeArgumentVector,
  normalizeSpawnSyncOutput,
  RECORDING_READINESS_AUTHORITY,
} from "./readiness.js";
import {
  MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
  MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
  validateEndpointName,
} from "./runtime-endpoints.js";

export const MEETLESS_HOST_BUNDLE_ID = "com.meetless.app";
export const MEETLESS_HOST_EXECUTABLE = "MeetlessHost";
export const MEETLESS_HOST_INSTALL_PATH = "/Applications/Meetless.app";
const MEETLESS_HOST_CONFIG_SCHEMA = "MEETLESS_MACOS_HOST_CONFIG v2";
const MEETLESS_INSTALLATION_CONTRACT_SCHEMA = "MEETLESS_INSTALLATION_CONTRACT v1";
const MEETLESS_PACKAGE_SCHEMA = "MEETLESS_MACOS_PACKAGE v2";
const DIRECT_RUNTIME_ROOT_RELATIVE_PATH = "Library/Application Support/Meetless";
const MACOS_APP_CONTAINER_SUPPORT_ROOT_SUFFIX = "/Library/Containers/com.meetless.app/Data/Library/Application Support";

const HostLaunchConfigurationSchema = z.object({
  repositoryRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  listen: z.string().min(1),
  rendererOrigin: z.string().url(),
  transcriptionSocket: z.string().min(1),
  transcriptionStaging: z.string().min(1),
  nodePath: z.string().min(1),
  runtimeCliPath: z.string().min(1),
  identityPath: z.string().min(1),
  endpointPolicy: z.literal(MEETLESS_RUNTIME_ENDPOINTS_SCHEMA).optional(),
  endpointWorkingDirectory: z.literal(MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY).optional(),
  recordingEndpointName: z.string().min(1).optional(),
  transcriptionEndpointName: z.string().min(1).optional(),
}).strict();

export type HostLaunchConfiguration = z.infer<typeof HostLaunchConfigurationSchema>;

const RelativeHostPathSchema = z.string().min(1).refine((value) =>
  !path.isAbsolute(value) && !value.split("/").some((part) => part === ".." || part === ""),
  "must be a non-empty relative path without traversal",
);

const PackagedHostConfigurationSchema = z.object({
  schema: z.literal(MEETLESS_HOST_CONFIG_SCHEMA),
  mode: z.literal("packaged"),
  bundleIdentifier: z.literal(MEETLESS_HOST_BUNDLE_ID),
  packageRoot: RelativeHostPathSchema,
  installationContract: z.literal("installation-contract.json"),
  installationContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  runtimeRootRelativeToUserHome: RelativeHostPathSchema,
  identityRelativeToRuntimeRoot: RelativeHostPathSchema,
  listen: z.string().min(1),
  rendererOrigin: z.string().url(),
  transcriptionSocketRelativeToRuntimeRoot: RelativeHostPathSchema,
  transcriptionStagingRelativeToRuntimeRoot: RelativeHostPathSchema,
  endpointPolicy: z.literal(MEETLESS_RUNTIME_ENDPOINTS_SCHEMA),
  endpointWorkingDirectory: z.literal(MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY),
  recordingEndpointName: RelativeHostPathSchema,
  transcriptionEndpointName: RelativeHostPathSchema,
  nodePath: RelativeHostPathSchema,
  runtimeCliPath: RelativeHostPathSchema,
}).strict();

const DevelopmentHostConfigurationSchema = z.object({
  schema: z.literal(MEETLESS_HOST_CONFIG_SCHEMA),
  mode: z.literal("development"),
  bundleIdentifier: z.literal(MEETLESS_HOST_BUNDLE_ID),
  repositoryRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  listen: z.string().min(1),
  rendererOrigin: z.string().url(),
  transcriptionSocket: z.string().min(1),
  transcriptionStaging: z.string().min(1),
  nodePath: z.string().min(1),
  runtimeCliPath: z.string().min(1),
  identityPath: z.string().min(1),
}).strict();

const HostConfigurationFileSchema = z.discriminatedUnion("mode", [
  PackagedHostConfigurationSchema,
  DevelopmentHostConfigurationSchema,
]);

type HostConfigurationFile = z.infer<typeof HostConfigurationFileSchema>;

const InstallationContractSchema = z.object({
  schema: z.literal(MEETLESS_INSTALLATION_CONTRACT_SCHEMA),
  bundleIdentifier: z.literal(MEETLESS_HOST_BUNDLE_ID),
  installPath: z.literal(MEETLESS_HOST_INSTALL_PATH),
  userSupportRelativePath: RelativeHostPathSchema,
  recordingExportsRelativePath: RelativeHostPathSchema,
  identityRelativePath: RelativeHostPathSchema,
  runtime: z.object({
    paseoHomeRelativePath: RelativeHostPathSchema,
    electronUserDataRelativePath: RelativeHostPathSchema,
    meetingStoreRelativePath: RelativeHostPathSchema,
    logsRelativePath: RelativeHostPathSchema,
    daemonLogRelativePath: RelativeHostPathSchema,
    manifestRelativePath: RelativeHostPathSchema,
    recordingSocketRelativePath: RelativeHostPathSchema,
    transcriptionSocketRelativePath: RelativeHostPathSchema,
    transcriptionStagingRelativePath: RelativeHostPathSchema,
    endpointPolicy: z.object({
      schema: z.literal(MEETLESS_RUNTIME_ENDPOINTS_SCHEMA),
      workingDirectory: z.literal(MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY),
      recordingEndpointName: RelativeHostPathSchema,
      transcriptionEndpointName: RelativeHostPathSchema,
    }).strict(),
  }).strict(),
  listen: z.string().min(1),
  rendererOrigin: z.string().url(),
  package: z.object({
    rootRelativeToBundle: RelativeHostPathSchema,
    markerFilename: z.literal("meetless-package.json"),
    contractFilename: z.literal("installation-contract.json"),
    hostConfigRelativeToBundle: RelativeHostPathSchema,
    resources: z.record(z.string(), RelativeHostPathSchema),
  }).strict(),
  host: z.record(z.string(), z.string()),
  dmg: z.record(z.string(), z.string()),
}).strict();

export const HostIdentitySchema = z.object({
  version: z.literal(1),
  bundleIdentifier: z.literal(MEETLESS_HOST_BUNDLE_ID),
  bundlePath: z.string().min(1),
  bundleRealPath: z.string().min(1),
  executablePath: z.string().min(1),
  designatedRequirement: z.string().min(1),
  cdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryDevice: z.number().int().nonnegative(),
  binaryInode: z.number().int().nonnegative(),
  binarySize: z.number().int().positive(),
  configuration: HostLaunchConfigurationSchema,
}).strict();

export type HostIdentity = z.infer<typeof HostIdentitySchema>;

export interface HostInspectionContext {
  runtimeRoot: string;
  containerSupportRoot?: string;
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  executablePath: string;
  arguments: string[];
  executableDevice: number;
  executableInode: number;
  executableSize: number;
}

interface HostInspectionDependencies {
  inspectInstalled(bundlePath: string, context?: HostInspectionContext): Promise<HostIdentity>;
  readRecorded(identityPath: string): Promise<HostIdentity>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  inspectLiveHost(bundlePath: string, context?: HostInspectionContext): Promise<HostIdentity>;
}

const defaultDependencies: HostInspectionDependencies = {
  inspectInstalled: inspectHostBundle,
  readRecorded: readHostIdentity,
  inspectProcess,
  inspectLiveHost: inspectHostBundle,
};

export async function inspectHostBundle(
  bundlePath: string,
  context?: HostInspectionContext,
): Promise<HostIdentity> {
  const canonicalBundle = await realpath(bundlePath);
  const bundleIdentifier = inspectRequired(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(canonicalBundle, "Contents", "Info.plist")],
    "bundle identifier",
  );
  if (bundleIdentifier !== MEETLESS_HOST_BUNDLE_ID) {
    throw new Error(`installed host bundle identifier is ${bundleIdentifier}, expected ${MEETLESS_HOST_BUNDLE_ID}`);
  }
  const executablePath = path.join(canonicalBundle, "Contents", "MacOS", MEETLESS_HOST_EXECUTABLE);
  const [binary, binaryInfo, configurationText] = await Promise.all([
    readFile(executablePath),
    stat(executablePath),
    readFile(path.join(canonicalBundle, "Contents", "Resources", "host-config.json"), "utf8"),
  ]);
  const configuration = resolveHostConfiguration(JSON.parse(configurationText), canonicalBundle, context);
  const requirementOutput = inspectRequiredOutput("codesign", ["-d", "-r-", canonicalBundle], "designated requirement");
  const designatedRequirement = /^(?:# )?designated => (.+)$/mu.exec(requirementOutput)?.[1];
  if (!designatedRequirement) throw new Error("codesign did not report a designated requirement for Meetless.app");
  const signatureOutput = inspectRequiredOutput("codesign", ["-d", "--verbose=4", canonicalBundle], "CDHash");
  const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(signatureOutput)?.[1];
  if (!cdHash) throw new Error("codesign did not report a 40-character CDHash for Meetless.app");
  inspectRequired("codesign", ["--verify", "--deep", "--strict", canonicalBundle], "signature verification");
  return HostIdentitySchema.parse({
    version: 1,
    bundleIdentifier,
    bundlePath: path.resolve(bundlePath),
    bundleRealPath: canonicalBundle,
    executablePath,
    designatedRequirement,
    cdHash,
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    binaryDevice: binaryInfo.dev,
    binaryInode: binaryInfo.ino,
    binarySize: binaryInfo.size,
    configuration,
  });
}

export function resolveHostConfiguration(
  configuration: unknown,
  bundlePath: string,
  context?: HostInspectionContext,
): HostLaunchConfiguration {
  let parsed: HostConfigurationFile;
  try {
    parsed = HostConfigurationFileSchema.parse(configuration);
  } catch (error) {
    if (isRecord(configuration) && configuration.mode === "packaged" && !hasPackagedEndpointPolicyShape(configuration)) {
      throw endpointConfigurationError("packaged host configuration endpoint policy is missing or invalid", error);
    }
    throw error;
  }
  if (parsed.mode === "development") {
    const launchConfiguration = HostLaunchConfigurationSchema.parse({
      repositoryRoot: parsed.repositoryRoot,
      runtimeRoot: parsed.runtimeRoot,
      listen: parsed.listen,
      rendererOrigin: parsed.rendererOrigin,
      transcriptionSocket: parsed.transcriptionSocket,
      transcriptionStaging: parsed.transcriptionStaging,
      nodePath: parsed.nodePath,
      runtimeCliPath: parsed.runtimeCliPath,
      identityPath: parsed.identityPath,
    });
    if (context && path.resolve(launchConfiguration.runtimeRoot) !== trustedRuntimeRoot(context, "development")) {
      throw trustedContextError(
        `runtime root ${launchConfiguration.runtimeRoot} differs from the supplied ${context.runtimeRoot}`,
      );
    }
    return launchConfiguration;
  }

  const canonicalBundle = path.resolve(bundlePath);
  const packageRoot = resolveBundleRelativePath(canonicalBundle, parsed.packageRoot, "package root");
  const contractPath = path.join(packageRoot, parsed.installationContract);
  const contractBytes = readFileSyncRequired(contractPath, "installation contract");
  const contractDigest = createHash("sha256").update(contractBytes).digest("hex");
  if (contractDigest !== parsed.installationContractSha256) {
    throw new Error(`host configuration installation contract digest ${contractDigest} differs from ${parsed.installationContractSha256}`);
  }
  const contractValue = parseJsonRequired(contractBytes, contractPath);
  let contract: z.infer<typeof InstallationContractSchema>;
  try {
    contract = InstallationContractSchema.parse(contractValue);
  } catch (error) {
    throw endpointConfigurationError(
      "packaged installation contract endpoint policy is missing or invalid",
      error,
    );
  }
  const markerPath = resolveContainedPath(packageRoot, "meetless-package.json", "package marker");
  const marker = parseJsonRequired(readFileSyncRequired(markerPath, "package marker"), markerPath) as Record<string, unknown>;
  if (
    marker.schema !== MEETLESS_PACKAGE_SCHEMA ||
    marker.target !== "macos-arm64" ||
    marker.bundleIdentifier !== MEETLESS_HOST_BUNDLE_ID ||
    marker.hostBundlePath !== MEETLESS_HOST_INSTALL_PATH ||
    marker.installationContract !== parsed.installationContract ||
    marker.installationContractSha256 !== parsed.installationContractSha256 ||
    marker.listen !== parsed.listen ||
    marker.rendererOrigin !== parsed.rendererOrigin ||
    contract.package.rootRelativeToBundle !== parsed.packageRoot.replaceAll(path.sep, "/") ||
    contract.package.contractFilename !== parsed.installationContract ||
    contract.listen !== parsed.listen ||
    contract.rendererOrigin !== parsed.rendererOrigin ||
    contract.runtime.endpointPolicy.schema !== parsed.endpointPolicy ||
    contract.runtime.endpointPolicy.workingDirectory !== parsed.endpointWorkingDirectory ||
    contract.runtime.endpointPolicy.recordingEndpointName !== parsed.recordingEndpointName ||
    contract.runtime.endpointPolicy.transcriptionEndpointName !== parsed.transcriptionEndpointName ||
    contract.runtime.recordingSocketRelativePath !== contract.runtime.endpointPolicy.recordingEndpointName ||
    contract.runtime.transcriptionSocketRelativePath !== contract.runtime.endpointPolicy.transcriptionEndpointName ||
    JSON.stringify(marker.resources) !== JSON.stringify(contract.package.resources)
  ) {
    throw endpointConfigurationError("packaged host configuration differs from the accepted endpoint policy");
  }
  validateHostEndpointPolicy(parsed.recordingEndpointName, parsed.transcriptionEndpointName);
  for (const [name, relativePath] of Object.entries(contract.package.resources)) {
    resolveBundleRelativePath(packageRoot, relativePath, `packaged ${name}`);
  }
  const runtimeRoot = resolvePackagedRuntimeRoot(parsed.runtimeRootRelativeToUserHome, context);
  const identityPath = resolveContainedPath(runtimeRoot, parsed.identityRelativeToRuntimeRoot, "host identity");
  const transcriptionSocket = resolveContainedPath(
    runtimeRoot,
    parsed.transcriptionSocketRelativeToRuntimeRoot,
    "transcription socket",
  );
  const transcriptionStaging = resolveContainedPath(
    runtimeRoot,
    parsed.transcriptionStagingRelativeToRuntimeRoot,
    "transcription staging",
  );
  return HostLaunchConfigurationSchema.parse({
    repositoryRoot: packageRoot,
    runtimeRoot,
    listen: parsed.listen,
    rendererOrigin: parsed.rendererOrigin,
    transcriptionSocket,
    transcriptionStaging,
    nodePath: resolveBundleRelativePath(packageRoot, parsed.nodePath, "packaged node"),
    runtimeCliPath: resolveBundleRelativePath(packageRoot, parsed.runtimeCliPath, "packaged runtime CLI"),
    identityPath,
    endpointPolicy: parsed.endpointPolicy,
    endpointWorkingDirectory: parsed.endpointWorkingDirectory,
    recordingEndpointName: parsed.recordingEndpointName,
    transcriptionEndpointName: parsed.transcriptionEndpointName,
  });
}

function resolvePackagedRuntimeRoot(
  relativePath: string,
  context?: HostInspectionContext,
): string {
  if (!context) return resolveUserHomeRelativePath(relativePath, "runtime root");

  const runtimeRoot = trustedRuntimeRoot(context, "packaged");
  if (relativePath === MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH) {
    const containerSupportRoot = trustedContainerSupportRoot(context);
    const expectedRuntimeRoot = path.join(containerSupportRoot, "Meetless");
    if (runtimeRoot !== expectedRuntimeRoot) {
      throw trustedContextError(
        `MAS runtime root ${runtimeRoot} differs from the supplied app-container support root ${containerSupportRoot}`,
      );
    }
    return runtimeRoot;
  }
  if (context.containerSupportRoot !== undefined) {
    throw trustedContextError("a MAS app-container support root was supplied for a direct-DMG runtime");
  }
  if (relativePath !== DIRECT_RUNTIME_ROOT_RELATIVE_PATH ||
      !runtimeRoot.endsWith(`/${DIRECT_RUNTIME_ROOT_RELATIVE_PATH}`)) {
    throw trustedContextError(
      `direct-DMG runtime root ${runtimeRoot} does not match the accepted relative path ${relativePath}`,
    );
  }
  return runtimeRoot;
}

function trustedRuntimeRoot(context: HostInspectionContext, mode: string): string {
  if (!context.runtimeRoot || !path.isAbsolute(context.runtimeRoot)) {
    throw trustedContextError(`${mode} runtime root must be an absolute path`);
  }
  return path.resolve(context.runtimeRoot);
}

function trustedContainerSupportRoot(context: HostInspectionContext): string {
  if (!context.containerSupportRoot || !path.isAbsolute(context.containerSupportRoot)) {
    throw trustedContextError("MAS app-container support root must be supplied as an absolute path");
  }
  const containerSupportRoot = path.resolve(context.containerSupportRoot);
  if (!containerSupportRoot.endsWith(MACOS_APP_CONTAINER_SUPPORT_ROOT_SUFFIX)) {
    throw trustedContextError(
      `MAS app-container support root ${containerSupportRoot} is outside the Meetless app container`,
    );
  }
  return containerSupportRoot;
}

function trustedContextError(reason: string): Error {
  return new Error(
    `trusted Meetless host inspection context is invalid: ${reason}. ` +
      "Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md and docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. " +
      "Next action: derive the runtime and app-container support roots from RuntimeConfig and stop before child launch.",
  );
}

function resolveBundleRelativePath(bundleRoot: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`host ${label} must be a relative bundle path: ${relativePath}`);
  }
  const resolved = path.resolve(bundleRoot, relativePath);
  const relative = path.relative(bundleRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`host ${label} escapes its bundle: ${relativePath}`);
  }
  return resolved;
}

function resolveUserHomeRelativePath(relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`host ${label} must be relative to the current user home: ${relativePath}`);
  }
  return path.resolve(homedir(), ...relativePath.split("/"));
}

function resolveContainedPath(parent: string, relativePath: string, label: string): string {
  const resolved = resolveBundleRelativePath(parent, relativePath, label);
  if (resolved === path.resolve(parent)) throw new Error(`host ${label} cannot be the runtime root`);
  return resolved;
}

function readFileSyncRequired(filePath: string, label: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    throw new Error(`host ${label} is unavailable at ${filePath}: ${message(error)}`);
  }
}

function parseJsonRequired(bytes: Buffer, filePath: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`host JSON is invalid at ${filePath}: ${message(error)}`);
  }
}

export async function readHostIdentity(identityPath: string): Promise<HostIdentity> {
  return HostIdentitySchema.parse(JSON.parse(await readFile(identityPath, "utf8")));
}

export function hostIdentityEquals(left: unknown, right: unknown): boolean {
  const leftResult = HostIdentitySchema.safeParse(left);
  const rightResult = HostIdentitySchema.safeParse(right);
  return leftResult.success && rightResult.success && deepValueEqual(leftResult.data, rightResult.data);
}

export function assertExactInstalledHostPath(bundlePath: string): void {
  if (path.resolve(bundlePath) !== MEETLESS_HOST_INSTALL_PATH) {
    throw new Error(
      `Meetless runtime launch rejected for ${bundlePath}. Move Meetless.app to ${MEETLESS_HOST_INSTALL_PATH}, then open the copy there; do not launch from a mounted disk image or another folder.`,
    );
  }
}

export function assertStableHostIdentity(
  previous: HostIdentity,
  current: HostIdentity,
  options: { packagedDeveloperIdVerified?: boolean } = {},
): void {
  const exactLocationAndOwner =
    previous.bundleIdentifier === MEETLESS_HOST_BUNDLE_ID &&
    current.bundleIdentifier === MEETLESS_HOST_BUNDLE_ID &&
    previous.bundlePath === MEETLESS_HOST_INSTALL_PATH &&
    previous.bundleRealPath === MEETLESS_HOST_INSTALL_PATH &&
    current.bundlePath === MEETLESS_HOST_INSTALL_PATH &&
    current.bundleRealPath === MEETLESS_HOST_INSTALL_PATH;
  const stable = exactLocationAndOwner && previous.designatedRequirement === current.designatedRequirement;
  const legacyMigration = exactLocationAndOwner &&
    options.packagedDeveloperIdVerified === true &&
    /^cdhash H"[0-9A-Fa-f]{40}"$/u.test(previous.designatedRequirement) &&
    previous.designatedRequirement !== current.designatedRequirement;
  if (!stable && !legacyMigration) {
    throw hostFailure(
      "host replacement changed the exact installed path, bundle identifier, or designated requirement; identity refresh is refused",
    );
  }
}

export async function assertInstalledHostIdentity(
  config: RuntimeConfig,
  dependencies: Pick<HostInspectionDependencies, "inspectInstalled" | "readRecorded"> = defaultDependencies,
): Promise<HostIdentity> {
  try {
    assertExactInstalledHostPath(config.host.bundle);
  } catch (error) {
    throw hostFailure(message(error));
  }
  let installed: HostIdentity;
  let recorded: HostIdentity;
  try {
    [installed, recorded] = await Promise.all([
      dependencies.inspectInstalled(config.host.bundle, trustedHostInspectionContext(config)),
      dependencies.readRecorded(config.host.identity),
    ]);
  } catch (error) {
    throw hostFailure(`cannot attest the installed host: ${message(error)}`);
  }
  const parsedInstalled = parseHostIdentity(installed, "installed");
  const parsedRecorded = parseHostIdentity(recorded, "recorded");
  if (!deepValueEqual(parsedInstalled, parsedRecorded)) {
    throw hostFailure(
      "installed bundle identity drifted from its recorded designated requirement/CDHash/binary identity",
    );
  }
  let expectedConfiguration: HostLaunchConfiguration;
  try {
    expectedConfiguration = expectedHostConfiguration(config);
  } catch (error) {
    throw hostFailure(message(error));
  }
  if (!deepValueEqual(parsedInstalled.configuration, expectedConfiguration)) {
    throw hostFailure("installed host repository/runtime configuration differs from this production runtime");
  }
  if (
    parsedInstalled.bundlePath !== path.resolve(config.host.bundle) ||
    parsedInstalled.bundleRealPath !== path.resolve(config.host.bundle)
  ) {
    throw hostFailure(`installed host is not at the canonical path ${config.host.bundle}`);
  }
  return parsedInstalled;
}

export async function assertDesktopLaunchedByHost(
  config: RuntimeConfig,
  currentPid = process.pid,
  dependencies: HostInspectionDependencies = defaultDependencies,
): Promise<HostIdentity> {
  const identity = await assertInstalledHostIdentity(config, dependencies);
  const desktop = await dependencies.inspectProcess(currentPid);
  const host = await dependencies.inspectProcess(desktop.ppid);
  await assertExactTopology(identity, desktop, host, config, dependencies.inspectLiveHost);
  return identity;
}

export async function assertSupervisorOwnedByHost(
  config: RuntimeConfig,
  supervisorPid: number,
  dependencies: HostInspectionDependencies = defaultDependencies,
): Promise<{
  identity: HostIdentity;
  hostPid: number;
  desktopPid: number;
  supervisorPid: number;
}> {
  const identity = await assertInstalledHostIdentity(config, dependencies);
  const supervisor = await dependencies.inspectProcess(supervisorPid);
  const desktop = await dependencies.inspectProcess(supervisor.ppid);
  const host = await dependencies.inspectProcess(desktop.ppid);
  await assertExactTopology(identity, desktop, host, config, dependencies.inspectLiveHost);
  return { identity, hostPid: host.pid, desktopPid: desktop.pid, supervisorPid };
}

export function expectedHostConfiguration(config: RuntimeConfig): HostLaunchConfiguration {
  const endpointConfiguration = config.packaged && config.endpoints.mode === "packaged"
    ? {
      endpointPolicy: config.endpoints.schema,
      endpointWorkingDirectory: MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
      recordingEndpointName: config.endpoints.recording.name,
      transcriptionEndpointName: config.endpoints.transcription.name,
    }
    : {};
  const nodePath = config.packaged
    ? config.packageResources?.nodeBinary
    : process.execPath;
  if (!nodePath || (config.packaged && !path.isAbsolute(nodePath))) {
    throw new Error(
      "packaged runtime has no exact absolute nodeBinary in RuntimeConfig.packageResources. " +
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. " +
        "Next action: rebuild the packaged resource manifest and stop before child launch.",
    );
  }
  return {
    repositoryRoot: path.resolve(config.paths.plugin, "..", ".."),
    runtimeRoot: config.paths.root,
    listen: config.listen,
    rendererOrigin: config.rendererOrigin,
    transcriptionSocket: config.paths.transcriptionSocket,
    transcriptionStaging: config.paths.transcriptionStaging,
    nodePath,
    runtimeCliPath: path.join(path.resolve(config.paths.plugin, "..", ".."), "packages", "runtime", "dist", "cli.js"),
    identityPath: config.host.identity,
    ...endpointConfiguration,
  };
}

export function trustedHostInspectionContext(config: RuntimeConfig): HostInspectionContext {
  const containerSupportRoot = config.environment.MEETLESS_APP_CONTAINER_SUPPORT_ROOT?.trim();
  return {
    runtimeRoot: config.paths.root,
    ...(containerSupportRoot ? { containerSupportRoot } : {}),
  };
}

function validateHostEndpointPolicy(recording: string, transcription: string): void {
  try {
    validateEndpointName("recording", recording);
    validateEndpointName("transcription", transcription);
  } catch (error) {
    throw endpointConfigurationError("packaged host endpoint name is invalid", error);
  }
  if (recording === transcription) {
    throw endpointConfigurationError("packaged recording and transcription endpoint names must remain distinct");
  }
}

function hasPackagedEndpointPolicyShape(configuration: Record<string, unknown>): boolean {
  return configuration.endpointPolicy === MEETLESS_RUNTIME_ENDPOINTS_SCHEMA &&
    configuration.endpointWorkingDirectory === MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY &&
    typeof configuration.recordingEndpointName === "string" &&
    typeof configuration.transcriptionEndpointName === "string";
}

function endpointConfigurationError(reason: string, detail?: unknown): Error {
  const suffix = detail ? `: ${message(detail)}` : "";
  return new Error(
    `${reason}${suffix}. Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md, ` +
      "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md, and the accepted MEETLESS_RUNTIME_ENDPOINTS v1 package/runtime endpoint contract. " +
      "Next action: rebuild host-config.json and the installation contract from the accepted versioned endpoint policy; stop before child launch.",
  );
}

async function assertExactTopology(
  identity: HostIdentity,
  desktop: ProcessIdentity,
  host: ProcessIdentity,
  config: RuntimeConfig,
  inspectLiveHost: (bundlePath: string, context?: HostInspectionContext) => Promise<HostIdentity>,
): Promise<void> {
  if (path.resolve(host.executablePath) !== path.resolve(identity.executablePath)) {
    throw hostFailure(
      `responsible ancestor ${host.executablePath} is not the installed MeetlessHost executable; ` +
      "Paseo.app, Terminal, Codex, and other outer applications are rejected",
    );
  }
  const [desktopExecutable, configuredNode, hostExecutable, installedExecutable] = await Promise.all([
    realpath(desktop.executablePath),
    realpath(identity.configuration.nodePath),
    realpath(host.executablePath),
    realpath(identity.executablePath),
  ]);
  if (
    host.executableDevice !== identity.binaryDevice ||
    host.executableInode !== identity.binaryInode ||
    host.executableSize !== identity.binarySize
  ) {
    throw hostFailure("live host executable device/inode/size differs from the installed identity");
  }
  const expectedDesktopArguments = [
    identity.configuration.nodePath,
    identity.configuration.runtimeCliPath,
    "desktop",
  ];
  if (
    desktopExecutable !== configuredNode ||
    desktop.arguments.length !== expectedDesktopArguments.length ||
    desktop.arguments.some((argument, index) => argument !== expectedDesktopArguments[index])
  ) {
    throw hostFailure(`runtime PID ${desktop.pid} is not the exact installed host desktop CLI child`);
  }
  if (host.ppid !== 1 || hostExecutable !== installedExecutable) {
    throw hostFailure(
      `runtime ancestry is not LaunchServices → ${config.host.bundle} → desktop; ` +
      "Terminal, Codex, Paseo, and direct executable launch are not accepted responsible ancestors",
    );
  }
  const liveIdentity = parseHostIdentity(
    await inspectLiveHost(identity.bundleRealPath, trustedHostInspectionContext(config)),
    "live",
  );
  if (!deepValueEqual(liveIdentity, identity)) {
    throw hostFailure("live host executable hash/CDHash/designated requirement differs from the installed identity");
  }
}

function parseHostIdentity(value: unknown, label: string): HostIdentity {
  const parsed = HostIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw hostFailure(`${label} host identity is not schema-valid and complete: ${parsed.error.message}`);
  }
  return parsed.data;
}

function deepValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => deepValueEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepValueEqual(left[key], right[key]));
  }
  return false;
}

async function inspectProcess(pid: number): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid process PID ${pid}`);
  const ppid = Number(inspectRequired("ps", ["-p", String(pid), "-o", "ppid="], `parent PID for ${pid}`));
  if (!Number.isInteger(ppid)) throw new Error(`cannot inspect parent PID for ${pid}`);
  const inspected = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-FDsin"], {
    encoding: "utf8",
  });
  const diagnostic = {
    command: "lsof",
    inspectorPath: "lsof",
    purpose: `executable identity for process PID ${pid}`,
    result: inspected,
  };
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`cannot inspect executable for process PID ${pid}: ${formatSpawnSyncDiagnostic(diagnostic)}`);
  }
  const stdout = normalizeSpawnSyncOutput(inspected.stdout);
  if (stdout == null || stdout.trim().length === 0) {
    throw new Error(`lsof returned empty executable output for process PID ${pid}: ${formatSpawnSyncDiagnostic(diagnostic)}`);
  }
  const entry = stdout.split("ftxt\n").slice(1).map((block) =>
    Object.fromEntries(block.split("\n").filter(Boolean).map((line) => [line[0], line.slice(1)])),
  ).find((fields) => fields.n && fields.D && fields.i && fields.s);
  if (!entry?.n?.startsWith("/") || !entry.D || !entry.i || !entry.s) {
    throw new Error(`lsof returned malformed executable output for process PID ${pid}: ${formatSpawnSyncDiagnostic(diagnostic)}`);
  }
  return {
    pid,
    ppid,
    executablePath: entry.n,
    arguments: await inspectNativeArgumentVector(pid),
    executableDevice: Number(entry.D),
    executableInode: Number(entry.i),
    executableSize: Number(entry.s),
  };
}

function inspectRequired(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Meetless host ${fact}: ${formatSpawnSyncDiagnostic({
      command,
      inspectorPath: command,
      purpose: fact,
      result,
    })}`);
  }
  const stdout = normalizeSpawnSyncOutput(result.stdout);
  return (stdout ?? "").trim();
}

function inspectRequiredOutput(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Meetless host ${fact}: ${formatSpawnSyncDiagnostic({
      command,
      inspectorPath: command,
      purpose: fact,
      result,
    })}`);
  }
  const stdout = normalizeSpawnSyncOutput(result.stdout);
  const stderr = normalizeSpawnSyncOutput(result.stderr);
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

function hostFailure(reason: string): Error {
  return new Error(
    `Production Meetless host attestation failed closed: ${reason}. ` +
    `Authority: ${RECORDING_READINESS_AUTHORITY}. Next action: run npm run host:install; ` +
    `if identity drift is reported, run npm run host:install -- --replace and grant capture only to ${MEETLESS_HOST_INSTALL_PATH}.`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
