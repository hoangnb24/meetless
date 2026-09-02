import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
} from "./macos-app-store-contract.mjs";
import { PASEO_DEPENDENCY } from "./paseo-dependency.mjs";

const execFileAsync = promisify(execFile);

export const MACOS_APP_STORE_DEVELOPMENT_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_NAME = "Meetless Mac App Store R5 Sandbox Development";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_UUID = "828a0bac-887f-4e60-9e4b-9da7690178bc";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME = `${R5_APP_STORE_DEVELOPMENT_PROFILE_UUID}.mobileprovision`;
export const R5_APP_STORE_DEVELOPMENT_DEVICE_UDID = "00006041-000861C60EFA401C";
export const R5_APP_STORE_DEVELOPMENT_IDENTITY = "Apple Development: Long Le (335C7MY4H4)";
export const R5_APP_STORE_TEAM_ID = "63M98WD275";
export const R5_APP_STORE_BUNDLE_ID = "com.meetless.app";
export const R5_REVENUECAT_INFO_PLIST_KEY = "MeetlessRevenueCatAPIKey";
export const MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES = Object.freeze({
  PARENT: "parent",
  CHILD: "child",
  NONE: "none",
});

const MACOS_APP_STORE_DEVELOPMENT_MACHO_POLICIES = Object.freeze({
  parent: Object.freeze({
    entitlementPolicy: MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT,
    expectedEntitlementKeys: MACOS_APP_STORE_PARENT_ENTITLEMENTS,
  }),
  child: Object.freeze({
    entitlementPolicy: MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD,
    expectedEntitlementKeys: MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  }),
  none: Object.freeze({
    entitlementPolicy: MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE,
    expectedEntitlementKeys: Object.freeze([]),
  }),
});
const MACOS_APP_STORE_DEVELOPMENT_MACHO_FILE_TYPES = new Set(["MH_EXECUTE", "MH_BUNDLE", "MH_DYLIB"]);
const MACOS_CODESIGN_ENTITLEMENT_WARNING = "warning: Specifying ':' in the path is deprecated and will not work in a future release";

export function resolveR5DevelopmentProfilePath(userHome = homedir()) {
  return path.join(
    userHome,
    "Library",
    "Developer",
    "Xcode",
    "UserData",
    "Provisioning Profiles",
    R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME,
  );
}

export function resolveMacAppStoreDevelopmentEmbeddedProfilePath(bundlePath) {
  return path.resolve(bundlePath, "Contents", "embedded.provisionprofile");
}

export function classifyMacAppStoreDevelopmentMachO(entry, { outerMachOPath = "Contents/MacOS/MeetlessHost" } = {}) {
  const relativePath = typeof entry?.path === "string" && entry.path ? entry.path : "Mach-O";
  const fileType = entry?.machOFileType;
  if (!MACOS_APP_STORE_DEVELOPMENT_MACHO_FILE_TYPES.has(fileType)) {
    throw developmentError(`${relativePath} has an unknown or ambiguous Mach-O file type ${String(fileType)}`);
  }
  if (relativePath === outerMachOPath && fileType !== "MH_EXECUTE") {
    throw developmentError(`${relativePath} must be an MH_EXECUTE Mach-O file`);
  }
  const entitlementPolicy = relativePath === outerMachOPath
    ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
    : fileType === "MH_EXECUTE"
      ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
      : MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE;
  return {
    fileType,
    ...MACOS_APP_STORE_DEVELOPMENT_MACHO_POLICIES[entitlementPolicy],
  };
}

export function parseMacAppStoreDevelopmentEntitlementResult(
  { exitCode, stdout = "", stderr = "" } = {},
  { entitlementPolicy, executablePath, label = "signed Mach-O" } = {},
) {
  if (!Object.values(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES).includes(entitlementPolicy)) {
    throw developmentError(`${label} has an unknown entitlement policy ${String(entitlementPolicy)}`);
  }
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw developmentError(`${label} entitlement inspection requires an absolute executable path`);
  }
  const resolvedExecutablePath = path.resolve(executablePath);
  if (exitCode !== 0) {
    throw developmentError(`${label} entitlement inspection failed with exit code ${String(exitCode)}`);
  }
  const expectedExecutableDiagnostics = `Executable=${resolvedExecutablePath}\n`;
  const expectedWarningDiagnostics = `${expectedExecutableDiagnostics}${MACOS_CODESIGN_ENTITLEMENT_WARNING}\n`;
  const actualDiagnostics = String(stderr ?? "");
  if (actualDiagnostics !== expectedExecutableDiagnostics && actualDiagnostics !== expectedWarningDiagnostics) {
    throw developmentError(`${label} entitlement inspection returned malformed codesign diagnostics`);
  }
  const entitlementPlist = String(stdout ?? "");
  if (entitlementPlist === "") {
    if (entitlementPolicy !== MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE) {
      throw developmentError(`${label} is missing its required entitlement plist`);
    }
    return { kind: "absent", entitlementPolicy };
  }
  const trimmedPlist = entitlementPlist.trim();
  if (!(trimmedPlist.startsWith("<?xml") || trimmedPlist.startsWith("<plist")) || !trimmedPlist.endsWith("</plist>")) {
    throw developmentError(`${label} entitlement inspection returned malformed plist output`);
  }
  if (entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE) {
    throw developmentError(`${label} must not contain an entitlement plist or entitlement keys`);
  }
  return { kind: "plist", entitlementPolicy, plist: entitlementPlist };
}

export function projectMacAppStoreDevelopmentEntitlementEvidence(
  entitlements,
  entitlementPolicy,
  label = "signed Mach-O",
) {
  if (!Object.values(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES).includes(entitlementPolicy)) {
    throw developmentError(`${label} has an unknown entitlement policy ${String(entitlementPolicy)}`);
  }
  if (entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE) {
    if (entitlements !== null) {
      throw developmentError(`${label} must not contain an entitlement plist or entitlement keys`);
    }
    return { entitlementKeys: [] };
  }
  if (entitlements === null) {
    throw developmentError(`${label} is missing its required entitlement plist`);
  }
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) {
    throw developmentError(`${label} entitlements must be a dictionary`);
  }
  return { entitlementKeys: Object.keys(entitlements).sort() };
}

export function createMacAppStoreDevelopmentSigningOptions({ bundlePath, parentEntitlementsPath, childEntitlementsPath }) {
  const resolvedBundlePath = path.resolve(bundlePath);
  const embeddedProfilePath = resolveMacAppStoreDevelopmentEmbeddedProfilePath(resolvedBundlePath);
  return {
    ignore(filePath) {
      return path.resolve(filePath) === embeddedProfilePath;
    },
    optionsForFile(filePath) {
      const entitlements = path.resolve(filePath) === resolvedBundlePath
        ? parentEntitlementsPath
        : childEntitlementsPath;
      return { entitlements, hardenedRuntime: false, timestamp: "none" };
    },
  };
}

export function parseUnsignedCodesignProfileDiagnostic({ exitCode, stdout = "", stderr = "" }, label = "embedded provisioning profile") {
  const diagnostic = "code object is not signed at all";
  if (exitCode !== 1) {
    const outcome = exitCode === 0 ? "succeeded" : `exited with ${String(exitCode)}`;
    throw developmentError(`${label} codesign display ${outcome}; expected the unsigned-code-object diagnostic`);
  }
  const output = `${String(stdout ?? "")}\n${String(stderr ?? "")}`;
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const expectedLine = lines.length === 1 && (lines[0] === diagnostic || lines[0].endsWith(`: ${diagnostic}`));
  if (!expectedLine) {
    throw developmentError(`${label} codesign display did not report the expected unsigned-code-object diagnostic`);
  }
  return { exitCode, diagnostic };
}

export async function resolveR5DevelopmentPaseoCommit(repositoryRoot, { execute = execFileAsync } = {}) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw paseoDevelopmentError("the MAS marker resolver requires an absolute repository root");
  }
  if (typeof execute !== "function") {
    throw paseoDevelopmentError("the MAS marker resolver requires a Git command executor");
  }
  const paseoPath = path.join(repositoryRoot, "vendor", "paseo");
  let result;
  try {
    result = await execute(
      "git",
      ["-C", paseoPath, "rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: repositoryRoot },
    );
  } catch (error) {
    throw paseoDevelopmentError(
      `cannot resolve the pinned Paseo commit from ${paseoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const commit = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw paseoDevelopmentError(`Git returned an invalid Paseo commit marker from ${paseoPath}`);
  }
  if (commit !== PASEO_DEPENDENCY.expectedCommit) {
    throw paseoDevelopmentError(
      `Paseo is pinned to ${PASEO_DEPENDENCY.expectedCommit}, but ${paseoPath} resolves to ${commit}`,
    );
  }
  return commit;
}

export function parseMacAppStoreDevelopmentArguments(arguments_) {
  if (!Array.isArray(arguments_)) throw developmentError("Mac App Store development arguments must be an array");
  const options = { proofRoot: null, provisioningProfile: null, signingIdentity: null, buildNumber: null };
  const names = new Map([
    ["--proof-root", "proofRoot"],
    ["--provisioning-profile", "provisioningProfile"],
    ["--signing-identity", "signingIdentity"],
    ["--build-number", "buildNumber"],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw developmentError(`unsupported Mac App Store development argument ${String(argument)}`);
    }
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const key = names.get(name);
    if (!key) throw developmentError(`unsupported Mac App Store development option ${name}`);
    if (options[key] !== null) throw developmentError(`${name} was supplied more than once`);
    const value = separator < 0 ? arguments_[++index] : argument.slice(separator + 1);
    if (typeof value !== "string" || !value || value.startsWith("--")) {
      throw developmentError(`${name} requires one explicit value`);
    }
    options[key] = value;
  }
  if (!options.proofRoot || !path.isAbsolute(options.proofRoot)) {
    throw developmentError("--proof-root must be an absolute disposable directory");
  }
  if (!options.provisioningProfile || !path.isAbsolute(options.provisioningProfile)) {
    throw developmentError("--provisioning-profile must be an absolute path");
  }
  if (options.signingIdentity !== R5_APP_STORE_DEVELOPMENT_IDENTITY) {
    throw developmentError(`--signing-identity must be ${R5_APP_STORE_DEVELOPMENT_IDENTITY}`);
  }
  if (options.buildNumber !== null && !/^[1-9][0-9]*$/u.test(options.buildNumber)) {
    throw developmentError("--build-number must be a positive integer");
  }
  return options;
}

export function validateRevenueCatPublicSdkKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^appl_[A-Za-z0-9_-]{8,}$/u.test(key)) {
    throw developmentError("MEETLESS_REVENUECAT_PUBLIC_SDK_KEY must be the Meetless public Apple SDK key");
  }
  return key;
}

export function prepareMacAppStoreDevelopmentInfo(info, publicSdkKey) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw developmentError("outer Info.plist is not a dictionary");
  }
  const prepared = {
    ...info,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
    [R5_REVENUECAT_INFO_PLIST_KEY]: validateRevenueCatPublicSdkKey(publicSdkKey),
  };
  validateMacAppStoreDevelopmentInfo(prepared, { publicSdkKey });
  return prepared;
}

export function validateMacAppStoreDevelopmentInfo(info, { publicSdkKey = null } = {}) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw developmentError("outer Info.plist is not a dictionary");
  }
  if (info.CFBundleIdentifier !== R5_APP_STORE_BUNDLE_ID) {
    throw developmentError("signed outer bundle identifier does not match com.meetless.app");
  }
  if (info.ElectronTeamID !== R5_APP_STORE_TEAM_ID) {
    throw developmentError("signed outer ElectronTeamID does not match the accepted Apple Team ID");
  }
  const actualKey = validateRevenueCatPublicSdkKey(info[R5_REVENUECAT_INFO_PLIST_KEY]);
  if (publicSdkKey !== null && actualKey !== validateRevenueCatPublicSdkKey(publicSdkKey)) {
    throw developmentError("signed outer Info.plist contains a different RevenueCat public SDK key");
  }
  return info;
}

export function validateR5DevelopmentSignature(output, label = "Meetless.app", { expectedBundleIdentifier = R5_APP_STORE_BUNDLE_ID } = {}) {
  const text = String(output ?? "");
  const identifier = matchLine(text, "Identifier");
  const teamId = matchLine(text, "TeamIdentifier");
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const signature = matchLine(text, "Signature") ?? (teamId && teamId !== "not set" ? "cms" : "adhoc");
  const cdHash = matchLine(text, "CDHash")?.toLowerCase() ?? null;
  if (!identifier || !/^[a-f0-9]{40}$/u.test(cdHash ?? "")) {
    throw developmentError(`signature evidence for ${label} is missing an identifier or CDHash`);
  }
  const identity = authorities[0] ?? null;
  if (expectedBundleIdentifier !== null && identifier !== expectedBundleIdentifier) {
    throw developmentError(`${label} signature identifier is ${identifier}, expected ${expectedBundleIdentifier}`);
  }
  if (teamId !== R5_APP_STORE_TEAM_ID) {
    throw developmentError(`${label} signature Team ID does not match the accepted Apple Team ID`);
  }
  if (identity !== R5_APP_STORE_DEVELOPMENT_IDENTITY) {
    throw developmentError(`${label} signature identity does not match the accepted Apple Development identity`);
  }
  if (signature.toLowerCase() === "adhoc") {
    throw developmentError(`${label} signature is ad-hoc, not certificate-backed Apple Development signing`);
  }
  return { label, identifier, teamId, identity, signature, cdHash };
}

export function validateR5DevelopmentElectronInfo(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw developmentError("extracted Electron MAS Info.plist is not a dictionary");
  }
  if (info.CFBundleExecutable !== "Electron") {
    throw developmentError("extracted Electron MAS bundle does not contain the Electron executable");
  }
  if (info.CFBundleVersion !== "41.2.0" && info.CFBundleShortVersionString !== "41.2.0") {
    throw developmentError("extracted Electron MAS bundle is not version 41.2.0");
  }
  return info;
}

export function validateR5DevelopmentElectronFileOutput(fileOutput) {
  const text = String(fileOutput ?? "");
  if (!/Mach-O 64-bit executable arm64\b/u.test(text) || /universal|x86_64|i386|arm64e/iu.test(text)) {
    throw developmentError("packaged Electron MAS executable is not a thin arm64 Mach-O executable");
  }
  return { architecture: "arm64" };
}

export function validateR5DevelopmentProfile(profile, { now = new Date() } = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw developmentError("development provisioning profile is not a dictionary");
  }
  if (profile.Name !== R5_APP_STORE_DEVELOPMENT_PROFILE_NAME || profile.UUID !== R5_APP_STORE_DEVELOPMENT_PROFILE_UUID) {
    throw developmentError("development provisioning profile identity does not match the accepted R5 profile");
  }
  if (profile.Entitlements?.["com.apple.application-identifier"] !== `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`) {
    throw developmentError("development provisioning profile application identifier does not match Meetless");
  }
  if (profile.Entitlements?.["com.apple.developer.team-identifier"] !== R5_APP_STORE_TEAM_ID) {
    throw developmentError("development provisioning profile team identifier does not match Meetless");
  }
  if (!isFutureProfileDate(profile.ExpirationDate, now)) {
    throw developmentError("development provisioning profile is expired or has no valid ExpirationDate");
  }
  if (!Array.isArray(profile.ProvisionedDevices) || profile.ProvisionedDevices.length !== 1 || profile.ProvisionedDevices[0] !== R5_APP_STORE_DEVELOPMENT_DEVICE_UDID) {
    throw developmentError("development provisioning profile must contain only the accepted Mac Studio");
  }
  if (profile.ProvisionsAllDevices === true) throw developmentError("development provisioning profile must not provision all devices");
  for (const field of ["ApplicationIdentifierPrefix", "TeamIdentifier"]) {
    if (field in profile && !isExactProfileTeamValue(profile[field])) {
      throw developmentError(`development provisioning profile ${field} does not match the accepted Apple Team ID`);
    }
  }
  return profile;
}

function isExactProfileTeamValue(value) {
  return Array.isArray(value)
    ? value.length === 1 && value[0] === R5_APP_STORE_TEAM_ID
    : value === R5_APP_STORE_TEAM_ID;
}

function isFutureProfileDate(value, now) {
  const expiration = value instanceof Date ? value : new Date(value ?? "");
  const reference = now instanceof Date ? now : new Date(now);
  return Number.isFinite(expiration.getTime()) && Number.isFinite(reference.getTime()) && expiration.getTime() > reference.getTime();
}

function matchLine(text, key) {
  return text.match(new RegExp(`^${key}=(.+)$`, "mu"))?.[1]?.trim() ?? null;
}

function developmentError(reason) {
  return new Error(`${reason}. Authority: ${MACOS_APP_STORE_DEVELOPMENT_AUTHORITY}. Next action: use the exact accepted R5 development profile, identity, and build-scoped public Apple SDK key.`);
}

function paseoDevelopmentError(reason) {
  return new Error(
    `${reason}. Authority: ${MACOS_APP_STORE_DEVELOPMENT_AUTHORITY} and docs/decisions/0001-maintained-paseo-fork.md. ` +
      "Next action: restore vendor/paseo to the accepted pinned commit before rebuilding the MAS marker.",
  );
}
