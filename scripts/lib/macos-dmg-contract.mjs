import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MACOS_PACKAGE_INSTALL_PATH } from "./macos-package-contract.mjs";

export const MACOS_DMG_SCHEMA = "MEETLESS_MACOS_DMG v1";
export const MACOS_DMG_AUTHORITY = "docs/decisions/0002-direct-notarized-macos-dmg.md";
export const MACOS_DMG_TARGET = "macos-arm64";
export const MACOS_DMG_FILENAME = "Meetless.dmg";

const execFileAsync = promisify(execFile);
const DMG_ARGUMENTS = new Map([
  ["--output-dir", "outputDir"],
  ["--proof-root", "proofRoot"],
  ["--stage-root", "stageRoot"],
]);

export function parseMacOSDmgArguments(arguments_) {
  if (!Array.isArray(arguments_)) throw layoutError("DMG arguments are not an array");
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw layoutError(`unsupported DMG argument ${String(argument)}`);
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    if (name === "--build-package") {
      if (equals >= 0 || options.buildPackage !== undefined) {
        throw layoutError("--build-package was supplied more than once or has a value");
      }
      options.buildPackage = true;
      continue;
    }
    const key = DMG_ARGUMENTS.get(name);
    if (!key) throw layoutError(`unsupported DMG argument ${argument}`);
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw layoutError(`${name} requires one non-empty path value`);
    }
    if (options[key] !== undefined) throw layoutError(`${name} was supplied more than once`);
    if ((key === "outputDir" || key === "proofRoot" || key === "stageRoot") && !path.isAbsolute(value)) {
      throw layoutError(`${name} must be an absolute ${key === "stageRoot" ? "retained stage" : "disposable"} directory`);
    }
    options[key] = value;
  }
  return options;
}

export function parseMacOSProofRootArguments(arguments_) {
  if (!Array.isArray(arguments_)) throw layoutError("macOS proof arguments are not an array");
  const remaining = [];
  let proofRoot = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      remaining.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    if (name !== "--proof-root") {
      remaining.push(argument);
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw layoutError("--proof-root requires one non-empty path value");
    }
    if (proofRoot !== null) throw layoutError("--proof-root was supplied more than once");
    if (!path.isAbsolute(value)) throw layoutError("--proof-root must be an absolute disposable directory");
    proofRoot = value;
  }
  return { proofRoot, remainingArguments: remaining };
}

export function resolveMacOSDmgPaths(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  const proofRoot = options.proofRoot === undefined || options.proofRoot === null
    ? null
    : path.resolve(options.proofRoot);
  const stageRoot = options.stageRoot === undefined || options.stageRoot === null
    ? null
    : path.resolve(options.stageRoot);
  if (proofRoot && stageRoot) throw layoutError("a DMG cannot combine a disposable proof root with a retained signing stage");
  if (proofRoot) assertDisposableProofRoot(proofRoot, root);
  if (stageRoot) {
    assertNoResolvedEntry(stageRoot, root, "retained DMG source stage");
    assertNoResolvedEntry(stageRoot, MACOS_PACKAGE_INSTALL_PATH, "retained DMG source stage");
  }
  const mode = stageRoot ? "retained-release" : "local-ad-hoc";
  const releaseRoot = stageRoot ?? path.join(proofRoot ?? root, "release", "macos");
  const sourceAppPath = path.join(releaseRoot, "Meetless.app");
  const manifestPath = path.join(releaseRoot, "composition-manifest.json");
  const outputRoot = path.resolve(options.outputDir ?? releaseRoot);
  if (proofRoot && options.outputDir !== undefined && outputRoot !== releaseRoot) {
    throw layoutError("a disposable proof root cannot be combined with a different DMG output directory");
  }
  if (stageRoot && options.outputDir === undefined) {
    throw layoutError("retained DMG output directory is not explicit", "supply --output-dir as a distinct external sibling of the retained signing stage");
  }
  if (stageRoot && (isSameOrDescendant(outputRoot, stageRoot) || isSameOrDescendant(stageRoot, outputRoot))) {
    throw layoutError("retained DMG output directory is not a distinct external sibling of the retained signing stage");
  }
  assertSafeOutputRoot(outputRoot, sourceAppPath);
  const dmgPath = path.join(outputRoot, MACOS_DMG_FILENAME);
  const sidecarPath = `${dmgPath}.json`;
  for (const [label, candidate] of [["DMG", dmgPath], ["DMG sidecar", sidecarPath]]) {
    assertOutsideSourceApp(candidate, sourceAppPath, label);
  }
  return { mode, proofRoot, stageRoot, releaseRoot, sourceAppPath, manifestPath, outputRoot, dmgPath, sidecarPath };
}

export function assertDisposableProofRoot(proofRoot, repositoryRoot) {
  const candidate = path.resolve(proofRoot);
  if (!path.isAbsolute(proofRoot)) throw layoutError("disposable proof root must be absolute");
  const repository = path.resolve(repositoryRoot);
  assertNoResolvedEntry(candidate, repository, "disposable proof root");
  assertNoResolvedEntry(candidate, MACOS_PACKAGE_INSTALL_PATH, "disposable proof root");
  const state = readLstatSync(candidate);
  if (state?.isSymbolicLink()) {
    throw layoutError(`disposable proof root is a symlink: ${candidate}`);
  }
}

export function expectedMacOSDmgLayout() {
  return [
    { name: "Applications", type: "symlink", target: "/Applications" },
    { name: "Meetless.app", type: "directory" },
  ];
}

export function validateMacOSDmgLayout(entries) {
  if (!Array.isArray(entries)) throw layoutError("DMG layout is not an entry array");
  const actual = entries.map((entry) => normalizeEntry(entry)).sort(compareEntries);
  const expected = expectedMacOSDmgLayout().sort(compareEntries);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualNames = actual.map((entry) => `${entry.name}:${entry.type}${entry.target ? `->${entry.target}` : ""}`).join(", ") || "none";
    throw layoutError(`DMG layout differs from the exact app-plus-Applications contract (observed ${actualNames})`);
  }
  return actual;
}

export function digestMacOSDmgLayout(entries) {
  return sha256(JSON.stringify(validateMacOSDmgLayout(entries)));
}

export function assertDmgSourceUnchanged(beforeDigest, afterDigest) {
  if (!/^[a-f0-9]{64}$/u.test(beforeDigest ?? "") || !/^[a-f0-9]{64}$/u.test(afterDigest ?? "")) {
    throw layoutError("DMG source mutation check has no valid SHA-256 values");
  }
  if (beforeDigest !== afterDigest) {
    throw layoutError("DMG creation changed the source Meetless.app bytes");
  }
}

export async function attestMacOSDmgLayout(dmgPath, options = {}) {
  const imagePath = path.resolve(dmgPath);
  const mountParent = path.resolve(options.mountParent ?? tmpdir());
  const mountRoot = await mkdtemp(path.join(mountParent, "meetless-dmg-mount-"));
  const mountPoint = path.join(mountRoot, "volume");
  let observed;
  let operationError = null;
  const cleanupErrors = [];
  let attached = false;
  let attachAttempted = false;
  try {
    await mkdir(mountPoint, { recursive: true, mode: 0o700 });
    try {
      attachAttempted = true;
      await execFileAsync("hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint", mountPoint,
        imagePath,
      ], { cwd: process.cwd() });
      attached = true;
      observed = validateMacOSDmgLayout(await inspectMountedLayout(mountPoint));
    } catch (error) {
      operationError = error;
    }
  } finally {
    try {
      if (attachAttempted) {
        await execFileAsync("hdiutil", ["detach", mountPoint], { cwd: process.cwd() });
      }
    } catch (error) {
      cleanupErrors.push(new Error(`DMG mount detach failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    try {
      await rm(mountRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(new Error(`DMG mount cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (operationError || cleanupErrors.length > 0) {
    const causes = [operationError, ...cleanupErrors].filter(Boolean);
    const reason = causes.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    throw new AggregateError(causes, `DMG mounted-layout attestation failed: ${reason}`);
  }
  return observed;
}

export function assertMacOSDmgLayoutMatches(expectedEntries, actualEntries) {
  const expected = validateMacOSDmgLayout(expectedEntries);
  const actual = validateMacOSDmgLayout(actualEntries);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw layoutError("mounted DMG layout differs from the declared sidecar layout");
  }
  return actual;
}

export function validateMacOSDmgSidecar(sidecar, expected = {}) {
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
    throw layoutError("DMG sidecar is not an object");
  }
  const retained = sidecar.localOnly === false;
  const expectedMode = retained ? "retained-release" : "local-ad-hoc";
  if (
    sidecar.schema !== MACOS_DMG_SCHEMA ||
    sidecar.authority !== MACOS_DMG_AUTHORITY ||
    sidecar.target !== MACOS_DMG_TARGET ||
    typeof sidecar.localOnly !== "boolean" ||
    sidecar.mode !== expectedMode ||
    sidecar.releaseAcceptance !== "not-claimed" ||
    sidecar.proofRoot !== (retained ? "external-retained-sibling" : "external-disposable") ||
    sidecar.stageStatus !== (retained ? "retained-success" : "local-ad-hoc-candidate") ||
    sidecar.signingMode !== (retained ? "release" : "local-ad-hoc") ||
    sidecar.sourceAppPath !== "Meetless.app" ||
    sidecar.artifactPath !== "Meetless.dmg" ||
    sidecar.compositionManifest !== "composition-manifest.json"
  ) {
    throw layoutError("DMG sidecar schema, authority, mode, or retained-stage status is invalid");
  }
  if (retained ? (typeof sidecar.stageRoot !== "string" || !path.isAbsolute(sidecar.stageRoot)) : sidecar.stageRoot !== null) {
    throw layoutError("DMG sidecar retained-stage root binding is invalid");
  }
  const layout = validateMacOSDmgLayout(sidecar.layout);
  const layoutDigest = digestMacOSDmgLayout(layout);
  for (const [name, value] of Object.entries({
    sourceAppSha256: sidecar.sourceAppSha256,
    artifactSha256: sidecar.artifactSha256,
    layoutSha256: sidecar.layoutSha256,
    sourceAppBeforeSha256: sidecar.sourceAppBeforeSha256,
    sourceAppAfterSha256: sidecar.sourceAppAfterSha256,
    manifestSha256: sidecar.manifestSha256,
    artifactDigest: sidecar.artifactDigest,
    signatureStateDigest: sidecar.signatureStateDigest,
  })) {
    if (!/^[a-f0-9]{64}$/u.test(value ?? "")) throw layoutError(`DMG sidecar ${name} is not a SHA-256 digest`);
  }
  if (sidecar.layoutSha256 !== layoutDigest) throw layoutError("DMG sidecar layout digest is stale");
  if (sidecar.artifactDigest !== sidecar.compositionArtifactDigest) throw layoutError("DMG sidecar artifact digest aliases differ");
  assertDmgSourceUnchanged(sidecar.sourceAppBeforeSha256, sidecar.sourceAppAfterSha256);
  if (expected.sourceAppSha256 && sidecar.sourceAppSha256 !== expected.sourceAppSha256) {
    throw layoutError("DMG sidecar source app digest differs from the observed app");
  }
  if (expected.artifactSha256 && sidecar.artifactSha256 !== expected.artifactSha256) {
    throw layoutError("DMG sidecar artifact digest differs from the observed DMG");
  }
  if (expected.manifestSha256 && sidecar.manifestSha256 !== expected.manifestSha256) {
    throw layoutError("DMG sidecar manifest digest differs from the observed composition manifest");
  }
  if (expected.artifactDigest && sidecar.artifactDigest !== expected.artifactDigest) {
    throw layoutError("DMG sidecar artifact digest differs from the observed composition manifest");
  }
  if (expected.signatureStateDigest && sidecar.signatureStateDigest !== expected.signatureStateDigest) {
    throw layoutError("DMG sidecar signature-state digest differs from the observed composition manifest");
  }
  return sidecar;
}

function assertOutsideSourceApp(candidate, sourceAppPath, label) {
  const relative = path.relative(path.resolve(sourceAppPath), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw layoutError(`${label} output would mutate the source Meetless.app at ${sourceAppPath}`);
  }
}

function assertSafeOutputRoot(outputRoot, sourceAppPath) {
  const candidate = path.resolve(outputRoot);
  const state = readLstatSync(candidate);
  if (state?.isSymbolicLink()) {
    throw layoutError(`DMG output root is a symlink: ${candidate}`);
  }
  assertOutsideSourceApp(candidate, sourceAppPath, "DMG output root");
  const sourceRealPath = resolveExistingPath(sourceAppPath);
  assertNoResolvedEntry(candidate, sourceRealPath, "DMG output root");
}

function assertNoResolvedEntry(candidate, forbiddenRoot, label) {
  const forbidden = path.resolve(forbiddenRoot);
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    const state = readLstatSync(current);
    if (state) {
      const resolved = resolveExistingPath(current);
      if (isSameOrDescendant(resolved, forbidden)) {
        throw layoutError(`${label} resolves inside ${forbidden}: ${current} -> ${resolved}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
  }
}

function readLstatSync(candidate) {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw layoutError(`cannot inspect existing path ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveExistingPath(candidate) {
  try {
    return path.resolve(realpathSync(candidate));
  } catch (error) {
    if (error?.code === "ENOENT") return path.resolve(candidate);
    throw layoutError(`cannot resolve existing path ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isSameOrDescendant(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function inspectMountedLayout(root) {
  const entries = [];
  for (const name of await readdir(root)) {
    const candidate = path.join(root, name);
    const state = await lstat(candidate);
    if (state.isSymbolicLink()) entries.push({ name, type: "symlink", target: await readlink(candidate) });
    else if (state.isDirectory()) entries.push({ name, type: "directory" });
    else if (state.isFile()) entries.push({ name, type: "file" });
    else throw layoutError(`DMG mounted top-level entry ${name} has an unsupported type`);
  }
  return entries;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw layoutError("DMG layout contains a malformed entry");
  if (typeof entry.name !== "string" || !entry.name || entry.name.includes("/") || entry.name === "." || entry.name === "..") {
    throw layoutError(`DMG entry name is not a top-level name: ${String(entry.name)}`);
  }
  if (entry.type !== "directory" && entry.type !== "symlink" && entry.type !== "file") throw layoutError(`DMG entry ${entry.name} has unsupported type`);
  if (entry.type === "symlink" && typeof entry.target !== "string") throw layoutError(`DMG symlink ${entry.name} has no target`);
  if (entry.type !== "symlink" && entry.target !== undefined) throw layoutError(`DMG ${entry.type} ${entry.name} has an unexpected target`);
  return entry.type === "symlink"
    ? { name: entry.name, type: entry.type, target: entry.target }
    : { name: entry.name, type: entry.type };
}

function compareEntries(left, right) {
  return left.name.localeCompare(right.name);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function layoutError(reason) {
  return new Error(
    `${reason}. Authority: ${MACOS_DMG_AUTHORITY}. Next action: rebuild the local DMG with Meetless.app and Applications -> /Applications only; do not claim release acceptance from ad-hoc proof.`,
  );
}
