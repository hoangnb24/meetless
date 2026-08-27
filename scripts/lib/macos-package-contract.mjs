import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MACOS_INSTALLATION_CONTRACT_SCHEMA = "MEETLESS_INSTALLATION_CONTRACT v1";
export const MACOS_PACKAGE_SCHEMA = "MEETLESS_MACOS_PACKAGE v2";
export const MACOS_HOST_CONFIG_SCHEMA = "MEETLESS_MACOS_HOST_CONFIG v2";
export const MACOS_PACKAGE_CONTRACT_FILENAME = "installation-contract.json";
export const MACOS_PACKAGE_MARKER_FILENAME = "meetless-package.json";
export const MACOS_PACKAGE_INSTALL_PATH = "/Applications/Meetless.app";

const contractPath = fileURLToPath(new URL("./macos-package-contract.json", import.meta.url));
const contractBytes = readFileSync(contractPath);
export const MACOS_INSTALLATION_CONTRACT = JSON.parse(contractBytes.toString("utf8"));
export const MACOS_PACKAGE_RENDERER_ORIGIN = MACOS_INSTALLATION_CONTRACT.rendererOrigin;
export const MACOS_PACKAGE_LISTEN = MACOS_INSTALLATION_CONTRACT.listen;

export function installationContractBytes() {
  return Buffer.from(contractBytes);
}

export function installationContractSha256() {
  return createHash("sha256").update(contractBytes).digest("hex");
}

export function acceptedMacOSPackagePaths(userHome = homedir()) {
  const supportRoot = path.resolve(userHome, ...MACOS_INSTALLATION_CONTRACT.userSupportRelativePath.split("/"));
  return {
    canonicalBundlePath: MACOS_PACKAGE_INSTALL_PATH,
    supportRoot,
    runtimeRoot: supportRoot,
    recordingExports: path.resolve(userHome, ...MACOS_INSTALLATION_CONTRACT.recordingExportsRelativePath.split("/")),
    identityPath: path.join(supportRoot, MACOS_INSTALLATION_CONTRACT.identityRelativePath),
    rendererOrigin: MACOS_PACKAGE_RENDERER_ORIGIN,
    listen: MACOS_PACKAGE_LISTEN,
  };
}

export function packagedMarker({ paseoCommit }) {
  return {
    schema: MACOS_PACKAGE_SCHEMA,
    target: "macos-arm64",
    bundleIdentifier: MACOS_INSTALLATION_CONTRACT.bundleIdentifier,
    paseoCommit,
    listen: MACOS_PACKAGE_LISTEN,
    rendererOrigin: MACOS_PACKAGE_RENDERER_ORIGIN,
    installationContract: MACOS_PACKAGE_CONTRACT_FILENAME,
    installationContractSha256: installationContractSha256(),
    hostBundlePath: MACOS_PACKAGE_INSTALL_PATH,
    resources: { ...MACOS_INSTALLATION_CONTRACT.package.resources },
  };
}

export function packagedHostConfiguration() {
  const runtime = MACOS_INSTALLATION_CONTRACT.runtime;
  const packageRoot = MACOS_INSTALLATION_CONTRACT.package.rootRelativeToBundle;
  return {
    schema: MACOS_HOST_CONFIG_SCHEMA,
    mode: "packaged",
    bundleIdentifier: MACOS_INSTALLATION_CONTRACT.bundleIdentifier,
    packageRoot,
    installationContract: MACOS_PACKAGE_CONTRACT_FILENAME,
    installationContractSha256: installationContractSha256(),
    runtimeRootRelativeToUserHome: MACOS_INSTALLATION_CONTRACT.userSupportRelativePath,
    identityRelativeToRuntimeRoot: MACOS_INSTALLATION_CONTRACT.identityRelativePath,
    listen: MACOS_PACKAGE_LISTEN,
    rendererOrigin: MACOS_PACKAGE_RENDERER_ORIGIN,
    transcriptionSocketRelativeToRuntimeRoot: runtime.transcriptionSocketRelativePath,
    transcriptionStagingRelativeToRuntimeRoot: runtime.transcriptionStagingRelativePath,
    nodePath: "runtime/node",
    runtimeCliPath: "packages/runtime/dist/cli.js",
  };
}

export function relativePackageResource(name) {
  const resource = MACOS_INSTALLATION_CONTRACT.package.resources[name];
  if (typeof resource !== "string" || !resource) throw new Error(`Unknown packaged resource ${name}`);
  return resource;
}
