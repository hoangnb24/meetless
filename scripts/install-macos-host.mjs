import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inspectHostBundle } from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replace = process.argv.includes("--replace");
const config = resolveRuntimeConfig({
  repositoryRoot,
  runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT,
  listen: process.env.MEETLESS_LISTEN,
});
const target = config.host.bundle;
const identityPath = config.host.identity;
const exclusionPath = path.join(config.paths.root, "meetless-host.lock");
const exclusionMarker = "MEETLESS_HOST_INSTALL_LOCK_HELD";

await mkdir(config.paths.root, { recursive: true, mode: 0o700 });
if (process.env[exclusionMarker] !== exclusionPath) {
  const locked = spawnSync("/usr/bin/lockf", [
    "-t", "0", "-k", exclusionPath,
    process.execPath, ...process.argv.slice(1),
  ], {
    stdio: "inherit",
    env: { ...process.env, [exclusionMarker]: exclusionPath },
  });
  if (locked.error) throw locked.error;
  if (locked.status === 75) {
    const owner = await readFile(exclusionPath, "utf8").then((value) => value.trim(), () => "unknown owner");
    throw new Error(
      `Refusing MeetlessHost install/replacement because ${exclusionPath} is held by ${owner}. ` +
      "If the exact host is live, run npm run runtime:host:stop; kernel release makes stale file contents harmless.",
    );
  }
  process.exit(locked.status ?? 1);
}
const lockProbe = spawnSync("/usr/bin/lockf", ["-t", "0", "-k", exclusionPath, "/usr/bin/true"]);
if (lockProbe.status !== 75) {
  throw new Error("MeetlessHost installer exclusion marker was present without the kernel lock");
}
await writeFile(exclusionPath, `${JSON.stringify({ role: "installer", pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
const sourceHash = await hostSourceHash();

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
    transcriptionSocket: config.paths.transcriptionSocket,
    transcriptionStaging: config.paths.transcriptionStaging,
    nodePath: process.execPath,
    runtimeCliPath: path.join(repositoryRoot, "packages/runtime/dist/cli.js"),
    identityPath,
  }, null, 2)}\n`, { mode: 0o644 });
  await execFileAsync("xcrun", [
    "swiftc",
    "-O",
    "-framework",
    "AppKit",
    "-framework",
    "Security",
    path.join(repositoryRoot, "native/macos-host/MeetlessHost.swift"),
    path.join(repositoryRoot, "native/macos-host/TranscriptionCapability.swift"),
    path.join(repositoryRoot, "native/macos-host/main.swift"),
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
    "native/macos-host/TranscriptionCapability.swift",
    "native/macos-host/main.swift",
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
