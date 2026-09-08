export const MACOS_MAS_SIGNING_BOUNDARY_SCHEMA = "MEETLESS_MACOS_MAS_SIGNING_BOUNDARY v1";
export const MACOS_MAS_SIGNING_BOUNDARY_AUTHORITY = "docs/specs/macos-artifact-validation.md";
export const MACOS_MAS_SIGNING_BOUNDARY_CLASSIFIER =
  "macho-signature | signing-mutated-code-resources | outer-code-resources | license-inventory | ordinary-payload";
export const MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN = "pre-sign";
export const MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL = "final";
export const MACOS_MAS_OUTER_CODE_RESOURCES_PATH = "Contents/_CodeSignature/CodeResources";
export const MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES = Object.freeze(sortPaths([
  "Contents/Helpers/Electron.app/Contents/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Frameworks/Electron Helper (Plugin).app/Contents/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/_CodeSignature/CodeResources",
  "Contents/Helpers/Electron.app/Contents/Library/LoginItems/Electron Login Helper.app/Contents/_CodeSignature/CodeResources",
]));

const ALL_CODE_RESOURCES = Object.freeze(sortPaths([
  MACOS_MAS_OUTER_CODE_RESOURCES_PATH,
  ...MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES,
]));

export function isMacOSCodeResourcesPath(relativePath) {
  return typeof relativePath === "string" && /(?:^|\/)_CodeSignature\/CodeResources$/u.test(relativePath);
}

export function classifyMacOSMasSigningBoundPath(
  relativePath,
  { machoPaths = [], licenseInventoryPath = "Contents/Resources/meetless/notices/license-inventory.json" } = {},
) {
  const macho = new Set(machoPaths);
  if (macho.has(relativePath)) return "macho-signature";
  if (relativePath === licenseInventoryPath) return "license-inventory";
  if (MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES.includes(relativePath)) return "signing-mutated-code-resources";
  if (relativePath === MACOS_MAS_OUTER_CODE_RESOURCES_PATH) return "outer-code-resources";
  if (isMacOSCodeResourcesPath(relativePath)) return "unexpected-code-resources";
  return "ordinary-payload";
}

export function validateMacOSMasSigningBoundaryEntries(
  entries,
  {
    phase = MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
    expectedMachoPaths = null,
  } = {},
) {
  const expectedCodeResources = expectedMacOSMasCodeResourcesForPhase(phase);
  if (!Array.isArray(entries)) {
    throw masSigningBoundaryError(
      `MAS ${phase} signing-boundary validation has no actual package entries`,
      "enumerate the actual package before validating its phase-specific CodeResources set",
    );
  }
  const paths = entries.map((entry) => {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      throw masSigningBoundaryError(
        `MAS ${phase} signing-boundary validation received a malformed package entry`,
        "enumerate sorted unique package entries before validating signing evidence",
      );
    }
    return entry.path;
  });
  const duplicate = findDuplicate(paths);
  if (duplicate) {
    throw masSigningBoundaryError(
      `MAS ${phase} signing-boundary validation received duplicate package entry ${duplicate}`,
      "enumerate sorted unique package entries before validating signing evidence",
    );
  }
  const actualCodeResources = sortPaths(paths.filter(isMacOSCodeResourcesPath));
  assertExactCodeResources(actualCodeResources, expectedCodeResources, `actual MAS ${phase} package`);
  for (const relativePath of expectedCodeResources) {
    const entry = entries.find((candidate) => candidate.path === relativePath);
    if (entry?.type !== "file") {
      throw masSigningBoundaryError(
        `MAS ${phase} signing-bound CodeResources path ${relativePath} is not a regular file`,
        "retain each phase-expected CodeResources path as a regular package file",
      );
    }
  }
  if (expectedMachoPaths !== null) {
    const normalizedMachoPaths = normalizePaths(expectedMachoPaths, "expected Mach-O paths");
    for (const relativePath of normalizedMachoPaths) {
      if (!paths.includes(relativePath)) {
        throw masSigningBoundaryError(
          `MAS ${phase} signing-bound Mach-O path ${relativePath} is absent from the actual package entries`,
          "derive signing evidence from the complete inspected Mach-O closure",
        );
      }
    }
  }
  return actualCodeResources;
}

export function createMacOSMasSigningBoundDescriptor({
  entries,
  machoPaths = [],
  licenseInventoryPath = "Contents/Resources/meetless/notices/license-inventory.json",
  phase = MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN,
} = {}) {
  if (!Array.isArray(entries)) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor has no actual package entries",
      "enumerate the package before deriving the exact pre-sign or final signing boundary",
    );
  }
  const paths = entries.map((entry) => entry?.path);
  const duplicate = findDuplicate(paths);
  if (duplicate) {
    throw masSigningBoundaryError(
      `MAS signing-bound descriptor received duplicate package entry ${duplicate}`,
      "enumerate sorted unique package entries before deriving signing evidence",
    );
  }
  const normalizedMachoPaths = normalizePaths(machoPaths, "Mach-O signing-bound paths");
  validateMacOSMasSigningBoundaryEntries(entries, {
    phase,
    expectedMachoPaths: normalizedMachoPaths,
  });
  for (const relativePath of normalizedMachoPaths) {
    if (!paths.includes(relativePath)) {
      throw masSigningBoundaryError(
        `MAS signing-bound Mach-O path ${relativePath} is absent from the actual package entries`,
        "derive the signing boundary from the complete inspected Mach-O closure",
      );
    }
  }
  const descriptor = {
    schema: MACOS_MAS_SIGNING_BOUNDARY_SCHEMA,
    route: "mas",
    classifier: MACOS_MAS_SIGNING_BOUNDARY_CLASSIFIER,
    licenseInventoryPath,
    machoPaths: normalizedMachoPaths,
    codeResources: [...ALL_CODE_RESOURCES],
    signingMutatedCodeResources: [...MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES],
    excludedPaths: sortPaths([
      licenseInventoryPath,
      ...normalizedMachoPaths,
      ...ALL_CODE_RESOURCES,
    ]),
    counts: {
      macho: normalizedMachoPaths.length,
      codeResources: ALL_CODE_RESOURCES.length,
      signingMutatedCodeResources: MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES.length,
      ordinaryPayloadExcluded: 1 + normalizedMachoPaths.length + ALL_CODE_RESOURCES.length,
    },
  };
  return validateMacOSMasSigningBoundDescriptor(descriptor);
}

export function validateMacOSMasSigningBoundDescriptor(
  descriptor,
  {
    expectedMachoPaths = null,
    expectedLicenseInventoryPath = "Contents/Resources/meetless/notices/license-inventory.json",
  } = {},
) {
  const expectedKeys = [
    "classifier",
    "codeResources",
    "counts",
    "excludedPaths",
    "licenseInventoryPath",
    "machoPaths",
    "route",
    "schema",
    "signingMutatedCodeResources",
  ].sort();
  const actualKeys = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)
    ? Object.keys(descriptor).sort()
    : [];
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
      JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
      descriptor.schema !== MACOS_MAS_SIGNING_BOUNDARY_SCHEMA ||
      descriptor.route !== "mas" ||
      descriptor.classifier !== MACOS_MAS_SIGNING_BOUNDARY_CLASSIFIER) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor schema or classifier is missing or changed",
      "use the shared exact MAS signing-boundary descriptor for package-input and license evidence",
    );
  }
  if (descriptor.licenseInventoryPath !== expectedLicenseInventoryPath ||
      typeof descriptor.licenseInventoryPath !== "string" ||
      descriptor.licenseInventoryPath.length === 0 ||
      descriptor.licenseInventoryPath.startsWith("/") ||
      descriptor.licenseInventoryPath.includes("..")) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor license-inventory path is invalid",
      "bind the fixed package-relative license inventory path",
    );
  }
  const machoPaths = normalizePaths(descriptor.machoPaths, "MAS signing-bound Mach-O paths");
  const codeResources = normalizePaths(descriptor.codeResources, "MAS signing-bound CodeResources paths");
  const mutatedCodeResources = normalizePaths(
    descriptor.signingMutatedCodeResources,
    "MAS signing-bound mutated CodeResources paths",
  );
  const excludedPaths = normalizePaths(descriptor.excludedPaths, "MAS signing-bound ordinary exclusions");
  if (JSON.stringify(machoPaths) !== JSON.stringify(descriptor.machoPaths) ||
      JSON.stringify(codeResources) !== JSON.stringify(descriptor.codeResources) ||
      JSON.stringify(mutatedCodeResources) !== JSON.stringify(descriptor.signingMutatedCodeResources) ||
      JSON.stringify(excludedPaths) !== JSON.stringify(descriptor.excludedPaths)) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor paths are not sorted and unique",
      "regenerate one deterministic descriptor from the actual package entry set",
    );
  }
  assertExactCodeResources(codeResources, ALL_CODE_RESOURCES, "MAS signing-bound descriptor");
  if (JSON.stringify(mutatedCodeResources) !== JSON.stringify(MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES)) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor does not contain the exact seven nested CodeResources paths",
      "restore the pinned MAS Electron signer-mutated CodeResources path set",
    );
  }
  if (expectedMachoPaths !== null && JSON.stringify(machoPaths) !== JSON.stringify(normalizePaths(expectedMachoPaths, "expected Mach-O paths"))) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor Mach-O path set differs from the actual inspected closure",
      "derive package-input and final evidence from one complete Mach-O observation",
    );
  }
  const expectedExcludedPaths = sortPaths([
    expectedLicenseInventoryPath,
    ...machoPaths,
    ...ALL_CODE_RESOURCES,
  ]);
  if (JSON.stringify(excludedPaths) !== JSON.stringify(expectedExcludedPaths)) {
    throw masSigningBoundaryError(
      "MAS signing-bound ordinary exclusions are not the inventory, Mach-O, and exact eight CodeResources paths",
      "exclude only the exact seven nested and outer CodeResources paths from ordinary pre-sign digests",
    );
  }
  const expectedCounts = {
    macho: machoPaths.length,
    codeResources: ALL_CODE_RESOURCES.length,
    signingMutatedCodeResources: MACOS_MAS_SIGNING_MUTATED_CODE_RESOURCES.length,
    ordinaryPayloadExcluded: expectedExcludedPaths.length,
  };
  if (JSON.stringify(descriptor.counts) !== JSON.stringify(expectedCounts)) {
    throw masSigningBoundaryError(
      "MAS signing-bound descriptor counts are stale",
      "derive all signing-bound counts from the exact descriptor path sets",
    );
  }
  if (machoPaths.some((candidate) => codeResources.includes(candidate) || candidate === expectedLicenseInventoryPath) ||
      codeResources.includes(expectedLicenseInventoryPath)) {
    throw masSigningBoundaryError(
      "MAS signing-bound path classes overlap",
      "keep Mach-O, CodeResources, and license-inventory paths disjoint",
    );
  }
  return descriptor;
}

function assertExactCodeResources(actual, expected, label) {
  const missing = expected.filter((candidate) => !actual.includes(candidate));
  const extra = actual.filter((candidate) => !expected.includes(candidate));
  if (missing.length || extra.length) {
    throw masSigningBoundaryError(
      `${label} CodeResources path set differs from the exact MAS signer-mutated set` +
        ` (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
      "retain only the outer CodeResources before signing and exactly the seven nested signer outputs after signing",
    );
  }
}

function expectedMacOSMasCodeResourcesForPhase(phase) {
  if (phase === MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN) return [MACOS_MAS_OUTER_CODE_RESOURCES_PATH];
  if (phase === MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL) return [...ALL_CODE_RESOURCES];
  throw masSigningBoundaryError(
    `MAS signing phase ${String(phase)} is not supported`,
    `use ${MACOS_MAS_SIGNING_BOUNDARY_PHASE_PRE_SIGN} or ${MACOS_MAS_SIGNING_BOUNDARY_PHASE_FINAL}`,
  );
}

function normalizePaths(paths, label) {
  if (!Array.isArray(paths)) {
    throw masSigningBoundaryError(`${label} are missing`, "derive one sorted path array from the inspected package");
  }
  const values = paths.map((candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.startsWith("/")) {
      throw masSigningBoundaryError(`${label} contain an invalid path`, "use non-empty package-relative paths");
    }
    return candidate;
  });
  const duplicate = findDuplicate(values);
  if (duplicate) {
    throw masSigningBoundaryError(`${label} contain duplicate path ${duplicate}`, "sort and de-duplicate the shared path set");
  }
  return sortPaths(values);
}

function sortPaths(paths) {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function findDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function masSigningBoundaryError(reason, nextAction) {
  return new Error(
    `${reason}. Authority: ${MACOS_MAS_SIGNING_BOUNDARY_AUTHORITY}. Next action: ${nextAction}.`,
  );
}
