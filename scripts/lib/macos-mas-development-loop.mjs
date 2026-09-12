import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { assertMacOSPackageParent } from "./macos-package-parent-policy.mjs";
import { acquireMasGateLock } from "./macos-mas-gate-lock.mjs";

const execFileAsync = promisify(execFile);

export const MAS_DEVELOPMENT_OUTPUT_RELATIVE_PATH = ".artifacts/macos-mas-development/current";
export const MAS_DEVELOPMENT_BUNDLE_RELATIVE_PATH = "release/macos/Meetless.app";
export const MAS_DEVELOPMENT_MANIFEST_RELATIVE_PATH = "release/macos/app-store-development-manifest.json";
export const MAS_DEVELOPMENT_INSTALL_PATH = "/Applications/Meetless.app";
export const MAS_DEVELOPMENT_RUNTIME_RELATIVE_PATH =
  "Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless";

export function resolveMasDevelopmentLoopPaths(repositoryRoot, userHome) {
  const repository = path.resolve(repositoryRoot);
  const home = path.resolve(userHome);
  const proofRoot = path.join(repository, MAS_DEVELOPMENT_OUTPUT_RELATIVE_PATH);
  return Object.freeze({
    repositoryRoot: repository,
    proofRoot,
    bundlePath: path.join(proofRoot, MAS_DEVELOPMENT_BUNDLE_RELATIVE_PATH),
    manifestPath: path.join(proofRoot, MAS_DEVELOPMENT_MANIFEST_RELATIVE_PATH),
    installPath: MAS_DEVELOPMENT_INSTALL_PATH,
    runtimeRoot: path.join(home, MAS_DEVELOPMENT_RUNTIME_RELATIVE_PATH),
    runtimeParent: path.join(home, path.dirname(MAS_DEVELOPMENT_RUNTIME_RELATIVE_PATH)),
    lockPath: path.join(home, path.dirname(MAS_DEVELOPMENT_RUNTIME_RELATIVE_PATH), ".meetless-mas-gate.lock"),
  });
}

export function parseSimpleDotenv(source) {
  const values = {};
  for (const rawLine of String(source).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error("development environment file contains an unsupported line");
    let value = match[2].trim();
    const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/u.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/u, "").trim();
    values[match[1]] = value;
  }
  return values;
}

export function assertExactMasDevelopmentInstallPath(candidate) {
  if (path.resolve(candidate) !== MAS_DEVELOPMENT_INSTALL_PATH) {
    throw new Error(`MAS development install target must be exactly ${MAS_DEVELOPMENT_INSTALL_PATH}`);
  }
  return MAS_DEVELOPMENT_INSTALL_PATH;
}

export function assertNoLegacyMasEvidence(names) {
  const legacy = [...names].filter((name) => name.startsWith(".meetless-mas-gate-session"));
  if (legacy.length > 0) {
    throw new Error(`legacy MAS transaction evidence blocks the simple development loop: ${legacy.sort().join(", ")}`);
  }
}

export async function publishCurrentMasDevelopmentArtifact({
  sourceProofRoot,
  destinationProofRoot,
  validate,
  copyTree = copyTreeWithDitto,
} = {}) {
  const source = path.resolve(sourceProofRoot);
  const destination = path.resolve(destinationProofRoot);
  if (source === destination || destination === path.parse(destination).root) {
    throw new Error("MAS development publication requires distinct bounded proof roots");
  }
  const parent = path.dirname(destination);
  const staging = path.join(parent, `.next-${process.pid}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  try {
    await copyTree(source, staging);
    await validate(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    await validate(destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function resetMasDevelopmentRuntime(paths, { remove = rm, list = readdir } = {}) {
  assertExactMasDevelopmentInstallPath(paths.installPath);
  const names = await list(paths.runtimeParent).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assertNoLegacyMasEvidence(names);
  await remove(paths.runtimeRoot, { recursive: true, force: true });
  await remove(paths.lockPath, { force: true });
}

export async function prepareOwnedInstallDirectory(target, { uid, gid, execute = execFileAsync } = {}) {
  assertExactMasDevelopmentInstallPath(target);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("MAS development installation requires numeric current-user ownership");
  }
  const command = [
    "/bin/rm -rf /Applications/Meetless.app",
    "/bin/mkdir /Applications/Meetless.app",
    `/usr/sbin/chown ${uid}:${gid} /Applications/Meetless.app`,
  ].join(" && ");
  await execute("/usr/bin/osascript", [
    "-e",
    `do shell script ${JSON.stringify(command)} with administrator privileges`,
  ]);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new Error("prepared MAS development install target is not an owned non-symlink directory");
  }
}

export async function copyTreeWithDitto(source, destination) {
  await execFileAsync("/usr/bin/ditto", [source, destination], { maxBuffer: 1024 * 1024 });
}

export async function readDevelopmentEnvironment(environmentPath) {
  const values = parseSimpleDotenv(await readFile(environmentPath, "utf8"));
  const publicSdkKey = values.MEETLESS_REVENUECAT_PUBLIC_SDK_KEY;
  const convexUrl = values.CONVEX_URL;
  if (!publicSdkKey || !convexUrl) {
    throw new Error(".env.local must provide MEETLESS_REVENUECAT_PUBLIC_SDK_KEY and CONVEX_URL for the MAS development build");
  }
  return { publicSdkKey, convexUrl };
}

// The update route never removes or restores runtime data. Backups are retained
// even after success so an interrupted installation remains recoverable.
export async function assertMasUpdateStopped(paths, { execute = execFileAsync, list = readdir, inspect = lstat, allowMissingApp = false } = {}) {
  assertExactMasDevelopmentInstallPath(paths.installPath);
  const names = await list(paths.runtimeParent);
  assertNoLegacyMasEvidence(names);
  const processes = await execute("/bin/ps", ["-axo", "command="]);
  if (String(processes.stdout).split("\n").some((line) =>
    line.trim().startsWith(`${paths.installPath}/Contents/MacOS/`))) {
    throw new Error("MAS update requires the installed Meetless host to be stopped");
  }
  let appExists = true;
  if (allowMissingApp) {
    appExists = await inspect(paths.installPath).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
  }
  const probes = [["+D", paths.runtimeRoot], ["-nP", "-iTCP:16777", "-sTCP:LISTEN"]];
  if (appExists) probes.unshift(["+D", paths.installPath]);
  for (const args of probes) {
    const result = await execute("/usr/sbin/lsof", args).catch((error) => {
      // lsof's empty-selection status is safe only without inspection errors.
      if (error?.code === 1 && !String(error.stderr ?? "").trim()) return { stdout: "" };
      throw error;
    });
    if (String(result.stdout).trim()) throw new Error("MAS update requires no open app/runtime files or listener on port 16777");
  }
}

export async function updateMasDevelopmentInstall(paths, {
  acquireLock = acquireMasGateLock,
  assertStopped = assertMasUpdateStopped,
  inspect = lstat,
  copyTree = copyTreeWithDitto,
  prepareInstall = prepareMasUpdateDirectory,
  validateInstalled,
  uid = process.getuid(),
  gid = process.getgid(),
} = {}) {
  assertExactMasDevelopmentInstallPath(paths.installPath);
  if (typeof validateInstalled !== "function") throw new Error("MAS update requires installed signature validation");
  let lease;
  try {
    lease = await acquireLock({ parentPath: paths.runtimeParent, packageParentPath: path.dirname(paths.installPath) });
  } catch (error) {
    throw new Error("MAS update could not acquire the stable host lock; leave app/runtime intact and resolve the lock owner or lock diagnostic before retrying", { cause: error });
  }
  try {
    await lease.assertHeld();
    await assertStopped(paths);
    for (const target of [paths.installPath, paths.runtimeRoot]) {
      const info = await inspect(target);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`MAS update requires an existing non-symlink directory: ${target}`);
    }
    const backupParent = path.join(path.dirname(paths.proofRoot), "update-backups");
    await mkdir(backupParent, { recursive: true, mode: 0o700 });
    const backupRoot = await mkdtemp(path.join(backupParent, "backup-"));
    await copyTree(paths.installPath, path.join(backupRoot, "Meetless.app"));
    await copyTree(paths.runtimeRoot, path.join(backupRoot, "runtime"));
    await lease.assertHeld();
    await assertStopped(paths);
    try {
      await lease.assertHeld();
      await prepareInstall(paths.installPath, { uid, gid });
      await lease.assertHeld();
      await copyTree(paths.bundlePath, paths.installPath);
      await lease.assertHeld();
      await validateInstalled();
    } catch (error) {
      try {
        await lease.assertHeld();
        await assertStopped(paths, { allowMissingApp: true });
        await lease.assertHeld();
        await prepareInstall(paths.installPath, { uid, gid, allowMissingApp: true });
        await lease.assertHeld();
        await copyTree(path.join(backupRoot, "Meetless.app"), paths.installPath);
      } catch (rollbackError) {
        throw new Error(`MAS update failed and app rollback failed; retained backup: ${backupRoot}`, { cause: new AggregateError([error, rollbackError]) });
      }
      throw new Error(`MAS update failed; previous app restored, runtime untouched; retained backup: ${backupRoot}`, { cause: error });
    }
    return backupRoot;
  } finally {
    await lease.release();
  }
}


export async function prepareMasUpdateDirectory(target, {
  uid = process.getuid(),
  allowMissingApp = false,
  assertParent = assertMacOSPackageParent,
  inspect = lstat,
  remove = rm,
  makeDirectory = mkdir,
} = {}) {
  assertExactMasDevelopmentInstallPath(target);
  if (uid !== process.getuid()) throw new Error("MAS update requires the current user's UID");
  await assertParent(path.dirname(target));
  const existing = await inspect(target).catch((error) => {
    if (allowMissingApp && error?.code === "ENOENT") return null;
    throw error;
  });
  const assertOwned = (info) => {
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
      throw new Error("MAS update target must be a current-user-owned non-symlink directory");
    }
  };
  if (existing) assertOwned(existing);
  await remove(target, { recursive: true, force: allowMissingApp });
  await makeDirectory(target);
  assertOwned(await inspect(target));
}

export function parseMasDevelopmentLoopArguments(arguments_) {
  const [command = "fresh", ...options] = arguments_;
  if (!["fresh", "update", "launch"].includes(command) ||
      (options.length > 0 && !(command === "update" && options.length === 1 && options[0] === "--reuse-current"))) {
    throw new Error("Usage: node scripts/macos-mas-development-loop.mjs <fresh|update [--reuse-current]|launch>");
  }
  return { command, reuseCurrent: options.length === 1 };
}

export async function prepareMasDevelopmentCandidate({ reuseCurrent, produce, validate, proofRoot }) {
  if (!reuseCurrent) await produce();
  // Reuse is only a producer bypass: the exact same full validation is required.
  return validate(proofRoot);
}
