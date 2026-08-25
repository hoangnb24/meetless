import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  enumeratePackageEntries,
  inspectMachO,
  inspectPackageMachOEntries,
} from "./lib/macos-package-inventory.mjs";
import {
  PACKAGE_SOURCE_EXCLUDED_PATHS,
  PACKAGE_SOURCE_MODE,
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
} from "./candidate-snapshot.mjs";
import {
  MACOS_LICENSE_INVENTORY_AUTHORITY,
  MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES,
  MACOS_LICENSE_INVENTORY_MANIFEST_PATH,
  MACOS_LICENSE_INVENTORY_PATH,
  MACOS_LICENSE_INVENTORY_SCHEMA,
  REQUIRED_LICENSE_COMPONENTS,
  classifyArtifactPath,
  digestArtifactEntries,
  digestComponentEntries,
  isNpmPackageManifestPath,
  isWorkspacePackageManifestPath,
} from "./lib/macos-license-inventory.mjs";
import { digestJson } from "./lib/macos-package-inputs.mjs";
import {
  MACOS_PACKAGE_INPUT_SCHEMA,
  validateMacOSPackageInputDocument,
  verifyMacOSPackageInputs,
} from "./lib/macos-package-inputs.mjs";
import {
  MACOS_PACKAGE_SCHEMA,
  MACOS_PACKAGE_RENDERER_ORIGIN,
  acceptedMacOSPackagePaths,
} from "./lib/macos-package-contract.mjs";
import {
  collectMacOSSignatureEvidence,
  LOCAL_AD_HOC_SIGNING_MODE,
  parseSigningArguments,
  resolveSigningInputs,
  validateSigningMetadata,
  validateSigningDocument,
} from "./lib/macos-package-signing.mjs";

const execFileAsync = promisify(execFile);
const FORBIDDEN_LOAD_PATHS = ["/opt/homebrew", "/usr/local"];
const CANDIDATE_SNAPSHOT_COMMAND = PACKAGE_SOURCE_SNAPSHOT_COMMAND;
const PINNED_PASEO_COMMIT = "c81cb84735043c281a5a2d23d456d3708ce5d94e";

export { MACOS_PACKAGE_SCHEMA };

export function validateManifestDocument(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest is not an object", "write the machine-readable M7 package manifest");
  }
  if (manifest.schema !== MACOS_PACKAGE_SCHEMA) {
    fail(`manifest schema is ${String(manifest.schema)}`, `use ${MACOS_PACKAGE_SCHEMA}`);
  }
  if (manifest.target !== "macos-arm64") {
    fail(`manifest target is ${String(manifest.target)}`, "build only the accepted macOS arm64 package");
  }
  if (manifest.bundlePath !== "Meetless.app") {
    fail(`bundle path is ${String(manifest.bundlePath)}`, "compose the sole Meetless.app bundle");
  }
  if (manifest.host?.bundleIdentifier !== "com.meetless.app") {
    fail("host bundle identity is not com.meetless.app", "preserve the sole Meetless TCC owner");
  }
  if (manifest.host?.canonicalPath !== acceptedMacOSPackagePaths().canonicalBundlePath) {
    fail("manifest canonical host path is not ~/Applications/Meetless.app", "bind the package to the accepted host location");
  }
  if (
    !manifest.candidateSnapshot ||
    manifest.candidateSnapshot.command !== CANDIDATE_SNAPSHOT_COMMAND ||
    manifest.candidateSnapshot.mode !== PACKAGE_SOURCE_MODE ||
    JSON.stringify(manifest.candidateSnapshot.excludedPaths ?? []) !== JSON.stringify([...PACKAGE_SOURCE_EXCLUDED_PATHS]) ||
    !/^[a-f0-9]{64}$/u.test(manifest.candidateSnapshot.digest ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.candidateSnapshot.head ?? "") ||
    manifest.candidateSnapshot.paseoCommit !== PINNED_PASEO_COMMIT
  ) {
    fail("manifest candidate snapshot binding is missing or invalid", "rebuild from node scripts/candidate-snapshot.mjs");
  }
  try {
    validateMacOSPackageInputDocument(manifest.packageInputs, manifest.candidateSnapshot);
  } catch (error) {
    fail(`manifest package-input binding is invalid: ${error instanceof Error ? error.message : String(error)}`, "rebuild the package-input manifest from the current source and generated build inputs");
  }
  if (
    !manifest.renderer ||
    typeof manifest.renderer.entry !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.renderer.sha256 ?? "") ||
    !Number.isInteger(manifest.renderer.size) ||
    manifest.renderer.size < 0
  ) {
    fail("manifest renderer binding is missing or invalid", "bind the emitted renderer entry hash");
  }
  validateLicenseInventoryBinding(manifest.licenseInventory);
  assertPackageRelativePath(manifest.packageRoot, "package root");
  assertPackageRelativePath(manifest.packageMarker, "packaged runtime marker");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("manifest has no hashed package entries", "hash every packaged file or symlink");
  }
  const paths = new Set();
  for (const entry of manifest.entries) validateEntryDocument(entry, paths);
  const expectedDigest = digestManifest({ ...manifest, artifactDigest: undefined });
  if (manifest.artifactDigest !== expectedDigest) {
    fail("manifest artifact digest does not match its entries", "regenerate the manifest after composition and signing");
  }
  for (const required of manifest.requiredFiles ?? []) assertPackageRelativePath(required, "required file");
  if (!Array.isArray(manifest.macho)) {
    fail("manifest Mach-O inventory is missing", "inventory every regular Mach-O file in the artifact");
  }
  for (const binary of manifest.macho) assertPackageRelativePath(binary, "Mach-O entry");
  try {
    validateSigningDocument(manifest.signing, manifest.macho);
  } catch (error) {
    fail(`manifest signing contract is invalid: ${error instanceof Error ? error.message : String(error)}`, "assemble the package with an explicit local or release signing contract");
  }
  return manifest;
}

function validateEntryDocument(entry, paths) {
  if (!entry || typeof entry !== "object") {
    fail("manifest contains a malformed entry", "regenerate the package manifest");
  }
  assertPackageRelativePath(entry.path, "manifest entry");
  if (paths.has(entry.path)) {
    fail(`manifest contains duplicate entry ${entry.path}`, "regenerate sorted unique package entries");
  }
  paths.add(entry.path);
  if (entry.type !== "file" && entry.type !== "symlink") {
    fail(`manifest entry ${entry.path} has type ${String(entry.type)}`, "record file or symlink entries only");
  }
  if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    fail(`manifest entry ${entry.path} has no SHA-256`, "record a SHA-256 for each entry");
  }
  if (entry.type === "file" && (!Number.isInteger(entry.size) || entry.size < 0)) {
    fail(`manifest entry ${entry.path} has an invalid size`, "record the emitted file byte length");
  }
  if (entry.type === "symlink") {
    if (typeof entry.target !== "string") {
      fail(`manifest symlink ${entry.path} has no target`, "record an in-package symlink target");
    }
    if (sha256(Buffer.from(entry.target)) !== entry.sha256) {
      fail(`manifest symlink ${entry.path} has an invalid SHA-256`, "hash the recorded symlink target");
    }
  }
}

export function digestManifest(manifestWithoutDigest) {
  return createHash("sha256").update(JSON.stringify(manifestWithoutDigest)).digest("hex");
}

export function validateLicenseInventoryDocument(inventory, options = {}) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    failLicense("license inventory is not an object", "generate the machine-readable inventory from the actual artifact");
  }
  if (inventory.schema !== MACOS_LICENSE_INVENTORY_SCHEMA) {
    failLicense(`license inventory schema is ${String(inventory.schema)}`, `use ${MACOS_LICENSE_INVENTORY_SCHEMA}`);
  }
  if (inventory.authority !== MACOS_LICENSE_INVENTORY_AUTHORITY) {
    failLicense("license inventory authority is missing or changed", `cite ${MACOS_LICENSE_INVENTORY_AUTHORITY}`);
  }
  if (inventory.target !== "macos-arm64") {
    failLicense(`license inventory target is ${String(inventory.target)}`, "inventory only the accepted macOS arm64 artifact");
  }
  const artifact = inventory.artifact;
  if (!artifact || artifact.bundlePath !== "Meetless.app" || artifact.manifestPath !== MACOS_LICENSE_INVENTORY_MANIFEST_PATH || artifact.inventoryPath !== MACOS_LICENSE_INVENTORY_PATH) {
    failLicense("license inventory artifact binding is missing or invalid", "bind the inventory to release/macos/composition-manifest.json and its packaged path");
  }
  if (
    !artifact.candidateSnapshot ||
    artifact.candidateSnapshot.command !== CANDIDATE_SNAPSHOT_COMMAND ||
    artifact.candidateSnapshot.mode !== PACKAGE_SOURCE_MODE ||
    JSON.stringify(artifact.candidateSnapshot.excludedPaths ?? []) !== JSON.stringify([...PACKAGE_SOURCE_EXCLUDED_PATHS]) ||
    !/^[a-f0-9]{64}$/u.test(artifact.candidateSnapshot.digest ?? "") ||
    !/^[a-f0-9]{40}$/u.test(artifact.candidateSnapshot.head ?? "") ||
    !/^[a-f0-9]{40}$/u.test(artifact.candidateSnapshot.paseoCommit ?? "")
  ) {
    failLicense("license inventory candidate snapshot binding is missing or invalid", "regenerate the inventory from node scripts/candidate-snapshot.mjs");
  }
  if (!artifact.entryBinding || artifact.entryBinding.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(artifact.entryBinding.digest ?? "")) {
    failLicense("license inventory artifact entry binding is missing or invalid", "regenerate the inventory from the complete artifact entry set");
  }
  if (!artifact.packageInputBinding || artifact.packageInputBinding.schema !== MACOS_PACKAGE_INPUT_SCHEMA || !/^[a-f0-9]{64}$/u.test(artifact.packageInputBinding.digest ?? "") || !/^[a-f0-9]{64}$/u.test(artifact.packageInputBinding.sourceSnapshotDigest ?? "") || artifact.packageInputBinding.sourceSnapshotDigest !== artifact.candidateSnapshot.digest || !/^[a-f0-9]{64}$/u.test(artifact.packageInputBinding.artifactInputDigest ?? "") || artifact.packageInputBinding.artifactInputDigest !== artifact.entryBinding.digest || !/^[a-f0-9]{64}$/u.test(artifact.packageInputBinding.packageMemberDigest ?? "") || !/^[a-f0-9]{64}$/u.test(artifact.packageInputBinding.workspaceMemberDigest ?? "") || !Number.isInteger(artifact.packageInputBinding.inputCount) || !Number.isInteger(artifact.packageInputBinding.packageMemberCount) || !Number.isInteger(artifact.packageInputBinding.workspaceMemberCount) || !Number.isInteger(artifact.packageInputBinding.lockMetadataGapCount)) {
    failLicense("license inventory package-input binding is missing or invalid", "bind the inventory to the source snapshot, package-input digest, and final artifact input digest");
  }
  if (JSON.stringify(artifact.entryBinding.excludedPathPrefixes ?? []) !== JSON.stringify(MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES) || !Array.isArray(artifact.entryBinding.excludedPaths) || !artifact.entryBinding.excludedPaths.includes(MACOS_LICENSE_INVENTORY_PATH) || artifact.entryBinding.excludedPaths.some((candidate) => typeof candidate !== "string")) {
    failLicense("license inventory self-binding exclusions are not the accepted signing boundary", "exclude the inventory, signing metadata, and the observed Mach-O code-signature paths only");
  }
  if (!Array.isArray(inventory.components)) {
    failLicense("license inventory components are missing", "record each required release component");
  }
  if (!inventory.summary || !Number.isInteger(inventory.summary.artifactEntryCount) || !Number.isInteger(inventory.summary.componentCount) || !inventory.summary.componentPathCounts || !Number.isInteger(inventory.summary.packageMemberCount) || !/^[a-f0-9]{64}$/u.test(inventory.summary.packageMemberDigest ?? "") || !Number.isInteger(inventory.summary.workspaceMemberCount) || !/^[a-f0-9]{64}$/u.test(inventory.summary.workspaceMemberDigest ?? "") || !Number.isInteger(inventory.summary.lockMetadataGapCount) || inventory.summary.historicalAuthorityLockMetadataGapCount !== 28 || typeof inventory.summary.countRule !== "string") {
    failLicense("license inventory derived summary is missing or ambiguous", "derive current artifact, member, and lock-gap counts from the final inventory and label the historical authority count");
  }
  const components = new Map();
  for (const component of inventory.components) {
    validateLicenseComponent(component, options);
    if (components.has(component.id)) failLicense(`license inventory duplicates component ${component.id}`, "record each component exactly once");
    components.set(component.id, component);
  }
  for (const required of REQUIRED_LICENSE_COMPONENTS) {
    if (!components.has(required)) failLicense(`license inventory is missing component ${required}`, "include every discovery category in the component inventory");
  }
  if (components.has("unresolved") && components.get("unresolved").ownerDecision.status === "resolved") {
    failLicense("unresolved artifact component is marked resolved", "record the unresolved owner decision instead of approving unknown data");
  }
  validateOverlapRules(inventory.overlapRules, components);
  return inventory;
}

export function validateLicenseInventoryCoverage(inventory, manifestEntries, manifestBinding = null, manifestMacho = [], options = {}) {
  validateLicenseInventoryDocument(inventory, options);
  const actualPaths = new Set(manifestEntries.map((entry) => entry.path));
  const mappedPaths = new Map();
  for (const component of inventory.components) {
    for (const relativePath of component.artifactPathScope.paths) {
      if (mappedPaths.has(relativePath)) {
        failLicense(`artifact path ${relativePath} maps to both ${mappedPaths.get(relativePath)} and ${component.id}`, "assign each artifact path to exactly one component or add an accepted overlap rule");
      }
      mappedPaths.set(relativePath, component.id);
    }
  }
  const missing = [...actualPaths].filter((relativePath) => !mappedPaths.has(relativePath));
  if (missing.length) {
    failLicense(`artifact path ${missing[0]} has no component/provenance mapping`, "regenerate the inventory from the complete artifact closure");
  }
  const extra = [...mappedPaths.keys()].filter((relativePath) => !actualPaths.has(relativePath));
  if (extra.length) {
    failLicense(`inventory maps path ${extra[0]} that is not present in the artifact`, "remove stale inventory paths and regenerate the package");
  }
  const excludedPaths = inventory.artifact.entryBinding.excludedPaths;
  const machoSet = new Set(manifestMacho);
  for (const excludedPath of excludedPaths) {
    if (excludedPath === inventory.artifact.inventoryPath || excludedPath.startsWith("Contents/_CodeSignature/")) continue;
    if (!machoSet.has(excludedPath)) {
      failLicense(`license inventory excludes non-Mach-O path ${excludedPath} from its artifact binding`, "exclude only the final Mach-O paths recorded by the composition manifest");
    }
  }
  for (const machoPath of machoSet) {
    if (!excludedPaths.includes(machoPath)) {
      failLicense(`Mach-O path ${machoPath} is absent from the inventory signing boundary`, "regenerate the inventory after the final Mach-O set is known");
    }
  }
  const expectedDigest = digestArtifactEntries(manifestEntries, { excludedPaths });
  if (inventory.artifact.entryBinding.digest !== expectedDigest) {
    failLicense("license inventory artifact entry binding does not match the composition manifest", "regenerate the inventory and composition manifest from one candidate");
  }
  if (manifestBinding) {
    if (manifestBinding.schema !== inventory.schema || manifestBinding.path !== inventory.artifact.inventoryPath || manifestBinding.artifactEntryDigest !== inventory.artifact.entryBinding.digest || manifestBinding.componentCount !== inventory.components.length || manifestBinding.packageInputDigest !== inventory.artifact.packageInputBinding.digest || manifestBinding.packageInputArtifactDigest !== inventory.artifact.packageInputBinding.artifactInputDigest || JSON.stringify(manifestBinding.excludedPathPrefixes ?? []) !== JSON.stringify(inventory.artifact.entryBinding.excludedPathPrefixes) || JSON.stringify(manifestBinding.excludedPaths ?? []) !== JSON.stringify(excludedPaths)) {
      failLicense("composition manifest license inventory binding does not match the packaged inventory", "regenerate the manifest after writing the inventory");
    }
    const inventoryEntry = manifestEntries.find((entry) => entry.path === inventory.artifact.inventoryPath);
    if (!inventoryEntry || inventoryEntry.type !== "file" || manifestBinding.sha256 !== inventoryEntry.sha256) {
      failLicense("composition manifest does not hash the packaged license inventory", "include the generated inventory file in the manifest entry set");
    }
  }
  for (const component of inventory.components) {
    const expectedComponentHash = digestComponentEntries(manifestEntries, component.artifactPathScope.paths, { excludedPaths });
    if (component.provenance.versionOrHash.artifactScopeSha256 !== expectedComponentHash) {
      failLicense(`component ${component.id} artifact scope hash does not match the manifest`, "regenerate the inventory from the exact artifact closure");
    }
  }
  validateProvenanceMembers(inventory, manifestEntries, manifestMacho);
  validateDerivedInventorySummary(inventory, mappedPaths.size);
  return { mappedPaths: mappedPaths.size, components: inventory.components.length };
}

function validateProvenanceMembers(inventory, manifestEntries, manifestMacho) {
  const actualPaths = new Set(manifestEntries.map((entry) => entry.path));
  const components = new Map(inventory.components.map((component) => [component.id, component]));
  const packageMembers = [];
  const workspaceMembers = [];
  for (const component of inventory.components) {
    validateMemberRecords(component, component.provenance.packageMembers ?? [], "npm-package", packageMembers);
    validateMemberRecords(component, component.provenance.workspaceMembers ?? [], "workspace-package", workspaceMembers);
    validateArtifactMembers(component, component.provenance.artifactMembers ?? [], actualPaths, manifestMacho);
  }

  const expectedPackageJsonPaths = [...actualPaths]
    .filter((candidate) => isNpmPackageManifestPath(candidate))
    .sort();
  const packageJsonMembers = new Map(packageMembers.map((member) => [member.packageJsonPath, member]));
  for (const packageJsonPath of expectedPackageJsonPaths) {
    if (!packageJsonMembers.has(packageJsonPath)) {
      failLicense(`package member ${packageJsonPath} has no provenance record`, "record every shipped npm package member with lock v3 evidence or an explicit unresolved lock state");
    }
  }
  for (const member of packageMembers) {
    const expected = classifyArtifactPath(member.packageJsonPath, { type: "file" }, new Set(manifestMacho));
    if (expected !== member.component || !components.has(member.component)) {
      failLicense(`package member ${member.packageJsonPath} is assigned to ${member.component} but packaging classifies it as ${expected}`, "correct the native/package component owner in the inventory");
    }
  }

  const expectedWorkspaceJsonPaths = [...actualPaths]
    .filter((candidate) => isWorkspacePackageManifestPath(candidate))
    .sort();
  const workspaceJsonMembers = new Map(workspaceMembers.map((member) => [member.packageJsonPath, member]));
  for (const packageJsonPath of expectedWorkspaceJsonPaths) {
    if (!workspaceJsonMembers.has(packageJsonPath)) {
      failLicense(`workspace member ${packageJsonPath} has no provenance record`, "record every shipped Meetless/Paseo workspace manifest and its license state");
    }
  }
  for (const member of workspaceMembers) {
    const expected = member.packageJsonPath.startsWith("Contents/Resources/meetless/vendor/paseo/packages/") ? "paseo" : "meetless";
    if (member.component !== expected) {
      failLicense(`workspace member ${member.packageJsonPath} is assigned to ${member.component}`, "keep Paseo and Meetless workspace provenance on their owning component");
    }
    if (!member.declaredLicense && member.declaredLicenseEvidence?.status !== "not-declared") {
      failLicense(`workspace member ${member.packageJsonPath} hides a missing declared license`, "record the missing workspace license as an explicit unresolved record");
    }
  }
}

function validateMemberRecords(component, members, expectedType, allMembers) {
  const identities = new Set();
  for (const member of members) {
    if (!member || member.memberType !== expectedType || member.component !== component.id || typeof member.artifactPath !== "string" || typeof member.packageJsonPath !== "string" || typeof member.name !== "string" || typeof member.version !== "string" || identities.has(member.packageJsonPath)) {
      failLicense(`${component.id} ${expectedType} provenance is malformed or duplicated`, "record each package/workspace child member exactly once");
    }
    identities.add(member.packageJsonPath);
    const expectedPackageJsonPath = `${member.artifactPath}/package.json`;
    const sourceArtifactPath = `Contents/Resources/meetless/${member.sourcePath}`;
    const expectedArtifactPath = sourceArtifactPath.endsWith("/package.json") ? sourceArtifactPath.slice(0, -"/package.json".length) : sourceArtifactPath;
    if (!component.artifactPathScope.paths.includes(member.packageJsonPath) || member.packageJsonPath !== expectedPackageJsonPath || member.artifactPath !== expectedArtifactPath || !component.artifactPathScope.paths.includes(expectedPackageJsonPath)) {
      failLicense(`${component.id} child member ${member.packageJsonPath} is outside its component scope`, "map the child member to the exact artifact component");
    }
    if (expectedType === "npm-package") validateLockEvidence(member);
    allMembers.push({ ...member, component: component.id });
  }
}

function validateLockEvidence(member) {
  const evidence = member.lockEvidence;
  if (!evidence || !["matched", "unresolved"].includes(evidence.status) || typeof evidence.packageName !== "string" || evidence.packageName !== member.name || evidence.version !== member.version || evidence.canonicalPath !== member.sourcePath) {
    failLicense(`package member ${member.artifactPath} has invalid lock v3 evidence`, "match by canonical lock path plus package manifest name and version, or record an explicit unresolved state");
  }
  if (evidence.status === "matched") {
    if (!["package-lock.json", "vendor/paseo/package-lock.json"].includes(evidence.lockFile) || typeof evidence.lockPath !== "string" || !["canonical-path", "manifest-name-version-fallback"].includes(evidence.matchMode) || !Array.isArray(evidence.paths) || !evidence.paths.includes(evidence.lockPath) || typeof evidence.integrity !== "string" || typeof evidence.resolved !== "string") {
      failLicense(`package member ${member.artifactPath} has incomplete matched lock evidence`, "preserve lockfile, canonical path, version, integrity, resolved source, and license metadata");
    }
    if (!["available", "missing"].includes(evidence.licenseMetadataStatus)) {
      failLicense(`package member ${member.artifactPath} has invalid lock license metadata state`, "preserve the lock license value or label it missing");
    }
  } else if (!Array.isArray(evidence.paths) || typeof evidence.reason !== "string" || !evidence.reason) {
    failLicense(`package member ${member.artifactPath} has an empty unresolved lock state`, "name why lock v3 matching failed and keep the owner decision unresolved");
  }
}

function validateArtifactMembers(component, members, actualPaths, manifestMacho) {
  const identities = new Set();
  for (const member of members) {
    if (!member || typeof member.artifactPath !== "string" || typeof member.memberType !== "string" || !Array.isArray(member.sourcePaths) || !member.sourcePaths.length || identities.has(member.artifactPath)) {
      failLicense(`${component.id} artifact-member provenance is malformed or duplicated`, "record each native/model/asset child member exactly once");
    }
    identities.add(member.artifactPath);
    if (!actualPaths.has(member.artifactPath) || !component.artifactPathScope.paths.includes(member.artifactPath)) {
      failLicense(`${component.id} child artifact ${member.artifactPath} is missing or misassigned`, "map each child artifact to its owning component");
    }
    if (member.artifactSha256 !== null && !/^[a-f0-9]{64}$/u.test(member.artifactSha256 ?? "")) {
      failLicense(`${component.id} child artifact ${member.artifactPath} has no integrity hash`, "record the final artifact entry SHA-256");
    }
  }
  const expected = expectedArtifactMemberPaths(component.id, component.artifactPathScope.paths, new Set(manifestMacho));
  for (const artifactPath of expected) {
    if (!identities.has(artifactPath)) {
      failLicense(`${component.id} child artifact ${artifactPath} has no provenance record`, "record every native/model/asset child member exactly once");
    }
  }
}

function expectedArtifactMemberPaths(componentId, paths, machoSet) {
  return paths.filter((candidate) => {
    if (componentId === "native-binaries") return machoSet.has(candidate);
    if (componentId === "capture-helper") return candidate === "Contents/Resources/meetless/native/macos-capture/meetless-capture";
    if (componentId === "node") return candidate === "Contents/Resources/meetless/runtime/node";
    if (componentId === "ffmpeg-media") return candidate.startsWith("Contents/Resources/meetless/runtime/media/");
    if (componentId === "sherpa-model-assets") return candidate.endsWith("/silero_vad.onnx");
    if (componentId === "fonts-assets") return /\.(?:png|jpe?g|gif|webp|svg|ico|icns|ttf|otf|woff2?|eot)$/iu.test(candidate);
    return false;
  });
}

function validateDerivedInventorySummary(inventory, mappedPathCount) {
  const summary = inventory.summary;
  const expectedCounts = Object.fromEntries(inventory.components.map((component) => [component.id, component.artifactPathScope.paths.length]));
  if (summary.artifactEntryCount !== mappedPathCount || summary.componentCount !== inventory.components.length || JSON.stringify(summary.componentPathCounts) !== JSON.stringify(expectedCounts)) {
    failLicense("license inventory summary counts do not match the final component scopes", "derive all current counts from the final inventory and update the manifest binding");
  }
  const packageMemberCount = inventory.components.reduce((total, component) => total + (component.provenance.packageMembers?.length ?? 0), 0);
  const workspaceMemberCount = inventory.components.reduce((total, component) => total + (component.provenance.workspaceMembers?.length ?? 0), 0);
  const packageMembers = inventory.components.flatMap((component) => component.provenance.packageMembers ?? []).sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
  const workspaceMembers = inventory.components.flatMap((component) => component.provenance.workspaceMembers ?? []).sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
  if (summary.packageMemberCount !== packageMemberCount || summary.packageMemberDigest !== digestJson(packageMembers) || summary.workspaceMemberCount !== workspaceMemberCount || summary.workspaceMemberDigest !== digestJson(workspaceMembers)) {
    failLicense("license inventory package/workspace member counts are stale", "derive member counts from the final component provenance records");
  }
  const lockMetadataGapCount = inventory.components.find((component) => component.id === "js-closure")?.declaredLicenseEvidence?.lockMetadataGaps?.length ?? 0;
  if (summary.lockMetadataGapCount !== lockMetadataGapCount) {
    failLicense("license inventory lock metadata gap count is stale", "derive the current lock-gap count from the final inventory and label historical values separately");
  }
  const binding = inventory.artifact.packageInputBinding;
  if (binding.packageMemberCount !== summary.packageMemberCount || binding.packageMemberDigest !== summary.packageMemberDigest || binding.workspaceMemberCount !== summary.workspaceMemberCount || binding.workspaceMemberDigest !== summary.workspaceMemberDigest || binding.lockMetadataGapCount !== summary.lockMetadataGapCount) {
    failLicense("license inventory package-input counts do not match the final inventory summary", "derive package, workspace, and lock-gap counts once from the final inventory");
  }
}

function validateLicenseInventoryBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.schema !== MACOS_LICENSE_INVENTORY_SCHEMA || binding.path !== MACOS_LICENSE_INVENTORY_PATH || !/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "") || !/^[a-f0-9]{64}$/u.test(binding.artifactEntryDigest ?? "") || !/^[a-f0-9]{64}$/u.test(binding.packageInputDigest ?? "") || !/^[a-f0-9]{64}$/u.test(binding.packageInputArtifactDigest ?? "") || !Number.isInteger(binding.componentCount) || binding.componentCount < REQUIRED_LICENSE_COMPONENTS.length || JSON.stringify(binding.excludedPathPrefixes ?? []) !== JSON.stringify(MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES) || !Array.isArray(binding.excludedPaths)) {
    failLicense("manifest license inventory binding is missing or invalid", "regenerate the composition manifest with the packaged inventory");
  }
}

function validateLicenseComponent(component, options = {}) {
  if (!component || typeof component !== "object" || typeof component.id !== "string" || !component.id) {
    failLicense("license inventory contains a malformed component", "record a stable component identifier and all required fields");
  }
  const scope = component.artifactPathScope;
  if (!scope || scope.kind !== "exact-paths" || !Array.isArray(scope.paths) || scope.count !== scope.paths.length) {
    failLicense(`component ${component.id} has no exact artifact path scope`, "record every mapped artifact path exactly once");
  }
  const paths = new Set();
  for (const relativePath of scope.paths) {
    assertLicensePackageRelativePath(relativePath, `${component.id} artifact path`);
    if (paths.has(relativePath)) failLicense(`component ${component.id} repeats artifact path ${relativePath}`, "sort and de-duplicate the component path scope");
    paths.add(relativePath);
  }
  const provenance = component.provenance;
  if (!provenance || typeof provenance.sourceType !== "string" || !Array.isArray(provenance.sourcePaths) || !provenance.versionOrHash || typeof provenance.versionOrHash !== "object" || !/^[a-f0-9]{64}$/u.test(provenance.versionOrHash.artifactScopeSha256 ?? "")) {
    failLicense(`component ${component.id} provenance/version/hash evidence is missing`, "record source paths and a deterministic artifact scope hash");
  }
  validateEvidenceBlock(component.declaredLicenseEvidence, `${component.id} declared-license evidence`);
  validateEvidenceBlock(component.shippedNotice, `${component.id} shipped notice`);
  validateNoticeEvidenceBlock(component.shippedNotice, `${component.id} shipped notice`);
  validateEvidenceBlock(component.sourceBuildMaterial, `${component.id} source/build material`);
  const decision = component.ownerDecision;
  if (!decision || typeof decision.required !== "boolean" || !["resolved", "unresolved", "not-required"].includes(decision.status) || typeof decision.owner !== "string" || typeof decision.rule !== "string" || typeof decision.nextAction !== "string") {
    failLicense(`component ${component.id} owner-decision state is missing or invalid`, "record the owner, unresolved/resolved state, authority, and next action");
  }
  if (decision.rule !== MACOS_LICENSE_INVENTORY_AUTHORITY) {
    failLicense(`component ${component.id} owner decision cites an unaccepted authority`, `use ${MACOS_LICENSE_INVENTORY_AUTHORITY}`);
  }
  if (decision.required && decision.status === "resolved" && !decision.resolutionEvidence) {
    failLicense(`component ${component.id} is marked resolved without resolution evidence`, "record the owner decision evidence before changing the state to resolved");
  }
  if (decision.status !== "resolved" && decision.resolutionEvidence) {
    failLicense(`component ${component.id} has resolution evidence while its decision is unresolved`, "remove stale approval evidence or resolve the owner decision with complete evidence");
  }
  if (decision.status === "resolved") validateResolutionEvidenceShape(decision.resolutionEvidence, `${component.id} owner decision`);
}

function validateEvidenceBlock(block, label) {
  if (!block || typeof block !== "object" || !["available", "available-in-repository", "available-if-builder-license-is-copied", "partial", "not-declared", "not-present", "unresolved"].includes(block.status) || !Array.isArray(block.paths)) {
    failLicense(`${label} is missing or invalid`, "record evidence paths and an explicit availability status without inventing missing text");
  }
  for (const evidencePath of block.paths) {
    if (typeof evidencePath !== "string" || !evidencePath) failLicense(`${label} contains an empty evidence path`, "record a repository or packaged evidence path");
  }
}

function validateNoticeEvidenceBlock(block, label) {
  if (!Array.isArray(block.records)) {
    failLicense(`${label} has no structured evidence records`, "record only verified text notices with byte-bound source associations");
  }
  const paths = new Set(block.paths);
  const records = new Set();
  for (const record of block.records) {
    if (!record || typeof record.artifactPath !== "string" || !paths.has(record.artifactPath) || records.has(record.artifactPath) || typeof record.sourcePath !== "string" || !record.sourcePath || !["verified-upstream-text", "packaged-npm-member"].includes(record.sourceKind) || !/^[a-f0-9]{64}$/u.test(record.sourceSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(record.artifactSha256 ?? "") || record.byteBound !== true || record.sourceSha256 !== record.artifactSha256) {
      failLicense(`${label} contains an unbound or duplicated notice record`, "use verified upstream text or package-member text with matching source and artifact SHA-256 values");
    }
    records.add(record.artifactPath);
  }
  if (records.size !== paths.size) {
    failLicense(`${label} contains notice paths without structured evidence`, "remove filename-only notice paths or add byte-bound verified evidence");
  }
}

function validateResolutionEvidenceShape(evidence, label) {
  if (!evidence || typeof evidence !== "object" || !evidence.authorityRecord || !evidence.ownerDecisionRecord || !Array.isArray(evidence.relevantEvidence) || evidence.relevantEvidence.length === 0) {
    failLicense(`${label} resolution evidence is empty or incomplete`, "reference an existing accepted authority, owner-decision record, and relevant evidence paths with integrity");
  }
  for (const record of [evidence.authorityRecord, evidence.ownerDecisionRecord, ...evidence.relevantEvidence]) {
    if (!record || typeof record.path !== "string" || !record.path || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")) {
      failLicense(`${label} resolution evidence has a missing path or SHA-256`, "record every resolution evidence path and its exact SHA-256");
    }
  }
}

async function validateNoticeEvidence(inventory, bundlePath, repositoryRoot) {
  for (const component of inventory.components) {
    for (const record of component.shippedNotice.records) {
      const artifactPath = path.join(bundlePath, record.artifactPath);
      const artifactBytes = await readFile(artifactPath).catch(() => null);
      if (!artifactBytes || sha256(artifactBytes) !== record.artifactSha256) {
        failLicense(`notice evidence ${record.artifactPath} does not match the shipped bytes`, "regenerate notice evidence from the final artifact");
      }
      let sourcePath;
      if (record.sourceKind === "packaged-npm-member") {
        sourcePath = path.join(bundlePath, "Contents", "Resources", "meetless", record.sourcePath);
      } else {
        sourcePath = record.sourceResolvedPath ?? (repositoryRoot ? path.join(repositoryRoot, record.sourcePath) : null);
      }
      const sourceBytes = sourcePath ? await readFile(sourcePath).catch(() => null) : null;
      if (!sourceBytes || sha256(sourceBytes) !== record.sourceSha256 || !sourceBytes.equals(artifactBytes)) {
        failLicense(`notice evidence ${record.artifactPath} has no byte-bound source`, "associate only verified upstream or package-member text with matching bytes");
      }
    }
  }
}

export async function validateResolutionEvidencePaths(inventory, repositoryRoot) {
  for (const component of inventory.components) {
    const decision = component.ownerDecision;
    if (decision.status !== "resolved") continue;
    validateResolutionEvidenceShape(decision.resolutionEvidence, `${component.id} owner decision`);
    if (!repositoryRoot) continue;
    for (const record of [decision.resolutionEvidence.authorityRecord, decision.resolutionEvidence.ownerDecisionRecord, ...decision.resolutionEvidence.relevantEvidence]) {
      if (path.isAbsolute(record.path)) {
        failLicense(`${component.id} resolution evidence uses an absolute path`, "record repository-relative accepted evidence paths");
      }
      const resolved = path.resolve(repositoryRoot, record.path);
      const relative = path.relative(repositoryRoot, resolved);
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        failLicense(`${component.id} resolution evidence escapes the repository: ${record.path}`, "reference an existing repository evidence file");
      }
      const bytes = await readFile(resolved).catch(() => null);
      if (!bytes || sha256(bytes) !== record.sha256) {
        failLicense(`${component.id} resolution evidence is missing or stale: ${record.path}`, "refresh the owner-decision evidence SHA-256 or keep the decision unresolved");
      }
    }
  }
}

function validateOverlapRules(rules, components) {
  if (!Array.isArray(rules)) failLicense("license inventory overlap rules are missing", "record explicit narrower-over-broader packaging rules");
  for (const rule of rules) {
    if (!rule || typeof rule.id !== "string" || !components.has(rule.broaderComponent) || !components.has(rule.narrowerComponent) || !Array.isArray(rule.paths) || typeof rule.reason !== "string" || !rule.reason) {
      failLicense("license inventory contains a malformed overlap rule", "name both components, the affected paths, and the inspected packaging reason");
    }
    for (const relativePath of rule.paths) {
      assertLicensePackageRelativePath(relativePath, `overlap rule ${rule.id} path`);
      if (!components.get(rule.narrowerComponent).artifactPathScope.paths.includes(relativePath)) {
        failLicense(`overlap rule ${rule.id} names an unmapped narrower path ${relativePath}`, "map each overlap path to the narrower component it describes");
      }
    }
  }
}

export function assertPackageRelativePath(candidate, label = "package path") {
  if (typeof candidate !== "string" || candidate.length === 0 || path.isAbsolute(candidate)) {
    fail(`${label} is absolute or empty: ${String(candidate)}`, "use a path relative to Meetless.app");
  }
  const normalized = path.posix.normalize(candidate.replaceAll(path.sep, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail(`${label} escapes Meetless.app: ${candidate}`, "keep packaged resources inside the artifact");
  }
  return normalized;
}

function assertLicensePackageRelativePath(candidate, label) {
  if (typeof candidate !== "string" || candidate.length === 0 || path.isAbsolute(candidate)) {
    failLicense(`${label} is absolute or empty: ${String(candidate)}`, "use a path relative to Meetless.app");
  }
  const normalized = path.posix.normalize(candidate.replaceAll(path.sep, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    failLicense(`${label} escapes Meetless.app: ${candidate}`, "keep inventory scopes inside the distributed artifact");
  }
  return normalized;
}

export function assertNoForbiddenLoadPath(value, label = "Mach-O dependency") {
  const forbidden = FORBIDDEN_LOAD_PATHS.find((prefix) => value.includes(prefix));
  if (forbidden) {
    fail(`${label} resolves through ${forbidden}: ${value}`, "rewrite the closure to an in-package @loader_path or system path");
  }
}

export async function validateMacOSPackage(manifestPath, options = {}) {
  const manifest = validateManifestDocument(JSON.parse(await readFile(manifestPath, "utf8")));
  const requestedMode = options.signingMode ?? manifest.signing.mode;
  let signingInputs;
  try {
    signingInputs = await resolveSigningInputs({
      mode: requestedMode,
      signingIdentity: options.signingIdentity ?? (requestedMode === LOCAL_AD_HOC_SIGNING_MODE ? "-" : null),
      entitlementsPath: options.entitlementsPath ?? null,
      expectedTeamId: options.expectedTeamId ?? null,
    });
  } catch (error) {
    fail(`signing input validation failed: ${error instanceof Error ? error.message : String(error)}`, "supply the explicit identity and entitlement inputs required by the declared signing mode");
  }
  const releaseRoot = path.dirname(manifestPath);
  const bundlePath = path.resolve(releaseRoot, manifest.bundlePath);
  const packageRoot = path.resolve(bundlePath, manifest.packageRoot);
  assertInside(bundlePath, packageRoot, "package root");
  const repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : null;
  const candidateSnapshot = repositoryRoot ? await verifyCandidateSnapshot(manifest, repositoryRoot) : manifest.candidateSnapshot;

  const actualEntries = await enumeratePackageEntries(bundlePath);
  compareManifestEntrySets(manifest.entries, actualEntries, bundlePath);
  await validatePackageSymlinkClosure(bundlePath, actualEntries);
  const inventoryPath = path.resolve(bundlePath, manifest.licenseInventory.path);
  assertInside(bundlePath, inventoryPath, "packaged license inventory");
  const inventoryEntry = manifest.entries.find((entry) => entry.path === manifest.licenseInventory.path);
  if (!inventoryEntry || inventoryEntry.type !== "file") {
    failLicense("packaged license inventory is not a hashed regular file", "include the generated inventory JSON in the artifact manifest");
  }
  const inventoryBytes = await readFile(inventoryPath).catch(() => null);
  if (!inventoryBytes || sha256(inventoryBytes) !== manifest.licenseInventory.sha256) {
    failLicense("packaged license inventory bytes do not match the composition manifest", "regenerate the manifest after writing the inventory");
  }
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  try {
    await verifyMacOSPackageInputs({ manifest: manifest.packageInputs, repositoryRoot: repositoryRoot ?? path.dirname(path.dirname(manifestPath)), bundlePath, candidateSnapshot });
  } catch (error) {
    failLicense(`package-input validation failed: ${error instanceof Error ? error.message : String(error)}`, "rebuild the package from the exact source and shipped-input closure");
  }
  validateLicenseInventoryCoverage(inventory, manifest.entries, manifest.licenseInventory, manifest.macho, { repositoryRoot, bundlePath });
  await validateNoticeEvidence(inventory, bundlePath, repositoryRoot);
  await validateResolutionEvidencePaths(inventory, repositoryRoot);
  if (JSON.stringify(inventory.artifact.candidateSnapshot) !== JSON.stringify({
    command: manifest.candidateSnapshot.command,
    mode: manifest.candidateSnapshot.mode,
    excludedPaths: manifest.candidateSnapshot.excludedPaths,
    digest: manifest.candidateSnapshot.digest,
    head: manifest.candidateSnapshot.head,
    paseoCommit: manifest.candidateSnapshot.paseoCommit,
  })) {
    failLicense("license inventory candidate snapshot differs from the composition manifest", "regenerate both files from the same deterministic candidate snapshot");
  }
  const packageEntryPaths = new Set(actualEntries.map((entry) => entry.path));
  const entryMap = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const required of manifest.requiredFiles ?? []) {
    if (!entryMap.has(required)) {
      fail(`required resource is not hashed: ${required}`, "add it to the composition manifest");
    }
  }

  const markerPath = path.resolve(bundlePath, manifest.packageMarker);
  assertInside(bundlePath, markerPath, "packaged runtime marker");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  validatePackagedMarker(marker, packageRoot);
  const hostConfig = JSON.parse(await readFile(path.join(bundlePath, "Contents", "Resources", "host-config.json"), "utf8"));
  validateHostConfig(hostConfig, bundlePath);

  const rendererEntry = entryMap.get(manifest.renderer.entry);
  if (!rendererEntry || rendererEntry.type !== "file" || rendererEntry.sha256 !== manifest.renderer.sha256) {
    fail("renderer manifest binding does not match a packaged file", "bind the emitted renderer entry hash");
  }

  const actualMachO = await inspectPackageMachOEntries(bundlePath, actualEntries);
  const actualMachOPaths = actualMachO.map((entry) => entry.path);
  const expectedMachOPaths = [...new Set(manifest.macho)].sort((left, right) => left.localeCompare(right));
  if (expectedMachOPaths.length !== manifest.macho.length) {
    fail("manifest Mach-O inventory contains duplicate paths", "record each regular Mach-O exactly once");
  }
  if (JSON.stringify(actualMachOPaths) !== JSON.stringify(expectedMachOPaths)) {
    fail(
      `manifest Mach-O inventory differs from the artifact (manifest ${expectedMachOPaths.length}, actual ${actualMachOPaths.length})`,
      "inventory every regular Mach-O file and remove only proven-unused native resources",
    );
  }

  await verifyCodeSignature(bundlePath);
  await verifyIndividualMachOSignatures(actualMachO, bundlePath);
  await verifyBundleIdentity(bundlePath);
  let signatureEvidence;
  try {
    signatureEvidence = await collectMacOSSignatureEvidence({
      bundlePath,
      machoPaths: actualMachOPaths,
      verify: false,
      requireCertificateEvidence: signingInputs.mode === "release",
    });
    validateSigningMetadata(manifest.signing, {
      machoPaths: actualMachOPaths,
      actual: signatureEvidence,
      expectedMode: requestedMode,
      expectedIdentity: signingInputs.requestedIdentity,
      expectedResolvedIdentity: signingInputs.resolvedIdentity,
      expectedCertificateFingerprint: signingInputs.certificateFingerprint,
      expectedCertificateSha1: signingInputs.certificateSha1,
      entitlementFileSha256: signingInputs.entitlementFileSha256,
      entitlementOwnerCanonicalSha256: signingInputs.entitlementOwnerCanonicalSha256,
      expectedTeamId: signingInputs.resolvedTeamId ?? signingInputs.expectedTeamId,
    });
  } catch (error) {
    fail(`final signing contract validation failed: ${error instanceof Error ? error.message : String(error)}`, "rebuild and revalidate every final nested Mach-O and the outer app in the declared mode");
  }
  const inspectedMachO = [];
  for (const entry of actualMachO) {
    const absolute = path.resolve(bundlePath, entry.path);
    verifyArm64(entry.path, entry.fileOutput);
    const inspected = await inspectMachO(absolute);
    if (!inspected) fail(`${entry.path} disappeared from the Mach-O inventory`, "rebuild the exact package candidate");
    inspectedMachO.push({ relative: entry.path, binary: absolute, fileOutput: entry.fileOutput, ...inspected });
  }
  await validateMacOSLoadPathClosure(inspectedMachO, bundlePath, packageEntryPaths);
  return {
    status: "passed",
    bundlePath,
    artifactDigest: manifest.artifactDigest,
    candidateSnapshotDigest: manifest.candidateSnapshot.digest,
    entries: manifest.entries.length,
    macho: actualMachO.length,
  };
}

async function verifyCandidateSnapshot(manifest, repositoryRoot) {
  const result = await execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts", "candidate-snapshot.mjs"), "--mode=package-source"], {
    cwd: repositoryRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  const snapshot = JSON.parse(result.stdout);
  if (
    snapshot.mode !== PACKAGE_SOURCE_MODE ||
    JSON.stringify(snapshot.excludedPaths ?? []) !== JSON.stringify([...PACKAGE_SOURCE_EXCLUDED_PATHS]) ||
    snapshot.digest !== manifest.candidateSnapshot.digest ||
    snapshot.head !== manifest.candidateSnapshot.head ||
    snapshot.dependencyArtifacts?.paseo?.expectedCommit !== manifest.candidateSnapshot.paseoCommit ||
    snapshot.dependencyArtifacts?.paseo?.gitlinkCommit !== manifest.candidateSnapshot.paseoCommit
  ) {
    fail(
      "current candidate snapshot differs from the artifact evidence",
      "rebuild the package from the exact deterministic candidate snapshot before validation",
    );
  }
  return snapshot;
}

export function validateAcceptanceEvidenceBinding(evidence, manifest) {
  const expected = {
    sourceSnapshotMode: manifest?.candidateSnapshot?.mode,
    sourceSnapshotExcludedPaths: manifest?.candidateSnapshot?.excludedPaths,
    sourceSnapshotDigest: manifest?.candidateSnapshot?.digest,
    sourceSnapshotHead: manifest?.candidateSnapshot?.head,
    packageInputDigest: manifest?.packageInputs?.digest,
    artifactInputDigest: manifest?.packageInputs?.artifactInput?.digest,
    artifactDigest: manifest?.artifactDigest,
    paseoCommit: manifest?.candidateSnapshot?.paseoCommit,
  };
  const actual = {
    sourceSnapshotMode: evidence?.candidate?.sourceSnapshotMode,
    sourceSnapshotExcludedPaths: evidence?.candidate?.sourceSnapshotExcludedPaths,
    sourceSnapshotDigest: evidence?.candidate?.sourceSnapshotDigest,
    sourceSnapshotHead: evidence?.candidate?.sourceSnapshotHead,
    packageInputDigest: evidence?.candidate?.packageInputDigest,
    artifactInputDigest: evidence?.candidate?.artifactInputDigest,
    artifactDigest: evidence?.candidate?.artifactDigest,
    paseoCommit: evidence?.candidate?.paseoCommit,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("acceptance evidence candidate identity differs from the package manifest", "regenerate evidence from the exact validated package candidate");
  }
  return evidence;
}

export function compareManifestEntrySets(expected, actual, bundlePath = "Meetless.app") {
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = expected.filter((entry) => !actualMap.has(entry.path)).map((entry) => entry.path);
  const extra = actual.filter((entry) => !expectedMap.has(entry.path)).map((entry) => entry.path);
  if (missing.length || extra.length) {
    fail(
      `manifest entry set differs from ${bundlePath} (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`,
      "regenerate the manifest from the complete artifact entry set",
    );
  }
  for (const entry of expected) {
    const actualEntry = actualMap.get(entry.path);
    if (!actualEntry || JSON.stringify(actualEntry) !== JSON.stringify(entry)) {
      fail(`manifest entry ${entry.path} type, target, size, or hash changed`, "rebuild the deterministic package");
    }
  }
}

export async function validatePackageSymlinkClosure(bundlePath, entries) {
  const packageRoot = await realpath(bundlePath).catch((error) => {
    fail(`package root cannot be resolved before symlink validation: ${error.message}`, "validate the complete package directory");
  });
  for (const entry of entries.filter((candidate) => candidate.type === "symlink")) {
    const linkPath = path.resolve(packageRoot, entry.path);
    assertInside(packageRoot, linkPath, `packaged symlink ${entry.path}`);
    const target = await readlink(linkPath).catch((error) => {
      fail(`packaged symlink ${entry.path} cannot be read: ${error.message}`, "rebuild the complete package closure");
    });
    if (path.isAbsolute(target)) {
      fail(`packaged symlink ${entry.path} uses an absolute target ${target}`, "use a relative target that remains inside Meetless.app");
    }
    const lexicalTarget = path.resolve(path.dirname(linkPath), target);
    if (!isInsideBoolean(packageRoot, lexicalTarget)) {
      fail(`packaged symlink ${entry.path} escapes Meetless.app through ${target}`, "keep every symlink target inside the artifact");
    }
    const resolvedTarget = await realpath(linkPath).catch((error) => {
      fail(`packaged symlink ${entry.path} is dangling: ${error.message}`, "include the complete symlink target in the artifact");
    });
    if (!isInsideBoolean(packageRoot, resolvedTarget)) {
      fail(`packaged symlink ${entry.path} resolves outside Meetless.app: ${resolvedTarget}`, "bundle the resolved target inside the artifact");
    }
    const resolvedStats = await stat(resolvedTarget).catch((error) => {
      fail(`packaged symlink ${entry.path} resolved target is unavailable: ${error.message}`, "include the complete symlink target in the artifact");
    });
    if (!resolvedStats.isFile() && !resolvedStats.isDirectory()) {
      fail(`packaged symlink ${entry.path} resolves to an unsupported file type`, "use a regular in-package file or directory target");
    }
  }
}

function validatePackagedMarker(marker, packageRoot) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    fail("packaged runtime marker is not an object", "rebuild the signed marker");
  }
  const accepted = acceptedMacOSPackagePaths();
  if (
    marker.schema !== MACOS_PACKAGE_SCHEMA ||
    marker.target !== "macos-arm64" ||
    marker.bundleIdentifier !== "com.meetless.app" ||
    marker.paseoCommit !== PINNED_PASEO_COMMIT ||
    marker.rendererOrigin !== MACOS_PACKAGE_RENDERER_ORIGIN ||
    marker.runtimeRoot !== accepted.runtimeRoot ||
    marker.recordingExports !== accepted.recordingExports ||
    marker.identityPath !== accepted.identityPath ||
    marker.hostBundlePath !== accepted.canonicalBundlePath
  ) {
    fail(
      "packaged marker absolute path or identity does not match the accepted package locations",
      "rebuild with the fixed Meetless package runtime, export, identity, and host paths",
    );
  }
  const requiredResources = ["rendererRoot", "electronBinary", "nodeBinary", "captureHelper", "ffmpeg", "ffprobe"];
  for (const name of requiredResources) {
    const relative = marker.resources?.[name];
    if (typeof relative !== "string") {
      fail(`packaged resource ${name} is missing`, "use a relative in-package resource path");
    }
    const resourcePath = path.resolve(packageRoot, relative);
    assertInside(packageRoot, resourcePath, `packaged resource ${name}`);
    if (path.isAbsolute(relative) || resourcePath === packageRoot || path.relative(packageRoot, resourcePath).startsWith("../")) {
      fail(`packaged resource ${name} escapes the package root`, "use a relative in-package resource path");
    }
  }
}

function validateHostConfig(configuration, bundlePath) {
  const accepted = acceptedMacOSPackagePaths();
  const canonicalPackageRoot = path.join(accepted.canonicalBundlePath, "Contents", "Resources", "meetless");
  const expected = {
    repositoryRoot: canonicalPackageRoot,
    runtimeRoot: accepted.runtimeRoot,
    rendererOrigin: accepted.rendererOrigin,
    transcriptionSocket: path.join(accepted.runtimeRoot, "transcription.sock"),
    transcriptionStaging: path.join(accepted.runtimeRoot, "meeting-store", "transcription-ranges"),
    nodePath: path.join(canonicalPackageRoot, "runtime", "node"),
    runtimeCliPath: path.join(canonicalPackageRoot, "packages", "runtime", "dist", "cli.js"),
    identityPath: accepted.identityPath,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (configuration?.[name] !== value) {
      fail(`host configuration ${name} is not bound to the accepted package path`, `rebuild host-config.json for ${bundlePath}`);
    }
  }
  if (typeof configuration.listen !== "string" || !/^127\.0\.0\.1:\d+$/u.test(configuration.listen)) {
    fail("packaged daemon listener is not an exact loopback endpoint", "use a bounded package-owned loopback port");
  }
  const port = Number(configuration.listen.slice(configuration.listen.lastIndexOf(":") + 1));
  if (port < 1024 || port > 65535 || port === 6767) {
    fail(`packaged daemon listener port is invalid: ${configuration.listen}`, "use a non-production loopback port");
  }
}

async function verifyCodeSignature(bundlePath) {
  try {
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", bundlePath]);
  } catch (error) {
    fail(`codesign verification failed: ${error.message}`, "sign the complete nested closure in the declared mode after composition");
  }
}

export async function verifyIndividualMachOSignatures(entries, bundlePath) {
  for (const entry of entries) {
    await verifyIndividualMachOSignature(entry.path, path.resolve(bundlePath, entry.path));
  }
}

export async function verifyIndividualMachOSignature(relativePath, binaryPath) {
  try {
    await execFileAsync("codesign", ["--verify", "--strict", "--verbose=2", binaryPath]);
  } catch (error) {
    const detail = [error?.stderr, error?.stdout, error?.message]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .replaceAll(/\s+/gu, " ")
      .slice(0, 600);
    fail(
      `standalone Mach-O ${relativePath} failed individual codesign verification: ${detail}`,
      "sign every final manifest Mach-O after load-path normalization and before outer bundle signing",
    );
  }
}

async function verifyBundleIdentity(bundlePath) {
  const { stdout } = await execFileAsync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(bundlePath, "Contents", "Info.plist")]);
  if (stdout.trim() !== "com.meetless.app") fail("top bundle identifier is not com.meetless.app", "keep Meetless.app as the only TCC owner");
  const executable = path.join(bundlePath, "Contents", "MacOS", "MeetlessHost");
  const requirementResult = await execFileAsync("codesign", ["-d", "-r-", bundlePath]).catch((error) => {
    fail(`could not inspect top designated requirement: ${error.message}`, "sign the top Meetless.app bundle");
  });
  const requirement = `${requirementResult.stdout}\n${requirementResult.stderr}`;
  if (!requirement.includes("designated =>")) fail("top designated requirement is missing", "sign the sole Meetless TCC owner");
  await lstat(executable).catch(() => fail("MeetlessHost executable is missing", "include the native host in the package"));
}

function verifyArm64(relative, fileOutput) {
  if (!/arm64/u.test(fileOutput) || /x86_64|i386/u.test(fileOutput)) {
    fail(`${relative} is not arm64-only: ${fileOutput.trim()}`, "compose only the accepted macOS arm64 binaries");
  }
}

export async function validateMacOSLoadPathClosure(images, bundlePath, packageEntryPaths) {
  const executablePaths = new Map();
  for (const image of images) {
    executablePaths.set(image.relative, await findApplicableExecutable(image.binary, bundlePath, packageEntryPaths, { required: false, fileOutput: image.fileOutput }));
  }
  const resolvedImages = new Map();
  for (const image of images) {
    const resolved = await realpath(image.binary).catch(() => path.resolve(image.binary));
    resolvedImages.set(resolved, image);
  }
  const roots = images.filter((image) => path.resolve(executablePaths.get(image.relative) ?? "") === path.resolve(image.binary));
  const visited = new Set();
  const seenImages = new Set();
  const visit = async (image, inheritedRunPaths, mainExecutablePath) => {
    seenImages.add(image.relative);
    const runPathContext = appendRunPaths(inheritedRunPaths, image.binary, image.rpaths);
    const contextKey = `${image.relative}\0${runPathContext.map((entry) => `${entry.ownerBinary}\0${entry.value}`).join("\0")}`;
    if (visited.has(contextKey)) return;
    visited.add(contextKey);
    await validateLoadPathClosure(image.relative, image.binary, bundlePath, packageEntryPaths, image.dependencies, image.rpaths, {
      executablePath: mainExecutablePath,
      runPathContext,
    });
    for (const dependency of image.dependencies) {
      const candidates = resolveDependencyCandidates({
        binary: image.binary,
        dependency,
        runPathContext,
        executablePath: mainExecutablePath,
      });
      for (const candidate of candidates) {
        if (!await isAcceptedLoadTarget(candidate, bundlePath, packageEntryPaths)) continue;
        const resolvedCandidate = await realpath(candidate).catch(() => path.resolve(candidate));
        const target = resolvedImages.get(resolvedCandidate);
        if (target) await visit(target, runPathContext, mainExecutablePath);
        break;
      }
    }
  };
  for (const image of roots) await visit(image, [], executablePaths.get(image.relative));
  for (const image of images.filter((candidate) => !seenImages.has(candidate.relative))) await visit(image, [], executablePaths.get(image.relative));
}

export async function validateLoadPathClosure(relative, binary, bundlePath, packageEntryPaths, dependencies, rpaths, options = {}) {
  const executablePath = options.executablePath ?? await findApplicableExecutable(binary, bundlePath, packageEntryPaths, { required: false, fileOutput: options.fileOutput });
  const runPathContext = options.runPathContext ?? appendRunPaths([], binary, rpaths);
  for (const rpath of rpaths) {
    assertNoForbiddenLoadPath(rpath, `${relative} LC_RPATH`);
    if (rpath.startsWith("/")) {
      if (!isSystemDependency(rpath)) {
        fail(`${relative} has a non-system absolute LC_RPATH ${rpath}`, "remove or rewrite the external LC_RPATH");
      }
    } else if (!rpath.startsWith("@loader_path") && !rpath.startsWith("@executable_path")) {
      fail(`${relative} has an unsupported LC_RPATH ${rpath}`, "use an in-package loader-relative or accepted system rpath");
    }
  }

  for (const dependency of dependencies) {
    assertNoForbiddenLoadPath(dependency, `${relative} dependency closure`);
    if (dependency.startsWith("/")) {
      if (!isSystemDependency(dependency)) {
        fail(`${relative} has an external dependency ${dependency}`, "rewrite it to @loader_path or bundle the closure");
      }
      continue;
    }
    if (dependency.startsWith("@rpath/")) {
      const candidates = resolveDependencyCandidates({ binary, dependency, runPathContext, executablePath });
      if (!await anyAcceptedLoadTarget(candidates, bundlePath, packageEntryPaths)) {
        fail(`${relative} @rpath dependency does not resolve inside the artifact: ${dependency} (candidates=${candidates.join(",") || "none"})`, "bundle the exact dependency target or rewrite the load path");
      }
      continue;
    }
    if (dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")) {
      const candidates = resolveDependencyCandidates({ binary, dependency, runPathContext, executablePath });
      if (!await anyAcceptedLoadTarget(candidates, bundlePath, packageEntryPaths)) {
        fail(`${relative} dependency does not resolve inside the artifact: ${dependency} (candidates=${candidates.join(",") || "none"})`, "bundle the exact dependency target or rewrite the load path");
      }
      continue;
    }
    fail(`${relative} has an unsupported dependency ${dependency}`, "use a packaged @loader_path or accepted system dependency");
  }
}

export function resolveLoadPath(binary, token, relative, executablePath = binary) {
  if (token.startsWith("/")) return path.resolve(token, relative);
  if (token === "@loader_path" || token === "@loader_path/") return path.resolve(path.dirname(binary), relative);
  if (token === "@executable_path" || token === "@executable_path/") return path.resolve(path.dirname(executablePath), relative);
  if (token.startsWith("@loader_path/")) return path.resolve(path.dirname(binary), token.slice("@loader_path/".length), relative);
  if (token.startsWith("@executable_path/")) return path.resolve(path.dirname(executablePath), token.slice("@executable_path/".length), relative);
  return path.resolve(path.dirname(binary), relative);
}

async function anyAcceptedLoadTarget(candidates, bundlePath, packageEntryPaths) {
  for (const candidate of candidates) {
    if (await isAcceptedLoadTarget(candidate, bundlePath, packageEntryPaths)) return true;
  }
  return false;
}

async function isAcceptedLoadTarget(candidate, bundlePath, packageEntryPaths = new Set()) {
  if (isSystemDependency(candidate)) return true;
  const resolvedBundle = await realpath(bundlePath).catch(() => path.resolve(bundlePath));
  const lexicalBundle = path.resolve(bundlePath);
  if (!isInsideBoolean(lexicalBundle, candidate)) return false;
  const relative = path.relative(lexicalBundle, path.resolve(candidate)).split(path.sep).join("/");
  if (!packageEntryPaths.has(relative)) return false;
  const lexicalStats = await lstat(candidate).catch(() => null);
  if (!lexicalStats?.isFile() && !lexicalStats?.isSymbolicLink()) return false;
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || !isInsideBoolean(resolvedBundle, resolved)) return false;
  const resolvedRelative = path.relative(resolvedBundle, resolved).split(path.sep).join("/");
  if (!packageEntryPaths.has(resolvedRelative)) return false;
  const resolvedStats = await stat(resolved).catch(() => null);
  return Boolean(resolvedStats?.isFile());
}

function resolveDependencyCandidates({ binary, dependency, runPathContext, executablePath }) {
  if (dependency.startsWith("@rpath/")) {
    return runPathContext.map((entry) => resolveLoadPath(entry.ownerBinary, entry.value, dependency.slice("@rpath/".length), executablePath ?? entry.ownerBinary));
  }
  if (dependency.startsWith("@loader_path/")) return [resolveLoadPath(binary, "@loader_path/", dependency.slice("@loader_path/".length), executablePath ?? binary)];
  if (dependency.startsWith("@executable_path/")) return [resolveLoadPath(binary, "@executable_path/", dependency.slice("@executable_path/".length), executablePath ?? binary)];
  return [dependency];
}

function appendRunPaths(inheritedRunPaths, binary, rpaths) {
  const entries = [
    ...inheritedRunPaths,
    ...rpaths.map((value) => ({ value, ownerBinary: binary })),
  ];
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.ownerBinary}\0${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findApplicableExecutable(binary, bundlePath, packageEntryPaths, { required = true, fileOutput = null } = {}) {
  if (fileOutput && /\bexecutable\b/u.test(fileOutput) && !/dynamically linked shared library|bundle/u.test(fileOutput)) return path.resolve(binary);
  const applicationRoot = nearestApplicationRoot(binary, bundlePath);
  const executableDirectory = path.join(applicationRoot, "Contents", "MacOS");
  const relativeDirectory = path.relative(path.resolve(bundlePath), executableDirectory).split(path.sep).join("/");
  const candidates = [...packageEntryPaths]
    .filter((entry) => path.posix.dirname(entry) === relativeDirectory)
    .map((entry) => path.resolve(bundlePath, entry));
  const regularFiles = [];
  for (const candidate of candidates) {
    const inspected = await lstat(candidate).catch(() => null);
    if (inspected?.isFile()) regularFiles.push(candidate);
  }
  if (regularFiles.length === 1) return regularFiles[0];
  if (!required && regularFiles.length === 0) return null;
  fail(
    `${path.relative(bundlePath, binary) || binary} has ${regularFiles.length} applicable main executables`,
    "keep one regular main executable in the containing app Contents/MacOS directory for @executable_path resolution",
  );
}

function nearestApplicationRoot(binary, bundlePath) {
  const resolvedBundle = path.resolve(bundlePath);
  let candidate = path.resolve(path.dirname(binary));
  while (isInsideBoolean(resolvedBundle, candidate)) {
    if (candidate === resolvedBundle || path.basename(candidate).endsWith(".app")) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return resolvedBundle;
}

function isSystemDependency(value) {
  return value.startsWith("/System/Library/") || value.startsWith("/usr/lib/") || value.startsWith("/System/iOSSupport/");
}

function assertInside(root, candidate, label) {
  if (!isInsideBoolean(root, candidate)) {
    fail(`${label} escapes ${root}: ${candidate}`, "keep the packaged runtime inside the artifact");
  }
}

function isInsideBoolean(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(reason, nextAction) {
  throw new Error(
    `${reason}. Authority: docs/plans/active/v1-paseo-foundation.md. Next action: ${nextAction}.`,
  );
}

function failLicense(reason, nextAction) {
  throw new Error(
    `${reason}. Authority: ${MACOS_LICENSE_INVENTORY_AUTHORITY}. Next action: ${nextAction}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let signingArguments;
  try {
    signingArguments = parseSigningArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (signingArguments) {
    const manifestPath = path.resolve(signingArguments.manifestPath ?? "release/macos/composition-manifest.json");
    validateMacOSPackage(manifestPath, {
      repositoryRoot: process.cwd(),
      signingMode: signingArguments.signingMode ?? undefined,
      signingIdentity: signingArguments.signingIdentity ?? undefined,
      entitlementsPath: signingArguments.entitlementsPath ?? undefined,
      expectedTeamId: signingArguments.expectedTeamId ?? undefined,
    })
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
