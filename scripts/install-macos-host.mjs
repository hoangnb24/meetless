import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  hostIdentityEquals,
  inspectHostBundle,
  trustedHostInspectionContext,
} from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";
import {
  finalizePackageTransaction,
  newPackageTransactionId,
  packageTransactionPaths,
  recoverPackageTransaction,
  replacePackageBundle,
} from "./lib/macos-package-transaction.mjs";

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
const inspectionContext = trustedHostInspectionContext(config);
const nodePath = config.packaged ? config.packageResources?.nodeBinary : process.execPath;
if (!nodePath || (config.packaged && !path.isAbsolute(nodePath))) {
  throw new Error(
    "Cannot install MeetlessHost without the exact packaged nodeBinary from RuntimeConfig. " +
    "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. " +
    "Next action: rebuild the packaged resource manifest before installation.",
  );
}
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
const hostArtifact = await requireRevenueCatHostArtifact();

if (await exists(target)) {
  try {
    const [installed, recorded] = await Promise.all([
      inspectHostBundle(target, inspectionContext),
      readFile(identityPath, "utf8").then(JSON.parse),
    ]);
    if (hostIdentityEquals(installed, recorded) && !replace) {
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
    schema: "MEETLESS_MACOS_HOST_CONFIG v2",
    mode: "development",
    bundleIdentifier: "com.meetless.app",
    repositoryRoot,
    runtimeRoot: config.paths.root,
    listen: config.listen,
    rendererOrigin: config.rendererOrigin,
    transcriptionSocket: config.paths.transcriptionSocket,
    transcriptionStaging: config.paths.transcriptionStaging,
    nodePath,
    runtimeCliPath: path.join(repositoryRoot, "packages/runtime/dist/cli.js"),
    identityPath,
  }, null, 2)}\n`, { mode: 0o644 });
  await cp(hostArtifact, executable);
  await execFileAsync("codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.meetless.app",
    "--timestamp=none",
    bundle,
  ]);
  assertNoExactHost(target);
  const ownerToken = `MEETLESS_M7_PACKAGE_INSTALL_v1:${process.pid}:${randomUUID()}`;
  const runId = newPackageTransactionId();
  const journalPath = packageTransactionPaths(target, runId).journal;
  let transaction = null;
  try {
    try {
      transaction = await replacePackageBundle({
        source: bundle,
        target,
        identityPath,
        ownerToken,
        runId,
        inspect: (bundlePath) => inspectHostBundle(bundlePath, inspectionContext),
      });
    } catch (error) {
      if (await exists(journalPath)) transaction = JSON.parse(await readFile(journalPath, "utf8"));
      throw error;
    }
    await finalizePackageTransaction(transaction, {
      ownerToken,
      target,
      identityPath,
      assertNoLiveHost: async () => assertNoExactHost(target),
    });
    const installed = await inspectHostBundle(target, inspectionContext);
    process.stdout.write(`${JSON.stringify({ status: replace ? "replaced" : "installed", sourceHash, ...installed }, null, 2)}\n`);
  } catch (error) {
    if (transaction && await exists(journalPath)) {
      await recoverPackageTransaction(journalPath, {
        ownerToken,
        target,
        identityPath,
        assertNoLiveHost: async () => assertNoExactHost(target),
      }).catch((recoveryError) => {
        throw new Error(`${describe(error)}; package transaction recovery failed closed: ${describe(recoveryError)}`);
      });
    }
    throw error;
  }
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

async function hostSourceHash() {
  const files = [
    "native/macos-host/Info.plist",
    "native/macos-host/Package.swift",
    "native/macos-host/Package.resolved",
    "native/macos-host/MeetlessHost.swift",
    "native/macos-host/RevenueCatCapability.swift",
    "native/macos-host/TranscriptionCapability.swift",
    "native/macos-host/host-entry/main.swift",
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(await readFile(path.join(repositoryRoot, file)));
  return hash.digest("hex");
}

async function requireRevenueCatHostArtifact() {
  const candidate = path.join(repositoryRoot, "native/macos-host/.build/release/MeetlessHost");
  const inspected = await stat(candidate).catch(() => null);
  if (!inspected?.isFile()) {
    throw new Error(
      `Required SwiftPM RevenueCat-linked host artifact is missing at ${candidate}. ` +
      "Run npm run build:native before installing the host.",
    );
  }
  const { stdout: fileOutput } = await execFileAsync("file", [candidate]);
  if (!/Mach-O 64-bit executable arm64/u.test(fileOutput)) {
    throw new Error(`Required host artifact is not an arm64 Mach-O executable: ${candidate}`);
  }
  const { stdout: symbols } = await execFileAsync("nm", ["-gU", candidate], { maxBuffer: 16 * 1024 * 1024 });
  if (!/\$s10RevenueCat/u.test(symbols)) {
    throw new Error(
      `Required host artifact has no linked RevenueCat symbols: ${candidate}. ` +
      "Refusing to install the #else not_configured fallback.",
    );
  }
  return candidate;
}

async function exists(candidate) {
  try { await stat(candidate); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertNoExactHost(bundlePath) {
  const executablePath = path.join(bundlePath, "Contents", "MacOS", "MeetlessHost");
  const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) throw new Error("Cannot inspect the exact MeetlessHost process before replacement");
  const matches = inspected.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match?.[3] === executablePath ? [Number(match[1])] : [];
  });
  if (matches.length > 0) throw new Error(`Refusing to replace a live exact MeetlessHost: ${matches.join(", ")}`);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
