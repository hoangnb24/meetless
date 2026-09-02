import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MACOS_APP_STORE_RECORDING_EXPORTS_RELATIVE_PATH,
  MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH,
  resolveRuntimeConfig,
} from "../src/config.js";
import {
  MACOS_INSTALLATION_CONTRACT,
  installationContractBytes,
  packagedMarker,
  packagedHostConfiguration,
} from "../../../scripts/lib/macos-package-contract.mjs";
import { expectedHostConfiguration, resolveHostConfiguration } from "../src/host.js";
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

  test("names endpoint policy violations and gives a compliant repair action", () => {
    const contract = macAppStoreInstallationContract();
    const invalidContract = {
      ...contract,
      runtime: {
        ...contract.runtime,
        endpointPolicy: {
          ...contract.runtime.endpointPolicy,
          recordingEndpointName: "../recording.sock",
        },
      },
    };
    expect(() => validateMacAppStorePackageContract(invalidContract)).toThrow(
      /installation contract recording endpoint name.*relative name.*Authority:.*0005-mac-app-store-and-revenuecat.*Next action: restore a non-empty relative endpoint name/s,
    );

    const invalidHost = {
      ...macAppStorePackagedHostConfiguration(),
      recordingEndpointName: "a".repeat(104),
    };
    expect(() => validateMacAppStorePackagedHostConfiguration(invalidHost)).toThrow(
      /host configuration recording endpoint name exceeds the 103-byte Darwin limit.*Next action: restore an endpoint name at or below 103 UTF-8 bytes/s,
    );
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
    expect(config.paths.recordingSocket).toBe(
      `${FIXTURE_RUNTIME_ROOT}/paseo-home/recording-control.sock`,
    );
    expect(config.endpoints.recording.bindArgument).toBe("paseo-home/recording-control.sock");
    expect(config.endpoints.transcription.bindArgument).toBe("transcription.sock");
    expect(config.endpoints.recording.canonicalPath).toContain(FIXTURE_CONTAINER_SUPPORT);
    expect(config.environment.MEETLESS_APP_CONTAINER_SUPPORT_ROOT).toBe(FIXTURE_CONTAINER_SUPPORT);
    expect(config.environment.MEETLESS_EXPORT_ROOT).toBe(config.paths.recordingExports);
    expect(expectedHostConfiguration(config).nodePath).toBe(config.packageResources?.nodeBinary);
    expect(expectedHostConfiguration(config).nodePath).not.toBe(process.execPath);

    const childConfig = resolveRuntimeConfig({
      repositoryRoot: root,
      userHome: FIXTURE_HOME,
      environment: config.environment,
    });
    expect(childConfig.paths.recordingExports).toBe(config.paths.recordingExports);
    expect(childConfig.environment.MEETLESS_EXPORT_ROOT).toBe(config.paths.recordingExports);

    expect(() => resolveRuntimeConfig({
      repositoryRoot: root,
      userHome: FIXTURE_HOME,
      environment: {
        MEETLESS_RUNTIME_ROOT: FIXTURE_RUNTIME_ROOT,
        MEETLESS_RECORDING_SOCKET: `${FIXTURE_RUNTIME_ROOT}/legacy-recording.sock`,
      },
    })).toThrow(
      /Runtime endpoint MEETLESS_RECORDING_SOCKET violates policy.*canonical absolute projection.*stop before child launch/s,
    );

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

  test("keeps direct-DMG one-argument static host inspection compatible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-direct-host-contract-"));
    fixtureRoots.push(root);
    const bundle = path.join(root, "Meetless.app");
    const packageRoot = path.join(bundle, "Contents/Resources/meetless");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "installation-contract.json"), installationContractBytes());
    await writeFile(
      path.join(packageRoot, "meetless-package.json"),
      `${JSON.stringify(packagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT }), null, 2)}\n`,
    );

    const configuration = resolveHostConfiguration(packagedHostConfiguration(), bundle);
    expect(configuration.runtimeRoot).toBe(
      path.resolve(homedir(), MACOS_INSTALLATION_CONTRACT.userSupportRelativePath),
    );
    expect(configuration.nodePath).toBe(path.join(packageRoot, "runtime/node"));
    expect(configuration.captureHelperPath).toBe(
      path.join(packageRoot, MACOS_INSTALLATION_CONTRACT.package.resources.captureHelper),
    );
  });

  test("keeps packaged bind arguments stable across ordinary, long ASCII, and long Unicode homes", async () => {
    const root = await createPackagedMasFixture();
    const homes = [
      "/Users/example",
      `/Users/${"long-ascii-home-segment-".repeat(12)}`,
      `/Users/${"用户家目录-".repeat(18)}`,
    ];
    const compositions = homes.map((userHome) => {
      const containerSupport = path.join(
        userHome,
        "Library/Containers/com.meetless.app/Data/Library/Application Support",
      );
      return resolveRuntimeConfig({
        repositoryRoot: root,
        userHome,
        environment: { MEETLESS_RUNTIME_ROOT: path.join(containerSupport, "Meetless") },
      }).endpoints;
    });

    for (const endpoints of compositions) {
      expect(endpoints.recording.bindArgument).toBe("paseo-home/recording-control.sock");
      expect(endpoints.transcription.bindArgument).toBe("transcription.sock");
      expect(Buffer.byteLength(endpoints.recording.bindArgument, "utf8")).toBeLessThanOrEqual(103);
      expect(Buffer.byteLength(endpoints.transcription.bindArgument, "utf8")).toBeLessThanOrEqual(103);
      expect(endpoints.recording.canonicalPath).toBe(
        `${endpoints.workingDirectory}/paseo-home/recording-control.sock`,
      );
      expect(endpoints.transcription.canonicalPath).toBe(
        `${endpoints.workingDirectory}/transcription.sock`,
      );
      expect(endpoints.recording.canonicalPath.startsWith(`${endpoints.workingDirectory}/`)).toBe(true);
      expect(endpoints.transcription.canonicalPath.startsWith(`${endpoints.workingDirectory}/`)).toBe(true);
    }
    expect(compositions.map((endpoints) => endpoints.recording.bindArgument)).toEqual([
      "paseo-home/recording-control.sock",
      "paseo-home/recording-control.sock",
      "paseo-home/recording-control.sock",
    ]);
  });

  test("projects the packaged host endpoint composition under the exact runtime root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-mas-host-contract-"));
    fixtureRoots.push(root);
    const bundle = path.join(root, "Meetless.app");
    const packageRoot = path.join(bundle, "Contents/Resources/meetless");
    await mkdir(packageRoot, { recursive: true });
    const contract = macAppStoreInstallationContract();
    const contractSha256 = macAppStoreInstallationContractSha256();
    const marker = macAppStorePackagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT });
    await writeFile(path.join(packageRoot, "installation-contract.json"), macAppStoreInstallationContractBytes());
    await writeFile(path.join(packageRoot, "meetless-package.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await writePackagedResources(packageRoot, marker.resources);

    const configuration = resolveHostConfiguration(
      macAppStorePackagedHostConfiguration({ contractSha256 }),
      bundle,
      {
        runtimeRoot: FIXTURE_RUNTIME_ROOT,
        containerSupportRoot: FIXTURE_CONTAINER_SUPPORT,
      },
    );
    expect(configuration.endpointPolicy).toBe("MEETLESS_RUNTIME_ENDPOINTS v1");
    expect(configuration.endpointWorkingDirectory).toBe("runtime-root");
    expect(configuration.recordingEndpointName).toBe(contract.runtime.endpointPolicy.recordingEndpointName);
    expect(configuration.transcriptionEndpointName).toBe(contract.runtime.endpointPolicy.transcriptionEndpointName);
    expect(configuration.transcriptionSocket).toBe(
      path.join(configuration.runtimeRoot, contract.runtime.endpointPolicy.transcriptionEndpointName),
    );
    expect(configuration.captureHelperPath).toBe(
      path.join(packageRoot, contract.package.resources.captureHelper),
    );
    const runtimeConfiguration = resolveRuntimeConfig({
      repositoryRoot: packageRoot,
      userHome: FIXTURE_HOME,
      listen: contract.listen,
      rendererOrigin: contract.rendererOrigin,
      environment: { MEETLESS_RUNTIME_ROOT: FIXTURE_RUNTIME_ROOT },
    });
    expect(configuration).toEqual(expectedHostConfiguration(runtimeConfiguration));

    expect(resolveHostConfiguration(
      macAppStorePackagedHostConfiguration({ contractSha256 }),
      bundle,
    ).runtimeRoot).not.toBe(FIXTURE_RUNTIME_ROOT);
    expect(() => resolveHostConfiguration(
      macAppStorePackagedHostConfiguration({ contractSha256 }),
      bundle,
      {
        runtimeRoot: path.join(FIXTURE_CONTAINER_SUPPORT, "Other"),
        containerSupportRoot: FIXTURE_CONTAINER_SUPPORT,
      },
    )).toThrow(/MAS runtime root .*differs from the supplied app-container support root/);
    expect(() => resolveHostConfiguration(
      macAppStorePackagedHostConfiguration({ contractSha256 }),
      bundle,
      {
        runtimeRoot: FIXTURE_RUNTIME_ROOT,
        containerSupportRoot: `${FIXTURE_HOME}/Library/Application Support`,
      },
    )).toThrow(/app-container support root .*outside the Meetless app container/);
    expect(() => resolveHostConfiguration(
      macAppStorePackagedHostConfiguration({ contractSha256 }),
      bundle,
      { runtimeRoot: FIXTURE_RUNTIME_ROOT },
    )).toThrow(/app-container support root must be supplied/);
  });

  test("keeps capture helper internal and rejects invalid digest-bound resource bindings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-mas-capture-helper-contract-"));
    fixtureRoots.push(root);
    const bundle = path.join(root, "Meetless.app");
    const packageRoot = path.join(bundle, "Contents/Resources/meetless");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "meetless-package.json"),
      `${JSON.stringify(macAppStorePackagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT }), null, 2)}\n`,
    );

    const packagedConfiguration = macAppStorePackagedHostConfiguration();
    expect(() => resolveHostConfiguration({
      ...packagedConfiguration,
      captureHelperPath: "native/macos-capture/meetless-capture",
    }, bundle)).toThrow(/Unrecognized key.*captureHelperPath/s);

    await writeFile(path.join(packageRoot, "installation-contract.json"), macAppStoreInstallationContractBytes());
    expect(() => resolveHostConfiguration({
      ...packagedConfiguration,
      installationContractSha256: "0".repeat(64),
    }, bundle)).toThrow(/installation contract digest .* differs from 0{64}/s);

    const mutations: Array<[string, unknown]> = [
      ["omitted", undefined],
      ["non-string", 42],
      ["empty", ""],
      ["traversal", "../meetless-capture"],
      ["absolute escape", "/private/tmp/meetless-capture"],
    ];
    for (const [label, captureHelper] of mutations) {
      const contract = macAppStoreInstallationContract();
      if (captureHelper === undefined) {
        delete (contract.package.resources as Record<string, unknown>).captureHelper;
      } else {
        (contract.package.resources as Record<string, unknown>).captureHelper = captureHelper;
      }
      const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
      const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
      await writeFile(path.join(packageRoot, "installation-contract.json"), contractBytes);
      expect(
        () => resolveHostConfiguration(
          macAppStorePackagedHostConfiguration({ contractSha256 }),
          bundle,
        ),
        label,
      ).toThrow(
        /package\.resources\.captureHelper.*Authority: ADR0004.*digest-verified installation artifact contract.*Next action: rebuild the complete macOS package/s,
      );
    }

    const developmentConfiguration = {
      schema: "MEETLESS_MACOS_HOST_CONFIG v2",
      mode: "development",
      bundleIdentifier: "com.meetless.app",
      repositoryRoot: process.cwd(),
      runtimeRoot: "/tmp/meetless-development-host",
      listen: "127.0.0.1:6777",
      rendererOrigin: "http://127.0.0.1:8082",
      transcriptionSocket: "/tmp/meetless-development-host/transcription.sock",
      transcriptionStaging: "/tmp/meetless-development-host/transcription",
      nodePath: process.execPath,
      runtimeCliPath: path.resolve("packages/runtime/dist/cli.js"),
      identityPath: "/tmp/meetless-development-host/host-identity.json",
    };
    expect(resolveHostConfiguration(developmentConfiguration, bundle)).not.toHaveProperty("captureHelperPath");
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
  await writePackagedResources(root, marker.resources);

  expect(validateMacAppStorePackageContract(JSON.parse(contractBytes.toString("utf8")))).toBeTruthy();
  expect(validateMacAppStorePackagedMarker(marker, { contractSha256 })).toBeTruthy();
  expect(validateMacAppStorePackagedHostConfiguration(hostConfiguration, { contractSha256 })).toBeTruthy();
  return root;
}

async function writePackagedResources(root: string, resources: Record<string, string>): Promise<void> {
  for (const [name, relativePath] of Object.entries(resources)) {
    const target = path.join(root, relativePath);
    if (name === "rendererRoot") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${name}\n`);
    }
  }
}
