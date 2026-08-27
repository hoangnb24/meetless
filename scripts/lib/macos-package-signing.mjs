import { createHash, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeMachOSlices } from "./macos-package-inventory.mjs";

const execFileAsync = promisify(execFile);

export const MACOS_OWNER_TOOL_PATHS = Object.freeze({
  codesign: "/usr/bin/codesign",
  plutil: "/usr/bin/plutil",
  security: "/usr/bin/security",
});

function ownerToolEnvironment(environment = process.env) {
  const sanitized = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  for (const name of ["HOME", "USER", "LOGNAME", "TERM", "TERM_PROGRAM"]) {
    if (typeof environment?.[name] === "string" && environment[name].length > 0) sanitized[name] = environment[name];
  }
  return sanitized;
}

export const MACOS_SIGNING_SCHEMA = "MEETLESS_MACOS_SIGNING v1";
export const MACOS_SIGNING_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";
export const LOCAL_AD_HOC_SIGNING_MODE = "local-ad-hoc";
export const RELEASE_SIGNING_MODE = "release";
export const MACOS_SIGNING_MODES = Object.freeze([LOCAL_AD_HOC_SIGNING_MODE, RELEASE_SIGNING_MODE]);
export const MACOS_SIGNING_OUTER_PATH = "Meetless.app";
export const MACOS_ENTITLEMENT_POLICY_SCHEMA = "MEETLESS_MACOS_ENTITLEMENT_MAP v1";
export const MACOS_ENTITLEMENT_MAP_PATH = "scripts/macos-entitlements/entitlement-map.json";
export const MACOS_REQUIRED_MACHO_FILE_TYPE = "MH_EXECUTE";
export const MACOS_REQUIRED_MACHO_ARCHITECTURE = "arm64";
export const MACOS_REQUIRED_DEVELOPER_ID_TEAM = "63M98WD275";
export const MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1 = "d3ca2aea2dcbf578d27cfc3557bffcb41e370561";
export const MACOS_RELEASE_TIMESTAMP_ARGUMENT = "--timestamp";
export const MACOS_LOCAL_TIMESTAMP_ARGUMENT = "--timestamp=none";

export const MACOS_APPROVED_ENTITLEMENT_MAP = Object.freeze([
  Object.freeze({
    path: "Contents/Resources/meetless/runtime/node",
    class: "jit",
    plist: "entitlements/jit.plist",
    key: "com.apple.security.cs.allow-jit",
  }),
  Object.freeze({
    path: "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
    class: "jit",
    plist: "entitlements/jit.plist",
    key: "com.apple.security.cs.allow-jit",
  }),
  Object.freeze({
    path: "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)",
    class: "jit",
    plist: "entitlements/jit.plist",
    key: "com.apple.security.cs.allow-jit",
  }),
  Object.freeze({
    path: "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)",
    class: "jit",
    plist: "entitlements/jit.plist",
    key: "com.apple.security.cs.allow-jit",
  }),
  Object.freeze({
    path: "Contents/Resources/meetless/native/macos-capture/meetless-capture",
    class: "audio-input",
    plist: "entitlements/audio-input.plist",
    key: "com.apple.security.device.audio-input",
  }),
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const CD_HASH_PATTERN = /^[a-f0-9]{40}$/u;
const TEAM_ID_PATTERN = /^[A-Z0-9]{5,20}$/u;
const DEVELOPER_ID_APPLICATION_PATTERN = /^Developer ID Application: .+ \(([A-Z0-9]{5,20})\)$/u;

export function parseSigningArguments(arguments_, { requireMode = false } = {}) {
  let signingMode = null;
  let signingIdentity = null;
  let entitlementsPath = null;
  let expectedTeamId = null;
  let manifestPath = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      if (manifestPath) throw signingError(`multiple manifest paths were supplied: ${manifestPath} and ${argument}`, "provide one composition manifest path");
      manifestPath = argument;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const option = {
      "--signing-mode": "signingMode",
      "--signing-identity": "signingIdentity",
      "--entitlements": "entitlementsPath",
      "--team-id": "expectedTeamId",
    }[name];
    if (!option) throw signingError(`unsupported signing option ${name}`, "use --signing-mode, --signing-identity, --entitlements, or --team-id; the checked-in entitlement map cannot be overridden");
    if (arguments_.slice(0, index).some((candidate) => candidate === argument || candidate.startsWith(`${name}=`))) {
      throw signingError(`${name} was supplied more than once`, "supply one explicit value for each signing option");
    }
    const value = inlineValue ?? arguments_[++index];
    if (!value || value.startsWith("--")) throw signingError(`${name} has no value`, `supply an explicit value for ${name}`);
    if ({ signingMode, signingIdentity, entitlementsPath, expectedTeamId }[option] !== null) {
      throw signingError(`${name} was supplied more than once`, "supply one explicit value for each signing option");
    }
    if (option === "signingMode") signingMode = value;
    if (option === "signingIdentity") signingIdentity = value;
    if (option === "entitlementsPath") entitlementsPath = value;
    if (option === "expectedTeamId") expectedTeamId = value;
  }

  if (requireMode && signingMode === null) {
    throw signingError("signing mode is not explicit", "supply --signing-mode=local-ad-hoc or --signing-mode=release");
  }
  if (signingMode !== null && !MACOS_SIGNING_MODES.includes(signingMode)) {
    throw signingError(`unsupported signing mode ${signingMode}`, "use local-ad-hoc for local proof or release for supplied Developer ID preparation");
  }
  if (expectedTeamId !== null && !TEAM_ID_PATTERN.test(expectedTeamId)) {
    throw signingError(`Team ID ${expectedTeamId} is not a valid uppercase Apple Team ID evidence value`, "supply the Team ID shown by the signing identity");
  }
  return { signingMode, signingIdentity, entitlementsPath, expectedTeamId, manifestPath };
}

export function normalizeSigningOptions({ mode, signingMode = mode, signingIdentity = null, entitlementsPath = null, entitlementMapPath = null, expectedTeamId = null, requireEntitlementMap = true } = {}) {
  if (!MACOS_SIGNING_MODES.includes(signingMode)) {
    throw signingError(`signing mode is ${String(signingMode)}`, "supply --signing-mode=local-ad-hoc or --signing-mode=release");
  }
  const identity = signingIdentity?.trim() || null;
  const entitlementFile = entitlementsPath?.trim() || null;
  const entitlementMap = entitlementMapPath?.trim() || null;
  const teamId = expectedTeamId?.trim() || null;
  if (teamId !== null && !TEAM_ID_PATTERN.test(teamId)) {
    throw signingError(`Team ID ${teamId} is not a valid uppercase Apple Team ID evidence value`, "supply the Team ID shown by the signing identity");
  }
  if (signingMode === LOCAL_AD_HOC_SIGNING_MODE) {
    if (identity !== null && identity !== "-") {
      throw signingError(`local ad-hoc mode received release identity ${identity}`, "use --signing-mode=release with an explicit signing identity");
    }
    if (entitlementFile !== null || entitlementMap !== null) {
      throw signingError("local ad-hoc mode received an entitlement policy input", "use --signing-mode=release for hardened-runtime entitlements");
    }
    if (teamId !== null) {
      throw signingError("local ad-hoc mode received a Team ID", "use --signing-mode=release for Developer ID Team ID evidence");
    }
    return {
      mode: LOCAL_AD_HOC_SIGNING_MODE,
      identity: "-",
      entitlementsPath: null,
      entitlementMapPath: null,
      expectedTeamId: null,
    };
  }
  if (!identity) {
    throw signingError("release signing identity is missing", "supply --signing-identity with the intended Developer ID identity");
  }
  if (identity === "-" || /^adhoc$/iu.test(identity)) {
    throw signingError(`release signing identity ${identity} is ad-hoc`, "supply a non-ad-hoc Developer ID Application identity");
  }
  if (entitlementFile !== null) {
    throw signingError("release mode received a single outer-app entitlement file", `use the checked-in ${MACOS_ENTITLEMENT_MAP_PATH} per-executable policy`);
  }
  if (entitlementMap !== null && entitlementMap !== MACOS_ENTITLEMENT_MAP_PATH) {
    throw signingError(
      `release entitlement map override ${entitlementMap} is not the checked-in authority path`,
      `use ${MACOS_ENTITLEMENT_MAP_PATH}; production release policy cannot be overridden`,
    );
  }
  return {
    mode: RELEASE_SIGNING_MODE,
    identity,
    entitlementsPath: null,
    entitlementMapPath: MACOS_ENTITLEMENT_MAP_PATH,
    expectedTeamId: teamId,
  };
}

export async function resolveSigningInputs(options = {}) {
  const normalized = normalizeSigningOptions(options);
  if (normalized.mode === LOCAL_AD_HOC_SIGNING_MODE) {
    return {
      ...normalized,
      requestedIdentity: normalized.identity,
      resolvedIdentity: "-",
      leafSigner: "-",
      certificateFingerprint: null,
      certificateSha1: null,
      resolvedTeamId: null,
      entitlementPolicy: null,
    };
  }
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const entitlementPolicy = await loadEntitlementPolicy({
    entitlementMapPath: MACOS_ENTITLEMENT_MAP_PATH,
    repositoryRoot,
    ownerMode: options.ownerMode === true,
  });
  const signer = await resolveDeveloperIdSigner({
    requestedIdentity: normalized.identity,
    expectedTeamId: normalized.expectedTeamId,
    ownerMode: options.ownerMode === true,
  });
  return {
    ...normalized,
    identity: signer.certificateSha1,
    requestedIdentity: normalized.identity,
    resolvedIdentity: signer.identity,
    leafSigner: signer.identity,
    certificateFingerprint: signer.certificateFingerprint,
    certificateSha1: signer.certificateSha1,
    resolvedTeamId: signer.teamId,
    entitlementPolicy,
  };
}

export async function resolveDeveloperIdSigner({
  requestedIdentity,
  expectedTeamId = null,
  findIdentityOutput = null,
  findCertificateOutput = null,
  runSecurity = runSecurityCommand,
  ownerMode = false,
} = {}) {
  if (typeof requestedIdentity !== "string" || !requestedIdentity) {
    throw signingError("release signing identity is missing", "supply the exact Developer ID Application identity");
  }
  const identityOutput = findIdentityOutput ?? await runSecurity(["find-identity", "-v", "-p", "codesigning"], { ownerMode });
  const identities = parseSecurityIdentityOutput(identityOutput);
  const requestedFingerprint = requestedIdentity.toLowerCase();
  const matches = identities.filter((candidate) => candidate.identity === requestedIdentity || candidate.certificateSha1 === requestedFingerprint);
  if (matches.length === 0) {
    throw signingError(
      `release signing identity ${requestedIdentity} was not resolved to one valid certificate identity`,
      "supply one exact identity returned by security find-identity -v -p codesigning",
    );
  }
  if (matches.length !== 1) {
    throw signingError(
      `release signing identity ${requestedIdentity} is ambiguous across ${matches.length} valid certificates`,
      "supply the exact certificate SHA-1 identity or remove duplicate matching certificates",
    );
  }
  const selected = matches[0];
  const teamId = parseDeveloperIdTeamId(selected.identity);
  if (!teamId) {
    throw signingError(
      `resolved signing identity ${selected.identity} is not a Developer ID Application leaf signer`,
      "supply a valid Developer ID Application certificate, not Apple Development, Apple Distribution, or ad-hoc signing",
    );
  }
  if (expectedTeamId !== null && teamId !== expectedTeamId) {
    throw signingError(
      `resolved signing identity Team ID ${teamId} differs from requested Team ID ${expectedTeamId}`,
      "supply the Team ID belonging to the exact Developer ID Application certificate",
    );
  }
  const certificateOutput = findCertificateOutput ?? await runSecurity(["find-certificate", "-a", "-Z", "-c", selected.identity], { ownerMode });
  const certificate = parseCertificateEvidence(certificateOutput, selected.certificateSha1);
  if (teamId !== MACOS_REQUIRED_DEVELOPER_ID_TEAM) {
    throw signingError(
      `resolved Developer ID certificate Team ID ${teamId} is not the owner-approved Team ${MACOS_REQUIRED_DEVELOPER_ID_TEAM}`,
      `supply the owner-approved Developer ID Application identity for Team ${MACOS_REQUIRED_DEVELOPER_ID_TEAM}`,
    );
  }
  if (certificate.certificateSha1 !== MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1) {
    throw signingError(
      `resolved Developer ID certificate SHA-1 ${certificate.certificateSha1} is not the owner-approved certificate ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1}`,
      `supply the owner-approved Developer ID certificate with SHA-1 ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1}`,
    );
  }
  return {
    identity: selected.identity,
    certificateSha1: selected.certificateSha1,
    certificateFingerprint: certificate.certificateFingerprint,
    teamId,
  };
}

export function parseSecurityIdentityOutput(output) {
  return [...String(output ?? "").matchAll(/^\s*\d+\)\s+([a-f0-9]{40})\s+"([^"]+)"\s*$/gimu)].map((match) => ({
    certificateSha1: match[1].toLowerCase(),
    identity: match[2],
  }));
}

export function parseCertificateEvidence(output, certificateSha1) {
  const normalizedSha1 = String(certificateSha1 ?? "").toLowerCase();
  const certificates = [...String(output ?? "").matchAll(/SHA-256 hash:\s*([a-f0-9]{64})[\s\S]*?SHA-1 hash:\s*([a-f0-9]{40})/gimu)]
    .map((match) => ({ certificateFingerprint: match[1].toLowerCase(), certificateSha1: match[2].toLowerCase() }));
  const matches = certificates.filter((certificate) => certificate.certificateSha1 === normalizedSha1);
  if (matches.length === 0) {
    throw signingError(
      `certificate evidence for SHA-1 ${normalizedSha1 || "missing"} is absent`,
      "inspect the exact resolved certificate with security find-certificate -a -Z",
    );
  }
  if (matches.length !== 1) {
    throw signingError(
      `certificate evidence for SHA-1 ${normalizedSha1} is ambiguous`,
      "remove duplicate certificate evidence and resolve one exact Developer ID certificate",
    );
  }
  return matches[0];
}

export async function canonicalizeEntitlements(value, label = "entitlements", { ownerMode = false } = {}) {
  const bytes = typeof value === "string" ? await readFile(value) : Buffer.from(value ?? "");
  if (bytes.byteLength === 0) {
    throw signingError(`${label} is empty`, "supply a non-empty owner-provided entitlement plist");
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "meetless-entitlements-"));
  const temporaryPath = path.join(temporaryRoot, "entitlements.plist");
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600 });
    const result = await execFileAsync(ownerMode ? MACOS_OWNER_TOOL_PATHS.plutil : "plutil", ["-convert", "json", "-o", "-", "--", temporaryPath], {
      encoding: "utf8",
      ...(ownerMode ? { env: ownerToolEnvironment() } : {}),
    }).catch((error) => {
      throw signingError(`${label} is not a valid plist: ${describe(error)}`, "supply the owner-provided entitlement plist in a valid macOS plist format");
    });
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw signingError(`${label} did not convert to valid plist JSON: ${describe(error)}`, "supply a valid owner-provided entitlement plist");
    }
    const canonical = JSON.stringify(sortCanonicalValue(parsed));
    return { canonical, sha256: sha256(Buffer.from(canonical)), value: parsed };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function loadEntitlementPolicy({ entitlementMapPath = MACOS_ENTITLEMENT_MAP_PATH, repositoryRoot = process.cwd(), ownerMode = false } = {}) {
  if (!entitlementMapPath) {
    throw signingError("release entitlement map is missing", "supply the owner-approved per-executable entitlement map");
  }
  assertNoTraversal(entitlementMapPath, "release entitlement map");
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const requestedMapPath = path.isAbsolute(entitlementMapPath)
    ? path.resolve(entitlementMapPath)
    : path.resolve(resolvedRepositoryRoot, entitlementMapPath);
  const mapPathEvidence = await assertContainedAuthorityPath(requestedMapPath, resolvedRepositoryRoot, "release entitlement map");
  const resolvedMapPath = mapPathEvidence.absolutePath;
  if (!mapPathEvidence.stat.isFile() || mapPathEvidence.stat.isSymbolicLink()) {
    throw signingError(
      `release entitlement map is not a regular non-symlink file: ${resolvedMapPath}`,
      "supply the checked-in owner-approved per-executable entitlement map",
    );
  }
  const mapBytes = await readFile(resolvedMapPath);
  if (mapBytes.byteLength === 0) {
    throw signingError(`release entitlement map is empty: ${resolvedMapPath}`, "supply the non-empty owner-approved per-executable entitlement map");
  }
  let document;
  try {
    document = JSON.parse(mapBytes.toString("utf8"));
  } catch (error) {
    throw signingError(`release entitlement map is not valid JSON: ${describe(error)}`, "supply the deterministic owner-approved entitlement map as JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document) || document.schema !== MACOS_ENTITLEMENT_POLICY_SCHEMA || !Array.isArray(document.entries)) {
    throw signingError(
      `release entitlement map schema or entries are invalid; observed schema ${String(document?.schema)}`,
      `use ${MACOS_ENTITLEMENT_POLICY_SCHEMA} with the exact owner-approved five-path map`,
    );
  }
  const expectedEntries = MACOS_APPROVED_ENTITLEMENT_MAP.map(({ path: relativePath, class: policyClass, plist }) => ({ path: relativePath, class: policyClass, plist }));
  const observedEntries = document.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return { path: entry.path, class: entry.class, plist: entry.plist };
  });
  if (JSON.stringify(observedEntries) !== JSON.stringify(expectedEntries)) {
    throw signingError(
      `release entitlement map entries differ from owner authority; observed ${JSON.stringify(observedEntries)}`,
      "restore the exact five-path owner-approved map and do not add a union or inventory-derived entry",
    );
  }
  for (const entry of document.entries) {
    if (Object.keys(entry).sort((left, right) => left.localeCompare(right)).join(",") !== "class,path,plist") {
      throw signingError(
        `release entitlement map entry ${String(entry.path)} contains extra fields`,
        "keep each mapping entry limited to path, class, and owner plist",
      );
    }
    assertRelativePolicyPath(entry.path, "entitlement map executable path");
    if (!path.isAbsolute(entry.plist) && (entry.plist === path.posix.normalize(entry.plist)) && !entry.plist.startsWith("../") && entry.plist !== "..") {
      // The exact map comparison above binds the relative plist names. This branch
      // keeps the path check explicit for diagnostics before reading the owner file.
    } else {
      throw signingError(
        `entitlement map plist for ${entry.path} is not a safe relative path: ${entry.plist}`,
        "use only the checked-in entitlements/jit.plist or entitlements/audio-input.plist source",
      );
    }
  }

  const mapCanonical = JSON.stringify(sortCanonicalValue(document));
  const sourceByPath = new Map();
  const resolvedEntries = [];
  for (const approved of MACOS_APPROVED_ENTITLEMENT_MAP) {
    const entry = document.entries.find((candidate) => candidate.path === approved.path);
    const resolvedPlistPath = path.resolve(path.dirname(resolvedMapPath), entry.plist);
    if (!isInsidePath(path.dirname(resolvedMapPath), resolvedPlistPath)) {
      throw signingError(
        `entitlement map plist for ${entry.path} escapes the map owner directory: ${entry.plist}`,
        "keep owner plist inputs below the checked-in entitlement map directory",
      );
    }
    const plistPathEvidence = await assertContainedAuthorityPath(resolvedPlistPath, path.dirname(resolvedMapPath), `owner entitlement plist for ${entry.path}`);
    const plistStat = plistPathEvidence.stat;
    if (!plistStat.isFile() || plistStat.isSymbolicLink()) {
      throw signingError(
        `owner entitlement plist for ${entry.path} is not a regular non-symlink file: ${resolvedPlistPath}`,
        "restore the exact checked-in owner-approved plist input",
      );
    }
    const plistBytes = await readFile(resolvedPlistPath);
    const canonical = await canonicalizeEntitlements(plistBytes, `${entry.class} owner entitlement plist`, { ownerMode });
    validateApprovedEntitlementValue(canonical.value, { ...entry, key: approved.key }, `${entry.class} owner entitlement plist`);
    const sourcePath = repositoryRelativePath(resolvedRepositoryRoot, resolvedPlistPath);
    const source = sourceByPath.get(sourcePath) ?? {
      path: sourcePath,
      fileSha256: sha256(plistBytes),
      canonicalSha256: canonical.sha256,
      absolutePath: resolvedPlistPath,
    };
    if (source.canonicalSha256 !== canonical.sha256 || source.fileSha256 !== sha256(plistBytes)) {
      throw signingError(
        `owner entitlement plist evidence for ${entry.path} is inconsistent`,
        "use one stable checked-in plist for each approved entitlement class",
      );
    }
    sourceByPath.set(sourcePath, source);
    resolvedEntries.push({
      path: entry.path,
      class: entry.class,
      plist: entry.plist,
      sourcePath,
      absolutePath: resolvedPlistPath,
      key: approved.key,
      ownerFileSha256: sha256(plistBytes),
      ownerCanonicalSha256: canonical.sha256,
      ownerKeys: Object.keys(canonical.value).sort((left, right) => left.localeCompare(right)),
    });
  }
  const sourcePlists = [...sourceByPath.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path: sourcePath, fileSha256, canonicalSha256 }) => ({ path: sourcePath, fileSha256, canonicalSha256 }));
  return {
    schema: MACOS_ENTITLEMENT_POLICY_SCHEMA,
    mapPath: repositoryRelativePath(resolvedRepositoryRoot, resolvedMapPath),
    mapAbsolutePath: resolvedMapPath,
    mapSha256: sha256(mapBytes),
    mapCanonicalSha256: sha256(Buffer.from(mapCanonical)),
    sourcePlists,
    entries: resolvedEntries,
  };
}

function validateApprovedEntitlementValue(value, entry, label) {
  const observedKeys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort((left, right) => left.localeCompare(right))
    : [];
  if (observedKeys.length !== 1 || observedKeys[0] !== entry.key || value?.[entry.key] !== true) {
    throw signingError(
      `${label} for ${entry.path} has observed keys ${JSON.stringify(observedKeys)}; expected policy class ${entry.class} with ${entry.key}=true under owner authority`,
      "restore the exact owner-approved plist and remove every extra, false, or risky entitlement key",
    );
  }
}

export function validateApprovedEntitlementMachOEntries({ entries = [], machoEntries = [], policy = null } = {}) {
  if (!policy) return;
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const machoByPath = new Map(machoEntries.map((entry) => [entry.path, entry]));
  for (const mapping of policy.entries) {
    const packageEntry = entryByPath.get(mapping.path);
    if (!packageEntry || packageEntry.type !== "file") {
      throw signingError(
        `approved entitlement path ${mapping.path} is not a regular file (observed ${packageEntry?.type ?? "missing"})`,
        `restore the regular ${MACOS_REQUIRED_MACHO_ARCHITECTURE} Mach-O executable for policy class ${mapping.class} before signing; do not sign a symlink, directory, or missing path`,
      );
    }
    const machoEntry = machoByPath.get(mapping.path);
    if (!machoEntry) {
      throw signingError(
        `approved entitlement path ${mapping.path} is not a regular Mach-O file`,
        `restore the ${MACOS_REQUIRED_MACHO_ARCHITECTURE} ${MACOS_REQUIRED_MACHO_FILE_TYPE} executable for policy class ${mapping.class} before signing`,
      );
    }
    let machOSlices;
    try {
      machOSlices = normalizeMachOSlices(machoEntry.machOSlices, mapping.path);
    } catch (error) {
      throw signingError(
        error instanceof Error ? error.message : String(error),
        `inspect every architecture slice for ${mapping.path} and keep one regular arm64 ${MACOS_REQUIRED_MACHO_FILE_TYPE} executable before applying ${mapping.class} entitlements`,
      );
    }
    const observedSlices = machOSlices.map((slice) => `${slice.architecture}/${slice.cpuSubtype} ${slice.fileType}`);
    if (machOSlices.length !== 1 || machOSlices[0].architecture !== MACOS_REQUIRED_MACHO_ARCHITECTURE || machOSlices[0].cpuSubtype !== "all" || machOSlices[0].fileType !== MACOS_REQUIRED_MACHO_FILE_TYPE) {
      throw signingError(
        `approved entitlement path ${mapping.path} has observed Mach-O slices ${JSON.stringify(observedSlices)}; expected exactly [${MACOS_REQUIRED_MACHO_ARCHITECTURE}/all ${MACOS_REQUIRED_MACHO_FILE_TYPE}] for policy class ${mapping.class}`,
        `replace the dylib, bundle, object, non-arm64 image, or other Mach-O with the exact regular arm64 executable before applying entitlements`,
      );
    }
  }
}

function assertRelativePolicyPath(candidate, label) {
  if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    throw signingError(`${label} is absolute, empty, or escapes its declared root: ${String(candidate)}`, "use the exact repository-relative owner policy path");
  }
}

function repositoryRelativePath(repositoryRoot, candidate) {
  const relative = path.relative(repositoryRoot, candidate).replaceAll(path.sep, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw signingError(`entitlement policy path is outside repository authority: ${candidate}`, "keep the checked-in entitlement map and plists inside the repository");
  }
  return relative;
}

function isInsidePath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoTraversal(candidate, label) {
  const rawPath = String(candidate).replaceAll(path.sep, "/");
  const normalizedPath = path.posix.normalize(rawPath);
  if (rawPath.includes("..") && normalizedPath !== rawPath) {
    throw signingError(
      `${label} uses traversal path ${candidate}`,
      "use the exact repository-relative checked-in authority path",
    );
  }
}

async function assertContainedAuthorityPath(candidate, authorityRoot, label) {
  const rootPath = path.resolve(authorityRoot);
  const absolutePath = path.resolve(candidate);
  if (!isInsidePath(rootPath, absolutePath)) {
    throw signingError(
      `${label} escapes repository authority: ${candidate}`,
      "keep the entitlement map and plists inside the checked-in repository authority",
    );
  }
  const relative = path.relative(rootPath, absolutePath);
  let cursor = rootPath;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const componentStat = await lstat(cursor).catch(() => null);
    if (!componentStat) {
      throw signingError(
        `${label} path is missing: ${absolutePath}`,
        "restore the checked-in regular authority file and its parent directories",
      );
    }
    if (componentStat.isSymbolicLink()) {
      throw signingError(
        `${label} path contains symlink component ${cursor}`,
        "replace the symlink with a regular in-repository authority path",
      );
    }
  }
  const rootRealPath = await realpath(rootPath).catch(() => rootPath);
  const candidateRealPath = await realpath(absolutePath).catch(() => null);
  if (!candidateRealPath || !isInsidePath(rootRealPath, candidateRealPath)) {
    throw signingError(
      `${label} realpath escapes repository authority: ${absolutePath}`,
      "keep the map and plist realpaths inside the checked-in repository authority",
    );
  }
  return { absolutePath, stat: await lstat(absolutePath) };
}

async function runSecurityCommand(arguments_, { ownerMode = false } = {}) {
  const result = await execFileAsync(ownerMode ? MACOS_OWNER_TOOL_PATHS.security : "security", arguments_, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...(ownerMode ? { env: ownerToolEnvironment() } : {}),
  }).catch((error) => {
    throw signingError(`security certificate lookup failed: ${describe(error)}`, "install or select the owner-approved Developer ID Application certificate");
  });
  return `${result.stdout}\n${result.stderr ?? ""}`;
}

function parseDeveloperIdTeamId(identity) {
  return identity.match(DEVELOPER_ID_APPLICATION_PATTERN)?.[1] ?? null;
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => [key, sortCanonicalValue(value[key])]));
}

export function buildSigningOrder(machoEntries, outerPath = MACOS_SIGNING_OUTER_PATH) {
  const paths = machoEntries.map((entry) => typeof entry === "string" ? entry : entry?.path);
  if (paths.some((entry) => typeof entry !== "string" || !entry || path.isAbsolute(entry))) {
    throw signingError("final Mach-O signing order contains an invalid path", "inventory regular in-package Mach-O paths before signing");
  }
  if (new Set(paths).size !== paths.length) {
    throw signingError("final Mach-O signing order contains a duplicate path", "inventory each final Mach-O exactly once");
  }
  if (paths.includes(outerPath)) {
    throw signingError(`nested Mach-O signing order contains outer path ${outerPath}`, "sign the outer Meetless.app only after nested Mach-O files");
  }
  const nestedMachO = [...paths].sort((left, right) => {
    const depthDifference = right.split("/").length - left.split("/").length;
    return depthDifference || left.localeCompare(right);
  });
  return {
    nestedMachO,
    outer: outerPath,
    all: [...nestedMachO, outerPath],
  };
}

export function codesignArguments({ mode, identity, target, identifier, entitlementsPath = null, outer = false }) {
  const normalized = normalizeSigningOptions({
    mode,
    signingIdentity: identity,
    entitlementMapPath: mode === RELEASE_SIGNING_MODE ? MACOS_ENTITLEMENT_MAP_PATH : null,
    requireEntitlementMap: false,
  });
  if (typeof target !== "string" || !target || typeof identifier !== "string" || !identifier) {
    throw signingError("codesign target or identifier is missing", "sign every final Mach-O and the outer app with explicit paths");
  }
  if (outer && entitlementsPath !== null) {
    throw signingError(
      `outer app ${MACOS_SIGNING_OUTER_PATH} received an entitlement plist`,
      "omit --entitlements for the outer app; apply only the exact per-executable map entries",
    );
  }
  const arguments_ = ["--force", "--sign", normalized.identity, "--identifier", identifier];
  if (normalized.mode === RELEASE_SIGNING_MODE) {
    arguments_.push("--options", "runtime");
    if (entitlementsPath !== null) arguments_.push("--entitlements", entitlementsPath);
  }
  arguments_.push(
    normalized.mode === RELEASE_SIGNING_MODE ? MACOS_RELEASE_TIMESTAMP_ARGUMENT : MACOS_LOCAL_TIMESTAMP_ARGUMENT,
    target,
  );
  return arguments_;
}

export function parseCodesignDisplay(output, relativePath) {
  const text = String(output ?? "");
  const identifier = matchLine(text, "Identifier") ?? null;
  const teamValue = matchLine(text, "TeamIdentifier");
  const teamId = teamValue && teamValue !== "not set" ? teamValue : null;
  const timestampValue = matchLine(text, "Timestamp");
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const flagMatch = text.match(/\bflags=0x[0-9a-f]+(?:\(([^)]*)\))?/iu);
  const flags = flagMatch?.[1] ? flagMatch[1].split(",").map((flag) => flag.trim()).filter(Boolean).sort() : [];
  const signatureValue = matchLine(text, "Signature");
  const signature = signatureValue ?? (teamId ? "cms" : "adhoc");
  const timestamp = timestampValue && !/^(?:none|not set|absent)$/iu.test(timestampValue)
    ? timestampValue
    : timestampValue === null && signature === "adhoc"
      ? "none"
      : timestampValue === null
        ? null
        : "none";
  const secureTimestamp = timestamp !== null && timestamp !== "none";
  const identity = signature === "adhoc" ? "-" : authorities[0] ?? null;
  const cdHash = matchLine(text, "CDHash") ?? null;
  if (!identifier || !CD_HASH_PATTERN.test(cdHash ?? "")) {
    throw signingError(`codesign evidence for ${relativePath} is missing an identifier or CDHash`, "re-sign and inspect every final Mach-O and the outer app");
  }
  return {
    path: relativePath,
    identifier,
    identity,
    teamId,
    signature,
    authorities,
    flags,
    hardenedRuntime: flags.includes("runtime"),
    entitlementsSha256: null,
    entitlementsCanonicalSha256: null,
    entitlementKeys: [],
    certificateFingerprint: null,
    certificateSha1: null,
    cdHash,
    timestamp,
    secureTimestamp,
  };
}

export async function collectMacOSSignatureEvidence({
  bundlePath,
  machoPaths,
  machoEntries = null,
  outerPath = MACOS_SIGNING_OUTER_PATH,
  verify = false,
  requireCertificateEvidence = false,
  extractCertificateEvidence = extractSignatureCertificateEvidence,
  runCodesign = execFileAsync,
  ownerMode = false,
} = {}) {
  const order = buildSigningOrder(machoPaths, outerPath);
  const machoEvidenceByPath = new Map((machoEntries ?? []).map((entry) => [entry.path, entry]));
  const nestedMachO = [];
  for (const relativePath of order.nestedMachO) {
    nestedMachO.push(await readSignatureEvidence(bundlePath, relativePath, false, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign, machoEvidenceByPath.get(relativePath) ?? null, ownerMode));
  }
  const outer = await readSignatureEvidence(bundlePath, order.outer, true, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign, null, ownerMode);
  return { order, outer, nestedMachO };
}

export async function extractSignatureCertificateEvidence(binaryPath, relativePath = binaryPath, { ownerMode = false } = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "meetless-signature-certs-"));
  const prefix = path.join(temporaryRoot, "certificate-");
  try {
    await execFileAsync(ownerMode ? MACOS_OWNER_TOOL_PATHS.codesign : "codesign", ["-d", `--extract-certificates=${prefix}`, binaryPath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...(ownerMode ? { env: ownerToolEnvironment() } : {}),
    }).catch((error) => {
      throw signingError(`cannot extract the leaf certificate for ${relativePath}: ${describe(error)}`, "inspect the exact final signature and extract its certificate chain");
    });
    const leafPath = `${prefix}0`;
    const leafBytes = await readFile(leafPath).catch((error) => {
      throw signingError(`the exact signature for ${relativePath} has no leaf certificate: ${describe(error)}`, "sign the final code object with a certificate-backed Developer ID identity");
    });
    return parseExtractedCertificateEvidence(leafBytes, relativePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseExtractedCertificateEvidence(bytes, relativePath = "signature") {
  const certificateBytes = Buffer.from(bytes ?? "");
  if (certificateBytes.byteLength === 0) {
    throw signingError(`leaf certificate evidence for ${relativePath} is empty`, "extract the leaf certificate from the exact final signature");
  }
  try {
    new X509Certificate(certificateBytes);
  } catch (error) {
    throw signingError(`leaf certificate evidence for ${relativePath} is not a valid DER certificate: ${describe(error)}`, "extract the leaf certificate from the exact final signature");
  }
  return {
    certificateSha1: sha1(certificateBytes),
    certificateFingerprint: sha256(certificateBytes),
  };
}

export function createSigningMetadata({
  mode,
  identity,
  requestedIdentity = identity,
  resolvedIdentity = identity,
  expectedTeamId = null,
  resolvedTeamId = expectedTeamId,
  certificateFingerprint = null,
  certificateSha1 = null,
  entitlementPolicy = null,
  order,
  outer,
  nestedMachO,
}) {
  const normalized = normalizeSigningOptions({
    mode,
    signingIdentity: requestedIdentity,
    entitlementMapPath: mode === RELEASE_SIGNING_MODE ? MACOS_ENTITLEMENT_MAP_PATH : null,
    expectedTeamId,
    requireEntitlementMap: false,
  });
  if (mode === RELEASE_SIGNING_MODE && !entitlementPolicy) {
    throw signingError("release signing metadata has no entitlement map evidence", "load the exact owner-approved per-executable entitlement map before signing");
  }
  const state = normalizeSignatureState({ order, outer, nestedMachO });
  const actualTeamId = state.outer.teamId;
  const declaredTeamId = mode === RELEASE_SIGNING_MODE ? (resolvedTeamId ?? expectedTeamId ?? parseDeveloperIdTeamId(resolvedIdentity)) : null;
  if (mode === RELEASE_SIGNING_MODE && declaredTeamId && actualTeamId !== declaredTeamId) {
    throw signingError(`signed outer app Team ID ${actualTeamId ?? "missing"} differs from resolved certificate Team ID ${declaredTeamId}`, "sign every final code object with the exact resolved Developer ID identity");
  }
  const signing = {
    schema: MACOS_SIGNING_SCHEMA,
    mode,
    localOnly: mode === LOCAL_AD_HOC_SIGNING_MODE,
    identity: {
      requested: normalized.identity,
      resolved: mode === RELEASE_SIGNING_MODE ? resolvedIdentity : "-",
      primaryAuthority: state.outer.identity,
      teamId: mode === RELEASE_SIGNING_MODE ? actualTeamId : null,
      observedLeafSigner: mode === RELEASE_SIGNING_MODE ? state.outer.identity : "-",
      certificateFingerprint: mode === RELEASE_SIGNING_MODE ? certificateFingerprint : null,
      certificateSha1: mode === RELEASE_SIGNING_MODE ? certificateSha1 : null,
    },
    hardenedRuntime: {
      required: mode === RELEASE_SIGNING_MODE,
      flag: mode === RELEASE_SIGNING_MODE ? "runtime" : null,
      verified: state.outer.hardenedRuntime && state.nestedMachO.every((entry) => entry.hardenedRuntime),
    },
    entitlements: buildEntitlementMetadata(mode, entitlementPolicy, state),
    order: {
      nestedMachO: state.order.nestedMachO,
      outer: state.order.outer,
      all: state.order.all,
    },
    signatureState: {
      outer: state.outer,
      nestedMachO: state.nestedMachO,
    },
    manifestBinding: {
      phase: "post-signature",
      signatureStateDigest: digestSignatureState(state),
    },
    distribution: {
      status: mode === LOCAL_AD_HOC_SIGNING_MODE ? "local-only" : "developer-id-preparation",
      releaseAcceptance: "not-claimed",
      notarization: "not-run",
    },
  };
  signing.signatureStateDigest = signing.manifestBinding.signatureStateDigest;
  validateSigningMetadata(signing, {
    machoPaths: state.order.nestedMachO,
    actual: state,
    expectedMode: mode,
    expectedIdentity: normalized.identity,
    expectedResolvedIdentity: mode === RELEASE_SIGNING_MODE ? resolvedIdentity : "-",
    expectedCertificateFingerprint: mode === RELEASE_SIGNING_MODE ? certificateFingerprint : null,
    expectedCertificateSha1: mode === RELEASE_SIGNING_MODE ? certificateSha1 : null,
    entitlementPolicy,
    expectedTeamId: declaredTeamId,
  });
  return signing;
}

export function validateSigningMetadata(signing, {
  machoPaths = null,
  outerPath = MACOS_SIGNING_OUTER_PATH,
  actual = null,
  expectedMode = null,
  expectedIdentity = null,
  expectedResolvedIdentity = null,
  expectedCertificateFingerprint = null,
  expectedCertificateSha1 = null,
  entitlementPolicy = null,
  expectedTeamId = null,
} = {}) {
  validateSigningDocument(signing, machoPaths);
  if (expectedMode !== null && signing.mode !== expectedMode) {
    throw signingError(`manifest signing mode ${signing.mode} differs from requested ${expectedMode}`, "validate the package with the same explicit signing mode used to assemble it");
  }
  if (expectedIdentity !== null && signing.identity.requested !== expectedIdentity) {
    throw signingError(`manifest signing identity ${signing.identity.requested} differs from requested ${expectedIdentity}`, "validate with the exact supplied signing identity");
  }
  if (expectedResolvedIdentity !== null && signing.identity.resolved !== expectedResolvedIdentity) {
    throw signingError(`manifest resolved signing identity ${signing.identity.resolved} differs from resolved ${expectedResolvedIdentity}`, "validate with the exact certificate identity selected before signing");
  }
  if (expectedCertificateFingerprint !== null && signing.identity.certificateFingerprint !== expectedCertificateFingerprint) {
    throw signingError("manifest certificate fingerprint is stale or mismatched", "validate with the exact resolved Developer ID certificate");
  }
  if (expectedCertificateSha1 !== null && signing.identity.certificateSha1 !== expectedCertificateSha1) {
    throw signingError("manifest certificate SHA-1 identity is stale or mismatched", "validate with the exact resolved Developer ID certificate identity");
  }
  if (expectedTeamId !== null && signing.identity.teamId !== expectedTeamId) {
    throw signingError(`manifest Team ID ${signing.identity.teamId ?? "missing"} differs from requested ${expectedTeamId}`, "validate with the Team ID belonging to the supplied signing identity");
  }
  if (signing.mode === RELEASE_SIGNING_MODE && !entitlementPolicy) {
    throw signingError("release signing metadata validation has no entitlement map evidence", "load the exact owner-approved per-executable entitlement map before validating");
  }
  if (machoPaths !== null) {
    const order = buildSigningOrder(machoPaths, outerPath);
    if (JSON.stringify(signing.order) !== JSON.stringify(order)) {
      throw signingError("manifest signing order differs from the final Mach-O inventory", "rebuild the manifest after deepest-first signing and outer-app signing");
    }
  }
  if (actual !== null) {
    const normalizedActual = normalizeSignatureState(actual);
    if (JSON.stringify(signing.signatureState) !== JSON.stringify({ outer: normalizedActual.outer, nestedMachO: normalizedActual.nestedMachO })) {
      throw signingError("post-signature signing metadata differs from the final code signatures", "rebuild the manifest after the final signature mutation");
    }
    if (signing.manifestBinding.signatureStateDigest !== digestSignatureState(normalizedActual) || signing.signatureStateDigest !== digestSignatureState(normalizedActual)) {
      throw signingError("post-signature signing state digest is stale", "recompute signing metadata after signing every final code object");
    }
  }
  const validatedState = normalizeSignatureState(actual ?? signing.signatureState);
  if (signing.mode === RELEASE_SIGNING_MODE) {
    validateEntitlementPolicyBinding(signing, entitlementPolicy, validatedState);
  } else if (JSON.stringify(signing.entitlements) !== JSON.stringify(buildEntitlementMetadata(LOCAL_AD_HOC_SIGNING_MODE, null, validatedState))) {
    throw signingError("local ad-hoc entitlement metadata is stale or contains release evidence", "regenerate local-only metadata from the final entitlement-free signatures");
  }
  return signing;
}

export function validateSigningDocument(signing, machoPaths = null) {
  if (!signing || typeof signing !== "object" || Array.isArray(signing)) {
    throw signingError("manifest signing contract is missing", "assemble the package with an explicit signing mode");
  }
  if (signing.schema !== MACOS_SIGNING_SCHEMA) {
    throw signingError(`manifest signing schema is ${String(signing.schema)}`, `use ${MACOS_SIGNING_SCHEMA}`);
  }
  if (!MACOS_SIGNING_MODES.includes(signing.mode)) {
    throw signingError(`manifest signing mode is ${String(signing.mode)}`, "use local-ad-hoc or release");
  }
  if (signing.localOnly !== (signing.mode === LOCAL_AD_HOC_SIGNING_MODE)) {
    throw signingError("manifest local-only signing marker does not match its mode", "mark ad-hoc packages local-only and release packages as preparation only");
  }
  if (!signing.identity || typeof signing.identity.requested !== "string" || !signing.identity.requested || typeof signing.identity.resolved !== "string" || !signing.identity.resolved || typeof signing.identity.primaryAuthority !== "string" || !signing.identity.primaryAuthority || (signing.identity.teamId !== null && !TEAM_ID_PATTERN.test(signing.identity.teamId))) {
    throw signingError("manifest signing identity or Team ID evidence is missing", "record the supplied identity and final signature Team ID evidence");
  }
  if (!signing.hardenedRuntime || signing.hardenedRuntime.flag !== (signing.mode === RELEASE_SIGNING_MODE ? "runtime" : null) || typeof signing.hardenedRuntime.verified !== "boolean") {
    throw signingError("manifest hardened-runtime contract is missing or inconsistent", "record and verify the runtime CodeDirectory flag for every final Mach-O and the outer app");
  }
  validateEntitlementDocument(signing.entitlements, signing.mode);
  if (signing.mode === LOCAL_AD_HOC_SIGNING_MODE && (signing.identity.requested !== "-" || signing.identity.resolved !== "-" || signing.identity.teamId !== null || signing.identity.certificateFingerprint !== null || signing.identity.certificateSha1 !== null)) {
    throw signingError("local ad-hoc metadata contains release identity, Team ID, or entitlement evidence", "keep local proof explicitly ad-hoc and non-distributable");
  }
  if (!signing.order || !Array.isArray(signing.order.nestedMachO) || signing.order.outer !== MACOS_SIGNING_OUTER_PATH || !Array.isArray(signing.order.all) || JSON.stringify(signing.order.all) !== JSON.stringify([...signing.order.nestedMachO, signing.order.outer])) {
    throw signingError("manifest signing order is missing or not outer-last", "record deepest-first nested Mach-O paths followed by Meetless.app");
  }
  if (!signing.signatureState || !Array.isArray(signing.signatureState.nestedMachO)) {
    throw signingError("manifest final signature state is missing", "record every final nested Mach-O and the outer app after signing");
  }
  const state = normalizeSignatureState({ order: signing.order, outer: signing.signatureState.outer, nestedMachO: signing.signatureState.nestedMachO });
  if (JSON.stringify(state.order) !== JSON.stringify(signing.order) || JSON.stringify(state.outer) !== JSON.stringify(signing.signatureState.outer) || JSON.stringify(state.nestedMachO) !== JSON.stringify(signing.signatureState.nestedMachO)) {
    throw signingError("manifest final signature state is not normalized", "regenerate deterministic signing metadata from final signatures");
  }
  if (state.outer.path !== signing.order.outer || JSON.stringify(state.nestedMachO.map((entry) => entry.path)) !== JSON.stringify([...signing.order.nestedMachO].sort((left, right) => left.localeCompare(right)))) {
    throw signingError("manifest final signature state does not cover the declared signing order", "record every final nested Mach-O and the outer app exactly once");
  }
  if (machoPaths !== null && JSON.stringify(buildSigningOrder(machoPaths).nestedMachO) !== JSON.stringify(signing.order.nestedMachO)) {
    throw signingError("manifest signing paths do not cover the final Mach-O inventory", "inventory and sign every final nested Mach-O");
  }
  if (signing.mode === RELEASE_SIGNING_MODE) validateReleaseState(signing, state);
  else validateLocalState(signing, state);
  if (!signing.manifestBinding || signing.manifestBinding.phase !== "post-signature" || signing.manifestBinding.signatureStateDigest !== digestSignatureState(state) || signing.signatureStateDigest !== digestSignatureState(state)) {
    throw signingError("manifest signing metadata is stale or has a digest cycle", "derive the manifest from final signature state without hashing the manifest back into that state");
  }
  if (signing.distribution?.releaseAcceptance !== "not-claimed" || signing.distribution?.notarization !== "not-run") {
    throw signingError("manifest makes an unproven release or notarization claim", "leave external release and notarization claims unverified");
  }
  return signing;
}

export function digestSignatureState({ order, outer, nestedMachO }) {
  const state = normalizeSignatureState({ order, outer, nestedMachO });
  return sha256(JSON.stringify(state));
}

function validateLocalState(signing, state) {
  const signatures = [state.outer, ...state.nestedMachO];
  if (signing.hardenedRuntime.verified || signatures.some((entry) => entry.hardenedRuntime || entry.teamId !== null || entry.signature !== "adhoc" || entry.identity !== "-")) {
    throw signingError("local ad-hoc package contains release-style signature evidence", "use local ad-hoc signatures only for non-distributable proof");
  }
  const timestampedImage = signatures.find((entry) => entry.secureTimestamp === true || entry.timestamp !== "none");
  if (timestampedImage) {
    throw signingError(
      `local ad-hoc image ${timestampedImage.path} has timestamp evidence ${timestampedImage.timestamp ?? "missing"}`,
      "use --timestamp=none for every local ad-hoc signature and regenerate the package",
    );
  }
  const entitlementBearingImage = signatures.find((entry) => entry.entitlementsSha256 !== null || entry.entitlementsCanonicalSha256 !== null || entry.entitlementKeys.length !== 0);
  if (entitlementBearingImage) {
    throw signingError(
      `local ad-hoc image ${entitlementBearingImage.path} has entitlement keys ${JSON.stringify(entitlementBearingImage.entitlementKeys)} or signed entitlement digests`,
      "remove --entitlements from local-ad-hoc signing, rebuild the image, and validate empty entitlement evidence",
    );
  }
  if (signing.distribution?.status !== "local-only") {
    throw signingError("local ad-hoc package is not marked local-only", "mark the package non-distributable");
  }
}

function validateReleaseState(signing, state) {
  const signatures = [state.outer, ...state.nestedMachO];
  const resolvedTeamId = parseDeveloperIdTeamId(signing.identity.resolved);
  if (
    signing.localOnly ||
    signing.identity.requested === "-" ||
    !resolvedTeamId ||
    signing.identity.resolved !== signing.identity.observedLeafSigner ||
    !SHA256_PATTERN.test(signing.identity.certificateFingerprint ?? "") ||
    !SHA1_PATTERN.test(signing.identity.certificateSha1 ?? "") ||
    signatures.some((entry) => entry.signature === "adhoc" || entry.teamId === null || entry.identity === "-" || !parseDeveloperIdTeamId(entry.identity) || entry.certificateFingerprint !== signing.identity.certificateFingerprint || entry.certificateSha1 !== signing.identity.certificateSha1)
    || signing.identity.teamId !== MACOS_REQUIRED_DEVELOPER_ID_TEAM
    || signing.identity.certificateSha1 !== MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1
    || signatures.some((entry) => entry.teamId !== MACOS_REQUIRED_DEVELOPER_ID_TEAM || entry.certificateSha1 !== MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1 || entry.secureTimestamp !== true || typeof entry.timestamp !== "string" || entry.timestamp === "none")
  ) {
    throw signingError("release package uses an unapproved signer, lacks Developer ID certificate evidence, or lacks a secure timestamp", `use the owner-approved Developer ID certificate SHA-1 ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1}, Team ${MACOS_REQUIRED_DEVELOPER_ID_TEAM}, and --timestamp for every final code object`);
  }
  if (!signing.hardenedRuntime.required || !signing.hardenedRuntime.verified || signatures.some((entry) => !entry.hardenedRuntime || !entry.flags.includes("runtime"))) {
    throw signingError("release package is missing the hardened-runtime flag on a final code object", "sign every final Mach-O and the outer app with --options runtime");
  }
  const teamId = signing.identity.teamId;
  if (!teamId || teamId !== resolvedTeamId || signatures.some((entry) => entry.teamId !== teamId)) {
    throw signingError("release package Team ID evidence is mismatched", "use one Developer ID Team ID for every final code object");
  }
  if (!signing.identity.primaryAuthority || signing.identity.primaryAuthority !== signing.identity.observedLeafSigner || signatures.some((entry) => entry.identity !== signing.identity.observedLeafSigner)) {
    throw signingError("release package signing identity evidence is mismatched", "use one supplied Developer ID identity for every final code object");
  }
  if (signing.distribution?.status !== "developer-id-preparation") {
    throw signingError("release package preparation status is missing", "mark the artifact as Developer ID preparation without claiming release acceptance");
  }
}

function buildEntitlementMetadata(mode, policy, state) {
  const observed = [state.outer, ...state.nestedMachO]
    .map((entry) => {
      const mapping = policy?.entries.find((candidate) => candidate.path === entry.path) ?? null;
      return {
        path: entry.path,
        expectedClass: mapping?.class ?? "none",
        signedSha256: entry.entitlementsSha256,
        signedCanonicalSha256: entry.entitlementsCanonicalSha256,
        observedKeys: [...entry.entitlementKeys],
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (mode === LOCAL_AD_HOC_SIGNING_MODE) {
    return {
      required: false,
      scope: "none",
      mapPath: null,
      mapSha256: null,
      mapCanonicalSha256: null,
      sourcePlists: [],
      bindings: [],
      observed,
    };
  }
  return {
    required: true,
    scope: "per-executable",
    mapPath: policy.mapPath,
    mapSha256: policy.mapSha256,
    mapCanonicalSha256: policy.mapCanonicalSha256,
    sourcePlists: policy.sourcePlists.map((source) => ({ ...source })),
    bindings: policy.entries.map((mapping) => {
      const image = [state.outer, ...state.nestedMachO].find((entry) => entry.path === mapping.path) ?? null;
      return {
        path: mapping.path,
        class: mapping.class,
        sourcePath: mapping.sourcePath,
        fileSha256: mapping.ownerFileSha256,
        ownerCanonicalSha256: mapping.ownerCanonicalSha256,
        expectedKeys: [...mapping.ownerKeys],
        signedSha256: image?.entitlementsSha256 ?? null,
        signedCanonicalSha256: image?.entitlementsCanonicalSha256 ?? null,
        observedKeys: image ? [...image.entitlementKeys] : [],
      };
    }),
    observed,
  };
}

function validateEntitlementDocument(entitlements, mode) {
  const expectedRelease = mode === RELEASE_SIGNING_MODE;
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements) || entitlements.required !== expectedRelease || entitlements.scope !== (expectedRelease ? "per-executable" : "none") || !Array.isArray(entitlements.sourcePlists) || !Array.isArray(entitlements.bindings) || !Array.isArray(entitlements.observed)) {
    throw signingError("manifest entitlement contract is missing or has the wrong per-executable scope", "bind the owner-approved map and every observed image entitlement state");
  }
  if (expectedRelease) {
    if (typeof entitlements.mapPath !== "string" || !entitlements.mapPath || !SHA256_PATTERN.test(entitlements.mapSha256 ?? "") || !SHA256_PATTERN.test(entitlements.mapCanonicalSha256 ?? "")) {
      throw signingError("release entitlement map path or digest evidence is missing", "record the checked-in map bytes and canonical map digest");
    }
    if (entitlements.sourcePlists.length !== 2 || entitlements.bindings.length !== MACOS_APPROVED_ENTITLEMENT_MAP.length) {
      throw signingError("release entitlement source or mapping evidence is incomplete", "record both owner plist digests and all five approved executable bindings");
    }
    for (const source of entitlements.sourcePlists) {
      if (!source || typeof source.path !== "string" || !source.path || !SHA256_PATTERN.test(source.fileSha256 ?? "") || !SHA256_PATTERN.test(source.canonicalSha256 ?? "")) {
        throw signingError("release owner entitlement source evidence is malformed", "record each owner plist path, raw digest, and canonical digest");
      }
    }
    for (const binding of entitlements.bindings) {
      if (!binding || typeof binding.path !== "string" || !binding.path || typeof binding.class !== "string" || !binding.class || typeof binding.sourcePath !== "string" || !binding.sourcePath || !SHA256_PATTERN.test(binding.fileSha256 ?? "") || !SHA256_PATTERN.test(binding.ownerCanonicalSha256 ?? "") || !Array.isArray(binding.expectedKeys) || !Array.isArray(binding.observedKeys) || (binding.signedSha256 !== null && !SHA256_PATTERN.test(binding.signedSha256)) || (binding.signedCanonicalSha256 !== null && !SHA256_PATTERN.test(binding.signedCanonicalSha256))) {
        throw signingError("release entitlement binding evidence is malformed", "record path, policy class, owner digests, and observed signed digests for every approved executable");
      }
    }
  } else if (entitlements.mapPath !== null || entitlements.mapSha256 !== null || entitlements.mapCanonicalSha256 !== null || entitlements.sourcePlists.length !== 0 || entitlements.bindings.length !== 0) {
    throw signingError("local ad-hoc metadata contains release entitlement policy evidence", "keep local ad-hoc packages entitlement-free and local-only");
  }
  for (const observed of entitlements.observed) {
    if (!observed || typeof observed.path !== "string" || !observed.path || typeof observed.expectedClass !== "string" || !Array.isArray(observed.observedKeys) || (observed.signedSha256 !== null && !SHA256_PATTERN.test(observed.signedSha256)) || (observed.signedCanonicalSha256 !== null && !SHA256_PATTERN.test(observed.signedCanonicalSha256))) {
      throw signingError("per-image entitlement evidence is malformed", "record observed entitlement keys and raw/canonical digests for each final code object");
    }
  }
}

function validateEntitlementPolicyBinding(signing, policy, state) {
  const stateByPath = new Map([state.outer, ...state.nestedMachO].map((entry) => [entry.path, entry]));
  for (const mapping of policy.entries) {
    const image = stateByPath.get(mapping.path);
    const observedSlices = image?.machOSlices ?? [];
    if (!image || observedSlices.length !== 1 || observedSlices[0].fileType !== MACOS_REQUIRED_MACHO_FILE_TYPE || observedSlices[0].architecture !== MACOS_REQUIRED_MACHO_ARCHITECTURE || observedSlices[0].cpuSubtype !== "all") {
      throw signingError(
        `approved entitlement path ${mapping.path} has observed Mach-O slices ${JSON.stringify(observedSlices.map((slice) => `${slice.architecture}/${slice.cpuSubtype} ${slice.fileType}`))}; expected exactly [${MACOS_REQUIRED_MACHO_ARCHITECTURE}/all ${MACOS_REQUIRED_MACHO_FILE_TYPE}] for policy class ${mapping.class}`,
        "sign only the exact regular arm64 executable at the approved path; replace any universal, non-arm64, dylib, bundle, object, symlink, or other Mach-O type",
      );
    }
  }
  const expected = buildEntitlementMetadata(RELEASE_SIGNING_MODE, policy, state);
  if (JSON.stringify(signing.entitlements) !== JSON.stringify(expected)) {
    throw signingError(
      "release entitlement map, owner digest, or observed per-image entitlement metadata is stale or mismatched",
      "rebuild every approved executable with its exact policy plist, omit --entitlements for all other code objects, and regenerate post-signature metadata",
    );
  }
  for (const mapping of policy.entries) {
    const image = stateByPath.get(mapping.path);
    if (!image) {
      throw signingError(
        `approved entitlement path ${mapping.path} is absent from the final Mach-O inventory`,
        `restore the exact ${mapping.class} executable or remove the package candidate for owner review; do not spread entitlements to a new path`,
      );
    }
    if (image.entitlementsCanonicalSha256 !== mapping.ownerCanonicalSha256 || JSON.stringify(image.entitlementKeys) !== JSON.stringify(mapping.ownerKeys)) {
      throw signingError(
        `entitlement path ${mapping.path} observed keys ${JSON.stringify(image.entitlementKeys)} do not match expected policy class ${mapping.class}`,
        "sign the approved executable with its exact owner plist and read back the signed entitlements before writing the manifest",
      );
    }
  }
  for (const image of [state.outer, ...state.nestedMachO]) {
    if (!policy.entries.some((mapping) => mapping.path === image.path) && (image.entitlementsSha256 !== null || image.entitlementsCanonicalSha256 !== null || image.entitlementKeys.length !== 0)) {
      throw signingError(
        `unmapped entitlement-bearing image ${image.path} has observed keys ${JSON.stringify(image.entitlementKeys)}`,
        "omit --entitlements for every unapproved code object, including the outer app, helpers, frameworks, dylibs, and tools",
      );
    }
  }
}

function normalizeSignatureState({ order, outer, nestedMachO }) {
  const normalizedOrder = order ?? buildSigningOrder((nestedMachO ?? []).map((entry) => entry.path));
  const normalizedOuter = normalizeSignatureEvidence(outer, normalizedOrder.outer);
  const normalizedNested = (nestedMachO ?? []).map((entry) => normalizeSignatureEvidence(entry, entry?.path)).sort((left, right) => left.path.localeCompare(right.path));
  return {
    order: {
      nestedMachO: [...normalizedOrder.nestedMachO],
      outer: normalizedOrder.outer,
      all: [...normalizedOrder.all],
    },
    outer: normalizedOuter,
    nestedMachO: normalizedNested,
  };
}

function normalizeSignatureEvidence(evidence, fallbackPath = null) {
  if (!evidence || typeof evidence !== "object") {
    throw signingError(`signature evidence for ${fallbackPath ?? "unknown path"} is missing`, "inspect every final code signature after signing");
  }
  const pathValue = evidence.path ?? fallbackPath;
  const flags = Array.isArray(evidence.flags) ? [...new Set(evidence.flags)].sort() : [];
  let machOSlices;
  try {
    machOSlices = normalizeMachOSlices(evidence.machOSlices ?? [], pathValue ?? "Mach-O");
  } catch (error) {
    throw signingError(
      error instanceof Error ? error.message : String(error),
      "record the complete normalized architecture slice set from the exact final Mach-O before writing signature metadata",
    );
  }
  const normalized = {
    path: pathValue,
    identifier: evidence.identifier ?? null,
    identity: evidence.identity ?? (evidence.signature === "adhoc" ? "-" : null),
    teamId: evidence.teamId ?? null,
    signature: evidence.signature ?? null,
    authorities: Array.isArray(evidence.authorities) ? [...evidence.authorities] : [],
    flags,
    hardenedRuntime: evidence.hardenedRuntime ?? flags.includes("runtime"),
    machOSlices,
    machOFileType: machOSlices.length === 1 ? machOSlices[0].fileType : null,
    machOArchitecture: machOSlices.length === 1 ? machOSlices[0].architecture : null,
    entitlementsSha256: evidence.entitlementsSha256 ?? null,
    entitlementsCanonicalSha256: evidence.entitlementsCanonicalSha256 ?? null,
    entitlementKeys: Array.isArray(evidence.entitlementKeys) ? [...new Set(evidence.entitlementKeys)].sort((left, right) => left.localeCompare(right)) : [],
    certificateFingerprint: evidence.certificateFingerprint ?? null,
    certificateSha1: evidence.certificateSha1 ?? null,
    cdHash: evidence.cdHash ?? null,
    timestamp: evidence.timestamp ?? null,
    secureTimestamp: evidence.secureTimestamp ?? (typeof evidence.timestamp === "string" && evidence.timestamp !== "none"),
  };
  if (typeof normalized.path !== "string" || !normalized.path || path.isAbsolute(normalized.path) || typeof normalized.identifier !== "string" || !normalized.identifier || typeof normalized.identity !== "string" || !normalized.identity || (normalized.teamId !== null && !TEAM_ID_PATTERN.test(normalized.teamId)) || typeof normalized.signature !== "string" || !normalized.signature || typeof normalized.hardenedRuntime !== "boolean" || !normalized.machOSlices.every((slice) => /^[a-z0-9_]+$/u.test(slice.architecture) && /^[a-z0-9_]+$/u.test(slice.cpuType) && /^[a-z0-9_]+$/u.test(slice.cpuSubtype) && /^MH_[A-Z0-9_]+$/u.test(slice.fileType)) || (normalized.entitlementsSha256 !== null && !SHA256_PATTERN.test(normalized.entitlementsSha256)) || (normalized.entitlementsCanonicalSha256 !== null && !SHA256_PATTERN.test(normalized.entitlementsCanonicalSha256)) || !normalized.entitlementKeys.every((key) => typeof key === "string" && key) || (normalized.certificateFingerprint !== null && !SHA256_PATTERN.test(normalized.certificateFingerprint)) || (normalized.certificateSha1 !== null && !SHA1_PATTERN.test(normalized.certificateSha1)) || !CD_HASH_PATTERN.test(normalized.cdHash ?? "") || (normalized.timestamp !== null && (typeof normalized.timestamp !== "string" || !normalized.timestamp)) || typeof normalized.secureTimestamp !== "boolean" || (normalized.secureTimestamp && normalized.timestamp === null) || (normalized.timestamp === "none" && normalized.secureTimestamp)) {
    throw signingError(`signature evidence for ${pathValue ?? "unknown path"} is malformed`, "record identifier, signer, Team ID, flags, timestamp, entitlements, and CDHash evidence");
  }
  return normalized;
}

async function readSignatureEvidence(bundlePath, relativePath, outer, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign, machoEvidence, ownerMode = false) {
  const binaryPath = outer && relativePath === MACOS_SIGNING_OUTER_PATH
    ? bundlePath
    : path.resolve(bundlePath, relativePath);
  const command = ownerMode ? MACOS_OWNER_TOOL_PATHS.codesign : "codesign";
  const options = ownerMode ? { env: ownerToolEnvironment() } : undefined;
  const invoke = (arguments_, overrides = undefined) => runCodesign(command, arguments_, ownerMode ? { ...(overrides ?? {}), env: ownerToolEnvironment() } : overrides);
  if (verify) {
    await invoke(["--verify", ...(outer ? ["--deep"] : []), "--strict", binaryPath], options).catch((error) => {
      throw signingError(`final signature verification failed for ${relativePath}: ${describe(error)}`, "sign every final code object in the declared mode before writing the manifest");
    });
  }
  const details = await invoke(["-dvvv", binaryPath], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
    throw signingError(`cannot inspect final signature for ${relativePath}: ${describe(error)}`, "sign the final Mach-O or outer app before manifest generation");
  });
  const parsed = parseCodesignDisplay(`${bufferToString(details.stdout)}\n${bufferToString(details.stderr)}`, relativePath);
  parsed.machOSlices = machoEvidence?.machOSlices ?? [];
  const entitlementResult = await invoke(["-d", "--entitlements", "-", "--xml", binaryPath], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
    throw signingError(`cannot inspect entitlements for ${relativePath}: ${describe(error)}`, "inspect the final signature before writing the manifest");
  });
  const signedEntitlementBytes = bufferToString(entitlementResult.stdout, true);
  parsed.entitlementsSha256 = signedEntitlementBytes.byteLength > 0
    ? sha256(signedEntitlementBytes)
    : null;
  let signedEntitlements = null;
  if (parsed.entitlementsSha256 !== null) {
    try {
      signedEntitlements = await canonicalizeEntitlements(signedEntitlementBytes, `${relativePath} signed entitlements`, { ownerMode });
    } catch {
      throw signingError(
        `signed entitlement extraction format for ${relativePath} is not a valid plist document`,
        "read signed entitlements with codesign -d --entitlements --xml - and inspect the exact plist output; do not replace the approved entitlement input plist",
      );
    }
  }
  parsed.entitlementsCanonicalSha256 = signedEntitlements?.sha256 ?? null;
  parsed.entitlementKeys = signedEntitlements?.value && typeof signedEntitlements.value === "object" && !Array.isArray(signedEntitlements.value)
    ? Object.keys(signedEntitlements.value).sort((left, right) => left.localeCompare(right))
    : [];
  const certificateEvidence = requireCertificateEvidence
    ? await extractCertificateEvidence(binaryPath, relativePath, { ownerMode })
    : null;
  parsed.certificateFingerprint = certificateEvidence?.certificateFingerprint ?? null;
  parsed.certificateSha1 = certificateEvidence?.certificateSha1 ?? null;
  return normalizeSignatureEvidence(parsed, relativePath);
}

function matchLine(text, key) {
  return text.match(new RegExp(`^${key}=(.+)$`, "mu"))?.[1]?.trim() ?? null;
}

function bufferToString(value, preserveBytes = false) {
  if (Buffer.isBuffer(value)) return preserveBytes ? value : value.toString("utf8");
  if (preserveBytes) return Buffer.from(value ?? "");
  return String(value ?? "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function signingError(reason, nextAction) {
  return new Error(`${reason}. Authority: ${MACOS_SIGNING_AUTHORITY}. Next action: ${nextAction}.`);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
