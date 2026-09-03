import path from "node:path";

export const MAS_GATE_ARTIFACT_BINDING_SCHEMA = "MAS_GATE_ARTIFACT_BINDING v1";
export const MAS_GATE_ARTIFACT_BINDING_VERSION = 1;

const BINDING_FIELDS = Object.freeze([
  "schema",
  "version",
  "manifestPath",
  "manifestSha256",
  "bundlePath",
  "bundleFingerprint",
  "artifactDigest",
  "candidateSnapshotDigest",
  "packageInputDigest",
  "artifactInputDigest",
  "licenseDigest",
  "signatureDigest",
  "publicSdkKeySha256",
]);
const DIGEST_FIELDS = Object.freeze([
  "manifestSha256",
  "bundleFingerprint",
  "artifactDigest",
  "candidateSnapshotDigest",
  "packageInputDigest",
  "artifactInputDigest",
  "licenseDigest",
  "signatureDigest",
  "publicSdkKeySha256",
]);

/**
 * Convert the complete validator result into the only package-install identity
 * that may cross the MAS coordinator boundary. The DTO is deliberately plain,
 * closed over an allow-list, and recursively frozen; it contains no SDK key.
 */
export function freezeMasGateArtifactBinding(value) {
  const binding = assertMasGateArtifactBinding(value);
  return deepFreeze(Object.fromEntries(BINDING_FIELDS.map((field) => [field, binding[field]])));
}

export function assertMasGateArtifactBinding(value, { bundlePath, manifestPath } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("MAS artifact binding must be one plain object");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...BINDING_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("MAS artifact binding contains an unexpected or missing field");
  }
  if (value.schema !== MAS_GATE_ARTIFACT_BINDING_SCHEMA || value.version !== MAS_GATE_ARTIFACT_BINDING_VERSION) {
    throw new Error("MAS artifact binding schema or version is invalid");
  }
  for (const [field, expected] of [["manifestPath", manifestPath], ["bundlePath", bundlePath]]) {
    if (expected !== undefined && value[field] !== expected) throw new Error(`MAS artifact binding ${field} is not exact`);
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field]) || path.resolve(value[field]) !== value[field] || value[field].includes("\0")) {
      throw new Error(`MAS artifact binding ${field} is not one canonical absolute path`);
    }
  }
  for (const field of DIGEST_FIELDS) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field])) {
      throw new Error(`MAS artifact binding ${field} is not one SHA-256 digest`);
    }
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
