import path from "node:path";

export const MACOS_APP_STORE_DEVELOPMENT_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_NAME = "Meetless Mac App Store R5 Sandbox Development";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_UUID = "828a0bac-887f-4e60-9e4b-9da7690178bc";
export const R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME = `${R5_APP_STORE_DEVELOPMENT_PROFILE_UUID}.provisionprofile`;
export const R5_APP_STORE_DEVELOPMENT_DEVICE_UDID = "00006041-000861C60EFA401C";
export const R5_APP_STORE_DEVELOPMENT_IDENTITY = "Apple Development: Long Le (335C7MY4H4)";
export const R5_APP_STORE_TEAM_ID = "63M98WD275";
export const R5_APP_STORE_BUNDLE_ID = "com.meetless.app";
export const R5_REVENUECAT_INFO_PLIST_KEY = "MeetlessRevenueCatAPIKey";

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

export function validateR5DevelopmentProfile(profile) {
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

function matchLine(text, key) {
  return text.match(new RegExp(`^${key}=(.+)$`, "mu"))?.[1]?.trim() ?? null;
}

function developmentError(reason) {
  return new Error(`${reason}. Authority: ${MACOS_APP_STORE_DEVELOPMENT_AUTHORITY}. Next action: use the exact accepted R5 development profile, identity, and build-scoped public Apple SDK key.`);
}
