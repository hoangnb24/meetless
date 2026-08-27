import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  collectMacOSPackageMetadata,
  digestArtifactEntries,
  collectWorkspaceMembers,
} from "./macos-license-inventory.mjs";
import { enumeratePackageEntries, inspectPackageMachOEntries } from "./macos-package-inventory.mjs";
import {
  PACKAGE_SOURCE_EXCLUDED_PATHS,
  PACKAGE_SOURCE_MODE,
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
} from "../candidate-snapshot.mjs";

export const MACOS_PACKAGE_INPUT_SCHEMA = "MEETLESS_MACOS_PACKAGE_INPUTS v1";
export const MACOS_PACKAGE_INPUT_AUTHORITY = "docs/decisions/0001-maintained-paseo-fork.md";

const PACKAGE_INPUT_ACTION =
  "rebuild the package-input manifest from the current source, generated build outputs, shipped dependency closure, and final artifact inputs";

const GENERATED_INPUTS = [
  ["meetless-app-dist", "generated-dist", "packages/meetless-app/dist", ["Contents/Resources/meetless/packages/meetless-app/"]],
  ["runtime-dist", "generated-dist", "packages/runtime/dist", ["Contents/Resources/meetless/packages/runtime/"]],
  ["meeting-contracts-dist", "generated-dist", "packages/meeting-contracts/dist", ["Contents/Resources/meetless/packages/meeting-contracts/"]],
  ["meeting-domain-dist", "generated-dist", "packages/meeting-domain/dist", ["Contents/Resources/meetless/packages/meeting-domain/"]],
  ["meeting-store-dist", "generated-dist", "packages/meeting-store/dist", ["Contents/Resources/meetless/packages/meeting-store/"]],
  ["meetless-client-dist", "generated-dist", "packages/meetless-client/dist", ["Contents/Resources/meetless/packages/meetless-client/"]],
  ["meetless-plugin-dist", "generated-dist", "packages/meetless-plugin/dist", ["Contents/Resources/meetless/packages/meetless-plugin/"]],
  ["meetless-plugin-source", "shipped-source", "packages/meetless-plugin/src", ["Contents/Resources/meetless/packages/meetless-plugin/"]],
  ["paseo-highlight-dist", "generated-dist", "vendor/paseo/packages/highlight/dist", ["Contents/Resources/meetless/vendor/paseo/packages/highlight/"]],
  ["paseo-plugin-dist", "generated-dist", "vendor/paseo/packages/plugin/dist", ["Contents/Resources/meetless/vendor/paseo/packages/plugin/"]],
  ["paseo-protocol-dist", "generated-dist", "vendor/paseo/packages/protocol/dist", ["Contents/Resources/meetless/vendor/paseo/packages/protocol/"]],
  ["paseo-relay-dist", "generated-dist", "vendor/paseo/packages/relay/dist", ["Contents/Resources/meetless/vendor/paseo/packages/relay/"]],
  ["paseo-client-dist", "generated-dist", "vendor/paseo/packages/client/dist", ["Contents/Resources/meetless/vendor/paseo/packages/client/"]],
  ["paseo-server-dist", "generated-dist", "vendor/paseo/packages/server/dist", ["Contents/Resources/meetless/vendor/paseo/packages/server/"]],
  ["paseo-cli-dist", "generated-dist", "vendor/paseo/packages/cli/dist", ["Contents/Resources/meetless/vendor/paseo/packages/cli/"]],
  ["paseo-desktop-dist", "generated-dist", "vendor/paseo/packages/desktop/dist", ["Contents/Resources/meetless/vendor/paseo/packages/desktop/"]],
  ["paseo-desktop-assets", "generated-assets", "vendor/paseo/packages/desktop/assets", ["Contents/Resources/meetless/vendor/paseo/packages/desktop/assets/"]],
  ["capture-helper-build", "generated-native", "native/macos-capture/.build/release/meetless-capture", ["Contents/Resources/meetless/native/macos-capture/"]],
];

const NATIVE_PACKAGE_INPUTS = [
  ["anthropic-native-package", "native-package", "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64", ["Contents/Resources/meetless/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/"]],
  ["esbuild-native-package", "native-package", "node_modules/@esbuild/darwin-arm64", ["Contents/Resources/meetless/node_modules/@esbuild/darwin-arm64/"]],
  ["node-pty-native-package", "native-package", "node_modules/node-pty", ["Contents/Resources/meetless/node_modules/node-pty/"]],
  ["sherpa-node-package", "model-package", "node_modules/sherpa-onnx-node", ["Contents/Resources/meetless/node_modules/sherpa-onnx-node/"]],
  ["sherpa-darwin-package", "model-native-package", "node_modules/sherpa-onnx-darwin-arm64", ["Contents/Resources/meetless/node_modules/sherpa-onnx-darwin-arm64/"]],
  ["unzip-crx-package", "npm-package", "node_modules/unzip-crx-3", ["Contents/Resources/meetless/node_modules/unzip-crx-3/"]],
];

export async function collectMacOSPackageInputs({
  repositoryRoot,
  bundlePath,
  candidateSnapshot,
  mediaSources = null,
  priorManifest = null,
  packageMetadata = null,
}) {
  const packageRoot = path.join(bundlePath, "Contents", "Resources", "meetless");
  const workspaceMembers = await collectWorkspaceMembers(bundlePath);
  const metadata = packageMetadata ?? await collectMacOSPackageMetadata(packageRoot, repositoryRoot, workspaceMembers);
  const specs = buildInputSpecs({ repositoryRoot, candidateSnapshot, mediaSources, priorManifest });
  const inputs = [];
  for (const spec of specs) inputs.push(await hashInputSpec(spec, repositoryRoot, priorManifest));

  const entries = await enumeratePackageEntries(bundlePath);
  const machoEntries = await inspectPackageMachOEntries(bundlePath, entries);
  const machoPaths = machoEntries.map((entry) => entry.path);
  const excludedPaths = [...new Set([MACOS_LICENSE_INVENTORY_PATH, ...machoPaths])].sort((left, right) => left.localeCompare(right));
  const artifactEntries = entries.filter((entry) => !excludedPaths.includes(entry.path) && !entry.path.startsWith("Contents/_CodeSignature/"));
  const packageMembers = metadata.members.map((member) => ({ ...member })).sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
  const packagedWorkspaceMembers = [...metadata.workspaceMembers].sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
  const packageInputBase = {
    schema: MACOS_PACKAGE_INPUT_SCHEMA,
    authority: MACOS_PACKAGE_INPUT_AUTHORITY,
    sourceSnapshot: snapshotBinding(candidateSnapshot),
    inputs,
    packageMembers,
    workspaceMembers: packagedWorkspaceMembers,
    lockMetadataGaps: metadata.lockMetadataGaps,
    artifactInput: {
      algorithm: "sha256",
      digest: digestArtifactEntries(entries, { excludedPaths }),
      entryCount: artifactEntries.length,
      excludedPaths,
    },
    packageMemberDigest: digestJson(packageMembers),
    workspaceMemberDigest: digestJson(packagedWorkspaceMembers),
    lockMetadataGapCount: metadata.lockMetadataGaps.length,
  };
  return {
    manifest: {
      ...packageInputBase,
      digest: digestJson(packageInputBase),
    },
    packageMetadata: metadata,
  };
}

export async function verifyMacOSPackageInputs({ manifest, repositoryRoot, bundlePath, candidateSnapshot }) {
  validateMacOSPackageInputDocument(manifest, candidateSnapshot);
  const current = await collectMacOSPackageInputs({
    repositoryRoot,
    bundlePath,
    candidateSnapshot,
    priorManifest: manifest,
  });
  const actualPaths = (await enumeratePackageEntries(bundlePath)).map((entry) => entry.path);
  for (const input of manifest.inputs) {
    for (const prefix of input.artifactPathPrefixes) {
      if (!actualPaths.some((candidate) => candidate === prefix || candidate.startsWith(prefix))) {
        throw new Error(`package input ${input.id} has no shipped artifact binding for ${prefix}; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: bind the input to the final artifact or remove the unused input`);
      }
    }
  }
  if (current.manifest.digest !== manifest.digest) {
    throw new Error(`package-input digest differs from the bound candidate; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: rebuild the package after every source or shipped-input mutation`);
  }
  return current;
}

export function validateMacOSPackageInputDocument(manifest, candidateSnapshot = null) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`package-input manifest is not an object; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (manifest.schema !== MACOS_PACKAGE_INPUT_SCHEMA || manifest.authority !== MACOS_PACKAGE_INPUT_AUTHORITY) {
    throw new Error(`package-input manifest schema or authority is invalid; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (
    !manifest.sourceSnapshot ||
    manifest.sourceSnapshot.command !== PACKAGE_SOURCE_SNAPSHOT_COMMAND ||
    manifest.sourceSnapshot.mode !== PACKAGE_SOURCE_MODE ||
    JSON.stringify(manifest.sourceSnapshot.excludedPaths ?? []) !== JSON.stringify([...PACKAGE_SOURCE_EXCLUDED_PATHS]) ||
    !/^[a-f0-9]{64}$/u.test(manifest.sourceSnapshot.digest ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceSnapshot.head ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceSnapshot.paseoCommit ?? "")
  ) {
    throw new Error(`package-input source snapshot binding is missing; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (candidateSnapshot && JSON.stringify(manifest.sourceSnapshot) !== JSON.stringify(snapshotBinding(candidateSnapshot))) {
    throw new Error(`package-input source snapshot differs from the candidate snapshot; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0) {
    throw new Error(`package-input source records are missing; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  const ids = new Set();
  for (const input of manifest.inputs) {
    if (!input || typeof input.id !== "string" || !input.id || ids.has(input.id) || !Array.isArray(input.sourcePaths) || input.sourcePaths.length === 0 || !input.content || !/^[a-f0-9]{64}$/u.test(input.content.digest ?? "") || !Number.isInteger(input.content.entryCount) || input.content.entryCount < 1 || !Array.isArray(input.artifactPathPrefixes) || input.artifactPathPrefixes.length === 0) {
      throw new Error(`package-input record is missing identity, source, content, or artifact binding; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
    }
    ids.add(input.id);
    for (const sourcePath of input.sourcePaths) if (typeof sourcePath !== "string" || !sourcePath) throw new Error(`package-input ${input.id} has an empty source path; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
    for (const artifactPath of input.artifactPathPrefixes) if (typeof artifactPath !== "string" || !artifactPath) throw new Error(`package-input ${input.id} has an empty artifact binding; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  validateMemberArray(manifest.packageMembers, "package member");
  validateMemberArray(manifest.workspaceMembers, "workspace member");
  if (!manifest.artifactInput || manifest.artifactInput.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(manifest.artifactInput.digest ?? "") || !Number.isInteger(manifest.artifactInput.entryCount) || !Array.isArray(manifest.artifactInput.excludedPaths)) {
    throw new Error(`package-input artifact binding is missing or invalid; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.packageMemberDigest ?? "") || !/^[a-f0-9]{64}$/u.test(manifest.workspaceMemberDigest ?? "") || !Number.isInteger(manifest.lockMetadataGapCount)) {
    throw new Error(`package-input derived member counts or digests are missing; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  if (!Array.isArray(manifest.lockMetadataGaps) || manifest.packageMemberDigest !== digestJson(manifest.packageMembers) || manifest.workspaceMemberDigest !== digestJson(manifest.workspaceMembers) || manifest.lockMetadataGapCount !== manifest.lockMetadataGaps.length) {
    throw new Error(`package-input member or lock-gap counts are stale; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: derive counts from the final package metadata`);
  }
  const expectedDigest = digestJson({ ...manifest, digest: undefined });
  if (manifest.digest !== expectedDigest) {
    throw new Error(`package-input manifest digest is stale; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  }
  return manifest;
}

export function snapshotBinding(snapshot) {
  return {
    command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
    mode: snapshot?.mode ?? null,
    excludedPaths: snapshot?.excludedPaths ?? null,
    digest: snapshot?.digest ?? null,
    head: snapshot?.head ?? null,
    paseoCommit: snapshot?.dependencyArtifacts?.paseo?.expectedCommit ?? snapshot?.paseoCommit ?? null,
  };
}

export function digestJson(value) {
  return sha256(JSON.stringify(value));
}

function buildInputSpecs({ repositoryRoot, candidateSnapshot, mediaSources, priorManifest }) {
  const specs = [
    {
      id: "root-package-manifests",
      kind: "package-manifest-and-lock-v3",
      sourcePaths: ["package.json", "package-lock.json", "vendor/paseo/package.json", "vendor/paseo/package-lock.json"],
      artifactPathPrefixes: ["Contents/Resources/meetless/package.json", "Contents/Resources/meetless/node_modules/", "Contents/Resources/meetless/packages/", "Contents/Resources/meetless/vendor/paseo/packages/"],
    },
    {
      id: "meetless-native-sources",
      kind: "native-source",
      sourcePaths: ["native/macos-host", "packages/runtime/native", "native/macos-capture/Package.swift", "native/macos-capture/Sources"],
      artifactPathPrefixes: ["Contents/Info.plist", "Contents/MacOS/MeetlessHost", "Contents/Resources/meetless/native/macos-capture/", "Contents/Resources/meetless/packages/runtime/"],
    },
    {
      id: "package-assembly-scripts",
      kind: "package-build-script",
      sourcePaths: ["scripts/package-macos.mjs", "scripts/build-native.mjs", "scripts/electron-bootstrap.mjs", "scripts/launch-macos-host.mjs", "scripts/stop-macos-host.mjs", "scripts/lib/macos-package-contract.mjs", "scripts/lib/macos-package-contract.json"],
      artifactPathPrefixes: ["Contents/Resources/host-config.json", "Contents/Resources/meetless/installation-contract.json", "Contents/Resources/meetless/meetless-package.json", "Contents/Resources/meetless/scripts/"],
    },
    {
      id: "paseo-source-bundle",
      kind: "paseo-source-bundle",
      sourcePaths: [
        candidateSnapshot?.dependencyArtifacts?.paseo?.bundle?.path ??
          priorManifest?.inputs?.find((input) => input.id === "paseo-source-bundle")?.sourcePaths?.[0] ??
          "vendor/paseo-bundles",
      ],
      artifactPathPrefixes: ["Contents/Resources/meetless/vendor/paseo/"],
    },
    {
      id: "paseo-notices-source",
      kind: "upstream-notice-source",
      sourcePaths: ["vendor/paseo/LICENSE", "vendor/paseo/packages/expo-two-way-audio/LICENSE"],
      artifactPathPrefixes: ["Contents/Resources/meetless/notices/"],
    },
    {
      id: "model-source",
      kind: "model-source",
      sourcePaths: ["vendor/paseo/packages/server/src/server/speech/providers/local/sherpa"],
      artifactPathPrefixes: ["Contents/Resources/meetless/vendor/paseo/packages/server/dist/server/server/speech/providers/local/sherpa/"],
    },
    ...GENERATED_INPUTS.map(([id, kind, sourcePath, artifactPathPrefixes]) => ({ id, kind, sourcePaths: [sourcePath], artifactPathPrefixes })),
    ...NATIVE_PACKAGE_INPUTS.map(([id, kind, sourcePath, artifactPathPrefixes]) => ({ id, kind, sourcePaths: [sourcePath], artifactPathPrefixes })),
    {
      id: "electron-runtime-input",
      kind: "electron-chromium-runtime",
      sourcePaths: ["node_modules/electron/package.json", "node_modules/electron/LICENSE", "node_modules/electron/dist/LICENSES.chromium.html", "node_modules/electron/dist/Electron.app"],
      artifactPathPrefixes: ["Contents/Resources/meetless/runtime/electron/", "Contents/Resources/meetless/notices/Electron-", "Contents/Resources/meetless/notices/Chromium-"],
    },
    {
      id: "node-runtime-input",
      kind: "node-runtime",
      sourcePaths: ["process.execPath"],
      resolvedPaths: [priorResolvedPath(priorManifest, "node-runtime-input") ?? process.execPath],
      artifactPathPrefixes: ["Contents/Resources/meetless/runtime/node", "Contents/Resources/meetless/notices/Node-LICENSE"],
    },
  ];
  const media = mediaSources?.closure ?? priorManifest?.inputs?.filter((input) => input.id.startsWith("media-"))?.map((input) => ({ source: input.resolvedPaths?.[0], destination: input.artifactPathPrefixes?.[0]?.replace("Contents/Resources/meetless/", "") })) ?? [];
  for (const [index, item] of media.entries()) {
    if (!item?.source) continue;
    specs.push({
      id: `media-${index.toString().padStart(3, "0")}`,
      kind: "media-runtime-input",
      sourcePaths: [`media source ${index}`],
      resolvedPaths: [item.source],
      artifactPathPrefixes: [item.destination ? (item.destination.startsWith("Contents/") ? item.destination : `Contents/Resources/meetless/${item.destination}`) : "Contents/Resources/meetless/runtime/media/"],
    });
  }
  return specs;
}

function priorResolvedPath(priorManifest, id) {
  return priorManifest?.inputs?.find((input) => input.id === id)?.resolvedPaths?.[0] ?? null;
}

async function hashInputSpec(spec, repositoryRoot, priorManifest) {
  const resolvedPaths = spec.resolvedPaths ?? spec.sourcePaths.map((sourcePath) => path.resolve(repositoryRoot, sourcePath));
  const pathRecords = [];
  for (let index = 0; index < resolvedPaths.length; index += 1) {
    const resolvedPath = resolvedPaths[index];
    const sourcePath = spec.sourcePaths[index];
    const content = await hashPath(resolvedPath, sourcePath);
    pathRecords.push({ sourcePath, resolvedPath: path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(resolvedPath), ...content });
  }
  return {
    id: spec.id,
    kind: spec.kind,
    sourcePaths: spec.sourcePaths,
    ...(spec.resolvedPaths ? { resolvedPaths: spec.resolvedPaths } : {}),
    artifactPathPrefixes: spec.artifactPathPrefixes,
    content: {
      algorithm: "sha256",
      digest: digestJson(pathRecords.map(({ sourcePath: _sourcePath, resolvedPath: _resolvedPath, ...record }) => record)),
      entryCount: pathRecords.reduce((total, record) => total + record.entryCount, 0),
    },
  };
}

async function hashPath(candidate, label) {
  const root = path.resolve(candidate);
  const records = [];
  async function visit(current, relative) {
    const inspected = await lstat(current).catch(() => null);
    if (!inspected) throw new Error(`package input ${label} is missing at ${current}; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
    if (inspected.isSymbolicLink()) {
      records.push({ path: relative || ".", type: "symlink", target: await readlink(current) });
      return;
    }
    if (inspected.isFile()) {
      const bytes = await readFile(current);
      records.push({ path: relative || ".", type: "file", size: bytes.byteLength, sha256: sha256(bytes) });
      return;
    }
    if (!inspected.isDirectory()) throw new Error(`package input ${label} is not a file or directory: ${current}; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
      await visit(path.join(current, name), relative ? path.join(relative, name) : name);
    }
  }
  await visit(root, "");
  return { digest: digestJson(records), entryCount: records.length };
}

function validateMemberArray(members, label) {
  if (!Array.isArray(members)) throw new Error(`package-input ${label} records are missing; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
  const identities = new Set();
  for (const member of members) {
    const identity = `${member?.artifactPath ?? ""}:${member?.packageJsonPath ?? ""}:${member?.memberType ?? ""}`;
    if (!member || !member.artifactPath || !member.memberType || identities.has(identity)) throw new Error(`package-input ${label} record is missing identity or is duplicated; Authority: ${MACOS_PACKAGE_INPUT_AUTHORITY}. Next action: ${PACKAGE_INPUT_ACTION}`);
    identities.add(identity);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
