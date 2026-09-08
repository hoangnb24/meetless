import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  enumeratePackageEntries,
  inspectPackageMachOEntries,
} from "./macos-package-inventory.mjs";
import {
  collectMacOSPackageInputs,
  verifyMacOSPackageInputs,
  MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
  validateMacOSPackageElectronArchiveSource,
  validateMacOSPackageInputDocument,
} from "./macos-package-inputs.mjs";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  MACOS_MAS_LICENSE_INVENTORY_MANIFEST_PATH,
  MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX,
  MACOS_MAS_ELECTRON_APP_PATH_PREFIX,
  macOSMasLicenseLayout,
  digestArtifactEntries,
  selectArtifactEntriesForDigest,
  writeMacOSLicenseInventory,
} from "./macos-license-inventory.mjs";
import {
  validateLicenseInventoryCoverage,
  validateLicenseInventoryDocument,
  validateMasLicenseInventoryPackageInputBinding,
  validateNoticeEvidence,
  validateResolutionEvidencePaths,
} from "../validate-macos-package.mjs";
import { validateMacAppStoreDirectCompositionBinding } from "../validate-macos-package.mjs";
import {
  MACOS_APP_STORE_ELECTRON_BINARY_PATH,
  MACOS_APP_STORE_LEGACY_ELECTRON_APP_PATH,
} from "./macos-app-store-package-contract.mjs";
import { MACOS_APP_STORE_CONTRACT } from "./macos-app-store-contract.mjs";
import {
  createMacOSMasSigningBoundDescriptor,
  MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
  MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
  validateMacOSMasSigningBoundDescriptor,
  isMacOSCodeResourcesPath,
} from "./macos-mas-signing-boundary.mjs";

export const MACOS_APP_STORE_PACKAGE_EVIDENCE_SCHEMA = "MEETLESS_MACOS_APP_STORE_PACKAGE_EVIDENCE v1";
export const MACOS_APP_STORE_PACKAGE_EVIDENCE_AUTHORITY = "docs/decisions/0006-mas-development-desktop-integration.md";
export const MACOS_APP_STORE_PACKAGE_EVIDENCE_LAYOUT = MACOS_PACKAGE_ELECTRON_LAYOUT_MAS;
export const MACOS_MAS_EMBEDDED_PROFILE_PATH = "Contents/embedded.provisionprofile";
export const MACOS_MAS_EMBEDDED_PROFILE_MODE = 0o400;
const MACOS_MAS_EMBEDDED_PROFILE_SCHEMA = "MEETLESS_MACOS_MAS_EMBEDDED_PROFILE v1";

/**
 * Stage the exact selected profile in its final bundle location before any
 * MAS package-input or license evidence is derived.
 */
export async function stageMacOSAppStoreEmbeddedProfile({ bundlePath, profileBytes } = {}) {
  const bytes = requireProfileBytes(profileBytes);
  const profilePath = path.join(bundlePath, MACOS_MAS_EMBEDDED_PROFILE_PATH);
  const existing = await lstat(profilePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw masEvidenceError("embedded development provisioning profile path is a symlink", "remove the indirection and stage the exact selected profile bytes at Contents/embedded.provisionprofile");
  }
  await writeFile(profilePath, bytes, { mode: MACOS_MAS_EMBEDDED_PROFILE_MODE });
  await chmod(profilePath, MACOS_MAS_EMBEDDED_PROFILE_MODE);
  const embeddedProfile = createEmbeddedProfileBinding(bytes);
  await verifyEmbeddedProfileOnDisk({ bundlePath, embeddedProfile, profileBytes: bytes });
  return embeddedProfile;
}

/**
 * Keep the retained direct manifest's public binding small while carrying the
 * exact parsed inputs privately into the post-relocation MAS evidence owner.
 */
export function createMacOSAppStoreDirectCompositionSource({ binding, manifest } = {}) {
  validateMacAppStoreDirectCompositionBinding(binding);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      !manifest.candidateSnapshot || typeof manifest.candidateSnapshot !== "object" ||
      !manifest.packageInputs || typeof manifest.packageInputs !== "object" ||
      manifest.artifactDigest !== binding.artifactDigest) {
    throw masEvidenceError("retained direct-composition source fields are missing or cross-bound incorrectly", "carry the parsed direct candidateSnapshot and packageInputs privately from the same retained manifest");
  }
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    candidateSnapshot: manifest.candidateSnapshot,
    packageInputs: manifest.packageInputs,
  });
}

/**
 * Build the MAS package-input and license evidence after the Electron app has
 * been moved. This is the only owner that derives the MAS evidence; callers
 * retain direct composition only as immutable source provenance.
 */
export async function prepareMacOSAppStorePackageEvidence({
  bundlePath,
  repositoryRoot,
  candidateSnapshot,
  priorManifest = null,
  mediaSources = null,
  electronArchiveSource = null,
  embeddedProfile = null,
  profileBytes = null,
  expectedElectronArchiveSha256 = MACOS_APP_STORE_CONTRACT.electron.sha256,
} = {}) {
  const expectedArchiveSha256 = normalizeExpectedElectronArchiveSha256(expectedElectronArchiveSha256);
  const normalizedCandidateSnapshot = normalizeCandidateSnapshot(candidateSnapshot);
  const selectedProfileBytes = requireProfileBytes(profileBytes);
  const validatedEmbeddedProfile = await verifyEmbeddedProfileOnDisk({
    bundlePath,
    embeddedProfile,
    profileBytes: selectedProfileBytes,
  });
  const packageInputCollection = await collectMacOSPackageInputs({
    repositoryRoot,
    bundlePath,
    candidateSnapshot: normalizedCandidateSnapshot,
    priorManifest,
    mediaSources,
    electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
    electronArchiveSource,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  const inventory = await writeMacOSLicenseInventory({
    bundlePath,
    repositoryRoot,
    candidateSnapshot: normalizedCandidateSnapshot,
    packageInputManifest: packageInputCollection.manifest,
    packageMetadata: packageInputCollection.packageMetadata,
    mediaSources,
    manifestPath: MACOS_MAS_LICENSE_INVENTORY_MANIFEST_PATH,
    masLayout: macOSMasLicenseLayout(),
    electronArchiveSource: packageInputCollection.manifest.electronArchiveSource,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });

  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries, { ownerMode: true });
  assertMasBundleLayout(entries, "prepared MAS package");
  const inventoryBinding = createLicenseInventoryBinding(entries, inventory);
  const evidence = {
    schema: MACOS_APP_STORE_PACKAGE_EVIDENCE_SCHEMA,
    authority: MACOS_APP_STORE_PACKAGE_EVIDENCE_AUTHORITY,
    layout: MACOS_APP_STORE_PACKAGE_EVIDENCE_LAYOUT,
    electronAppPath: "Contents/Helpers/Electron.app",
    electronBinaryPath: MACOS_APP_STORE_ELECTRON_BINARY_PATH,
    electronArchiveSource: packageInputCollection.manifest.electronArchiveSource,
    embeddedProfile: validatedEmbeddedProfile,
    signingBoundary: packageInputCollection.manifest.artifactInput.signingBoundary,
    packageInputs: packageInputCollection.manifest,
    licenseInventory: inventoryBinding,
  };
  validateMasPackageEvidenceInputs(evidence, {
    entries,
    machoEntries,
    inventory,
    embeddedProfile: validatedEmbeddedProfile,
    profileBytes: selectedProfileBytes,
    validateInventory: false,
    masSigningPhase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  await verifyMacOSAppStorePackageEvidenceSources({
    evidence,
    repositoryRoot,
    bundlePath,
    candidateSnapshot: normalizedCandidateSnapshot,
    masSigningPhase: MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  return evidence;
}

/**
 * Bind the prepared evidence to the signed, post-relocation bundle. The
 * package-input source check remains mandatory for every caller.
 */
export async function finalizeMacOSAppStorePackageEvidence({
  bundlePath,
  repositoryRoot,
  candidateSnapshot,
  preparedEvidence,
  signature,
  entries = null,
  machoEntries = null,
  embeddedProfile = null,
  profileBytes = null,
  expectedElectronArchiveSha256 = MACOS_APP_STORE_CONTRACT.electron.sha256,
} = {}) {
  const expectedArchiveSha256 = normalizeExpectedElectronArchiveSha256(expectedElectronArchiveSha256);
  const selectedProfileBytes = requireProfileBytes(profileBytes);
  const actualEntries = entries ?? await enumeratePackageEntries(bundlePath);
  const actualMachOEntries = machoEntries ?? await inspectPackageMachOEntries(bundlePath, actualEntries, { ownerMode: true });
  assertMasBundleLayout(actualEntries, "final MAS package");
  if (!preparedEvidence || typeof preparedEvidence !== "object") {
    throw masEvidenceError("prepared MAS package evidence is missing", "prepare the Helpers-scoped package evidence before signing");
  }
  const validatedEmbeddedProfile = await verifyEmbeddedProfileOnDisk({
    bundlePath,
    embeddedProfile: embeddedProfile ?? preparedEvidence.embeddedProfile,
    profileBytes: selectedProfileBytes,
  });
  const electronArchiveSource = validateMacOSPackageElectronArchiveSource(preparedEvidence.electronArchiveSource, expectedArchiveSha256);
  const inventoryPath = path.join(bundlePath, MACOS_LICENSE_INVENTORY_PATH);
  const inventoryBytes = await readFile(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  const inventoryBinding = createLicenseInventoryBinding(actualEntries, inventory);
  const evidence = {
    schema: MACOS_APP_STORE_PACKAGE_EVIDENCE_SCHEMA,
    authority: MACOS_APP_STORE_PACKAGE_EVIDENCE_AUTHORITY,
    layout: MACOS_APP_STORE_PACKAGE_EVIDENCE_LAYOUT,
    electronAppPath: "Contents/Helpers/Electron.app",
    electronBinaryPath: MACOS_APP_STORE_ELECTRON_BINARY_PATH,
    electronArchiveSource,
    embeddedProfile: validatedEmbeddedProfile,
    signingBoundary: preparedEvidence.signingBoundary,
    packageInputs: preparedEvidence.packageInputs,
    licenseInventory: inventoryBinding,
    artifact: createArtifactBinding(actualEntries, actualMachOEntries),
    signature: {
      algorithm: "sha256",
      digest: sha256(Buffer.from(JSON.stringify(signature))),
      machoPaths: actualMachOEntries.map((entry) => entry.path),
    },
  };
  validateMasPackageEvidenceInputs(evidence, {
    entries: actualEntries,
    machoEntries: actualMachOEntries,
    inventory,
    inventoryBytes,
    embeddedProfile: validatedEmbeddedProfile,
    profileBytes: selectedProfileBytes,
    bundlePath,
    repositoryRoot,
    candidateSnapshot,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  await verifyMacOSAppStorePackageEvidenceSources({
    evidence,
    repositoryRoot,
    bundlePath,
    candidateSnapshot,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  return evidence;
}

/**
 * Re-read the retained archive and the packaged inventory, then verify the
 * source and final MAS package-input graph through the shared owners. This is
 * used by production, fixtures, and the install gate; callers cannot replace
 * it with a forged digest or fixture-only result.
 */
export async function verifyMacOSAppStorePackageEvidenceSources({
  evidence,
  repositoryRoot,
  bundlePath,
  candidateSnapshot,
  masSigningPhase = MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
  expectedElectronArchiveSha256 = MACOS_APP_STORE_CONTRACT.electron.sha256,
} = {}) {
  const expectedArchiveSha256 = normalizeExpectedElectronArchiveSha256(expectedElectronArchiveSha256);
  await verifyEmbeddedProfileOnDisk({
    bundlePath,
    embeddedProfile: evidence?.embeddedProfile,
  });
  const electronArchiveSource = validateMacOSPackageElectronArchiveSource(evidence?.electronArchiveSource, expectedArchiveSha256);
  const packageInputArchiveSource = validateMacOSPackageElectronArchiveSource(evidence?.packageInputs?.electronArchiveSource, expectedArchiveSha256);
  if (JSON.stringify(electronArchiveSource) !== JSON.stringify(packageInputArchiveSource)) {
    throw masEvidenceError("MAS package evidence archive source is not cross-bound to package inputs", "carry one verified archive descriptor through the final Helpers evidence owner");
  }
  await verifyMacOSPackageInputs({
    manifest: evidence.packageInputs,
    repositoryRoot,
    bundlePath,
    candidateSnapshot: normalizeCandidateSnapshot(candidateSnapshot),
    electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
    electronArchiveSource,
    masSigningPhase,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  const inventoryPath = path.join(bundlePath, MACOS_LICENSE_INVENTORY_PATH);
  const inventoryBytes = await readFile(inventoryPath);
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString("utf8"));
  } catch (error) {
    throw masEvidenceError(`packaged MAS license inventory is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "regenerate the inventory through the shared MAS evidence owner");
  }
  validateMasLicenseInventoryPackageInputBinding(inventory, evidence.packageInputs);
  validateLicenseInventoryDocument(inventory, {
    repositoryRoot,
    route: "mas",
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  if (JSON.stringify(inventory.artifact.electronArchiveSource) !== JSON.stringify(electronArchiveSource) ||
      JSON.stringify(inventory.artifact.masLayout) !== JSON.stringify(macOSMasLicenseLayout())) {
    throw masEvidenceError("MAS license inventory source or Helpers layout is not cross-bound to final evidence", "regenerate the route-aware MAS inventory from the verified archive and final bundle");
  }
  await validateNoticeEvidence(inventory, bundlePath, repositoryRoot);
  await validateResolutionEvidencePaths(inventory, repositoryRoot);
  return { evidence, inventory, inventoryBytes, electronArchiveSource };
}

function normalizeCandidateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  if (snapshot.dependencyArtifacts?.paseo?.expectedCommit || typeof snapshot.paseoCommit !== "string") return snapshot;
  return {
    ...snapshot,
    dependencyArtifacts: {
      ...(snapshot.dependencyArtifacts ?? {}),
      paseo: {
        ...(snapshot.dependencyArtifacts?.paseo ?? {}),
        expectedCommit: snapshot.paseoCommit,
      },
    },
  };
}

/**
 * Validate final MAS evidence against actual package observations. The MAS
 * gate uses this same owner after reading the immutable manifest and bundle.
 */
export function validateMasPackageEvidenceInputs(
  evidence,
  {
    entries,
    machoEntries,
    inventory,
    inventoryBytes = null,
    bundlePath = null,
    repositoryRoot = null,
    candidateSnapshot = null,
    embeddedProfile = null,
    profileBytes = null,
    validateInventory = true,
    masSigningPhase = MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL,
    expectedElectronArchiveSha256 = MACOS_APP_STORE_CONTRACT.electron.sha256,
  } = {},
) {
  const expectedArchiveSha256 = normalizeExpectedElectronArchiveSha256(expectedElectronArchiveSha256);
  if (!evidence || evidence.schema !== MACOS_APP_STORE_PACKAGE_EVIDENCE_SCHEMA ||
      evidence.authority !== MACOS_APP_STORE_PACKAGE_EVIDENCE_AUTHORITY ||
      evidence.layout !== MACOS_APP_STORE_PACKAGE_EVIDENCE_LAYOUT ||
      evidence.electronAppPath !== "Contents/Helpers/Electron.app" ||
      evidence.electronBinaryPath !== MACOS_APP_STORE_ELECTRON_BINARY_PATH) {
    throw masEvidenceError("final MAS evidence schema or exact Helpers layout is invalid", "regenerate MAS evidence from the post-relocation bundle");
  }
  if (!Array.isArray(entries) || !Array.isArray(machoEntries) || !inventory || typeof inventory !== "object") {
    throw masEvidenceError("final MAS evidence lacks the actual package entry, Mach-O, or license observations", "inspect the final signed bundle before writing the MAS manifest");
  }
  assertMasBundleLayout(entries, "final MAS package");
  const expectedEmbeddedProfile = validateEmbeddedProfileBinding(evidence.embeddedProfile);
  if (embeddedProfile && JSON.stringify(validateEmbeddedProfileBinding(embeddedProfile)) !== JSON.stringify(expectedEmbeddedProfile)) {
    throw masEvidenceError("MAS embedded-profile evidence is not cross-bound to the evidence document", "carry the exact staged profile descriptor through prepare and finalize");
  }
  const profileEntry = entries.find((entry) => entry.path === MACOS_MAS_EMBEDDED_PROFILE_PATH);
  if (!profileEntry || profileEntry.type !== "file" || profileEntry.sha256 !== expectedEmbeddedProfile.sha256 ||
      profileEntry.size !== expectedEmbeddedProfile.size) {
    throw masEvidenceError("MAS package embedded profile entry is absent or differs from its evidence", "retain the exact selected profile bytes before collecting pre-sign evidence");
  }
  if (profileBytes !== null) {
    const selectedProfileBytes = requireProfileBytes(profileBytes);
    if (sha256(selectedProfileBytes) !== expectedEmbeddedProfile.sha256 ||
        selectedProfileBytes.byteLength !== expectedEmbeddedProfile.size) {
      throw masEvidenceError("MAS embedded profile bytes differ from the staged profile evidence", "reject a substituted or mutated provisioning profile before signing");
    }
  }
  const electronArchiveSource = validateMacOSPackageElectronArchiveSource(evidence.electronArchiveSource, expectedArchiveSha256);
  const rawElectronInput = evidence.packageInputs?.inputs?.find((input) => input?.id === "electron-runtime-input");
  if (rawElectronInput?.artifactPathPrefixes?.some((prefix) => prefix === MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX || prefix.startsWith(MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX))) {
    throw masEvidenceError("final MAS package-input evidence uses the direct Electron prefix", "rebuild package inputs with electronLayout=mas and bind Contents/Helpers/Electron.app/");
  }
  validateMacOSPackageInputDocument(evidence.packageInputs, candidateSnapshot, {
    electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS,
    electronArchiveSource,
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  validateMasLicenseInventoryPackageInputBinding(inventory, evidence.packageInputs);
  const electronInput = evidence.packageInputs.inputs.find((input) => input.id === "electron-runtime-input");
  if (!electronInput || electronInput.artifactPathPrefixes.some((prefix) => prefix === MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX || prefix.startsWith(MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX)) ||
      !electronInput.artifactPathPrefixes.includes(MACOS_MAS_ELECTRON_APP_PATH_PREFIX)) {
    throw masEvidenceError("final MAS package-input evidence uses the direct Electron prefix", "rebuild package inputs with electronLayout=mas and bind Contents/Helpers/Electron.app/");
  }
  const machoPaths = machoEntries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  const expectedBoundary = createMacOSMasSigningBoundDescriptor({
    entries,
    machoPaths,
    licenseInventoryPath: MACOS_LICENSE_INVENTORY_PATH,
    phase: masSigningPhase,
  });
  let suppliedBoundary;
  try {
    suppliedBoundary = validateMacOSMasSigningBoundDescriptor(evidence.signingBoundary, {
      expectedMachoPaths: machoPaths,
      expectedLicenseInventoryPath: MACOS_LICENSE_INVENTORY_PATH,
    });
  } catch (error) {
    throw masEvidenceError(
      "MAS signing-boundary evidence is missing or invalid: " +
      (error instanceof Error ? error.message : String(error)),
      "retain one exact descriptor for the complete Mach-O and CodeResources closure",
    );
  }
  if (JSON.stringify(suppliedBoundary) !== JSON.stringify(expectedBoundary) ||
      JSON.stringify(evidence.packageInputs.artifactInput.signingBoundary) !== JSON.stringify(expectedBoundary) ||
      JSON.stringify(inventory.artifact?.entryBinding?.signingBoundary) !== JSON.stringify(expectedBoundary)) {
    throw masEvidenceError("MAS signing-boundary descriptor is not shared across package, inventory, and final evidence", "derive all MAS ordinary exclusions from one exact descriptor");
  }
  const expectedExcludedPaths = expectedBoundary.excludedPaths;
  if (JSON.stringify(evidence.packageInputs.artifactInput.excludedPaths) !== JSON.stringify(expectedExcludedPaths)) {
    throw masEvidenceError("final MAS package-input exclusions do not match the actual Mach-O closure", "regenerate package inputs after the Helpers relocation");
  }
  const expectedArtifactInputDigest = digestArtifactEntries(entries, {
    excludedPaths: expectedExcludedPaths,
    signingBoundary: expectedBoundary,
    expectedMachoPaths: machoPaths,
  });
  if (evidence.packageInputs.artifactInput.digest !== expectedArtifactInputDigest) {
    throw masEvidenceError("final MAS package-input artifact digest differs from the signed bundle", "rebuild package-input evidence from the final Helpers bundle");
  }
  if (evidence.packageInputs.artifactInput.entryCount !== selectArtifactEntriesForDigest(entries, {
    excludedPaths: expectedExcludedPaths,
    signingBoundary: expectedBoundary,
    expectedMachoPaths: machoPaths,
  }).length) {
    throw masEvidenceError("final MAS package-input entry count is stale", "recompute artifactInput.entryCount from the final bundle");
  }
  if (JSON.stringify(inventory.artifact?.masLayout) !== JSON.stringify(macOSMasLicenseLayout()) ||
      JSON.stringify(inventory.artifact?.electronArchiveSource) !== JSON.stringify(electronArchiveSource)) {
    throw masEvidenceError("final MAS license inventory is stale direct-layout evidence", "regenerate the inventory after relocating Electron to Contents/Helpers");
  }
  if (validateInventory) validateLicenseInventoryDocument(inventory, {
    repositoryRoot,
    route: "mas",
    expectedElectronArchiveSha256: expectedArchiveSha256,
  });
  if (inventoryBytes && sha256(inventoryBytes) !== evidence.licenseInventory.sha256) {
    throw masEvidenceError("final MAS license inventory bytes differ from its evidence binding", "regenerate the MAS evidence after writing the inventory");
  }
  if (bundlePath && inventory.artifact.bundlePath !== "Meetless.app") {
    throw masEvidenceError("final MAS license inventory does not name the packaged bundle", "bind the inventory to Meetless.app");
  }
  if (validateInventory) {
    validateLicenseInventoryCoverage(
      inventory,
      entries,
      evidence.licenseInventory,
      machoPaths,
      {
        repositoryRoot,
        bundlePath,
        route: "mas",
        masSigningPhase,
        expectedElectronArchiveSha256: expectedArchiveSha256,
      },
    );
  }
  if (evidence.artifact) {
    const actualArtifact = createArtifactBinding(entries, machoEntries);
    if (JSON.stringify(evidence.artifact) !== JSON.stringify(actualArtifact)) {
      throw masEvidenceError("final MAS artifact-entry evidence differs from the signed bundle", "regenerate the MAS evidence from the exact final entry and Mach-O sets");
    }
  }
  if (evidence.signature) {
    const actualSignaturePaths = machoEntries.map((entry) => entry.path);
    if (!/^[a-f0-9]{64}$/u.test(evidence.signature.digest ?? "") ||
        JSON.stringify(evidence.signature.machoPaths) !== JSON.stringify(actualSignaturePaths)) {
      throw masEvidenceError("final MAS Mach-O/signature path set differs from the signed bundle", "regenerate signature evidence from every final Mach-O");
    }
  }
  return evidence;
}

function assertMasBundleLayout(entries, label) {
  const legacyPrefix = `${MACOS_APP_STORE_LEGACY_ELECTRON_APP_PATH}/`;
  if (entries.some((entry) => entry.path === MACOS_APP_STORE_LEGACY_ELECTRON_APP_PATH || entry.path.startsWith(legacyPrefix) || entry.path.startsWith(MACOS_DIRECT_ELECTRON_APP_PATH_PREFIX))) {
    throw masEvidenceError(`${label} contains the legacy Resources Electron layout`, "remove Contents/Resources/meetless/runtime/electron/Electron.app and retain only Contents/Helpers/Electron.app");
  }
  if (!entries.some((entry) => entry.path === MACOS_APP_STORE_ELECTRON_BINARY_PATH)) {
    throw masEvidenceError(`${label} is missing ${MACOS_APP_STORE_ELECTRON_BINARY_PATH}`, "relocate and validate the MAS Electron app before signing");
  }
}

function createLicenseInventoryBinding(entries, inventory) {
  const inventoryEntry = entries.find((entry) => entry.path === MACOS_LICENSE_INVENTORY_PATH && entry.type === "file");
  if (!inventoryEntry) throw masEvidenceError(`final MAS package is missing ${MACOS_LICENSE_INVENTORY_PATH}`, "write the license inventory before signing");
  return {
    schema: inventory.schema,
    path: MACOS_LICENSE_INVENTORY_PATH,
    sha256: inventoryEntry.sha256,
    artifactEntryDigest: inventory.artifact.entryBinding.digest,
    excludedPathPrefixes: inventory.artifact.entryBinding.excludedPathPrefixes,
    excludedPaths: inventory.artifact.entryBinding.excludedPaths,
    ...(inventory.artifact.entryBinding.signingBoundary
      ? { signingBoundary: inventory.artifact.entryBinding.signingBoundary }
      : {}),
    componentCount: inventory.components.length,
    packageInputDigest: inventory.artifact.packageInputBinding.digest,
    packageInputArtifactDigest: inventory.artifact.packageInputBinding.artifactInputDigest,
  };
}

function createArtifactBinding(entries, machoEntries) {
  const machoPaths = machoEntries.map((entry) => entry.path);
  const codeResources = entries
    .filter((entry) => isMacOSCodeResourcesPath(entry.path))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    algorithm: "sha256",
    entryDigest: sha256(Buffer.from(JSON.stringify(entries))),
    entryCount: entries.length,
    machoEntryCount: machoEntries.length,
    machoPaths,
    machoPathDigest: sha256(Buffer.from(JSON.stringify(machoPaths))),
    codeResources,
  };
}

function masEvidenceError(reason, nextAction) {
  return new Error(`${reason}. Authority: ${MACOS_APP_STORE_PACKAGE_EVIDENCE_AUTHORITY}. Next action: ${nextAction}.`);
}

function requireProfileBytes(profileBytes) {
  if (!Buffer.isBuffer(profileBytes) || profileBytes.byteLength === 0) {
    throw masEvidenceError("selected MAS provisioning-profile bytes are missing", "pass the immutable selected-profile snapshot bytes before deriving package evidence");
  }
  return profileBytes;
}

function createEmbeddedProfileBinding(profileBytes) {
  const bytes = requireProfileBytes(profileBytes);
  return validateEmbeddedProfileBinding({
    schema: MACOS_MAS_EMBEDDED_PROFILE_SCHEMA,
    path: MACOS_MAS_EMBEDDED_PROFILE_PATH,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  });
}

function validateEmbeddedProfileBinding(binding) {
  const expectedKeys = ["path", "schema", "sha256", "size"].sort();
  const actualKeys = binding && typeof binding === "object" && !Array.isArray(binding)
    ? Object.keys(binding).sort()
    : [];
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
      binding.schema !== MACOS_MAS_EMBEDDED_PROFILE_SCHEMA ||
      binding.path !== MACOS_MAS_EMBEDDED_PROFILE_PATH ||
      !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "") ||
      !Number.isSafeInteger(binding.size) || binding.size < 1) {
    throw masEvidenceError("MAS embedded-profile descriptor is missing or malformed", "bind Contents/embedded.provisionprofile to one immutable SHA-256 and byte length");
  }
  return binding;
}

async function verifyEmbeddedProfileOnDisk({ bundlePath, embeddedProfile, profileBytes = null } = {}) {
  const descriptor = validateEmbeddedProfileBinding(embeddedProfile);
  const profilePath = path.join(bundlePath, MACOS_MAS_EMBEDDED_PROFILE_PATH);
  const state = await lstat(profilePath).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== MACOS_MAS_EMBEDDED_PROFILE_MODE) {
    throw masEvidenceError("MAS embedded provisioning profile is absent or not a private regular file", "stage the exact selected profile at Contents/embedded.provisionprofile with mode 0400");
  }
  const actual = await readFile(profilePath);
  if (actual.byteLength !== descriptor.size || sha256(actual) !== descriptor.sha256) {
    throw masEvidenceError("MAS embedded provisioning profile bytes differ from its descriptor", "reject a mutated or substituted profile before signing or final acceptance");
  }
  if (profileBytes !== null) {
    const selected = requireProfileBytes(profileBytes);
    if (selected.byteLength !== descriptor.size || sha256(selected) !== descriptor.sha256 || !actual.equals(selected)) {
      throw masEvidenceError("MAS embedded provisioning profile bytes differ from the immutable selected snapshot", "reject a substituted or mutated profile before signing");
    }
  }
  return descriptor;
}

function normalizeExpectedElectronArchiveSha256(expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw masEvidenceError(
      `expected MAS Electron archive SHA-256 is malformed: ${String(expectedSha256)}`,
      "supply the accepted contract pin or one explicit test digest outside manifest and evidence data",
    );
  }
  return expectedSha256;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
