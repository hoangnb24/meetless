import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { downloadArtifact } from "@electron/get";
import { signAsync } from "@electron/osx-sign";
import plist from "plist";
import {
  enumeratePackageEntries,
  inspectPackageMachOEntries,
} from "./lib/macos-package-inventory.mjs";
import {
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_CONTRACT,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
  validateEntitlementKeys,
  validateMacAppStoreEntitlementClosure,
} from "./lib/macos-app-store-contract.mjs";
import {
  macAppStoreInstallationContractBytes,
  macAppStoreInstallationContractSha256,
  macAppStorePackagedHostConfiguration,
  macAppStorePackagedMarker,
  validateMacAppStorePackageContract,
  validateMacAppStorePackagedHostConfiguration,
  validateMacAppStorePackagedMarker,
} from "./lib/macos-app-store-package-contract.mjs";
import { resolveMacOSDmgPaths } from "./lib/macos-dmg-contract.mjs";
import {
  MACOS_APP_STORE_DEVELOPMENT_AUTHORITY,
  MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES,
  R5_APP_STORE_BUNDLE_ID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME,
  R5_APP_STORE_TEAM_ID,
  classifyMacAppStoreDevelopmentMachO,
  createMacAppStoreDevelopmentSigningOptions,
  parseMacAppStoreDevelopmentEntitlementResult,
  parseUnsignedCodesignProfileDiagnostic,
  parseMacAppStoreDevelopmentArguments,
  prepareR5DevelopmentElectronInfo,
  prepareMacAppStoreDevelopmentInfo,
  projectMacAppStoreDevelopmentEntitlementEvidence,
  resolveMacAppStoreDevelopmentEmbeddedProfilePath,
  resolveR5DevelopmentPaseoCommit,
  validateMacAppStoreDevelopmentInfo,
  validateR5DevelopmentElectronFileOutput,
  validateR5DevelopmentElectronInfo,
  validateR5DevelopmentProfile,
  validateR5DevelopmentSignature,
  validateRevenueCatPublicSdkKey,
} from "./lib/macos-app-store-development.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseMacAppStoreDevelopmentArguments(process.argv.slice(2));
const publicSdkKey = readBuildScopedPublicSdkKey();
const packagePaths = resolveMacOSDmgPaths(repositoryRoot, { proofRoot: options.proofRoot });
const bundlePath = packagePaths.sourceAppPath;
const contentsPath = path.join(bundlePath, "Contents");
const packageRoot = path.join(contentsPath, "Resources", "meetless");
const nestedElectronAppPath = path.join(contentsPath, "Resources", "meetless", "runtime", "electron", "Electron.app");
const nestedElectronExecutablePath = path.join(nestedElectronAppPath, "Contents", "MacOS", "Electron");
const nestedElectronRelativePath = path.relative(bundlePath, nestedElectronExecutablePath).split(path.sep).join("/");
const directManifestPath = path.join(packagePaths.releaseRoot, "composition-manifest.direct.json");
const masManifestPath = path.join(packagePaths.releaseRoot, "app-store-development-manifest.json");
const installationContractPath = path.join(packageRoot, "installation-contract.json");
const packageMarkerPath = path.join(packageRoot, "meetless-package.json");
const hostConfigPath = path.join(contentsPath, "Resources", "host-config.json");
const parentEntitlementsPath = path.join(repositoryRoot, "native", "macos-host", "MeetlessAppStore.entitlements.plist");
const childEntitlementsPath = path.join(repositoryRoot, "native", "macos-host", "MeetlessAppStoreChild.entitlements.plist");

await main();

async function main() {
  assertDarwinArm64();
  await mkdir(options.proofRoot, { recursive: true, mode: 0o700 });
  const profileSnapshot = await snapshotProvisioningProfile(options.provisioningProfile);
  validateR5DevelopmentProfile(profileSnapshot.profile);
  await readSourceEntitlements();
  await requireExactDevelopmentIdentity(options.signingIdentity);

  await runComposer();
  const directComposition = await retainDirectCompositionManifest();
  await applyMacAppStorePackageContract();
  const archivePath = await downloadMasElectron();
  await replaceElectronRuntime(archivePath);
  await injectBuildInputs();
  await assertProfileSnapshotUnchanged(profileSnapshot);
  await signMasBundle(profileSnapshot.path);

  const evidence = await validateSignedArtifact({
    profile: profileSnapshot.profile,
    profileBytes: profileSnapshot.bytes,
    profileSnapshot,
    directComposition,
  });
  await writeFile(masManifestPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: "candidate",
    target: MACOS_APP_STORE_CONTRACT.target,
    artifactPath: bundlePath,
    proofRoot: options.proofRoot,
    manifestPath: masManifestPath,
    bundleIdentifier: evidence.signature.bundleIdentifier,
    teamId: evidence.signature.teamId,
    signingIdentity: evidence.signature.identity,
    profile: evidence.provisioningProfile,
    electron: evidence.electron,
    signatureVerified: evidence.signature.verified,
    nestedMachOCount: evidence.signature.nestedMachOCount,
    revenueCatPublicSdkKeyEmbedded: evidence.revenueCatPublicSdkKeyEmbedded,
    externalGates: evidence.externalGates,
  }, null, 2)}\n`);
}

function readBuildScopedPublicSdkKey() {
  const value = validateRevenueCatPublicSdkKey(process.env.MEETLESS_REVENUECAT_PUBLIC_SDK_KEY);
  delete process.env.MEETLESS_REVENUECAT_PUBLIC_SDK_KEY;
  return value;
}

function assertDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw developmentError(`Mac App Store development packaging requires darwin arm64, received ${process.platform} ${process.arch}`);
  }
}

async function snapshotProvisioningProfile(profilePath) {
  await requireRegularFile(profilePath, "provisioning profile");
  if (path.basename(profilePath) !== R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME) {
    throw developmentError(`provisioning profile filename ${path.basename(profilePath)} is not the accepted R5 profile`);
  }
  const bytes = await readFile(profilePath);
  const snapshotPath = path.join(options.proofRoot, "profile-snapshot.mobileprovision");
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  await chmod(snapshotPath, 0o400);
  await assertReadOnlyProfileMode(snapshotPath, "immutable provisioning-profile snapshot");
  const { stdout } = await run("security", ["cms", "-D", "-i", snapshotPath]);
  return {
    path: snapshotPath,
    bytes,
    sha256: sha256(bytes),
    profile: parsePlistDocument(stdout, "development provisioning profile snapshot"),
  };
}

async function readSourceEntitlements() {
  const parent = parsePlistDocument(await readFile(parentEntitlementsPath, "utf8"), "parent App Sandbox entitlements");
  const child = parsePlistDocument(await readFile(childEntitlementsPath, "utf8"), "inherited child App Sandbox entitlements");
  validateMacAppStoreEntitlementClosure(parent, child, {
    teamId: R5_APP_STORE_TEAM_ID,
    applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
  });
  return { parent, child };
}

async function requireExactDevelopmentIdentity(identity) {
  const { stdout } = await run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const exact = [...stdout.matchAll(new RegExp(`"${escapeRegExp(identity)}"`, "gu"))];
  if (exact.length !== 1) {
    throw developmentError(`keychain must expose exactly one ${identity} signing identity`);
  }
}

async function runComposer() {
  const arguments_ = [
    path.join(repositoryRoot, "scripts", "package-macos.mjs"),
    `--proof-root=${options.proofRoot}`,
    "--signing-mode=local-ad-hoc",
  ];
  if (options.buildNumber !== null) arguments_.push(`--build-number=${options.buildNumber}`);
  await run(process.execPath, arguments_, { cwd: repositoryRoot, env: environmentWithoutSdkKey() });
}

async function retainDirectCompositionManifest() {
  await requireRegularFile(packagePaths.manifestPath, "direct composition manifest");
  const manifestBytes = await readFile(packagePaths.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schema !== "MEETLESS_MACOS_PACKAGE v2" ||
    manifest.target !== "macos-arm64" ||
    manifest.proof?.mode !== "local-ad-hoc-disposable" ||
    manifest.signing?.mode !== "local-ad-hoc" ||
    manifest.signing?.localOnly !== true
  ) {
    throw developmentError("the MAS candidate did not receive the expected disposable local composition");
  }
  await rm(directManifestPath, { force: true });
  await rename(packagePaths.manifestPath, directManifestPath);
  return {
    path: path.relative(options.proofRoot, directManifestPath).split(path.sep).join("/"),
    sha256: sha256(manifestBytes),
    artifactDigest: manifest.artifactDigest,
  };
}

async function applyMacAppStorePackageContract() {
  const contractBytes = macAppStoreInstallationContractBytes();
  const contractSha256 = macAppStoreInstallationContractSha256();
  const contract = JSON.parse(contractBytes.toString("utf8"));
  const marker = macAppStorePackagedMarker({ paseoCommit: await resolveR5DevelopmentPaseoCommit(repositoryRoot) });
  const hostConfiguration = macAppStorePackagedHostConfiguration({ contractSha256 });
  validateMacAppStorePackageContract(contract);
  validateMacAppStorePackagedMarker(marker, { contractSha256 });
  validateMacAppStorePackagedHostConfiguration(hostConfiguration, { contractSha256 });
  await writeFile(installationContractPath, contractBytes, { mode: 0o644 });
  await writeFile(packageMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
  await writeFile(hostConfigPath, `${JSON.stringify(hostConfiguration, null, 2)}\n`, { mode: 0o644 });
}

async function assertProfileSnapshotUnchanged(snapshot) {
  const current = await readFile(snapshot.path);
  if (!current.equals(snapshot.bytes)) {
    throw developmentError("the immutable provisioning-profile snapshot changed before signing");
  }
}

async function downloadMasElectron() {
  const electron = MACOS_APP_STORE_CONTRACT.electron;
  const archivePath = await downloadArtifact({
    version: electron.version,
    platform: electron.platform,
    arch: electron.arch,
    artifactName: "electron",
    cacheRoot: path.join(options.proofRoot, "electron-cache"),
    tempDirectory: options.proofRoot,
  });
  if (path.basename(archivePath) !== electron.archiveName) {
    throw developmentError(`Electron download returned ${path.basename(archivePath)}, expected ${electron.archiveName}`);
  }
  return archivePath;
}

async function replaceElectronRuntime(archivePath) {
  const extractionRoot = path.join(options.proofRoot, "electron-mas");
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
  await run("ditto", ["-x", "-k", archivePath, extractionRoot]);
  const extractedAppPath = path.join(extractionRoot, "Electron.app");
  await requireDirectory(extractedAppPath, "extracted Electron MAS app");
  const extractedInfo = parsePlistDocument(
    await readFile(path.join(extractedAppPath, "Contents", "Info.plist"), "utf8"),
    "extracted Electron MAS Info.plist",
  );
  const preparedInfo = prepareR5DevelopmentElectronInfo(extractedInfo);
  const extractedExecutablePath = path.join(extractedAppPath, "Contents", "MacOS", "Electron");
  await requireRegularFile(extractedExecutablePath, "extracted Electron MAS executable");
  const { stdout: fileOutput } = await run("file", [extractedExecutablePath]);
  validateR5DevelopmentElectronFileOutput(fileOutput);
  await rm(nestedElectronAppPath, { recursive: true, force: true });
  await cp(extractedAppPath, nestedElectronAppPath, { recursive: true, verbatimSymlinks: true });
  await writeFile(
    path.join(nestedElectronAppPath, "Contents", "Info.plist"),
    plist.build(preparedInfo),
    { mode: 0o644 },
  );
}

async function injectBuildInputs() {
  const infoPath = path.join(contentsPath, "Info.plist");
  const info = parsePlistDocument(await readFile(infoPath, "utf8"), "outer Info.plist");
  const prepared = prepareMacAppStoreDevelopmentInfo(info, publicSdkKey);
  await writeFile(infoPath, plist.build(prepared), { mode: 0o644 });
}

async function signMasBundle(provisioningProfilePath) {
  const signingOptions = createMacAppStoreDevelopmentSigningOptions({
    bundlePath,
    parentEntitlementsPath,
    childEntitlementsPath,
  });
  await signAsync({
    app: bundlePath,
    platform: "mas",
    type: "development",
    identity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    identityValidation: false,
    provisioningProfile: provisioningProfilePath,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: true,
    strictVerify: true,
    ignore: signingOptions.ignore,
    optionsForFile: signingOptions.optionsForFile,
  });
  await assertReadOnlyProfileMode(
    resolveMacAppStoreDevelopmentEmbeddedProfilePath(bundlePath),
    "embedded development provisioning profile",
  );
}

async function validateSignedArtifact({ profile, profileBytes, profileSnapshot, directComposition }) {
  const packagedContract = await readPackagedContractFiles();
  await assertProfileSnapshotUnchanged(profileSnapshot);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const outerSignature = validateR5DevelopmentSignature(
    await readCodesignDisplay(bundlePath),
    "Meetless.app",
  );
  const outerInfo = parsePlistDocument(await readFile(path.join(contentsPath, "Info.plist"), "utf8"), "signed outer Info.plist");
  validateMacAppStoreDevelopmentInfo(outerInfo, { publicSdkKey });
  const actualParent = await readCodesignEntitlements(
    bundlePath,
    MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT,
    "signed parent app",
    { expectedExecutablePath: path.join(bundlePath, "Contents", "MacOS", "MeetlessHost") },
  );
  validateEntitlementKeys(
    actualParent,
    MACOS_APP_STORE_PARENT_ENTITLEMENTS,
    "signed parent app",
    { applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}` },
  );

  const profilePath = resolveMacAppStoreDevelopmentEmbeddedProfilePath(bundlePath);
  await requireRegularFile(profilePath, "embedded development provisioning profile");
  await assertReadOnlyProfileMode(profilePath, "embedded development provisioning profile");
  const embeddedProfileBytes = await readFile(profilePath);
  if (!embeddedProfileBytes.equals(profileBytes)) {
    throw developmentError("embedded development provisioning profile bytes differ from the immutable selected-profile snapshot");
  }
  const embeddedProfile = validateR5DevelopmentProfile(
    parsePlistDocument((await run("security", ["cms", "-D", "-i", profilePath])).stdout, "embedded development provisioning profile"),
  );
  if (embeddedProfile.UUID !== profile.UUID || embeddedProfile.Name !== profile.Name) {
    throw developmentError("signed bundle embeds a different R5 development profile");
  }
  await assertUnsignedCodesignProfileData(profilePath);

  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries, { ownerMode: true });
  const outerMachOPath = "Contents/MacOS/MeetlessHost";
  const outerMachOEntry = machoEntries.find((entry) => entry.path === outerMachOPath);
  if (!outerMachOEntry) throw developmentError("signed package is missing the outer MeetlessHost Mach-O executable");
  const outerMachOPolicy = classifyMacAppStoreDevelopmentMachO(outerMachOEntry, { outerMachOPath });
  validateMachOEntry(outerMachOEntry, "outer MeetlessHost");
  const outerMachOAbsolutePath = path.join(bundlePath, outerMachOPath);
  await run("codesign", ["--verify", "--strict", "--verbose=2", outerMachOAbsolutePath]);
  validateR5DevelopmentSignature(
    await readCodesignDisplay(outerMachOAbsolutePath),
    "outer MeetlessHost",
    { expectedBundleIdentifier: null },
  );
  const outerMachOEntitlements = await readCodesignEntitlements(
    outerMachOAbsolutePath,
    outerMachOPolicy.entitlementPolicy,
    "outer MeetlessHost",
  );
  validateMachOEntitlements(outerMachOEntitlements, outerMachOPolicy, "outer MeetlessHost");
  const electronEntry = machoEntries.find((entry) => entry.path === nestedElectronRelativePath);
  if (!electronEntry) throw developmentError("signed package is missing the MAS Electron executable");
  validateR5DevelopmentElectronFileOutput(await runFile(nestedElectronExecutablePath));
  if (electronEntry.machOArchitecture !== "arm64" || electronEntry.machOSlices?.length !== 1) {
    throw developmentError("signed MAS Electron executable is not a thin arm64 Mach-O");
  }
  validateR5DevelopmentElectronInfo(
    parsePlistDocument(
      await readFile(path.join(nestedElectronAppPath, "Contents", "Info.plist"), "utf8"),
      "signed Electron MAS Info.plist",
    ),
    { requireElectronTeamId: true, requireBundleIdentifier: true },
  );
  validateR5DevelopmentSignature(
    await readCodesignDisplay(nestedElectronExecutablePath),
    "signed MAS Electron",
    { expectedBundleIdentifier: R5_APP_STORE_BUNDLE_ID },
  );

  const nestedSignatures = [];
  for (const entry of machoEntries.filter((candidate) => candidate.path !== outerMachOPath)) {
    const absolute = path.join(bundlePath, entry.path);
    const machOPolicy = classifyMacAppStoreDevelopmentMachO(entry, { outerMachOPath });
    await run("codesign", ["--verify", "--strict", "--verbose=2", absolute]);
    const signature = validateR5DevelopmentSignature(
      await readCodesignDisplay(absolute),
      entry.path,
      { expectedBundleIdentifier: null },
    );
    const entitlements = await readCodesignEntitlements(absolute, machOPolicy.entitlementPolicy, entry.path);
    const entitlementEvidence = validateMachOEntitlements(entitlements, machOPolicy, entry.path);
    validateMachOEntry(entry, entry.path);
    nestedSignatures.push({
      path: entry.path,
      identifier: signature.identifier,
      teamId: signature.teamId,
      identity: signature.identity,
      cdHash: signature.cdHash,
      architecture: entry.machOArchitecture,
      fileType: entry.machOFileType,
      entitlementKeys: entitlementEvidence.entitlementKeys,
    });
  }

  return {
    schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
    authority: MACOS_APP_STORE_DEVELOPMENT_AUTHORITY,
    target: MACOS_APP_STORE_CONTRACT.target,
    bundlePath: path.relative(options.proofRoot, bundlePath).split(path.sep).join("/"),
    bundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    teamId: R5_APP_STORE_TEAM_ID,
    signingIdentity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    revenueCatPublicSdkKeyEmbedded: true,
    provisioningProfile: {
      name: profile.Name,
      uuid: profile.UUID,
      sha256: profileSnapshot.sha256,
      provisionedDevices: [profile.ProvisionedDevices[0]],
      expirationDate: profile.ExpirationDate instanceof Date
        ? profile.ExpirationDate.toISOString()
        : new Date(profile.ExpirationDate).toISOString(),
    },
    signature: {
      verified: true,
      bundleIdentifier: outerSignature.identifier,
      teamId: outerSignature.teamId,
      identity: outerSignature.identity,
      signature: outerSignature.signature,
      cdHash: outerSignature.cdHash,
      nestedMachOCount: nestedSignatures.length,
      nestedMachO: nestedSignatures,
    },
    entitlements: {
      parentKeys: Object.keys(actualParent).sort(),
      childKeys: MACOS_APP_STORE_CHILD_ENTITLEMENTS,
      applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
    },
    electron: {
      version: MACOS_APP_STORE_CONTRACT.electron.version,
      platform: MACOS_APP_STORE_CONTRACT.electron.platform,
      arch: MACOS_APP_STORE_CONTRACT.electron.arch,
      archiveName: MACOS_APP_STORE_CONTRACT.electron.archiveName,
      executable: nestedElectronRelativePath,
      architecture: "arm64",
      thin: true,
    },
    artifact: {
      sha256: sha256(JSON.stringify(entries)),
      entryCount: entries.length,
      machoEntryCount: machoEntries.length,
    },
    packagedContract,
    directComposition,
    externalGates: {
      launch: "not-run",
      purchase: "not-run",
      distribution: "not-claimed",
    },
  };
}

async function readPackagedContractFiles() {
  const contractBytes = await readFile(installationContractPath);
  const contract = parseJsonObject(contractBytes, "packaged MAS installation contract");
  const contractSha256 = sha256(contractBytes);
  validateMacAppStorePackageContract(contract);
  const marker = parseJsonObject(await readFile(packageMarkerPath), "packaged MAS marker");
  validateMacAppStorePackagedMarker(marker, { contractSha256 });
  const hostConfiguration = parseJsonObject(await readFile(hostConfigPath), "packaged MAS host configuration");
  validateMacAppStorePackagedHostConfiguration(hostConfiguration, { contractSha256 });
  return {
    schema: contract.schema,
    runtimeRootRelativePath: contract.userSupportRelativePath,
    recordingExportsRelativePath: contract.recordingExportsRelativePath,
    contractSha256,
    markerTarget: marker.target,
    hostRuntimeRootRelativePath: hostConfiguration.runtimeRootRelativeToUserHome,
  };
}

function validateMachOEntry(entry, label) {
  if (entry.machOArchitecture !== "arm64" || entry.machOSlices?.length !== 1) {
    throw developmentError(`${label} is not a thin arm64 Mach-O executable`);
  }
}

function parseJsonObject(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    throw developmentError(`${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function readCodesignDisplay(target) {
  const result = await run("codesign", ["--display", "--verbose=4", target]);
  return `${result.stdout}\n${result.stderr}`;
}

async function readCodesignEntitlements(
  target,
  entitlementPolicy,
  label = target,
  { expectedExecutablePath = target } = {},
) {
  let result;
  try {
    const commandResult = await run("codesign", ["--display", "--entitlements", ":-", target]);
    result = { exitCode: 0, stdout: commandResult.stdout, stderr: commandResult.stderr };
  } catch (error) {
    result = {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: error?.stdout,
      stderr: error?.stderr,
    };
  }
  const parsed = parseMacAppStoreDevelopmentEntitlementResult(result, {
    entitlementPolicy,
    executablePath: expectedExecutablePath,
    label,
  });
  if (parsed.kind === "absent") return null;
  return parsePlistDocument(parsed.plist, `${label} signed entitlements`);
}

function validateMachOEntitlements(entitlements, policy, label) {
  const evidence = projectMacAppStoreDevelopmentEntitlementEvidence(
    entitlements,
    policy.entitlementPolicy,
    label,
  );
  if (policy.entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE) return evidence;
  validateEntitlementKeys(
    entitlements,
    policy.expectedEntitlementKeys,
    label,
    policy.entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
      ? { applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}` }
      : undefined,
  );
  return evidence;
}

async function assertUnsignedCodesignProfileData(profilePath) {
  try {
    const result = await run("codesign", ["--display", "--verbose=2", profilePath]);
    parseUnsignedCodesignProfileDiagnostic(
      { exitCode: 0, stdout: result.stdout, stderr: result.stderr },
      "embedded development provisioning profile",
    );
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      return parseUnsignedCodesignProfileDiagnostic(
        { exitCode: error.code, stdout: error.stdout, stderr: error.stderr },
        "embedded development provisioning profile",
      );
    }
    throw error;
  }
}

async function runFile(target) {
  return (await run("file", [target])).stdout;
}

async function requireRegularFile(target, label) {
  const state = await lstat(target).catch(() => null);
  if (!state?.isFile()) throw developmentError(`${label} is missing or is not a regular file`);
}

async function requireDirectory(target, label) {
  const state = await stat(target).catch(() => null);
  if (!state?.isDirectory()) throw developmentError(`${label} is missing or is not a directory`);
}

async function assertReadOnlyProfileMode(target, label) {
  const state = await lstat(target).catch(() => null);
  if (!state?.isFile() || (state.mode & 0o777) !== 0o400) {
    throw developmentError(`${label} must remain a regular file with mode 0400`);
  }
}

function parsePlistDocument(text, label) {
  const source = String(text ?? "");
  const xmlStart = source.indexOf("<?xml");
  const plistStart = source.indexOf("<plist");
  const start = xmlStart >= 0 && (plistStart < 0 || xmlStart < plistStart) ? xmlStart : plistStart;
  const end = source.indexOf("</plist>", start);
  if (start < 0 || end < 0) throw developmentError(`${label} did not produce a plist document`);
  try {
    return plist.parse(source.slice(start, end + "</plist>".length));
  } catch (error) {
    throw developmentError(`${label} is not valid plist XML (${error instanceof Error ? error.message : String(error)})`);
  }
}

function environmentWithoutSdkKey() {
  const environment = { ...process.env };
  delete environment.MEETLESS_REVENUECAT_PUBLIC_SDK_KEY;
  return environment;
}

function run(command, arguments_, options_ = {}) {
  return execFileAsync(command, arguments_, {
    maxBuffer: 32 * 1024 * 1024,
    env: environmentWithoutSdkKey(),
    ...options_,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function developmentError(reason) {
  return new Error(`${reason}. Authority: ${MACOS_APP_STORE_DEVELOPMENT_AUTHORITY}. Next action: stop before using the artifact until the exact R5 development contract is restored.`);
}
