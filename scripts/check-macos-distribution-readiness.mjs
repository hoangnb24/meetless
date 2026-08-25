import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMacOSPackage, validateLicenseInventoryDocument } from "./validate-macos-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authority = "docs/decisions/0001-maintained-paseo-fork.md";

export function unresolvedOwnerDecisions(inventory) {
  return (inventory.components ?? [])
    .filter((component) => component.ownerDecision?.required && component.ownerDecision.status !== "resolved")
    .map((component) => ({
      component: component.id,
      artifactPathCount: component.artifactPathScope?.paths?.length ?? 0,
      nextAction: component.ownerDecision.nextAction,
    }));
}

export function assertDistributionReadiness(inventory) {
  validateLicenseInventoryDocument(inventory);
  const unresolved = unresolvedOwnerDecisions(inventory);
  if (unresolved.length) {
    const diagnostics = unresolved
      .map((item) => `${item.component} (${item.artifactPathCount} artifact paths): ${item.nextAction}`)
      .join("\n");
    throw new Error(
      `repository-declared technical obligations remain unresolved:\n${diagnostics}\nAuthority: ${authority}. Next action: record each required Human/legal owner decision before binary release. This check is not legal clearance.`,
    );
  }
  return {
    status: "repository-declared-technical-obligations-resolved",
    message: "Repository-declared technical obligations are resolved. This result is not legal clearance.",
  };
}

export async function checkDistributionReadiness(manifestPath = path.join(repositoryRoot, "release/macos/composition-manifest.json")) {
  await validateMacOSPackage(manifestPath, { repositoryRoot });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const bundlePath = path.resolve(path.dirname(manifestPath), manifest.bundlePath);
  const inventoryPath = path.join(bundlePath, manifest.licenseInventory.path);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  return assertDistributionReadiness(inventory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const manifestPath = process.argv[2] ?? path.join(repositoryRoot, "release/macos/composition-manifest.json");
  checkDistributionReadiness(manifestPath)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
