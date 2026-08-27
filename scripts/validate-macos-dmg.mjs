import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fingerprintPath } from "./lib/macos-package-transaction.mjs";
import {
  assertMacOSDmgLayoutMatches,
  attestMacOSDmgLayout,
  parseMacOSDmgArguments,
  resolveMacOSDmgPaths,
  validateMacOSDmgSidecar,
} from "./lib/macos-dmg-contract.mjs";
import { validateArtifactStageRoot } from "./lib/macos-artifact-resign.mjs";
import { validateMacOSPackage } from "./validate-macos-package.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dmgOptions = parseMacOSDmgArguments(process.argv.slice(2));
const dmgPaths = resolveMacOSDmgPaths(
  repositoryRoot,
  dmgOptions,
);
const { mode, proofRoot, stageRoot, sourceAppPath: bundlePath, manifestPath, outputRoot, dmgPath, sidecarPath } = dmgPaths;
if (mode === "local-ad-hoc" && !proofRoot) {
  throw new Error("local/ad-hoc DMG validation requires --proof-root outside repository release/macos; refusing to validate repository release bytes");
}

await main();

async function main() {
  const [sidecarBytes, appState, dmgState] = await Promise.all([
    readFile(sidecarPath),
    fingerprintPath(bundlePath),
    stat(dmgPath),
  ]);
  if (!appState) throw new Error("DMG source Meetless.app is missing");
  if (!dmgState.isFile() || dmgState.size <= 0) throw new Error("Meetless.dmg is not a non-empty regular file");
  const stage = mode === "retained-release" ? await validateRetainedStage() : null;
  await validateMacOSPackage(manifestPath, mode === "retained-release"
    ? {
      repositoryRoot,
      artifactOnly: true,
      retainedArtifactOnly: true,
      ownerMode: true,
    }
    : {
      repositoryRoot,
      artifactOnly: false,
      disposableProof: true,
    });
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const artifactSha256 = createHash("sha256").update(await readFile(dmgPath)).digest("hex");
  const sidecar = validateMacOSDmgSidecar(JSON.parse(sidecarBytes.toString("utf8")), {
    sourceAppSha256: appState,
    artifactSha256,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    artifactDigest: manifest.artifactDigest,
    signatureStateDigest: manifest.signing.signatureStateDigest,
  });
  if (sidecar.compositionArtifactDigest !== manifest.artifactDigest || sidecar.artifactDigest !== manifest.artifactDigest || sidecar.signatureStateDigest !== manifest.signing.signatureStateDigest || sidecar.stageRoot !== (stageRoot ?? null)) {
    throw new Error("DMG sidecar composition manifest digest differs from the validated package");
  }
  await execFileAsync("hdiutil", ["verify", dmgPath], { cwd: repositoryRoot });
  const actualLayout = await attestMacOSDmgLayout(dmgPath, { mountParent: proofRoot ?? outputRoot });
  assertMacOSDmgLayoutMatches(sidecar.layout, actualLayout);
  process.stdout.write(`${JSON.stringify({
    status: mode === "retained-release" ? "validated-retained-release-dmg" : "validated-local-ad-hoc-dmg",
    proofRoot,
    dmgPath,
    sidecarPath,
    sourceAppFingerprint: appState,
    dmgSha256: sidecar.artifactSha256,
    layoutSha256: sidecar.layoutSha256,
    layout: sidecar.layout,
    localOnly: sidecar.localOnly,
    mode,
    releaseAcceptance: sidecar.releaseAcceptance,
  }, null, 2)}\n`);
}

async function validateRetainedStage() {
  const stage = await validateArtifactStageRoot({ stageRoot, repositoryRoot, ownerMode: true });
  if (stage.status?.state !== "retained-success" || stage.status.attempt !== 1) {
    throw new Error("retained release DMG validation requires one retained-success owner stage with attempt 1");
  }
  if (path.resolve(stage.bundlePath) !== path.resolve(bundlePath) || path.resolve(stage.manifestPath) !== path.resolve(manifestPath)) {
    throw new Error("retained release DMG source paths do not match the validated owner stage");
  }
  return stage;
}
