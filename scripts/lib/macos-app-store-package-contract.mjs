import { createHash } from "node:crypto";
import {
  MACOS_INSTALLATION_CONTRACT,
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
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw macAppStoreContractError("the packaged host configuration does not bind the app-container MAS contract");
  }
  return value;
}

function macAppStoreContractError(reason) {
  return new Error(
    `${reason}. Authority: ${MACOS_APP_STORE_PACKAGE_CONTRACT_AUTHORITY}. ` +
      "Next action: rebuild the MAS artifact with app-container-owned state and a user-selected security-scoped export destination.",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
