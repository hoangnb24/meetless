import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { resolveMacOSDmgPaths } from "./lib/macos-dmg-contract.mjs";
import {
  MACOS_APP_STORE_DEVELOPMENT_AUTHORITY,
  R5_APP_STORE_BUNDLE_ID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_TEAM_ID,
  parseMacAppStoreDevelopmentArguments,
  prepareMacAppStoreDevelopmentInfo,
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
const nestedElectronAppPath = path.join(contentsPath, "Resources", "meetless", "runtime", "electron", "Electron.app");
const nestedElectronExecutablePath = path.join(nestedElectronAppPath, "Contents", "MacOS", "Electron");
const nestedElectronRelativePath = path.relative(bundlePath, nestedElectronExecutablePath).split(path.sep).join("/");
const directManifestPath = path.join(packagePaths.releaseRoot, "composition-manifest.direct.json");
const masManifestPath = path.join(packagePaths.releaseRoot, "app-store-development-manifest.json");
const parentEntitlementsPath = path.join(repositoryRoot, "native", "macos-host", "MeetlessAppStore.entitlements.plist");
const childEntitlementsPath = path.join(repositoryRoot, "native", "macos-host", "MeetlessAppStoreChild.entitlements.plist");

await main();

async function main() {
  assertDarwinArm64();
  const profile = await readProvisioningProfile(options.provisioningProfile);
  validateR5DevelopmentProfile(profile);
  await readSourceEntitlements();
  await requireExactDevelopmentIdentity(options.signingIdentity);

  await runComposer();
  const directComposition = await retainDirectCompositionManifest();
  const archivePath = await downloadMasElectron();
  await replaceElectronRuntime(archivePath);
  await injectBuildInputs();
  await signMasBundle();

  const evidence = await validateSignedArtifact({ profile, directComposition });
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

async function readProvisioningProfile(profilePath) {
  await requireRegularFile(profilePath, "provisioning profile");
  const { stdout } = await run("security", ["cms", "-D", "-i", profilePath]);
  return parsePlistDocument(stdout, "development provisioning profile");
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
  validateR5DevelopmentElectronInfo(extractedInfo);
  const extractedExecutablePath = path.join(extractedAppPath, "Contents", "MacOS", "Electron");
  await requireRegularFile(extractedExecutablePath, "extracted Electron MAS executable");
  const { stdout: fileOutput } = await run("file", [extractedExecutablePath]);
  validateR5DevelopmentElectronFileOutput(fileOutput);
  await rm(nestedElectronAppPath, { recursive: true, force: true });
  await cp(extractedAppPath, nestedElectronAppPath, { recursive: true, verbatimSymlinks: true });
}

async function injectBuildInputs() {
  const infoPath = path.join(contentsPath, "Info.plist");
  const info = parsePlistDocument(await readFile(infoPath, "utf8"), "outer Info.plist");
  const prepared = prepareMacAppStoreDevelopmentInfo(info, publicSdkKey);
  await writeFile(infoPath, plist.build(prepared), { mode: 0o644 });
}

async function signMasBundle() {
  await signAsync({
    app: bundlePath,
    platform: "mas",
    type: "development",
    identity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    identityValidation: false,
    provisioningProfile: options.provisioningProfile,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: true,
    strictVerify: true,
    optionsForFile(filePath) {
      const target = path.resolve(filePath) === path.resolve(bundlePath) ? parentEntitlementsPath : childEntitlementsPath;
      return { entitlements: target, hardenedRuntime: false, timestamp: "none" };
    },
  });
}

async function validateSignedArtifact({ profile, directComposition }) {
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const outerSignature = validateR5DevelopmentSignature(
    await readCodesignDisplay(bundlePath),
    "Meetless.app",
  );
  const outerInfo = parsePlistDocument(await readFile(path.join(contentsPath, "Info.plist"), "utf8"), "signed outer Info.plist");
  validateMacAppStoreDevelopmentInfo(outerInfo, { publicSdkKey });
  const actualParent = await readCodesignEntitlements(bundlePath);
  validateEntitlementKeys(
    actualParent,
    MACOS_APP_STORE_PARENT_ENTITLEMENTS,
    "signed parent app",
    { applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}` },
  );

  const profilePath = path.join(contentsPath, "embedded.provisionprofile");
  await requireRegularFile(profilePath, "embedded development provisioning profile");
  const embeddedProfileBytes = await readFile(profilePath);
  const inputProfileBytes = await readFile(options.provisioningProfile);
  if (sha256(embeddedProfileBytes) !== sha256(inputProfileBytes)) {
    throw developmentError("embedded development provisioning profile bytes differ from the selected profile");
  }
  const embeddedProfile = validateR5DevelopmentProfile(
    parsePlistDocument((await run("security", ["cms", "-D", "-i", profilePath])).stdout, "embedded development provisioning profile"),
  );
  if (embeddedProfile.UUID !== profile.UUID || embeddedProfile.Name !== profile.Name) {
    throw developmentError("signed bundle embeds a different R5 development profile");
  }

  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries, { ownerMode: true });
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
  );

  const nestedSignatures = [];
  for (const entry of machoEntries) {
    const absolute = path.join(bundlePath, entry.path);
    await run("codesign", ["--verify", "--strict", "--verbose=2", absolute]);
    const signature = validateR5DevelopmentSignature(
      await readCodesignDisplay(absolute),
      entry.path,
      { expectedBundleIdentifier: null },
    );
    const entitlements = await readCodesignEntitlements(absolute);
    validateEntitlementKeys(entitlements, MACOS_APP_STORE_CHILD_ENTITLEMENTS, entry.path);
    if (entry.machOArchitecture !== "arm64" || entry.machOSlices?.length !== 1) {
      throw developmentError(`${entry.path} is not a thin arm64 Mach-O executable`);
    }
    nestedSignatures.push({
      path: entry.path,
      identifier: signature.identifier,
      teamId: signature.teamId,
      identity: signature.identity,
      cdHash: signature.cdHash,
      architecture: entry.machOArchitecture,
      fileType: entry.machOFileType,
      entitlementKeys: Object.keys(entitlements).sort(),
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
      sha256: sha256(inputProfileBytes),
      provisionedDevices: [profile.ProvisionedDevices[0]],
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
    directComposition,
    externalGates: {
      launch: "not-run",
      purchase: "not-run",
      distribution: "not-claimed",
    },
  };
}

async function readCodesignDisplay(target) {
  const result = await run("codesign", ["--display", "--verbose=4", target]);
  return `${result.stdout}\n${result.stderr}`;
}

async function readCodesignEntitlements(target) {
  const result = await run("codesign", ["--display", "--entitlements", ":-", target]);
  return parsePlistDocument(`${result.stdout}\n${result.stderr}`, `${target} signed entitlements`);
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
