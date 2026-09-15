import { createHash, X509Certificate } from "node:crypto";
import path from "node:path";
import { MACOS_APP_STORE_PARENT_ENTITLEMENTS, validateEntitlementKeys } from "./macos-app-store-contract.mjs";
import { rm, lstat, readdir } from "node:fs/promises";
import {
  NATIVE_TEST_POLICY_REQUIRED,
  nativeTestEvidence,
  validateNativeTestPolicy,
} from "./native-test-policy.mjs";
import { R5_APP_STORE_TEAM_ID as TEAM, R5_APP_STORE_BUNDLE_ID as BUNDLE, validateBuildScopedConvexUrl, validateRevenueCatPublicSdkKey } from "./macos-app-store-development.mjs";

export const DISTRIBUTION_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
const fail = (message) => { throw new Error(`${message}. Authority: ${DISTRIBUTION_AUTHORITY}. Restore the explicit reviewed distribution inputs before packaging.`); };
export function parseMacAppStoreDistributionArguments(args) {
  const names = { "proof-root": "proofRoot", "provisioning-profile": "provisioningProfile", "signing-identity": "signingIdentity", "installer-identity": "installerIdentity", keychain: "keychain", "keychain-password-file": "keychainPasswordFile", version: "version", "build-number": "buildNumber", "sandbox-url": "sandboxUrl", "production-url": "productionUrl", "public-sdk-key": "publicSdkKey", "source-commit": "sourceCommit", "source-snapshot-sha256": "sourceSnapshotSha256", "native-test-policy": "nativeTestPolicy" };
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(args[i]);
    if (!match || !names[match[1]]) fail(`Unknown distribution option ${args[i]}`);
    const key = names[match[1]];
    if (Object.hasOwn(result, key)) fail(`Duplicate --${match[1]}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith("--")) fail(`Missing value for --${match[1]}`);
    result[key] = value;
  }
  for (const [name, key] of Object.entries(names)) if (name !== "native-test-policy" && !result[key]) fail(`Missing --${name}`);
  for (const key of ["proofRoot", "provisioningProfile", "keychain", "keychainPasswordFile"]) if (!path.isAbsolute(result[key])) fail(`${key} must be absolute`);
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(result.version)) fail("Version must be an explicit numeric marketing version");
  if (!/^[1-9][0-9]*$/u.test(result.buildNumber)) fail("Build number must be a positive integer");
  result.nativeTestPolicy = validateDistributionNativeTestPolicy(result);
  if (!/^[a-f0-9]{40}$/u.test(result.sourceCommit) || !/^[a-f0-9]{64}$/u.test(result.sourceSnapshotSha256)) fail("Source provenance must include exact commit and snapshot SHA-256");
  validateDistributionIdentity(result.signingIdentity, "app");
  validateDistributionIdentity(result.installerIdentity, "installer");
  validateRevenueCatPublicSdkKey(result.publicSdkKey);
  validateDistributionRouting(result.sandboxUrl, result.productionUrl);
  return result;
}
export function validateDistributionIdentity(identity, kind) {
  const prefix = kind === "app" ? "Apple Distribution: " : "3rd Party Mac Developer Installer: ";
  if (typeof identity !== "string" || !identity.startsWith(prefix) || !identity.endsWith(` (${TEAM})`) || identity.includes("\n")) fail(`Expected ${kind} distribution identity for team ${TEAM}`);
  return identity;
}
function validateDistributionNativeTestPolicy(options) {
  const policy = validateNativeTestPolicy(options.nativeTestPolicy ?? NATIVE_TEST_POLICY_REQUIRED);
  if (policy !== NATIVE_TEST_POLICY_REQUIRED && !(options.version === "1.0" && options.buildNumber === "4")) {
    fail("The owner-deferred internal beta native test policy is restricted to version 1.0 build 4");
  }
  return policy;
}
export function validateDistributionRouting(sandboxUrl, productionUrl) {
  for (const value of [sandboxUrl, productionUrl]) {
    validateBuildScopedConvexUrl(value);
    const url = new URL(value);
    if (url.origin !== value || !/^[a-z0-9-]+\.convex\.cloud$/u.test(url.hostname)) fail("Distribution backend must be a canonical HTTPS Convex deployment origin");
  }
  if (sandboxUrl === productionUrl) fail("Sandbox and production backends must be distinct");
}
export function validateDistributionSource(snapshot, options) {
  if (snapshot?.mode !== "package-source" || snapshot.head !== options.sourceCommit || snapshot.digest !== options.sourceSnapshotSha256) fail("Candidate source differs from reviewed commit/snapshot");
}
export function distributionConfiguration(options) {
  return { version: options.version, buildNumber: options.buildNumber, sandboxUrl: options.sandboxUrl, productionUrl: options.productionUrl, publicSdkKey: options.publicSdkKey, sourceCommit: options.sourceCommit, sourceSnapshotSha256: options.sourceSnapshotSha256 };
}
export function prepareDistributionInfo(info, options) {
  validateDistributionRouting(options.sandboxUrl, options.productionUrl);
  validateRevenueCatPublicSdkKey(options.publicSdkKey);
  const result = { ...info, CFBundleIconFile: "Meetless.icns", LSApplicationCategoryType: "public.app-category.productivity", ElectronTeamID: TEAM, CFBundleShortVersionString: options.version, CFBundleVersion: options.buildNumber, MeetlessRevenueCatAPIKey: options.publicSdkKey, MeetlessStoreBackendRouting: true, MeetlessConvexSandboxURL: options.sandboxUrl, MeetlessConvexProductionURL: options.productionUrl, MeetlessSourceCommit: options.sourceCommit, MeetlessSourceSnapshotSHA256: options.sourceSnapshotSha256, MeetlessDistributionConfigurationSHA256: createHash("sha256").update(JSON.stringify(distributionConfiguration(options))).digest("hex") };
  delete result.MeetlessConvexURL;
  validateDistributionInfo(result, options);
  return result;
}
export function validateDistributionInfo(info, options) {
  if (info?.CFBundleIdentifier !== BUNDLE || info.ElectronTeamID !== TEAM || info.MeetlessStoreBackendRouting !== true || Object.hasOwn(info, "MeetlessConvexURL")) fail("Signed distribution identity/routing mode is invalid");
  const expected = { CFBundleIconFile: "Meetless.icns", LSApplicationCategoryType: "public.app-category.productivity", CFBundleShortVersionString: options.version, CFBundleVersion: options.buildNumber, MeetlessRevenueCatAPIKey: options.publicSdkKey, MeetlessConvexSandboxURL: options.sandboxUrl, MeetlessConvexProductionURL: options.productionUrl, MeetlessSourceCommit: options.sourceCommit, MeetlessSourceSnapshotSHA256: options.sourceSnapshotSha256, MeetlessDistributionConfigurationSHA256: createHash("sha256").update(JSON.stringify(distributionConfiguration(options))).digest("hex") };
  for (const [key, value] of Object.entries(expected)) if (info[key] !== value) fail(`Signed ${key} differs from reviewed input`);
  validateDistributionRouting(info.MeetlessConvexSandboxURL, info.MeetlessConvexProductionURL);
  return info;
}
export function validateDistributionProfile(profile, { now = new Date() } = {}) {
  if (!profile || typeof profile.UUID !== "string" || !profile.UUID || !profile.Name || !Array.isArray(profile.Platform) || !profile.Platform.includes("OSX")) fail("Missing macOS distribution profile identity");
  if (!Array.isArray(profile.TeamIdentifier) || profile.TeamIdentifier.length !== 1 || profile.TeamIdentifier[0] !== TEAM || !Array.isArray(profile.ApplicationIdentifierPrefix) || profile.ApplicationIdentifierPrefix.length !== 1 || profile.ApplicationIdentifierPrefix[0] !== TEAM) fail("Profile team mismatch");
  const ent = profile.Entitlements;
  if (ent?.["com.apple.application-identifier"] !== `${TEAM}.${BUNDLE}` || ent?.["com.apple.developer.team-identifier"] !== TEAM) fail("Profile app/team entitlement mismatch");
  if (Object.hasOwn(profile, "ProvisionedDevices") || profile.ProvisionsAllDevices === true || ent["get-task-allow"] === true || ent["com.apple.security.get-task-allow"] === true) fail("Profile is development or direct distribution, not App Store distribution");
  if (!Array.isArray(profile.DeveloperCertificates) || profile.DeveloperCertificates.length === 0) fail("Profile missing signing certificates");
  if (!(new Date(profile.ExpirationDate).getTime() > new Date(now).getTime())) fail("Distribution profile expired");
  return profile;
}
export function validateDistributionSignature(output, identity, label = "app", { expectedBundleIdentifier = BUNDLE } = {}) {
  validateDistributionIdentity(identity, "app");
  const field = (name) => output.match(new RegExp(`^${name}=(.+)$`, "mu"))?.[1]?.trim();
  const identifier = field("Identifier"), cdHash = field("CDHash"), teamId = field("TeamIdentifier");
  if (!identifier || (expectedBundleIdentifier !== null && identifier !== expectedBundleIdentifier) || teamId !== TEAM || field("Authority") !== identity || field("Signature") === "adhoc" || !/^[a-f0-9]{40}$/u.test(cdHash ?? "")) fail(`${label} distribution signature mismatch`);
  return { identifier, cdHash, teamId, identity, signature: "cms" };
}
export function validateInstallerSignature(output, identity, { certificatePem } = {}) {
  validateDistributionIdentity(identity, "installer");
  if (!certificatePem) fail("Installer validation requires the selected public certificate");
  const cert = new X509Certificate(certificatePem);
  if (!cert.subject.split("\n").includes(`CN=${identity}`) || !cert.subject.split("\n").includes(`OU=${TEAM}`) || !cert.keyUsage?.includes("1.2.840.113635.100.4.9")) fail("Selected certificate lacks the Mac App Store Installer purpose or identity");
  const statuses = [...output.matchAll(/^\s*Status: (.+)$/gmu)].map((match) => match[1]);
  const accepted = ["signed by a certificate trusted by Mac OS X", "signed by a certificate trusted by macOS", "signed by a developer certificate issued by Apple (Development)"];
  const chain = [...output.matchAll(/^\s+(\d+)\. (.+)\n([\s\S]*?)(?=^\s+\d+\. |$(?![\s\S]))/gmu)];
  const leafFingerprint = chain[0]?.[3].match(/SHA256 Fingerprint:\s*([A-F0-9 \n]+?)(?=\s*-|$)/u)?.[1]?.replace(/\s/gu, "");
  if (statuses.length !== 1 || !accepted.includes(statuses[0]) || chain.length !== 3 || chain[0][1] !== "1" || chain[0][2] !== identity || chain[1][1] !== "2" || chain[1][2] !== "Apple Worldwide Developer Relations Certification Authority" || chain[2][1] !== "3" || chain[2][2] !== "Apple Root CA" || leafFingerprint !== cert.fingerprint256.replace(/:/gu, "")) fail("Installer signature is not the selected Apple-anchored distribution identity");
  return { identity, verified: true, certificateSha256: cert.fingerprint256.replace(/:/gu, "").toLowerCase(), certificatePurpose: "1.2.840.113635.100.4.9" };
}

export function validateDistributionProfileCertificate(profile, pem) {
  const selected = new X509Certificate(pem);
  const matches = profile.DeveloperCertificates.some((value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "base64");
    return new X509Certificate(bytes).fingerprint256 === selected.fingerprint256;
  });
  if (!matches) fail("Selected distribution certificate is not authorized by the provisioning profile");
  return selected.fingerprint256;
}

// The producer must rebuild, even when outputs already exist. These callbacks
// are injected only to exercise failure ordering without signing a fixture.
export async function buildReviewedDistributionSource({ options, readSnapshot, clean, build }) {
  const nativeTestPolicy = validateDistributionNativeTestPolicy(options);
  validateDistributionSource(await readSnapshot(), options);
  await clean();
  await build();
  validateDistributionSource(await readSnapshot(), options);
  const nativeTests = nativeTestEvidence(nativeTestPolicy);
  return {
    command: "npm run build",
    ...(nativeTestPolicy === NATIVE_TEST_POLICY_REQUIRED ? {} : { arguments: [`--native-test-policy=${nativeTestPolicy}`] }),
    clean: true,
    sourceCommit: options.sourceCommit,
    sourceSnapshotSha256: options.sourceSnapshotSha256,
    nativeTests,
  };
}

export async function rebuildDistributionSource({ repositoryRoot, options, run, readSnapshot }) {
  return buildReviewedDistributionSource({
    options,
    readSnapshot,
    clean: async () => {
      // Fixed generated-output closure only; never installed apps or user data.
      const packages = ["meeting-domain", "meeting-contracts", "meeting-store", "managed-transcription-foundation", "meeting-surface", "meetless-client", "meetless-plugin", "runtime", "meetless-app"];
      const paseoPackages = ["protocol", "relay", "client", "plugin", "highlight", "server", "cli", "desktop"];
      for (const relative of [...packages.map((name) => `packages/${name}/dist`), ...paseoPackages.map((name) => `vendor/paseo/packages/${name}/dist`)]) {
        await rm(path.join(repositoryRoot, relative), { recursive: true, force: true });
      }
      // Desktop inherits incremental=true; its cache lives beside tsconfig,
      // outside dist. Keeping it can make tsc skip missing output entirely.
      await rm(path.join(repositoryRoot, "vendor/paseo/packages/desktop/tsconfig.tsbuildinfo"), { force: true });
      for (const nativePackage of ["native/macos-host", "native/macos-capture"]) await run("swift", ["package", "--package-path", nativePackage, "clean"], { cwd: repositoryRoot });
    },
    build: () => {
      const arguments_ = ["run", "build"];
      const nativeTestPolicy = options.nativeTestPolicy ?? NATIVE_TEST_POLICY_REQUIRED;
      if (nativeTestPolicy !== NATIVE_TEST_POLICY_REQUIRED) arguments_.push("--", `--native-test-policy=${nativeTestPolicy}`);
      return run("npm", arguments_, { cwd: repositoryRoot });
    },
  });
}

export function prepareDistributionEntitlements(parent, profile) {
  validateDistributionProfile(profile);
  validateEntitlementKeys(parent, MACOS_APP_STORE_PARENT_ENTITLEMENTS, "distribution base parent", { applicationGroup: `${TEAM}.${BUNDLE}` });
  return { ...parent, "com.apple.application-identifier": profile.Entitlements["com.apple.application-identifier"], "com.apple.developer.team-identifier": profile.Entitlements["com.apple.developer.team-identifier"] };
}
export function validateDistributionEntitlements(actual, profile) {
  validateDistributionProfile(profile);
  const identifiers = ["com.apple.application-identifier", "com.apple.developer.team-identifier"];
  const base = { ...actual };
  for (const key of identifiers) {
    if (actual?.[key] !== profile?.Entitlements?.[key] || typeof actual?.[key] !== "string") fail(`Signed ${key} must match the provisioning profile`);
    delete base[key];
  }
  validateEntitlementKeys(base, MACOS_APP_STORE_PARENT_ENTITLEMENTS, "distribution signed parent", { applicationGroup: `${TEAM}.${BUNDLE}` });
  return actual;
}
export function validateDistributionIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) fail("Invalid ICNS container");
  let offset = 8, required = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail("Truncated ICNS chunk");
    const kind = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > bytes.length) fail("Invalid ICNS chunk size");
    if (kind === "ic10") {
      const png = bytes.subarray(offset + 8, offset + size);
      if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024) fail("ICNS 512pt @2x must contain the 1024px PNG");
      required = true;
    }
    offset += size;
  }
  if (!required) fail("ICNS missing required 512pt @2x representation");
  return { format: "icns", has512ptAt2x: true };
}
export async function validateDistributionReadableClosure(bundlePath) {
  let files = 0, directories = 0;
  async function visit(target) {
    const state = await lstat(target);
    if (state.isSymbolicLink()) return;
    if (state.isDirectory()) {
      if ((state.mode & 0o005) !== 0o005) fail(`Distribution directory is not readable/traversable by non-root users: ${path.relative(bundlePath, target)}`);
      directories++;
      for (const name of await readdir(target)) await visit(path.join(target, name));
    } else if (state.isFile()) {
      if ((state.mode & 0o004) === 0) fail(`Distribution file is not readable by non-root users: ${path.relative(bundlePath, target)}`);
      files++;
    } else fail("Unsupported distribution filesystem entry");
  }
  await visit(bundlePath);
  return { nonRootReadable: true, files, directories };
}
