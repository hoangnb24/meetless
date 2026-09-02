import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  enumeratePackageEntries,
  inspectPackageMachOEntries,
} from "./macos-package-inventory.mjs";
import {
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
} from "../candidate-snapshot.mjs";

export const MACOS_LICENSE_INVENTORY_SCHEMA = "MEETLESS_MACOS_LICENSE_INVENTORY v2";
export const MACOS_LICENSE_INVENTORY_PATH = "Contents/Resources/meetless/notices/license-inventory.json";
export const MACOS_LICENSE_INVENTORY_MANIFEST_PATH = "release/macos/composition-manifest.json";
export const MACOS_LICENSE_INVENTORY_AUTHORITY = "docs/decisions/0001-maintained-paseo-fork.md";
export const MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES = ["Contents/_CodeSignature/"];
export const MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS = [MACOS_LICENSE_INVENTORY_PATH];

export const REQUIRED_LICENSE_COMPONENTS = [
  "meetless",
  "paseo",
  "js-closure",
  "electron-chromium",
  "node",
  "native-binaries",
  "capture-helper",
  "ffmpeg-media",
  "sherpa-model-assets",
  "fonts-assets",
  "unzip-crx-3",
];

const NATIVE_NPM_PACKAGES = new Set([
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "@esbuild/darwin-arm64",
  "node-pty",
]);

const AUTHORITY_ACTION =
  "Human/legal owner review must decide the required notice, Corresponding Source, build/install, and AGPL network-interaction obligations before binary release";

export async function writeMacOSLicenseInventory(options) {
  const inventory = await buildMacOSLicenseInventory(options);
  const inventoryPath = path.join(options.bundlePath, MACOS_LICENSE_INVENTORY_PATH);
  await mkdir(path.dirname(inventoryPath), { recursive: true, mode: 0o755 });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
  return inventory;
}

export async function buildMacOSLicenseInventory({ bundlePath, repositoryRoot, candidateSnapshot, packageInputManifest, packageMetadata, mediaSources }) {
  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries);
  const machoPaths = new Set(machoEntries.map((entry) => entry.path));
  const plannedEntries = [...new Map(entries.concat([
    { path: MACOS_LICENSE_INVENTORY_PATH, type: "file", size: 0, sha256: "0".repeat(64) },
    { path: "Contents/_CodeSignature/CodeResources", type: "file", size: 0, sha256: "0".repeat(64) },
  ]).map((entry) => [entry.path, entry])).values()];
  const componentPaths = new Map(REQUIRED_LICENSE_COMPONENTS.map((id) => [id, []]));
  const overlapRules = [];
  for (const entry of plannedEntries) {
    const component = classifyArtifactPath(entry.path, entry, machoPaths);
    if (!componentPaths.has(component)) componentPaths.set(component, []);
    componentPaths.get(component).push(entry.path);
  }

  const unresolvedPaths = componentPaths.get("unresolved") ?? [];
  if (unresolvedPaths.length) {
    throw new Error(
      `artifact path ${unresolvedPaths[0]} has no accepted component/provenance mapping; Authority: ${MACOS_LICENSE_INVENTORY_AUTHORITY}. Next action: add an inspected packaging rule before building the release inventory`,
    );
  }

  const excludedPaths = [...new Set([MACOS_LICENSE_INVENTORY_PATH, ...machoPaths])].sort((left, right) => left.localeCompare(right));
  const actualEntryDigest = digestArtifactEntries(entries, { excludedPaths });
  const packageRoot = path.join(bundlePath, "Contents", "Resources", "meetless");
  const workspaceMembers = await collectWorkspaceMembers(bundlePath);
  const metadata = packageMetadata ?? await collectMacOSPackageMetadata(packageRoot, repositoryRoot, workspaceMembers);
  const components = await buildComponents({
    componentPaths,
    entries: plannedEntries,
    excludedPaths,
    machoPaths,
    packageMetadata: metadata,
    repositoryRoot,
    candidateSnapshot,
    bundlePath,
    mediaSources,
  });
  const discoveredOverlapRules = buildOverlapRules(componentPaths, overlapRules);
  const inventory = {
    schema: MACOS_LICENSE_INVENTORY_SCHEMA,
    authority: MACOS_LICENSE_INVENTORY_AUTHORITY,
    target: "macos-arm64",
    artifact: {
      bundlePath: "Meetless.app",
      manifestPath: MACOS_LICENSE_INVENTORY_MANIFEST_PATH,
      inventoryPath: MACOS_LICENSE_INVENTORY_PATH,
      candidateSnapshot: snapshotBinding(candidateSnapshot),
      entryBinding: {
        algorithm: "sha256",
        digest: actualEntryDigest,
        excludedPathPrefixes: MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES,
        excludedPaths,
        explanation: "The signing CodeResources file, self-referential inventory, and Mach-O code signatures are cross-bound by the composition manifest; repeated ad-hoc signing rewrites Mach-O signature bytes.",
      },
      packageInputBinding: packageInputBinding(packageInputManifest),
    },
    overlapRules: discoveredOverlapRules,
    components,
    unresolvedOwnerDecisions: components
      .filter((component) => component.ownerDecision.required && component.ownerDecision.status !== "resolved")
      .map((component) => ({
        component: component.id,
        artifactPathCount: component.artifactPathScope.paths.length,
        nextAction: component.ownerDecision.nextAction,
      })),
    summary: {
      artifactEntryCount: new Set(plannedEntries.map((entry) => entry.path)).size,
      componentCount: components.length,
      componentPathCounts: Object.fromEntries(components.map((component) => [component.id, component.artifactPathScope.paths.length])),
      packageMemberCount: metadata.members.length,
      packageMemberDigest: digestJson([...metadata.members].sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath))),
      workspaceMemberCount: metadata.workspaceMembers.length,
      workspaceMemberDigest: digestJson([...metadata.workspaceMembers].sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath))),
      lockMetadataGapCount: metadata.lockMetadataGaps.length,
      historicalAuthorityLockMetadataGapCount: 28,
      historicalAuthority: MACOS_LICENSE_INVENTORY_AUTHORITY,
      countRule: "All current counts are derived from this final inventory; 28 is the historical authority value and is not the current scan result.",
    },
  };

  return inventory;
}

export function classifyArtifactPath(relativePath, entry = {}, machoPaths = new Set()) {
  if (relativePath === MACOS_LICENSE_INVENTORY_PATH || relativePath === "Contents/_CodeSignature/CodeResources") {
    return "meetless";
  }
  if (relativePath === "Contents/Resources/meetless/notices/Node-LICENSE") return "node";
  if (relativePath.startsWith("Contents/Resources/meetless/notices/Electron-") || relativePath.startsWith("Contents/Resources/meetless/notices/Chromium-")) return "electron-chromium";
  if (relativePath.startsWith("Contents/Resources/meetless/notices/FFmpeg-")) return "ffmpeg-media";
  if (relativePath === "Contents/Resources/meetless/native/macos-capture/meetless-capture") {
    return "capture-helper";
  }
  if (relativePath === "Contents/Resources/meetless/runtime/node") return "node";
  if (relativePath.startsWith("Contents/Resources/meetless/runtime/electron/")) return "electron-chromium";
  if (relativePath.startsWith("Contents/Resources/meetless/runtime/media/")) return "ffmpeg-media";
  if (relativePath.startsWith("Contents/Resources/meetless/node_modules/unzip-crx-3/")) return "unzip-crx-3";
  if (isNativePath(relativePath, entry, machoPaths)) return "native-binaries";
  if (isSherpaPath(relativePath)) return "sherpa-model-assets";
  if (isAssetPath(relativePath)) return "fonts-assets";
  if (isPaseoPath(relativePath, entry)) return "paseo";
  if (isMeetlessPath(relativePath, entry)) return "meetless";
  if (relativePath.startsWith("Contents/Resources/meetless/node_modules/")) return "js-closure";
  if (relativePath.startsWith("Contents/Resources/meetless/")) return "meetless";
  if (relativePath.startsWith("Contents/")) return "meetless";
  return "unresolved";
}

export function resolveNpmPackageRoot(relativePath) {
  if (typeof relativePath !== "string") return null;
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const markerIndex = normalizedPath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const packageSegments = normalizedPath.slice(markerIndex + marker.length).split("/");
  const packageSegmentCount = packageSegments[0]?.startsWith("@") ? 2 : 1;
  if (
    packageSegments.length < packageSegmentCount ||
    packageSegments.slice(0, packageSegmentCount).some((segment) => !segment || segment === "." || segment === "..")
  ) return null;
  const name = packageSegments.slice(0, packageSegmentCount).join("/");
  return {
    name,
    root: `${normalizedPath.slice(0, markerIndex + marker.length)}${name}`,
  };
}

export function isNpmPackageManifestPath(relativePath) {
  const packageRoot = resolveNpmPackageRoot(relativePath);
  return packageRoot !== null && relativePath.replaceAll("\\", "/") === `${packageRoot.root}/package.json`;
}

export function isWorkspacePackageManifestPath(relativePath) {
  if (!relativePath.endsWith("/package.json")) return false;
  const workspacePrefix = relativePath.startsWith("Contents/Resources/meetless/vendor/paseo/packages/")
    ? "Contents/Resources/meetless/vendor/paseo/packages/"
    : relativePath.startsWith("Contents/Resources/meetless/packages/")
      ? "Contents/Resources/meetless/packages/"
      : null;
  if (!workspacePrefix) return false;
  const workspaceRelativePath = relativePath.slice(workspacePrefix.length, -"/package.json".length);
  return workspaceRelativePath.length > 0 && !workspaceRelativePath.includes("/");
}

export function digestArtifactEntries(entries, options = {}) {
  const excludedPaths = new Set(options.excludedPaths ?? []);
  return digestEntries(entries.filter((entry) => !isExcludedArtifactPath(entry.path) && !excludedPaths.has(entry.path)));
}

export function digestComponentEntries(entries, paths, options = {}) {
  const pathSet = new Set(paths);
  const excludedPaths = new Set(options.excludedPaths ?? []);
  return digestEntries(entries.filter((entry) => pathSet.has(entry.path) && !isExcludedArtifactPath(entry.path) && !excludedPaths.has(entry.path)));
}

export function isExcludedArtifactPath(relativePath) {
  return (
    MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS.includes(relativePath) ||
    MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function digestEntries(entries) {
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      ...(entry.type === "file" ? { size: entry.size } : { target: entry.target }),
      sha256: entry.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(JSON.stringify(canonical));
}

function isSherpaPath(relativePath) {
  return (
    relativePath.endsWith("/silero_vad.onnx") ||
    relativePath.startsWith("Contents/Resources/meetless/node_modules/sherpa-onnx-node/") ||
    relativePath.startsWith("Contents/Resources/meetless/node_modules/sherpa-onnx-darwin-arm64/")
  );
}

function isNativePath(relativePath, entry, machoPaths) {
  const packageRoot = resolveNpmPackageRoot(relativePath);
  if (packageRoot && NATIVE_NPM_PACKAGES.has(packageRoot.name)) return true;
  if (machoPaths.has(relativePath)) return true;
  if (/\.(?:dylib|dll|exe|node)$/iu.test(relativePath)) return true;
  return entry.type === "file" && relativePath.endsWith("/meetless-process-argv");
}

function isAssetPath(relativePath) {
  if (relativePath.startsWith("Contents/Resources/meetless/runtime/electron/")) return false;
  if (relativePath.endsWith("/silero_vad.onnx")) return false;
  return /\.(?:png|jpe?g|gif|webp|svg|ico|icns|ttf|otf|woff2?|eot)$/iu.test(relativePath);
}

function isPaseoPath(relativePath, entry) {
  if (relativePath === "Contents/Resources/meetless/notices/Paseo-LICENSE") return true;
  if (relativePath === "Contents/Resources/meetless/notices/expo-two-way-audio-LICENSE") return true;
  if (relativePath.startsWith("Contents/Resources/meetless/vendor/paseo/")) return true;
  return (
    relativePath.startsWith("Contents/Resources/meetless/node_modules/@getpaseo/") ||
    relativePath.startsWith("Contents/Resources/meetless/node_modules/@paseo/") ||
    (entry.type === "symlink" && typeof entry.target === "string" && entry.target.includes("vendor/paseo"))
  );
}

function isMeetlessPath(relativePath, entry) {
  if (relativePath === "Contents/Resources/meetless/notices/Node-LICENSE") return false;
  if (relativePath.startsWith("Contents/Resources/meetless/node_modules/@meetless/")) return true;
  if (relativePath.startsWith("Contents/Resources/meetless/packages/")) return true;
  if (relativePath.startsWith("Contents/Resources/meetless/scripts/")) return true;
  if (relativePath.startsWith("Contents/Resources/meetless/notices/")) return true;
  return entry.type === "symlink" && typeof entry.target === "string" && entry.target.includes("packages/");
}

async function buildComponents({ componentPaths, entries, excludedPaths, machoPaths, packageMetadata, repositoryRoot, candidateSnapshot, bundlePath, mediaSources }) {
  const context = { componentPaths, entries, excludedPaths, machoPaths, packageMetadata, repositoryRoot, candidateSnapshot, bundlePath, mediaSources };
  const components = [];
  for (const id of REQUIRED_LICENSE_COMPONENTS) components.push(await buildComponent(id, context));
  const unresolvedPaths = componentPaths.get("unresolved") ?? [];
  if (unresolvedPaths.length) components.push(await buildComponent("unresolved", context));
  return components;
}

async function buildComponent(id, context) {
  const paths = [...new Set(context.componentPaths.get(id) ?? [])].sort((left, right) => left.localeCompare(right));
  const artifactHash = digestComponentEntries(context.entries, paths, { excludedPaths: context.excludedPaths });
  const packageMetadata = context.packageMetadata;
  const base = {
    id,
    artifactPathScope: {
      kind: "exact-paths",
      count: paths.length,
      paths,
    },
    provenance: {
      sourceType: sourceType(id),
      sourcePaths: sourcePaths(id),
      versionOrHash: {
        artifactScopeSha256: artifactHash,
        ...versionOrHash(id, packageMetadata, context.candidateSnapshot),
      },
    },
    declaredLicenseEvidence: declaredLicenseEvidence(id, paths, packageMetadata),
    shippedNotice: await shippedNotice(id, paths, context),
    sourceBuildMaterial: sourceBuildMaterial(id),
    ownerDecision: {
      required: true,
      owner: "Human/legal",
      status: "unresolved",
      rule: MACOS_LICENSE_INVENTORY_AUTHORITY,
      nextAction: AUTHORITY_ACTION,
    },
  };
  const packageMembers = packageMetadata.members.filter((member) => member.component === id);
  const workspaceMembers = packageMetadata.workspaceMembers.filter((member) => member.component === id);
  if (packageMembers.length) base.provenance.packageMembers = packageMembers;
  if (workspaceMembers.length) base.provenance.workspaceMembers = workspaceMembers;
  const artifactMembers = buildArtifactMembers(id, paths, context);
  if (artifactMembers.length) base.provenance.artifactMembers = artifactMembers;
  if (id === "js-closure") {
    base.declaredLicenseEvidence.lockMetadataGaps = packageMetadata.lockMetadataGaps;
  }
  if (id === "unresolved") {
    base.provenance.sourceType = "unresolved-artifact-path";
    base.provenance.sourcePaths = [];
    base.provenance.unresolved = paths.map((artifactPath) => ({ artifactPath, reason: "No accepted component rule matched this path" }));
  }
  return base;
}

function sourceType(id) {
  if (id === "paseo") return "git-submodule-and-generated-Paseo-closure";
  if (id === "js-closure" || id === "unzip-crx-3" || id === "sherpa-model-assets") return "npm-production-closure-and-model-output";
  if (id === "electron-chromium") return "Electron-distribution-and-Chromium-runtime";
  if (id === "node") return "Node-runtime-binary";
  if (id === "ffmpeg-media") return "configured-ffmpeg-closure";
  if (id === "fonts-assets") return "packaged-static-assets";
  if (id === "capture-helper" || id === "native-binaries") return "Meetless-native-build-output-and-native-dependencies";
  return "Meetless-source-and-package-assembly";
}

function sourcePaths(id) {
  const common = ["docs/decisions/0001-maintained-paseo-fork.md", "scripts/package-macos.mjs"];
  if (id === "paseo") return [...common, "vendor/paseo", "vendor/paseo/package.json", "vendor/paseo/package-lock.json"];
  if (id === "js-closure") return [...common, "package.json", "package-lock.json"];
  if (id === "electron-chromium") return [...common, "node_modules/electron/package.json", "node_modules/electron/LICENSE", "node_modules/electron/dist/LICENSES.chromium.html"];
  if (id === "node") return [...common, "process.execPath (package builder input)"];
  if (id === "native-binaries") return [
    ...common,
    "scripts/build-native.mjs",
    "native/macos-host",
    "packages/runtime/native",
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json",
    "node_modules/@esbuild/darwin-arm64/package.json",
    "node_modules/node-pty/package.json",
  ];
  if (id === "capture-helper") return [...common, "scripts/build-native.mjs", "native/macos-capture"];
  if (id === "ffmpeg-media") return [...common, "scripts/package-macos.mjs:createMediaClosure", "MEETLESS_FFMPEG", "MEETLESS_FFPROBE"];
  if (id === "sherpa-model-assets") return [...common, "vendor/paseo/packages/server/src/server/speech/providers/local/sherpa", "vendor/paseo/packages/server/package.json", "vendor/paseo/package-lock.json"];
  if (id === "fonts-assets") return [...common, "vendor/paseo/packages/desktop/assets", "vendor/paseo/packages/desktop/package.json", "package-lock.json"];
  if (id === "unzip-crx-3") return [...common, "package-lock.json", "node_modules/unzip-crx-3/package.json"];
  return [...common, "package.json", "release/macos"];
}

function buildArtifactMembers(id, paths, context) {
  const selected = paths.filter((relativePath) => {
    if (id === "native-binaries") return context.machoPaths.has(relativePath);
    if (id === "capture-helper") return relativePath === "Contents/Resources/meetless/native/macos-capture/meetless-capture";
    if (id === "node") return relativePath === "Contents/Resources/meetless/runtime/node";
    if (id === "ffmpeg-media") return relativePath.startsWith("Contents/Resources/meetless/runtime/media/");
    if (id === "sherpa-model-assets") return relativePath.endsWith("/silero_vad.onnx");
    if (id === "fonts-assets") return isAssetPath(relativePath);
    return false;
  });
  return selected.sort((left, right) => left.localeCompare(right)).map((artifactPath) => ({
    artifactPath,
    memberType: artifactMemberType(id),
    sourcePaths: artifactMemberSourcePaths(id, artifactPath, context),
    artifactSha256: context.entries.find((entry) => entry.path === artifactPath)?.sha256 ?? null,
  }));
}

function artifactMemberType(id) {
  if (id === "native-binaries" || id === "capture-helper") return "native-binary";
  if (id === "node") return "runtime-binary";
  if (id === "ffmpeg-media") return "media-binary";
  if (id === "sherpa-model-assets") return "model-asset";
  if (id === "fonts-assets") return "static-asset";
  return "artifact-member";
}

function artifactMemberSourcePaths(id, artifactPath, context) {
  const packageRoot = resolveNpmPackageRoot(artifactPath);
  const packageSource = packageRoot?.root.replace("Contents/Resources/meetless/", "");
  if (id === "native-binaries") {
    if (artifactPath === "Contents/MacOS/MeetlessHost") return ["native/macos-host"];
    if (artifactPath.endsWith("/meetless-process-argv")) return ["packages/runtime/native/process-argv.swift"];
    if (packageSource) return [packageSource];
  }
  if (id === "capture-helper") return ["native/macos-capture/.build/release/meetless-capture"];
  if (id === "node") return ["process.execPath"];
  if (id === "ffmpeg-media") {
    const destination = artifactPath;
    const source = context.mediaSources?.closure?.find((item) => item.destination === destination)?.source;
    return source ? [`external:${source}`] : ["MEETLESS_FFMPEG/MEETLESS_FFPROBE closure"];
  }
  if (id === "sherpa-model-assets") return ["vendor/paseo/packages/server/src/server/speech/providers/local/sherpa/assets/silero_vad.onnx"];
  if (id === "fonts-assets") {
    if (artifactPath.includes("/vendor/paseo/packages/desktop/assets/")) return [artifactPath.replace("Contents/Resources/meetless/", "")];
    if (packageSource) return [packageSource];
  }
  return [artifactPath];
}

function versionOrHash(id, packageMetadata, candidateSnapshot) {
  if (id === "paseo") {
    return {
      paseoCommit: candidateSnapshot?.dependencyArtifacts?.paseo?.expectedCommit,
      paseoBundleSha256: candidateSnapshot?.dependencyArtifacts?.paseo?.bundle?.sha256,
    };
  }
  if (id === "node") return { version: process.version };
  if (id === "electron-chromium") return { version: packageMetadata.electron?.version ?? null };
  if (id === "ffmpeg-media") return { version: "recorded by packaged artifact only; source tool version is unresolved" };
  if (id === "unzip-crx-3") return { version: packageMetadata.byName.get("unzip-crx-3")?.version ?? null };
  if (id === "sherpa-model-assets") {
    return {
      sherpaNodeVersion: packageMetadata.byName.get("sherpa-onnx-node")?.version ?? null,
      sherpaDarwinVersion: packageMetadata.byName.get("sherpa-onnx-darwin-arm64")?.version ?? null,
      modelArtifactPaths: ["Contents/Resources/meetless/vendor/paseo/packages/server/dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx"],
    };
  }
  if (id === "js-closure") return { packageCount: packageMetadata.members.filter((member) => member.component === id).length };
  return {};
}

function declaredLicenseEvidence(id, paths, packageMetadata) {
  const pathSet = new Set(paths);
  const packagePaths = packageMetadata.members
    .filter((member) => member.component === id)
    .flatMap((member) => [member.packageJsonPath, ...member.noticePaths])
    .filter((candidate) => pathSet.has(candidate) || candidate.startsWith("node_modules/") || candidate.startsWith("vendor/"));
  const evidencePaths = [...new Set(packagePaths)].sort((left, right) => left.localeCompare(right));
  if (id === "meetless") {
    const workspaceGaps = packageMetadata.workspaceMembers
      .filter((member) => member.component === id && !member.declaredLicense)
      .map((member) => ({ packageJsonPath: member.packageJsonPath, name: member.name, version: member.version }));
    return {
      status: "not-declared",
      paths: [
        "package.json",
        "packages/meeting-contracts/package.json",
        "packages/meeting-domain/package.json",
        "packages/meeting-store/package.json",
        "packages/meeting-surface/package.json",
        "packages/meetless-app/package.json",
        "packages/meetless-client/package.json",
        "packages/meetless-plugin/package.json",
        "packages/runtime/package.json",
      ],
      unresolved: ["Meetless package manifests do not declare a release license"],
      workspaceLicenseGaps: workspaceGaps,
    };
  }
  if (id === "paseo") {
    const workspaceGaps = packageMetadata.workspaceMembers
      .filter((member) => member.component === id && !member.declaredLicense)
      .map((member) => ({ packageJsonPath: member.packageJsonPath, name: member.name, version: member.version }));
    return {
      status: workspaceGaps.length ? "partial" : "available",
      paths: ["vendor/paseo/package.json", "vendor/paseo/LICENSE", "vendor/paseo/packages/expo-two-way-audio/LICENSE"],
      unresolved: workspaceGaps.length ? ["Paseo workspace package manifests do not declare a license"] : [],
      workspaceLicenseGaps: workspaceGaps,
    };
  }
  if (id === "node") return { status: "available-if-builder-license-is-copied", paths: ["notices/Node-LICENSE"] };
  if (id === "electron-chromium") return { status: "available", paths: ["node_modules/electron/package.json", "node_modules/electron/LICENSE", "node_modules/electron/dist/LICENSES.chromium.html", "notices/Electron-LICENSE", "notices/Chromium-LICENSES.html"] };
  if (id === "ffmpeg-media") return { status: "partial", paths: ["notices/FFmpeg-LICENSE.md", "notices/FFmpeg-COPYING.LGPLv2.1", "notices/FFmpeg-COPYING.LGPLv3", "notices/FFmpeg-COPYING.GPLv2", "notices/FFmpeg-COPYING.GPLv3"], unresolved: ["dynamic-library dependency notices are not established by the packaged tool license files"] };
  if (id === "capture-helper") return { status: "not-declared", paths: ["native/macos-capture/Package.swift"], unresolved: ["capture helper source has no declared license evidence"] };
  if (id === "native-binaries") {
    return {
      status: "partial",
      paths: [
        "package-lock.json",
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json",
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/LICENSE.md",
        "node_modules/@esbuild/darwin-arm64/package.json",
        "node_modules/esbuild/LICENSE.md",
        "node_modules/node-pty/package.json",
        "node_modules/node-pty/LICENSE",
      ],
      unresolved: ["native dependency license evidence is not complete"],
    };
  }
  if (id === "sherpa-model-assets") return { status: "partial", paths: ["node_modules/sherpa-onnx-node/package.json", "node_modules/sherpa-onnx-darwin-arm64/package.json", "vendor/paseo/packages/server/package.json"], unresolved: ["model and platform package license texts are not shipped"] };
  if (id === "unzip-crx-3") return { status: "available", paths: ["node_modules/unzip-crx-3/package.json", "node_modules/unzip-crx-3/LICENSE"] };
  if (id === "fonts-assets") {
    return {
      status: "partial",
      paths: ["package-lock.json", "vendor/paseo/package.json", "vendor/paseo/package-lock.json", "vendor/paseo/packages/desktop/package.json"],
      unresolved: ["asset-specific license evidence is not complete"],
    };
  }
  if (id === "js-closure") {
    return {
      status: "partial",
      paths: ["package.json", "package-lock.json", "vendor/paseo/package.json", "vendor/paseo/package-lock.json"],
      unresolved: packageMetadata.lockMetadataGaps.length
        ? ["Some production package records lack lockfile license metadata"]
        : ["npm package Corresponding Source/build-install material is not published by this inventory"],
    };
  }
  return { status: "unresolved", paths: [] };
}

async function shippedNotice(id, paths, context) {
  const packageNoticePaths = context.packageMetadata.members
    .filter((member) => member.component === id)
    .flatMap((member) => member.noticePaths)
    .filter((candidate) => paths.includes(candidate) && isVerifiedNoticePath(candidate));
  const trusted = trustedNoticeSources(id, context).filter((notice) => paths.includes(notice.artifactPath));
  const candidates = [...new Map([...trusted, ...packageNoticePaths.map((artifactPath) => ({ artifactPath, sourceKind: "packaged-npm-member" }))].map((notice) => [notice.artifactPath, notice])).values()];
  const records = [];
  const unresolved = [];
  for (const candidate of candidates.sort((left, right) => left.artifactPath.localeCompare(right.artifactPath))) {
    const artifactEntry = context.entries.find((entry) => entry.path === candidate.artifactPath);
    if (!artifactEntry) {
      unresolved.push(`notice artifact path is not present: ${candidate.artifactPath}`);
      continue;
    }
    const artifactBytes = await readFile(path.join(context.bundlePath, candidate.artifactPath)).catch(() => null);
    if (!artifactBytes || !isUtf8Text(artifactBytes)) {
      unresolved.push(`notice artifact is not verified UTF-8 text: ${candidate.artifactPath}`);
      continue;
    }
    if (candidate.sourceKind === "packaged-npm-member") {
      records.push({
        artifactPath: candidate.artifactPath,
        sourcePath: candidate.artifactPath.replace("Contents/Resources/meetless/", ""),
        sourceKind: candidate.sourceKind,
        sourceSha256: artifactEntry.sha256,
        artifactSha256: artifactEntry.sha256,
        byteBound: true,
      });
      continue;
    }
    const source = resolveTrustedNoticeSource(candidate, context);
    if (!source) {
      unresolved.push(`trusted notice source is unavailable for ${candidate.artifactPath}`);
      continue;
    }
    const sourceBytes = await readFile(source.resolvedPath).catch(() => null);
    if (!sourceBytes || !isUtf8Text(sourceBytes) || sha256(sourceBytes) !== artifactEntry.sha256 || !sourceBytes.equals(artifactBytes)) {
      unresolved.push(`notice bytes do not match the verified upstream source: ${candidate.artifactPath}`);
      continue;
    }
    records.push({
      artifactPath: candidate.artifactPath,
      sourcePath: source.sourcePath,
      sourceResolvedPath: source.resolvedPath,
      sourceKind: "verified-upstream-text",
      sourceSha256: sha256(sourceBytes),
      artifactSha256: artifactEntry.sha256,
      byteBound: true,
    });
  }
  const explicitUnresolved = [];
  if (!records.length) explicitUnresolved.push(`No verified upstream license/notice text is associated with ${id}`);
  if (packageNoticePaths.length !== candidates.filter((candidate) => candidate.sourceKind === "packaged-npm-member").length) {
    explicitUnresolved.push("Some package notice filenames were rejected because they are not verified text forms");
  }
  unresolved.push(...explicitUnresolved);
  return {
    status: records.length ? (unresolved.length ? "partial" : "available") : "not-present",
    paths: records.map((record) => record.artifactPath),
    records,
    unresolved,
  };
}

function trustedNoticeSources(id, context) {
  const sources = [
    { component: "paseo", artifactPath: "Contents/Resources/meetless/notices/Paseo-LICENSE", sourcePath: "vendor/paseo/LICENSE" },
    { component: "paseo", artifactPath: "Contents/Resources/meetless/notices/expo-two-way-audio-LICENSE", sourcePath: "vendor/paseo/packages/expo-two-way-audio/LICENSE" },
    { component: "electron-chromium", artifactPath: "Contents/Resources/meetless/notices/Electron-LICENSE", sourcePath: "node_modules/electron/LICENSE" },
    { component: "electron-chromium", artifactPath: "Contents/Resources/meetless/notices/Chromium-LICENSES.html", sourcePath: "node_modules/electron/dist/LICENSES.chromium.html" },
  ];
  if (id === "node") sources.push({ component: id, artifactPath: "Contents/Resources/meetless/notices/Node-LICENSE", sourcePath: "process.execPath license" });
  if (id === "ffmpeg-media") {
    for (const name of ["LICENSE.md", "COPYING.LGPLv2.1", "COPYING.LGPLv3", "COPYING.GPLv2", "COPYING.GPLv3"]) {
      sources.push({ component: id, artifactPath: `Contents/Resources/meetless/notices/FFmpeg-${name}`, sourcePath: `ffmpeg source ${name}` });
    }
  }
  return sources.filter((source) => source.component === id);
}

function resolveTrustedNoticeSource(candidate, context) {
  if (candidate.sourcePath === "process.execPath license") {
    return { sourcePath: candidate.sourcePath, resolvedPath: path.resolve(path.dirname(process.execPath), "..", "LICENSE") };
  }
  if (candidate.sourcePath.startsWith("ffmpeg source ")) {
    const ffmpeg = context.mediaSources?.ffmpeg;
    if (!ffmpeg) return null;
    return { sourcePath: candidate.sourcePath, resolvedPath: path.join(path.resolve(path.dirname(ffmpeg), ".."), candidate.sourcePath.slice("ffmpeg source ".length)) };
  }
  return { sourcePath: candidate.sourcePath, resolvedPath: path.join(context.repositoryRoot, candidate.sourcePath) };
}

function isVerifiedNoticePath(candidate) {
  return isVerifiedNoticeName(path.basename(candidate));
}

export function isVerifiedNoticeName(name) {
  if (typeof name !== "string" || !/^(?:license|licence|copying|notice)(?:[._-].*)?$/iu.test(name)) return false;
  const suffix = name.slice(name.search(/[._-]/u) + 1).toLowerCase();
  const extension = path.extname(name).toLowerCase();
  return extension === "" || [".md", ".markdown", ".txt", ".html", ".htm", ".rst", ".adoc"].includes(extension) || /^(?:a?gpl|lgpl|mpl|apache|bsd|mit|isc|epl|cddl|zlib|boost|ofl|psf|python|ruby|perl|openssl|icu)/u.test(suffix);
}

function isUtf8Text(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > 0 && !text.includes("\u0000");
  } catch {
    return false;
  }
}

function sourceBuildMaterial(id) {
  if (id === "meetless") return { status: "available-in-repository", paths: ["packages", "native/macos-host", "scripts/package-macos.mjs", "scripts/install-macos-host.mjs"] };
  if (id === "paseo") return { status: "partial", paths: ["vendor/paseo", "vendor/paseo/package-lock.json", "scripts/package-macos.mjs"], unresolved: ["Corresponding Source/build-install publication decision remains open"] };
  if (id === "js-closure") return { status: "partial", paths: ["package-lock.json", "scripts/package-macos.mjs"], unresolved: ["npm package Corresponding Source/build-install material is not published by this inventory"] };
  if (id === "electron-chromium") return { status: "partial", paths: ["node_modules/electron/package.json", "scripts/package-macos.mjs"], unresolved: ["Electron/Chromium source and build material publication decision remains open"] };
  if (id === "node") return { status: "unresolved", paths: [], unresolved: ["Node source/build material is not in the Meetless repository"] };
  if (id === "native-binaries") return {
    status: "partial",
    paths: [
      "scripts/build-native.mjs",
      "native/macos-host",
      "packages/runtime/native",
      "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json",
      "node_modules/@esbuild/darwin-arm64/package.json",
      "node_modules/node-pty/package.json",
    ],
    unresolved: ["Third-party native source/build material is not complete"],
  };
  if (id === "capture-helper") return { status: "available-in-repository", paths: ["native/macos-capture", "scripts/build-native.mjs"] };
  if (id === "ffmpeg-media") return { status: "partial", paths: ["scripts/package-macos.mjs", "MEETLESS_FFMPEG", "MEETLESS_FFPROBE"], unresolved: ["FFmpeg source/build material publication decision remains open"] };
  if (id === "sherpa-model-assets") return { status: "partial", paths: ["vendor/paseo/packages/server/src/server/speech/providers/local/sherpa", "vendor/paseo/packages/server/package.json"], unresolved: ["Downloaded model source/build and notice material is not complete"] };
  if (id === "fonts-assets") return { status: "partial", paths: ["vendor/paseo/packages/desktop/assets", "vendor/paseo/packages/desktop/package.json", "package-lock.json"], unresolved: ["Asset provenance is mixed across package sources"] };
  if (id === "unzip-crx-3") return { status: "partial", paths: ["package-lock.json", "scripts/package-macos.mjs"], unresolved: ["Corresponding Source/build-install publication decision remains open"] };
  return { status: "unresolved", paths: [], unresolved: ["No accepted source/build material was identified"] };
}

function buildOverlapRules(componentPaths) {
  const rules = [];
  const addRule = (id, broader, narrower, paths, reason) => {
    const matched = paths.filter((candidate) => componentPaths.get(narrower)?.includes(candidate));
    if (matched.length) rules.push({ id, broaderComponent: broader, narrowerComponent: narrower, paths: matched.sort(), reason });
  };
  addRule(
    "paseo-model-output",
    "paseo",
    "sherpa-model-assets",
    ["Contents/Resources/meetless/vendor/paseo/packages/server/dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx"],
    "Paseo server build output contains the copied Sherpa model; the model path has its own inventory component.",
  );
  addRule(
    "paseo-static-assets",
    "paseo",
    "fonts-assets",
    (componentPaths.get("fonts-assets") ?? []).filter((candidate) => candidate.includes("/vendor/paseo/")),
    "Paseo package assets are mapped to the asset component while their provenance remains the Paseo package tree.",
  );
  addRule(
    "sherpa-native-closure",
    "sherpa-model-assets",
    "native-binaries",
    (componentPaths.get("native-binaries") ?? []).filter((candidate) => candidate.includes("/sherpa-onnx-")),
    "Sherpa platform package binaries are native artifacts; model and package metadata remain in the Sherpa/model component.",
  );
  return rules;
}

export async function collectWorkspaceMembers(bundlePath) {
  const members = [];
  for (const entry of await enumeratePackageEntries(bundlePath)) {
    if (entry.type !== "file" || !isWorkspacePackageManifestPath(entry.path)) continue;
    const relative = entry.path.replace("Contents/Resources/meetless/", "");
    const component = relative.startsWith("vendor/paseo/packages/") ? "paseo" : relative.startsWith("packages/") ? "meetless" : null;
    if (!component) continue;
    const packageJson = await readJson(path.join(bundlePath, entry.path));
    if (!packageJson?.name || !packageJson?.version) continue;
    const sourcePath = relative;
    members.push({
      memberType: "workspace-package",
      component,
      artifactPath: path.posix.dirname(entry.path),
      packageJsonPath: entry.path,
      sourcePath,
      name: packageJson.name,
      version: packageJson.version,
      declaredLicense: typeof packageJson.license === "string" ? packageJson.license : null,
      declaredLicenseEvidence: {
        status: typeof packageJson.license === "string" ? "declared" : "not-declared",
        paths: [sourcePath],
        ...(typeof packageJson.license === "string" ? {} : { unresolved: ["Workspace package manifest does not declare a license"] }),
      },
    });
  }
  return members.sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
}

export async function collectMacOSPackageMetadata(packageRoot, repositoryRoot, workspaceMembers = []) {
  const rootLock = await readJson(path.join(repositoryRoot, "package-lock.json"));
  const paseoLock = await readJson(path.join(repositoryRoot, "vendor/paseo/package-lock.json"));
  const members = [];
  await walkPackages(packageRoot, packageRoot, async (packageDir, relative) => {
    const packageJsonPath = path.join(packageDir, "package.json");
    const manifest = await readJson(packageJsonPath);
    if (!manifest?.name || !manifest?.version) return;
    const artifactRoot = `Contents/Resources/meetless/node_modules/${relative}`.replaceAll(path.sep, "/");
    const packageJsonArtifactPath = `${artifactRoot}/package.json`;
    const files = await readdir(packageDir);
    const noticePaths = files
      .filter((name) => isVerifiedNoticeName(name))
      .map((name) => `${artifactRoot}/${name}`)
      .sort();
    const lockPath = `node_modules/${relative}`.replaceAll(path.sep, "/");
    const lockMatch = findLockMatch(manifest.name, manifest.version, lockPath, rootLock, paseoLock);
    const component = packageComponent(artifactRoot);
    members.push({
      memberType: "npm-package",
      component,
      artifactPath: artifactRoot,
      packageJsonPath: packageJsonArtifactPath,
      sourcePath: `node_modules/${relative}`.replaceAll(path.sep, "/"),
      name: manifest.name,
      version: manifest.version,
      declaredLicense: typeof manifest.license === "string" ? manifest.license : null,
      noticePaths,
      lockEvidence: lockMatch,
    });
  });
  members.sort((left, right) => left.artifactPath.localeCompare(right.artifactPath));
  const lockMetadataGaps = [];
  for (const [lockFile, lock] of [["package-lock.json", rootLock], ["vendor/paseo/package-lock.json", paseoLock]]) {
    for (const [lockPath, entry] of Object.entries(lock?.packages ?? {})) {
      if (!lockPath || !entry?.name || entry.license || entry.licenses) continue;
      lockMetadataGaps.push({ lockFile, lockPath, name: entry.name, version: entry.version ?? null });
    }
  }
  const byName = new Map();
  for (const member of members) if (!byName.has(member.name)) byName.set(member.name, member);
  const electronManifest = await readJson(path.join(repositoryRoot, "node_modules/electron/package.json"));
  return {
    members,
    workspaceMembers,
    lockMetadataGaps: lockMetadataGaps.sort((left, right) => `${left.lockFile}:${left.lockPath}`.localeCompare(`${right.lockFile}:${right.lockPath}`)),
    byName,
    electron: electronManifest ?? null,
  };
}

function packageComponent(artifactRoot) {
  const packageRoot = resolveNpmPackageRoot(artifactRoot);
  const name = packageRoot?.name;
  if (name === "unzip-crx-3") return "unzip-crx-3";
  if (name === "sherpa-onnx-node" || name === "sherpa-onnx-darwin-arm64") return "sherpa-model-assets";
  if (name?.startsWith("@getpaseo/") || name?.startsWith("@paseo/")) return "paseo";
  if (name?.startsWith("@meetless/")) return "meetless";
  if (name && NATIVE_NPM_PACKAGES.has(name)) return "native-binaries";
  return "js-closure";
}

function findLockMatch(name, version, preferredPath, ...locks) {
  const labeledLocks = locks.map((lock, index) => ({
    lock,
    lockFile: index === 0 ? "package-lock.json" : "vendor/paseo/package-lock.json",
  }));
  for (const { lock, lockFile } of labeledLocks) {
    const exact = lock?.packages?.[preferredPath];
    if (exact && lockEntryMatches(name, version, preferredPath, exact)) return lockEvidence(lockFile, preferredPath, preferredPath, name, exact, "canonical-path");
  }
  const matches = [];
  for (const { lock, lockFile } of labeledLocks) {
    for (const [lockPath, entry] of Object.entries(lock?.packages ?? {})) {
      if (entry && lockEntryMatches(name, version, lockPath, entry)) matches.push({ lockFile, lockPath, entry });
    }
  }
  if (matches.length) {
    const identities = new Set(matches.map(({ entry }) => JSON.stringify({
      version: entry.version,
      integrity: entry.integrity ?? null,
      resolved: entry.resolved ?? null,
      license: entry.license ?? null,
      licenses: entry.licenses ?? null,
    })));
    if (identities.size === 1) {
      const match = matches.sort((left, right) => `${left.lockFile}:${left.lockPath}`.localeCompare(`${right.lockFile}:${right.lockPath}`))[0];
      return lockEvidence(match.lockFile, match.lockPath, preferredPath, name, match.entry, "manifest-name-version-fallback");
    }
    return {
      matched: false,
      status: "unresolved",
      packageName: name,
      version,
      canonicalPath: preferredPath,
      paths: matches.map((match) => `${match.lockFile}:${match.lockPath}`).sort(),
      reason: "Multiple npm lock v3 records matched the package manifest name and version with different integrity or source metadata",
    };
  }
  return {
    matched: false,
    status: "unresolved",
    packageName: name,
    version,
    canonicalPath: preferredPath,
    paths: [],
    reason: "No npm lock v3 package record matched the package manifest name, version, and canonical lock path",
  };
}

function lockEntryMatches(name, version, lockPath, entry) {
  return (entry.name ?? packageNameFromLockPath(lockPath)) === name && entry.version === version;
}

function packageNameFromLockPath(lockPath) {
  const marker = lockPath.lastIndexOf("node_modules/");
  if (marker < 0) return null;
  return lockPath.slice(marker + "node_modules/".length);
}

function lockEvidence(lockFile, lockPath, canonicalPath, packageName, entry, matchMode) {
  return {
    matched: true,
    status: "matched",
    lockFile,
    lockPath,
    canonicalPath,
    matchMode,
    packageName,
    paths: [lockPath],
    version: entry.version,
    license: entry.license ?? entry.licenses ?? null,
    licenses: entry.licenses ?? null,
    integrity: entry.integrity ?? null,
    resolved: entry.resolved ?? null,
    flags: {
      dev: entry.dev ?? null,
      optional: entry.optional ?? null,
      devOptional: entry.devOptional ?? null,
      link: entry.link ?? null,
    },
    licenseMetadataStatus: entry.license || entry.licenses ? "available" : "missing",
  };
}

async function walkPackages(root, directory, callback, relative = "") {
  for (const name of (await readdir(directory)).sort((left, right) => left.localeCompare(right))) {
    const absolute = path.join(directory, name);
    const inspected = await lstat(absolute);
    if (inspected.isSymbolicLink() || !inspected.isDirectory() || name.startsWith(".")) continue;
    if (name === "node_modules") {
      await walkPackages(root, absolute, callback, relative);
      continue;
    }
    const childRelative = path.join(relative, name);
    if (name.startsWith("@")) {
      await walkPackages(root, absolute, callback, childRelative);
      continue;
    }
    if (await exists(path.join(absolute, "package.json"))) await callback(absolute, childRelative);
    const nested = path.join(absolute, "node_modules");
    if (await exists(nested)) await walkPackages(root, nested, callback, path.join(childRelative, "node_modules"));
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function snapshotBinding(snapshot) {
  return {
    command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
    mode: snapshot?.mode ?? null,
    excludedPaths: snapshot?.excludedPaths ?? null,
    digest: snapshot?.digest ?? null,
    head: snapshot?.head ?? null,
    paseoCommit: snapshot?.dependencyArtifacts?.paseo?.expectedCommit ?? null,
  };
}

function packageInputBinding(packageInputManifest) {
  if (!packageInputManifest) {
    return {
      schema: "MEETLESS_MACOS_PACKAGE_INPUTS v1",
      digest: null,
      sourceSnapshotDigest: null,
      artifactInputDigest: null,
      packageMemberDigest: null,
      workspaceMemberDigest: null,
      inputCount: 0,
      packageMemberCount: 0,
      workspaceMemberCount: 0,
      lockMetadataGapCount: null,
    };
  }
  return {
    schema: packageInputManifest.schema,
    digest: packageInputManifest.digest,
    sourceSnapshotDigest: packageInputManifest.sourceSnapshot.digest,
    artifactInputDigest: packageInputManifest.artifactInput.digest,
    packageMemberDigest: packageInputManifest.packageMemberDigest,
    workspaceMemberDigest: packageInputManifest.workspaceMemberDigest,
    inputCount: packageInputManifest.inputs.length,
    packageMemberCount: packageInputManifest.packageMembers.length,
    workspaceMemberCount: packageInputManifest.workspaceMembers.length,
    lockMetadataGapCount: packageInputManifest.lockMetadataGapCount,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value) {
  return sha256(JSON.stringify(value));
}
