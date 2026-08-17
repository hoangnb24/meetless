import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replace = process.argv.includes("--replace");
const config = resolveRuntimeConfig({ repositoryRoot });
const target = config.host.bundle;
const identityPath = config.host.identity;
const sourceHash = await hostSourceHash();

if (await exists(target)) {
  const executablePath = path.join(await realpath(target), "Contents", "MacOS", "MeetlessHost");
  const livePids = exactLiveHostPids(executablePath);
  if (livePids.length > 0) {
    throw new Error(
      `Refusing to install or replace ${target} while the exact MeetlessHost is live as PID(s) ${livePids.join(", ")}. ` +
      "Run npm run runtime:host:stop, verify shutdown, then retry the install.",
    );
  }
}

if (await exists(target)) {
  try {
    const [installed, recorded] = await Promise.all([
      inspectHostBundle(target),
      readFile(identityPath, "utf8").then(JSON.parse),
    ]);
    if (JSON.stringify(installed) === JSON.stringify(recorded) && !replace) {
      process.stdout.write(`${JSON.stringify({ status: "unchanged", sourceHash, ...installed }, null, 2)}\n`);
      process.exit(0);
    }
  } catch {
    // The diagnostic below intentionally treats missing or malformed identity as drift.
  }
  if (!replace) {
    throw new Error(
      `Installed Meetless host identity drift detected at ${target}. It was not regenerated or re-signed. ` +
      `Inspect the existing app, then run npm run host:install -- --replace and regrant Screen & System Audio Recording ` +
      `only to ${target}.`,
    );
  }
}

const buildRoot = await mkdtemp(path.join(tmpdir(), "meetless-host-build-"));
const bundle = path.join(buildRoot, "Meetless.app");
const contents = path.join(bundle, "Contents");
const executableDirectory = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const executable = path.join(executableDirectory, "MeetlessHost");
try {
  await Promise.all([
    mkdir(executableDirectory, { recursive: true, mode: 0o755 }),
    mkdir(resources, { recursive: true, mode: 0o755 }),
  ]);
  await cp(path.join(repositoryRoot, "native/macos-host/Info.plist"), path.join(contents, "Info.plist"));
  await writeFile(path.join(resources, "host-config.json"), `${JSON.stringify({
    repositoryRoot,
    runtimeRoot: config.paths.root,
    listen: config.listen,
    nodePath: process.execPath,
    runtimeCliPath: path.join(repositoryRoot, "packages/runtime/dist/cli.js"),
    identityPath,
  }, null, 2)}\n`, { mode: 0o644 });
  await execFileAsync("xcrun", [
    "swiftc",
    "-O",
    "-framework",
    "AppKit",
    path.join(repositoryRoot, "native/macos-host/MeetlessHost.swift"),
    "-o",
    executable,
  ]);
  await execFileAsync("codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.meetless.app",
    "--timestamp=none",
    bundle,
  ]);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const staging = path.join(path.dirname(target), `.Meetless.app.${process.pid}.${randomUUID()}.installing`);
  await cp(bundle, staging, { recursive: true, force: false, errorOnExist: true });
  let backup = null;
  let placedTarget = false;
  try {
    if (await exists(target)) {
      backup = path.join(path.dirname(target), `.Meetless.app.${process.pid}.${randomUUID()}.backup`);
      await rename(target, backup);
    }
    await rename(staging, target);
    placedTarget = true;
    const installed = await inspectHostBundle(target);
    await writeIdentity(identityPath, installed);
    if (backup) await rm(backup, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ status: replace ? "replaced" : "installed", sourceHash, ...installed }, null, 2)}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (placedTarget) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    if (backup) await rename(backup, target).catch(() => undefined);
    throw error;
  }
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

async function writeIdentity(filePath, identity) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

async function hostSourceHash() {
  const files = [
    "native/macos-host/Info.plist",
    "native/macos-host/MeetlessHost.swift",
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(await readFile(path.join(repositoryRoot, file)));
  return hash.digest("hex");
}

async function exists(candidate) {
  try { await stat(candidate); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function exactLiveHostPids(executablePath) {
  const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) throw new Error("Cannot inspect live MeetlessHost processes");
  return inspected.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match && Number(match[2]) === 1 && match[3] === executablePath ? [Number(match[1])] : [];
  });
}
