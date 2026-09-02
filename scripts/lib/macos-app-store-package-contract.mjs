import { createHash } from "node:crypto";
import {
  MACOS_INSTALLATION_CONTRACT,
  MACOS_RUNTIME_ENDPOINTS_SCHEMA,
  MACOS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
  MACOS_PACKAGE_SCHEMA,
  packagedHostConfiguration,
} from "./macos-package-contract.mjs";
import { MACOS_APP_STORE_CONTRACT } from "./macos-app-store-contract.mjs";

export const MACOS_APP_STORE_PACKAGE_CONTRACT_AUTHORITY = "docs/decisions/0005-mac-app-store-and-revenuecat.md";
const MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH =
  "Library/Containers/com.meetless.app/Data/Library/Application Support";
export const MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH = [
  MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH,
  MACOS_APP_STORE_CONTRACT.state.applicationSupportRelativePath,
].join("/");
export const MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH = [
  MACOS_APP_STORE_CONTAINER_SUPPORT_RELATIVE_PATH,
  MACOS_APP_STORE_CONTRACT.state.recordingExportsRelativePath,
].join("/");

export function macAppStoreInstallationContract() {
  const contract = MACOS_INSTALLATION_CONTRACT;
  return {
    ...contract,
    userSupportRelativePath: MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH,
    recordingExportsRelativePath: MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH,
    runtime: { ...contract.runtime },
    package: { ...contract.package, resources: { ...contract.package.resources } },
    host: { ...contract.host },
    dmg: { ...contract.dmg },
  };
}

export function macAppStoreInstallationContractBytes() {
  return Buffer.from(`${JSON.stringify(macAppStoreInstallationContract(), null, 2)}\n`);
}

export function macAppStoreInstallationContractSha256() {
  return sha256(macAppStoreInstallationContractBytes());
}

export function macAppStorePackagedMarker({ paseoCommit }) {
  const contract = macAppStoreInstallationContract();
  return {
    schema: MACOS_PACKAGE_SCHEMA,
    target: "macos-arm64",
    bundleIdentifier: contract.bundleIdentifier,
    paseoCommit,
    listen: contract.listen,
    rendererOrigin: contract.rendererOrigin,
    installationContract: contract.package.contractFilename,
    installationContractSha256: macAppStoreInstallationContractSha256(),
    hostBundlePath: contract.installPath,
    resources: { ...contract.package.resources },
  };
}

export function macAppStorePackagedHostConfiguration({ contractSha256 = macAppStoreInstallationContractSha256() } = {}) {
  const direct = packagedHostConfiguration();
  const contract = macAppStoreInstallationContract();
  return {
    ...direct,
    installationContractSha256: contractSha256,
    runtimeRootRelativeToUserHome: contract.userSupportRelativePath,
  };
}

export function validateMacAppStorePackageContract(value) {
  const expected = macAppStoreInstallationContract();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw macAppStoreContractError("the packaged installation contract is not an object");
  }
  if (value.userSupportRelativePath === MACOS_INSTALLATION_CONTRACT.userSupportRelativePath ||
      value.recordingExportsRelativePath === MACOS_INSTALLATION_CONTRACT.recordingExportsRelativePath) {
    throw macAppStoreContractError(
      "the MAS artifact/config uses the direct-DMG writable paths " +
      `(${MACOS_INSTALLATION_CONTRACT.userSupportRelativePath} or ${MACOS_INSTALLATION_CONTRACT.recordingExportsRelativePath})`,
    );
  }
  validateEndpointPolicy(value.runtime?.endpointPolicy, "installation contract");
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw macAppStoreContractError("the packaged installation contract does not match the app-container MAS contract");
  }
  return value;
}

export function validateMacAppStorePackagedMarker(value, { contractSha256 = macAppStoreInstallationContractSha256() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw macAppStoreContractError("the packaged MAS marker is not an object");
  }
  if (typeof value.paseoCommit !== "string" || !/^[a-f0-9]{40}$/u.test(value.paseoCommit)) {
    throw macAppStoreContractError("the packaged MAS marker does not bind a valid Paseo commit");
  }
  const expected = macAppStorePackagedMarker({ paseoCommit: value.paseoCommit });
  expected.installationContractSha256 = contractSha256;
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw macAppStoreContractError("the packaged marker does not bind the app-container MAS contract");
  }
  return value;
}

export function validateMacAppStorePackagedHostConfiguration(
  value,
  { contractSha256 = macAppStoreInstallationContractSha256() } = {},
) {
  const expected = macAppStorePackagedHostConfiguration({ contractSha256: contractSha256 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw macAppStoreContractError("the packaged host configuration is not an object");
  }
  if (value.runtimeRootRelativeToUserHome === MACOS_INSTALLATION_CONTRACT.userSupportRelativePath) {
    throw macAppStoreContractError(
      `the MAS host configuration resolves runtime state through ${MACOS_INSTALLATION_CONTRACT.userSupportRelativePath}`,
    );
  }
  validateEndpointPolicy({
    schema: value.endpointPolicy,
    workingDirectory: value.endpointWorkingDirectory,
    recordingEndpointName: value.recordingEndpointName,
    transcriptionEndpointName: value.transcriptionEndpointName,
  }, "host configuration");
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw macAppStoreContractError("the packaged host configuration does not bind the app-container MAS contract");
  }
  return value;
}

function validateEndpointPolicy(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw macAppStoreContractError(`${label} endpoint policy is missing or not an object`);
  }
  const expectedKeys = ["schema", "workingDirectory", "recordingEndpointName", "transcriptionEndpointName"].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw macAppStoreContractError(
      `${label} endpoint policy fields ${JSON.stringify(actualKeys)} do not match ${JSON.stringify(expectedKeys)}`,
      "restore the exact MEETLESS_RUNTIME_ENDPOINTS v1 policy shape before packaging",
    );
  }
  const expected = {
    schema: MACOS_RUNTIME_ENDPOINTS_SCHEMA,
    workingDirectory: MACOS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
  };
  if (value.schema !== expected.schema || value.workingDirectory !== expected.workingDirectory) {
    throw macAppStoreContractError(
      `${label} endpoint policy ${JSON.stringify(value.schema)} / working directory ${JSON.stringify(value.workingDirectory)} ` +
      `does not match ${expected.schema} / ${expected.workingDirectory}`,
    );
  }
  for (const [role, name] of [
    ["recording", value.recordingEndpointName],
    ["transcription", value.transcriptionEndpointName],
  ]) {
    if (typeof name !== "string" || !name || name !== name.trim() || name.includes("\\") || name.includes("\u0000") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw macAppStoreContractError(
        `${label} ${role} endpoint name ${JSON.stringify(name)} is not a contained relative name`,
        "restore a non-empty relative endpoint name from the accepted MEETLESS_RUNTIME_ENDPOINTS v1 policy",
      );
    }
    if (Buffer.byteLength(name, "utf8") > 103) {
      throw macAppStoreContractError(
        `${label} ${role} endpoint name exceeds the 103-byte Darwin limit`,
        "restore an endpoint name at or below 103 UTF-8 bytes in the accepted MEETLESS_RUNTIME_ENDPOINTS v1 policy",
      );
    }
  }
  if (value.recordingEndpointName === value.transcriptionEndpointName) {
    throw macAppStoreContractError(
      `${label} recording and transcription endpoint names must remain distinct`,
      "restore distinct recording and transcription names in the accepted MEETLESS_RUNTIME_ENDPOINTS v1 policy",
    );
  }
}

function macAppStoreContractError(reason, nextAction = "rebuild the MAS artifact with app-container-owned state and a user-selected security-scoped export destination") {
  return new Error(
    `${reason}. Authority: ${MACOS_APP_STORE_PACKAGE_CONTRACT_AUTHORITY}. ` +
      `Next action: ${nextAction}.`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
