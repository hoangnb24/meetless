import { createHash, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MACOS_SIGNING_SCHEMA = "MEETLESS_MACOS_SIGNING v1";
export const MACOS_SIGNING_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";
export const LOCAL_AD_HOC_SIGNING_MODE = "local-ad-hoc";
export const RELEASE_SIGNING_MODE = "release";
export const MACOS_SIGNING_MODES = Object.freeze([LOCAL_AD_HOC_SIGNING_MODE, RELEASE_SIGNING_MODE]);
export const MACOS_SIGNING_OUTER_PATH = "Meetless.app";

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
    if (!option) throw signingError(`unsupported signing option ${name}`, "use --signing-mode, --signing-identity, --entitlements, or --team-id");
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

export function normalizeSigningOptions({ mode, signingMode = mode, signingIdentity = null, entitlementsPath = null, expectedTeamId = null } = {}) {
  if (!MACOS_SIGNING_MODES.includes(signingMode)) {
    throw signingError(`signing mode is ${String(signingMode)}`, "supply --signing-mode=local-ad-hoc or --signing-mode=release");
  }
  const identity = signingIdentity?.trim() || null;
  const entitlementFile = entitlementsPath?.trim() || null;
  const teamId = expectedTeamId?.trim() || null;
  if (teamId !== null && !TEAM_ID_PATTERN.test(teamId)) {
    throw signingError(`Team ID ${teamId} is not a valid uppercase Apple Team ID evidence value`, "supply the Team ID shown by the signing identity");
  }
  if (signingMode === LOCAL_AD_HOC_SIGNING_MODE) {
    if (identity !== null && identity !== "-") {
      throw signingError(`local ad-hoc mode received release identity ${identity}`, "use --signing-mode=release with an explicit signing identity");
    }
    if (entitlementFile !== null) {
      throw signingError("local ad-hoc mode received an entitlement file", "use --signing-mode=release for hardened-runtime entitlements");
    }
    if (teamId !== null) {
      throw signingError("local ad-hoc mode received a Team ID", "use --signing-mode=release for Developer ID Team ID evidence");
    }
    return {
      mode: LOCAL_AD_HOC_SIGNING_MODE,
      identity: "-",
      entitlementsPath: null,
      expectedTeamId: null,
    };
  }
  if (!identity) {
    throw signingError("release signing identity is missing", "supply --signing-identity with the intended Developer ID identity");
  }
  if (identity === "-" || /^adhoc$/iu.test(identity)) {
    throw signingError(`release signing identity ${identity} is ad-hoc`, "supply a non-ad-hoc Developer ID Application identity");
  }
  if (!entitlementFile) {
    throw signingError("release entitlement file is missing", "supply --entitlements with the owner-provided entitlement file");
  }
  return {
    mode: RELEASE_SIGNING_MODE,
    identity,
    entitlementsPath: path.resolve(entitlementFile),
    expectedTeamId: teamId,
  };
}

export async function resolveSigningInputs(options) {
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
      entitlementFileSha256: null,
      entitlementOwnerCanonicalSha256: null,
    };
  }
  const inspected = await lstat(normalized.entitlementsPath).catch(() => null);
  if (!inspected?.isFile() || inspected.isSymbolicLink()) {
    throw signingError(
      `release entitlement input is not a regular non-symlink file: ${normalized.entitlementsPath}`,
      "supply the exact owner-provided entitlement file",
    );
  }
  const bytes = await readFile(normalized.entitlementsPath);
  if (bytes.byteLength === 0) {
    throw signingError(`release entitlement input is empty: ${normalized.entitlementsPath}`, "supply the non-empty owner-provided entitlement file");
  }
  const canonicalEntitlements = await canonicalizeEntitlements(bytes, normalized.entitlementsPath);
  const signer = await resolveDeveloperIdSigner({
    requestedIdentity: normalized.identity,
    expectedTeamId: normalized.expectedTeamId,
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
    entitlementFileSha256: sha256(bytes),
    entitlementOwnerCanonicalSha256: canonicalEntitlements.sha256,
  };
}

export async function resolveDeveloperIdSigner({
  requestedIdentity,
  expectedTeamId = null,
  findIdentityOutput = null,
  findCertificateOutput = null,
  runSecurity = runSecurityCommand,
} = {}) {
  if (typeof requestedIdentity !== "string" || !requestedIdentity) {
    throw signingError("release signing identity is missing", "supply the exact Developer ID Application identity");
  }
  const identityOutput = findIdentityOutput ?? await runSecurity(["find-identity", "-v", "-p", "codesigning"]);
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
  const certificateOutput = findCertificateOutput ?? await runSecurity(["find-certificate", "-a", "-Z", "-c", selected.identity]);
  const certificate = parseCertificateEvidence(certificateOutput, selected.certificateSha1);
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

export async function canonicalizeEntitlements(value, label = "entitlements") {
  const bytes = typeof value === "string" ? await readFile(value) : Buffer.from(value ?? "");
  if (bytes.byteLength === 0) {
    throw signingError(`${label} is empty`, "supply a non-empty owner-provided entitlement plist");
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "meetless-entitlements-"));
  const temporaryPath = path.join(temporaryRoot, "entitlements.plist");
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600 });
    const result = await execFileAsync("plutil", ["-convert", "json", "-o", "-", "--", temporaryPath], { encoding: "utf8" }).catch((error) => {
      throw signingError(`${label} is not a valid plist: ${describe(error)}`, "supply the owner-provided entitlement plist in a valid macOS plist format");
    });
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw signingError(`${label} did not convert to valid plist JSON: ${describe(error)}`, "supply a valid owner-provided entitlement plist");
    }
    const canonical = JSON.stringify(sortCanonicalValue(parsed));
    return { canonical, sha256: sha256(Buffer.from(canonical)) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runSecurityCommand(arguments_) {
  const result = await execFileAsync("security", arguments_, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
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
    entitlementsPath: mode === RELEASE_SIGNING_MODE ? (outer ? entitlementsPath : "nested-signature-entitlements-not-used") : null,
  });
  if (typeof target !== "string" || !target || typeof identifier !== "string" || !identifier) {
    throw signingError("codesign target or identifier is missing", "sign every final Mach-O and the outer app with explicit paths");
  }
  const arguments_ = ["--force", "--sign", normalized.identity, "--identifier", identifier];
  if (normalized.mode === RELEASE_SIGNING_MODE) {
    arguments_.push("--options", "runtime");
    if (outer) arguments_.push("--entitlements", normalized.entitlementsPath);
  }
  arguments_.push("--timestamp=none", target);
  return arguments_;
}

export function parseCodesignDisplay(output, relativePath) {
  const text = String(output ?? "");
  const identifier = matchLine(text, "Identifier") ?? null;
  const teamValue = matchLine(text, "TeamIdentifier");
  const teamId = teamValue && teamValue !== "not set" ? teamValue : null;
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const flagMatch = text.match(/\bflags=0x[0-9a-f]+(?:\(([^)]*)\))?/iu);
  const flags = flagMatch?.[1] ? flagMatch[1].split(",").map((flag) => flag.trim()).filter(Boolean).sort() : [];
  const signatureValue = matchLine(text, "Signature");
  const signature = signatureValue ?? (teamId ? "cms" : "adhoc");
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
    certificateFingerprint: null,
    certificateSha1: null,
    cdHash,
  };
}

export async function collectMacOSSignatureEvidence({
  bundlePath,
  machoPaths,
  outerPath = MACOS_SIGNING_OUTER_PATH,
  verify = false,
  requireCertificateEvidence = false,
  extractCertificateEvidence = extractSignatureCertificateEvidence,
  runCodesign = execFileAsync,
} = {}) {
  const order = buildSigningOrder(machoPaths, outerPath);
  const nestedMachO = [];
  for (const relativePath of order.nestedMachO) {
    nestedMachO.push(await readSignatureEvidence(bundlePath, relativePath, false, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign));
  }
  const outer = await readSignatureEvidence(bundlePath, order.outer, true, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign);
  return { order, outer, nestedMachO };
}

export async function extractSignatureCertificateEvidence(binaryPath, relativePath = binaryPath) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "meetless-signature-certs-"));
  const prefix = path.join(temporaryRoot, "certificate-");
  try {
    await execFileAsync("codesign", ["-d", `--extract-certificates=${prefix}`, binaryPath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
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
  entitlementFileSha256 = null,
  entitlementOwnerCanonicalSha256 = null,
  order,
  outer,
  nestedMachO,
}) {
  const normalized = normalizeSigningOptions({ mode, signingIdentity: requestedIdentity, entitlementsPath: mode === RELEASE_SIGNING_MODE ? "provided" : null, expectedTeamId });
  if (mode === LOCAL_AD_HOC_SIGNING_MODE) {
    // The placeholder above only selects the release/local validation branch.
    normalized.entitlementsPath = null;
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
    entitlements: {
      required: mode === RELEASE_SIGNING_MODE,
      scope: mode === RELEASE_SIGNING_MODE ? "outer-app" : null,
      fileSha256: mode === RELEASE_SIGNING_MODE ? entitlementFileSha256 : null,
      ownerCanonicalSha256: mode === RELEASE_SIGNING_MODE ? entitlementOwnerCanonicalSha256 : null,
      signedSha256: mode === RELEASE_SIGNING_MODE ? state.outer.entitlementsSha256 : null,
      signedCanonicalSha256: mode === RELEASE_SIGNING_MODE ? state.outer.entitlementsCanonicalSha256 : null,
    },
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
    entitlementFileSha256: mode === RELEASE_SIGNING_MODE ? entitlementFileSha256 : null,
    entitlementOwnerCanonicalSha256: mode === RELEASE_SIGNING_MODE ? entitlementOwnerCanonicalSha256 : null,
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
  entitlementFileSha256 = null,
  entitlementOwnerCanonicalSha256 = null,
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
  if (signing.mode === RELEASE_SIGNING_MODE && entitlementFileSha256 !== null && signing.entitlements.fileSha256 !== entitlementFileSha256) {
    throw signingError("manifest entitlement file digest is stale or mismatched", "rebuild and validate with the exact supplied entitlement file");
  }
  if (signing.mode === RELEASE_SIGNING_MODE && entitlementOwnerCanonicalSha256 !== null && signing.entitlements.ownerCanonicalSha256 !== entitlementOwnerCanonicalSha256) {
    throw signingError("manifest canonical owner entitlement digest is stale or mismatched", "rebuild and validate with the exact supplied entitlement plist semantics");
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
  if (signing.mode === RELEASE_SIGNING_MODE && signing.entitlements.fileSha256 !== entitlementFileSha256 && entitlementFileSha256 !== null) {
    throw signingError("release entitlement file digest does not match the declared contract", "use the same supplied entitlement file for signing and validation");
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
  if (!signing.entitlements || signing.entitlements.required !== (signing.mode === RELEASE_SIGNING_MODE) || signing.entitlements.scope !== (signing.mode === RELEASE_SIGNING_MODE ? "outer-app" : null)) {
    throw signingError("manifest entitlement contract is missing or has the wrong scope", "bind the supplied entitlement file to the outer app without inventing entitlement policy");
  }
  if (signing.mode === RELEASE_SIGNING_MODE && (!SHA256_PATTERN.test(signing.entitlements.fileSha256 ?? "") || !SHA256_PATTERN.test(signing.entitlements.ownerCanonicalSha256 ?? "") || !SHA256_PATTERN.test(signing.entitlements.signedSha256 ?? "") || !SHA256_PATTERN.test(signing.entitlements.signedCanonicalSha256 ?? ""))) {
    throw signingError("release entitlement file or signed entitlement digest is missing", "supply the owner-provided entitlement file and regenerate post-signature metadata");
  }
  if (signing.mode === LOCAL_AD_HOC_SIGNING_MODE && (signing.identity.requested !== "-" || signing.identity.resolved !== "-" || signing.identity.teamId !== null || signing.identity.certificateFingerprint !== null || signing.identity.certificateSha1 !== null || signing.entitlements.fileSha256 !== null || signing.entitlements.ownerCanonicalSha256 !== null || signing.entitlements.signedSha256 !== null || signing.entitlements.signedCanonicalSha256 !== null)) {
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
  ) {
    throw signingError("release package uses an ad-hoc signer or lacks Developer ID certificate evidence", "resolve one exact Developer ID Application leaf certificate and sign every final code object with it");
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
  if (state.outer.entitlementsSha256 !== signing.entitlements.signedSha256 || state.outer.entitlementsCanonicalSha256 !== signing.entitlements.signedCanonicalSha256 || signing.entitlements.ownerCanonicalSha256 !== signing.entitlements.signedCanonicalSha256) {
    throw signingError("outer app signed entitlements are missing or semantically differ from the owner plist", "re-sign the outer app with the owner-provided entitlement file without changing its values");
  }
  if (signing.distribution?.status !== "developer-id-preparation") {
    throw signingError("release package preparation status is missing", "mark the artifact as Developer ID preparation without claiming release acceptance");
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
  const normalized = {
    path: pathValue,
    identifier: evidence.identifier ?? null,
    identity: evidence.identity ?? (evidence.signature === "adhoc" ? "-" : null),
    teamId: evidence.teamId ?? null,
    signature: evidence.signature ?? null,
    authorities: Array.isArray(evidence.authorities) ? [...evidence.authorities] : [],
    flags,
    hardenedRuntime: evidence.hardenedRuntime ?? flags.includes("runtime"),
    entitlementsSha256: evidence.entitlementsSha256 ?? null,
    entitlementsCanonicalSha256: evidence.entitlementsCanonicalSha256 ?? null,
    certificateFingerprint: evidence.certificateFingerprint ?? null,
    certificateSha1: evidence.certificateSha1 ?? null,
    cdHash: evidence.cdHash ?? null,
  };
  if (typeof normalized.path !== "string" || !normalized.path || path.isAbsolute(normalized.path) || typeof normalized.identifier !== "string" || !normalized.identifier || typeof normalized.identity !== "string" || !normalized.identity || (normalized.teamId !== null && !TEAM_ID_PATTERN.test(normalized.teamId)) || typeof normalized.signature !== "string" || !normalized.signature || typeof normalized.hardenedRuntime !== "boolean" || (normalized.entitlementsSha256 !== null && !SHA256_PATTERN.test(normalized.entitlementsSha256)) || (normalized.entitlementsCanonicalSha256 !== null && !SHA256_PATTERN.test(normalized.entitlementsCanonicalSha256)) || (normalized.certificateFingerprint !== null && !SHA256_PATTERN.test(normalized.certificateFingerprint)) || (normalized.certificateSha1 !== null && !SHA1_PATTERN.test(normalized.certificateSha1)) || !CD_HASH_PATTERN.test(normalized.cdHash ?? "")) {
    throw signingError(`signature evidence for ${pathValue ?? "unknown path"} is malformed`, "record identifier, signer, Team ID, flags, entitlements, and CDHash evidence");
  }
  return normalized;
}

async function readSignatureEvidence(bundlePath, relativePath, outer, verify, requireCertificateEvidence, extractCertificateEvidence, runCodesign) {
  const binaryPath = outer && relativePath === MACOS_SIGNING_OUTER_PATH
    ? bundlePath
    : path.resolve(bundlePath, relativePath);
  if (verify) {
    await runCodesign("codesign", ["--verify", ...(outer ? ["--deep"] : []), "--strict", binaryPath]).catch((error) => {
      throw signingError(`final signature verification failed for ${relativePath}: ${describe(error)}`, "sign every final code object in the declared mode before writing the manifest");
    });
  }
  const details = await runCodesign("codesign", ["-dvvv", binaryPath], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
    throw signingError(`cannot inspect final signature for ${relativePath}: ${describe(error)}`, "sign the final Mach-O or outer app before manifest generation");
  });
  const parsed = parseCodesignDisplay(`${bufferToString(details.stdout)}\n${bufferToString(details.stderr)}`, relativePath);
  const entitlementResult = await runCodesign("codesign", ["-d", "--entitlements", "-", binaryPath], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }).catch((error) => {
    throw signingError(`cannot inspect entitlements for ${relativePath}: ${describe(error)}`, "inspect the final signature before writing the manifest");
  });
  parsed.entitlementsSha256 = bufferToString(entitlementResult.stdout, true).byteLength > 0
    ? sha256(bufferToString(entitlementResult.stdout, true))
    : null;
  parsed.entitlementsCanonicalSha256 = parsed.entitlementsSha256 === null
    ? null
    : (await canonicalizeEntitlements(bufferToString(entitlementResult.stdout, true), `${relativePath} signed entitlements`)).sha256;
  const certificateEvidence = requireCertificateEvidence
    ? await extractCertificateEvidence(binaryPath, relativePath)
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
