import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MACOS_APP_STORE_ELECTRON_BINARY_PATH,
  resolveRuntimeConfig,
} from "../src/config.js";
import {
  MACOS_INSTALLATION_CONTRACT,
  installationContractBytes,
  packagedMarker,
} from "../../../scripts/lib/macos-package-contract.mjs";
import {
  macAppStoreInstallationContract,
  macAppStoreInstallationContractBytes,
  macAppStorePackagedMarker,
} from "../../../scripts/lib/macos-app-store-package-contract.mjs";

const FIXTURE_HOME = "/Users/config-fixture";
const FIXTURE_PASEO_COMMIT = "a2c8ff349ffdf6f500eb09270c7f44af4c018bfc";
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged runtime Electron layout contract", () => {
  test("resolves MAS Electron from the bundle and keeps the direct route package-root-relative", async () => {
    const mas = await createPackagedFixture("mas");
    const masConfig = resolveRuntimeConfig({ repositoryRoot: mas.packageRoot, userHome: FIXTURE_HOME });
    expect(masConfig.packageResources?.electronBinary).toBe(
      path.join(mas.bundle, MACOS_APP_STORE_ELECTRON_BINARY_PATH),
    );
    expect(masConfig.packageResources?.electronBinary).not.toBe(
      path.join(mas.packageRoot, "runtime/electron/Electron.app/Contents/MacOS/Electron"),
    );

    const direct = await createPackagedFixture("direct");
    const directConfig = resolveRuntimeConfig({ repositoryRoot: direct.packageRoot, userHome: FIXTURE_HOME });
    expect(directConfig.packageResources?.electronBinary).toBe(
      path.join(direct.packageRoot, MACOS_INSTALLATION_CONTRACT.package.resources.electronBinary),
    );
    expect(directConfig.packageResources?.electronBinary).not.toBe(
      path.join(direct.bundle, MACOS_APP_STORE_ELECTRON_BINARY_PATH),
    );
  });

  test.each([
    ["missing descriptor", (contract: Record<string, any>) => {
      delete contract.package.electronBinary;
    }],
    ["wrong descriptor base", (contract: Record<string, any>) => {
      contract.package.electronBinary.pathBase = "package";
    }],
    ["absolute descriptor path", (contract: Record<string, any>) => {
      contract.package.electronBinary.path = "/Contents/Helpers/Electron.app/Contents/MacOS/Electron";
    }],
    ["traversal descriptor path", (contract: Record<string, any>) => {
      contract.package.electronBinary.path = "../Contents/Helpers/Electron.app/Contents/MacOS/Electron";
    }],
  ] as const)("rejects MAS %s before packaged runtime resolution", async (_label, mutate) => {
    const fixture = await createPackagedFixture("mas", mutate);
    expect(() => resolveRuntimeConfig({ repositoryRoot: fixture.packageRoot, userHome: FIXTURE_HOME })).toThrow(
      /MAS Electron descriptor|installation contract endpoint policy is invalid|electronBinary/s,
    );
  });

  test("rejects a legacy duplicate Electron app under Resources", async () => {
    const fixture = await createPackagedFixture("mas");
    await mkdir(
      path.join(fixture.bundle, "Contents/Resources/meetless/runtime/electron/Electron.app"),
      { recursive: true },
    );
    expect(() => resolveRuntimeConfig({ repositoryRoot: fixture.packageRoot, userHome: FIXTURE_HOME })).toThrow(
      /legacy Electron app layout.*Contents\/Resources\/meetless\/runtime\/electron\/Electron\.app/s,
    );
  });

  test("rejects a symlink that escapes the MAS bundle", async () => {
    const fixture = await createPackagedFixture("mas");
    const electronAppPath = path.join(fixture.bundle, "Contents/Helpers/Electron.app");
    const outsideAppPath = path.join(fixture.root, "outside", "Electron.app");
    await mkdir(path.join(outsideAppPath, "Contents/MacOS"), { recursive: true });
    await writeFile(path.join(outsideAppPath, "Contents/MacOS/Electron"), "outside\n");
    await rm(electronAppPath, { recursive: true, force: true });
    await symlink(outsideAppPath, electronAppPath);

    expect(() => resolveRuntimeConfig({ repositoryRoot: fixture.packageRoot, userHome: FIXTURE_HOME })).toThrow(
      /electronBinary resource resolves outside the package root/s,
    );
  });
});

async function createPackagedFixture(
  layout: "direct" | "mas",
  mutate?: (contract: Record<string, any>) => void,
): Promise<{ root: string; bundle: string; packageRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-runtime-config-layout-"));
  fixtureRoots.push(root);
  const bundle = path.join(root, "Meetless.app");
  const packageRoot = path.join(bundle, "Contents/Resources/meetless");
  const contract = layout === "mas"
    ? structuredClone(macAppStoreInstallationContract()) as Record<string, any>
    : structuredClone(MACOS_INSTALLATION_CONTRACT) as Record<string, any>;
  mutate?.(contract);
  const contractBytes = layout === "mas"
    ? Buffer.from(`${JSON.stringify(contract, null, 2)}\n`)
    : installationContractBytes();
  const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
  const marker = layout === "mas"
    ? {
      ...macAppStorePackagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT }),
      installationContractSha256: contractSha256,
      resources: { ...contract.package.resources },
    }
    : packagedMarker({ paseoCommit: FIXTURE_PASEO_COMMIT });

  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "installation-contract.json"), contractBytes);
  await writeFile(path.join(packageRoot, "meetless-package.json"), `${JSON.stringify(marker, null, 2)}\n`);
  await writePackagedResources(packageRoot, bundle, contract.package.resources);
  return { root, bundle, packageRoot };
}

async function writePackagedResources(
  packageRoot: string,
  bundle: string,
  resources: Record<string, string>,
): Promise<void> {
  for (const [name, relativePath] of Object.entries(resources)) {
    const resourceRoot = name === "electronBinary" && relativePath.startsWith("Contents/Helpers/")
      ? bundle
      : packageRoot;
    const target = path.join(resourceRoot, relativePath);
    if (name === "rendererRoot") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${name}\n`);
    }
  }
}
