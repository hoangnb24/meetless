import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_SOURCE_EXCLUDED_PATHS,
  PACKAGE_SOURCE_MODE,
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
} from "./candidate-snapshot.mjs";
import { digestManifest, validateMacOSPackage } from "./validate-macos-package.mjs";
import { enumeratePackageEntries, inspectMachO, inspectPackageMachOEntries } from "./lib/macos-package-inventory.mjs";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  writeMacOSLicenseInventory,
} from "./lib/macos-license-inventory.mjs";
import { collectMacOSPackageInputs } from "./lib/macos-package-inputs.mjs";
import {
  buildSigningOrder,
  codesignArguments,
  collectMacOSSignatureEvidence,
  createSigningMetadata,
  parseSigningArguments,
  resolveSigningInputs,
  validateApprovedEntitlementMachOEntries,
} from "./lib/macos-package-signing.mjs";
import {
  MACOS_PACKAGE_SCHEMA,
  MACOS_PACKAGE_INSTALL_PATH,
  installationContractBytes,
  packagedHostConfiguration,
  packagedMarker,
} from "./lib/macos-package-contract.mjs";
import {
  parseMacOSProofRootArguments,
  resolveMacOSDmgPaths,
} from "./lib/macos-dmg-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { proofRoot, remainingArguments } = parseMacOSProofRootArguments(process.argv.slice(2));
const packagePaths = resolveMacOSDmgPaths(repositoryRoot, { proofRoot });
const releaseRoot = packagePaths.releaseRoot;
const bundlePath = path.join(releaseRoot, "Meetless.app");
const contentsPath = path.join(bundlePath, "Contents");
const packageRoot = path.join(contentsPath, "Resources", "meetless");
const manifestPath = path.join(releaseRoot, "composition-manifest.json");
const pinnedPaseoCommit = "c81cb84735043c281a5a2d23d456d3708ce5d94e";
const canonicalBundlePath = MACOS_PACKAGE_INSTALL_PATH;

const signingArguments = parseSigningArguments(remainingArguments, { requireMode: true });
if (signingArguments.signingMode === "local-ad-hoc" && !proofRoot) {
  throw new Error("local/ad-hoc package proof requires --proof-root outside repository release/macos; refusing to mutate release/macos");
}

const localPackages = [
  ["@meetless/runtime", "packages/runtime", ["dist"], []],
  ["@meetless/meeting-contracts", "packages/meeting-contracts", ["dist"], []],
  ["@meetless/meeting-domain", "packages/meeting-domain", ["dist"], []],
  ["@meetless/meeting-store", "packages/meeting-store", ["dist"], []],
  ["@meetless/client", "packages/meetless-client", ["dist"], []],
  ["@meetless/plugin", "packages/meetless-plugin", ["dist", "src"], ["index.tsx", "paseo-plugin.json"]],
  ["@getpaseo/highlight", "vendor/paseo/packages/highlight", ["dist"], []],
  ["@paseo/plugin", "vendor/paseo/packages/plugin", ["dist"], []],
  ["@getpaseo/protocol", "vendor/paseo/packages/protocol", ["dist"], []],
  ["@getpaseo/relay", "vendor/paseo/packages/relay", ["dist"], []],
  ["@getpaseo/client", "vendor/paseo/packages/client", ["dist"], []],
  ["@getpaseo/server", "vendor/paseo/packages/server", ["dist"], []],
  ["@getpaseo/cli", "vendor/paseo/packages/cli", ["dist", "bin"], []],
  ["@getpaseo/desktop", "vendor/paseo/packages/desktop", ["dist", "assets"], []],
];

await main(signingArguments);

async function main(rawSigningOptions) {
  assertDarwinArm64();
  const signingInputs = await resolveSigningInputs({
    mode: rawSigningOptions.signingMode,
    signingIdentity: rawSigningOptions.signingIdentity,
    entitlementsPath: rawSigningOptions.entitlementsPath,
    expectedTeamId: rawSigningOptions.expectedTeamId,
    repositoryRoot,
  });
  const paseoCommit = await gitPaseoCommit();
  if (paseoCommit !== pinnedPaseoCommit) {
    throw new Error(`Paseo package source is ${paseoCommit}; expected accepted commit ${pinnedPaseoCommit}`);
  }
  await requireBuildOutputs();
  const candidateSnapshot = await readCandidateSnapshot();
  await rm(bundlePath, { recursive: true, force: true });
  await rm(manifestPath, { force: true });
  await mkdir(releaseRoot, { recursive: true });

  await createHostBundle();
  await createRuntimeTree(paseoCommit);
  const mediaSources = await createMediaClosure();
  await createElectronRuntime();
  await createPackageDependencies();
  await createNotices(mediaSources);
  await normalizePackageMachOLoadPaths();
  const finalMachOEntries = await enumerateFinalMachOEntries(signingInputs.entitlementPolicy);
  const signingOrder = buildSigningOrder(finalMachOEntries);
  await signMachOClosure(signingInputs, signingOrder);
  const packageInputCollection = await collectMacOSPackageInputs({
    repositoryRoot,
    bundlePath,
    candidateSnapshot,
    mediaSources,
  });
  const licenseInventory = await writeMacOSLicenseInventory({
    bundlePath,
    repositoryRoot,
    candidateSnapshot,
    packageInputManifest: packageInputCollection.manifest,
    packageMetadata: packageInputCollection.packageMetadata,
    mediaSources,
  });
  await signBundle(signingInputs);
  const signatureEvidence = await collectMacOSSignatureEvidence({
    bundlePath,
    machoPaths: signingOrder.nestedMachO,
    machoEntries: finalMachOEntries,
    outerPath: signingOrder.outer,
    verify: true,
    requireCertificateEvidence: signingInputs.mode === "release",
  });
  const signing = createSigningMetadata({
    mode: signingInputs.mode,
    requestedIdentity: signingInputs.requestedIdentity,
    resolvedIdentity: signingInputs.resolvedIdentity,
    certificateFingerprint: signingInputs.certificateFingerprint,
    certificateSha1: signingInputs.certificateSha1,
    expectedTeamId: signingInputs.expectedTeamId,
    resolvedTeamId: signingInputs.resolvedTeamId,
    entitlementPolicy: signingInputs.entitlementPolicy,
    order: signatureEvidence.order,
    outer: signatureEvidence.outer,
    nestedMachO: signatureEvidence.nestedMachO,
  });

  const manifest = await createCompositionManifest(paseoCommit, candidateSnapshot, licenseInventory, packageInputCollection.manifest, signing);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const validation = await validateMacOSPackage(manifestPath, {
    repositoryRoot,
    signingMode: signingInputs.mode,
    signingIdentity: signingInputs.requestedIdentity,
    expectedTeamId: signingInputs.expectedTeamId,
    disposableProof: Boolean(proofRoot),
  });
  process.stdout.write(`${JSON.stringify({
    status: "candidate",
    target: "macos-arm64",
    bundlePath,
    manifestPath,
    artifactDigest: validation.artifactDigest,
    entries: validation.entries,
    macho: validation.macho,
    signingMode: signing.mode,
    localOnly: signing.localOnly,
    releaseAcceptance: signing.distribution.releaseAcceptance,
    notarization: signing.distribution.notarization,
    proofRoot,
    canonicalBundlePath,
  }, null, 2)}\n`);
}

function assertDarwinArm64() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`M7 macOS package requires darwin arm64, received ${process.platform} ${process.arch}`);
  }
}

async function requireBuildOutputs() {
  const required = [
    "packages/runtime/dist/cli.js",
    "packages/runtime/dist/meetless-process-argv",
    "packages/meetless-app/dist/index.html",
    "packages/meetless-plugin/index.tsx",
    "vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js",
    "vendor/paseo/packages/desktop/dist/main.js",
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    "native/macos-capture/.build/release/meetless-capture",
  ];
  for (const relative of required) await requireRegularFile(path.join(repositoryRoot, relative), relative);
}

async function readCandidateSnapshot() {
  const result = await run(process.execPath, [path.join(repositoryRoot, "scripts", "candidate-snapshot.mjs"), "--mode=package-source"]);
  const snapshot = JSON.parse(result.stdout);
  if (
    snapshot.mode !== PACKAGE_SOURCE_MODE ||
    snapshot.excludedPaths?.join("\0") !== PACKAGE_SOURCE_EXCLUDED_PATHS.join("\0") ||
    !/^[a-f0-9]{64}$/u.test(snapshot.digest ?? "")
  ) {
    throw new Error("Canonical candidate snapshot did not return a SHA-256 digest");
  }
  if (snapshot.head !== await gitCommit()) {
    throw new Error(`Canonical candidate snapshot HEAD ${snapshot.head} differs from the package source HEAD`);
  }
  if (snapshot.dependencyArtifacts?.paseo?.expectedCommit !== pinnedPaseoCommit) {
    throw new Error("Canonical candidate snapshot does not bind the accepted Paseo commit");
  }
  return snapshot;
}

async function createHostBundle() {
  const executable = path.join(contentsPath, "MacOS", "MeetlessHost");
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o755 });
  await mkdir(path.join(contentsPath, "Resources"), { recursive: true, mode: 0o755 });
  await cp(path.join(repositoryRoot, "native/macos-host/Info.plist"), path.join(contentsPath, "Info.plist"));
  await writeFile(
    path.join(contentsPath, "Resources", "host-config.json"),
    `${JSON.stringify(packagedHostConfiguration(), null, 2)}\n`,
    { mode: 0o644 },
  );
  await run("xcrun", [
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
  await chmod(executable, 0o755);
}

async function createRuntimeTree(paseoCommit) {
  await mkdir(packageRoot, { recursive: true, mode: 0o755 });
  const packagedNode = path.join(packageRoot, "runtime", "node");
  const packagedCaptureHelper = path.join(packageRoot, "native", "macos-capture", "meetless-capture");
  await copyFileIfPresent(process.execPath, packagedNode);
  await chmod(packagedNode, 0o755);
  await copyFileIfPresent(
    "native/macos-capture/.build/release/meetless-capture",
    packagedCaptureHelper,
  );
  await writeFile(
    path.join(packageRoot, "installation-contract.json"),
    installationContractBytes(),
    { mode: 0o644 },
  );
  await chmod(packagedCaptureHelper, 0o755);
  await copyFilteredTree(
    path.join(repositoryRoot, "packages/meetless-app/dist"),
    path.join(packageRoot, "packages/meetless-app/dist"),
    sourceFilter,
  );
  await copyFileIfPresent("scripts/electron-bootstrap.mjs", path.join(packageRoot, "scripts/electron-bootstrap.mjs"));
  await copyFileIfPresent("scripts/launch-macos-host.mjs", path.join(packageRoot, "scripts/launch-macos-host.mjs"));
  await copyFileIfPresent("scripts/stop-macos-host.mjs", path.join(packageRoot, "scripts/stop-macos-host.mjs"));

  for (const [, sourceRelative, directories, files] of localPackages) {
    const sourceRoot = path.join(repositoryRoot, sourceRelative);
    const targetRoot = path.join(packageRoot, sourceRelative);
    await mkdir(targetRoot, { recursive: true, mode: 0o755 });
    await copyFileIfPresent(path.join(sourceRelative, "package.json"), path.join(targetRoot, "package.json"));
    for (const file of files) await copyFileIfPresent(path.join(sourceRelative, file), path.join(targetRoot, file));
    for (const directory of directories) {
      const sourceDirectory = path.join(sourceRoot, directory);
      if (await exists(sourceDirectory)) await copyFilteredTree(sourceDirectory, path.join(targetRoot, directory), sourceFilter);
    }
  }

  await copyFilteredTree(
    path.join(repositoryRoot, "packages/runtime/dist"),
    path.join(packageRoot, "packages/runtime/dist"),
    sourceFilter,
  );
  await copyFileIfPresent("vendor/paseo/LICENSE", path.join(packageRoot, "notices", "Paseo-LICENSE"));
  await copyFileIfPresent(
    "vendor/paseo/packages/expo-two-way-audio/LICENSE",
    path.join(packageRoot, "notices", "expo-two-way-audio-LICENSE"),
  );

  const marker = packagedMarker({ paseoCommit });
  await writeFile(path.join(packageRoot, "meetless-package.json"), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
}

async function createPackageDependencies() {
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const localNames = new Set(localPackages.map(([name]) => name));
  const dependencies = new Map();
  for (const [, sourceRelative] of localPackages) {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, sourceRelative, "package.json"), "utf8"));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name] of Object.entries(packageJson[section] ?? {})) {
        if (localNames.has(name)) continue;
        const locked = lock.packages?.[`node_modules/${name}`];
        if (!locked?.version) throw new Error(`No root lock entry for packaged dependency ${name}`);
        const previous = dependencies.get(name);
        if (previous && previous !== locked.version) {
          throw new Error(`Packaged dependency ${name} resolves to both ${previous} and ${locked.version}`);
        }
        dependencies.set(name, locked.version);
      }
    }
  }
  for (const name of ["unzip-crx-3"]) {
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked?.version) throw new Error(`No root lock entry for packaged runtime dependency ${name}`);
    dependencies.set(name, locked.version);
  }
  const packageJson = {
    name: "meetless-macos-runtime",
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: Object.fromEntries([...dependencies.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });
  await run("npm", [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
  ], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_arch: "arm64", npm_config_platform: "darwin" },
  });
  await rm(path.join(packageRoot, "node_modules", ".package-lock.json"), { force: true });
  for (const [name, sourceRelative] of localPackages) {
    const link = path.join(packageRoot, "node_modules", ...name.split("/"));
    const target = path.join(packageRoot, sourceRelative);
    await mkdir(path.dirname(link), { recursive: true, mode: 0o755 });
    await rm(link, { recursive: true, force: true });
    await symlink(path.relative(path.dirname(link), target), link, "dir");
  }
  await pruneNonArm64MachO(path.join(packageRoot, "node_modules"));
}

async function createElectronRuntime() {
  const source = path.join(repositoryRoot, "node_modules/electron/dist/Electron.app");
  const target = path.join(packageRoot, "runtime/electron/Electron.app");
  await copyPath(source, target);
  const applications = await findDirectories(target, (candidate) => candidate.endsWith(".app"));
  for (const application of applications) {
    const info = path.join(application, "Contents", "Info.plist");
    if (!(await exists(info))) continue;
    const isOuter = application === target;
    const suffix = isOuter ? "" : path.basename(application, ".app").replace(/^Electron Helper(?: \((.+)\))?$/u, "$1").toLowerCase().replaceAll(" ", "-");
    const identifier = isOuter ? "com.meetless.desktop" : `com.meetless.desktop.helper${suffix ? `.${suffix}` : ""}`;
    await run("plutil", ["-replace", "CFBundleIdentifier", "-string", identifier, info]);
    for (const key of [
      "NSAudioCaptureUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSScreenCaptureUsageDescription",
      "NSCameraUsageDescription",
      "NSBluetoothAlwaysUsageDescription",
      "NSBluetoothPeripheralUsageDescription",
    ]) {
      await runOptional("plutil", ["-remove", key, info]);
    }
  }
}

async function createMediaClosure() {
  const ffmpeg = await resolveTool("MEETLESS_FFMPEG", "ffmpeg");
  const ffprobe = await resolveTool("MEETLESS_FFPROBE", "ffprobe");
  const mediaRoot = path.join(packageRoot, "runtime", "media");
  const sourceToDestination = new Map();
  const originalDependencies = new Map();
  const roots = [
    [ffmpeg, path.join(mediaRoot, "bin", "ffmpeg")],
    [ffprobe, path.join(mediaRoot, "bin", "ffprobe")],
  ];
  for (const [source, destination] of roots) await collectMedia(source, destination, sourceToDestination, originalDependencies);
  for (const [source, destination] of sourceToDestination) {
    const dependencies = originalDependencies.get(source) ?? [];
    for (const dependency of dependencies) {
      const resolved = await resolveMediaDependency(source, dependency);
      if (!resolved) continue;
      const target = sourceToDestination.get(resolved);
      if (!target) throw new Error(`Media dependency ${dependency} was not collected from ${source}`);
      const rewritten = `@loader_path/${path.relative(path.dirname(destination), target)}`;
      await run("install_name_tool", ["-change", dependency, rewritten, destination]);
    }
    for (const rpath of await readRpaths(source)) {
      if (rpath.includes("/opt/homebrew") || rpath.includes("/usr/local")) {
        await run("install_name_tool", ["-delete_rpath", rpath, destination]);
      }
    }
    if (destination.endsWith(".dylib")) {
      await run("install_name_tool", ["-id", `@loader_path/${path.basename(destination)}`, destination]);
    }
  }
  return {
    ffmpeg,
    ffprobe,
    closure: [...sourceToDestination.entries()].map(([source, destination]) => ({
      source,
      destination: path.relative(bundlePath, destination).replaceAll(path.sep, "/"),
    })).sort((left, right) => left.destination.localeCompare(right.destination)),
  };
}

async function collectMedia(source, destination, sourceToDestination, originalDependencies) {
  const resolvedSource = await realpath(source);
  if (isSystemDependency(resolvedSource)) return;
  const known = sourceToDestination.get(resolvedSource);
  if (known) return;
  await requireRegularFile(resolvedSource, "media dependency");
  const info = await run("file", [resolvedSource]);
  if (!/arm64/u.test(info.stdout) || /x86_64|i386/u.test(info.stdout)) {
    throw new Error(`Media resource is not arm64-only: ${resolvedSource}`);
  }
  sourceToDestination.set(resolvedSource, destination);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(resolvedSource, destination);
  await chmod(destination, 0o755);
  const dependencies = await readDependencies(resolvedSource);
  originalDependencies.set(resolvedSource, dependencies);
  for (const dependency of dependencies) {
    const resolvedDependency = await resolveMediaDependency(resolvedSource, dependency);
    if (!resolvedDependency) continue;
    const dependencyDestination = path.join(packageRoot, "runtime", "media", "lib", path.basename(resolvedDependency));
    await collectMedia(resolvedDependency, dependencyDestination, sourceToDestination, originalDependencies);
  }
}

async function resolveTool(environmentName, executable) {
  const configured = process.env[environmentName]?.trim();
  if (configured) return path.resolve(configured);
  const { stdout } = await run("which", [executable]);
  return path.resolve(stdout.trim());
}

async function resolveMediaDependency(owner, dependency) {
  if (isSystemDependency(dependency)) return null;
  const ownerDirectory = path.dirname(owner);
  let candidates;
  if (dependency.startsWith("/")) {
    candidates = [dependency];
  } else if (dependency.startsWith("@loader_path/")) {
    candidates = [path.resolve(ownerDirectory, dependency.slice("@loader_path/".length))];
  } else if (dependency.startsWith("@executable_path/")) {
    candidates = [path.resolve(ownerDirectory, dependency.slice("@executable_path/".length))];
  } else if (dependency.startsWith("@rpath/")) {
    candidates = (await readRpaths(owner)).map((rpath) => resolveRpath(ownerDirectory, rpath, dependency.slice("@rpath/".length)));
  } else {
    throw new Error(`Unsupported non-system media dependency ${dependency} from ${owner}`);
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return realpath(candidate);
  }
  throw new Error(`Cannot resolve media dependency ${dependency} from ${owner}`);
}

function resolveRpath(ownerDirectory, rpath, relative) {
  if (rpath.startsWith("/")) return path.resolve(rpath, relative);
  if (rpath === "@loader_path/") return path.resolve(ownerDirectory, relative);
  if (rpath.startsWith("@loader_path/")) return path.resolve(ownerDirectory, rpath.slice("@loader_path/".length), relative);
  if (rpath === "@executable_path/") return path.resolve(ownerDirectory, relative);
  if (rpath.startsWith("@executable_path/")) return path.resolve(ownerDirectory, rpath.slice("@executable_path/".length), relative);
  throw new Error(`Unsupported media LC_RPATH ${rpath}`);
}

async function readDependencies(binary) {
  const { stdout } = await run("otool", ["-L", binary]);
  return stdout.split("\n").slice(1).map((line) => line.trim().split(" (")[0]).filter(Boolean);
}

async function readRpaths(binary) {
  const { stdout } = await run("otool", ["-l", binary]);
  return [...stdout.matchAll(/^\s*path\s+(.+?)\s+\(offset\s+\d+\)/gmu)].map((match) => match[1]);
}

function isSystemDependency(candidate) {
  return candidate.startsWith("/System/Library/") || candidate.startsWith("/usr/lib/") || candidate.startsWith("/System/iOSSupport/");
}

async function signBundle(signingInputs) {
  await run("codesign", codesignArguments({
    mode: signingInputs.mode,
    identity: signingInputs.identity,
    target: bundlePath,
    identifier: "com.meetless.app",
    outer: true,
  }));
  await run("codesign", ["--verify", "--deep", "--strict", bundlePath]);
}

async function signMachOClosure(signingInputs, signingOrder) {
  if (signingOrder.nestedMachO.length === 0) throw new Error("Final package contains no Mach-O files to sign");
  for (const relativePath of signingOrder.nestedMachO) {
    await run("codesign", [
      ...codesignArguments({
        mode: signingInputs.mode,
        identity: signingInputs.identity,
        target: path.join(bundlePath, relativePath),
        identifier: machOSignatureIdentifier(relativePath),
        entitlementsPath: signingInputs.entitlementPolicy?.entries.find((entry) => entry.path === relativePath)?.absolutePath ?? null,
        outer: false,
      }),
    ]);
  }
}

async function enumerateFinalMachOEntries(entitlementPolicy) {
  const entries = await enumeratePackageEntries(bundlePath);
  const machos = await inspectPackageMachOEntries(bundlePath, entries);
  if (machos.length === 0) throw new Error("Final package contains no Mach-O files to sign");
  validateApprovedEntitlementMachOEntries({ entries, machoEntries: machos, policy: entitlementPolicy });
  return machos;
}

function machOSignatureIdentifier(relativePath) {
  return `com.meetless.package.macho.${sha256(Buffer.from(relativePath)).slice(0, 16)}`;
}

async function createNotices(mediaSources) {
  const noticeRoot = path.join(packageRoot, "notices");
  await mkdir(noticeRoot, { recursive: true, mode: 0o755 });
  const authority = "docs/decisions/0001-maintained-paseo-fork.md";
  await writeFile(
    path.join(noticeRoot, "LICENSE-REVIEW-UNRESOLVED.txt"),
    [
      "Meetless M7 technical package license review is unresolved.",
      `Authority: ${authority}`,
      "This directory contains available upstream license files only.",
      "It is not a license clearance or distribution approval.",
      "Unresolved inventory: Paseo AGPL-3.0-or-later obligations; lock license metadata gaps; native capture, models, bundled ffmpeg, and dynamic-library notices.",
      "Distribution, notarization, update publication, and clean-install acceptance remain external gates.",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  await copyFileIfPresent(
    path.resolve(path.dirname(process.execPath), "..", "LICENSE"),
    path.join(noticeRoot, "Node-LICENSE"),
  );
  await copyFileIfPresent("node_modules/electron/LICENSE", path.join(noticeRoot, "Electron-LICENSE"));
  await copyFileIfPresent(
    "node_modules/electron/dist/LICENSES.chromium.html",
    path.join(noticeRoot, "Chromium-LICENSES.html"),
  );
  const mediaBinary = mediaSources?.ffmpeg ? await realpath(mediaSources.ffmpeg).catch(() => mediaSources.ffmpeg) : null;
  const mediaRoot = mediaBinary ? path.resolve(path.dirname(mediaBinary), "..") : null;
  for (const name of ["LICENSE.md", "COPYING.LGPLv2.1", "COPYING.LGPLv3", "COPYING.GPLv2", "COPYING.GPLv3"]) {
    if (mediaRoot) await copyFileIfPresent(path.join(mediaRoot, name), path.join(noticeRoot, `FFmpeg-${name}`));
  }
}

async function normalizePackageMachOLoadPaths() {
  const entries = await enumeratePackageEntries(bundlePath);
  const machos = await inspectPackageMachOEntries(bundlePath, entries);
  for (const entry of machos) {
    const binary = path.join(bundlePath, entry.path);
    const inspected = await inspectMachO(binary);
    if (!inspected) throw new Error(`Mach-O disappeared during package load-path normalization: ${entry.path}`);
    for (const rpath of inspected.rpaths) {
      if (rpath.startsWith("/") && !isSystemDependency(rpath)) {
        await run("install_name_tool", ["-delete_rpath", rpath, binary]);
      } else if (
        !rpath.startsWith("/") &&
        !rpath.startsWith("@loader_path") &&
        !rpath.startsWith("@executable_path")
      ) {
        throw new Error(`Unsupported package LC_RPATH ${rpath} in ${entry.path}`);
      }
    }
    for (const dependency of inspected.dependencies) {
      if (dependency.startsWith("/") && !isSystemDependency(dependency)) {
        throw new Error(`External package Mach-O dependency ${dependency} in ${entry.path}`);
      }
      if (dependency.startsWith("./") || dependency.startsWith("../")) {
        const oldName = dependency.replace(/^\.\//u, "");
        await run("install_name_tool", ["-change", oldName, `@loader_path/${dependency}`, binary]);
      }
    }
  }
}

async function createCompositionManifest(paseoCommit, candidateSnapshot, licenseInventory, packageInputManifest, signing) {
  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries);
  const rendererEntryPath = "Contents/Resources/meetless/packages/meetless-app/dist/index.html";
  const rendererEntry = entries.find((entry) => entry.path === rendererEntryPath && entry.type === "file");
  if (!rendererEntry) throw new Error(`Packaged renderer entry is missing from the composition: ${rendererEntryPath}`);
  const macho = machoEntries.map((entry) => entry.path);
  const requiredFiles = [
    "Contents/Info.plist",
    "Contents/MacOS/MeetlessHost",
    "Contents/Resources/host-config.json",
    "Contents/Resources/meetless/installation-contract.json",
    "Contents/Resources/meetless/meetless-package.json",
    "Contents/Resources/meetless/packages/meetless-app/dist/index.html",
    "Contents/Resources/meetless/packages/runtime/dist/cli.js",
    "Contents/Resources/meetless/packages/runtime/dist/meetless-process-argv",
    "Contents/Resources/meetless/packages/meetless-plugin/index.tsx",
    "Contents/Resources/meetless/packages/meetless-plugin/paseo-plugin.json",
    "Contents/Resources/meetless/vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js",
    "Contents/Resources/meetless/runtime/node",
    "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
    "Contents/Resources/meetless/runtime/media/bin/ffmpeg",
    "Contents/Resources/meetless/runtime/media/bin/ffprobe",
    "Contents/Resources/meetless/native/macos-capture/meetless-capture",
  ];
  const manifest = {
    schema: MACOS_PACKAGE_SCHEMA,
    target: "macos-arm64",
    bundlePath: "Meetless.app",
    packageRoot: "Contents/Resources/meetless",
    packageMarker: "Contents/Resources/meetless/meetless-package.json",
    sourceCommit: await gitCommit(),
    paseoCommit,
    candidateSnapshot: {
      command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
      mode: candidateSnapshot.mode,
      excludedPaths: candidateSnapshot.excludedPaths,
      digest: candidateSnapshot.digest,
      head: candidateSnapshot.head,
      paseoCommit: candidateSnapshot.dependencyArtifacts.paseo.expectedCommit,
    },
    host: {
      bundleIdentifier: "com.meetless.app",
      canonicalPath: canonicalBundlePath,
      tccOwner: "sole Meetless host",
    },
    resources: {
      rendererRoot: "Contents/Resources/meetless/packages/meetless-app/dist",
      runtimeRoot: "Contents/Resources/meetless",
      electronBinary: "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
      nodeBinary: "Contents/Resources/meetless/runtime/node",
      captureHelper: "Contents/Resources/meetless/native/macos-capture/meetless-capture",
      ffmpeg: "Contents/Resources/meetless/runtime/media/bin/ffmpeg",
      ffprobe: "Contents/Resources/meetless/runtime/media/bin/ffprobe",
    },
    renderer: {
      entry: rendererEntryPath,
      sha256: rendererEntry.sha256,
      size: rendererEntry.size,
    },
    packageInputs: packageInputManifest,
    proof: proofRoot
      ? { mode: "local-ad-hoc-disposable", rootRelativePath: "release/macos" }
      : { mode: "repository-release", rootRelativePath: "release/macos" },
    signing,
    licenseInventory: createLicenseInventoryManifestBinding(entries, licenseInventory),
    notices: entries.filter((entry) => entry.path.includes("/notices/")).map((entry) => entry.path),
    licenseReview: {
      status: "unresolved",
      authority: "docs/decisions/0001-maintained-paseo-fork.md",
      unresolved: [
        "Paseo AGPL-3.0-or-later obligations",
        `Current lock license metadata gaps: ${licenseInventory.summary.lockMetadataGapCount}; historical authority value: ${licenseInventory.summary.historicalAuthorityLockMetadataGapCount}; reconciliation remains unresolved`,
        "native capture, models, bundled ffmpeg, and dynamic-library notices",
      ],
    },
    requiredFiles,
    macho,
    entries,
  };
  manifest.artifactDigest = digestManifest({ ...manifest, artifactDigest: undefined });
  return manifest;
}

function createLicenseInventoryManifestBinding(entries, inventory) {
  const entry = entries.find((candidate) => candidate.path === MACOS_LICENSE_INVENTORY_PATH && candidate.type === "file");
  if (!entry) throw new Error(`Packaged license inventory entry is missing from the composition: ${MACOS_LICENSE_INVENTORY_PATH}`);
  return {
    schema: inventory.schema,
    path: MACOS_LICENSE_INVENTORY_PATH,
    sha256: entry.sha256,
    artifactEntryDigest: inventory.artifact.entryBinding.digest,
    excludedPathPrefixes: inventory.artifact.entryBinding.excludedPathPrefixes,
    excludedPaths: inventory.artifact.entryBinding.excludedPaths,
    componentCount: inventory.components.length,
    packageInputDigest: inventory.artifact.packageInputBinding.digest,
    packageInputArtifactDigest: inventory.artifact.packageInputBinding.artifactInputDigest,
  };
}

async function copyFileIfPresent(sourceRelative, destination) {
  const source = path.isAbsolute(sourceRelative) ? sourceRelative : path.join(repositoryRoot, sourceRelative);
  if (!(await exists(source))) return;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination);
}

async function copyPath(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

async function copyFilteredTree(source, destination, filter) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, { recursive: true, filter });
}

function sourceFilter(candidate) {
  return !candidate.endsWith(".map") && !candidate.endsWith(".d.ts") && !candidate.endsWith(".tsbuildinfo");
}

async function findDirectories(root, predicate) {
  const found = [];
  async function visit(candidate) {
    const inspected = await lstat(candidate);
    if (!inspected.isDirectory()) return;
    if (predicate(candidate)) found.push(candidate);
    for (const name of await readdir(candidate)) await visit(path.join(candidate, name));
  }
  await visit(root);
  return found;
}

async function pruneNonArm64MachO(root) {
  for (const candidate of await findFiles(root)) {
    if (!candidate.endsWith(".node") && !candidate.includes(`${path.sep}prebuilds${path.sep}`)) continue;
    const result = await run("file", [candidate]);
    if (/Mach-O/u.test(result.stdout) && (!/arm64/u.test(result.stdout) || /x86_64|i386/u.test(result.stdout))) {
      await rm(candidate, { force: true });
    }
  }
}

async function findFiles(root) {
  const found = [];
  async function visit(candidate) {
    const inspected = await lstat(candidate);
    if (inspected.isSymbolicLink()) return;
    if (inspected.isFile()) {
      found.push(candidate);
      return;
    }
    if (!inspected.isDirectory()) return;
    for (const name of await readdir(candidate)) await visit(path.join(candidate, name));
  }
  await visit(root);
  return found;
}

async function requireRegularFile(candidate, label) {
  const inspected = await stat(candidate).catch(() => null);
  if (!inspected?.isFile()) throw new Error(`Required ${label} is missing: ${candidate}`);
}

async function exists(candidate) {
  return (await lstat(candidate).catch(() => null)) !== null;
}

async function run(command, arguments_, options = {}) {
  const result = await execFileAsync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  return result;
}

async function runOptional(command, arguments_) {
  try {
    await run(command, arguments_);
  } catch {
    // Missing optional plist keys are expected when scrubbing nested helper identities.
  }
}

async function gitCommit() {
  return (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
}

async function gitPaseoCommit() {
  return (await run("git", ["-C", path.join(repositoryRoot, "vendor/paseo"), "rev-parse", "HEAD"])).stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
