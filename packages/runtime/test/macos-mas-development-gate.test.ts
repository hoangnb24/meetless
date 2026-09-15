import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createMasHostHandoff,
  classifyMasLsofResult,
  inspectListeners,
  inspectMasLiveState,
  inspectOpenHandles,
  installMasDevelopmentGate,
  launchMasDevelopmentGate,
  MAS_LSOF_MAX_BUFFER_BYTES,
  MAS_LSOF_PURPOSES,
  MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
  MAS_GATE_LAUNCH_FAILURE_CATEGORIES,
  MAS_GATE_HANDOFF_PREDICATE_GROUPS,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  masLiveAbsentObservation,
  readMasDevelopmentGateStatus,
  readMasGateSessionStatus,
  restoreMasDevelopmentGate,
  restoreInRequiredOrder,
  serializeMasDevelopmentGateFailure,
  stopMasDevelopmentGate,
  validateMasDevelopmentInstallArtifact,
  validateMasDevelopmentInstalledSignatures,
  validateMasHostHandoff,
} from "../../../scripts/macos-mas-development-gate.mjs";
import {
  MAS_GATE_SESSION_INDEX_BASENAME,
  MAS_GATE_SESSION_INDEX_INTENT_BASENAME,
  MAS_GATE_SESSION_INDEX_SCHEMA,
  MAS_GATE_SESSION_INDEX_VERSION,
  archiveMasGateSessionTransaction,
  attestMasGateRuntimeRoot,
  beginMasGateSessionTransaction,
  restoreMasGateSessionTransaction,
} from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";
import {
  MAS_GATE_LOCK_BASENAME,
  acquireMasGateLock,
  masGateLockPath,
  withMasGateLock,
} from "../../../scripts/lib/macos-mas-gate-lock.mjs";
import {
  createMacOSAppStoreDirectCompositionSource,
  finalizeMacOSAppStorePackageEvidence,
  MACOS_MAS_EMBEDDED_PROFILE_PATH,
  prepareMacOSAppStorePackageEvidence,
  stageMacOSAppStoreEmbeddedProfile,
  verifyMacOSAppStorePackageEvidenceSources,
  validateMasPackageEvidenceInputs,
} from "../../../scripts/lib/macos-app-store-package-evidence.mjs";
import {
  MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
  MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
  MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES,
  MACOS_MAS_OUTER_CODE_RESOURCES_PATH,
  validateMacOSMasSigningBoundaryEntries,
} from "../../../scripts/lib/macos-mas-signing-boundary.mjs";
import { freezeMasGateArtifactBinding } from "../../../scripts/lib/mas-gate-artifact-binding.mjs";
import {
  enumeratePackageEntries,
  inspectPackageMachOEntries,
} from "../../../scripts/lib/macos-package-inventory.mjs";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  createLicenseInventoryPackageInputBinding,
  digestArtifactEntries,
  selectArtifactEntriesForDigest,
  writeMacOSLicenseInventory,
} from "../../../scripts/lib/macos-license-inventory.mjs";
import {
  macAppStoreInstallationContractBytes,
  macAppStoreInstallationContractSha256,
  macAppStorePackagedHostConfiguration,
  macAppStorePackagedMarker,
} from "../../../scripts/lib/macos-app-store-package-contract.mjs";
import {
  fingerprintPath,
  packageTransactionPaths,
  replacePackageBundle,
  restorePackageTransaction,
} from "../../../scripts/lib/macos-package-transaction.mjs";
import {
  createMacOSPackageElectronArchiveSource,
  buildMacOSPackageInputSpecs,
  collectMacOSPackageInputs,
  digestJson,
  MACOS_PACKAGE_ELECTRON_LAYOUT_DIRECT,
  MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
  snapshotBinding,
} from "../../../scripts/lib/macos-package-inputs.mjs";
import { MACOS_APP_STORE_CONTRACT } from "../../../scripts/lib/macos-app-store-contract.mjs";
import { collectCandidateSnapshot } from "../../../scripts/candidate-snapshot.mjs";
import {
  digestManifest,
  validateLicenseInventoryCoverage,
} from "../../../scripts/validate-macos-package.mjs";
import {
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
} from "../../../scripts/lib/macos-app-store-contract.mjs";
import { HOSTED_DEV_TARGET } from "../../../scripts/prove-managed-convex-hosted-dev-target.mjs";
import {
  MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES,
  R5_APP_STORE_DEVELOPMENT_DEVICE_UDID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
  R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
  R5_APP_STORE_BUNDLE_ID,
  R5_APP_STORE_ELECTRON_BUNDLE_ID,
  R5_APP_STORE_TEAM_ID,
  R5_CONVEX_INFO_PLIST_KEY,
  R5_REVENUECAT_INFO_PLIST_KEY,
  R5_APP_STORE_DEVELOPMENT_CONVEX_URL,
} from "../../../scripts/lib/macos-app-store-development.mjs";
import plist from "plist";

const roots: string[] = [];
const execFile = promisify(execFileCallback);
const MAS_FIXTURE_ARCHIVE_BYTES = Buffer.from("deterministic MAS archive fixture bytes\n");
const MAS_FIXTURE_ARCHIVE_SHA256 = createHash("sha256").update(MAS_FIXTURE_ARCHIVE_BYTES).digest("hex");
const MAS_FIXTURE_CONVEX_URL = "https://meetless-fixture.convex.cloud/";
let sharedMasValidationFixture: ReturnType<typeof makeMasValidationFixture> | null = null;
let sharedMasValidationFixtureRoot: string | null = null;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  if (sharedMasValidationFixtureRoot) await rm(sharedMasValidationFixtureRoot, { recursive: true, force: true });
});

async function captureLaunchFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return serializeMasDevelopmentGateFailure(error);
  }
  throw new Error("expected the MAS launch fixture to fail closed");
}

function captureSynchronousFailure(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    return serializeMasDevelopmentGateFailure(error);
  }
  throw new Error("expected the MAS handoff fixture to fail closed");
}

async function seedMasSessionIndex(context: ReturnType<typeof masDevelopmentRuntimeContext>) {
  const indexPath = path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME);
  await writeFile(
    indexPath,
    `${JSON.stringify({
      schema: MAS_GATE_SESSION_INDEX_SCHEMA,
      version: MAS_GATE_SESSION_INDEX_VERSION,
      runtimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: context.activePath,
      indexPath,
      indexIntentPath: path.join(context.parentPath, MAS_GATE_SESSION_INDEX_INTENT_BASENAME),
      entries: [],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function createDirectCompositionFixture({ template, candidateSnapshot, packageInputs, inventory, entries, machoEntries }: {
  template: Record<string, any>;
  candidateSnapshot: Record<string, any>;
  packageInputs: Record<string, any>;
  inventory: Record<string, any>;
  entries: Array<Record<string, any>>;
  machoEntries: Array<Record<string, any>>;
}) {
  const inventoryEntry = entries.find((entry) => entry.path === MACOS_LICENSE_INVENTORY_PATH && entry.type === "file");
  if (!inventoryEntry) throw new Error("direct composition fixture is missing its license inventory entry");
  const candidateBinding = snapshotBinding(candidateSnapshot);
  const directComposition = {
    ...template,
    sourceCommit: candidateBinding.head,
    paseoCommit: candidateBinding.paseoCommit,
    candidateSnapshot: candidateBinding,
    packageInputs,
    licenseInventory: {
      schema: inventory.schema,
      path: MACOS_LICENSE_INVENTORY_PATH,
      sha256: inventoryEntry.sha256,
      artifactEntryDigest: inventory.artifact.entryBinding.digest,
      excludedPathPrefixes: inventory.artifact.entryBinding.excludedPathPrefixes,
      excludedPaths: inventory.artifact.entryBinding.excludedPaths,
      componentCount: inventory.components.length,
      packageInputDigest: inventory.artifact.packageInputBinding.digest,
      packageInputArtifactDigest: inventory.artifact.packageInputBinding.artifactInputDigest,
    },
    renderer: {
      ...template.renderer,
      ...entries.find((entry) => entry.path === template.renderer.entry),
    },
    entries,
    macho: machoEntries.map((entry) => entry.path),
  };
  return {
    ...directComposition,
    artifactDigest: digestManifest({ ...directComposition, artifactDigest: undefined }),
  };
}

async function makeMasValidationFixture() {
  if (sharedMasValidationFixture) return sharedMasValidationFixture;
  const proofRoot = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-validation-fixture-")));
  sharedMasValidationFixtureRoot = proofRoot;
  const bundle = path.join(proofRoot, "release", "macos", "Meetless.app");
  const manifestPath = path.join(proofRoot, "release", "macos", "app-store-development-manifest.json");
  await mkdir(path.dirname(bundle), { recursive: true, mode: 0o700 });
  await execFile("/bin/cp", ["-cR", path.resolve("release/macos/Meetless.app"), bundle]);
  const legacyElectronAppPath = path.join(bundle, "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app");
  const nestedElectronAppPath = path.join(bundle, "Contents", "Helpers", "Electron.app");
  await execFile("/bin/cp", [
    "-cR",
    path.resolve("packages/managed-transcription-foundation/dist"),
    path.join(bundle, "Contents", "Resources", "meetless", "packages", "managed-transcription-foundation"),
  ]);
  // Compose the direct source before relocation through the existing direct
  // package-input and inventory owners; retain those bytes unchanged while
  // the shared MAS owner derives the post-relocation evidence below.
  const collectedSnapshot = collectCandidateSnapshot("package-source");
  const candidateSnapshot = {
    command: snapshotBinding(collectedSnapshot).command,
    ...collectedSnapshot,
    paseoCommit: collectedSnapshot.dependencyArtifacts.paseo.expectedCommit,
  };
  const directPackageInputCollection = await collectMacOSPackageInputs({
    bundlePath: bundle,
    repositoryRoot: path.resolve("."),
    candidateSnapshot,
  });
  const directInventory = await writeMacOSLicenseInventory({
    bundlePath: bundle,
    repositoryRoot: path.resolve("."),
    candidateSnapshot,
    packageInputManifest: directPackageInputCollection.manifest,
    packageMetadata: directPackageInputCollection.packageMetadata,
  });
  const directEntries = await enumeratePackageEntries(bundle);
  const directMachOEntries = await inspectPackageMachOEntries(bundle, directEntries, { ownerMode: true });
  const directTemplate = JSON.parse((await readFile(path.join("release", "macos", "composition-manifest.json"))).toString("utf8"));
  const directComposition = createDirectCompositionFixture({
    template: directTemplate,
    candidateSnapshot,
    packageInputs: directPackageInputCollection.manifest,
    inventory: directInventory,
    entries: directEntries,
    machoEntries: directMachOEntries,
  });
  const directCompositionBytes = Buffer.from(`${JSON.stringify(directComposition)}\n`);
  const directCompositionSource = createMacOSAppStoreDirectCompositionSource({
    binding: {
      path: "release/macos/composition-manifest.direct.json",
      sha256: createHash("sha256").update(directCompositionBytes).digest("hex"),
      artifactDigest: directComposition.artifactDigest,
    },
    manifest: directComposition,
  });
  const profile = {
    Name: R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
    UUID: R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
    Entitlements: {
      "com.apple.application-identifier": [R5_APP_STORE_TEAM_ID, R5_APP_STORE_BUNDLE_ID].join("."),
      "com.apple.developer.team-identifier": R5_APP_STORE_TEAM_ID,
    },
    ExpirationDate: new Date("2099-01-01T00:00:00.000Z"),
    ProvisionedDevices: [R5_APP_STORE_DEVELOPMENT_DEVICE_UDID],
  };
  const profileBytes = Buffer.from(plist.build(profile));
  await mkdir(path.dirname(nestedElectronAppPath), { recursive: true, mode: 0o755 });
  await rename(legacyElectronAppPath, nestedElectronAppPath);
  for (const framework of ["Mantle.framework", "ReactiveObjC.framework", "Squirrel.framework"]) {
    await rm(path.join(nestedElectronAppPath, "Contents", "Frameworks", framework), { recursive: true, force: true });
  }
  for (const relativePath of MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES) {
    await rm(path.join(bundle, relativePath), { force: true });
  }
  const archivePath = path.join(proofRoot, MACOS_APP_STORE_CONTRACT.electron.archiveName);
  await writeFile(archivePath, MAS_FIXTURE_ARCHIVE_BYTES, { mode: 0o600 });
  const electronArchiveSource = await createMacOSPackageElectronArchiveSource({
    archivePath,
    expectedSha256: MAS_FIXTURE_ARCHIVE_SHA256,
  });
  const embeddedProfile = await stageMacOSAppStoreEmbeddedProfile({
    bundlePath: bundle,
    profileBytes,
  });
  const packageEvidence = await prepareMacOSAppStorePackageEvidence({
    bundlePath: bundle,
    repositoryRoot: path.resolve("."),
    candidateSnapshot: directCompositionSource.candidateSnapshot,
    priorManifest: directCompositionSource.packageInputs,
    electronArchiveSource,
    embeddedProfile,
    profileBytes,
    expectedElectronArchiveSha256: MAS_FIXTURE_ARCHIVE_SHA256,
  });
  const preSignEntries = await enumeratePackageEntries(bundle);
  const preSignMachOEntries = await inspectPackageMachOEntries(bundle, preSignEntries, { ownerMode: true });
  const simulatedOuterCodeResourcesPath = path.join(bundle, MACOS_MAS_OUTER_CODE_RESOURCES_PATH);
  await writeFile(simulatedOuterCodeResourcesPath, "simulated final outer CodeResources fixture\n", { mode: 0o644 });
  for (const [index, relativePath] of MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES.entries()) {
    const codeResourcesPath = path.join(bundle, relativePath);
    await mkdir(path.dirname(codeResourcesPath), { recursive: true, mode: 0o755 });
    await writeFile(codeResourcesPath, `simulated nested signer output ${index}\n`, { mode: 0o644 });
  }
  const entries = await enumeratePackageEntries(bundle);
  const inspectedEntries = await inspectPackageMachOEntries(bundle, entries, { ownerMode: true });
  const inventoryPath = path.join(bundle, packageEvidence.licenseInventory.path);
  const inventoryBytes = await readFile(inventoryPath);
  const outerExecutablePath = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  const nestedElectronExecutablePath = path.join(
    bundle,
    "Contents",
    "Helpers",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  const nestedElectronRelativePath = path.relative(bundle, nestedElectronExecutablePath).split(path.sep).join("/");
  const normalElectronHelperIdentifier = "com.github.Electron.helper";
  const nestedSignatureIdentifier = (relativePath: string) => relativePath === nestedElectronRelativePath
    ? R5_APP_STORE_ELECTRON_BUNDLE_ID
    : relativePath.endsWith("Electron Helper.app/Contents/MacOS/Electron Helper")
      ? normalElectronHelperIdentifier
      : "com.github.Electron.nested";
  const profilePath = path.join(bundle, "Contents", "embedded.provisionprofile");
  const publicSdkKey = "appl_test_fixture_public_key";
  const convexUrl = MAS_FIXTURE_CONVEX_URL;
  const contract = macAppStoreInstallationContractBytes();
  const contractSha256 = macAppStoreInstallationContractSha256();
  const marker = Buffer.from(`${JSON.stringify(macAppStorePackagedMarker({ paseoCommit: directCompositionSource.candidateSnapshot.paseoCommit }))}\n`);
  const hostConfiguration = Buffer.from(`${JSON.stringify(macAppStorePackagedHostConfiguration({ contractSha256 }))}\n`);
  const parentEntitlements = Object.fromEntries(MACOS_APP_STORE_PARENT_ENTITLEMENTS.map((key) => [
    key,
    key === "com.apple.security.application-groups" ? [`${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`] : true,
  ]));
  const childEntitlements = Object.fromEntries(MACOS_APP_STORE_CHILD_ENTITLEMENTS.map((key) => [key, true]));
  const outerInfo = Buffer.from(plist.build({
    CFBundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
    [R5_REVENUECAT_INFO_PLIST_KEY]: publicSdkKey,
    [R5_CONVEX_INFO_PLIST_KEY]: convexUrl,
  }));
  const electronInfo = Buffer.from(plist.build({
    CFBundleExecutable: "Electron",
    CFBundleVersion: "41.2.0",
    CFBundleIdentifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
  }));
  const signature = {
    bundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    teamId: R5_APP_STORE_TEAM_ID,
    identity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    signature: "CMS",
    cdHash: "a".repeat(40),
  };
  const nestedMachO = inspectedEntries.map((entry) => {
    const isOuter = entry.path === "Contents/MacOS/MeetlessHost";
    const entitlementPolicy = isOuter
      ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
      : entry.machOFileType === "MH_EXECUTE"
        ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
        : MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE;
    return {
      path: entry.path,
      identifier: nestedSignatureIdentifier(entry.path),
      teamId: signature.teamId,
      identity: signature.identity,
      cdHash: signature.cdHash,
      architecture: entry.machOArchitecture,
      fileType: entry.machOFileType,
      entitlementKeys: entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
        ? [...MACOS_APP_STORE_CHILD_ENTITLEMENTS].sort()
        : [],
    };
  }).filter((entry) => entry.path !== "Contents/MacOS/MeetlessHost");
  const packagedContract = {
    schema: JSON.parse(contract.toString("utf8")).schema,
    runtimeRootRelativePath: JSON.parse(contract.toString("utf8")).userSupportRelativePath,
    recordingExportsRelativePath: JSON.parse(contract.toString("utf8")).recordingExportsRelativePath,
    contractSha256,
    markerTarget: JSON.parse(marker.toString("utf8")).target,
    hostRuntimeRootRelativePath: JSON.parse(hostConfiguration.toString("utf8")).runtimeRootRelativeToUserHome,
  };
  const signatureEvidence = {
    verified: true,
    ...signature,
    nestedMachOCount: nestedMachO.length,
    nestedMachO,
  };
  const masPackageEvidence = await finalizeMacOSAppStorePackageEvidence({
    bundlePath: bundle,
    repositoryRoot: path.resolve("."),
    candidateSnapshot: directCompositionSource.candidateSnapshot,
    preparedEvidence: packageEvidence,
    signature: signatureEvidence,
    entries,
    machoEntries: inspectedEntries,
    embeddedProfile,
    profileBytes,
    expectedElectronArchiveSha256: MAS_FIXTURE_ARCHIVE_SHA256,
  });
  const manifest = {
    schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
    authority: "docs/decisions/0005-mac-app-store-and-revenuecat.md",
    target: "macos-app-store-arm64",
    bundlePath: "release/macos/Meetless.app",
    bundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    teamId: R5_APP_STORE_TEAM_ID,
    signingIdentity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    revenueCatPublicSdkKeyEmbedded: true,
    convexUrlEmbedded: true,
    convexUrlSha256: createHash("sha256").update(convexUrl).digest("hex"),
    provisioningProfile: {
      name: R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
      uuid: R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
      sha256: createHash("sha256").update(profileBytes).digest("hex"),
      provisionedDevices: [R5_APP_STORE_DEVELOPMENT_DEVICE_UDID],
      expirationDate: profile.ExpirationDate.toISOString(),
    },
    signature: signatureEvidence,
    entitlements: {
      parentKeys: Object.keys(parentEntitlements).sort(),
      childKeys: [...MACOS_APP_STORE_CHILD_ENTITLEMENTS],
      applicationGroup: `${R5_APP_STORE_TEAM_ID}.${R5_APP_STORE_BUNDLE_ID}`,
    },
    electron: {
      version: "41.2.0",
      platform: "mas",
      arch: "arm64",
      archiveName: "electron-v41.2.0-mas-arm64.zip",
      archiveSha256: packageEvidence.electronArchiveSource.sha256,
      executable: path.relative(bundle, nestedElectronExecutablePath).split(path.sep).join("/"),
      architecture: "arm64",
      thin: true,
    },
    artifact: {
      sha256: createHash("sha256").update(Buffer.from(JSON.stringify(entries))).digest("hex"),
      entryCount: entries.length,
      machoEntryCount: inspectedEntries.length,
    },
    packagedContract,
    directComposition: {
      ...directCompositionSource.binding,
    },
    masPackageEvidence,
    externalGates: {
      launch: "not-run",
      purchase: "not-run",
      distribution: "not-claimed",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const files = new Map([
    [path.resolve(manifestPath), manifestBytes],
    [path.resolve(proofRoot, "release", "macos", "composition-manifest.direct.json"), directCompositionBytes],
    [path.join(bundle, "Contents", "Info.plist"), outerInfo],
    [path.join(bundle, "Contents", "Resources", "meetless", "installation-contract.json"), contract],
    [path.join(bundle, "Contents", "Resources", "meetless", "meetless-package.json"), marker],
    [path.join(bundle, "Contents", "Resources", "host-config.json"), hostConfiguration],
    [inventoryPath, inventoryBytes],
    [profilePath, profileBytes],
    [path.join(bundle, "Contents", "Helpers", "Electron.app", "Contents", "Info.plist"), electronInfo],
  ]);
  const signatureText = (identifier: string) => [
    `Identifier=${identifier}`,
    `TeamIdentifier=${signature.teamId}`,
    `Authority=${signature.identity}`,
    `Signature=${signature.signature}`,
    `CDHash=${signature.cdHash}`,
  ].join("\n");
  const machoByPath = new Map(inspectedEntries.map((entry) => [entry.path, entry]));
  const adapters = {
    readSecureFile: async (target: string) => files.get(path.resolve(target)) ?? readFile(target),
    assertSecureDirectory: async (target: string) => lstat(target),
    assertSecureFile: async (target: string) => target === profilePath
      ? { uid: process.getuid?.() ?? 0, nlink: 1, mode: 0o400, isFile: () => true, isSymbolicLink: () => false }
      : lstat(target),
    runMacOSCommand: async (command: string, arguments_: string[]) => {
      if (command === "codesign" && arguments_.includes("--verify")) return { stdout: "", stderr: "" };
      if (command === "codesign" && arguments_.includes("--entitlements")) {
        const target = arguments_.at(-1) as string;
        const entry = machoByPath.get(path.relative(bundle, target).split(path.sep).join("/"));
        const isOuter = target === bundle || target === outerExecutablePath;
        const entitlementPolicy = isOuter
          ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
          : entry?.machOFileType === "MH_EXECUTE"
            ? MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
            : MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE;
        const entitlements = entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT
          ? parentEntitlements
          : entitlementPolicy === MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD
            ? childEntitlements
            : null;
        return {
          stdout: entitlements === null ? "" : plist.build(entitlements),
          stderr: `Executable=${isOuter && target === bundle ? outerExecutablePath : target}\n`,
        };
      }
      if (command === "codesign" && arguments_.includes("--verbose=4")) {
        const target = arguments_.at(-1) as string;
        const relativePath = path.relative(bundle, target).split(path.sep).join("/");
        const identifier = target === bundle || target === outerExecutablePath
          ? signature.bundleIdentifier
          : nestedSignatureIdentifier(relativePath);
        return { stdout: signatureText(identifier), stderr: "" };
      }
      if (command === "codesign" && arguments_.includes("--verbose=2") && arguments_.at(-1) === profilePath) {
        const error = new Error("code object is not signed at all");
        Object.assign(error, { code: 1, stdout: "", stderr: "code object is not signed at all\n" });
        throw error;
      }
      if (command === "security") return { stdout: plist.build(profile), stderr: "" };
      if (command === "file") return { stdout: "Mach-O 64-bit executable arm64\n", stderr: "" };
      throw new Error(`unexpected fixture owner command ${command}`);
    },
    enumeratePackageEntries: async () => entries,
    inspectPackageMachOEntries: async () => inspectedEntries,
    verifyIndividualMachOSignatures: async () => undefined,
    inspectMachO: async (target: string) => {
      const entry = machoByPath.get(path.relative(bundle, target).split(path.sep).join("/"));
      if (!entry) return null;
      return {
        ...entry,
        dependencies: [],
        rpaths: [],
      };
    },
  };
  sharedMasValidationFixture = Promise.resolve({
    adapters,
    publicSdkKey,
    convexUrl,
    bundlePath: bundle,
    manifestPath,
    expectedElectronArchiveSha256: MAS_FIXTURE_ARCHIVE_SHA256,
    directInventory,
    preSignEntries,
    preSignMachOEntries,
    preparedEvidence: packageEvidence,
  });
  return sharedMasValidationFixture;
}

async function makeInstalledSignatureFixture({
  mutatePlist,
  manifestIdentifier = R5_APP_STORE_ELECTRON_BUNDLE_ID,
  signedIdentifier = R5_APP_STORE_ELECTRON_BUNDLE_ID,
  convexUrl = "https://meetless-installed-fixture.convex.cloud/",
}: {
  mutatePlist?: (info: Record<string, unknown>) => void;
  manifestIdentifier?: string;
  signedIdentifier?: string;
  convexUrl?: string;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-installed-signature-fixture-")));
  roots.push(root);
  const bundle = path.join(root, "Meetless.app");
  const outerPath = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  const electronRelativePath = "Contents/Helpers/Electron.app/Contents/MacOS/Electron";
  const electronPath = path.join(bundle, electronRelativePath);
  const electronInfoPath = path.join(bundle, "Contents", "Helpers", "Electron.app", "Contents", "Info.plist");
  const outerInfoPath = path.join(bundle, "Contents", "Info.plist");
  const manifestPath = path.join(root, "app-store-development-manifest.json");
  await mkdir(path.dirname(outerPath), { recursive: true, mode: 0o755 });
  await mkdir(path.dirname(electronPath), { recursive: true, mode: 0o755 });
  await writeFile(outerPath, "outer Mach-O fixture\n", { mode: 0o755 });
  await writeFile(electronPath, "Electron Mach-O fixture\n", { mode: 0o755 });
  await writeFile(outerInfoPath, plist.build({
    CFBundleIdentifier: R5_APP_STORE_BUNDLE_ID,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
    [R5_REVENUECAT_INFO_PLIST_KEY]: "appl_installed_fixture_public_key",
    [R5_CONVEX_INFO_PLIST_KEY]: convexUrl,
  }), { mode: 0o600 });
  const electronInfo: Record<string, unknown> = {
    CFBundleExecutable: "Electron",
    CFBundleVersion: "41.2.0",
    CFBundleIdentifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
    ElectronTeamID: R5_APP_STORE_TEAM_ID,
  };
  mutatePlist?.(electronInfo);
  await writeFile(electronInfoPath, plist.build(electronInfo), { mode: 0o600 });
  const manifest = {
    schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
    convexUrlEmbedded: true,
    convexUrlSha256: createHash("sha256").update(convexUrl).digest("hex"),
    electron: { executable: electronRelativePath },
    signature: { nestedMachO: [{ path: electronRelativePath, identifier: manifestIdentifier }] },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const artifactBinding = freezeMasGateArtifactBinding({
    schema: "MAS_GATE_ARTIFACT_BINDING v1",
    version: 1,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    bundlePath: bundle,
    bundleFingerprint: "a".repeat(64),
    artifactDigest: "b".repeat(64),
    candidateSnapshotDigest: "c".repeat(64),
    packageInputDigest: "d".repeat(64),
    artifactInputDigest: "e".repeat(64),
    licenseDigest: "f".repeat(64),
    signatureDigest: createHash("sha256").update(JSON.stringify(manifest.signature)).digest("hex"),
    publicSdkKeySha256: "0".repeat(64),
  });
  const commands: Array<{ command: string; arguments_: string[] }> = [];
  const signatureText = [
    `Identifier=${signedIdentifier}`,
    `TeamIdentifier=${R5_APP_STORE_TEAM_ID}`,
    `Authority=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
    "Signature=CMS",
    `CDHash=${"a".repeat(40)}`,
  ].join("\n");
  const dependencies = {
    expectedConvexUrl: convexUrl,
    artifactValidationAdapters: {
      runMacOSCommand: async (command: string, arguments_: string[]) => {
        commands.push({ command, arguments_ });
        if (command === "codesign" && arguments_.includes("--display") && arguments_.includes("--verbose=4")) {
          return { stdout: signatureText, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    },
  };
  return {
    root,
    bundle,
    electronPath,
    electronInfoPath,
    outerInfoPath,
    convexUrl,
    manifestPath,
    artifactBinding,
    dependencies,
    commands,
    receiptPath: path.join(bundle, "Contents", "Helpers", "Electron.app", "Contents", "_MASReceipt", "receipt"),
  };
}

describe("MAS development gate coordinator", () => {
  it("requires the locked hosted-development URL for the production authority path", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-url-authority-test-")));
    roots.push(root);
    const bundlePath = path.join(root, "release", "macos", "Meetless.app");
    const manifestPath = path.join(root, "release", "macos", "app-store-development-manifest.json");
    await mkdir(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify({
      bundlePath: "release/macos/Meetless.app",
      directComposition: { path: "release/macos/composition-manifest.direct.json" },
    })}\n`, { mode: 0o600 });
    const previous = process.env.MEETLESS_CONVEX_URL;
    try {
      delete process.env.MEETLESS_CONVEX_URL;
      await expect(validateMasDevelopmentInstallArtifact({
        manifestPath,
        bundlePath,
        dependencies: { expectedRevenueCatPublicSdkKey: "appl_url_authority_test" },
      })).rejects.toThrow(/expected build-scoped Convex URL authority/);

      process.env.MEETLESS_CONVEX_URL = HOSTED_DEV_TARGET.cloudUrl.replace(".convex.cloud", ".alternate.convex.cloud");
      await expect(validateMasDevelopmentInstallArtifact({
        manifestPath,
        bundlePath,
        dependencies: { expectedRevenueCatPublicSdkKey: "appl_url_authority_test" },
      })).rejects.toThrow(/hosted-development target/);
    } finally {
      if (previous === undefined) delete process.env.MEETLESS_CONVEX_URL;
      else process.env.MEETLESS_CONVEX_URL = previous;
    }
    expect(R5_APP_STORE_DEVELOPMENT_CONVEX_URL).toBe(HOSTED_DEV_TARGET.cloudUrl);
  });

  it("binds MAS package inputs to Helpers while preserving the direct Electron prefix", () => {
    const direct = buildMacOSPackageInputSpecs({ electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_DIRECT });
    const mas = buildMacOSPackageInputSpecs({
      electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
      electronArchiveSource: {
        schema: "MEETLESS_MAS_ELECTRON_ARCHIVE_SOURCE v1",
        archiveName: MACOS_APP_STORE_CONTRACT.electron.archiveName,
        path: path.resolve("/tmp", MACOS_APP_STORE_CONTRACT.electron.archiveName),
        sha256: MACOS_APP_STORE_CONTRACT.electron.sha256,
      },
    });
    const directElectron = direct.find(({ id }) => id === "electron-runtime-input");
    const masElectron = mas.find(({ id }) => id === "electron-runtime-input");
    expect(directElectron?.artifactPathPrefixes).toContain("Contents/Resources/meetless/runtime/electron/");
    expect(directElectron?.artifactPathPrefixes).not.toContain("Contents/Helpers/Electron.app/");
    expect(masElectron?.artifactPathPrefixes).toContain("Contents/Helpers/Electron.app/");
    expect(masElectron?.artifactPathPrefixes).not.toContain("Contents/Resources/meetless/runtime/electron/");
    expect(() => buildMacOSPackageInputSpecs({ electronLayout: "unexpected" as never })).toThrow(/accepted MAS Contents\/Helpers layout/);
  });

  it("binds the staged profile and exact seven nested CodeResources across MAS evidence", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();
    const profileBytes = await readFile(path.join(fixture.bundlePath, MACOS_MAS_EMBEDDED_PROFILE_PATH));
    expect(validateMacOSMasSigningBoundaryEntries(fixture.preSignEntries, {
      phase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
      expectedMachoPaths: fixture.preSignMachOEntries.map((entry) => entry.path),
    })).toEqual([MACOS_MAS_OUTER_CODE_RESOURCES_PATH]);
    expect(validateMacOSMasSigningBoundaryEntries(entries, {
      phase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
      expectedMachoPaths: machoEntries.map((entry) => entry.path),
    })).toEqual(evidence.signingBoundary.codeResources);
    const validation = () => validateMasPackageEvidenceInputs(evidence, {
      entries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      embeddedProfile: evidence.embeddedProfile,
      profileBytes,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    });

    expect(validation()).toBe(evidence);
    expect(evidence.embeddedProfile).toMatchObject({
      path: MACOS_MAS_EMBEDDED_PROFILE_PATH,
      sha256: createHash("sha256").update(profileBytes).digest("hex"),
      size: profileBytes.byteLength,
    });
    expect(evidence.embeddedProfile.sha256).toBe(manifest.provisioningProfile.sha256);
    const masElectronComponent = inventory.components.find((component: { id: string }) => component.id === "electron-chromium");
    expect(masElectronComponent?.provenance.sourceType).toBe("pinned-MAS-Electron-archive-and-Chromium-runtime");
    expect(path.isAbsolute(evidence.electronArchiveSource.path)).toBe(true);
    expect(masElectronComponent?.provenance.sourcePaths).toEqual([
      "docs/decisions/0001-maintained-paseo-fork.md",
      "scripts/package-macos.mjs",
      evidence.electronArchiveSource.path,
    ]);
    const directElectronComponent = fixture.directInventory.components.find((component: { id: string }) => component.id === "electron-chromium");
    expect(directElectronComponent?.provenance.sourceType).toBe("Electron-distribution-and-Chromium-runtime");
    expect(directElectronComponent?.provenance.sourcePaths).toEqual([
      "docs/decisions/0001-maintained-paseo-fork.md",
      "scripts/package-macos.mjs",
      "node_modules/electron/package.json",
      "node_modules/electron/LICENSE",
      "node_modules/electron/dist/LICENSES.chromium.html",
    ]);
    expect(evidence.signingBoundary.signingMutatedCodeResources).toEqual([...MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES]);
    expect(evidence.signingBoundary.codeResources).toHaveLength(MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES.length + 1);
    expect(evidence.signingBoundary.codeResources).toContain(MACOS_MAS_OUTER_CODE_RESOURCES_PATH);
    expect(evidence.artifact.codeResources.map((entry: { path: string }) => entry.path)).toEqual(evidence.signingBoundary.codeResources);
    expect(evidence.packageInputs.artifactInput.excludedPaths).toEqual(evidence.signingBoundary.excludedPaths);
    expect(inventory.artifact.entryBinding.signingBoundary).toEqual(evidence.signingBoundary);
    expect(inventory.artifact.packageInputBinding).toEqual(createLicenseInventoryPackageInputBinding(evidence.packageInputs));
    expect(fixture.preparedEvidence.signingBoundary).toEqual(evidence.signingBoundary);
  });

  it.each([
    ["head", (snapshot: Record<string, any>) => { snapshot.head = snapshot.head === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40); }],
    ["paseoCommit", (snapshot: Record<string, any>) => { snapshot.paseoCommit = snapshot.paseoCommit === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40); }],
  ] as const)("rejects an independently stale valid-format inventory candidate snapshot %s", { timeout: 300_000 }, async (_label, mutate) => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    mutate(inventory.artifact.candidateSnapshot);
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();

    expect(() => validateMasPackageEvidenceInputs(evidence, {
      entries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/MAS license inventory candidate snapshot differs from the evidence\.packageInputs source snapshot/);
  });

  it.each([
    ["package-input digest", (binding: Record<string, any>) => { binding.digest = "0".repeat(64); }],
    ["source snapshot digest", (binding: Record<string, any>) => { binding.sourceSnapshotDigest = "1".repeat(64); }],
    ["artifact-input digest", (binding: Record<string, any>) => { binding.artifactInputDigest = "2".repeat(64); }],
    ["signing boundary", (binding: Record<string, any>) => { binding.signingBoundary = { ...binding.signingBoundary, phase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL }; }],
    ["package member digest", (binding: Record<string, any>) => { binding.packageMemberDigest = "3".repeat(64); }],
    ["package member count", (binding: Record<string, any>) => { binding.packageMemberCount += 1; }],
    ["workspace member digest", (binding: Record<string, any>) => { binding.workspaceMemberDigest = "4".repeat(64); }],
    ["workspace member count", (binding: Record<string, any>) => { binding.workspaceMemberCount += 1; }],
    ["input count", (binding: Record<string, any>) => { binding.inputCount += 1; }],
    ["lock metadata gap count", (binding: Record<string, any>) => { binding.lockMetadataGapCount += 1; }],
  ] as const)("rejects an independently stale %s inventory package-input binding", { timeout: 300_000 }, async (_label, mutate) => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    mutate(inventory.artifact.packageInputBinding);
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();

    expect(() => validateMasPackageEvidenceInputs(evidence, {
      entries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/package-input binding differs from the evidence\.packageInputs projection/);
  });

  it("rejects a self-consistent inventory summary rewrite at the MAS evidence boundary", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const rewritten = structuredClone(inventory);
    const jsClosure = rewritten.components.find((component: Record<string, any>) => component.id === "js-closure");
    if (!jsClosure) throw new Error("fixture inventory is missing js-closure");
    const lockMetadataGaps = jsClosure.declaredLicenseEvidence.lockMetadataGaps ?? [];
    jsClosure.declaredLicenseEvidence.lockMetadataGaps = [
      ...lockMetadataGaps,
      { lockFile: "package-lock.json", lockPath: "node_modules/forged", name: "forged", version: null },
    ];
    rewritten.summary.lockMetadataGapCount += 1;
    rewritten.artifact.packageInputBinding.lockMetadataGapCount = rewritten.summary.lockMetadataGapCount;
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();

    expect(() => validateLicenseInventoryCoverage(
      rewritten,
      entries,
      evidence.licenseInventory,
      machoEntries.map((entry: { path: string }) => entry.path),
      {
        route: "mas",
        masSigningPhase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
        expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
      },
    )).not.toThrow();
    expect(() => validateMasPackageEvidenceInputs(evidence, {
      entries,
      machoEntries,
      inventory: rewritten,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/package-input binding differs from the evidence\.packageInputs projection/);
  });

  it("applies the same package-input cross-binding at installed-consumer source validation", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryPath = path.join(fixture.bundlePath, evidence.licenseInventory.path);
    const originalInventoryBytes = await readFile(inventoryPath);
    const inventory = JSON.parse(originalInventoryBytes.toString("utf8"));
    inventory.artifact.packageInputBinding.inputCount += 1;
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
    try {
      await expect(verifyMacOSAppStorePackageEvidenceSources({
        evidence,
        repositoryRoot: path.resolve("."),
        bundlePath: fixture.bundlePath,
        candidateSnapshot: evidence.packageInputs.sourceSnapshot,
        expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
      })).rejects.toThrow(/package-input binding differs from the evidence\.packageInputs projection/);
    } finally {
      await writeFile(inventoryPath, originalInventoryBytes, { mode: 0o644 });
    }
  });

  it.each([
    ["head", (snapshot: Record<string, any>) => { snapshot.head = snapshot.head === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40); }],
    ["paseoCommit", (snapshot: Record<string, any>) => { snapshot.paseoCommit = snapshot.paseoCommit === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40); }],
  ] as const)("rejects an independently stale %s inventory candidate snapshot at installed-consumer validation", { timeout: 300_000 }, async (_label, mutate) => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryPath = path.join(fixture.bundlePath, evidence.licenseInventory.path);
    const originalInventoryBytes = await readFile(inventoryPath);
    const inventory = JSON.parse(originalInventoryBytes.toString("utf8"));
    mutate(inventory.artifact.candidateSnapshot);
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
    try {
      await expect(verifyMacOSAppStorePackageEvidenceSources({
        evidence,
        repositoryRoot: path.resolve("."),
        bundlePath: fixture.bundlePath,
        candidateSnapshot: evidence.packageInputs.sourceSnapshot,
        expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
      })).rejects.toThrow(/MAS license inventory candidate snapshot differs from the evidence\.packageInputs source snapshot/);
    } finally {
      await writeFile(inventoryPath, originalInventoryBytes, { mode: 0o644 });
    }
  });

  it("rejects signer-created nested CodeResources during the pre-sign phase", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = fixture.preparedEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const nestedPath = MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES[0];
    const tooEarlyEntries = [...fixture.preSignEntries, { path: nestedPath, type: "file", size: 1, sha256: "1".repeat(64) }]
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(() => validateMasPackageEvidenceInputs(evidence, {
      entries: tooEarlyEntries,
      machoEntries: fixture.preSignMachOEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      validateInventory: false,
      masSigningPhase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/pre-sign package CodeResources path set differs from the exact MAS signer-mutated set/);
  });

  it("rejects absent, mutated, or substituted embedded profile evidence before MAS acceptance", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();
    const options = {
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    };
    const absent = entries.filter((entry) => entry.path !== MACOS_MAS_EMBEDDED_PROFILE_PATH);
    expect(() => validateMasPackageEvidenceInputs(evidence, { ...options, entries: absent })).toThrow(/embedded profile entry is absent/);

    const mutated = entries.map((entry) => entry.path === MACOS_MAS_EMBEDDED_PROFILE_PATH
      ? { ...entry, sha256: "0".repeat(64) }
      : entry);
    expect(() => validateMasPackageEvidenceInputs(evidence, { ...options, entries: mutated })).toThrow(/embedded profile entry is absent or differs/);

    expect(() => validateMasPackageEvidenceInputs(evidence, {
      ...options,
      entries,
      profileBytes: Buffer.from("substituted profile bytes\n"),
    })).toThrow(/embedded profile bytes differ/);
  });

  it("rejects missing or extra nested CodeResources and ordinary-payload mutation", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();
    const options = {
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    };
    const nestedPath = MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES[0];
    expect(() => validateMasPackageEvidenceInputs(evidence, {
      ...options,
      entries: entries.filter((entry) => entry.path !== nestedPath),
    })).toThrow(/exact MAS signer-mutated/);

    const extraPath = "Contents/Helpers/Electron.app/Contents/Frameworks/Unexpected.framework/_CodeSignature/CodeResources";
    const extraEntries = [...entries, { path: extraPath, type: "file", size: 1, sha256: "1".repeat(64) }]
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(() => validateMasPackageEvidenceInputs(evidence, { ...options, entries: extraEntries })).toThrow(/exact MAS signer-mutated/);

    const ordinary = entries.map((entry) => entry.path === "Contents/Info.plist"
      ? { ...entry, sha256: "2".repeat(64) }
      : entry);
    expect(() => validateMasPackageEvidenceInputs(evidence, { ...options, entries: ordinary })).toThrow(/package-input artifact digest differs/);
  });

  it("keeps arbitrary outer signature payload in the MAS digest while preserving the direct prefix", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const entries = await fixture.adapters.enumeratePackageEntries();
    const masDigestOptions = {
      excludedPaths: evidence.signingBoundary.excludedPaths,
      signingBoundary: evidence.signingBoundary,
      expectedMachoPaths: evidence.signingBoundary.machoPaths,
    };
    const extraPath = "Contents/_CodeSignature/Unexpected";
    const extraEntry = { path: extraPath, type: "file", size: 1, sha256: "1".repeat(64) };
    const withExtra = [...entries, extraEntry].sort((left, right) => left.path.localeCompare(right.path));

    expect(selectArtifactEntriesForDigest(withExtra).length).toBe(selectArtifactEntriesForDigest(entries).length);
    expect(digestArtifactEntries(withExtra)).toBe(digestArtifactEntries(entries));
    expect(selectArtifactEntriesForDigest(withExtra, masDigestOptions).length)
      .toBe(selectArtifactEntriesForDigest(entries, masDigestOptions).length + 1);
    expect(digestArtifactEntries(withExtra, masDigestOptions)).not.toBe(digestArtifactEntries(entries, masDigestOptions));

    const mutatedExtra = withExtra.map((entry) => entry.path === extraPath
      ? { ...entry, sha256: "2".repeat(64) }
      : entry);
    expect(digestArtifactEntries(mutatedExtra, masDigestOptions)).not.toBe(digestArtifactEntries(withExtra, masDigestOptions));
    expect(digestArtifactEntries(mutatedExtra)).toBe(digestArtifactEntries(withExtra));
  });

  it("rejects an arbitrary mutation of the final outer CodeResources payload", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const evidence = manifest.masPackageEvidence;
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, evidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();
    const mutatedEntries = entries.map((entry) => entry.path === MACOS_MAS_OUTER_CODE_RESOURCES_PATH
      ? { ...entry, sha256: "0".repeat(64) }
      : entry);
    expect(() => validateMasPackageEvidenceInputs(evidence, {
      entries: mutatedEntries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/final MAS artifact-entry evidence differs from the signed bundle/);
  });

  it("rejects stale direct-layout package evidence and final entry mutations", { timeout: 300_000 }, async () => {
    const fixture = await makeMasValidationFixture();
    const manifest = JSON.parse((await fixture.adapters.readSecureFile(fixture.manifestPath, "fixture manifest")).toString("utf8"));
    const inventoryBytes = await readFile(path.join(fixture.bundlePath, manifest.masPackageEvidence.licenseInventory.path));
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    const entries = await fixture.adapters.enumeratePackageEntries();
    const machoEntries = await fixture.adapters.inspectPackageMachOEntries();
    const directEvidence = structuredClone(manifest.masPackageEvidence);
    const electronInput = directEvidence.packageInputs.inputs.find((input: { id: string }) => input.id === "electron-runtime-input");
    if (!electronInput) throw new Error("fixture MAS package input is missing Electron");
    electronInput.artifactPathPrefixes = electronInput.artifactPathPrefixes.map((prefix: string) =>
      prefix.startsWith("Contents/Helpers/Electron.app/")
        ? prefix.replace("Contents/Helpers/Electron.app/", "Contents/Resources/meetless/runtime/electron/")
        : prefix,
    );
    directEvidence.packageInputs.digest = digestJson({ ...directEvidence.packageInputs, digest: undefined });
    expect(() => validateMasPackageEvidenceInputs(directEvidence, {
      entries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/direct Electron prefix/);

    const staleInventory = structuredClone(inventory);
    staleInventory.artifact.manifestPath = "release/macos/composition-manifest.json";
    expect(() => validateMasPackageEvidenceInputs(manifest.masPackageEvidence, {
      entries,
      machoEntries,
      inventory: staleInventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/license inventory artifact binding is missing or invalid/);

    const mutatedEntries = entries.map((entry, index) => index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry);
    expect(() => validateMasPackageEvidenceInputs(manifest.masPackageEvidence, {
      entries: mutatedEntries,
      machoEntries,
      inventory,
      inventoryBytes,
      bundlePath: fixture.bundlePath,
      candidateSnapshot: manifest.directComposition.candidateSnapshot,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    })).toThrow(/artifact-entry evidence differs from the signed bundle/);
  });

  it("passes strict/deep MAS signature proof before and after an opaque Helpers receipt is inserted", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-receipt-signature-test-")));
    roots.push(root);
    const bundle = path.join(root, "Meetless.app");
    const outerPath = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
    const electronRelativePath = "Contents/Helpers/Electron.app/Contents/MacOS/Electron";
    const electronPath = path.join(bundle, electronRelativePath);
    const electronInfoPath = path.join(bundle, "Contents", "Helpers", "Electron.app", "Contents", "Info.plist");
    const outerInfoPath = path.join(bundle, "Contents", "Info.plist");
    await mkdir(path.dirname(outerPath), { recursive: true, mode: 0o755 });
    await mkdir(path.dirname(electronPath), { recursive: true, mode: 0o755 });
    await writeFile(outerPath, "outer Mach-O fixture\n", { mode: 0o755 });
    await writeFile(electronPath, "Electron Mach-O fixture\n", { mode: 0o755 });
    const convexUrl = "https://meetless-installed-receipt-fixture.convex.cloud/";
    await writeFile(outerInfoPath, plist.build({
      CFBundleIdentifier: R5_APP_STORE_BUNDLE_ID,
      ElectronTeamID: R5_APP_STORE_TEAM_ID,
      [R5_REVENUECAT_INFO_PLIST_KEY]: "appl_installed_receipt_fixture_key",
      [R5_CONVEX_INFO_PLIST_KEY]: convexUrl,
    }), { mode: 0o600 });
    await writeFile(electronInfoPath, plist.build({
      CFBundleExecutable: "Electron",
      CFBundleVersion: "41.2.0",
      CFBundleIdentifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
      ElectronTeamID: R5_APP_STORE_TEAM_ID,
    }), { mode: 0o600 });

    const manifestPath = path.join(root, "app-store-development-manifest.json");
    const manifest = {
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      convexUrlEmbedded: true,
      convexUrlSha256: createHash("sha256").update(convexUrl).digest("hex"),
      electron: { executable: electronRelativePath },
      signature: { nestedMachO: [{ path: electronRelativePath, identifier: R5_APP_STORE_ELECTRON_BUNDLE_ID }] },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const artifactBinding = freezeMasGateArtifactBinding({
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      bundlePath: bundle,
      bundleFingerprint: "a".repeat(64),
      artifactDigest: "b".repeat(64),
      candidateSnapshotDigest: "c".repeat(64),
      packageInputDigest: "d".repeat(64),
      artifactInputDigest: "e".repeat(64),
      licenseDigest: "f".repeat(64),
      signatureDigest: createHash("sha256").update(JSON.stringify(manifest.signature)).digest("hex"),
      publicSdkKeySha256: "0".repeat(64),
    });
    const commands: Array<{ command: string; arguments_: string[] }> = [];
    const electronSignatureText = [
      `Identifier=${R5_APP_STORE_ELECTRON_BUNDLE_ID}`,
      `TeamIdentifier=${R5_APP_STORE_TEAM_ID}`,
      `Authority=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
      "Signature=CMS",
      `CDHash=${"a".repeat(40)}`,
    ].join("\n");
    const dependencies = {
      expectedConvexUrl: convexUrl,
      artifactValidationAdapters: {
        runMacOSCommand: async (command: string, arguments_: string[]) => {
          commands.push({ command, arguments_ });
          if (command === "codesign" && arguments_.includes("--display") && arguments_.includes("--verbose=4")) {
            return { stdout: electronSignatureText, stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      },
    };
    const expectedCommands = [
      ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]],
      ["codesign", ["--verify", "--strict", "--verbose=2", outerPath]],
      ["codesign", ["--verify", "--strict", "--verbose=2", electronPath]],
      ["codesign", ["--display", "--verbose=4", electronPath]],
    ];

    await expect(validateMasDevelopmentInstalledSignatures({ manifestPath, bundlePath: bundle, artifactBinding, dependencies })).resolves.toMatchObject({ status: "passed" });
    expect(commands).toEqual(expectedCommands.map(([command, arguments_]) => ({ command, arguments_ })));

    const receiptDirectory = path.join(bundle, "Contents", "Helpers", "Electron.app", "Contents", "_MASReceipt");
    await mkdir(receiptDirectory, { recursive: true, mode: 0o755 });
    await writeFile(path.join(receiptDirectory, "receipt"), "opaque receipt bytes are never inspected\n", { mode: 0o600 });
    commands.length = 0;
    await expect(validateMasDevelopmentInstalledSignatures({ manifestPath, bundlePath: bundle, artifactBinding, dependencies })).resolves.toMatchObject({ status: "passed" });
    expect(commands).toEqual(expectedCommands.map(([command, arguments_]) => ({ command, arguments_ })));

    await mkdir(path.join(bundle, "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app"), { recursive: true, mode: 0o755 });
    await expect(validateMasDevelopmentInstalledSignatures({ manifestPath, bundlePath: bundle, artifactBinding, dependencies })).rejects.toThrow(/legacy Electron app layout/);
  });

  it("rejects a self-consistent alternate Convex URL when the out-of-band authority differs", async () => {
    const fixture = await makeInstalledSignatureFixture({ convexUrl: "https://alternate-fixture.convex.cloud/" });
    await expect(validateMasDevelopmentInstalledSignatures({
      manifestPath: fixture.manifestPath,
      bundlePath: fixture.bundle,
      artifactBinding: fixture.artifactBinding,
      dependencies: { ...fixture.dependencies, expectedConvexUrl: "https://meetless-authority.convex.cloud/" },
    })).rejects.toThrow(/expected build-scoped Convex URL hash/);
  });

  it("rejects a signed outer Info.plist Convex URL mismatch before launch", async () => {
    const fixture = await makeInstalledSignatureFixture();
    const outerInfo = plist.parse((await readFile(fixture.outerInfoPath)).toString("utf8")) as Record<string, unknown>;
    outerInfo[R5_CONVEX_INFO_PLIST_KEY] = "https://alternate-fixture.convex.cloud/";
    await writeFile(fixture.outerInfoPath, plist.build(outerInfo), { mode: 0o600 });
    await expect(validateMasDevelopmentInstalledSignatures({
      manifestPath: fixture.manifestPath,
      bundlePath: fixture.bundle,
      artifactBinding: fixture.artifactBinding,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/different build-scoped Convex URL/);
  });

  it.each<[string, Parameters<typeof makeInstalledSignatureFixture>[0], RegExp]>([
    ["missing plist CFBundleIdentifier", { mutatePlist: (info) => { delete info.CFBundleIdentifier; } }, /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["duplicate parent plist CFBundleIdentifier", { mutatePlist: (info) => { info.CFBundleIdentifier = R5_APP_STORE_BUNDLE_ID; } }, /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["wrong plist CFBundleIdentifier", { mutatePlist: (info) => { info.CFBundleIdentifier = "com.github.Electron"; } }, /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["missing ElectronTeamID", { mutatePlist: (info) => { delete info.ElectronTeamID; } }, /signed Electron MAS Info\.plist ElectronTeamID does not match the accepted Apple Team ID/],
    ["wrong ElectronTeamID", { mutatePlist: (info) => { info.ElectronTeamID = "WRONGTEAMID"; } }, /signed Electron MAS Info\.plist ElectronTeamID does not match the accepted Apple Team ID/],
    ["wrong immutable manifest main Electron identifier", { manifestIdentifier: "com.github.Electron" }, /main Electron identifier is com\.github\.Electron; expected com\.meetless\.app\.electron/],
    ["duplicate parent immutable manifest main Electron identifier", { manifestIdentifier: R5_APP_STORE_BUNDLE_ID }, /main Electron identifier is com\.meetless\.app; expected com\.meetless\.app\.electron/],
    ["wrong actual codesign main Electron identifier", { signedIdentifier: "com.github.Electron" }, /signature identifier is com\.github\.Electron, expected com\.meetless\.app\.electron/],
    ["duplicate parent actual codesign main Electron identifier", { signedIdentifier: R5_APP_STORE_BUNDLE_ID }, /signature identifier is com\.meetless\.app, expected com\.meetless\.app\.electron/],
  ])("rejects %s during launch signature recheck without reading receipt bytes", async (_label, options, expectedDiagnostic) => {
    const fixture = await makeInstalledSignatureFixture(options);
    await mkdir(path.dirname(fixture.receiptPath), { recursive: true, mode: 0o755 });
    await writeFile(fixture.receiptPath, "opaque receipt bytes are never inspected\n", { mode: 0o600 });
    const receiptBytes = await readFile(fixture.receiptPath);
    const bundleIdentity = await lstat(fixture.bundle);

    await expect(validateMasDevelopmentInstalledSignatures({
      manifestPath: fixture.manifestPath,
      bundlePath: fixture.bundle,
      artifactBinding: fixture.artifactBinding,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(expectedDiagnostic);
    await expect(readFile(fixture.receiptPath)).resolves.toEqual(receiptBytes);
    await expect(lstat(fixture.bundle)).resolves.toMatchObject({
      dev: bundleIdentity.dev,
      ino: bundleIdentity.ino,
      nlink: bundleIdentity.nlink,
      size: bundleIdentity.size,
    });
    expect(fixture.commands.some(({ arguments_ }) => arguments_.some((argument) => argument.includes("_MASReceipt")))).toBe(false);
  });

  it.each([
    ["missing plist CFBundleIdentifier", "missing-plist-bundle-id", /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["duplicate parent plist CFBundleIdentifier", "duplicate-parent-plist-bundle-id", /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["wrong plist CFBundleIdentifier", "wrong-plist-bundle-id", /signed Electron MAS Info\.plist bundle identifier does not match com\.meetless\.app\.electron/],
    ["missing ElectronTeamID", "missing-plist-team-id", /signed Electron MAS Info\.plist ElectronTeamID does not match the accepted Apple Team ID/],
    ["wrong ElectronTeamID", "wrong-plist-team-id", /signed Electron MAS Info\.plist ElectronTeamID does not match the accepted Apple Team ID/],
    ["wrong signed main Electron identifier", "wrong-signed-main-id", /Contents\/Helpers\/Electron\.app\/Contents\/MacOS\/Electron signature identifier is com\.github\.Electron, expected com\.meetless\.app\.electron/],
  ] as const)("rejects %s before install/runtime mutation", { timeout: 300_000 }, async (_label, mutation, expectedDiagnostic) => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-electron-identity-negative-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await writeFile(prior, "prior\n", { mode: 0o600 });
    const packageTargetBefore = await lstat(context.bundlePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const sessionIndexPath = path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME);
    const sessionIndexBytes = await readFile(sessionIndexPath, "utf8");
    const fixture = await makeMasValidationFixture();
    const electronInfoPath = path.resolve(fixture.bundlePath, "Contents", "Helpers", "Electron.app", "Contents", "Info.plist");
    const mainElectronPath = path.resolve(fixture.bundlePath, "Contents", "Helpers", "Electron.app", "Contents", "MacOS", "Electron");
    const originalReadSecureFile = fixture.adapters.readSecureFile;
    const originalRunMacOSCommand = fixture.adapters.runMacOSCommand;
    const adapters = {
      ...fixture.adapters,
      readSecureFile: async (target: string, label: string) => {
        const bytes = await originalReadSecureFile(target, label);
        if (path.resolve(target) !== electronInfoPath || !mutation.startsWith("missing-plist") && !mutation.startsWith("wrong-plist")) {
          return bytes;
        }
        const info = plist.parse(bytes.toString("utf8")) as Record<string, unknown>;
        if (mutation === "missing-plist-bundle-id") delete info.CFBundleIdentifier;
        if (mutation === "duplicate-parent-plist-bundle-id") info.CFBundleIdentifier = R5_APP_STORE_BUNDLE_ID;
        if (mutation === "wrong-plist-bundle-id") info.CFBundleIdentifier = "com.github.Electron";
        if (mutation === "missing-plist-team-id") delete info.ElectronTeamID;
        if (mutation === "wrong-plist-team-id") info.ElectronTeamID = "WRONGTEAMID";
        return Buffer.from(plist.build(info));
      },
      runMacOSCommand: async (command: string, arguments_: string[]) => {
        const result = await originalRunMacOSCommand(command, arguments_);
        const target = arguments_.at(-1);
        if (mutation !== "wrong-signed-main-id" || command !== "codesign" || !arguments_.includes("--verbose=4") || typeof target !== "string" || path.resolve(target) !== mainElectronPath) {
          return result;
        }
        return {
          ...result,
          stdout: result.stdout.replace(`Identifier=${R5_APP_STORE_ELECTRON_BUNDLE_ID}`, "Identifier=com.github.Electron"),
        };
      },
    };

    await expect(installMasDevelopmentGate({
      manifestPath: fixture.manifestPath,
      bundlePath: fixture.bundlePath,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
        expectedConvexUrl: fixture.convexUrl,
        expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
        artifactValidationAdapters: adapters,
      },
    })).rejects.toThrow(expectedDiagnostic);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(readFile(sessionIndexPath, "utf8")).resolves.toBe(sessionIndexBytes);
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(context.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (packageTargetBefore) {
      await expect(lstat(context.bundlePath)).resolves.toMatchObject({
        dev: packageTargetBefore.dev,
        ino: packageTargetBefore.ino,
        nlink: packageTargetBefore.nlink,
        size: packageTargetBefore.size,
      });
    } else {
      await expect(lstat(context.bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(lstat(context.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes unknown launch failures into the fixed diagnostic shape", () => {
    const secret = "owner-token=/private/secret/runtime-root";
    const serialized = serializeMasDevelopmentGateFailure(new Error(secret), "not-an-accepted-category");
    expect(serialized).toEqual({
      coordinator: "MAS_GATE_COORDINATOR v1",
      status: "failed",
      diagnostic: {
        schema: MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN,
      },
    });
    expect(JSON.stringify(serialized)).not.toContain(secret);
    expect(JSON.stringify(serialized)).not.toContain("runtime-root");

    const hostileDiagnostic = new Error(secret);
    Object.defineProperty(hostileDiagnostic, "masLaunchDiagnostic", {
      value: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT,
        lastCause: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID,
        lastPredicateGroup: secret,
      },
    });
    const sanitized = serializeMasDevelopmentGateFailure(hostileDiagnostic);
    expect(sanitized).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT,
        lastCause: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID,
      },
    });
    expect(sanitized.diagnostic).not.toHaveProperty("lastPredicateGroup");
    expect(JSON.stringify(sanitized)).not.toContain(secret);
  });

  it("classifies invalid launch context as preflight status without exposing context", async () => {
    const failure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context: {} as ReturnType<typeof masDevelopmentRuntimeContext>,
    }));
    expect(failure).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PREFLIGHT_STATUS,
      },
    });
    expect(JSON.stringify(failure)).not.toContain("MAS user home");
  });

  it("captures the real CLI lock failure as bounded machine-readable output", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-launch-cli-test-")));
    roots.push(base);
    const result = await execFile(process.execPath, [path.resolve("scripts/macos-mas-development-gate.mjs"), "launch"], {
      cwd: path.resolve("."),
      env: { ...process.env, HOME: base },
    }).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      coordinator: "MAS_GATE_COORDINATOR v1",
      status: "failed",
      diagnostic: {
        schema: MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.LOCK_FAILED,
      },
    });
    expect(result.stderr).not.toContain(base);
  });

  it("binds MAS state to the app-container contract and keeps the direct-DMG root separate", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    expect(context.runtimeRoot).toBe("/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless");
    expect(context.directRuntimeRoot).toBe("/Users/example/Library/Application Support/Meetless");
    expect(context.runtimeRoot).not.toBe(context.directRuntimeRoot);
    expect(context.identityPath).toBe(`${context.runtimeRoot}/host-identity.json`);
    expect(context.lockPath).toBe(`${context.parentPath}/${MAS_GATE_LOCK_BASENAME}`);
    expect(masGateRuntimeOptions(context, { requiredFreeBytes: 1 }).runtimeRoot).toBe(context.runtimeRoot);

    const directContract = { ...context.contract, userSupportRelativePath: "Library/Application Support/Meetless" };
    expect(() => masDevelopmentRuntimeContext({ userHome: "/Users/example", contract: directContract })).toThrow(/exact macAppStoreInstallationContract/);
  });

  it("exports the transaction status reader and reports a bounded empty status fixture", async () => {
    expect(readMasGateSessionStatus).toBeTypeOf("function");
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-status-export-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await expect(readMasGateSessionStatus(masGateRuntimeOptions(context))).resolves.toMatchObject({
      status: "uninitialized",
      state: "absent-safe",
      activePath: context.activePath,
    });
    await seedMasSessionIndex(context);
    await expect(readMasGateSessionStatus(masGateRuntimeOptions(context))).resolves.toMatchObject({
      status: "absent",
      activePath: context.activePath,
    });
  });

  it("propagates terminal non-device assurance through the authoritative coordinator", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-terminal-assurance-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n", { mode: 0o600 });
    const isolatedDependencies = {
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };

    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies: isolatedDependencies }),
    });
    await restoreMasGateSessionTransaction(session, masGateRuntimeOptions(context, { dependencies: isolatedDependencies }));
    const archived = await archiveMasGateSessionTransaction(session, masGateRuntimeOptions(context, { dependencies: isolatedDependencies }));
    const currentRoot = await lstat(context.runtimeRoot);
    const historicalDevice = Number(currentRoot.dev) + 1;
    const projected = await attestMasGateRuntimeRoot(context.runtimeRoot, { digestDevice: historicalDevice });
    const journal = JSON.parse(await readFile(archived.journalPath, "utf8"));
    journal.priorAggregateAttestation = { ...projected, root: { ...projected.root, dev: historicalDevice } };
    journal.priorRootIdentity = { ...journal.priorRootIdentity, dev: historicalDevice };
    journal.prior = {
      ...journal.prior,
      rootIdentity: { ...journal.prior.rootIdentity, dev: historicalDevice },
      aggregateAttestation: { ...projected, root: { ...projected.root, dev: historicalDevice } },
    };
    journal.freshRootIdentity = { ...journal.freshRootIdentity, dev: historicalDevice };
    journal.freshRetainedRootIdentity = { ...journal.freshRetainedRootIdentity, dev: historicalDevice };
    await writeFile(archived.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    const status = await readMasDevelopmentGateStatus({
      context,
      dependencies: isolatedDependencies,
    });
    expect(status).toMatchObject({
      status: "archived",
      assurance: {
        classification: "terminal-archive-limited-non-device-equivalence",
        deviceIdentity: "numeric-device-projected",
        recordedNonDeviceProperties: "matched",
        historicalVolumeContinuity: "unproven",
        retainedFreshRootContent: "not-recorded",
      },
      package: { status: "not-applicable" },
      archived: [{ runId: archived.runId, assurance: { classification: "terminal-archive-limited-non-device-equivalence" } }],
    });
  });

  it("returns only an exact absent observation and rejects malformed process/listener evidence", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const empty = {
      processRows: async () => [{ pid: 1, ppid: 0, executablePath: "/sbin/launchd", arguments: ["/sbin/launchd"] }],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    await expect(inspectMasLiveState(context, empty)).resolves.toEqual(masLiveAbsentObservation(context));

    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => undefined,
    })).rejects.toThrow(/complete process list/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/tool", arguments: null }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "", arguments: [] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: Number.MAX_SAFE_INTEGER + 1, ppid: 1, executablePath: "/usr/bin/tool", arguments: ["/usr/bin/tool"] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/tool", arguments: ["/usr/bin/tool", null] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/Paseo Supervisor", arguments: ["/usr/bin/Paseo Supervisor", ""] }],
    })).resolves.toMatchObject({ status: "absent", processes: [] });
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 43, ppid: 1, executablePath: "/usr/bin/MeetlessHostTests", arguments: ["/usr/bin/MeetlessHostTests", ""] }],
    })).resolves.toMatchObject({ status: "absent", processes: [] });
    await expect(inspectMasLiveState(context, {
      ...empty,
      listeners: async () => undefined,
    })).rejects.toThrow(/listener inspection returned malformed/);
  });

  it("does not use command substrings, but detects exact owned descendants, listeners, sockets, and handles", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const base = {
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    const substringOnly = {
      pid: 42,
      ppid: 1,
      executablePath: "/usr/bin/tool",
      arguments: ["/usr/bin/tool", `prefix${context.runtimeRoot}suffix`],
    };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [substringOnly] })).resolves.toMatchObject({ status: "absent" });

    const descendant = { ...substringOnly, arguments: ["/usr/bin/tool", `${context.runtimeRoot}/nested-state`] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [descendant] })).resolves.toMatchObject({
      status: "live",
      processes: [descendant],
    });

    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [host] })).resolves.toMatchObject({ status: "live" });
    for (const row of [
      { ...host, pid: 50, arguments: [context.executablePath, ""] },
      { ...host, pid: 51, arguments: [context.executablePath, "extra"] },
    ]) {
      await expect(inspectMasLiveState(context, { ...base, processRows: async () => [row] })).resolves.toMatchObject({
        status: "live",
        processes: [row],
      });
    }
    for (const row of [
      { pid: 44, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "desktop"] },
      { pid: 45, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "daemon"] },
      { pid: 46, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.daemonWorkerPath, "daemon"] },
      { pid: 47, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.pluginPath] },
      { pid: 48, ppid: 43, executablePath: context.packagePaths.captureHelperPath, arguments: [context.packagePaths.captureHelperPath] },
    ]) {
      await expect(inspectMasLiveState(context, { ...base, processRows: async () => [row] })).resolves.toMatchObject({ status: "live", processes: [row] });
    }
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [{ pid: 49, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, "/private/unknown-role.js"] }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      listeners: async () => [{ port: 16777 }],
    })).resolves.toMatchObject({ status: "live", listeners: [{ port: 16777 }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      sockets: async () => [{ path: context.runtimePaths.recordingSocket, type: "socket" }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      openHandles: async () => [{ path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ path: context.runtimeRoot }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [host],
      openHandles: async () => [{ pid: host.pid, path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ pid: host.pid, path: context.runtimeRoot }] });
  });

  it("classifies exact empty and status-1 live lsof results with bounded records", () => {
    const empty = (overrides: Record<string, unknown> = {}) => ({
      error: undefined,
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
      ...overrides,
    });
    const validOpen = "p31\ncnode\nf3\nn/private/tmp/fixture/held-file\n";
    const validListener = "p31\ncnode\nf3\ntIPv4\n";

    expect(classifyMasLsofResult(empty(), MAS_LSOF_PURPOSES.OPEN_HANDLES)).toEqual({ status: "absent", records: [] });
    expect(classifyMasLsofResult({ ...empty(), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, MAS_LSOF_PURPOSES.LISTENER)).toEqual({ status: "absent", records: [] });
    expect(classifyMasLsofResult({ ...empty(), stdout: validOpen }, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toEqual({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], paths: ["/private/tmp/fixture/held-file"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), stdout: Buffer.from(validListener) }, MAS_LSOF_PURPOSES.LISTENER)).toEqual({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], types: ["IPv4"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), status: 0, stdout: validOpen, stderr: Buffer.alloc(0) }, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toMatchObject({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], paths: ["/private/tmp/fixture/held-file"] }],
    });
    expect(classifyMasLsofResult({ ...empty(), status: 0, stdout: Buffer.from(validListener), stderr: "" }, MAS_LSOF_PURPOSES.LISTENER)).toMatchObject({
      status: "live",
      records: [{ pid: 31, command: "node", fileDescriptors: ["3"], types: ["IPv4"] }],
    });

    const rejected = [
      ["status-1 whitespace stdout", empty({ stdout: " \t\n" })],
      ["status-1 non-empty stderr", empty({ stderr: "diagnostic\n" })],
      ["status-1 missing stderr", empty({ stderr: undefined })],
      ["status-1 valid stdout plus stderr", empty({ stdout: validOpen, stderr: "diagnostic\n" })],
      ["status-1 missing stdout", empty({ stdout: undefined })],
      ["status-1 null stderr", empty({ stderr: null })],
      ["status-1 non-string stream", empty({ stdout: 0 })],
      ["status-1 signal", empty({ signal: "SIGTERM" })],
      ["status-1 missing signal", empty({ signal: undefined })],
      ["status-1 error", empty({ error: Object.assign(new Error("secret lsof error"), { code: "EACCES" }) })],
      ["status-1 valid stdout plus signal", empty({ stdout: validOpen, signal: "SIGTERM" })],
      ["status-1 valid stdout plus error", empty({ stdout: validOpen, error: Object.assign(new Error("secret lsof error"), { code: "EACCES" }) })],
      ["status-1 malformed records", empty({ stdout: "p31\ncnode\nxunexpected\n" })],
      ["status-1 invalid UTF-8", empty({ stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) })],
      ["status-1 maxBuffer overflow", empty({ stdout: Buffer.alloc(MAS_LSOF_MAX_BUFFER_BYTES + 1, 0x78) })],
      ["null result", null],
      ["undefined result", undefined],
      ["null status", empty({ status: null })],
      ["undefined status", empty({ status: undefined })],
      ["negative status", empty({ status: -1 })],
      ["status greater than one", empty({ status: 2 })],
      ["string status", empty({ status: "1" })],
      ["status-0 empty", empty({ status: 0 })],
      ["status-0 whitespace", empty({ status: 0, stdout: " \n" })],
      ["status-0 missing stderr", empty({ status: 0, stderr: undefined })],
      ["status-0 null stdout", empty({ status: 0, stdout: null })],
      ["status-0 diagnostic stderr", empty({ status: 0, stdout: validOpen, stderr: "warning\n" })],
      ["status-0 missing final newline", empty({ status: 0, stdout: validOpen.slice(0, -1) })],
      ["status-0 unknown field", empty({ status: 0, stdout: "p31\ncnode\nxunexpected\n" })],
      ["status-0 missing required field", empty({ status: 0, stdout: "p31\ncnode\n" })],
      ["status-0 invalid UTF-8", empty({ status: 0, stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) })],
      ["status-0 maxBuffer overflow", empty({ status: 0, stdout: Buffer.alloc(MAS_LSOF_MAX_BUFFER_BYTES + 1, 0x78) })],
      ["spawnSync maxBuffer error", { error: Object.assign(new Error("secret maxBuffer output"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), status: null, signal: null, stdout: undefined, stderr: undefined }],
    ] as const;

    for (const [_label, result] of rejected) {
      expect(() => classifyMasLsofResult(result, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toThrow(/MAS runtime-root open-handle lsof result rejected/);
    }

    const diagnosticResult = empty({
      status: 2,
      stdout: `stream-secret-sentinel-${"s".repeat(1024 * 1024)}`,
      stderr: `stream-secret-sentinel-${"e".repeat(1024 * 1024)}`,
      error: Object.assign(new Error("error-message-secret"), { code: "EACCES", syscall: "spawn lsof" }),
    });
    let diagnostic: Error | undefined;
    try {
      classifyMasLsofResult(diagnosticResult, MAS_LSOF_PURPOSES.OPEN_HANDLES);
    } catch (error) {
      diagnostic = error as Error;
    }
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).not.toContain("stream-secret-sentinel");
    expect(diagnostic!.message).not.toContain("error-message-secret");
    expect(diagnostic!.message).toContain('purpose=open-handles');
    expect(diagnostic!.message).toContain('error=name="Error",code="EACCES"');
    expect(diagnostic!.message).toMatch(/stdout=\{state=present,type=string,byteLength=\d+\}/u);
    expect(diagnostic!.message).toMatch(/stderr=\{state=present,type=string,byteLength=\d+\}/u);
    expect(diagnostic!.message.length).toBeLessThan(2_048);
  });

  it("uses bounded low-level lsof adapters and rejects +D root type drift before invocation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-adapter-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    const calls: Array<{ command: string; arguments_: string[]; options: Record<string, unknown> }> = [];
    const empty = { error: undefined, status: 1, signal: null, stdout: "", stderr: "" };
    const invokeLsof = (command: string, arguments_: string[], options: Record<string, unknown>) => {
      calls.push({ command, arguments_, options });
      return empty;
    };

    await expect(inspectListeners([16777], context, { invokeLsof })).resolves.toEqual([]);
    await expect(inspectOpenHandles([], context, { invokeLsof })).resolves.toEqual([]);
    await expect(inspectMasLiveState(context, {
      processRows: async () => [],
      sockets: async () => [],
      invokeLsof,
    })).resolves.toMatchObject({ status: "absent" });
    expect(calls[0]).toMatchObject({
      command: "/usr/sbin/lsof",
      arguments_: ["-nP", "-iTCP:16777", "-sTCP:LISTEN", "-Fpct"],
    });
    expect(calls[0].options).toMatchObject({ encoding: "utf8", maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES });
    expect(Number.isFinite(calls[0].options.maxBuffer)).toBe(true);
    const openCall = calls.find((call) => call.arguments_.includes("+D"));
    expect(openCall).toMatchObject({
      command: "/usr/sbin/lsof",
      arguments_: ["-nP", "+D", context.runtimeRoot, "-Fpcn"],
    });

    const guardedCalls = calls.length;
    await rm(context.runtimeRoot, { recursive: true, force: true });
    await symlink(base, context.runtimeRoot);
    await expect(inspectOpenHandles([], context, { invokeLsof })).rejects.toThrow(/non-symlink directory before invocation/);
    expect(calls).toHaveLength(guardedCalls);

    await rm(context.runtimeRoot, { recursive: true, force: true });
    await writeFile(context.runtimeRoot, "not a directory\n");
    await expect(inspectOpenHandles([], context, { invokeLsof })).rejects.toThrow(/non-symlink directory before invocation/);
    expect(calls).toHaveLength(guardedCalls);
  });

  it("proves exact /usr/sbin/lsof fixture no-match and held-file semantics", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-fixture-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await expect(inspectListeners([1], context)).resolves.toEqual([]);
    await expect(inspectOpenHandles([], context)).resolves.toEqual([]);

    const missingPath = path.join(context.runtimeRoot, "missing-path");
    const missing = spawnSync("/usr/sbin/lsof", ["-nP", "+D", missingPath, "-Fpcn"], {
      encoding: "utf8",
      maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    expect(missing.status).toBe(1);
    expect(Buffer.byteLength(String(missing.stderr), "utf8")).toBeGreaterThan(0);
    expect(() => classifyMasLsofResult(missing, MAS_LSOF_PURPOSES.OPEN_HANDLES)).toThrow(/status 1 is not an exact empty no-match result/);

    const heldPath = path.join(context.runtimeRoot, "held-file");
    await writeFile(heldPath, "held\n");
    const held = await open(heldPath, "r");
    try {
      const heldResult = spawnSync("/usr/sbin/lsof", ["-nP", "+D", context.runtimeRoot, "-Fpcn"], {
        encoding: "utf8",
        maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      });
      expect(heldResult.status).toBe(1);
      expect(Buffer.byteLength(String(heldResult.stdout), "utf8")).toBeGreaterThan(0);
      await expect(inspectOpenHandles([], context)).resolves.toMatchObject([
        { path: context.runtimeRoot, records: expect.any(Array) },
      ]);
      const classified = classifyMasLsofResult(heldResult, MAS_LSOF_PURPOSES.OPEN_HANDLES);
      expect(classified).toMatchObject({ status: "live", records: expect.any(Array) });
      expect(classified.records.length).toBeGreaterThan(0);
    } finally {
      await held.close();
    }
  });

  it("does not begin package rollback when status-1 lsof is live or rejected", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lsof-recovery-boundary-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    const empty = { error: undefined, status: 1, signal: null, stdout: "", stderr: "" };
    const validOpen = "p31\ncnode\nf3\nn/private/tmp/fixture/held-file\n";
    let openHandleResult: Record<string, unknown> = { ...empty, stdout: validOpen };
    const invokeLsof = (_command: string, arguments_: string[]) => arguments_.includes("+D") ? openHandleResult : empty;
    const dependencies = {
      processRows: async () => [],
      sockets: async () => [],
      invokeLsof,
    };
    let mutationCount = 0;
    const attemptRestore = () => restoreInRequiredOrder({
      stop: () => stopMasDevelopmentGate({ context, dependencies }),
      rollbackPackage: async () => {
        mutationCount += 1;
        return { status: "ready-for-runtime-restore" };
      },
      reacquireGateLock: async () => {
        mutationCount += 1;
        return { release: async () => undefined };
      },
      runtimeRestore: async () => {
        mutationCount += 1;
        return { phase: "restored" };
      },
      archiveSession: async () => {
        mutationCount += 1;
        return { phase: "archived" };
      },
    });

    await expect(attemptRestore()).rejects.toThrow(/exact LaunchServices host process/);
    openHandleResult = { ...empty, stdout: validOpen, stderr: "diagnostic\n" };
    await expect(attemptRestore()).rejects.toThrow(/lsof result rejected/);
    expect(mutationCount).toBe(0);
  });

  it("uses one stable kernel lock and rejects contention until the holder releases", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lock-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });
    const first = await acquireMasGateLock({ parentPath: parent });
    expect(first.lockPath).toBe(masGateLockPath(parent));
    await expect(acquireMasGateLock({ parentPath: parent })).rejects.toThrow(/MAS gate lock failed/);
    await first.release();
    const second = await acquireMasGateLock({ parentPath: parent });
    await second.release();
    await expect(lstat(masGateLockPath(parent))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("requires a live kernel-holder assertion for every supplied lease", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lease-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });

    const released = await acquireMasGateLock({ parentPath: parent });
    await released.release();
    await expect(released.assertHeld()).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: released }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);

    const killed = await acquireMasGateLock({ parentPath: parent });
    process.kill(killed.holderPid, "SIGKILL");
    await expect(killed.assertHeld()).rejects.toThrow(/no longer held|kernel lock|holder exited/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: killed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|holder exited|not kernel-backed/);

    const genuine = await acquireMasGateLock({ parentPath: parent });
    expect(Object.isFrozen(genuine)).toBe(true);
    const spoofed = { ...genuine };
    await expect(withMasGateLock({ parentPath: parent, lockLease: spoofed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/not kernel-backed|live holder/);
    await genuine.release();
  });

  it("uses an actual committed package transaction for post-install launch and restore composition", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-launch-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n");
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] } }),
    });
    const packageParent = path.join(base, "Applications");
    const packageTarget = path.join(packageParent, "Meetless.app");
    const packageSource = path.join(base, "candidate.app");
    await mkdir(packageParent, { recursive: true, mode: 0o700 });
    await mkdir(path.join(packageTarget, "Contents"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageTarget, "Contents", "marker"), "prior package\n");
    await mkdir(path.join(packageSource, "Contents"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(packageSource, "Contents", "marker"), "candidate package\n");
    await mkdir(path.join(packageSource, "Contents", "Helpers", "Electron.app", "Contents"), { recursive: true, mode: 0o700 });
    const convexUrl = "https://meetless-launch-fixture.convex.cloud/";
    await writeFile(path.join(packageSource, "Contents", "Info.plist"), plist.build({
      CFBundleIdentifier: R5_APP_STORE_BUNDLE_ID,
      ElectronTeamID: R5_APP_STORE_TEAM_ID,
      [R5_REVENUECAT_INFO_PLIST_KEY]: "appl_launch_fixture_public_key",
      [R5_CONVEX_INFO_PLIST_KEY]: convexUrl,
    }), { mode: 0o600 });
    await writeFile(path.join(packageSource, "Contents", "Helpers", "Electron.app", "Contents", "Info.plist"), plist.build({
      CFBundleExecutable: "Electron",
      CFBundleVersion: "41.2.0",
      CFBundleIdentifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
      ElectronTeamID: R5_APP_STORE_TEAM_ID,
    }), { mode: 0o600 });
    const manifestPath = path.join(base, "app-store-development-manifest.json");
    const manifest = {
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      convexUrlEmbedded: true,
      convexUrlSha256: createHash("sha256").update(convexUrl).digest("hex"),
      electron: { executable: "Contents/Helpers/Electron.app/Contents/MacOS/Electron" },
      signature: {
        nestedMachO: [{
          path: "Contents/Helpers/Electron.app/Contents/MacOS/Electron",
          identifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
        }],
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const packageFingerprint = await fingerprintPath(packageSource);
    if (!packageFingerprint) throw new Error("package fixture source fingerprint is missing");
    const artifactBinding = freezeMasGateArtifactBinding({
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      bundlePath: packageSource,
      bundleFingerprint: packageFingerprint,
      artifactDigest: "a".repeat(64),
      candidateSnapshotDigest: "b".repeat(64),
      packageInputDigest: "c".repeat(64),
      artifactInputDigest: "d".repeat(64),
      licenseDigest: "e".repeat(64),
      signatureDigest: createHash("sha256").update(JSON.stringify(manifest.signature)).digest("hex"),
      publicSdkKeySha256: createHash("sha256").update("fixture-public-key").digest("hex"),
    });
    const packageTransaction = await replacePackageBundle({
      source: packageSource,
      target: packageTarget,
      identityPath: context.identityPath,
      ownerToken: session.ownerToken,
      runId: session.runId,
      artifactBinding,
      inspect: async () => ({
        version: 1,
        bundleIdentifier: context.contract.bundleIdentifier,
        bundlePath: context.bundlePath,
        bundleRealPath: context.bundlePath,
        executablePath: context.executablePath,
        designatedRequirement: "identifier \\\"com.meetless.app\\\"",
        cdHash: "a".repeat(40),
        binarySha256: "b".repeat(64),
        binaryDevice: 1,
        binaryInode: 3,
        binarySize: 10,
        configuration: {
          repositoryRoot: path.join(base, "repository"),
          runtimeRoot: context.runtimeRoot,
          listen: "127.0.0.1:16777",
          rendererOrigin: "http://127.0.0.1:18082",
          transcriptionSocket: path.join(context.runtimeRoot, "transcription.sock"),
          transcriptionStaging: path.join(context.runtimeRoot, "transcription-staging"),
          nodePath: path.join(base, "node"),
          runtimeCliPath: path.join(base, "runtime.js"),
          identityPath: context.identityPath,
        },
      }),
    });
    const installed = {
      version: 1,
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
      configuration: {
        repositoryRoot: path.join(base, "repository"),
        runtimeRoot: context.runtimeRoot,
        listen: "127.0.0.1:16777",
        rendererOrigin: "http://127.0.0.1:18082",
        transcriptionSocket: path.join(context.runtimeRoot, "transcription.sock"),
        transcriptionStaging: path.join(context.runtimeRoot, "transcription-staging"),
        nodePath: path.join(base, "node"),
        runtimeCliPath: path.join(base, "runtime.js"),
        identityPath: context.identityPath,
      },
    };
    const available = createMasHostHandoff(context, session, installed);
    await writeFile(path.join(session.activePath, "host-handoff.json"), `${JSON.stringify(available)}\n`, { mode: 0o600 });
    const packageJournalPath = packageTransactionPaths(context.bundlePath, session.runId).journal;
    let interruptAfterPackageRecord = false;
    let injectLateReceipt = false;
    let lateReceiptInjected = false;
    let interruptAfterUpgradeWrite = false;
    const packageFilesystem = {
      resolvePath: (candidate: string) => {
        const logicalParent = path.dirname(context.bundlePath);
        const prefix = `${logicalParent}${path.sep}`;
        if (candidate === logicalParent) return packageParent;
        if (candidate.startsWith(prefix)) return path.join(packageParent, candidate.slice(prefix.length));
        return candidate;
      },
      lstat: (candidate: string) => lstat(candidate),
      beforePendingRetainedInspection: async (retained: any) => {
        if (!injectLateReceipt || lateReceiptInjected || retained.source !== packageTransaction.paths.displaced) return;
        lateReceiptInjected = true;
        const receiptDirectory = path.join(
          retained.path,
          "Contents", "Helpers", "Electron.app", "Contents", "_MASReceipt",
        );
        await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(receiptDirectory, "receipt"), "opaque late receipt\n", { mode: 0o600 });
      },
      afterPackageRetentionRecordWrite: async (record: any) => {
        if (interruptAfterPackageRecord && record.source === packageTransaction.paths.displaced) {
          interruptAfterPackageRecord = false;
          throw new Error("one-shot coordinator interruption after durable package record");
        }
      },
      afterPackageRetentionUpgradeWrite: async (records: any[]) => {
        if (interruptAfterUpgradeWrite && records.some((record) => record.source === packageTransaction.paths.displaced)) {
          interruptAfterUpgradeWrite = false;
          throw new Error("one-shot coordinator interruption after durable late-receipt upgrade");
        }
      },
    };
    let launchElectronIdentifier = R5_APP_STORE_ELECTRON_BUNDLE_ID;
    const launchElectronSignatureText = () => [
      `Identifier=${launchElectronIdentifier}`,
      `TeamIdentifier=${R5_APP_STORE_TEAM_ID}`,
      `Authority=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
      "Signature=CMS",
      `CDHash=${"a".repeat(40)}`,
    ].join("\n");
    const launchDependencies = {
      expectedConvexUrl: convexUrl,
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      packageFilesystem,
      artifactValidationAdapters: {
        runMacOSCommand: async (command: string, arguments_: string[]) => {
          if (command === "codesign" && arguments_.includes("--display") && arguments_.includes("--verbose=4")) {
            return { stdout: launchElectronSignatureText(), stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      },
    };
    const narrativeDigestOutsideRuntimeContract = "0".repeat(64);
    await expect(attestMasGateRuntimeRoot(session.quarantinePath)).resolves.toEqual(session.priorAggregateAttestation);
    expect(session.priorAggregateAttestation.digest).not.toBe(narrativeDigestOutsideRuntimeContract);
    await expect(validateMasDevelopmentInstalledSignatures({
      manifestPath,
      bundlePath: context.bundlePath,
      artifactBinding,
      dependencies: launchDependencies,
    })).resolves.toMatchObject({ status: "passed" });
    const composedStatus = await readMasDevelopmentGateStatus({
      context,
      dependencies: launchDependencies,
    });
    expect(composedStatus).toMatchObject({
      status: "active",
      phase: "ready",
      package: { status: "committed", state: "committed", journalPath: packageJournalPath },
    });
    const handoffPath = path.join(session.activePath, "host-handoff.json");
    await rm(handoffPath);
    launchElectronIdentifier = "com.github.Electron";
    let launchIdentityFailure: any = null;
    let identityFailureLaunchCalled = false;
    let identityFailureHandoffWaited = false;
    try {
      await launchMasDevelopmentGate({
        context,
        dependencies: {
          ...launchDependencies,
          launch: async () => { identityFailureLaunchCalled = true; },
          waitForHandoff: async () => {
            identityFailureHandoffWaited = true;
            return available;
          },
        },
      });
    } catch (error) {
      launchIdentityFailure = error;
    } finally {
      launchElectronIdentifier = R5_APP_STORE_ELECTRON_BUNDLE_ID;
    }
    expect(launchIdentityFailure).toMatchObject({ cause: expect.any(Error) });
    expect(String(launchIdentityFailure?.cause?.message)).toMatch(/signature identifier is com\.github\.Electron, expected com\.meetless\.app\.electron/);
    expect(identityFailureLaunchCalled).toBe(false);
    expect(identityFailureHandoffWaited).toBe(false);
    await expect(lstat(handoffPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(handoffPath, `${JSON.stringify(available)}\n`, { mode: 0o600 });
    await rm(handoffPath);

    const handoffReadFailure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => { throw new Error("must not launch without an available handoff"); },
      },
    }));
    expect(handoffReadFailure).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_READ,
      },
    });
    await writeFile(path.join(session.activePath, "host-handoff.json"), `${JSON.stringify(available)}\n`, { mode: 0o600 });

    const openFailure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => { throw new Error(`secret-open-failure ${context.runtimeRoot}`); },
      },
    }));
    expect(openFailure).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.OPEN_FAILED,
      },
    });
    expect(JSON.stringify(openFailure)).not.toContain(context.runtimeRoot);

    const claimedHandoffFailure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => undefined,
        waitForHandoff: async () => available,
      },
    }));
    expect(claimedHandoffFailure).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID,
        predicateGroup: MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE,
      },
    });

    const timeoutFailure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => undefined,
      },
    }));
    expect(timeoutFailure).toMatchObject({
      diagnostic: {
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.HANDOFF_CLAIM_TIMEOUT,
        lastCause: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.CLAIMED_HANDOFF_INVALID,
        lastPredicateGroup: MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE,
      },
    });
    expect(JSON.stringify(timeoutFailure)).not.toContain(context.runtimeRoot);
    expect(JSON.stringify(timeoutFailure)).not.toContain(session.ownerToken);

    let launchCalled = false;
    const result = await launchMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        launch: async () => {
          launchCalled = true;
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
        },
        waitForHandoff: async () => {
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
          return { ...available, state: "claimed", claimedByPid: process.pid, claimedAt: new Date().toISOString() };
        },
      },
    });
    expect(launchCalled).toBe(true);
    expect(result.status).toBe("launch-claimed");
    expect(result.handoff.state).toBe("claimed");
    expect(result).not.toHaveProperty("readiness");

    interruptAfterPackageRecord = true;
    await expect(restorePackageTransaction(packageTransaction, {
      ownerToken: packageTransaction.ownerToken,
      target: packageTransaction.target,
      identityPath: packageTransaction.identityPath,
      runtimeRootPath: context.runtimeRoot,
      requireRecoveryProof: true,
      expectedArtifactBinding: artifactBinding,
      filesystem: packageFilesystem,
    })).rejects.toThrow("one-shot coordinator interruption after durable package record");
    const interruptedPackageJournal = JSON.parse(await readFile(packageTransaction.paths.journal, "utf8"));
    expect(interruptedPackageJournal.state).toBe("target-restored");
    expect(interruptedPackageJournal.cleanupSource).toBe(packageTransaction.paths.displaced);
    expect(interruptedPackageJournal.cleanupPath).toBeDefined();
    expect(interruptedPackageJournal.retainedPackageDisposables.records).toHaveLength(1);
    expect(interruptedPackageJournal.retainedPackageDisposables.records[0].receipt).toBeNull();

    injectLateReceipt = true;
    interruptAfterUpgradeWrite = true;
    await expect(restorePackageTransaction(packageTransaction, {
      ownerToken: packageTransaction.ownerToken,
      target: packageTransaction.target,
      identityPath: packageTransaction.identityPath,
      runtimeRootPath: context.runtimeRoot,
      requireRecoveryProof: true,
      expectedArtifactBinding: artifactBinding,
      filesystem: packageFilesystem,
    })).rejects.toThrow("one-shot coordinator interruption after durable late-receipt upgrade");
    expect(lateReceiptInjected).toBe(true);
    const interruptedUpgradeJournal = JSON.parse(await readFile(packageTransaction.paths.journal, "utf8"));
    const interruptedUpgradeRecord = interruptedUpgradeJournal.retainedPackageDisposables.records[0];
    expect(interruptedUpgradeJournal.cleanupPath).toBe(interruptedUpgradeRecord.path);
    expect(interruptedUpgradeRecord).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      receipt: {
        relative: "Contents/Helpers/Electron.app/Contents/_MASReceipt/receipt",
      },
    });
    expect(interruptedUpgradeRecord.receiptChain).toHaveLength(5);

    const restored = await restoreMasDevelopmentGate({
      context,
      dependencies: {
        ...launchDependencies,
        packageFilesystem: { resolvePath: packageFilesystem.resolvePath },
      },
    });
    expect(restored.status).toBe("restored");
    expect(restored.packageRollbackBeforeRuntimeRestore).toBe(true);
    expect(restored.session.phase).toBe("archived");
    await expect(readFile(path.join(packageTarget, "Contents", "marker"), "utf8")).resolves.toBe("prior package\n");
    await expect(lstat(context.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(context.runtimeRoot, "prior-runtime-state"), "utf8")).resolves.toBe("prior runtime\n");
    await expect(lstat(session.freshRetainedPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(lstat(packageTransaction.paths.journal)).resolves.toBeDefined();
    const retainedPackageJournal = JSON.parse(await readFile(packageTransaction.paths.journal, "utf8"));
    const retainedRecord = retainedPackageJournal.retainedPackageDisposables.records[0];
    const retainedSuffix = createHash("sha256")
      .update(`${packageTransaction.paths.displaced}\0displaced package`)
      .digest("hex")
      .slice(0, 16);
    expect(retainedRecord).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      source: packageTransaction.paths.displaced,
      path: `${packageTransaction.paths.displaced}.m7-cleanup-${session.runId}-${retainedSuffix}`,
      packageRole: "candidate",
      packageFingerprint: packageTransaction.candidateFingerprint,
      receipt: {
        relative: "Contents/Helpers/Electron.app/Contents/_MASReceipt/receipt",
      },
    });
    expect(retainedRecord.receiptChain).toHaveLength(5);
    expect(retainedRecord).toEqual(interruptedUpgradeRecord);
  });

  it("does not synthesize post-install active/ready or consult package state before quarantine attestation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-quarantine-status-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "prior-runtime-state"), "prior runtime\n", { mode: 0o600 });
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, {
        requiredFreeBytes: 1,
        dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] },
      }),
    });
    await writeFile(context.identityPath, "published package identity\n", { mode: 0o600 });
    await writeFile(path.join(session.quarantinePath, "prior-runtime-state"), "changed bytes\n", { mode: 0o600 });
    let packagePathResolutions = 0;

    await expect(readMasDevelopmentGateStatus({
      context,
      dependencies: {
        packageFilesystem: {
          resolvePath: (candidate: string) => {
            packagePathResolutions += 1;
            return candidate;
          },
        },
      },
    })).rejects.toThrow(/quarantine prior root attestation changed/);
    expect(packagePathResolutions).toBe(0);
    await expect(readFile(context.identityPath, "utf8")).resolves.toBe("published package identity\n");
    await expect(readFile(path.join(session.quarantinePath, "prior-runtime-state"), "utf8")).resolves.toBe("changed bytes\n");
    await expect(lstat(session.freshRetainedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(context.parentPath, `.meetless-mas-gate-session.${session.runId}.archived`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot authorize launch through a caller-supplied package proof", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-proof-authority-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    const session = await beginMasGateSessionTransaction({
      ...masGateRuntimeOptions(context, {
        requiredFreeBytes: 1,
        dependencies: { processRows: async () => [], listeners: async () => [], sockets: async () => [], openHandles: async () => [] },
      }),
    });
    const packageParent = path.join(base, "Applications");
    await mkdir(packageParent, { recursive: true, mode: 0o700 });
    const packageFilesystem = {
      resolvePath: (candidate: string) => {
        const logicalParent = path.dirname(context.bundlePath);
        const prefix = `${logicalParent}${path.sep}`;
        if (candidate === logicalParent) return packageParent;
        if (candidate.startsWith(prefix)) return path.join(packageParent, candidate.slice(prefix.length));
        return candidate;
      },
    };
    let forgedReaderCalled = false;
    let launchCalled = false;
    const failure = await captureLaunchFailure(() => launchMasDevelopmentGate({
      context,
      dependencies: {
        processRows: async () => [],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        packageFilesystem,
        readPackageTransactionProof: async () => {
          forgedReaderCalled = true;
          return { status: "committed" };
        },
        launch: async () => { launchCalled = true; },
      },
    }));
    expect(failure).toMatchObject({
      diagnostic: {
        schema: MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
        category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.PACKAGE_PROOF,
      },
    });
    expect(forgedReaderCalled).toBe(false);
    expect(launchCalled).toBe(false);
    await expect(readFile(path.join(session.activePath, "transaction.json"))).resolves.toBeDefined();
  });

  it("stops only the exact owned host through the coordinator and never through an ambient authority string", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-stop-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    let live = true;
    const dependencies = {
      processRows: async () => live ? [host] : [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      stopProcess: async (pid: number) => {
        expect(pid).toBe(host.pid);
        live = false;
      },
      waitForProcessExit: async () => undefined,
    };
    await expect(stopMasDevelopmentGate({ context, dependencies })).resolves.toMatchObject({ status: "stopped" });

    let signalled = false;
    const nonExactHost = { ...host, arguments: [context.executablePath, ""] };
    await expect(stopMasDevelopmentGate({
      context,
      dependencies: {
        processRows: async () => [nonExactHost],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        stopProcess: async () => { signalled = true; },
      },
    })).rejects.toThrow(/exact LaunchServices host process/);
    expect(signalled).toBe(false);

    const masRoot = context.runtimeRoot;
    const forged = await execFile(process.execPath, ["scripts/stop-macos-host.mjs"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: base,
        MEETLESS_RUNTIME_ROOT: masRoot,
        MEETLESS_LISTEN: context.contract.listen,
        MEETLESS_MAS_COORDINATOR_AUTHORITY: "MAS_GATE_COORDINATOR v1",
      },
    }).catch((error) => error);
    expect(forged.code).not.toBe(0);
    expect(`${forged.stderr ?? ""}${forged.stdout ?? ""}`).toMatch(/refuses the MAS app-container runtime root/);
  });

  it("always runs production validation and ignores forged validator results before any mutation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-install-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const proofRoot = path.join(base, "proof");
    const releaseRoot = path.join(proofRoot, "release", "macos");
    const bundle = path.join(releaseRoot, "Meetless.app");
    const manifestPath = path.join(releaseRoot, "app-store-development-manifest.json");
    await mkdir(bundle, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      bundlePath: "release/macos/Meetless.app",
      directComposition: { path: "release/macos/composition-manifest.direct.json" },
    })}\n`, { mode: 0o600 });
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await mkdir(context.runtimeRoot, { recursive: true });
    await writeFile(prior, "prior\n");
    const forgedBinding = {
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      bundlePath: bundle,
      manifestSha256: "f".repeat(64),
      bundleFingerprint: "f".repeat(64),
      artifactDigest: "f".repeat(64),
      candidateSnapshotDigest: "f".repeat(64),
      packageInputDigest: "f".repeat(64),
      artifactInputDigest: "f".repeat(64),
      licenseDigest: "f".repeat(64),
      signatureDigest: "f".repeat(64),
      publicSdkKeySha256: "f".repeat(64),
    };
    let forgedValidatorCalled = false;
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        expectedConvexUrl: MAS_FIXTURE_CONVEX_URL,
        validateArtifact: async () => {
          forgedValidatorCalled = true;
          return { status: "passed", artifactBinding: forgedBinding };
        },
      },
    })).rejects.toThrow(/full MAS artifact validation|schema, authority, bundle/);
    expect(forgedValidatorCalled).toBe(false);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(context.parentPath, MAS_GATE_SESSION_INDEX_BASENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(context.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        expectedConvexUrl: MAS_FIXTURE_CONVEX_URL,
        artifactValidationAdapters: { fingerprintPath: async () => "f".repeat(64) },
      },
    })).rejects.toThrow(/not an allowed low-level function/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installMasDevelopmentGate({
      manifestPath: path.join(releaseRoot, "missing.json"),
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        expectedRevenueCatPublicSdkKey: "appl_test_validator_authority",
        expectedConvexUrl: MAS_FIXTURE_CONVEX_URL,
        artifactBinding: forgedBinding,
        validateArtifact: async () => ({ status: "passed", artifactBinding: forgedBinding }),
      },
    })).rejects.toThrow(/MAS development manifest/);
  });

  it("rejects a wrong public key or missing license evidence before runtime quarantine", { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-validation-negative-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await writeFile(prior, "prior\n");
    const fixture = await makeMasValidationFixture();
    const { bundlePath: bundle, manifestPath } = fixture;
    const baseDependencies = {
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      artifactValidationAdapters: fixture.adapters,
      expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
      expectedConvexUrl: fixture.convexUrl,
    };
    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies: baseDependencies,
    })).rejects.toThrow(/accepted pin/);
    const fixtureDependencies = {
      ...baseDependencies,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
    };
    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies: { ...fixtureDependencies, expectedRevenueCatPublicSdkKey: "appl_wrong_fixture_public_key" },
    })).rejects.toThrow(/different RevenueCat public SDK key/);

    const originalReadSecureFile = fixture.adapters.readSecureFile;
    const missingLicenseAdapters = {
      ...fixture.adapters,
      readSecureFile: async (target: string, label: string) => target.endsWith("/license-inventory.json")
        ? Buffer.from("{}")
        : originalReadSecureFile(target, label),
    };
    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies: {
        ...fixtureDependencies,
        expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
        artifactValidationAdapters: missingLicenseAdapters,
      },
    })).rejects.toThrow(/license inventory|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });

    const originalEntries = await fixture.adapters.enumeratePackageEntries();
    const symlinkEvidenceAdapters = {
      ...fixture.adapters,
      enumeratePackageEntries: async () => originalEntries.map((entry, index) => index === 0
        ? { ...entry, type: "symlink", target: "../outside" }
        : entry),
    };
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        ...fixtureDependencies,
        artifactValidationAdapters: symlinkEvidenceAdapters,
      },
    })).rejects.toThrow(/packaged symlink|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });

    const originalInspectMachO = fixture.adapters.inspectMachO;
    const loadPathEvidenceAdapters = {
      ...fixture.adapters,
      inspectMachO: async (target: string) => {
        const inspected = await originalInspectMachO(target);
        return inspected ? { ...inspected, dependencies: ["/tmp/forbidden-mas-fixture.dylib"] } : inspected;
      },
    };
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        ...fixtureDependencies,
        artifactValidationAdapters: loadPathEvidenceAdapters,
      },
    })).rejects.toThrow(/external dependency|full MAS artifact validation/);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["opaque MAS receipt", "Contents/Helpers/Electron.app/Contents/_MASReceipt/receipt"],
    ["absolute external file", path.resolve("/tmp/meetless-forbidden-license-inventory.json")],
  ])("rejects a manifest-selected %s before reading it", async (_label, suppliedPath) => {
    const fixture = await makeMasValidationFixture();
    const { bundlePath, manifestPath } = fixture;
    const originalManifest = JSON.parse((await fixture.adapters.readSecureFile(manifestPath, "fixture manifest")).toString("utf8"));
    const mutatedManifest = structuredClone(originalManifest);
    mutatedManifest.masPackageEvidence.licenseInventory.path = suppliedPath;
    const mutatedManifestBytes = Buffer.from(`${JSON.stringify(mutatedManifest)}\n`);
    const forbiddenPath = path.isAbsolute(suppliedPath)
      ? suppliedPath
      : path.resolve(bundlePath, suppliedPath);
    const readTargets: string[] = [];
    const ownerCommands: string[] = [];
    const originalReadSecureFile = fixture.adapters.readSecureFile;
    const adapters = {
      ...fixture.adapters,
      readSecureFile: async (target: string, label: string) => {
        const resolved = path.resolve(target);
        readTargets.push(resolved);
        if (resolved === path.resolve(forbiddenPath)) throw new Error(`forbidden target read: ${resolved}`);
        if (resolved === path.resolve(manifestPath)) return mutatedManifestBytes;
        return originalReadSecureFile(target, label);
      },
      runMacOSCommand: async (command: string, arguments_: string[]) => {
        ownerCommands.push(`${command} ${arguments_.join(" ")}`);
        return fixture.adapters.runMacOSCommand(command, arguments_);
      },
    };

    await expect(validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath,
      dependencies: {
        expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
        expectedConvexUrl: fixture.convexUrl,
        expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
        artifactValidationAdapters: adapters,
      },
    })).rejects.toThrow(/manifest license inventory binding is missing or invalid/);
    expect(readTargets).toEqual([path.resolve(manifestPath)]);
    expect(readTargets).not.toContain(path.resolve(forbiddenPath));
    expect(ownerCommands).toEqual([]);
  });

  it("runs complete policy with low-level fixture adapters and passes the unchanged binding to composition", { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-binding-composition-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await seedMasSessionIndex(context);
    await writeFile(path.join(context.runtimeRoot, "opaque-state"), "preserve me\n");

    const fixture = await makeMasValidationFixture();
    const { bundlePath: bundle, manifestPath } = fixture;
    const fixtureManifest = JSON.parse((await fixture.adapters.readSecureFile(manifestPath, "fixture manifest")).toString("utf8"));
    expect(fixtureManifest.signature.nestedMachO.find((entry: { path: string }) => entry.path === "Contents/Helpers/Electron.app/Contents/MacOS/Electron")).toMatchObject({
      identifier: R5_APP_STORE_ELECTRON_BUNDLE_ID,
    });
    expect(fixtureManifest.signature.nestedMachO.find((entry: { path: string }) => entry.path.endsWith("Electron Helper.app/Contents/MacOS/Electron Helper"))).toMatchObject({
      identifier: "com.github.Electron.helper",
    });
    const inventoryReads: string[] = [];
    const originalReadSecureFile = fixture.adapters.readSecureFile;
    const validationAdapters = {
      ...fixture.adapters,
      readSecureFile: async (target: string, label: string) => {
        const resolved = path.resolve(target);
        if (resolved.endsWith(`/${MACOS_LICENSE_INVENTORY_PATH}`)) inventoryReads.push(resolved);
        return originalReadSecureFile(target, label);
      },
    };
    const dependencies = {
      expectedRevenueCatPublicSdkKey: fixture.publicSdkKey,
      expectedConvexUrl: fixture.convexUrl,
      expectedElectronArchiveSha256: fixture.expectedElectronArchiveSha256,
      processRows: async () => [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      artifactValidationAdapters: validationAdapters,
    };
    const validation = await validateMasDevelopmentInstallArtifact({
      manifestPath,
      bundlePath: bundle,
      context,
      dependencies,
    });
    expect(inventoryReads).toEqual([path.resolve(bundle, MACOS_LICENSE_INVENTORY_PATH)]);
    const runtimeLease = await acquireMasGateLock({ parentPath: context.parentPath });
    let session;
    try {
      session = await beginMasGateSessionTransaction({
        ...masGateRuntimeOptions(context, { requiredFreeBytes: 1, dependencies }),
        lockLease: runtimeLease,
      });
    } finally {
      await runtimeLease.release();
    }
    let packageInput: Record<string, unknown> | null = null;
    const packageTransaction = await (async (input: Record<string, unknown>) => {
      packageInput = input;
      return { schema: "MAS_PACKAGE_TRANSACTION v4", version: 4, artifactBinding: input.artifactBinding };
    })({
      source: bundle,
      target: context.bundlePath,
      artifactBinding: validation.artifactBinding,
    });
    const result = { status: "installed", session, packageTransaction };

    expect(result.status).toBe("installed");
    expect(result.session.schema).toBe("MAS_GATE_SESSION_TRANSACTION v2");
    expect(packageInput?.artifactBinding).toBe(result.packageTransaction.artifactBinding);
    expect(Object.isFrozen(packageInput?.artifactBinding)).toBe(true);
    expect(JSON.stringify(packageInput)).not.toContain(fixture.publicSdkKey);
    await expect(readFile(path.join(context.runtimeRoot, "opaque-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(result.session.quarantinePath, "opaque-state"), "utf8")).resolves.toBe("preserve me\n");
  });

  it("binds a one-time host handoff to the owner, run, fresh-root identity, exact bundle, and exact executable", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const session = {
      phase: "ready",
      stateScope: "runtime-root-only",
      ownerToken: "owner-token-abcdefghijklmnopqrstuvwxyz-0123456789",
      runId: "run-1",
      canonicalRuntimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: context.activePath,
      identityRelativePath: context.identityRelativePath,
      identityPath: context.identityPath,
      freshRootIdentity: {
        type: "directory",
        mode: 448,
        uid: 501,
        gid: 20,
        dev: 1,
        ino: 2,
        nlink: 2,
        size: 0,
      },
    };
    const installed = {
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
    };
    const handoff = createMasHostHandoff(context, session, installed);
    const packageProof = {
      status: "committed",
      ownerToken: session.ownerToken,
      runId: session.runId,
      target: context.bundlePath,
      identityPath: context.identityPath,
      candidateFingerprint: "c".repeat(64),
      artifactBinding: { bundleFingerprint: "c".repeat(64) },
      transaction: { state: "committed" },
      publishedHostIdentity: { version: 1, ...installed },
    };
    expect(validateMasHostHandoff(handoff, { context, session, packageProof })).toBe(handoff);
    const swiftSorted = Object.fromEntries(Object.entries({
      ...handoff,
      freshRootIdentity: Object.fromEntries(Object.entries(handoff.freshRootIdentity).reverse()),
    }).reverse());
    expect(validateMasHostHandoff(swiftSorted, { context, session, packageProof })).toBe(swiftSorted);
    const predicateCases = [
      { group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.SCHEMA, candidate: { ...handoff, extra: true } },
      { group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.SESSION, candidate: { ...handoff, ownerToken: "other-owner" } },
      { group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.ROOT, candidate: { ...handoff, canonicalRuntimeRoot: `${context.runtimeRoot}-other` } },
      { group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.PACKAGE_PROOF, proof: { ...packageProof, candidateFingerprint: "d".repeat(64) } },
      {
        group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.INSTALLED_IDENTITY,
        proof: { ...packageProof, publishedHostIdentity: { ...packageProof.publishedHostIdentity, cdHash: "d".repeat(40) } },
      },
      { group: MAS_GATE_HANDOFF_PREDICATE_GROUPS.CLAIM_STATE, candidate: { ...handoff, claimedByPid: 99 } },
    ];
    for (const testCase of predicateCases) {
      const failure = captureSynchronousFailure(() => validateMasHostHandoff(testCase.candidate ?? handoff, {
        context,
        session,
        packageProof: testCase.proof ?? packageProof,
      }));
      expect(failure).toMatchObject({
        coordinator: "MAS_GATE_COORDINATOR v1",
        status: "failed",
        diagnostic: {
          schema: MAS_GATE_LAUNCH_DIAGNOSTIC_SCHEMA,
          category: MAS_GATE_LAUNCH_FAILURE_CATEGORIES.UNKNOWN,
          predicateGroup: testCase.group,
        },
      });
      expect(JSON.stringify(failure)).not.toContain(context.runtimeRoot);
      expect(JSON.stringify(failure)).not.toContain(session.ownerToken);
    }
    for (const change of [
      { ownerToken: "other-owner" },
      { runId: "other-run" },
      { canonicalRuntimeRoot: `${context.runtimeRoot}-other` },
      { identityPath: `${context.identityPath}-other` },
      { bundlePath: `${context.bundlePath}-other` },
      { bundleIdentifier: "other.bundle" },
    ]) {
      expect(() => validateMasHostHandoff({ ...handoff, ...change }, { context, session, packageProof })).toThrow(/not bound/);
    }
    expect(() => validateMasHostHandoff({ ...handoff, extra: true }, { context, session, packageProof })).toThrow(/not bound/);
    const { binarySize: _missing, ...missingKey } = handoff;
    expect(() => validateMasHostHandoff(missingKey, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff({ ...handoff, binarySize: "10" }, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff({
      ...handoff,
      freshRootIdentity: { ...handoff.freshRootIdentity, extra: 1 },
    }, { context, session, packageProof })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff(handoff, {
      context,
      session,
      packageProof: { ...packageProof, candidateFingerprint: "d".repeat(64) },
    })).toThrow(/not bound/);
    expect(() => validateMasHostHandoff(handoff, {
      context,
      session,
      packageProof: { ...packageProof, publishedHostIdentity: { ...packageProof.publishedHostIdentity, cdHash: "d".repeat(40) } },
    })).toThrow(/not bound/);
    const replay = { ...handoff, state: "claimed", claimedByPid: 99, claimedAt: new Date().toISOString() };
    expect(() => validateMasHostHandoff(replay, { context, session, packageProof })).toThrow(/not bound/);
    expect(validateMasHostHandoff(replay, { context, session, state: "claimed", packageProof })).toBe(replay);
  });

  it("keeps restore ordering package-first and releases the reacquired lock last", async () => {
    const events: string[] = [];
    const lease = { release: async () => { events.push("release"); } };
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "ready-for-runtime-restore" }; },
      reacquireGateLock: async () => { events.push("lock"); return lease; },
      runtimeRestore: async () => { events.push("runtime-restore"); return { phase: "restored" }; },
      archiveSession: async () => { events.push("archive"); return { phase: "archived" }; },
    });
    expect(result.status).toBe("restored");
    expect(events).toEqual(["stop", "package-rollback", "lock", "runtime-restore", "archive", "release"]);
  });

  it("does not reacquire or mutate anything when stop proves no active session", async () => {
    const events: string[] = [];
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "nothing-to-restore", observation: masLiveAbsentObservation(masDevelopmentRuntimeContext({ userHome: "/Users/example" })) }; },
      reacquireGateLock: async () => { events.push("lock"); throw new Error("must not acquire"); },
      runtimeRestore: async () => { events.push("runtime"); return {}; },
      archiveSession: async () => { events.push("archive"); return {}; },
    });
    expect(result.status).toBe("nothing-to-restore");
    expect(events).toEqual(["stop", "package-rollback"]);
  });

});
