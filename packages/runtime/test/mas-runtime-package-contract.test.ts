import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH,
  MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH,
  resolveRuntimeConfig,
} from "../src/config.js";
import {
  MACOS_INSTALLATION_CONTRACT,
  packagedHostConfiguration,
} from "../../../scripts/lib/macos-package-contract.mjs";
import {
  macAppStoreInstallationContract,
  macAppStoreInstallationContractBytes,
  macAppStoreInstallationContractSha256,
  macAppStorePackagedHostConfiguration,
  macAppStorePackagedMarker,
  validateMacAppStorePackageContract,
  validateMacAppStorePackagedHostConfiguration,
  validateMacAppStorePackagedMarker,
} from "../../../scripts/lib/macos-app-store-package-contract.mjs";

const FIXTURE_PASEO_COMMIT = "7618cda71e2836f9ba7e821286504841203cb745";
const FIXTURE_HOME = "/Users/example";
const FIXTURE_CONTAINER_SUPPORT = `${FIXTURE_HOME}/Library/Containers/com.meetless.app/Data/Library/Application Support`;
const FIXTURE_RUNTIME_ROOT = `${FIXTURE_CONTAINER_SUPPORT}/Meetless`;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Mac App Store runtime/package contract", () => {
  test("emits and validates app-container state, host, and marker bindings", async () => {
    const contract = macAppStoreInstallationContract();
    expect(contract.userSupportRelativePath).toBe(MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH);
    expect(contract.recordingExportsRelativePath).toBe(MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH);
    expect(contract.userSupportRelativePath).not.toBe(MACOS_INSTALLATION_CONTRACT.userSupportRelativePath);
    expect(contract.recordingExportsRelativePath).not.toBe(MACOS_INSTALLATION_CONTRACT.recordingExportsRelativePath);

    const contractBytes = macAppStoreInstallationContractBytes();
    expect(JSON.parse(contractBytes.toString("utf8"))).toEqual(contract);
    expect(macAppStoreInstallationContractSha256()).toMatch(/^[a-f0-9]{64}$/u);
    expect(validateMacAppStorePackageContract(contract)).toEqual(contract);

    const marker = macAppStorePackagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT });
    expect(validateMacAppStorePackagedMarker(marker, {
      contractSha256: macAppStoreInstallationContractSha256(),
    })).toEqual(marker);
    const hostConfiguration = macAppStorePackagedHostConfiguration({
      contractSha256: macAppStoreInstallationContractSha256(),
    });
    expect(validateMacAppStorePackagedHostConfiguration(hostConfiguration, {
      contractSha256: macAppStoreInstallationContractSha256(),
    })).toEqual(hostConfiguration);
    expect(hostConfiguration.runtimeRootRelativeToUserHome).toBe(MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH);
    expect(hostConfiguration.runtimeRootRelativeToUserHome).not.toBe(
      packagedHostConfiguration().runtimeRootRelativeToUserHome,
    );

    const directContract = JSON.parse(await readFile("scripts/lib/macos-package-contract.json", "utf8"));
    expect(() => validateMacAppStorePackageContract(directContract)).toThrow(
      /direct-DMG writable paths.*docs\/decisions\/0005-mac-app-store-and-revenuecat\.md.*Next action/s,
    );
    expect(() => validateMacAppStorePackagedHostConfiguration(packagedHostConfiguration())).toThrow(
      /MAS host configuration resolves runtime state.*docs\/decisions\/0005-mac-app-store-and-revenuecat\.md.*Next action/s,
    );
    expect(() => validateMacAppStorePackagedMarker({
      ...marker,
      paseoCommit: "not-a-commit",
    })).toThrow(/valid Paseo commit/);
  });

  test("resolves packaged MAS state inside the app container and rejects direct export overrides", async () => {
    const root = await createPackagedMasFixture();
    const config = resolveRuntimeConfig({
      repositoryRoot: root,
      userHome: FIXTURE_HOME,
      environment: { MEETLESS_RUNTIME_ROOT: FIXTURE_RUNTIME_ROOT },
    });
    expect(config.packaged).toBe(true);
    expect(config.paths.root).toBe(FIXTURE_RUNTIME_ROOT);
    expect(config.paths.recordingExports).toBe(
      `${FIXTURE_CONTAINER_SUPPORT}/Meetless/recordings`,
    );
    expect(config.paths.recordingExports).not.toBe(`${FIXTURE_HOME}/Documents/meetings`);
    expect(config.paths.recordingSocket).toMatch(/^\/private\/tmp\/meetless-recording-[a-f0-9]{24}\.sock$/u);
    expect(config.paths.recordingSocket).not.toContain(FIXTURE_CONTAINER_SUPPORT);
    expect(config.environment.MEETLESS_APP_CONTAINER_SUPPORT_ROOT).toBe(FIXTURE_CONTAINER_SUPPORT);
    expect(config.environment.MEETLESS_EXPORT_ROOT).toBe(config.paths.recordingExports);

    expect(() => resolveRuntimeConfig({
      repositoryRoot: root,
      userHome: FIXTURE_HOME,
      environment: {
        MEETLESS_RUNTIME_ROOT: FIXTURE_RUNTIME_ROOT,
        MEETLESS_EXPORT_ROOT: `${FIXTURE_HOME}/Documents/meetings`,
      },
    })).toThrow(
      /Mac App Store recording exports cannot be redirected.*docs\/decisions\/0005-mac-app-store-and-revenuecat\.md.*security-scoped export/s,
    );
    expect(() => resolveRuntimeConfig({
      repositoryRoot: root,
      userHome: FIXTURE_HOME,
      environment: {
        MEETLESS_RUNTIME_ROOT: FIXTURE_RUNTIME_ROOT,
        MEETLESS_APP_CONTAINER_SUPPORT_ROOT: `${FIXTURE_HOME}/Library/Application Support`,
      },
    })).toThrow(/differs from the app-container path.*docs\/decisions\/0005-mac-app-store-and-revenuecat\.md/s);
  });
});

async function createPackagedMasFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-mas-contract-"));
  fixtureRoots.push(root);
  const contractBytes = macAppStoreInstallationContractBytes();
  const contractSha256 = macAppStoreInstallationContractSha256();
  const marker = macAppStorePackagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT });
  const hostConfiguration = macAppStorePackagedHostConfiguration({ contractSha256 });

  await writeFile(path.join(root, "installation-contract.json"), contractBytes);
  await writeFile(path.join(root, "meetless-package.json"), `${JSON.stringify(marker, null, 2)}\n`);
  for (const [name, relativePath] of Object.entries(marker.resources)) {
    const target = path.join(root, relativePath);
    if (name === "rendererRoot") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${name}\n`);
    }
  }

  expect(validateMacAppStorePackageContract(JSON.parse(contractBytes.toString("utf8")))).toBeTruthy();
  expect(validateMacAppStorePackagedMarker(marker, { contractSha256 })).toBeTruthy();
  expect(validateMacAppStorePackagedHostConfiguration(hostConfiguration, { contractSha256 })).toBeTruthy();
  return root;
}
