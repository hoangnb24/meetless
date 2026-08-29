import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fingerprintPath } from "./lib/macos-package-transaction.mjs";
import {
  MACOS_DMG_AUTHORITY,
  parseMacOSDmgArguments,
  MACOS_DMG_SCHEMA,
  MACOS_DMG_TARGET,
  assertMacOSDmgLayoutMatches,
  attestMacOSDmgLayout,
  digestMacOSDmgLayout,
  resolveMacOSDmgPaths,
  validateMacOSDmgLayout,
} from "./lib/macos-dmg-contract.mjs";
import { validateArtifactStageRoot } from "./lib/macos-artifact-resign.mjs";
import { validateMacOSPackage } from "./validate-macos-package.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dmgOptions = parseMacOSDmgArguments(process.argv.slice(2));
const dmgPaths = resolveMacOSDmgPaths(repositoryRoot, dmgOptions);
const { mode, proofRoot, stageRoot, sourceAppPath: bundlePath, manifestPath, outputRoot, dmgPath, sidecarPath } = dmgPaths;

if (mode !== "retained-release") requireDisposableProofRoot(proofRoot);
if (mode === "retained-release" && dmgOptions.buildPackage) {
  throw new Error("retained release DMG packaging cannot rebuild the package; use the retained-success stage as its read-only source");
}
if (dmgOptions.buildPackage) await buildDisposablePackage(proofRoot, dmgOptions);
await main();

async function main() {
  assertDarwinArm64();
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const bundleState = await lstat(bundlePath).catch(() => null);
  if (!bundleState?.isDirectory() || bundleState.isSymbolicLink()) {
    throw new Error("local DMG source Meetless.app must be one regular non-symlink directory");
  }
  const stage = mode === "retained-release"
    ? await validateRetainedStage()
    : null;
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
      signingMode: mode === "disposable-release" ? "release" : "local-ad-hoc",
      signingIdentity: dmgOptions.signingIdentity,
      expectedTeamId: dmgOptions.expectedTeamId,
    });
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const beforeDigest = await fingerprintPath(bundlePath);
  if (!beforeDigest) throw new Error("local DMG source Meetless.app has no fingerprint");

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "meetless-dmg-layout-"));
  let expectedLayout;
  try {
    const stagedApp = path.join(stagingRoot, "Meetless.app");
    await cp(bundlePath, stagedApp, { recursive: true, verbatimSymlinks: true, force: false });
    await symlink("/Applications", path.join(stagingRoot, "Applications"));
    expectedLayout = validateMacOSDmgLayout(await inspectLayout(stagingRoot));
    await rm(dmgPath, { force: true });
    await execFileAsync("hdiutil", [
      "create",
      "-volname", "Meetless",
      "-srcfolder", stagingRoot,
      "-ov",
      "-format", "UDZO",
      dmgPath,
    ], { cwd: repositoryRoot });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const afterDigest = await fingerprintPath(bundlePath);
  if (!afterDigest) throw new Error("local DMG source Meetless.app disappeared after DMG creation");
  if (beforeDigest !== afterDigest) throw new Error("DMG creation changed the source Meetless.app fingerprint");
  await execFileAsync("hdiutil", ["verify", dmgPath], { cwd: repositoryRoot });
  const mountedLayout = await attestMacOSDmgLayout(dmgPath, { mountParent: proofRoot ?? outputRoot });
  const actualLayout = assertMacOSDmgLayoutMatches(expectedLayout, mountedLayout);
  const artifactSha256 = await sha256File(dmgPath);
  const sidecar = {
    schema: MACOS_DMG_SCHEMA,
    authority: MACOS_DMG_AUTHORITY,
    target: MACOS_DMG_TARGET,
    sourceAppPath: "Meetless.app",
    sourceAppSha256: beforeDigest,
    sourceAppBeforeSha256: beforeDigest,
    sourceAppAfterSha256: afterDigest,
    artifactPath: "Meetless.dmg",
    artifactSha256,
    manifestSha256: sha256(manifestBytes),
    artifactDigest: manifest.artifactDigest,
    signatureStateDigest: manifest.signing.signatureStateDigest,
    layout: actualLayout,
    layoutSha256: digestMacOSDmgLayout(actualLayout),
    localOnly: mode === "local-ad-hoc",
    mode,
    signingMode: manifest.signing.mode,
    stageStatus: mode === "retained-release" ? stage.status.state : mode === "disposable-release" ? "direct-release-candidate" : "local-ad-hoc-candidate",
    stageRoot: stageRoot ?? null,
    releaseAcceptance: "not-claimed",
    proofRoot: mode === "retained-release" ? "external-retained-sibling" : "external-disposable",
    compositionManifest: "composition-manifest.json",
    compositionArtifactDigest: manifest.artifactDigest,
  };
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({
    status: mode === "retained-release" ? "retained-release-dmg-candidate" : mode === "disposable-release" ? "direct-release-dmg-candidate" : "local-ad-hoc-candidate",
    bundlePath,
    manifestPath,
    dmgPath,
    sidecarPath,
    appFingerprint: beforeDigest,
    dmgSha256: artifactSha256,
    layoutSha256: sidecar.layoutSha256,
    localOnly: sidecar.localOnly,
    releaseAcceptance: "not-claimed",
  }, null, 2)}\n`);
}

async function validateRetainedStage() {
  const stage = await validateArtifactStageRoot({ stageRoot, repositoryRoot, ownerMode: true });
  if (stage.status?.state !== "retained-success" || stage.status.attempt !== 1) {
    throw new Error("retained release DMG source requires one retained-success owner stage with attempt 1");
  }
  if (path.resolve(stage.bundlePath) !== path.resolve(bundlePath) || path.resolve(stage.manifestPath) !== path.resolve(manifestPath)) {
    throw new Error("retained release DMG source paths do not match the validated owner stage");
  }
  return stage;
}

async function buildDisposablePackage(disposableRoot, options) {
  assertDarwinArm64();
  await run("npm", ["run", "build"]);
  const packageArguments = [
    path.join(repositoryRoot, "scripts", "package-macos.mjs"),
    `--signing-mode=${options.signingMode ?? "local-ad-hoc"}`,
    `--proof-root=${disposableRoot}`,
  ];
  if (options.signingMode === "release") {
    packageArguments.push(`--signing-identity=${options.signingIdentity}`, `--team-id=${options.expectedTeamId}`);
  }
  if (options.buildNumber) packageArguments.push(`--build-number=${options.buildNumber}`);
  await run(process.execPath, packageArguments);
}

async function inspectLayout(root) {
  const entries = [];
  for (const name of await readdir(root)) {
    const candidate = path.join(root, name);
    const state = await lstat(candidate);
    if (state.isSymbolicLink()) entries.push({ name, type: "symlink", target: await readlink(candidate) });
    else if (state.isDirectory()) entries.push({ name, type: "directory" });
    else throw new Error(`DMG staging contains unsupported top-level entry ${name}`);
  }
  return entries;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`local macOS DMG requires darwin arm64, received ${process.platform} ${process.arch}`);
  }
}

function requireDisposableProofRoot(disposableRoot) {
  if (!disposableRoot) {
    throw new Error("local/ad-hoc DMG proof requires --proof-root outside repository release/macos; refusing to mutate release/macos");
  }
}

async function run(command, arguments_) {
  const result = await execFileAsync(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}
