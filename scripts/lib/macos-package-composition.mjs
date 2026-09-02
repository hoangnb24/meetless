import { readFile } from "node:fs/promises";
import path from "node:path";

const PACKAGE_DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

export const MACOS_LOCAL_PACKAGES = Object.freeze([
  Object.freeze(["@meetless/runtime", "packages/runtime", ["dist"], []]),
  Object.freeze(["@meetless/managed-transcription-foundation", "packages/managed-transcription-foundation", ["dist"], []]),
  Object.freeze(["@meetless/meeting-contracts", "packages/meeting-contracts", ["dist"], []]),
  Object.freeze(["@meetless/meeting-domain", "packages/meeting-domain", ["dist"], []]),
  Object.freeze(["@meetless/meeting-store", "packages/meeting-store", ["dist"], []]),
  Object.freeze(["@meetless/client", "packages/meetless-client", ["dist"], []]),
  Object.freeze(["@meetless/plugin", "packages/meetless-plugin", ["dist", "src"], ["index.tsx", "paseo-plugin.json"]]),
  Object.freeze(["@getpaseo/highlight", "vendor/paseo/packages/highlight", ["dist"], []]),
  Object.freeze(["@paseo/plugin", "vendor/paseo/packages/plugin", ["dist"], []]),
  Object.freeze(["@getpaseo/protocol", "vendor/paseo/packages/protocol", ["dist"], []]),
  Object.freeze(["@getpaseo/relay", "vendor/paseo/packages/relay", ["dist"], []]),
  Object.freeze(["@getpaseo/client", "vendor/paseo/packages/client", ["dist"], []]),
  Object.freeze(["@getpaseo/server", "vendor/paseo/packages/server", ["dist"], []]),
  Object.freeze(["@getpaseo/cli", "vendor/paseo/packages/cli", ["dist", "bin"], []]),
  Object.freeze(["@getpaseo/desktop", "vendor/paseo/packages/desktop", ["dist", "assets"], []]),
]);

export async function validateMacOSPackageComposition({ repositoryRoot, localPackages = MACOS_LOCAL_PACKAGES } = {}) {
  const root = path.resolve(repositoryRoot ?? process.cwd());
  const rootLock = await readJson(path.join(root, "package-lock.json"), "root package lock");
  const packageManifests = [];
  for (const tuple of localPackages) {
    const [name, sourceRelative] = validateLocalPackageTuple(tuple);
    const manifestPath = path.join(root, sourceRelative, "package.json");
    packageManifests.push({ name, manifest: await readJson(manifestPath, `${name} package manifest`) });
  }
  return validateMacOSPackageCompositionData({ localPackages, packageManifests, rootLock });
}

export function validateMacOSPackageCompositionData({ localPackages = MACOS_LOCAL_PACKAGES, packageManifests, rootLock } = {}) {
  if (!rootLock || typeof rootLock !== "object" || !rootLock.packages || typeof rootLock.packages !== "object") {
    throw new Error("Root package lock does not contain package records; Next action: use the repository package-lock.json for localPackages/selection validation");
  }
  if (!Array.isArray(localPackages)) {
    throw new Error("Packaged local package selection is not an array; Next action: restore the fixed localPackages/selection tuple list before packaging");
  }
  if (!Array.isArray(packageManifests)) {
    throw new Error("Packaged local package manifests are missing; Next action: inspect every selected localPackages/selection tuple before packaging");
  }

  const selectedNames = new Set();
  for (const tuple of localPackages) {
    const [name] = validateLocalPackageTuple(tuple);
    if (selectedNames.has(name)) {
      throw new Error(`Packaged local package ${name} is selected more than once; Next action: keep one fixed tuple in localPackages/selection`);
    }
    selectedNames.add(name);
  }
  if (packageManifests.length !== selectedNames.size) {
    throw new Error("Not every selected packaged local package has been inspected; Next action: inspect every fixed localPackages/selection manifest before packaging");
  }

  const workspaceLinks = [];
  const inspectedNames = new Set();
  for (const packageRecord of packageManifests) {
    const declaringPackage = packageRecord?.name;
    if (typeof declaringPackage !== "string" || !selectedNames.has(declaringPackage) || inspectedNames.has(declaringPackage)) {
      throw new Error("Packaged local package manifest identity is invalid or duplicated; Next action: inspect every fixed localPackages/selection manifest before packaging");
    }
    inspectedNames.add(declaringPackage);
    const manifest = packageRecord?.manifest;
    if (!manifest || typeof manifest !== "object") {
      throw new Error(`Packaged local package ${declaringPackage} manifest is not an object; Next action: repair the selected localPackages/selection package manifest`);
    }
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        const lockPath = `node_modules/${dependency}`;
        const lockRecord = rootLock.packages[lockPath];
        if (lockRecord?.link !== true) continue;
        const workspaceLink = {
          declaringPackage,
          dependency,
          section,
          classification: "root-lock-workspace-link",
          lockPath,
          resolved: lockRecord.resolved ?? null,
        };
        workspaceLinks.push(workspaceLink);
        if (!selectedNames.has(dependency)) {
          throw new Error(
            `Packaged local package ${declaringPackage} declares ${section} dependency ${dependency}, but root package-lock.json classifies ${lockPath} as a workspace link omitted from the selected local package set. ` +
            `Authority: docs/specs/macos-artifact-validation.md and docs/decisions/0001-maintained-paseo-fork.md. Next action: add ${dependency} to localPackages/selection with its fixed tuple; keep inclusion selective and copy only the intended dist output.`,
          );
        }
      }
    }
  }
  return { localPackages, workspaceLinks };
}

function validateLocalPackageTuple(tuple) {
  const [name, sourceRelative] = tuple ?? [];
  if (!Array.isArray(tuple) || typeof name !== "string" || !name || typeof sourceRelative !== "string" || !sourceRelative) {
    throw new Error("A packaged local package tuple is invalid; Next action: fix the fixed localPackages/selection tuple before packaging");
  }
  return [name, sourceRelative];
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : `: ${String(error)}`;
    throw new Error(`${label} could not be inspected at ${filePath}${reason}; Next action: restore the selected localPackages/selection manifest or root lock`);
  }
}
