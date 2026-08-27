import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, renameSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, realpath, rename, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  digestArtifactEntries,
  digestComponentEntries,
} from "./macos-license-inventory.mjs";
import {
  MACOS_APPROVED_ENTITLEMENT_MAP,
  MACOS_ENTITLEMENT_MAP_PATH,
  MACOS_SIGNING_OUTER_PATH,
  RELEASE_SIGNING_MODE,
  buildSigningOrder,
  codesignArguments,
} from "./macos-package-signing.mjs";

export const MACOS_ARTIFACT_RESIGN_SCHEMA = "MEETLESS_MACOS_ARTIFACT_RESIGN v2";
export const MACOS_ARTIFACT_STAGE_MARKER_SCHEMA = "MEETLESS_MACOS_ARTIFACT_STAGE v1";
export const MACOS_SIGNING_BOUND_SCHEMA = "MEETLESS_MACOS_SIGNING_BOUND_PATHS v2";
export const MACOS_SIGNING_BOUND_PHASES = Object.freeze(["pre-outer", "final"]);
export const MACOS_PRE_OUTER_SIGNING_BOUND_PHASE = "pre-outer";
export const MACOS_FINAL_SIGNING_BOUND_PHASE = "final";
const MACOS_SIGNING_BOUND_CLASSIFIER = "macho-signature | code-resources | license-inventory | ordinary-payload";
const MACOS_SIGNING_BOUND_PROJECTION_SCHEMA = "MEETLESS_MACOS_SIGNING_BOUND_INVENTORY_PROJECTION v1";
const MACOS_SIGNING_BOUND_ARTIFACT_INPUT_SCHEMA = "MEETLESS_MACOS_SIGNING_BOUND_ARTIFACT_INPUT v1";
export const MACOS_MACHO_PAYLOAD_SCHEMA = "MEETLESS_MACOS_MACHO_PAYLOAD v1";
export const MACOS_MACHO_PAYLOAD_NORMALIZER = "exclude LC_CODE_SIGNATURE data ranges and canonicalize exact codesign-derived LC_CODE_SIGNATURE/__LINKEDIT metadata v2";
const MACOS_MACHO_DERIVED_METADATA_SCHEMA = "MEETLESS_MACOS_MACHO_DERIVED_METADATA v1";
export const MACOS_ARTIFACT_STAGE_MARKER_NAME = ".meetless-artifact-stage.json";
export const MACOS_ARTIFACT_STAGE_MANIFEST_NAME = "composition-manifest.json";
export const MACOS_ARTIFACT_STAGE_BUNDLE_NAME = "Meetless.app";
export const MACOS_OUTER_CODE_RESOURCES_PATH = "Contents/_CodeSignature/CodeResources";
export const MACOS_ARTIFACT_OWNER_STATUS_NAME = ".meetless-artifact-resign-status.json";
// Kept as a named historical export so callers can diagnose an obsolete split
// record. Owner stages no longer permit this path: terminal evidence lives in
// the one authoritative status record.
export const MACOS_ARTIFACT_OWNER_EVIDENCE_NAME = ".meetless-artifact-resign-evidence.json";
export const MACOS_ARTIFACT_OWNER_STATUS_SCHEMA = "MEETLESS_MACOS_ARTIFACT_RESIGN_STATUS v1";
export const MACOS_ARTIFACT_OWNER_EVIDENCE_SCHEMA = "MEETLESS_MACOS_ARTIFACT_RESIGN_EVIDENCE v1";
export const MACOS_ARTIFACT_OWNER_TERMINAL_STATES = Object.freeze([
  "retained-preparation-failure",
  "retained-success",
  "retained-failure",
  "retained-interrupted",
]);
export const MACOS_ARTIFACT_RESIGN_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";
export const MACOS_OWNER_TOOL_PATHS = Object.freeze({
  codesign: "/usr/bin/codesign",
});
const MACOS_OWNER_CHILD_KILL_GRACE_MS = 1000;
let activeCodesignChild = null;

export function ownerToolEnvironment(environment = process.env) {
  const sanitized = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "USER", "LOGNAME", "TERM", "TERM_PROGRAM"]) {
    if (typeof environment?.[name] === "string" && environment[name].length > 0) sanitized[name] = environment[name];
  }
  return sanitized;
}

export const ACCEPTED_M7_F23_SOURCE_SNAPSHOT = "52a7ea41a74fb9e8a63eca83b81801dc0fede698e0f4f55ee4b68515b19a76da";
export const ACCEPTED_ARTIFACT_BASELINE = Object.freeze({
  schema: "MEETLESS_MACOS_ARTIFACT_BASELINE v2",
  sourceAncestorSnapshotDigest: ACCEPTED_M7_F23_SOURCE_SNAPSHOT,
  paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e",
  machoCount: 46,
  codeResourcesCount: 10,
  codeObjectCount: 47,
});

export function parseArtifactResignArguments(arguments_) {
  let stageRoot = null;
  let sourceRoot = null;
  let prepare = false;
  let signingIdentity = null;
  let expectedTeamId = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      throw artifactResignError(`unexpected positional argument ${argument}`, "supply --prepare --source-root for credential-free preparation, or --stage-root with the owner identity and Team ID for one consumption attempt");
    }
    if (argument === "--prepare") {
      if (prepare) throw artifactResignError("--prepare was supplied more than once", "supply one preparation mode flag");
      prepare = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const option = {
      "--stage-root": "stageRoot",
      "--source-root": "sourceRoot",
      "--signing-identity": "signingIdentity",
      "--team-id": "expectedTeamId",
    }[name];
    if (!option) {
      throw artifactResignError(
        `unsupported artifact re-sign option ${name}`,
        "use --prepare --source-root for credential-free preparation, or --stage-root with --signing-identity and --team-id for one owner attempt",
      );
    }
    if ({ stageRoot, sourceRoot, signingIdentity, expectedTeamId }[option] !== null) {
      throw artifactResignError(`${name} was supplied more than once`, "supply one explicit value for each artifact re-sign option");
    }
    const value = inlineValue ?? arguments_[++index];
    if (!value || value.startsWith("--")) {
      throw artifactResignError(`${name} has no value`, `supply an explicit value for ${name}`);
    }
    if (option === "stageRoot") stageRoot = value;
    if (option === "sourceRoot") sourceRoot = value;
    if (option === "signingIdentity") signingIdentity = value;
    if (option === "expectedTeamId") expectedTeamId = value;
  }
  if (prepare) {
    if (!sourceRoot) throw artifactResignError("credential-free preparation source root is not explicit", "supply --source-root with the external local package root");
    if (!path.isAbsolute(sourceRoot)) throw artifactResignError(`preparation source root is not absolute: ${sourceRoot}`, "supply the exact absolute release/macos source root");
    if (stageRoot || signingIdentity || expectedTeamId) throw artifactResignError("credential-free preparation received owner signing options", "prepare the stage first, then run the separate generated owner command once");
    return { prepare: true, sourceRoot: path.resolve(sourceRoot), stageRoot: null, signingIdentity: null, expectedTeamId: null, ownerMode: false };
  }
  if (!stageRoot) throw artifactResignError("prepared stage root is not explicit", "run credential-free preparation first and pass its exact absolute --stage-root to the one owner command");
  if (!path.isAbsolute(stageRoot)) throw artifactResignError(`prepared stage root is not absolute: ${stageRoot}`, "supply the exact absolute retained stage root");
  if (!signingIdentity) throw artifactResignError("release signing identity is not explicit", "supply the exact Developer ID Application identity");
  if (!expectedTeamId) throw artifactResignError("Team ID is not explicit", "supply the Team ID belonging to the exact Developer ID Application identity");
  return { prepare: false, sourceRoot: null, stageRoot: path.resolve(stageRoot), signingIdentity, expectedTeamId, ownerMode: true };
}

export function classifySigningBoundPath(relativePath, { machoPaths = [], licenseInventoryPath = MACOS_LICENSE_INVENTORY_PATH } = {}) {
  const normalized = normalizeRelativePath(relativePath, "artifact path");
  if (new Set(machoPaths).has(normalized)) return "macho-signature";
  if (isCodeResourcesPath(normalized)) return "code-resources";
  if (normalized === licenseInventoryPath) return "license-inventory";
  return "ordinary-payload";
}

export function isCodeResourcesPath(relativePath) {
  return typeof relativePath === "string" && /(?:^|\/)_CodeSignature\/CodeResources$/u.test(relativePath);
}

export function createSigningBoundDescriptor({
  phase = null,
  machoPaths = [],
  machoPayloads = [],
  codeResourcePaths = [],
  licenseInventoryPath = MACOS_LICENSE_INVENTORY_PATH,
  ordinaryArtifactInput = null,
  inventoryProjection = null,
} = {}) {
  if (!MACOS_SIGNING_BOUND_PHASES.includes(phase)) {
    throw artifactResignError("signing-bound descriptor phase is missing or unsupported", "declare pre-outer for package-input and inventory scope or final for post-signing observation scope");
  }
  const macho = sortUniquePaths(machoPaths, "Mach-O signing-bound paths");
  const normalizedMachoPayloads = validateMachOPayloadBindings(machoPayloads, macho);
  const codeResources = sortUniquePaths(codeResourcePaths, "CodeResources signing-bound paths");
  const licenseInventory = normalizeRelativePath(licenseInventoryPath, "license inventory path");
  if (phase === MACOS_PRE_OUTER_SIGNING_BOUND_PHASE && codeResources.includes(MACOS_OUTER_CODE_RESOURCES_PATH)) {
    throw artifactResignError("pre-outer signing-bound descriptor includes the outer CodeResources path", "record only the nine nested CodeResources files before the final outer sign");
  }
  if (phase === MACOS_FINAL_SIGNING_BOUND_PHASE && !codeResources.includes(MACOS_OUTER_CODE_RESOURCES_PATH)) {
    throw artifactResignError("final signing-bound descriptor omits the outer CodeResources path", "record all ten nested and outer CodeResources files after the final outer sign");
  }
  const descriptor = {
    schema: MACOS_SIGNING_BOUND_SCHEMA,
    phase,
    classifier: MACOS_SIGNING_BOUND_CLASSIFIER,
    macho,
    machoPayloads: normalizedMachoPayloads,
    codeResources,
    licenseInventory,
    ordinaryArtifactInput: phase === MACOS_PRE_OUTER_SIGNING_BOUND_PHASE ? structuredClone(ordinaryArtifactInput) : null,
    inventoryProjection: phase === MACOS_PRE_OUTER_SIGNING_BOUND_PHASE ? structuredClone(inventoryProjection) : null,
    counts: {
      macho: macho.length,
      codeResources: codeResources.length,
      licenseInventory: 1,
      total: macho.length + codeResources.length + 1,
    },
  };
  validateSigningBoundDescriptor(descriptor);
  return descriptor;
}

export function validateSigningBoundDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) || descriptor.schema !== MACOS_SIGNING_BOUND_SCHEMA || !MACOS_SIGNING_BOUND_PHASES.includes(descriptor.phase) || descriptor.classifier !== MACOS_SIGNING_BOUND_CLASSIFIER) {
    throw artifactResignError("signing-bound path classifier is missing or changed", "use the exact artifact re-sign classifier and keep ordinary payload outside its exception set");
  }
  const macho = sortUniquePaths(descriptor.macho, "signing-bound Mach-O paths");
  const machoPayloads = validateMachOPayloadBindings(descriptor.machoPayloads, macho);
  if (JSON.stringify(machoPayloads) !== JSON.stringify(descriptor.machoPayloads)) {
    throw artifactResignError("signing-bound Mach-O payload bindings are not normalized", "regenerate the exact LC_CODE_SIGNATURE-excluded payload digest for every Mach-O");
  }
  const codeResources = sortUniquePaths(descriptor.codeResources, "signing-bound CodeResources paths");
  if (JSON.stringify(macho) !== JSON.stringify(descriptor.macho) || JSON.stringify(codeResources) !== JSON.stringify(descriptor.codeResources)) {
    throw artifactResignError("signing-bound path lists are not sorted and unique", "regenerate the deterministic Mach-O and CodeResources path sets");
  }
  if (codeResources.some((candidate) => !isCodeResourcesPath(candidate))) {
    throw artifactResignError("signing-bound CodeResources list contains a non-CodeResources path", "classify every **/_CodeSignature/CodeResources path and no other path");
  }
  const licenseInventory = normalizeRelativePath(descriptor.licenseInventory, "signing-bound license inventory path");
  if (licenseInventory !== descriptor.licenseInventory || descriptor.counts?.macho !== macho.length || descriptor.counts?.codeResources !== codeResources.length || descriptor.counts?.licenseInventory !== 1 || descriptor.counts?.total !== macho.length + codeResources.length + 1) {
    throw artifactResignError("signing-bound path counts or license inventory path are stale", "derive the classifier counts from the exact staged artifact path set");
  }
  if (macho.some((candidate) => codeResources.includes(candidate) || candidate === licenseInventory) || codeResources.includes(licenseInventory)) {
    throw artifactResignError("signing-bound path classes overlap", "keep Mach-O, CodeResources, and license-inventory paths disjoint");
  }
  if (descriptor.phase === MACOS_PRE_OUTER_SIGNING_BOUND_PHASE) {
    if (codeResources.includes(MACOS_OUTER_CODE_RESOURCES_PATH)) {
      throw artifactResignError("pre-outer signing-bound descriptor includes the outer CodeResources path", "record only nested CodeResources before the final outer sign");
    }
    validateOrdinaryArtifactInputDescriptor(descriptor.ordinaryArtifactInput, macho, codeResources, licenseInventory);
    validateInventoryProjectionDescriptor(descriptor.inventoryProjection);
  } else {
    if (!codeResources.includes(MACOS_OUTER_CODE_RESOURCES_PATH)) {
      throw artifactResignError("final signing-bound descriptor omits the outer CodeResources path", "record the final outer CodeResources path with the complete final signing observation");
    }
    if (descriptor.ordinaryArtifactInput !== null || descriptor.inventoryProjection !== null) {
      throw artifactResignError("final signing-bound descriptor carries pre-outer inventory or artifact-input scope", "keep package-input and license-inventory bindings in the pre-outer descriptor only");
    }
  }
  return descriptor;
}

export function buildPreOuterSigningBoundDescriptor({
  machoPaths = [],
  machoPayloads = [],
  codeResourcePaths = [],
  licenseInventoryPath = MACOS_LICENSE_INVENTORY_PATH,
  baselinePackageInputs,
  preOuterEntries = [],
  baselineInventory,
} = {}) {
  if (!baselinePackageInputs?.artifactInput || !Array.isArray(baselinePackageInputs.artifactInput.excludedPaths)) {
    throw artifactResignError("baseline package-input artifact scope is missing", "derive the pre-outer descriptor from the accepted package-input manifest before rebinding");
  }
  if (!baselineInventory || typeof baselineInventory !== "object") {
    throw artifactResignError("baseline license inventory policy projection is missing", "derive the pre-outer descriptor from the accepted packaged inventory before rebinding");
  }
  const nestedCodeResources = sortUniquePaths(codeResourcePaths, "pre-outer nested CodeResources paths");
  if (nestedCodeResources.includes(MACOS_OUTER_CODE_RESOURCES_PATH)) {
    throw artifactResignError("pre-outer descriptor input includes the outer CodeResources path", "observe only nested CodeResources after nested signing and before the final outer sign");
  }
  const excludedPaths = sortUniquePaths(
    baselinePackageInputs.artifactInput.excludedPaths,
    "pre-outer artifact-input excluded paths",
  );
  const projection = inventoryPolicyProjection(baselineInventory);
  return createSigningBoundDescriptor({
    phase: MACOS_PRE_OUTER_SIGNING_BOUND_PHASE,
    machoPaths,
    machoPayloads,
    codeResourcePaths: nestedCodeResources,
    licenseInventoryPath,
    ordinaryArtifactInput: {
      schema: MACOS_SIGNING_BOUND_ARTIFACT_INPUT_SCHEMA,
      algorithm: "sha256",
      digest: digestArtifactEntries(preOuterEntries, { excludedPaths }),
      entryCount: countArtifactInputEntries(preOuterEntries, excludedPaths),
      excludedPaths,
    },
    inventoryProjection: {
      schema: MACOS_SIGNING_BOUND_PROJECTION_SCHEMA,
      algorithm: "sha256",
      digest: digestJson(projection),
      projection,
    },
  });
}

function validateOrdinaryArtifactInputDescriptor(descriptor, macho, codeResources, licenseInventory) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) || descriptor.schema !== MACOS_SIGNING_BOUND_ARTIFACT_INPUT_SCHEMA || descriptor.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(descriptor.digest ?? "") || !Number.isInteger(descriptor.entryCount) || descriptor.entryCount < 0 || !Array.isArray(descriptor.excludedPaths)) {
    throw artifactResignError("pre-outer ordinary artifact-input closure is missing or malformed", "record its SHA-256, count, and exact excluded Mach-O/inventory paths in the versioned descriptor");
  }
  const excludedPaths = sortUniquePaths(descriptor.excludedPaths, "pre-outer artifact-input excluded paths");
  if (JSON.stringify(excludedPaths) !== JSON.stringify(descriptor.excludedPaths) || excludedPaths.includes(MACOS_OUTER_CODE_RESOURCES_PATH) || codeResources.some((candidate) => excludedPaths.includes(candidate)) || !excludedPaths.includes(licenseInventory) || macho.some((candidate) => !excludedPaths.includes(candidate))) {
    throw artifactResignError("pre-outer ordinary artifact-input exclusions are not the accepted scope", "exclude the inventory, all 46 Mach-O paths, and nested signing metadata without binding the outer CodeResources");
  }
}

function validateInventoryProjectionDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) || descriptor.schema !== MACOS_SIGNING_BOUND_PROJECTION_SCHEMA || descriptor.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(descriptor.digest ?? "") || !descriptor.projection || typeof descriptor.projection !== "object" || Array.isArray(descriptor.projection) || descriptor.digest !== digestJson(descriptor.projection)) {
    throw artifactResignError("pre-outer inventory legal/component/notice projection is missing or stale", "bind the unchanged accepted inventory policy projection before writing rebound metadata");
  }
}

function validatePreOuterSigningBound(descriptor) {
  validateSigningBoundDescriptor(descriptor);
  if (descriptor.phase !== MACOS_PRE_OUTER_SIGNING_BOUND_PHASE) {
    throw artifactResignError("a pre-outer signing-bound descriptor was not supplied", "use the nested post-signing descriptor for package-input and inventory rebind");
  }
  return descriptor;
}

function validateFinalSigningBound(descriptor) {
  validateSigningBoundDescriptor(descriptor);
  if (descriptor.phase !== MACOS_FINAL_SIGNING_BOUND_PHASE) {
    throw artifactResignError("a final signing-bound descriptor was not supplied", "use the complete post-outer Mach-O and CodeResources observation for final evidence");
  }
  return descriptor;
}

function assertPreOuterArtifactInputScope({ signingBound, excludedPaths, entries, label }) {
  const expectedExcludedPaths = sortUniquePaths(excludedPaths, `${label} pre-outer excluded paths`);
  const descriptor = signingBound.ordinaryArtifactInput;
  if (JSON.stringify(descriptor.excludedPaths) !== JSON.stringify(expectedExcludedPaths)) {
    throw artifactResignError(`${label} pre-outer excluded paths differ from the descriptor`, "derive package-input and inventory exclusions from the same nested post-signing scope");
  }
  const digest = digestArtifactEntries(entries ?? [], { excludedPaths: expectedExcludedPaths });
  const count = countArtifactInputEntries(entries ?? [], expectedExcludedPaths);
  if (descriptor.digest !== digest || descriptor.entryCount !== count) {
    throw artifactResignError(`${label} pre-outer ordinary artifact-input closure differs from the descriptor`, "recompute the descriptor from the exact post-nested entry observation before writing inventory metadata");
  }
}

export function normalizeMachOPayload(bytes, relativePath = "Mach-O") {
  const buffer = Buffer.from(bytes ?? "");
  const slices = parseMachOSlices(buffer, relativePath);
  const normalizedBuffer = Buffer.from(buffer);
  for (const slice of slices) {
    for (const field of slice.mutableFields) zeroMachoField(normalizedBuffer, field, relativePath);
  }
  const ranges = slices.flatMap((slice) => slice.signatureRanges).sort((left, right) => left.offset - right.offset || left.size - right.size);
  let cursor = 0;
  const digest = createHash("sha256");
  let payloadByteCount = 0;
  for (const range of ranges) {
    if (range.offset < cursor) {
      throw artifactResignError(`Mach-O ${relativePath} has overlapping LC_CODE_SIGNATURE ranges`, "retain one precise non-overlapping signature data range per Mach-O slice");
    }
    digest.update(normalizedBuffer.subarray(cursor, range.offset));
    payloadByteCount += range.offset - cursor;
    cursor = range.offset + range.size;
  }
  digest.update(normalizedBuffer.subarray(cursor));
  payloadByteCount += normalizedBuffer.byteLength - cursor;
  return {
    schema: MACOS_MACHO_PAYLOAD_SCHEMA,
    normalizer: MACOS_MACHO_PAYLOAD_NORMALIZER,
    algorithm: "sha256",
    payloadSha256: digest.digest("hex"),
    payloadByteCount,
    fileByteCount: buffer.byteLength,
    sliceCount: slices.length,
    signatureRangeCount: ranges.length,
    metadata: createMachOPayloadMetadata(slices),
  };
}

export function validateMachOPayloadBindings(bindings, machoPaths = null) {
  if (!Array.isArray(bindings)) {
    throw artifactResignError("Mach-O payload bindings are missing", "parse every regular Mach-O and bind bytes excluding each LC_CODE_SIGNATURE data range");
  }
  const normalized = bindings
    .map((binding) => {
      if (!binding || typeof binding !== "object" || typeof binding.path !== "string") {
        throw artifactResignError("Mach-O payload binding is malformed", "record one normalized payload binding for each in-package Mach-O");
      }
      const pathValue = normalizeRelativePath(binding.path, "Mach-O payload path");
      if (binding.schema !== MACOS_MACHO_PAYLOAD_SCHEMA || binding.normalizer !== MACOS_MACHO_PAYLOAD_NORMALIZER || binding.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(binding.payloadSha256 ?? "") || !Number.isInteger(binding.payloadByteCount) || binding.payloadByteCount <= 0 || !Number.isInteger(binding.fileByteCount) || binding.fileByteCount <= 0 || !Number.isInteger(binding.sliceCount) || binding.sliceCount <= 0 || !Number.isInteger(binding.signatureRangeCount) || binding.signatureRangeCount !== binding.sliceCount) {
        throw artifactResignError(`Mach-O payload binding for ${pathValue} is malformed or uses an imprecise normalizer`, "bind the parsed Mach-O payload while excluding only signature data ranges and canonicalizing exact derived LC_CODE_SIGNATURE/__LINKEDIT metadata");
      }
      const metadata = binding.metadata === undefined ? null : validateMachOPayloadMetadata(binding.metadata, pathValue, binding.fileByteCount, binding.sliceCount);
      return {
        path: pathValue,
        schema: binding.schema,
        normalizer: binding.normalizer,
        algorithm: binding.algorithm,
        payloadSha256: binding.payloadSha256,
        payloadByteCount: binding.payloadByteCount,
        fileByteCount: binding.fileByteCount,
        sliceCount: binding.sliceCount,
        signatureRangeCount: binding.signatureRangeCount,
        ...(metadata === null ? {} : { metadata }),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((binding) => binding.path)).size !== normalized.length) {
    throw artifactResignError("Mach-O payload bindings contain a duplicate path", "record each parsed Mach-O payload exactly once");
  }
  if (machoPaths !== null) {
    const expected = sortUniquePaths(machoPaths, "Mach-O signing-bound paths");
    if (JSON.stringify(normalized.map((binding) => binding.path)) !== JSON.stringify(expected)) {
      throw artifactResignError("Mach-O payload bindings do not cover the exact Mach-O path set", "parse every accepted Mach-O and remove extra or missing payload bindings");
    }
  }
  return normalized;
}

export function buildArtifactBaseline({ manifest, manifestBytes, machoPayloads, sourceAncestorSnapshotDigest = ACCEPTED_M7_F23_SOURCE_SNAPSHOT } = {}) {
  const candidateSnapshot = manifest?.candidateSnapshot;
  const baseline = {
    schema: ACCEPTED_ARTIFACT_BASELINE.schema,
    sourceAncestorSnapshotDigest,
    sourceSnapshotDigest: candidateSnapshot?.digest,
    sourceSnapshotHead: candidateSnapshot?.head,
    packageInputDigest: manifest?.packageInputs?.digest,
    artifactInputDigest: manifest?.packageInputs?.artifactInput?.digest,
    artifactDigest: manifest?.artifactDigest,
    signatureStateDigest: manifest?.signing?.signatureStateDigest,
    manifestSha256: manifestBytes === undefined || manifestBytes === null ? null : sha256(manifestBytes),
    paseoCommit: candidateSnapshot?.paseoCommit ?? manifest?.paseoCommit,
    machoCount: Array.isArray(manifest?.macho) ? manifest.macho.length : null,
    codeResourcesCount: Array.isArray(manifest?.entries) ? manifest.entries.filter((entry) => isCodeResourcesPath(entry.path)).length : null,
    codeObjectCount: Array.isArray(manifest?.macho) ? manifest.macho.length + 1 : null,
    machoPayloads: validateMachOPayloadBindings(machoPayloads, manifest?.macho ?? null),
  };
  return validateArtifactBaseline(baseline);
}

export function validateArtifactBaseline(baseline) {
  const expectedKeys = [
    "artifactDigest",
    "artifactInputDigest",
    "codeObjectCount",
    "codeResourcesCount",
    "machoCount",
    "machoPayloads",
    "manifestSha256",
    "packageInputDigest",
    "paseoCommit",
    "schema",
    "signatureStateDigest",
    "sourceAncestorSnapshotDigest",
    "sourceSnapshotDigest",
    "sourceSnapshotHead",
  ];
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline) || JSON.stringify(Object.keys(baseline).sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expectedKeys)) {
    throw artifactResignError("artifact baseline schema is missing or contains unsupported fields", "derive one fresh baseline from the accepted local package-source manifest and Mach-O payloads");
  }
  const digestFields = ["sourceSnapshotDigest", "packageInputDigest", "artifactInputDigest", "artifactDigest", "signatureStateDigest", "manifestSha256"];
  if (baseline.schema !== ACCEPTED_ARTIFACT_BASELINE.schema || baseline.sourceAncestorSnapshotDigest !== ACCEPTED_ARTIFACT_BASELINE.sourceAncestorSnapshotDigest || baseline.paseoCommit !== ACCEPTED_ARTIFACT_BASELINE.paseoCommit || baseline.machoCount !== ACCEPTED_ARTIFACT_BASELINE.machoCount || baseline.codeResourcesCount !== ACCEPTED_ARTIFACT_BASELINE.codeResourcesCount || baseline.codeObjectCount !== ACCEPTED_ARTIFACT_BASELINE.codeObjectCount || !/^[a-f0-9]{40}$/u.test(baseline.sourceSnapshotHead ?? "") || digestFields.some((name) => !/^[a-f0-9]{64}$/u.test(baseline[name] ?? ""))) {
    throw artifactResignError("artifact baseline lineage, shape, or digest evidence is invalid", `derive a fresh baseline descended from M7-F23 source snapshot ${ACCEPTED_M7_F23_SOURCE_SNAPSHOT} with 46 nested Mach-O objects and 10 CodeResources files`);
  }
  if (validateMachOPayloadBindings(baseline.machoPayloads).length !== baseline.machoCount) {
    throw artifactResignError("artifact baseline Mach-O payload evidence count is stale", "record one exact LC_CODE_SIGNATURE-excluded payload binding for each of the 46 nested Mach-O objects");
  }
  return baseline;
}

export async function bindMachOPayloads({ bundlePath, machoPaths } = {}) {
  const paths = sortUniquePaths(machoPaths, "Mach-O payload paths");
  const bindings = [];
  for (const relativePath of paths) {
    const absolutePath = path.resolve(bundlePath, relativePath);
    const inspected = await lstat(absolutePath).catch(() => null);
    if (!inspected?.isFile() || inspected.isSymbolicLink()) {
      throw artifactResignError(`Mach-O payload path ${relativePath} is not a regular non-symlink file`, "restore the exact regular Mach-O before the first codesign call");
    }
    bindings.push({ path: relativePath, ...normalizeMachOPayload(await readFile(absolutePath), relativePath) });
  }
  return validateMachOPayloadBindings(bindings, paths);
}

export function assertMachOPayloadClosure({ baselinePayloads, finalPayloads } = {}) {
  const baseline = validateMachOPayloadBindings(baselinePayloads);
  const final = validateMachOPayloadBindings(finalPayloads, baseline.map((binding) => binding.path));
  for (const before of baseline) {
    const after = final.find((binding) => binding.path === before.path);
    if (!after || after.payloadSha256 !== before.payloadSha256 || after.payloadByteCount !== before.payloadByteCount || after.sliceCount !== before.sliceCount || after.signatureRangeCount !== before.signatureRangeCount) {
      throw artifactResignError(`Mach-O payload changed outside LC_CODE_SIGNATURE data at ${before.path}`, "discard the candidate and restore the accepted Mach-O bytes; only signature data ranges may mutate");
    }
    if (!before.metadata || !after.metadata) {
      throw artifactResignError(`Mach-O signing-derived metadata evidence is missing at ${before.path}`, "rebind both baseline and final Mach-O observations with the exact LC_CODE_SIGNATURE/__LINKEDIT metadata normalizer");
    }
    assertMachOPayloadMetadataClosure(before, after);
  }
  return final;
}

function createMachOPayloadMetadata(slices) {
  return {
    schema: MACOS_MACHO_DERIVED_METADATA_SCHEMA,
    slices: slices.map((slice) => ({
      offset: slice.offset,
      size: slice.size,
      pageSize: slice.pageSize,
      signatureCommandOffset: slice.signature.commandOffset,
      signatureDataOffset: slice.signature.dataOffset,
      signatureDataSize: slice.signature.dataSize,
      linkeditCommandOffset: slice.linkedit.commandOffset,
      linkeditFileOffset: slice.linkedit.fileoff,
      linkeditFileSize: slice.linkedit.filesize,
      linkeditVmAddress: slice.linkedit.vmaddr,
      linkeditVmSize: slice.linkedit.vmsize,
      requiredLinkeditVmSize: slice.linkedit.requiredVmsize,
    })),
  };
}

function validateMachOPayloadMetadata(metadata, relativePath, fileByteCount, expectedSliceCount) {
  const metadataKeys = ["schema", "slices"];
  const sliceKeys = [
    "linkeditCommandOffset",
    "linkeditFileOffset",
    "linkeditFileSize",
    "linkeditVmAddress",
    "linkeditVmSize",
    "offset",
    "pageSize",
    "requiredLinkeditVmSize",
    "signatureCommandOffset",
    "signatureDataOffset",
    "signatureDataSize",
    "size",
  ];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.schema !== MACOS_MACHO_DERIVED_METADATA_SCHEMA || JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(metadataKeys.sort()) || !Array.isArray(metadata.slices) || metadata.slices.length !== expectedSliceCount) {
    throw artifactResignError(`Mach-O ${relativePath} derived metadata is missing or malformed`, "bind the exact parsed LC_CODE_SIGNATURE and __LINKEDIT metadata before accepting the Mach-O");
  }
  const normalized = metadata.slices.map((slice, index) => {
    if (!slice || typeof slice !== "object" || Array.isArray(slice) || JSON.stringify(Object.keys(slice).sort()) !== JSON.stringify(sliceKeys)) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} derived metadata is malformed`, "record only the exact bounded signature and __LINKEDIT fields");
    }
    const integerFields = [
      "offset",
      "size",
      "pageSize",
      "signatureCommandOffset",
      "signatureDataOffset",
      "signatureDataSize",
      "linkeditCommandOffset",
      "linkeditFileOffset",
      "linkeditFileSize",
      "linkeditVmAddress",
      "linkeditVmSize",
      "requiredLinkeditVmSize",
    ];
    if (integerFields.some((field) => !Number.isSafeInteger(slice[field]) || slice[field] < 0) || ![0x1000, 0x4000].includes(slice.pageSize) || slice.size <= 0 || !Number.isSafeInteger(slice.offset + slice.size) || slice.offset + slice.size > fileByteCount || slice.signatureDataSize <= 0 || !Number.isSafeInteger(slice.signatureDataOffset + slice.signatureDataSize) || slice.signatureDataOffset + slice.signatureDataSize !== slice.size || slice.linkeditFileSize <= 0 || !Number.isSafeInteger(slice.linkeditFileOffset + slice.linkeditFileSize) || slice.linkeditFileOffset + slice.linkeditFileSize !== slice.size || slice.signatureDataOffset < slice.linkeditFileOffset || slice.signatureCommandOffset < slice.offset || slice.signatureCommandOffset >= slice.offset + slice.size || slice.linkeditCommandOffset < slice.offset || slice.linkeditCommandOffset >= slice.offset + slice.size || slice.linkeditVmSize !== slice.requiredLinkeditVmSize || slice.requiredLinkeditVmSize !== roundUpMacho(slice.linkeditFileSize, slice.pageSize)) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} derived metadata is inconsistent with its bounded signature extent`, "restore the exact LC_CODE_SIGNATURE end, __LINKEDIT filesize, and page-rounded vmsize relationship");
    }
    return {
      offset: slice.offset,
      size: slice.size,
      pageSize: slice.pageSize,
      signatureCommandOffset: slice.signatureCommandOffset,
      signatureDataOffset: slice.signatureDataOffset,
      signatureDataSize: slice.signatureDataSize,
      linkeditCommandOffset: slice.linkeditCommandOffset,
      linkeditFileOffset: slice.linkeditFileOffset,
      linkeditFileSize: slice.linkeditFileSize,
      linkeditVmAddress: slice.linkeditVmAddress,
      linkeditVmSize: slice.linkeditVmSize,
      requiredLinkeditVmSize: slice.requiredLinkeditVmSize,
    };
  });
  const ranges = normalized.map((slice) => ({ offset: slice.offset, size: slice.size })).sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].offset + ranges[index - 1].size > ranges[index].offset) {
      throw artifactResignError(`Mach-O ${relativePath} derived metadata has overlapping slices`, "retain complete non-overlapping Mach-O slices");
    }
  }
  return { schema: MACOS_MACHO_DERIVED_METADATA_SCHEMA, slices: normalized };
}

function assertMachOPayloadMetadataClosure(before, after) {
  const beforeSlices = before.metadata.slices;
  const afterSlices = after.metadata.slices;
  if (beforeSlices.length !== afterSlices.length) {
    throw artifactResignError(`Mach-O slice count changed at ${before.path}`, "retain the exact thin or fat architecture closure before accepting the candidate");
  }
  let sliceSizeDelta = 0;
  for (let index = 0; index < beforeSlices.length; index += 1) {
    const prior = beforeSlices[index];
    const current = afterSlices[index];
    const immutable = [
      "offset",
      "pageSize",
      "signatureCommandOffset",
      "signatureDataOffset",
      "linkeditCommandOffset",
      "linkeditFileOffset",
      "linkeditVmAddress",
    ];
    if (immutable.some((field) => prior[field] !== current[field])) {
      throw artifactResignError(`Mach-O signing-derived layout changed at ${before.path} slice ${index}`, "restore the exact LC_CODE_SIGNATURE dataoff and __LINKEDIT segment identity/layout; only derived size fields may change");
    }
    if (prior.size - prior.signatureDataSize !== current.size - current.signatureDataSize) {
      throw artifactResignError(`Mach-O LC_CODE_SIGNATURE dataoff prefix changed at ${before.path} slice ${index}`, "restore the exact executable and pre-signature slice bytes");
    }
    sliceSizeDelta += current.size - prior.size;
  }
  if (after.fileByteCount - before.fileByteCount !== sliceSizeDelta) {
    throw artifactResignError(`Mach-O file extent changed outside signature data at ${before.path}`, "retain only the final LC_CODE_SIGNATURE extent change and restore unrelated file regions");
  }
}

function zeroMachoField(buffer, field, relativePath) {
  try {
    if (field.width === 4) {
      if (field.littleEndian) buffer.writeUInt32LE(0, field.offset);
      else buffer.writeUInt32BE(0, field.offset);
      return;
    }
    if (field.width === 8) {
      if (field.littleEndian) buffer.writeBigUInt64LE(0n, field.offset);
      else buffer.writeBigUInt64BE(0n, field.offset);
      return;
    }
  } catch {
    // The parser has already checked the field bounds; keep this diagnostic
    // actionable if a future field definition violates that proof.
  }
  throw artifactResignError(`Mach-O ${relativePath} has an unsupported derived metadata field width`, "retain only the fixed 32-bit or 64-bit LC_CODE_SIGNATURE/__LINKEDIT fields");
}

function parseMachOSlices(buffer, relativePath) {
  if (buffer.byteLength < 4) {
    throw artifactResignError(`Mach-O ${relativePath} is shorter than its magic`, "retain a complete regular Mach-O before signing");
  }
  const fatMagic = buffer.readUInt32BE(0);
  if (fatMagic === 0xcafebabe || fatMagic === 0xcafebabf) {
    const isFat64 = fatMagic === 0xcafebabf;
    if (buffer.byteLength < 8) {
      throw artifactResignError(`Mach-O ${relativePath} has a truncated fat header`, "retain a complete Mach-O slice table before signing");
    }
    const sliceCount = buffer.readUInt32BE(4);
    const archSize = isFat64 ? 32 : 20;
    const tableEnd = 8 + sliceCount * archSize;
    if (!Number.isSafeInteger(tableEnd) || sliceCount <= 0 || tableEnd > buffer.byteLength) {
      throw artifactResignError(`Mach-O ${relativePath} has an invalid fat slice table`, "retain one complete bounded Mach-O slice table");
    }
    const slices = [];
    const tableArchitectures = [];
    const architectureKeys = new Map();
    for (let index = 0; index < sliceCount; index += 1) {
      const archOffset = 8 + index * archSize;
      const tableCputype = buffer.readUInt32BE(archOffset);
      const tableCpusubtype = buffer.readUInt32BE(archOffset + 4);
      const architectureKey = machoArchitectureKey(tableCputype, tableCpusubtype);
      const priorIndex = architectureKeys.get(architectureKey);
      if (priorIndex !== undefined) {
        throw artifactResignError(`Mach-O ${relativePath} has duplicate FAT architecture key ${architectureKey} at slices ${priorIndex} and ${index}`, "retain one FAT architecture table entry for each exact CPU type/subtype pair in deterministic table order");
      }
      architectureKeys.set(architectureKey, index);
      const sliceOffset = isFat64 ? readMachoInteger(buffer, archOffset + 8, 8, false, relativePath, "fat slice offset") : readMachoInteger(buffer, archOffset + 8, 4, false, relativePath, "fat slice offset");
      const sliceSize = isFat64 ? readMachoInteger(buffer, archOffset + 16, 8, false, relativePath, "fat slice size") : readMachoInteger(buffer, archOffset + 12, 4, false, relativePath, "fat slice size");
      const alignmentPower = buffer.readUInt32BE(archOffset + (isFat64 ? 24 : 16));
      if (alignmentPower > 31 || !Number.isSafeInteger(sliceOffset) || !Number.isSafeInteger(sliceSize) || sliceSize <= 0 || sliceOffset < tableEnd || !Number.isSafeInteger(sliceOffset + sliceSize) || sliceOffset + sliceSize > buffer.byteLength || sliceOffset % (2 ** alignmentPower) !== 0) {
        throw artifactResignError(`Mach-O ${relativePath} has an invalid fat slice range`, "retain complete aligned non-overlapping Mach-O slices before signing");
      }
      const slice = parseThinMachOSlice(buffer, sliceOffset, sliceSize, relativePath, index);
      tableArchitectures.push({ cputype: tableCputype, cpusubtype: tableCpusubtype, key: architectureKey });
      slice.mutableFields.push({ offset: archOffset + (isFat64 ? 16 : 12), width: isFat64 ? 8 : 4, littleEndian: false });
      slices.push(slice);
    }
    const ranges = slices.map((slice) => ({ offset: slice.offset, size: slice.size })).sort((left, right) => left.offset - right.offset);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1].offset + ranges[index - 1].size > ranges[index].offset) {
        throw artifactResignError(`Mach-O ${relativePath} has overlapping fat slices`, "retain one bounded non-overlapping Mach-O slice for each architecture");
      }
    }
    for (let index = 0; index < slices.length; index += 1) {
      const table = tableArchitectures[index];
      const slice = slices[index];
      if (slice.cputype !== table.cputype || slice.cpusubtype !== table.cpusubtype) {
        throw artifactResignError(`Mach-O ${relativePath} FAT architecture key mismatch at slice ${index}: table ${table.key}, inner ${machoArchitectureKey(slice.cputype, slice.cpusubtype)}`, "make each FAT CPU type/subtype pair exactly match its bounded inner Mach-O header");
      }
    }
    return slices;
  }
  return [parseThinMachOSlice(buffer, 0, buffer.byteLength, relativePath, 0)];
}

function parseThinMachOSlice(buffer, offset, size, relativePath, index) {
  const end = offset + size;
  if (size < 28) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} is shorter than a Mach-O header`, "retain a complete supported Mach-O header");
  }
  const magicLittle = buffer.readUInt32LE(offset);
  const magicBig = buffer.readUInt32BE(offset);
  const littleEndian = magicLittle === 0xfeedface || magicLittle === 0xfeedfacf;
  const bigEndian = magicBig === 0xfeedface || magicBig === 0xfeedfacf;
  if (!littleEndian && !bigEndian) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has unsupported magic`, "retain a thin or fat Mach-O slice with a supported 32-bit or 64-bit header");
  }
  if (littleEndian && bigEndian) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has ambiguous byte order`, "retain one deterministic Mach-O header encoding");
  }
  const is64 = littleEndian ? magicLittle === 0xfeedfacf : magicBig === 0xfeedfacf;
  const read = (position) => littleEndian ? buffer.readUInt32LE(position) : buffer.readUInt32BE(position);
  const headerSize = is64 ? 32 : 28;
  const cputype = read(offset + 4);
  const cpusubtype = read(offset + 8);
  const pageSize = machoPageSize(cputype, relativePath, index);
  const commandCount = read(offset + 16);
  const commandBytes = read(offset + 20);
  const commandsEnd = offset + headerSize + commandBytes;
  if (!Number.isSafeInteger(commandCount) || !Number.isSafeInteger(commandBytes) || !Number.isSafeInteger(commandsEnd) || commandsEnd > end) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has load commands outside its bounded slice`, "retain complete bounded Mach-O load commands before signing");
  }
  let commandOffset = offset + headerSize;
  const signatureCommands = [];
  const segments = [];
  for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
    if (commandOffset + 8 > commandsEnd) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} has a truncated load command`, "retain complete Mach-O load commands before signing");
    }
    const command = read(commandOffset);
    const commandSize = read(commandOffset + 4);
    if (commandSize < 8 || commandOffset + commandSize > commandsEnd) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} has an invalid load-command size`, "retain deterministic bounded Mach-O load commands before signing");
    }
    if (commandSize % 4 !== 0) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} load command ${commandIndex} has cmdsize ${commandSize}, which is not divisible by 4`, "retain 4-byte-aligned Mach-O load-command sizes before signing");
    }
    if (command === 0x1d) {
      if (commandSize !== 16) {
        throw artifactResignError(`Mach-O ${relativePath} slice ${index} has a non-canonical LC_CODE_SIGNATURE command size`, "retain exactly one 16-byte LC_CODE_SIGNATURE command per Mach-O slice");
      }
      const dataOffset = read(commandOffset + 8);
      const dataSize = read(commandOffset + 12);
      if (dataSize <= 0 || dataOffset < headerSize + commandBytes || dataOffset + dataSize > size) {
        throw artifactResignError(`Mach-O ${relativePath} slice ${index} has an invalid LC_CODE_SIGNATURE data range`, "retain one complete in-slice code-signature data range");
      }
      signatureCommands.push({ commandOffset, dataOffset, dataSize, dataSizeFieldOffset: commandOffset + 12 });
    }
    if (command === 0x1 || command === 0x19) {
      const segment64 = command === 0x19;
      const minimumSize = segment64 ? 72 : 56;
      const sectionSize = segment64 ? 80 : 68;
      const nsectsOffset = commandOffset + (segment64 ? 64 : 48);
      if (commandSize < minimumSize) {
        throw artifactResignError(`Mach-O ${relativePath} slice ${index} has a truncated segment command`, "retain complete bounded segment load commands");
      }
      const nsects = read(nsectsOffset);
      if (!Number.isSafeInteger(nsects) || minimumSize + nsects * sectionSize > commandSize) {
        throw artifactResignError(`Mach-O ${relativePath} slice ${index} has segment sections outside its command`, "retain complete bounded segment and section commands");
      }
      const width = segment64 ? 8 : 4;
      const vmaddr = readMachoInteger(buffer, commandOffset + 24, width, littleEndian, relativePath, "segment vmaddr");
      const vmsize = readMachoInteger(buffer, commandOffset + (segment64 ? 32 : 28), width, littleEndian, relativePath, "segment vmsize");
      const fileoff = readMachoInteger(buffer, commandOffset + (segment64 ? 40 : 32), width, littleEndian, relativePath, "segment fileoff");
      const filesize = readMachoInteger(buffer, commandOffset + (segment64 ? 48 : 36), width, littleEndian, relativePath, "segment filesize");
      const segmentEnd = fileoff + filesize;
      if (!Number.isSafeInteger(segmentEnd) || segmentEnd > size || !Number.isSafeInteger(vmaddr + vmsize)) {
        throw artifactResignError(`Mach-O ${relativePath} slice ${index} has a segment range outside its bounded slice`, "retain complete non-overlapping segment file and virtual ranges");
      }
      const name = buffer.toString("ascii", commandOffset + 8, commandOffset + 24).replace(/\0.*$/u, "");
      segments.push({
        commandOffset,
        command,
        name,
        vmaddr,
        vmsize,
        fileoff,
        filesize,
        fileRangeEnd: segmentEnd,
        width,
        vmSizeFieldOffset: commandOffset + (segment64 ? 32 : 28),
        fileSizeFieldOffset: commandOffset + (segment64 ? 48 : 36),
      });
    }
    commandOffset += commandSize;
  }
  if (commandOffset !== commandsEnd || signatureCommands.length !== 1) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has ${signatureCommands.length} LC_CODE_SIGNATURE commands`, "retain exactly one precise LC_CODE_SIGNATURE data range per Mach-O slice");
  }
  const fileRanges = segments.filter((segment) => segment.filesize > 0).sort((left, right) => left.fileoff - right.fileoff);
  for (let rangeIndex = 1; rangeIndex < fileRanges.length; rangeIndex += 1) {
    if (fileRanges[rangeIndex - 1].fileRangeEnd > fileRanges[rangeIndex].fileoff) {
      throw artifactResignError(`Mach-O ${relativePath} slice ${index} has overlapping segment file ranges`, "retain non-overlapping bounded Mach-O segment layouts");
    }
  }
  const linkeditSegments = segments.filter((segment) => segment.name === "__LINKEDIT");
  if (linkeditSegments.length !== 1) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has ${linkeditSegments.length} __LINKEDIT segments`, "retain exactly one bounded __LINKEDIT segment for signature-derived metadata validation");
  }
  const signature = signatureCommands[0];
  const linkedit = linkeditSegments[0];
  if (linkedit.fileoff % pageSize !== 0 || linkedit.vmaddr % pageSize !== 0 || signature.dataOffset < linkedit.fileoff || signature.dataOffset + signature.dataSize !== size || linkedit.fileoff + linkedit.filesize !== size) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has an inconsistent LC_CODE_SIGNATURE/__LINKEDIT extent`, "retain a signature ending at the slice end with __LINKEDIT filesize derived from that extent");
  }
  const requiredVmsize = roundUpMacho(linkedit.filesize, pageSize);
  if (linkedit.vmsize !== requiredVmsize) {
    throw artifactResignError(`Mach-O ${relativePath} slice ${index} has an inconsistent __LINKEDIT vmsize`, "set __LINKEDIT vmsize to the exact page-rounded final __LINKEDIT filesize");
  }
  linkedit.requiredVmsize = requiredVmsize;
  return {
    offset,
    size,
    cputype,
    cpusubtype,
    pageSize,
    signatureRanges: [{ offset: offset + signature.dataOffset, size: signature.dataSize }],
    signature,
    linkedit,
    mutableFields: [
      { offset: signature.dataSizeFieldOffset, width: 4, littleEndian },
      { offset: linkedit.fileSizeFieldOffset, width: linkedit.width, littleEndian },
      { offset: linkedit.vmSizeFieldOffset, width: linkedit.width, littleEndian },
    ],
  };
}

function machoArchitectureKey(cputype, cpusubtype) {
  return `${formatMachoWord(cputype)}:${formatMachoWord(cpusubtype)}`;
}

function formatMachoWord(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function readMachoInteger(buffer, offset, width, littleEndian, relativePath, fieldName) {
  try {
    if (width === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (width === 8) {
      const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("outside safe integer range");
      return Number(value);
    }
  } catch {
    throw artifactResignError(`Mach-O ${relativePath} has an unreadable ${fieldName}`, "retain supported bounded 32-bit or 64-bit Mach-O fields");
  }
  throw artifactResignError(`Mach-O ${relativePath} has an unsupported ${fieldName} width`, "retain supported bounded 32-bit or 64-bit Mach-O fields");
}

function machoPageSize(cputype, relativePath, index) {
  if ([0x00000007, 0x0000000c, 0x01000007].includes(cputype)) return 0x1000;
  if ([0x0100000c, 0x0200000c].includes(cputype)) return 0x4000;
  throw artifactResignError(`Mach-O ${relativePath} slice ${index} uses unsupported CPU type 0x${cputype.toString(16)}`, "retain a bounded x86, x86_64, arm, or arm64 Mach-O slice");
}

function roundUpMacho(value, alignment) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(alignment) || value < 0 || alignment <= 0) {
    throw artifactResignError("Mach-O size arithmetic is outside the safe integer range", "retain bounded Mach-O segment and signature sizes");
  }
  const rounded = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(rounded)) throw artifactResignError("Mach-O rounded size is outside the safe integer range", "retain bounded Mach-O segment and signature sizes");
  return rounded;
}

export function assertExternalArtifactStageRoot({ stageRoot, repositoryRoot = process.cwd(), canonicalReleaseRoot = null } = {}) {
  if (typeof stageRoot !== "string" || !path.isAbsolute(stageRoot)) {
    throw artifactResignError(`staged root is not an absolute path: ${String(stageRoot)}`, "supply one explicit absolute temporary staging root outside the repository");
  }
  const resolvedStageRoot = path.resolve(stageRoot);
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const resolvedReleaseRoot = path.resolve(canonicalReleaseRoot ?? path.join(resolvedRepositoryRoot, "release", "macos"));
  if (isSameOrInside(resolvedRepositoryRoot, resolvedStageRoot)) {
    throw artifactResignError(`staged root ${resolvedStageRoot} is inside the canonical repository`, "stage the copied app and manifest outside the canonical workspace");
  }
  if (isSameOrInside(resolvedReleaseRoot, resolvedStageRoot)) {
    throw artifactResignError(`staged root ${resolvedStageRoot} is inside the canonical release artifact root`, "stage the copied app and manifest outside release/macos");
  }
  const canonicalBundle = path.join(resolvedReleaseRoot, MACOS_ARTIFACT_STAGE_BUNDLE_NAME);
  const canonicalManifest = path.join(resolvedReleaseRoot, MACOS_ARTIFACT_STAGE_MANIFEST_NAME);
  const stagedBundle = path.join(resolvedStageRoot, MACOS_ARTIFACT_STAGE_BUNDLE_NAME);
  const stagedManifest = path.join(resolvedStageRoot, MACOS_ARTIFACT_STAGE_MANIFEST_NAME);
  if (path.resolve(stagedBundle) === path.resolve(canonicalBundle) || path.resolve(stagedManifest) === path.resolve(canonicalManifest)) {
    throw artifactResignError("staged paths resolve to the canonical release artifact or manifest", "use a distinct explicit staged root; never write release/macos");
  }
  return {
    stageRoot: resolvedStageRoot,
    repositoryRoot: resolvedRepositoryRoot,
    releaseRoot: resolvedReleaseRoot,
    bundlePath: stagedBundle,
    manifestPath: stagedManifest,
    markerPath: path.join(resolvedStageRoot, MACOS_ARTIFACT_STAGE_MARKER_NAME),
  };
}

export async function validateArtifactStageRoot({ stageRoot, repositoryRoot = process.cwd(), canonicalReleaseRoot = null, markerPath = null, ownerMode = false } = {}) {
  const paths = assertExternalArtifactStageRoot({ stageRoot, repositoryRoot, canonicalReleaseRoot });
  const stageStat = await lstat(paths.stageRoot).catch(() => null);
  if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) {
    throw artifactResignError(`staged root is not a regular non-symlink directory: ${paths.stageRoot}`, "create one explicit temporary staging directory and copy only the accepted app and manifest into it");
  }
  const stageRealPath = await realpath(paths.stageRoot).catch(() => null);
  if (!stageRealPath || stageRealPath !== paths.stageRoot) {
    throw artifactResignError(`staged root realpath differs from its explicit path: ${paths.stageRoot}`, "use the realpath of one non-symlink staging root");
  }
  const stageNames = (await readdir(paths.stageRoot)).sort((left, right) => left.localeCompare(right));
  const requiredStageNames = [MACOS_ARTIFACT_STAGE_BUNDLE_NAME, MACOS_ARTIFACT_STAGE_MANIFEST_NAME, MACOS_ARTIFACT_STAGE_MARKER_NAME];
  const ownerMetadataNames = [MACOS_ARTIFACT_OWNER_STATUS_NAME];
  const allowedStageNames = new Set([...requiredStageNames, ...(ownerMode ? ownerMetadataNames : [])]);
  if (stageNames.some((name) => !allowedStageNames.has(name)) || requiredStageNames.some((name) => !stageNames.includes(name)) || (ownerMode && !stageNames.includes(MACOS_ARTIFACT_OWNER_STATUS_NAME))) {
    throw artifactResignError(`staged root contains unexpected or missing entries: ${stageNames.join(", ")}`, ownerMode
      ? "retain only Meetless.app, composition-manifest.json, the F11 marker, and the one authoritative owner lifecycle status record"
      : "retain only Meetless.app, composition-manifest.json, and the owner stage marker");
  }
  const expectedMarkerPath = paths.markerPath;
  if (markerPath !== null && path.resolve(markerPath) !== expectedMarkerPath) {
    throw artifactResignError(`stage marker path ${markerPath} is not the fixed marker inside the staged root`, "keep the owner stage marker at .meetless-artifact-stage.json");
  }
  const markerStat = await lstat(expectedMarkerPath).catch(() => null);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw artifactResignError(`stage marker is not a regular non-symlink file: ${expectedMarkerPath}`, "create the owner-controlled stage marker before invoking the artifact transform");
  }
  const markerBytes = await readFile(expectedMarkerPath);
  const marker = parseJson(markerBytes, "stage marker");
  validateArtifactStageMarker(marker, { stageRoot: paths.stageRoot, stageRealPath });
  const bundleStat = await lstat(paths.bundlePath).catch(() => null);
  if (!bundleStat?.isDirectory() || bundleStat.isSymbolicLink()) {
    throw artifactResignError(`staged Meetless.app is not a regular non-symlink directory: ${paths.bundlePath}`, "copy the accepted Meetless.app directory into the explicit staged root");
  }
  const bundleRealPath = await realpath(paths.bundlePath).catch(() => null);
  if (!bundleRealPath || bundleRealPath !== paths.bundlePath) {
    throw artifactResignError(`staged Meetless.app realpath differs from its explicit path: ${paths.bundlePath}`, "remove symlink indirection from the staged app root");
  }
  const manifestStat = await lstat(paths.manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw artifactResignError(`staged composition manifest is not a regular non-symlink file: ${paths.manifestPath}`, "copy the accepted external composition manifest beside the staged app");
  }
  const manifestRealPath = await realpath(paths.manifestPath).catch(() => null);
  if (!manifestRealPath || manifestRealPath !== paths.manifestPath) {
    throw artifactResignError(`staged composition manifest realpath differs from its explicit path: ${paths.manifestPath}`, "remove symlink indirection from the staged external manifest");
  }
  const statusPath = path.join(paths.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
  let status = null;
  let statusIdentity = null;
  const parentBinding = ownerMode ? await captureOwnerParentBinding(paths.stageRoot, "owner status parent") : null;
  if (ownerMode) {
    const statusStat = await lstat(statusPath).catch(() => null);
    if (!statusStat?.isFile() || statusStat.isSymbolicLink()) {
      throw artifactResignError(`owner attempt status is not a regular non-symlink file: ${statusPath}`, "retain the owner status beside the marker and do not reuse an ambiguous stage");
    }
    statusIdentity = await captureRegularFileIdentity(statusPath, "owner attempt status");
    status = parseJson(statusIdentity.bytes, "owner attempt status");
    validateOwnerStatusDocument(status, { stageRoot: paths.stageRoot, markerBytes });
  }
  const writableSurface = await assertStageWritableSurface({ ...paths, statusPath: ownerMode ? statusPath : null });
  return { ...paths, statusPath: ownerMode ? statusPath : null, statusIdentity, evidencePath: null, parentBinding, ownerMode, status, stageRealPath, markerBytes, marker, writableSurface };
}

export async function assertStageWritableSurface({ stageRoot, bundlePath, manifestPath, markerPath, statusPath = null, evidencePath = null } = {}) {
  const candidates = [stageRoot, bundlePath, manifestPath, markerPath, statusPath].filter(Boolean);
  if (evidencePath && await lstat(evidencePath).catch(() => null)) candidates.push(evidencePath);
  const visited = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw artifactResignError(`staged writable path is not explicit: ${String(candidate)}`, "use the exact absolute stage root, app, manifest, and marker paths");
    }
    await inspectWritablePath(candidate, { visited, root: stageRoot });
  }
  return { count: visited.size, uid: currentUserId() };
}

async function inspectWritablePath(candidate, { visited, root }) {
  const inspected = await lstat(candidate).catch(() => null);
  if (!inspected) {
    throw artifactResignError(`staged writable path is missing: ${candidate}`, "restore the explicit staged app, manifest, and marker before signing");
  }
  const absolute = path.resolve(candidate);
  if (visited.has(absolute)) return;
  visited.add(absolute);
  if (inspected.isSymbolicLink()) return;
  if (inspected.uid !== currentUserId()) {
    throw artifactResignError(`staged path ${candidate} is owned by uid ${inspected.uid}, not current uid ${currentUserId()}`, "stage a private copy owned by the signing operator");
  }
  if ((inspected.mode & 0o022) !== 0) {
    throw artifactResignError(`staged path ${candidate} is group/world writable`, "remove group and world write permission from the staged candidate");
  }
  if (inspected.isFile()) {
    if (inspected.nlink !== 1) {
      throw artifactResignError(`staged regular file ${candidate} has ${inspected.nlink} hard links`, "copy the accepted file so no other path shares its inode before signing");
    }
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== absolute) {
      throw artifactResignError(`staged regular file ${candidate} resolves through a different realpath`, "remove indirection from every writable staged regular file");
    }
    return;
  }
  if (!inspected.isDirectory()) return;
  const names = await readdir(candidate);
  for (const name of names) await inspectWritablePath(path.join(candidate, name), { visited, root });
}

export async function acquireArtifactStageCapability({ stageRoot, markerBytes } = {}) {
  if (typeof stageRoot !== "string" || !path.isAbsolute(stageRoot)) {
    throw artifactResignError("stage capability root is not an explicit absolute path", "acquire the narrow stage capability only for the validated external stage root");
  }
  const lockPath = path.join(path.dirname(stageRoot), `.${path.basename(stageRoot)}.meetless-artifact-resign.lock`);
  const token = randomUUID();
  let handle;
  let created = false;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    created = true;
    const payload = Buffer.from(JSON.stringify({ schema: "MEETLESS_MACOS_ARTIFACT_RESIGN_STAGE_CAPABILITY v1", stageRoot, markerSha256: sha256(markerBytes ?? Buffer.alloc(0)), uid: currentUserId(), token }) + "\n");
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    const inspected = await lstat(lockPath);
    if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.uid !== currentUserId() || (inspected.mode & 0o077) !== 0 || inspected.nlink !== 1) {
      throw artifactResignError(`stage capability file ${lockPath} is not private and exclusive`, "discard the capability and retry only with one private operator-owned lock file");
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) {
      const current = await readFile(lockPath).catch(() => null);
      try {
        if (current && JSON.parse(current.toString("utf8")).token === token) await unlink(lockPath);
      } catch {
        // The capability was not released because its file was not owned by this creation attempt.
      }
    }
    if (error?.code === "EEXIST") {
      throw artifactResignError(`staged root already has an active capability: ${lockPath}`, "stop the competing artifact transform and retain one authorized attempt");
    }
    if (error?.message?.includes("Authority: ")) throw error;
    throw artifactResignError(`cannot acquire the exclusive stage capability ${lockPath}: ${describe(error)}`, "create a private disposable stage outside the repository and retry one authorized attempt");
  }
  return {
    lockPath,
    token,
    async release() {
      const current = await readFile(lockPath).catch(() => null);
      if (!current) return;
      let document;
      try { document = JSON.parse(current.toString("utf8")); } catch (error) {
        throw artifactResignError(`stage capability file ${lockPath} is no longer valid JSON`, "preserve the staged candidate and have the owner inspect the capability path");
      }
      if (document.token !== token) {
        throw artifactResignError(`stage capability file ${lockPath} belongs to another token`, "do not remove another transform's capability; retain the stage for owner inspection");
      }
      await unlink(lockPath).catch((error) => {
        throw artifactResignError(`cannot release the stage capability ${lockPath}: ${describe(error)}`, "retain the staged candidate and have the owner remove only this transform capability");
      });
    },
  };
}

export async function captureRegularFileIdentity(filePath, label = "staged metadata") {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUserId() || (before.mode & 0o022) !== 0) {
      throw artifactResignError(`${label} is not a private operator-owned regular file: ${filePath}`, "restore one private non-symlink staged metadata file before the atomic write");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathIdentity = await lstat(filePath).catch(() => null);
    if (!pathIdentity?.isFile() || pathIdentity.isSymbolicLink() || pathIdentity.dev !== before.dev || pathIdentity.ino !== before.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw artifactResignError(`${label} changed while its identity was captured: ${filePath}`, "stop the competing mutation and validate one stable private metadata file");
    }
    return { dev: before.dev, ino: before.ino, sha256: sha256(bytes), bytes };
  } catch (error) {
    if (error?.message?.includes("Authority: ")) throw error;
    throw artifactResignError(`${label} is not a private operator-owned regular file: ${filePath}`, "restore one private non-symlink staged metadata file before the atomic write");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function assertRegularFileIdentity(actual, expected, label = "staged metadata") {
  if (!actual || !expected || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.sha256 !== expected.sha256) {
    throw artifactResignError(`${label} identity changed after validation`, "preserve the validated file inode and bytes until the bound terminal transition commits");
  }
  return actual;
}

export async function captureOwnerParentBinding(parentPath, label = "owner status parent") {
  const absolute = path.resolve(parentPath);
  const inspected = await lstat(absolute).catch(() => null);
  const resolved = await realpath(absolute).catch(() => null);
  if (!inspected?.isDirectory() || inspected.isSymbolicLink() || resolved !== absolute) {
    throw artifactResignError(`${label} is not one exact regular non-symlink directory: ${absolute}`, "retain the owner status under the exact private stage root");
  }
  if (inspected.uid !== currentUserId() || (inspected.mode & 0o777) !== 0o700) {
    throw artifactResignError(`${label} is not owned by the current uid with private 0700 mode: ${absolute}`, "use one owner-controlled 0700 stage root and status parent");
  }
  return {
    path: absolute,
    dev: inspected.dev,
    ino: inspected.ino,
    uid: inspected.uid,
    mode: inspected.mode & 0o777,
  };
}

export async function assertOwnerParentBinding(binding, label = "owner status parent") {
  if (!binding || typeof binding !== "object" || typeof binding.path !== "string") {
    throw artifactResignError(`${label} binding is missing`, "bind the private 0700 owner status parent before writing lifecycle metadata");
  }
  const current = await captureOwnerParentBinding(binding.path, label);
  if (current.path !== binding.path || current.dev !== binding.dev || current.ino !== binding.ino || current.uid !== binding.uid || current.mode !== binding.mode) {
    throw artifactResignError(`${label} realpath, device, inode, uid, or mode changed: ${binding.path}`, "stop without reporting a candidate and retain the stage for owner inspection");
  }
  return current;
}

export async function resolveOwnerTemporaryParent({ temporaryParent = path.resolve(tmpdir()), repositoryRoot = process.cwd(), canonicalReleaseRoot = null } = {}) {
  const requested = path.resolve(temporaryParent);
  const resolved = await realpath(requested).catch(() => null);
  const inspected = resolved ? await lstat(resolved).catch(() => null) : null;
  if (!resolved || !inspected?.isDirectory() || inspected.isSymbolicLink()) {
    throw artifactResignError(`owner temporary parent is not a regular non-symlink directory: ${requested}`, "use an existing system temporary directory outside the repository and canonical release root");
  }
  const repository = await realpath(path.resolve(repositoryRoot)).catch(() => path.resolve(repositoryRoot));
  const release = await realpath(path.resolve(canonicalReleaseRoot ?? path.join(repository, "release", "macos"))).catch(() => path.resolve(canonicalReleaseRoot ?? path.join(repository, "release", "macos")));
  if (isSameOrInside(repository, resolved) || isSameOrInside(release, resolved)) {
    throw artifactResignError(`owner temporary parent resolves inside the canonical workspace or release root: ${resolved}`, "use a temporary parent outside the repository and release artifact before creating any stage entry");
  }
  return { path: resolved, dev: inspected.dev, ino: inspected.ino, uid: inspected.uid, mode: inspected.mode & 0o777 };
}

async function writeJsonAtomically({ filePath, value, label = "staged JSON", expectedTarget = null, allowMissingTarget = false, beforeRename = null, beforeCommit = null, parentBinding = null } = {}) {
  const parent = path.dirname(filePath);
  if (parentBinding && path.resolve(parent) !== parentBinding.path) {
    throw artifactResignError(`${label} parent binding does not match its target directory: ${parent}`, "bind the exact private status parent before the atomic write");
  }
  if (parentBinding) await assertOwnerParentBinding(parentBinding, `${label} parent`);
  let initial = expectedTarget;
  if (initial === null) {
    if (!allowMissingTarget) {
      initial = await captureRegularFileIdentity(filePath, label);
    } else {
      const existing = await lstat(filePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing) initial = await captureRegularFileIdentity(filePath, label);
    }
  }
  const serialized = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = null;
    if (parentBinding) await assertOwnerParentBinding(parentBinding, `${label} parent`);
    if (typeof beforeRename === "function") await beforeRename({ filePath, temporaryPath });
    if (parentBinding) await assertOwnerParentBinding(parentBinding, `${label} parent`);
    if (initial === null) {
      const current = await lstat(filePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (current) {
        throw artifactResignError(`${label} appeared during the atomic write: ${filePath}`, "preserve the competing metadata and retry only with one owner of the staged root");
      }
    } else {
      const current = await captureRegularFileIdentity(filePath, label);
      if (current.dev !== initial.dev || current.ino !== initial.ino || current.sha256 !== initial.sha256) {
        throw artifactResignError(`${label} changed during the atomic write: ${filePath}`, "preserve the old valid metadata and retry only after the competing mutation is stopped");
      }
    }
    if (typeof beforeCommit === "function") {
      beforeCommit({ filePath, temporaryPath });
      renameSync(temporaryPath, filePath);
    } else {
      await rename(temporaryPath, filePath);
    }
    renamed = true;
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    if (parentBinding) await assertOwnerParentBinding(parentBinding, `${label} parent`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
    if (error?.message?.includes("Authority: ")) throw error;
    throw artifactResignError(`cannot atomically write ${label}: ${describe(error)}`, "preserve the prior valid metadata and inspect the staged directory before retrying");
  }
  return { filePath, sha256: sha256(serialized), bytes: serialized };
}

export async function writeArtifactMetadataAtomically(options = {}) {
  if (path.basename(path.resolve(options.filePath ?? "")) === MACOS_ARTIFACT_OWNER_STATUS_NAME) {
    throw artifactResignError("shared artifact metadata writer cannot target the owner lifecycle status", "use lifecycle-specific non-success operations or commitRetainedMacOSPackageSuccess");
  }
  return writeJsonAtomically(options);
}

export async function writeOwnerFailureStatusAtomically({ filePath, value, stageRoot, markerBytes = null, label = "owner attempt status", allowMissingTarget = false, expectedTarget = null, parentBinding = null } = {}) {
  validateOwnerStatusDocument(value, { stageRoot, markerBytes });
  if (!["retained-preparation-failure", "retained-failure", "retained-interrupted"].includes(value.state) || value.outcome === "success" || value.terminal?.outcome === "success") {
    throw artifactResignError("shared owner failure writer accepts only retained preparation-failure, failure, or interruption", "use commitRetainedMacOSPackageSuccess for the sole retained-success commit");
  }
  return writeJsonAtomically({ filePath, value, label, allowMissingTarget, expectedTarget, parentBinding });
}

export function createOwnerStatusDocument({ stageRoot, markerBytes = null, state = "prepared", attempt = 0, outcome = null, terminal = null } = {}) {
  if (state === "retained-success" || outcome === "success" || terminal?.outcome === "success") {
    throw artifactResignError("shared owner status helper cannot create retained-success", "use only commitRetainedMacOSPackageSuccess for full validation and the atomic success commit");
  }
  const document = {
    schema: MACOS_ARTIFACT_OWNER_STATUS_SCHEMA,
    authority: MACOS_ARTIFACT_RESIGN_AUTHORITY,
    stageRoot,
    markerSha256: markerBytes === null ? null : sha256(markerBytes),
    state,
    attempt,
    outcome,
    inDoubt: state === "consumed",
    terminal,
  };
  validateOwnerStatusDocument(document, { stageRoot, markerBytes });
  return document;
}

export function validateOwnerStatusDocument(status, { stageRoot, markerBytes = null } = {}) {
  const expectedKeys = ["attempt", "authority", "inDoubt", "markerSha256", "outcome", "schema", "stageRoot", "state", "terminal"];
  if (!status || typeof status !== "object" || Array.isArray(status) || JSON.stringify(Object.keys(status).sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expectedKeys)) {
    throw artifactResignError("owner attempt status schema is missing or contains unsupported fields", "retain only the explicit owner status schema beside the F11 marker");
  }
  if (status.schema !== MACOS_ARTIFACT_OWNER_STATUS_SCHEMA || status.authority !== MACOS_ARTIFACT_RESIGN_AUTHORITY || status.stageRoot !== stageRoot || !Number.isInteger(status.attempt) || ![0, 1].includes(status.attempt)) {
    throw artifactResignError("owner attempt status authority, stage root, or attempt number is invalid", "retain the status for this exact private owner stage and one attempt counter");
  }
  const expectedMarkerSha256 = markerBytes === null ? null : sha256(markerBytes);
  if (status.markerSha256 !== expectedMarkerSha256 || (status.markerSha256 !== null && !/^[a-f0-9]{64}$/u.test(status.markerSha256))) {
    throw artifactResignError("owner attempt status does not bind the exact F11 marker", "bind status to the current stage marker bytes before consuming the attempt");
  }
  const terminalOutcome = {
    "retained-preparation-failure": "preparation-failure",
    "retained-success": "success",
    "retained-failure": "failure",
    "retained-interrupted": "interrupted",
  }[status.state];
  if (["prepared", "preflight"].includes(status.state)) {
    if (status.attempt !== 0 || status.outcome !== null || status.inDoubt !== false || status.terminal !== null) {
      throw artifactResignError(`owner attempt status ${status.state} has a consumed attempt or terminal outcome`, "restore attempt 0 with no outcome before the first owner signing attempt");
    }
  } else if (status.state === "consumed") {
    if (status.attempt !== 1 || status.outcome !== null || status.inDoubt !== true || status.terminal !== null) {
      throw artifactResignError("owner attempt status consumed state is malformed or not explicitly in-doubt", "retain exactly one consumed attempt with no terminal evidence before identity resolution or codesign");
    }
  } else if (terminalOutcome) {
    if (status.attempt !== (terminalOutcome === "preparation-failure" ? 0 : 1) || status.outcome !== terminalOutcome || status.inDoubt !== false || !status.terminal) {
      throw artifactResignError(`owner terminal status ${status.state} has an invalid attempt or outcome`, "retain one terminal status matching the consumed or pre-consume failure boundary");
    }
    validateOwnerTerminalEvidence(status.terminal, { stageRoot, markerBytes });
  } else {
    throw artifactResignError(`owner attempt status state ${String(status.state)} is unsupported`, "use prepared, preflight, consumed, or one retained terminal state");
  }
  return status;
}

export async function transitionOwnerStatus({ stageRoot, statusPath, markerBytes, from, state, attempt, outcome = null, terminal = null, expectedCurrentIdentity = null, beforeRename = null, beforeCommit = null, parentBinding = null } = {}) {
  if (state === "retained-success" || outcome === "success" || terminal?.outcome === "success") {
    throw artifactResignError("shared owner lifecycle helper cannot transition to retained-success", "use only commitRetainedMacOSPackageSuccess for full validation and the atomic success commit");
  }
  const currentIdentity = await captureRegularFileIdentity(statusPath, "owner attempt status");
  if (expectedCurrentIdentity) assertRegularFileIdentity(currentIdentity, expectedCurrentIdentity, "owner attempt status");
  const current = parseJson(currentIdentity.bytes, "owner attempt status");
  validateOwnerStatusDocument(current, { stageRoot, markerBytes });
  const allowed = Array.isArray(from) ? from : [from];
  if (!allowed.includes(current.state)) {
    throw artifactResignError(`owner attempt status is ${current.state}, not an allowed ${allowed.join(" or ")} transition`, "do not reuse a consumed or terminal owner stage; create a fresh private stage");
  }
  const next = createOwnerStatusDocument({ stageRoot, markerBytes, state, attempt, outcome, terminal });
  await writeJsonAtomically({
    filePath: statusPath,
    value: next,
    label: "owner attempt status",
    expectedTarget: currentIdentity,
    beforeRename,
    beforeCommit,
    parentBinding,
  });
  return next;
}

export function buildOwnerTerminalEvidence({ stageRoot, markerBytes = null, status, outcome, result = null, error = null } = {}) {
  if (outcome === "success") {
    throw artifactResignError("shared owner evidence helper cannot create success terminal evidence", "use only commitRetainedMacOSPackageSuccess after full retained validation");
  }
  const state = {
    "preparation-failure": "retained-preparation-failure",
    failure: "retained-failure",
    interrupted: "retained-interrupted",
  }[outcome];
  if (!state) throw artifactResignError(`owner terminal outcome ${String(outcome)} is unsupported`, "retain preparation-failure, failure, or interrupted evidence through the shared helper");
  const document = {
    schema: MACOS_ARTIFACT_OWNER_EVIDENCE_SCHEMA,
    authority: MACOS_ARTIFACT_RESIGN_AUTHORITY,
    stageRoot,
    markerSha256: markerBytes === null ? null : sha256(markerBytes),
    attempt: status?.attempt,
    state,
    outcome,
    result: result === null ? null : {
      artifactDigest: result.artifactDigest ?? null,
      packageInputDigest: result.packageInputDigest ?? null,
      artifactInputDigest: result.artifactInputDigest ?? null,
      signatureStateDigest: result.signatureStateDigest ?? null,
      entries: result.entries ?? null,
      macho: result.macho ?? null,
      codeResources: result.codeResources ?? null,
    },
    error: error === null ? null : publicOwnerError(error),
  };
  validateOwnerTerminalEvidence(document, { stageRoot, markerBytes });
  return document;
}

export function validateOwnerTerminalEvidence(evidence, { stageRoot, markerBytes = null } = {}) {
  const expectedKeys = ["attempt", "authority", "error", "markerSha256", "outcome", "result", "schema", "stageRoot", "state"];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || JSON.stringify(Object.keys(evidence).sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expectedKeys)) {
    throw artifactResignError("owner terminal evidence schema is missing or contains unsupported fields", "retain only bounded non-secret owner terminal evidence");
  }
  if (evidence.schema !== MACOS_ARTIFACT_OWNER_EVIDENCE_SCHEMA || evidence.authority !== MACOS_ARTIFACT_RESIGN_AUTHORITY || evidence.stageRoot !== stageRoot || evidence.markerSha256 !== (markerBytes === null ? null : sha256(markerBytes)) || !Number.isInteger(evidence.attempt) || ![0, 1].includes(evidence.attempt)) {
    throw artifactResignError("owner terminal evidence authority, stage root, marker, or attempt is invalid", "bind terminal evidence to the exact retained owner stage and marker");
  }
  const expectedOutcome = {
    "retained-preparation-failure": "preparation-failure",
    "retained-success": "success",
    "retained-failure": "failure",
    "retained-interrupted": "interrupted",
  }[evidence.state];
  if (!expectedOutcome || evidence.outcome !== expectedOutcome || evidence.attempt !== (expectedOutcome === "preparation-failure" ? 0 : 1)) {
    throw artifactResignError("owner terminal evidence state or attempt is invalid", "record one retained terminal state after preparation or the consumed attempt");
  }
  if (expectedOutcome === "success") {
    const result = evidence.result;
    if (!result || typeof result !== "object" || !/^[a-f0-9]{64}$/u.test(result.artifactDigest ?? "") || !/^[a-f0-9]{64}$/u.test(result.packageInputDigest ?? "") || !/^[a-f0-9]{64}$/u.test(result.artifactInputDigest ?? "") || !/^[a-f0-9]{64}$/u.test(result.signatureStateDigest ?? "") || !Number.isInteger(result.entries) || result.entries <= 0 || result.macho !== ACCEPTED_ARTIFACT_BASELINE.machoCount || result.codeResources !== ACCEPTED_ARTIFACT_BASELINE.codeResourcesCount || evidence.error !== null) {
      throw artifactResignError("owner success evidence is incomplete or contains failure data", "retain the final rebound identities and exact package shape counts only");
    }
  } else {
    if (evidence.result !== null || !evidence.error || typeof evidence.error !== "object" || typeof evidence.error.code !== "string" || typeof evidence.error.message !== "string" || evidence.error.message.length > 512) {
      throw artifactResignError("owner failure evidence is missing bounded diagnostic metadata", "retain only a bounded non-secret failure code and message");
    }
  }
  return evidence;
}

export function assertOwnerTerminalResult(evidence, result, { stageRoot = evidence?.stageRoot, markerBytes = null } = {}) {
  validateOwnerTerminalEvidence(evidence, { stageRoot, markerBytes });
  if (evidence.outcome !== "success") {
    throw artifactResignError(`owner terminal outcome ${String(evidence.outcome)} is not success`, "use only retained-success evidence for an externally retained artifact");
  }
  const expected = {
    artifactDigest: result?.artifactDigest ?? null,
    packageInputDigest: result?.packageInputDigest ?? null,
    artifactInputDigest: result?.artifactInputDigest ?? null,
    signatureStateDigest: result?.signatureStateDigest ?? null,
    entries: result?.entries ?? null,
    macho: result?.macho ?? null,
    codeResources: result?.codeResources ?? null,
  };
  if (JSON.stringify(evidence.result) !== JSON.stringify(expected)) {
    throw artifactResignError("owner terminal success result differs from the exact validated artifact result", "retain success only for the current manifest, artifact, signature state, and package shape");
  }
  return evidence.result;
}

export function assertExternalRetainedSuccessState(status) {
  if (status?.state !== "retained-success" || status.attempt !== 1 || status.inDoubt !== false || status.outcome !== "success" || !status.terminal) {
    throw artifactResignError("external retained artifact validation requires exactly retained-success attempt 1 with inDoubt=false and terminal success evidence", "use only the completed owner attempt for retained DMG validation or promotion");
  }
  return status;
}

export function assertExternalRetainedSuccess(status, result, { stageRoot = status?.stageRoot, markerBytes = null } = {}) {
  assertExternalRetainedSuccessState(status);
  assertOwnerTerminalResult(status.terminal, result, { stageRoot, markerBytes });
  return status;
}

export function validateOwnerTerminalFacts({ stdinIsTTY, stdoutIsTTY, stderrIsTTY, environment = {} } = {}) {
  if (stdinIsTTY !== true || stdoutIsTTY !== true || stderrIsTTY !== true) {
    throw artifactResignError("owner signing mode requires an interactive native Terminal TTY on stdin, stdout, and stderr", "open a native local Terminal and run the one owner command directly");
  }
  const remoteOrMultiplexed = ["SSH_CONNECTION", "SSH_TTY", "TMUX", "STY"].find((name) => environment[name]);
  if (remoteOrMultiplexed) {
    throw artifactResignError(`owner signing mode detected remote or multiplexed Terminal variable ${remoteOrMultiplexed}`, "run the one owner command from an unshared native local Terminal");
  }
  return { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true };
}

export function assertOwnerNativeTerminal() {
  return validateOwnerTerminalFacts({
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
    environment: process.env,
  });
}

export async function validateOwnerSourceClosure({ sourceRoot, sourceBundlePath, sourceManifestPath } = {}) {
  const rootStat = await lstat(sourceRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw artifactResignError(`owner source root is not a regular non-symlink directory: ${sourceRoot}`, "use the canonical release/macos directory as the read-only owner source");
  }
  const rootRealPath = await realpath(sourceRoot).catch(() => null);
  if (!rootRealPath || rootRealPath !== path.resolve(sourceRoot)) {
    throw artifactResignError(`owner source root realpath differs from its explicit path: ${sourceRoot}`, "resolve the canonical release/macos path before copying");
  }
  const bundleStat = await lstat(sourceBundlePath).catch(() => null);
  if (!bundleStat?.isDirectory() || bundleStat.isSymbolicLink()) {
    throw artifactResignError(`owner source Meetless.app is not a regular non-symlink directory: ${sourceBundlePath}`, "use the accepted canonical Meetless.app directory as the read-only source");
  }
  const bundleRealPath = await realpath(sourceBundlePath).catch(() => null);
  if (!bundleRealPath || bundleRealPath !== path.resolve(sourceBundlePath) || !isSameOrInside(rootRealPath, bundleRealPath)) {
    throw artifactResignError(`owner source Meetless.app realpath is outside the canonical release root: ${sourceBundlePath}`, "use the canonical non-symlink Meetless.app path inside release/macos");
  }
  const manifestStat = await lstat(sourceManifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
    throw artifactResignError(`owner source composition manifest is not one regular non-symlink file: ${sourceManifestPath}`, "use one private-source composition manifest with no hardlink alias");
  }
  const manifestRealPath = await realpath(sourceManifestPath).catch(() => null);
  if (!manifestRealPath || manifestRealPath !== path.resolve(sourceManifestPath) || !isSameOrInside(rootRealPath, manifestRealPath)) {
    throw artifactResignError(`owner source composition manifest realpath is outside the canonical release root: ${sourceManifestPath}`, "use the canonical release/macos composition manifest");
  }
  const snapshot = [];
  await inspectOwnerSourceEntry(sourceBundlePath, { treeRoot: sourceBundlePath, sourceRoot: bundleRealPath, snapshot });
  return { sourceRoot: rootRealPath, sourceBundlePath: path.resolve(sourceBundlePath), sourceManifestPath: path.resolve(sourceManifestPath), snapshot: snapshot.sort((left, right) => left.path.localeCompare(right.path)) };
}

export async function createOwnerStage({ sourceRoot, sourceBundlePath, sourceManifestPath, repositoryRoot = process.cwd(), marker, onStageCreated = null, temporaryParentPath = null } = {}) {
  const source = await validateOwnerSourceClosure({ sourceRoot, sourceBundlePath, sourceManifestPath });
  const sourceManifestBytes = await readOwnerSourceRegularFile(source.sourceManifestPath, "owner source composition manifest");
  const temporaryParent = await resolveOwnerTemporaryParent({
    temporaryParent: temporaryParentPath ?? path.resolve(tmpdir()),
    repositoryRoot,
  });
  const temporaryRoot = await mkdtemp(path.join(temporaryParent.path, "meetless-artifact-owner-"));
  await chmod(temporaryRoot, 0o700);
  const stageRoot = await realpath(temporaryRoot).catch(() => null);
  if (!stageRoot) {
    throw artifactResignError(`owner stage realpath is unavailable for its created path: ${temporaryRoot}`, "retain the private temporary owner root and do not continue");
  }
  const stagePaths = assertExternalArtifactStageRoot({ stageRoot, repositoryRoot });
  const parentBinding = await captureOwnerParentBinding(stageRoot, "owner status parent");
  try {
    await onStageCreated?.({ ...stagePaths, stageRoot });
    await copyOwnerTree(source.sourceBundlePath, stagePaths.bundlePath, {
      sourceRoot: source.sourceBundlePath,
      expectedSnapshot: source.snapshot,
    });
    await copyOwnerRegularFile(source.sourceManifestPath, stagePaths.manifestPath, sourceManifestBytes);
    const currentSourceSnapshot = await validateOwnerSourceClosure({ sourceRoot: source.sourceRoot, sourceBundlePath: source.sourceBundlePath, sourceManifestPath: source.sourceManifestPath });
    if (JSON.stringify(currentSourceSnapshot.snapshot) !== JSON.stringify(source.snapshot)) {
      throw artifactResignError("canonical app source changed while the owner stage was being prepared", "discard this retained preparation-failure root and create a fresh stage from the accepted artifact");
    }
    const currentSourceManifestBytes = await readOwnerSourceRegularFile(source.sourceManifestPath, "owner source composition manifest");
    if (!currentSourceManifestBytes.equals(sourceManifestBytes)) {
      throw artifactResignError("canonical composition manifest changed while the owner stage was being prepared", "discard this retained preparation-failure root and create a fresh stage from the accepted manifest");
    }
    const stagedSnapshot = await snapshotOwnerTree(stagePaths.bundlePath);
    if (JSON.stringify(snapshotWithoutModes(stagedSnapshot)) !== JSON.stringify(snapshotWithoutModes(source.snapshot))) {
      throw artifactResignError("staged app bytes or symlink closure differs from the canonical source after copy", "discard this retained preparation-failure root and create a fresh exact copy");
    }
    const markerDocument = typeof marker === "function" ? marker({ ...stagePaths, stageRoot }) : { ...marker, stageRoot };
    const markerWrite = await writeJsonAtomically({
      filePath: stagePaths.markerPath,
      value: markerDocument,
      label: "owner F11 stage marker",
      allowMissingTarget: true,
      parentBinding,
    });
    const status = createOwnerStatusDocument({ stageRoot, markerBytes: markerWrite.bytes, state: "prepared", attempt: 0 });
    await writeJsonAtomically({
      filePath: stagePaths.statusPath ?? path.join(stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME),
      value: status,
      label: "owner attempt status",
      allowMissingTarget: true,
      parentBinding,
    });
    return validateArtifactStageRoot({ stageRoot, repositoryRoot, ownerMode: true });
  } catch (error) {
    if (error && typeof error === "object") error.ownerStage = { ...stagePaths, stageRoot, parentBinding };
    throw error;
  }
}

export async function copyOwnerTree(sourcePath, destinationPath, { sourceRoot, expectedSnapshot = null } = {}) {
  if (!Array.isArray(expectedSnapshot)) {
    throw artifactResignError("owner source snapshot is required before copying", "validate the accepted canonical source closure before creating any staged destination entry");
  }
  const root = path.resolve(sourceRoot ?? sourcePath);
  const expectedByPath = new Map();
  for (const entry of expectedSnapshot) {
    if (!entry || typeof entry.path !== "string" || expectedByPath.has(entry.path)) {
      throw artifactResignError("owner source snapshot contains a missing or duplicate entry", "regenerate one exact deterministic source snapshot before copying");
    }
    expectedByPath.set(entry.path, entry);
  }
  const seenExpectedPaths = new Set();
  await copyOwnerEntry(path.resolve(sourcePath), path.resolve(destinationPath), {
    sourceRoot: root,
    treeRoot: path.resolve(sourcePath),
    expectedByPath,
    seenExpectedPaths,
  });
  const missing = [...expectedByPath.keys()].filter((relativePath) => !seenExpectedPaths.has(relativePath));
  if (missing.length > 0) {
    throw artifactResignError(`owner source entries are missing from the accepted snapshot during copy: ${missing.join(", ")}`, "restore every accepted source entry and create a fresh owner stage");
  }
}

async function copyOwnerEntry(sourcePath, destinationPath, { sourceRoot, treeRoot, expectedByPath, seenExpectedPaths }) {
  const inspected = await lstat(sourcePath).catch(() => null);
  if (!inspected) throw artifactResignError(`owner source entry is missing: ${sourcePath}`, "restore the accepted canonical source before copying");
  const relativePath = path.relative(treeRoot, sourcePath).split(path.sep).join("/");
  const entryType = ownerLstatType(inspected);
  const expected = expectedByPath.get(relativePath);
  if (!expected) {
    throw artifactResignError(`owner source entry is added or missing from the accepted snapshot: ${relativePath || "."}`, "discard this preparation and restore the exact accepted source closure before copying");
  }
  if (expected.type !== entryType) {
    throw artifactResignError(`owner source entry type changed at ${relativePath || "."}: observed ${entryType}, expected ${expected.type}`, "discard this preparation and restore the exact accepted source entry before copying");
  }
  seenExpectedPaths.add(relativePath);
  const existing = await lstat(destinationPath).catch(() => null);
  if (existing) throw artifactResignError(`owner stage destination already exists: ${destinationPath}`, "use one fresh empty owner stage root");
  if (inspected.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    const targetDigest = sha256(Buffer.from(target));
    if (expected.target !== target || expected.sha256 !== targetDigest) {
      throw artifactResignError(`owner source symlink target or digest changed at ${sourcePath}`, "discard this preparation and restore the exact accepted internal relative symlink before copying");
    }
    const resolved = assertInternalOwnerSymlink(sourcePath, target, sourceRoot);
    const targetRealPath = await realpath(resolved).catch(() => null);
    if (!targetRealPath || !isSameOrInside(sourceRoot, targetRealPath)) {
      throw artifactResignError(`owner source symlink target resolves outside the accepted app: ${sourcePath} -> ${target}`, "retain only a relative symlink whose final target remains inside the canonical app");
    }
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await symlink(target, destinationPath);
    return;
  }
  if (inspected.isDirectory()) {
    const resolved = await realpath(sourcePath).catch(() => null);
    if (resolved !== sourcePath) throw artifactResignError(`owner source directory resolves through indirection: ${sourcePath}`, "use the canonical non-symlink source tree");
    await mkdir(destinationPath, { mode: 0o700 });
    await chmod(destinationPath, 0o700);
    for (const name of (await readdir(sourcePath)).sort((left, right) => left.localeCompare(right))) {
      await copyOwnerEntry(path.join(sourcePath, name), path.join(destinationPath, name), { sourceRoot, treeRoot, expectedByPath, seenExpectedPaths });
    }
    return;
  }
  if (inspected.isFile()) {
    const bound = await readOwnerBoundRegularFile(sourcePath, "owner source regular file");
    if (expected.size !== bound.bytes.byteLength || expected.sha256 !== sha256(bound.bytes) || expected.mode !== bound.mode) {
      throw artifactResignError(`owner source regular file changed before copy: ${sourcePath}`, "discard this preparation and create a fresh stage from the accepted canonical bytes");
    }
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeOwnerCopiedRegularFile(destinationPath, bound.bytes, bound.mode);
    return;
  }
  throw artifactResignError(`owner source entry has unsupported lstat type: ${sourcePath}`, "remove the FIFO, socket, device, or unsupported canonical source entry before staging");
}

function ownerLstatType(inspected) {
  if (inspected.isSymbolicLink()) return "symlink";
  if (inspected.isFile()) return "file";
  if (inspected.isDirectory()) return "directory";
  return "unsupported";
}

async function readOwnerBoundRegularFile(filePath, label) {
  const absolute = path.resolve(filePath);
  const inspected = await lstat(absolute).catch(() => null);
  const resolved = await realpath(absolute).catch(() => null);
  if (!inspected?.isFile() || inspected.isSymbolicLink() || inspected.nlink !== 1 || resolved !== absolute) {
    throw artifactResignError(`${label} is not one exact regular non-symlink file: ${absolute}`, "restore the canonical file with no hardlink alias before owner preparation");
  }
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const bound = await handle.stat();
    const expectedMode = inspected.mode & 0o777;
    if (bound.dev !== inspected.dev || bound.ino !== inspected.ino || bound.size !== inspected.size || (bound.mode & 0o777) !== expectedMode || bound.nlink !== 1) {
      throw artifactResignError(`${label} inode, size, link count, or mode changed before its bound read: ${absolute}`, "discard this preparation and create a fresh stage from stable canonical bytes");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== bound.dev || after.ino !== bound.ino || after.size !== bound.size || (after.mode & 0o777) !== (bound.mode & 0o777) || after.nlink !== 1 || bytes.byteLength !== bound.size) {
      throw artifactResignError(`${label} changed while reading its bound handle: ${absolute}`, "discard this preparation and create a fresh stage from stable canonical bytes");
    }
    return { bytes, dev: bound.dev, ino: bound.ino, size: bound.size, mode: bound.mode & 0o777 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeOwnerCopiedRegularFile(destinationPath, bytes, sourceMode) {
  const mode = (sourceMode & 0o111) === 0 ? 0o600 : 0o700;
  let handle;
  try {
    handle = await open(destinationPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  const copied = await readOwnerBoundRegularFile(destinationPath, "owner staged regular file");
  if (!copied.bytes.equals(bytes) || copied.mode !== mode || copied.size !== bytes.byteLength) {
    throw artifactResignError(`owner staged regular file bytes or mode differ after copy: ${destinationPath}`, "discard this preparation and create a fresh exact copy; do not retain changed source bytes as accepted input");
  }
}

async function copyOwnerRegularFile(sourcePath, destinationPath, expectedBytes) {
  const bound = await readOwnerBoundRegularFile(sourcePath, "owner source composition manifest");
  if (!bound.bytes.equals(expectedBytes)) throw artifactResignError(`owner source composition manifest changed before copy: ${sourcePath}`, "discard this preparation and create a fresh exact manifest copy");
  await writeOwnerCopiedRegularFile(destinationPath, bound.bytes, 0o600);
}

async function readOwnerSourceRegularFile(filePath, label) {
  return (await readOwnerBoundRegularFile(filePath, label)).bytes;
}

async function inspectOwnerSourceEntry(candidate, { treeRoot, sourceRoot, snapshot }) {
  const inspected = await lstat(candidate).catch(() => null);
  if (!inspected) throw artifactResignError(`owner source entry is missing: ${candidate}`, "restore the accepted canonical source tree before staging");
  const relativePath = path.relative(treeRoot, candidate).split(path.sep).join("/");
  if (inspected.isSymbolicLink()) {
    const target = await readlink(candidate);
    const resolved = assertInternalOwnerSymlink(candidate, target, sourceRoot);
    const targetRealPath = await realpath(resolved).catch(() => null);
    if (!targetRealPath || !isSameOrInside(sourceRoot, targetRealPath)) {
      throw artifactResignError(`owner source symlink target resolves outside the accepted app: ${candidate} -> ${target}`, "retain only a relative symlink whose final target remains inside the canonical app");
    }
    snapshot.push({ path: relativePath, type: "symlink", target, sha256: sha256(Buffer.from(target)) });
    return;
  }
  if (inspected.isFile()) {
    if (inspected.nlink !== 1) throw artifactResignError(`owner source regular file has ${inspected.nlink} hard links: ${candidate}`, "copy from a canonical file with no hardlink alias");
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== candidate) throw artifactResignError(`owner source regular file resolves through indirection: ${candidate}`, "use the canonical non-symlink source file");
    const bound = await readOwnerBoundRegularFile(candidate, "owner source regular file");
    snapshot.push({ path: relativePath, type: "file", size: bound.bytes.byteLength, mode: bound.mode, sha256: sha256(bound.bytes) });
    return;
  }
  if (inspected.isDirectory()) {
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== candidate) throw artifactResignError(`owner source directory resolves through indirection: ${candidate}`, "use the canonical non-symlink source directory");
    snapshot.push({ path: relativePath, type: "directory" });
    for (const name of (await readdir(candidate)).sort((left, right) => left.localeCompare(right))) {
      await inspectOwnerSourceEntry(path.join(candidate, name), { treeRoot, sourceRoot, snapshot });
    }
    return;
  }
  throw artifactResignError(`owner source entry has unsupported lstat type: ${candidate}`, "remove the FIFO, socket, device, or unsupported canonical source entry before staging");
}

async function snapshotOwnerTree(treeRoot) {
  const snapshot = [];
  await inspectOwnerSourceEntry(treeRoot, { treeRoot, sourceRoot: treeRoot, snapshot });
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotWithoutModes(snapshot) {
  return snapshot.map(({ mode: _mode, ...entry }) => entry);
}

function assertInternalOwnerSymlink(candidate, target, sourceRoot) {
  if (typeof target !== "string" || target.length === 0 || path.isAbsolute(target)) {
    throw artifactResignError(`owner source symlink is absolute or empty: ${candidate} -> ${String(target)}`, "retain only relative symlinks whose resolved target stays inside the accepted app");
  }
  const resolved = path.resolve(path.dirname(candidate), target);
  if (!isSameOrInside(sourceRoot, resolved)) {
    throw artifactResignError(`owner source symlink escapes the accepted app: ${candidate} -> ${target}`, "replace the symlink with the exact internal relative target before staging");
  }
  return resolved;
}

export function createOwnerSignalController({ signalSource = process, killGraceMs = MACOS_OWNER_CHILD_KILL_GRACE_MS } = {}) {
  let requestedSignal = null;
  let active = null;
  let closed = false;
  const onSignal = (signal) => {
    if (closed || requestedSignal !== null) return;
    requestedSignal = signal;
    if (!active || active.closed) return;
    try { active.child.kill(signal); } catch {
      // The close event and bounded escalation remain authoritative.
    }
    active.escalationTimer = setTimeout(() => {
      if (active?.closed) return;
      try { active?.child.kill("SIGKILL"); } catch {
        // The owner path reports the absence failure if the child does not close.
      }
    }, killGraceMs);
    active.escalationTimer.unref?.();
  };
  const listeners = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
    SIGHUP: () => onSignal("SIGHUP"),
  };
  for (const [signal, listener] of Object.entries(listeners)) signalSource.on?.(signal, listener);
  return {
    requestedSignal: () => requestedSignal,
    isInterrupted: () => requestedSignal !== null,
    assertNotInterrupted() {
      if (requestedSignal !== null) {
        const interrupted = artifactResignError(`owner lifecycle received ${requestedSignal}`, "retain the consumed owner stage as interrupted; never retry this stage");
        interrupted.ownerOutcome = "interrupted";
        throw interrupted;
      }
    },
    attachChild(child, relativePath) {
      if (closed || active) throw artifactResignError("owner signal controller already owns a child", "wait for the current owned codesign child before starting another");
      let resolveAbsence;
      const absence = new Promise((resolve) => { resolveAbsence = resolve; });
      active = { child, relativePath, closed: false, escalationTimer: null, absence, resolveAbsence };
      if (requestedSignal !== null) {
        try { child.kill(requestedSignal); } catch {
          // The close event and bounded escalation remain authoritative.
        }
        active.escalationTimer = setTimeout(() => {
          if (active?.closed) return;
          try { active?.child.kill("SIGKILL"); } catch {
            // The owner path reports the absence failure if the child does not close.
          }
        }, killGraceMs);
        active.escalationTimer.unref?.();
      }
      return active;
    },
    markChildClosed() {
      if (!active) return;
      active.closed = true;
      if (active.escalationTimer) clearTimeout(active.escalationTimer);
      active.resolveAbsence?.();
      active = null;
    },
    async waitForChildAbsence() {
      const current = active;
      if (current && !current.closed) await current.absence;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [signal, listener] of Object.entries(listeners)) signalSource.removeListener?.(signal, listener);
      if (active?.escalationTimer) clearTimeout(active.escalationTimer);
    },
  };
}

export async function runOwnedCodesignChild(arguments_, context, { spawnChild = spawn, signalSource = process, killGraceMs = MACOS_OWNER_CHILD_KILL_GRACE_MS, signalController = null, ownerMode = false } = {}) {
  if (activeCodesignChild) {
    throw artifactResignError(`codesign child ownership is already held by ${activeCodesignChild.relativePath}`, "wait for the existing owned codesign child and do not start a second child");
  }
  const spawnOptions = {
    stdio: ["inherit", "inherit", "inherit"],
    ...(ownerMode ? { env: ownerToolEnvironment() } : {}),
  };
  let child;
  try {
    child = spawnChild(MACOS_OWNER_TOOL_PATHS.codesign, arguments_, spawnOptions);
  } catch (error) {
    throw artifactResignError(`cannot start codesign for ${context?.relativePath ?? "unknown target"}: ${describe(error)}`, "stop this one attempt and retain the owner stage for inspection");
  }
  activeCodesignChild = { child, relativePath: context?.relativePath ?? "unknown target" };
  let requestedSignal = null;
  let escalationTimer = null;
  let closed = false;
  const onSignal = (signal) => {
    if (closed || requestedSignal !== null) return;
    requestedSignal = signal;
    try { child.kill(signal); } catch {
      // The close event or bounded escalation below remains authoritative.
    }
    escalationTimer = setTimeout(() => {
      if (closed) return;
      try { child.kill("SIGKILL"); } catch {
        // The terminal path reports the absence failure if the child does not close.
      }
    }, killGraceMs);
    escalationTimer.unref?.();
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  const onHangup = () => onSignal("SIGHUP");
  if (!signalController) {
    signalSource.on?.("SIGINT", onInterrupt);
    signalSource.on?.("SIGTERM", onTerminate);
    signalSource.on?.("SIGHUP", onHangup);
  }
  try {
    const outcome = await new Promise((resolve) => {
      let childError = null;
      child.once("error", (error) => { childError = error; });
      child.once("close", (code, signal) => {
        closed = true;
        signalController?.markChildClosed();
        resolve({ code, signal, error: childError });
      });
      signalController?.attachChild(child, context?.relativePath ?? "unknown target");
    });
    if (escalationTimer) clearTimeout(escalationTimer);
    requestedSignal = signalController?.requestedSignal() ?? requestedSignal;
    if (requestedSignal !== null) {
      const interrupted = artifactResignError(`codesign was interrupted by ${requestedSignal} after the child closed`, "retain the consumed owner stage and inspect terminal interrupted evidence; never retry this stage");
      interrupted.ownerOutcome = "interrupted";
      throw interrupted;
    }
    if (outcome.error) throw artifactResignError(`codesign could not start for ${context?.relativePath ?? "unknown target"}: ${describe(outcome.error)}`, "stop this one attempt and retain the owner stage for inspection");
    if (outcome.code !== 0) {
      throw artifactResignError(`codesign exited ${String(outcome.code)} for ${context?.relativePath ?? "unknown target"}`, "stop this one attempt and retain the owner stage for inspection");
    }
    return outcome;
  } finally {
    if (escalationTimer) clearTimeout(escalationTimer);
    if (!signalController) {
      signalSource.removeListener?.("SIGINT", onInterrupt);
      signalSource.removeListener?.("SIGTERM", onTerminate);
      signalSource.removeListener?.("SIGHUP", onHangup);
    }
    activeCodesignChild = null;
  }
}

function currentUserId() {
  if (typeof process.getuid !== "function") {
    throw artifactResignError("current uid is unavailable", "run the artifact transform on the owner macOS host with uid ownership checks available");
  }
  return process.getuid();
}

export function validateArtifactStageMarker(marker, { stageRoot, stageRealPath = stageRoot, expectedBaseline = null } = {}) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || marker.schema !== MACOS_ARTIFACT_STAGE_MARKER_SCHEMA || marker.stageRoot !== stageRealPath || marker.bundlePath !== MACOS_ARTIFACT_STAGE_BUNDLE_NAME || marker.manifestPath !== MACOS_ARTIFACT_STAGE_MANIFEST_NAME) {
    throw artifactResignError("stage marker schema, root realpath, or fixed app/manifest names are invalid", "regenerate the owner stage marker for this exact non-symlink staging root");
  }
  const baseline = marker.baseline;
  validateArtifactBaseline(baseline);
  if (expectedBaseline !== null && JSON.stringify(baseline) !== JSON.stringify(validateArtifactBaseline(expectedBaseline))) {
    throw artifactResignError("stage marker baseline differs from the prepared source-bound baseline", "use the exact baseline captured during credential-free preparation");
  }
  if (!marker.policy || typeof marker.policy !== "object" || Array.isArray(marker.policy)) {
    throw artifactResignError("stage marker policy evidence is missing", "record the checked-in F5 entitlement map and plist digests in the owner stage marker");
  }
  if (marker.policy.schema !== "MEETLESS_MACOS_ENTITLEMENT_MAP v1" || marker.policy.mapPath !== MACOS_ENTITLEMENT_MAP_PATH || !/^[a-f0-9]{64}$/u.test(marker.policy.mapSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(marker.policy.mapCanonicalSha256 ?? "") || !Array.isArray(marker.policy.sourcePlists) || marker.policy.sourcePlists.length !== 2) {
    throw artifactResignError("stage marker F5 entitlement policy evidence is malformed", "record the exact checked-in map and both owner plist digests in the stage marker");
  }
  return marker;
}

export function assertBaselineIdentity({ manifest, marker, manifestBytes = null, expected = null } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw artifactResignError("accepted baseline manifest is not an object", "copy the accepted composition manifest without editing it before the signing attempt");
  }
  const baseline = validateArtifactBaseline(expected ?? marker?.baseline);
  const observed = {
    sourceSnapshotDigest: manifest.candidateSnapshot?.digest,
    packageInputDigest: manifest.packageInputs?.digest,
    artifactInputDigest: manifest.packageInputs?.artifactInput?.digest,
    artifactDigest: manifest.artifactDigest,
    signatureStateDigest: manifest.signing?.signatureStateDigest,
    manifestSha256: manifestBytes === null ? undefined : sha256(manifestBytes),
    paseoCommit: manifest.candidateSnapshot?.paseoCommit ?? manifest.paseoCommit,
    machoCount: manifest.macho?.length,
    codeResourcesCount: Array.isArray(manifest.entries) ? manifest.entries.filter((entry) => isCodeResourcesPath(entry.path)).length : null,
    sourceSnapshotHead: manifest.candidateSnapshot?.head,
  };
  for (const name of ["sourceSnapshotDigest", "sourceSnapshotHead", "packageInputDigest", "artifactInputDigest", "artifactDigest", "signatureStateDigest", "paseoCommit", "machoCount", "codeResourcesCount"]) {
    const value = baseline[name];
    if (observed[name] !== value) {
      throw artifactResignError(`accepted baseline ${name} is ${String(observed[name])}, expected ${String(value)}`, "restore the exact accepted local artifact and manifest before signing");
    }
  }
  if (manifestBytes !== null && sha256(manifestBytes) !== baseline.manifestSha256) {
    throw artifactResignError("accepted baseline composition manifest bytes are stale", "copy the exact accepted external composition manifest into the staged root");
  }
  if (marker?.baseline && JSON.stringify(validateArtifactBaseline(marker.baseline)) !== JSON.stringify(baseline)) {
    throw artifactResignError("stage marker does not bind the accepted baseline manifest", "regenerate the owner stage marker from the accepted manifest bytes");
  }
  const expectedOrder = buildSigningOrder(manifest.macho);
  if (manifest.signing?.mode !== "local-ad-hoc" || manifest.signing.localOnly !== true || manifest.signing.identity?.requested !== "-" || JSON.stringify(manifest.signing.order) !== JSON.stringify(expectedOrder)) {
    throw artifactResignError("accepted baseline is not the exact local ad-hoc outer-last candidate", "stage the accepted local-only manifest with 46 nested objects followed by Meetless.app");
  }
  return observed;
}

export function validateExactEntitlementPolicy(policy, { machoPaths = [] } = {}) {
  if (!policy || policy.schema !== "MEETLESS_MACOS_ENTITLEMENT_MAP v1" || policy.mapPath !== MACOS_ENTITLEMENT_MAP_PATH || !Array.isArray(policy.entries)) {
    throw artifactResignError("F5 entitlement policy is missing or is not the checked-in map", `load ${MACOS_ENTITLEMENT_MAP_PATH} and do not accept a caller override`);
  }
  const observed = policy.entries.map((entry) => ({ path: entry?.path, class: entry?.class, plist: entry?.plist, key: entry?.key }));
  const expected = MACOS_APPROVED_ENTITLEMENT_MAP.map(({ path: entryPath, class: policyClass, plist, key }) => ({ path: entryPath, class: policyClass, plist, key }));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw artifactResignError(`F5 entitlement paths or keys differ from the exact five-path policy: ${JSON.stringify(observed)}`, "restore the owner-approved JIT/audio-input map; do not add a union entitlement or new path");
  }
  const machoSet = new Set(machoPaths);
  for (const entry of expected) {
    if (!machoSet.has(entry.path)) {
      throw artifactResignError(`approved entitlement path ${entry.path} is absent from the baseline Mach-O set`, `restore the exact ${entry.class} executable before the one signing attempt`);
    }
  }
  if (policy.entries.some((entry) => entry?.absolutePath && !path.isAbsolute(entry.absolutePath))) {
    throw artifactResignError("F5 entitlement plist authority path is not absolute after loading", "use the checked-in owner plist realpath from the repository policy loader");
  }
  return policy;
}

export function createStagePolicyEvidence(policy) {
  if (!policy || typeof policy !== "object") {
    throw artifactResignError("loaded F5 entitlement policy is missing", "load the checked-in entitlement map before creating the owner stage marker");
  }
  return {
    schema: policy.schema,
    mapPath: policy.mapPath,
    mapSha256: policy.mapSha256,
    mapCanonicalSha256: policy.mapCanonicalSha256,
    sourcePlists: (policy.sourcePlists ?? []).map((source) => ({ ...source })),
  };
}

export function assertStagePolicyBinding(markerPolicy, policy) {
  const expected = createStagePolicyEvidence(policy);
  if (JSON.stringify(markerPolicy) !== JSON.stringify(expected)) {
    throw artifactResignError("stage marker F5 entitlement policy evidence is stale or changed", "recreate the owner stage marker from the checked-in map and plist digests");
  }
  return markerPolicy;
}

export function assertBaselineArtifactClosure({ manifest, actualEntries, actualMachOEntries = null, actualMachOPayloads = null, expectedMachOPayloads = null, baselineInventory = null, bundlePath = "Meetless.app", expectedBaseline = null } = {}) {
  const baseline = expectedBaseline === null ? null : validateArtifactBaseline(expectedBaseline);
  compareExactEntrySets(manifest?.entries ?? [], actualEntries ?? [], `${bundlePath} baseline`);
  const expectedMachOPaths = sortUniquePaths(manifest?.macho ?? [], "baseline manifest Mach-O paths");
  const actualMachOPaths = sortUniquePaths((actualMachOEntries ?? []).map((entry) => entry.path), "actual baseline Mach-O paths");
  if (JSON.stringify(expectedMachOPaths) !== JSON.stringify(actualMachOPaths)) {
    throw artifactResignError(`baseline Mach-O inventory differs from the accepted manifest (manifest ${expectedMachOPaths.length}, actual ${actualMachOPaths.length})`, "restore every accepted nested Mach-O and remove extra or missing code objects before signing");
  }
  const normalizedPayloads = validateMachOPayloadBindings(actualMachOPayloads, expectedMachOPaths);
  if (expectedMachOPayloads !== null) assertMachOPayloadClosure({ baselinePayloads: expectedMachOPayloads, finalPayloads: normalizedPayloads });
  const codeResources = actualEntries.filter((entry) => isCodeResourcesPath(entry.path)).map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  const expectedCodeResourcesCount = baseline?.codeResourcesCount ?? ACCEPTED_ARTIFACT_BASELINE.codeResourcesCount;
  const expectedMachOCount = baseline?.machoCount ?? ACCEPTED_ARTIFACT_BASELINE.machoCount;
  if (expectedMachOCount !== expectedMachOPaths.length || codeResources.length !== expectedCodeResourcesCount || codeResources.some((relativePath) => actualEntries.find((entry) => entry.path === relativePath)?.type !== "file")) {
    throw artifactResignError(`baseline CodeResources inventory has ${codeResources.length} files or a non-file entry`, "restore every **/_CodeSignature/CodeResources file before signing");
  }
  const descriptor = createSigningBoundDescriptor({
    phase: MACOS_FINAL_SIGNING_BOUND_PHASE,
    machoPaths: expectedMachOPaths,
    machoPayloads: normalizedPayloads,
    codeResourcePaths: codeResources,
  });
  const declaredCodeResources = (manifest.entries ?? []).filter((entry) => isCodeResourcesPath(entry.path)).map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(declaredCodeResources) !== JSON.stringify(codeResources)) {
    throw artifactResignError("baseline manifest CodeResources paths differ from the staged artifact", "regenerate the accepted manifest from the complete nested signing closure");
  }
  const artifactInput = manifest.packageInputs?.artifactInput;
  if (!artifactInput || digestArtifactEntries(actualEntries, { excludedPaths: artifactInput.excludedPaths }) !== artifactInput.digest) {
    throw artifactResignError("baseline non-signing artifact-input digest differs from the accepted package input", "restore the exact ordinary payload, symlink closure, notices, and package members before signing");
  }
  if (baselineInventory) {
    const inventoryEntry = actualEntries.find((entry) => entry.path === MACOS_LICENSE_INVENTORY_PATH);
    if (!inventoryEntry || inventoryEntry.type !== "file" || manifest.licenseInventory?.sha256 !== inventoryEntry.sha256) {
      throw artifactResignError("baseline packaged license inventory bytes are not bound by the accepted manifest", "restore the accepted license-inventory.json bytes before signing");
    }
    if (baselineInventory.artifact?.entryBinding?.digest !== manifest.licenseInventory?.artifactEntryDigest || baselineInventory.artifact?.packageInputBinding?.digest !== manifest.packageInputs?.digest) {
      throw artifactResignError("baseline license inventory binding is stale", "stage the accepted package-input and license-inventory identities together");
    }
  }
  return { descriptor, machoPaths: expectedMachOPaths, machoPayloads: normalizedPayloads, codeResourcePaths: codeResources };
}

export function assertSigningOrder(observed, expected) {
  const actual = [...(observed ?? [])];
  const required = [...(expected ?? [])];
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw artifactResignError(`signing order was ${JSON.stringify(actual)}, expected deepest-first nested objects followed by ${MACOS_SIGNING_OUTER_PATH}`, "discard the attempt and run the fixed nested-then-outer signing sequence once");
  }
  return actual;
}

export function assertArtifactResignLifecycleOrder(observed, { terminalEvent = "terminal-retained-success" } = {}) {
  const required = [
    "inventory-written",
    "outer-sign-complete",
    "final-observation",
    "manifest-written",
    "retained-validation-complete",
    terminalEvent,
  ];
  let prior = -1;
  for (const event of required) {
    const position = (observed ?? []).indexOf(event);
    if (position < 0 || position <= prior) {
      throw artifactResignError(`artifact re-sign lifecycle event order is missing or invalid at ${event}`, "complete inventory write, outer-last signing, final observation, manifest write, retained validation, and terminal status in that order");
    }
    prior = position;
  }
  return observed;
}

export async function signNestedMachOClosure({ bundlePath, machoPaths, signingInputs, entitlementPolicy, signTarget = runCodesign, signalController = null } = {}) {
  const order = buildSigningOrder(machoPaths);
  validateExactEntitlementPolicy(entitlementPolicy, { machoPaths: order.nestedMachO });
  const observed = [];
  for (const relativePath of order.nestedMachO) {
    const mapping = entitlementPolicy.entries.find((entry) => entry.path === relativePath);
    const target = path.resolve(bundlePath, relativePath);
    const arguments_ = codesignArguments({
      mode: RELEASE_SIGNING_MODE,
      identity: signingInputs.identity,
      target,
      identifier: machOSignatureIdentifier(relativePath),
      entitlementsPath: mapping?.absolutePath ?? null,
      outer: false,
    });
    await signTarget(arguments_, { relativePath, target, outer: false, entitlement: mapping ?? null, signalController });
    observed.push(relativePath);
  }
  assertSigningOrder(observed, order.nestedMachO);
  return { order, observed };
}

export async function signOuterApp({ bundlePath, signingInputs, signTarget = runCodesign, signalController = null } = {}) {
  const target = path.resolve(bundlePath);
  const arguments_ = codesignArguments({
    mode: RELEASE_SIGNING_MODE,
    identity: signingInputs.identity,
    target,
    identifier: "com.meetless.app",
    outer: true,
  });
  await signTarget(arguments_, { relativePath: MACOS_SIGNING_OUTER_PATH, target, outer: true, entitlement: null, signalController });
  return { observed: [MACOS_SIGNING_OUTER_PATH] };
}

export function rebindPackageInputManifest({ baseline, preOuterEntries, signingBound } = {}) {
  validatePreOuterSigningBound(signingBound);
  if (!baseline?.artifactInput || !Array.isArray(baseline.artifactInput.excludedPaths)) {
    throw artifactResignError("baseline package-input artifact binding is missing", "use the accepted package-input manifest as the only re-sign input");
  }
  const next = structuredClone(baseline);
  const excludedPaths = sortUniquePaths(baseline.artifactInput.excludedPaths, "package-input excluded paths");
  assertPreOuterArtifactInputScope({ signingBound, excludedPaths, entries: preOuterEntries, label: "package-input" });
  next.artifactInput.excludedPaths = excludedPaths;
  next.artifactInput.digest = digestArtifactEntries(preOuterEntries, { excludedPaths });
  next.artifactInput.entryCount = countArtifactInputEntries(preOuterEntries, excludedPaths);
  next.signingBound = structuredClone(signingBound);
  next.digest = digestJson({ ...next, digest: undefined });
  return next;
}

export function rebindLicenseInventory({ baseline, packageInputs, preOuterEntries, signingBound } = {}) {
  validatePreOuterSigningBound(signingBound);
  if (!baseline?.artifact?.entryBinding || !Array.isArray(baseline.artifact.entryBinding.excludedPaths) || !Array.isArray(baseline.components)) {
    throw artifactResignError("baseline license inventory structure is missing", "use the accepted packaged license inventory as the only inventory input");
  }
  if (JSON.stringify(packageInputs?.signingBound) !== JSON.stringify(signingBound)) {
    throw artifactResignError("package-input and inventory pre-outer descriptors differ", "rebind both documents from one exact nested post-signing observation");
  }
  if (JSON.stringify(signingBound.inventoryProjection?.projection) !== JSON.stringify(inventoryPolicyProjection(baseline))) {
    throw artifactResignError("pre-outer inventory legal/component/notice projection changed", "copy the accepted inventory policy projection and update only signing-bound identities");
  }
  const next = structuredClone(baseline);
  const excludedPaths = sortUniquePaths(baseline.artifact.entryBinding.excludedPaths, "license inventory excluded paths");
  assertPreOuterArtifactInputScope({ signingBound, excludedPaths, entries: preOuterEntries, label: "license inventory" });
  next.artifact.entryBinding.excludedPaths = excludedPaths;
  next.artifact.entryBinding.digest = digestArtifactEntries(preOuterEntries, { excludedPaths });
  next.artifact.entryBinding.signingBound = structuredClone(signingBound);
  next.artifact.packageInputBinding = packageInputBinding(packageInputs);
  for (const component of next.components) {
    component.provenance.versionOrHash.artifactScopeSha256 = digestComponentEntries(preOuterEntries, component.artifactPathScope.paths, { excludedPaths });
  }
  assertInventoryPolicyPreserved(baseline, next);
  return next;
}

export function assertInventoryPolicyPreserved(baseline, rebound) {
  const before = inventoryPolicyProjection(baseline);
  const after = inventoryPolicyProjection(rebound);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw artifactResignError("license inventory notice text, component mapping, or owner decision changed during rebind", "copy the accepted inventory and update only signing-bound identities and derived scope hashes");
  }
  return rebound;
}

export function buildLicenseInventoryManifestBinding(entries, inventory, packageInputs) {
  const inventoryEntry = entries.find((entry) => entry.path === MACOS_LICENSE_INVENTORY_PATH && entry.type === "file");
  if (!inventoryEntry) throw artifactResignError("rebound license inventory is absent from the staged artifact", "write the regenerated inventory before rebuilding the external manifest");
  validatePreOuterSigningBound(inventory.artifact?.entryBinding?.signingBound);
  return {
    schema: inventory.schema,
    path: MACOS_LICENSE_INVENTORY_PATH,
    sha256: inventoryEntry.sha256,
    artifactEntryDigest: inventory.artifact.entryBinding.digest,
    excludedPathPrefixes: inventory.artifact.entryBinding.excludedPathPrefixes,
    excludedPaths: inventory.artifact.entryBinding.excludedPaths,
    componentCount: inventory.components.length,
    packageInputDigest: packageInputs.digest,
    packageInputArtifactDigest: packageInputs.artifactInput.digest,
    artifactEntryScope: MACOS_PRE_OUTER_SIGNING_BOUND_PHASE,
    signingBoundPhase: MACOS_PRE_OUTER_SIGNING_BOUND_PHASE,
  };
}

export function assertReboundDigestEquality({ finalEntries = null, scopedEntries = null, packageInputs, inventory, manifestBinding = null } = {}) {
  const packageArtifact = packageInputs?.artifactInput;
  const inventoryArtifact = inventory?.artifact?.entryBinding;
  if (!packageArtifact || !inventoryArtifact) {
    throw artifactResignError("rebound package-input or inventory artifact binding is missing", "regenerate both signing-bound metadata documents from the final entry set");
  }
  const signingBound = packageInputs?.signingBound;
  validatePreOuterSigningBound(signingBound);
  if (JSON.stringify(inventoryArtifact.signingBound) !== JSON.stringify(signingBound)) {
    throw artifactResignError("package-input and inventory signing-bound descriptors diverge", "retain one identical pre-outer descriptor in both rebound documents");
  }
  const entries = scopedEntries ?? finalEntries ?? [];
  const packageDigest = digestArtifactEntries(entries, { excludedPaths: packageArtifact.excludedPaths });
  const inventoryDigest = digestArtifactEntries(entries, { excludedPaths: inventoryArtifact.excludedPaths });
  const descriptorDigest = signingBound.ordinaryArtifactInput.digest;
  const descriptorExcludedPaths = signingBound.ordinaryArtifactInput.excludedPaths;
  if (packageArtifact.digest !== packageDigest || inventoryArtifact.digest !== inventoryDigest || packageArtifact.digest !== inventoryArtifact.digest) {
    throw artifactResignError(`rebound artifact digests diverge (package=${packageArtifact.digest}; packageComputed=${packageDigest}; inventory=${inventoryArtifact.digest}; inventoryComputed=${inventoryDigest})`, "recompute packageInputs.artifactInput and inventory artifact bindings from the exact pre-outer entry scope");
  }
  if (descriptorDigest !== packageArtifact.digest || JSON.stringify(descriptorExcludedPaths) !== JSON.stringify(packageArtifact.excludedPaths) || JSON.stringify(packageArtifact.excludedPaths) !== JSON.stringify(inventoryArtifact.excludedPaths)) {
    throw artifactResignError("rebound artifact-input scope is not the declared pre-outer descriptor", "bind package-input, inventory, and the descriptor to one exact nested post-signing scope");
  }
  if (manifestBinding !== null && (manifestBinding.artifactEntryDigest !== packageArtifact.digest || manifestBinding.packageInputArtifactDigest !== packageArtifact.digest)) {
    throw artifactResignError("composition manifest does not bind the same pre-outer artifact-input digest as package-input and inventory metadata", "write the manifest only after both rebound documents agree with the pre-outer scope");
  }
  return packageArtifact.digest;
}

export function buildArtifactResignManifest({ baselineManifest, packageInputs, inventory, signing, baseline, preOuterEntries = [], finalEntries = [], preOuterSigningBound, finalSigningBound, markerBytes } = {}) {
  const validatedBaseline = validateArtifactBaseline(baseline);
  validatePreOuterSigningBound(preOuterSigningBound);
  validateFinalSigningBound(finalSigningBound);
  const next = structuredClone(baselineManifest);
  next.packageInputs = structuredClone(packageInputs);
  next.signing = structuredClone(signing);
  next.licenseInventory = buildLicenseInventoryManifestBinding(finalEntries, inventory, packageInputs);
  next.entries = finalEntries.map((entry) => ({ ...entry }));
  next.macho = [...finalSigningBound.macho];
  assertReboundDigestEquality({ scopedEntries: preOuterEntries, packageInputs, inventory, manifestBinding: next.licenseInventory });
  next.artifactResign = {
    schema: MACOS_ARTIFACT_RESIGN_SCHEMA,
    authority: MACOS_ARTIFACT_RESIGN_AUTHORITY,
    stage: {
      markerSha256: sha256(markerBytes),
      markerEvidence: "owner-stage-marker-baseline-policy-payload-bound",
      bundlePath: MACOS_ARTIFACT_STAGE_BUNDLE_NAME,
      manifestPath: MACOS_ARTIFACT_STAGE_MANIFEST_NAME,
    },
    baseline: structuredClone(validatedBaseline),
    preOuter: {
      signingBound: structuredClone(preOuterSigningBound),
      entrySetDigest: digestSigningEntrySet(preOuterEntries),
      entryCount: preOuterEntries.length,
      packageInputDigest: packageInputs.digest,
      artifactInputDigest: packageInputs.artifactInput.digest,
      licenseInventorySha256: next.licenseInventory.sha256,
    },
    final: {
      signingBound: structuredClone(finalSigningBound),
      entrySetDigest: digestSigningEntrySet(finalEntries),
      entryCount: finalEntries.length,
      codeResourcesCount: finalSigningBound.codeResources.length,
      signatureStateDigest: signing.signatureStateDigest,
    },
    codeObjectCount: finalSigningBound.macho.length + 1,
    rebind: {
      packageInputDigest: packageInputs.digest,
      artifactInputDigest: packageInputs.artifactInput.digest,
      licenseInventorySha256: next.licenseInventory.sha256,
      signatureStateDigest: signing.signatureStateDigest,
    },
  };
  next.artifactDigest = digestManifest(next);
  return next;
}

export function validateArtifactResignLifecycleEvidence(evidence, { markerBytes, signingBound = null, baseline = null } = {}) {
  if (!evidence || evidence.schema !== MACOS_ARTIFACT_RESIGN_SCHEMA || evidence.authority !== MACOS_ARTIFACT_RESIGN_AUTHORITY) {
    throw artifactResignError("artifact re-sign lifecycle schema or authority is missing", "retain the explicit final F11 artifactResign evidence");
  }
  if (!evidence.stage || evidence.stage.markerSha256 !== sha256(markerBytes ?? Buffer.alloc(0)) || evidence.stage.markerEvidence !== "owner-stage-marker-baseline-policy-payload-bound" || evidence.stage.bundlePath !== MACOS_ARTIFACT_STAGE_BUNDLE_NAME || evidence.stage.manifestPath !== MACOS_ARTIFACT_STAGE_MANIFEST_NAME) {
    throw artifactResignError("artifact re-sign lifecycle stage marker evidence is missing or stale", "bind the final manifest to the exact owner stage marker and its baseline/policy/payload evidence");
  }
  const expectedBaseline = validateArtifactBaseline(baseline ?? evidence.baseline);
  if (JSON.stringify(validateArtifactBaseline(evidence.baseline)) !== JSON.stringify(expectedBaseline)) {
    throw artifactResignError("artifact re-sign lifecycle baseline is stale or differs from the prepared source-bound baseline", "retain the exact dynamic baseline captured before the one owner signing attempt");
  }
  if (signingBound !== null || evidence.signingBound !== undefined) {
    throw artifactResignError("artifact re-sign lifecycle uses obsolete single-phase metadata", "regenerate fresh metadata with separate pre-outer and final signing-bound descriptors");
  }
  const preOuterDescriptor = evidence.preOuter?.signingBound;
  const finalDescriptor = evidence.final?.signingBound;
  validatePreOuterSigningBound(preOuterDescriptor);
  validateFinalSigningBound(finalDescriptor);
  if (evidence.codeObjectCount !== 47 || preOuterDescriptor.macho.length !== 46 || finalDescriptor.macho.length !== 46 || preOuterDescriptor.codeResources.length !== 9 || finalDescriptor.codeResources.length !== 10) {
    throw artifactResignError("artifact re-sign lifecycle code-object count is not the exact 47-object closure", "retain exactly 46 nested Mach-O objects and the outer app");
  }
  if (JSON.stringify(finalDescriptor.codeResources.filter((candidate) => candidate !== MACOS_OUTER_CODE_RESOURCES_PATH)) !== JSON.stringify(preOuterDescriptor.codeResources)) {
    throw artifactResignError("artifact re-sign lifecycle nested CodeResources scopes differ", "carry the exact nine nested CodeResources from the pre-outer observation into final evidence");
  }
  if (!Number.isInteger(evidence.preOuter?.entryCount) || evidence.preOuter.entryCount <= 0 || !/^[a-f0-9]{64}$/u.test(evidence.preOuter?.entrySetDigest ?? "") || !/^[a-f0-9]{64}$/u.test(evidence.final?.entrySetDigest ?? "") || evidence.final?.entryCount !== evidence.preOuter.entryCount || !/^[a-f0-9]{64}$/u.test(evidence.final?.signatureStateDigest ?? "")) {
    throw artifactResignError("artifact re-sign lifecycle phase entry or signature evidence is missing", "record the pre-outer entry scope and final entry/signature observations separately");
  }
  const rebind = evidence.rebind;
  if (!rebind || typeof rebind !== "object" || !/^[a-f0-9]{64}$/u.test(rebind.packageInputDigest ?? "") || !/^[a-f0-9]{64}$/u.test(rebind.artifactInputDigest ?? "") || !/^[a-f0-9]{64}$/u.test(rebind.licenseInventorySha256 ?? "") || !/^[a-f0-9]{64}$/u.test(rebind.signatureStateDigest ?? "")) {
    throw artifactResignError("artifact re-sign lifecycle rebind evidence is missing", "record package-input, artifact-input, license-inventory, and signature-state identities after signing");
  }
  if (evidence.preOuter.packageInputDigest !== rebind.packageInputDigest || evidence.preOuter.artifactInputDigest !== rebind.artifactInputDigest || evidence.preOuter.licenseInventorySha256 !== rebind.licenseInventorySha256 || evidence.final.codeResourcesCount !== finalDescriptor.codeResources.length) {
    throw artifactResignError("artifact re-sign phase identities or CodeResources count diverge", "bind the pre-outer identity fields to the one rebind record and derive the final CodeResources count from its descriptor");
  }
  return evidence;
}

export function validateArtifactResignMetadata({ baselineManifest, baselineEntries, baselineMachOPayloads = null, baselineInventory, manifest, baseline = null, preOuterEntries = null, preOuterMachOPayloads = null, finalEntries, finalMachOPayloads = null, finalInventory, markerBytes } = {}) {
  if (!Array.isArray(preOuterEntries)) {
    throw artifactResignError("artifact re-sign pre-outer entry observation is missing", "retain the exact post-nested, pre-outer entry scope used for metadata rebind");
  }
  if (!Array.isArray(preOuterMachOPayloads) || !Array.isArray(finalMachOPayloads)) {
    throw artifactResignError("artifact re-sign phase Mach-O payload observations are missing", "bind both the post-nested pre-outer and final Mach-O payload observations before validating metadata");
  }
  const evidence = manifest?.artifactResign;
  validateArtifactResignLifecycleEvidence(evidence, { markerBytes, baseline });
  const preOuterDescriptor = evidence.preOuter.signingBound;
  const finalDescriptor = evidence.final.signingBound;
  if (evidence.codeObjectCount !== finalDescriptor.macho.length + 1) {
    throw artifactResignError("artifact re-sign code-object count is not the exact 47-object closure", "retain 46 nested Mach-O objects and sign the outer app last");
  }
  const finalCodeResourcePaths = finalEntries.filter((entry) => isCodeResourcesPath(entry.path)).map((entry) => entry.path);
  if (JSON.stringify(finalDescriptor) !== JSON.stringify(createSigningBoundDescriptor({ phase: MACOS_FINAL_SIGNING_BOUND_PHASE, machoPaths: manifest.macho, machoPayloads: finalDescriptor.machoPayloads, codeResourcePaths: finalCodeResourcePaths }))) {
    throw artifactResignError("artifact re-sign signing-bound path classifier differs from the final artifact", "regenerate the classifier from all final Mach-O and CodeResources paths");
  }
  if (JSON.stringify(manifest.packageInputs?.signingBound) !== JSON.stringify(preOuterDescriptor) || JSON.stringify(finalInventory?.artifact?.entryBinding?.signingBound) !== JSON.stringify(preOuterDescriptor)) {
    throw artifactResignError("artifact re-sign pre-outer descriptor is not rebound consistently across package-input and inventory metadata", "regenerate both documents from the same nested post-signing descriptor");
  }
  const observedPreOuterPayloads = validateMachOPayloadBindings(preOuterMachOPayloads, preOuterDescriptor.macho);
  if (JSON.stringify(observedPreOuterPayloads) !== JSON.stringify(preOuterDescriptor.machoPayloads)) {
    throw artifactResignError("artifact re-sign pre-outer Mach-O descriptor differs from its observed payloads", "retain the exact normalized post-nested Mach-O payload observation used for metadata rebind");
  }
  const observedFinalPayloads = validateMachOPayloadBindings(finalMachOPayloads, finalDescriptor.macho);
  if (JSON.stringify(observedFinalPayloads) !== JSON.stringify(finalDescriptor.machoPayloads)) {
    throw artifactResignError("artifact re-sign final Mach-O descriptor differs from its observed payloads", "retain the exact normalized post-outer Mach-O payload observation in final evidence");
  }
  if (JSON.stringify(finalCodeResourcePaths.filter((candidate) => candidate !== MACOS_OUTER_CODE_RESOURCES_PATH)) !== JSON.stringify(preOuterDescriptor.codeResources)) {
    throw artifactResignError("artifact re-sign final nested CodeResources scope differs from the pre-outer descriptor", "preserve the nine nested CodeResources after the outer sign");
  }
  if (evidence.final.signatureStateDigest !== manifest.signing?.signatureStateDigest || evidence.rebind?.packageInputDigest !== manifest.packageInputs?.digest || evidence.rebind?.artifactInputDigest !== manifest.packageInputs?.artifactInput?.digest || evidence.rebind?.licenseInventorySha256 !== manifest.licenseInventory?.sha256 || evidence.rebind?.signatureStateDigest !== manifest.signing?.signatureStateDigest) {
    throw artifactResignError("artifact re-sign package, license, or signature identity is stale", "rebind package-input and inventory metadata after final signature observation");
  }
  assertSigningBoundClosure({ baselineEntries, finalEntries, machoPaths: finalDescriptor.macho, baselineMachOPayloads, finalMachOPayloads });
  assertInventoryPolicyPreserved(baselineInventory, finalInventory);
  assertReboundDigestEquality({ scopedEntries: preOuterEntries, packageInputs: manifest.packageInputs, inventory: finalInventory, manifestBinding: manifest.licenseInventory });
  assertFinalOuterClosure({
    preOuterEntries,
    finalEntries,
    preOuterSigningBound: preOuterDescriptor,
    finalSigningBound: finalDescriptor,
  });
  if (evidence.preOuter.entrySetDigest !== digestSigningEntrySet(preOuterEntries)) {
    throw artifactResignError("artifact re-sign pre-outer entry scope digest is stale", "retain the exact post-nested, pre-outer entry observation used for metadata rebind");
  }
  if (evidence.final.entrySetDigest !== digestSigningEntrySet(finalEntries)) {
    throw artifactResignError("artifact re-sign final entry set digest is stale", "rebuild final evidence from the read-only post-outer entry observation");
  }
  if (manifest.artifactDigest !== digestManifest(manifest)) {
    throw artifactResignError("artifact re-sign manifest digest is stale", "hash the final external manifest after binding the retained staged artifact");
  }
  const expectedBaseline = validateArtifactBaseline(baseline ?? evidence.baseline);
  assertBaselineIdentity({ manifest: baselineManifest, marker: { baseline: expectedBaseline }, manifestBytes: null, expected: expectedBaseline });
  return manifest;
}

export function assertFinalOuterClosure({ preOuterEntries = [], finalEntries = [], preOuterSigningBound, finalSigningBound, licenseInventoryPath = MACOS_LICENSE_INVENTORY_PATH } = {}) {
  validatePreOuterSigningBound(preOuterSigningBound);
  validateFinalSigningBound(finalSigningBound);
  const beforeMap = new Map(preOuterEntries.map((entry) => [entry.path, entry]));
  const afterMap = new Map(finalEntries.map((entry) => [entry.path, entry]));
  const missing = [...beforeMap.keys()].filter((relativePath) => !afterMap.has(relativePath));
  const extra = [...afterMap.keys()].filter((relativePath) => !beforeMap.has(relativePath));
  if (missing.length || extra.length) {
    throw artifactResignError(`post-outer artifact path set changed (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`, "retain the exact package shape after the outer sign and before final validation");
  }
  const finalCodeResources = [...afterMap.keys()].filter(isCodeResourcesPath).sort((left, right) => left.localeCompare(right));
  const expectedFinalCodeResources = [...finalSigningBound.codeResources].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(finalCodeResources) !== JSON.stringify(expectedFinalCodeResources)) {
    throw artifactResignError("post-outer CodeResources set differs from the final descriptor", "retain all nine nested CodeResources and the outer CodeResources file");
  }
  const nestedCodeResources = finalCodeResources.filter((relativePath) => relativePath !== MACOS_OUTER_CODE_RESOURCES_PATH);
  if (JSON.stringify(nestedCodeResources) !== JSON.stringify(preOuterSigningBound.codeResources)) {
    throw artifactResignError("post-outer nested CodeResources scope differs from the pre-outer descriptor", "do not mutate nested signing metadata after the inventory write");
  }
  assertMachOPayloadClosure({ baselinePayloads: preOuterSigningBound.machoPayloads, finalPayloads: finalSigningBound.machoPayloads });
  const machoSet = new Set(preOuterSigningBound.macho);
  for (const [relativePath, before] of beforeMap) {
    const after = afterMap.get(relativePath);
    if (relativePath === MACOS_OUTER_CODE_RESOURCES_PATH) {
      if (before.type !== "file" || after.type !== "file") {
        throw artifactResignError("outer CodeResources is not a regular file after signing", "retain the final outer signing metadata as one regular file");
      }
      continue;
    }
    if (machoSet.has(relativePath)) {
      if (before.type !== "file" || after.type !== "file") {
        throw artifactResignError(`Mach-O signing path ${relativePath} is not a regular file after the outer sign`, "retain every nested Mach-O as a regular file");
      }
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const classification = classifySigningBoundPath(relativePath, { machoPaths: preOuterSigningBound.macho, licenseInventoryPath });
      const detail = classification === "code-resources" ? "nested CodeResources" : classification === "license-inventory" ? "license inventory" : "ordinary payload";
      throw artifactResignError(`post-outer ${detail} changed at ${relativePath}`, "stop finalization and retain the pre-outer artifact without post-outer app writes");
    }
  }
  return finalEntries;
}

export function assertSigningBoundClosure({ baselineEntries = [], finalEntries = [], machoPaths = [], baselineMachOPayloads = null, finalMachOPayloads = null, licenseInventoryPath = MACOS_LICENSE_INVENTORY_PATH } = {}) {
  const baselineMap = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const finalMap = new Map(finalEntries.map((entry) => [entry.path, entry]));
  const missing = [...baselineMap.keys()].filter((relativePath) => !finalMap.has(relativePath));
  const extra = [...finalMap.keys()].filter((relativePath) => !baselineMap.has(relativePath));
  if (missing.length || extra.length) {
    const codeResourceDifference = [...missing, ...extra].find((relativePath) => isCodeResourcesPath(relativePath));
    if (codeResourceDifference) {
      throw artifactResignError(`CodeResources path set changed at ${codeResourceDifference} (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`, "restore the exact nested CodeResources set; only its bytes may change during signing");
    }
    throw artifactResignError(`staged artifact path set changed (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`, "restore the exact accepted package shape before retaining the signed candidate");
  }
  const machoSet = new Set(machoPaths);
  if (baselineMachOPayloads !== null || finalMachOPayloads !== null) {
    if (baselineMachOPayloads === null || finalMachOPayloads === null) {
      throw artifactResignError("Mach-O payload closure is only partially supplied", "bind and compare the precise LC_CODE_SIGNATURE-excluded payload for every Mach-O before accepting the candidate");
    }
    assertMachOPayloadClosure({ baselinePayloads: baselineMachOPayloads, finalPayloads: finalMachOPayloads });
  }
  for (const [relativePath, before] of baselineMap) {
    const after = finalMap.get(relativePath);
    const classification = classifySigningBoundPath(relativePath, { machoPaths, licenseInventoryPath });
    if (classification === "ordinary-payload") {
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const notice = relativePath.includes("/notices/") ? "notice/license text" : "ordinary payload";
        const symlink = before.type === "symlink" || after.type === "symlink" ? "symlink target" : notice;
        throw artifactResignError(`${notice} changed at ${relativePath}; observed ${symlink}`, "discard the staged candidate and restore the accepted non-signing bytes");
      }
    } else if (after.type !== "file" || before.type !== "file") {
      throw artifactResignError(`signing-bound path ${relativePath} is not a regular file after signing`, `restore the ${classification} file before the one authorized signing attempt`);
    }
  }
  const actualMachO = [...finalMap.keys()].filter((relativePath) => machoSet.has(relativePath));
  if (actualMachO.length !== machoSet.size) {
    throw artifactResignError("final Mach-O signing-bound set differs from the baseline", "retain exactly the accepted 46 nested Mach-O paths");
  }
  const codeResources = [...finalMap.keys()].filter(isCodeResourcesPath).sort((left, right) => left.localeCompare(right));
  const baselineCodeResources = [...baselineMap.keys()].filter(isCodeResourcesPath).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(codeResources) !== JSON.stringify(baselineCodeResources)) {
    throw artifactResignError("final CodeResources set differs from the baseline", "retain every nested and outer **/_CodeSignature/CodeResources path");
  }
  const inventory = finalMap.get(licenseInventoryPath);
  if (!inventory || inventory.type !== "file") {
    throw artifactResignError(`final license inventory ${licenseInventoryPath} is missing or not a regular file`, "regenerate the packaged license inventory before the final outer sign");
  }
  return { machoPaths: [...machoSet].sort((left, right) => left.localeCompare(right)), codeResourcePaths: codeResources };
}

function compareExactEntrySets(expected, actual, label) {
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = expected.filter((entry) => !actualMap.has(entry.path)).map((entry) => entry.path);
  const extra = actual.filter((entry) => !expectedMap.has(entry.path)).map((entry) => entry.path);
  if (missing.length || extra.length) {
    throw artifactResignError(`${label} path set differs (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`, "restore the exact accepted app shape before signing");
  }
  for (const expectedEntry of expected) {
    const actualEntry = actualMap.get(expectedEntry.path);
    if (JSON.stringify(expectedEntry) !== JSON.stringify(actualEntry)) {
      const detail = expectedEntry.type === "symlink" ? "symlink target" : isCodeResourcesPath(expectedEntry.path) ? "CodeResources bytes" : "ordinary payload bytes";
      throw artifactResignError(`${label} ${detail} changed at ${expectedEntry.path}`, "restore the accepted staged baseline before the first codesign call");
    }
  }
}

function inventoryPolicyProjection(inventory) {
  const projection = structuredClone(inventory);
  if (projection?.artifact?.entryBinding) {
    delete projection.artifact.entryBinding.digest;
    delete projection.artifact.entryBinding.excludedPaths;
    delete projection.artifact.entryBinding.signingBound;
  }
  delete projection?.artifact?.packageInputBinding;
  for (const component of projection?.components ?? []) {
    if (component?.provenance?.versionOrHash) delete component.provenance.versionOrHash.artifactScopeSha256;
  }
  return projection;
}

function packageInputBinding(packageInputs) {
  return {
    schema: packageInputs.schema,
    digest: packageInputs.digest,
    sourceSnapshotDigest: packageInputs.sourceSnapshot.digest,
    artifactInputDigest: packageInputs.artifactInput.digest,
    packageMemberDigest: packageInputs.packageMemberDigest,
    workspaceMemberDigest: packageInputs.workspaceMemberDigest,
    inputCount: packageInputs.inputs.length,
    packageMemberCount: packageInputs.packageMembers.length,
    workspaceMemberCount: packageInputs.workspaceMembers.length,
    lockMetadataGapCount: packageInputs.lockMetadataGapCount,
  };
}

function countArtifactInputEntries(entries, excludedPaths) {
  const excluded = new Set(excludedPaths);
  return entries.filter((entry) => !excluded.has(entry.path) && !entry.path.startsWith("Contents/_CodeSignature/")).length;
}

function machOSignatureIdentifier(relativePath) {
  return `com.meetless.package.macho.${sha256(Buffer.from(relativePath)).slice(0, 16)}`;
}

async function runCodesign(arguments_, context) {
  return runOwnedCodesignChild(arguments_, context, {
    signalController: context?.signalController,
    ownerMode: context?.signalController !== null && context?.signalController !== undefined,
  });
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw artifactResignError(`${label} is not valid JSON: ${describe(error)}`, "restore the accepted machine-readable stage metadata");
  }
}

function normalizeRelativePath(candidate, label) {
  if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate)) {
    throw artifactResignError(`${label} is absolute or empty: ${String(candidate)}`, "use one normalized path relative to Meetless.app");
  }
  const normalized = candidate.replaceAll(path.sep, "/");
  if (path.posix.normalize(normalized) !== normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw artifactResignError(`${label} escapes the staged app: ${candidate}`, "use the exact in-package relative path");
  }
  return normalized;
}

function sortUniquePaths(paths, label) {
  if (!Array.isArray(paths)) throw artifactResignError(`${label} is missing`, "derive a complete sorted path list from the staged artifact");
  const normalized = paths.map((candidate) => normalizeRelativePath(candidate, label));
  if (new Set(normalized).size !== normalized.length) throw artifactResignError(`${label} contains a duplicate path`, "record each signing-bound path exactly once");
  return normalized.sort((left, right) => left.localeCompare(right));
}

function isSameOrInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function digestManifest(manifest) {
  return sha256(JSON.stringify({ ...manifest, artifactDigest: undefined }));
}

export function digestSigningEntrySet(entries) {
  return digestJson((entries ?? [])
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      ...(entry.type === "file" ? { size: entry.size } : { target: entry.target }),
      sha256: entry.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function digestJson(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactResignError(reason, nextAction) {
  return new Error(`${reason}. Authority: ${MACOS_ARTIFACT_RESIGN_AUTHORITY}. Next action: ${nextAction}.`);
}

function publicOwnerError(error) {
  return {
    code: typeof error?.code === "string" && /^[A-Za-z0-9_.-]+$/u.test(error.code) ? error.code : "owner-transform-failure",
    message: String(error?.message ?? error).replaceAll(/\s+/gu, " ").slice(0, 512),
  };
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
