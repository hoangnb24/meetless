import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoForbiddenLoadPath,
  assertPackageRelativePath,
  compareManifestEntrySets,
  digestManifest,
  validateAcceptanceEvidenceBinding,
  validateLicenseInventoryCoverage,
  validateLoadPathClosure,
  validateMacOSLoadPathClosure,
  validateLicenseInventoryDocument,
  validateManifestDocument,
  validatePackageSymlinkClosure,
  validateResolutionEvidencePaths,
  resolveLoadPath,
} from "../../../scripts/validate-macos-package.mjs";
import {
  MACOS_LICENSE_INVENTORY_AUTHORITY,
  MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES,
  MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS,
  MACOS_LICENSE_INVENTORY_MANIFEST_PATH,
  MACOS_LICENSE_INVENTORY_PATH,
  MACOS_LICENSE_INVENTORY_SCHEMA,
  REQUIRED_LICENSE_COMPONENTS,
  buildArtifactMembers,
  buildMacOSLicenseInventory,
  classifyArtifactPath,
  collectMacOSPackageMetadata,
  collectWorkspaceMembers,
  digestArtifactEntries,
  digestComponentEntries,
  isNpmPackageManifestPath,
  isVerifiedNoticeName,
  resolveNpmPackageRoot,
} from "../../../scripts/lib/macos-license-inventory.mjs";
import { buildMacOSPackageInputSpecs, MACOS_PACKAGE_INPUT_AUTHORITY, MACOS_PACKAGE_INPUT_SCHEMA, digestJson, validateMacOSPackageInputDocument } from "../../../scripts/lib/macos-package-inputs.mjs";
import { MACOS_LOCAL_PACKAGES, validateMacOSPackageComposition } from "../../../scripts/lib/macos-package-composition.mjs";
import { createSigningMetadata } from "../../../scripts/lib/macos-package-signing.mjs";
import { assertDistributionReadiness } from "../../../scripts/check-macos-distribution-readiness.mjs";
import {
  PACKAGE_SOURCE_EXCLUDED_PATHS,
  PACKAGE_SOURCE_MODE,
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
  digestSnapshot,
  parsePorcelainStatus,
  snapshotFilesForMode,
} from "../../../scripts/candidate-snapshot.mjs";

const symlinkFixtureRoots = new Set<string>();
const retainedFailedProofRoot = "/private/tmp/meetless-mas-development-proof.Ffw0bs";
const retainedFailedArtifactPath = path.join(retainedFailedProofRoot, "release/macos/Meetless.app");
const retainedFailedInventoryPath = path.join(retainedFailedArtifactPath, MACOS_LICENSE_INVENTORY_PATH);

afterEach(async () => {
  await Promise.all([...symlinkFixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  symlinkFixtureRoots.clear();
});

describe("macOS package composition manifest", () => {
  it("copies the package builder process.execPath to the contracted runtime/node destination", async () => {
    const [source, contractBytes] = await Promise.all([
      readFile("scripts/package-macos.mjs", "utf8"),
      readFile("scripts/lib/macos-package-contract.json", "utf8"),
    ]);
    const syntax = ts.createSourceFile("package-macos.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const createRuntimeTree = syntax.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "createRuntimeTree"
    );
    expect(createRuntimeTree).toBeDefined();
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(createRuntimeTree!);

    const packagedNode = nodes.find((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "packagedNode"
    );
    const packagedNodeInitializer = packagedNode?.initializer;
    expect(packagedNodeInitializer && ts.isCallExpression(packagedNodeInitializer)).toBe(true);
    if (!packagedNodeInitializer || !ts.isCallExpression(packagedNodeInitializer)) throw new Error("packagedNode initializer is not a call");
    expect(
      ts.isPropertyAccessExpression(packagedNodeInitializer.expression) &&
      ts.isIdentifier(packagedNodeInitializer.expression.expression) &&
      packagedNodeInitializer.expression.expression.text === "path" &&
      packagedNodeInitializer.expression.name.text === "join"
    ).toBe(true);
    expect(packagedNodeInitializer.arguments).toHaveLength(3);
    expect(ts.isIdentifier(packagedNodeInitializer.arguments[0]) && packagedNodeInitializer.arguments[0].text).toBe("packageRoot");
    expect(ts.isStringLiteral(packagedNodeInitializer.arguments[1]) && packagedNodeInitializer.arguments[1].text).toBe("runtime");
    expect(ts.isStringLiteral(packagedNodeInitializer.arguments[2]) && packagedNodeInitializer.arguments[2].text).toBe("node");
    const copyCall = nodes.find((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "copyFileIfPresent" &&
      ts.isIdentifier(node.arguments[1]) && node.arguments[1].text === "packagedNode"
    );
    const copySource = copyCall?.arguments[0];
    expect(
      copySource && ts.isPropertyAccessExpression(copySource) && ts.isIdentifier(copySource.expression) &&
      copySource.expression.text === "process" && copySource.name.text === "execPath"
    ).toBe(true);

    const contract = JSON.parse(contractBytes);
    expect(contract.package.resources.nodeBinary).toBe("runtime/node");
  });

  it("accepts a deterministic hashed file entry and candidate binding", () => {
    const manifest = completeManifest();
    expect(validateManifestDocument(manifest)).toEqual(manifest);
  });

  it("rejects a resource path that leaves the artifact", () => {
    expect(() => assertPackageRelativePath("../../repository/native/helper", "capture helper")).toThrow(
      /escapes Meetless\.app.*Authority.*Next action/s,
    );
  });

  it("rejects an absolute packaged marker path", () => {
    expect(() => assertPackageRelativePath("/private/tmp/meetless", "packaged marker")).toThrow(/absolute or empty/);
  });

  it("rejects a Homebrew Mach-O load path", () => {
    expect(() => assertNoForbiddenLoadPath("/opt/homebrew/Cellar/ffmpeg/lib/libavcodec.dylib")).toThrow(
      /rewrite the closure to an in-package @loader_path/s,
    );
  });

  it("resolves @loader_path from the loading image and rejects a same-basename fallback", async () => {
    const root = await symlinkFixture();
    const binary = path.join(root, "Contents", "Resources", "Frameworks", "Loader");
    const exact = path.join(root, "Contents", "Resources", "Frameworks", "Declared", "libExact.dylib");
    const unrelated = path.join(root, "Contents", "Resources", "Elsewhere", "libExact.dylib");
    const unrelatedFallback = path.join(root, "Contents", "Resources", "Elsewhere", "libFallback.dylib");
    await mkdir(path.dirname(exact), { recursive: true });
    await mkdir(path.dirname(unrelated), { recursive: true });
    await writeFile(binary, "loader\n");
    await writeFile(exact, "exact\n");
    await writeFile(unrelated, "unrelated\n");
    await writeFile(unrelatedFallback, "unrelated fallback\n");
    const entries = new Set([
      "Contents/Resources/Frameworks/Loader",
      "Contents/Resources/Frameworks/Declared/libExact.dylib",
      "Contents/Resources/Elsewhere/libExact.dylib",
      "Contents/Resources/Elsewhere/libFallback.dylib",
    ]);
    await expect(validateLoadPathClosure(
      "Contents/Resources/Frameworks/Loader",
      binary,
      root,
      entries,
      ["@rpath/libExact.dylib"],
      ["@loader_path/Declared"],
    )).resolves.toBeUndefined();
    await expect(validateLoadPathClosure(
      "Contents/Resources/Frameworks/Loader",
      binary,
      root,
      entries,
      ["@rpath/missing.dylib"],
      ["@loader_path/Declared"],
    )).rejects.toThrow(/does not resolve inside the artifact/);
    await expect(validateLoadPathClosure(
      "Contents/Resources/Frameworks/Loader",
      binary,
      root,
      entries,
      ["@rpath/libFallback.dylib"],
      ["@loader_path/Declared"],
    )).rejects.toThrow(/does not resolve inside the artifact/);
    expect(resolveLoadPath(binary, "@loader_path/", "Declared/libExact.dylib")).toBe(exact);
  });

  it("uses the applicable app executable for @executable_path and inherited @rpath context", async () => {
    const root = await symlinkFixture();
    const appRoot = path.join(root, "Electron.app");
    const executable = path.join(appRoot, "Contents", "MacOS", "Electron");
    const framework = path.join(appRoot, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
    const squirrel = path.join(appRoot, "Contents", "Frameworks", "Squirrel", "libSquirrel.dylib");
    const reactive = path.join(appRoot, "Contents", "Frameworks", "ReactiveObjC", "libReactiveObjC.dylib");
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(path.dirname(framework), { recursive: true });
    await mkdir(path.dirname(squirrel), { recursive: true });
    await mkdir(path.dirname(reactive), { recursive: true });
    await Promise.all([executable, framework, squirrel, reactive].map((candidate) => writeFile(candidate, `${candidate}\n`)));
    const entries = new Set([path.relative(root, executable), path.relative(root, framework), path.relative(root, squirrel), path.relative(root, reactive)].map((entry) => entry.split(path.sep).join("/")));
    await expect(validateMacOSLoadPathClosure([
      {
        relative: path.relative(root, executable).split(path.sep).join("/"),
        binary: executable,
        dependencies: ["@loader_path/../Frameworks/Electron Framework.framework/Versions/A/Electron Framework"],
        rpaths: ["@loader_path/../Frameworks"],
      },
      {
        relative: path.relative(root, framework).split(path.sep).join("/"),
        binary: framework,
        dependencies: ["@executable_path/../Frameworks/Squirrel/libSquirrel.dylib", "@rpath/ReactiveObjC/libReactiveObjC.dylib"],
        rpaths: [],
      },
      {
        relative: path.relative(root, squirrel).split(path.sep).join("/"),
        binary: squirrel,
        dependencies: [],
        rpaths: [],
      },
      {
        relative: path.relative(root, reactive).split(path.sep).join("/"),
        binary: reactive,
        dependencies: [],
        rpaths: [],
      },
    ], root, entries)).resolves.toBeUndefined();
  });

  it("rejects a dyld directory target", async () => {
    const root = await symlinkFixture();
    const binary = path.join(root, "Contents", "Resources", "Loader");
    const directory = path.join(root, "Contents", "Resources", "Frameworks", "Directory.dylib");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "loader\n");
    await mkdir(directory, { recursive: true });
    await expect(validateLoadPathClosure(
      "Contents/Resources/Loader",
      binary,
      root,
      new Set(["Contents/Resources/Loader", "Contents/Resources/Frameworks/Directory.dylib"]),
      ["@loader_path/Frameworks/Directory.dylib"],
      [],
    )).rejects.toThrow(/does not resolve inside the artifact/);
  });

  it("rejects an extra, missing, changed, or retargeted artifact entry", () => {
    const expected = [{ path: "Contents/Info.plist", type: "file", size: 3, sha256: "a".repeat(64) }];
    expect(() => compareManifestEntrySets(expected, [...expected, {
      path: "Contents/extra", type: "file", size: 1, sha256: "b".repeat(64),
    }])).toThrow(/extra=Contents\/extra/);
    expect(() => compareManifestEntrySets(expected, [])).toThrow(/missing=Contents\/Info\.plist/);
    expect(() => compareManifestEntrySets(expected, [{ ...expected[0], size: 4 }])).toThrow(/size.*changed/);
    expect(() => compareManifestEntrySets(
      [{ path: "Contents/link", type: "symlink", target: "old", sha256: hash("old") }],
      [{ path: "Contents/link", type: "symlink", target: "new", sha256: hash("new") }],
    )).toThrow(/target.*changed/);
  });

  it("validates resolved package symlink targets and preserves internal relative links", async () => {
    const root = await symlinkFixture();
    const target = path.join(root, "Contents", "target.txt");
    const link = path.join(root, "Contents", "link");
    await symlink("target.txt", link);
    await expect(validatePackageSymlinkClosure(root, [{
      path: "Contents/link",
      type: "symlink",
      target: "target.txt",
      sha256: hash("target.txt"),
    }])).resolves.toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("inside\n");
  });

  it.each([
    ["absolute", (root: string) => path.join(root, "outside.txt"), (root: string) => path.join(root, "outside.txt")],
    ["escaping", (root: string) => path.join(root, "outside.txt"), () => "../../outside.txt"],
    ["dangling", null, () => "missing.txt"],
  ])("rejects %s package symlinks", async (_label, outsideFactory, targetFactory) => {
    const root = await symlinkFixture();
    if (outsideFactory) await writeFile(outsideFactory(root), "outside\n");
    const link = path.join(root, "Contents", "link");
    const target = typeof targetFactory === "function" ? targetFactory(root) : targetFactory;
    await symlink(target, link);
    await expect(validatePackageSymlinkClosure(root, [{
      path: "Contents/link",
      type: "symlink",
      target,
      sha256: hash(target),
    }])).rejects.toThrow(/absolute target|escapes Meetless\.app|dangling/);
  });

  it("rejects a link whose target text stays inside but realpath escapes", async () => {
    const root = await symlinkFixture();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "meetless-symlink-external-"));
    symlinkFixtureRoots.add(outsideRoot);
    const outside = path.join(outsideRoot, "outside.txt");
    const redirect = path.join(root, "Contents", "redirect");
    await writeFile(outside, "outside\n");
    await symlink(path.relative(path.dirname(redirect), outside), redirect);
    const link = path.join(root, "Contents", "link");
    await symlink("redirect", link);
    await expect(validatePackageSymlinkClosure(root, [{
      path: "Contents/link",
      type: "symlink",
      target: "redirect",
      sha256: hash("redirect"),
    }])).rejects.toThrow(/resolves outside Meetless\.app/);
  });

  it("accepts complete isolated component coverage", () => {
    const manifest = completeManifest();
    expect(validateLicenseInventoryCoverage(
      manifest.inventory,
      manifest.entries,
      manifest.licenseInventory,
      manifest.macho,
    )).toEqual({ mappedPaths: manifest.entries.length, components: REQUIRED_LICENSE_COMPONENTS.length });
  });

  it("accepts and binds the isolated package-input manifest", () => {
    const manifest = completeManifest();
    expect(validateMacOSPackageInputDocument(manifest.packageInputs, manifest.candidateSnapshot)).toEqual(manifest.packageInputs);
  });

  it("rejects a stale package-input mutation", () => {
    const manifest = completeManifest();
    const packageInputs = structuredClone(manifest.packageInputs);
    packageInputs.inputs[0].content.digest = "f".repeat(64);
    expect(() => validateMacOSPackageInputDocument(packageInputs, manifest.candidateSnapshot)).toThrow(
      /package-input manifest digest is stale.*rebuild the package-input manifest/s,
    );
  });

  it("accepts the full selective local package set and binds the foundation dist", async () => {
    const foundationTuple = MACOS_LOCAL_PACKAGES.find(([name]) => name === "@meetless/managed-transcription-foundation");
    expect(foundationTuple).toEqual([
      "@meetless/managed-transcription-foundation",
      "packages/managed-transcription-foundation",
      ["dist"],
      [],
    ]);

    const composition = await validateMacOSPackageComposition({ repositoryRoot: process.cwd() });
    expect(composition.localPackages).toEqual(MACOS_LOCAL_PACKAGES);
    expect(composition.workspaceLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        declaringPackage: "@meetless/plugin",
        dependency: "@meetless/managed-transcription-foundation",
        classification: "root-lock-workspace-link",
      }),
    ]));

    const inputSpecs = buildMacOSPackageInputSpecs();
    expect(inputSpecs.find(({ id }) => id === "managed-transcription-foundation-dist")).toMatchObject({
      kind: "generated-dist",
      sourcePaths: ["packages/managed-transcription-foundation/dist"],
      artifactPathPrefixes: ["Contents/Resources/meetless/packages/managed-transcription-foundation/"],
    });
    expect(inputSpecs.find(({ id }) => id === "package-assembly-scripts").sourcePaths).toContain(
      "scripts/lib/macos-package-composition.mjs",
    );
  });

  it("rejects the plugin workspace dependency when only its foundation tuple is omitted", async () => {
    const withoutFoundation = MACOS_LOCAL_PACKAGES.filter(([name]) => name !== "@meetless/managed-transcription-foundation");
    expect(withoutFoundation).toHaveLength(MACOS_LOCAL_PACKAGES.length - 1);

    await expect(validateMacOSPackageComposition({
      repositoryRoot: process.cwd(),
      localPackages: withoutFoundation,
    })).rejects.toThrow(
      /@meetless\/plugin[\s\S]*@meetless\/managed-transcription-foundation[\s\S]*localPackages\/selection/,
    );
  });

  it("uses one exact npm package identity for native scope and package manifests", () => {
    const runtimeRoot = "Contents/Resources/meetless";
    const nativePackages = [
      {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
        root: `${runtimeRoot}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`,
        descendants: ["README.md", "package.json", "claude"],
      },
      {
        name: "@esbuild/darwin-arm64",
        root: `${runtimeRoot}/node_modules/@esbuild/darwin-arm64`,
        descendants: ["README.md", "package.json", "bin/esbuild"],
      },
      {
        name: "@esbuild/darwin-arm64",
        root: `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64`,
        descendants: ["README.md", "package.json", "bin/esbuild"],
      },
      {
        name: "node-pty",
        root: `${runtimeRoot}/node_modules/node-pty`,
        descendants: ["README.md", "package.json", "lib/index.js"],
      },
    ];

    for (const package_ of nativePackages) {
      expect(resolveNpmPackageRoot(package_.root)).toEqual({ name: package_.name, root: package_.root });
      expect(classifyArtifactPath(package_.root, { type: "file" })).toBe("native-binaries");
      expect(isNpmPackageManifestPath(`${package_.root}/package.json`)).toBe(true);
      for (const descendant of package_.descendants) {
        const artifactPath = `${package_.root}/${descendant}`;
        expect(resolveNpmPackageRoot(artifactPath)).toEqual({ name: package_.name, root: package_.root });
        expect(classifyArtifactPath(artifactPath, { type: "file" })).toBe("native-binaries");
      }
    }

    const nestedPackageJson = `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64/package.json`;
    expect(isNpmPackageManifestPath(`${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64/lib/package.json`)).toBe(false);
    expect(classifyArtifactPath(`${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64/lib/package.json`, { type: "file" })).toBe("native-binaries");
    expect(resolveNpmPackageRoot(`${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64-extra/package.json`)).toEqual({
      name: "@esbuild/darwin-arm64-extra",
      root: `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64-extra`,
    });

    for (const artifactPath of [
      `${runtimeRoot}/node_modules/convex/package.json`,
      `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-x64/package.json`,
      `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64-extra/package.json`,
      `${runtimeRoot}/node_modules/convex/node_modules/esbuild/package.json`,
      `${runtimeRoot}/node_modules/convex/node_modules/ws/index.js`,
    ]) {
      expect(classifyArtifactPath(artifactPath, { type: "file" })).toBe("js-closure");
    }
    expect(isNpmPackageManifestPath(nestedPackageJson)).toBe(true);
    expect(classifyArtifactPath(`${runtimeRoot}/node_modules/sherpa-onnx-darwin-arm64/package.json`, { type: "file" })).toBe("sherpa-model-assets");
  });

  it("executes clean-checkout native source projection and provenance coverage", () => {
    const manifest = completeManifestWithNativePackages();
    const native = manifest.inventory.components.find((component) => component.id === "native-binaries");
    const nativePackageRoots = [
      "Contents/Resources/meetless/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "Contents/Resources/meetless/node_modules/@esbuild/darwin-arm64",
      "Contents/Resources/meetless/node_modules/convex/node_modules/@esbuild/darwin-arm64",
      "Contents/Resources/meetless/node_modules/convex/node_modules/node-pty",
    ];

    expect(validateLicenseInventoryCoverage(
      manifest.inventory,
      manifest.entries,
      manifest.licenseInventory,
      manifest.macho,
    )).toEqual({ mappedPaths: manifest.entries.length, components: REQUIRED_LICENSE_COMPONENTS.length });
    for (const root of nativePackageRoots) {
      const descendants = manifest.entries.filter(({ path: artifactPath }) => artifactPath.startsWith(`${root}/`));
      expect(descendants.length).toBeGreaterThan(0);
      expect(descendants.every((entry) => classifyArtifactPath(entry.path, entry, new Set(manifest.macho)) === "native-binaries")).toBe(true);
      expect(isNpmPackageManifestPath(`${root}/package.json`)).toBe(true);
    }

    expect(isNpmPackageManifestPath(`${nativePackageRoots[2]}/lib/package.json`)).toBe(false);
    expect(classifyArtifactPath("Contents/Resources/meetless/node_modules/convex/package.json", { type: "file" })).toBe("js-closure");
    expect(classifyArtifactPath("Contents/Resources/meetless/node_modules/sherpa-onnx-darwin-arm64/package.json", { type: "file" })).toBe("sherpa-model-assets");
    expect(native.provenance.artifactMembers.map((member) => member.artifactPath)).toEqual([...manifest.macho].sort());
    expect(native.provenance.artifactMembers.every((member) => manifest.macho.includes(member.artifactPath))).toBe(true);
    expect(native.provenance.artifactMembers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactPath: `${nativePackageRoots[1]}/bin/esbuild`,
        sourcePaths: ["node_modules/@esbuild/darwin-arm64"],
      }),
      expect.objectContaining({
        artifactPath: `${nativePackageRoots[2]}/bin/esbuild`,
        sourcePaths: ["node_modules/convex/node_modules/@esbuild/darwin-arm64"],
      }),
      expect.objectContaining({
        artifactPath: `${nativePackageRoots[3]}/prebuilds/darwin-arm64/pty.node`,
        sourcePaths: ["node_modules/convex/node_modules/node-pty"],
      }),
    ]));
    expect(native.provenance.artifactMembers.flatMap((member) => member.sourcePaths)).not.toContain(
      "node_modules/convex/node_modules",
    );
    expect(native.provenance.artifactMembers.find((member) => member.artifactPath.endsWith("/package.json"))).toBeUndefined();

    const nestedPackageJson = `${nativePackageRoots[2]}/package.json`;
    const omitted = structuredClone(manifest.inventory);
    const omittedNative = omitted.components.find((component) => component.id === "native-binaries");
    omittedNative.provenance.packageMembers = omittedNative.provenance.packageMembers.filter((member) => member.packageJsonPath !== nestedPackageJson);
    expect(() => validateLicenseInventoryCoverage(omitted, manifest.entries, null, manifest.macho)).toThrow(
      /package member .*convex\/node_modules\/@esbuild\/darwin-arm64\/package\.json has no provenance record/,
    );

    const misassigned = structuredClone(manifest.inventory);
    const misassignedNative = misassigned.components.find((component) => component.id === "native-binaries");
    const nestedMember = misassignedNative.provenance.packageMembers.find((member) => member.packageJsonPath === nestedPackageJson);
    misassignedNative.provenance.packageMembers = misassignedNative.provenance.packageMembers.filter((member) => member.packageJsonPath !== nestedPackageJson);
    const misassignedJs = misassigned.components.find((component) => component.id === "js-closure");
    misassignedJs.provenance.packageMembers = [{ ...nestedMember, component: "js-closure" }];
    expect(() => validateLicenseInventoryCoverage(misassigned, manifest.entries, null, manifest.macho)).toThrow(
      /js-closure child member .*convex\/node_modules\/@esbuild\/darwin-arm64\/package\.json is outside its component scope/,
    );
  });

  it.runIf(existsSync(retainedFailedArtifactPath) && existsSync(retainedFailedInventoryPath))(
    "regenerates retained failed-artifact inventory coverage with exact nested native provenance",
    async () => {
      const manifest = JSON.parse(await readFile(path.join(retainedFailedProofRoot, "release/macos/composition-manifest.json"), "utf8"));
      const priorInventory = JSON.parse(await readFile(retainedFailedInventoryPath, "utf8"));
      const runtimeRoot = "Contents/Resources/meetless";
      const topLevelEsbuildRoot = `${runtimeRoot}/node_modules/@esbuild/darwin-arm64`;
      const nestedEsbuildRoot = `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64`;
      const anthropicRoot = `${runtimeRoot}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`;
      const nodePtyRoot = `${runtimeRoot}/node_modules/node-pty`;
      const machoPaths = new Set(manifest.macho);
      const candidateSnapshot = {
        ...manifest.candidateSnapshot,
        dependencyArtifacts: { paseo: { expectedCommit: manifest.candidateSnapshot.paseoCommit } },
      };
      const workspaceMembers = await collectWorkspaceMembers(retainedFailedArtifactPath);
      const packageMetadata = await collectMacOSPackageMetadata(
        path.join(retainedFailedArtifactPath, "Contents/Resources/meetless"),
        process.cwd(),
        workspaceMembers,
      );
      const packageMembers = [...packageMetadata.members].sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
      const packageInputManifest = {
        ...manifest.packageInputs,
        packageMembers,
        packageMemberDigest: digestJson(packageMembers),
        digest: undefined,
      };
      packageInputManifest.digest = digestJson(packageInputManifest);

      const regenerated = await buildMacOSLicenseInventory({
        bundlePath: retainedFailedArtifactPath,
        repositoryRoot: process.cwd(),
        candidateSnapshot,
        packageInputManifest,
        packageMetadata,
      });
      expect(validateLicenseInventoryCoverage(regenerated, manifest.entries, null, manifest.macho)).toEqual({
        mappedPaths: manifest.entries.length,
        components: REQUIRED_LICENSE_COMPONENTS.length,
      });

      expect(priorInventory.summary.componentPathCounts["native-binaries"]).toBe(61);
      expect(priorInventory.summary.componentPathCounts["js-closure"]).toBe(14966);
      expect(regenerated.summary.componentPathCounts["native-binaries"]).toBe(63);
      expect(regenerated.summary.componentPathCounts["js-closure"]).toBe(14964);

      const pathsUnder = (root: string) => manifest.entries.filter(({ path: artifactPath }: { path: string }) => artifactPath.startsWith(`${root}/`));
      for (const root of [topLevelEsbuildRoot, nestedEsbuildRoot, anthropicRoot, nodePtyRoot]) {
        const descendants = pathsUnder(root);
        expect(descendants.length).toBeGreaterThan(0);
        expect(descendants.every((entry: { path: string; type: string }) => classifyArtifactPath(entry.path, entry, machoPaths) === "native-binaries")).toBe(true);
      }

      const nestedPackageJson = `${nestedEsbuildRoot}/package.json`;
      expect(isNpmPackageManifestPath(nestedPackageJson)).toBe(true);
      expect(packageMetadata.members.find((member) => member.artifactPath === nestedEsbuildRoot)).toMatchObject({
        component: "native-binaries",
        packageJsonPath: nestedPackageJson,
        sourcePath: "node_modules/convex/node_modules/@esbuild/darwin-arm64",
      });
      expect(packageMetadata.members.find((member) => member.name === "convex")).toMatchObject({ component: "js-closure" });
      expect(packageMetadata.members.find((member) => member.name === "sherpa-onnx-darwin-arm64")).toMatchObject({ component: "sherpa-model-assets" });

      const native = regenerated.components.find((component) => component.id === "native-binaries");
      expect(native?.provenance.packageMembers).toEqual(expect.arrayContaining([
        expect.objectContaining({ packageJsonPath: nestedPackageJson, component: "native-binaries" }),
      ]));
      expect(native?.provenance.artifactMembers.every((member: { artifactPath: string }) => manifest.macho.includes(member.artifactPath))).toBe(true);
      const nestedEsbuildBinary = manifest.macho.find((artifactPath: string) => artifactPath.startsWith(`${nestedEsbuildRoot}/`));
      expect(nestedEsbuildBinary).toBeDefined();
      expect(native?.provenance.artifactMembers.find((member: { artifactPath: string }) => member.artifactPath === nestedEsbuildBinary)).toMatchObject({
        sourcePaths: ["node_modules/convex/node_modules/@esbuild/darwin-arm64"],
      });
      expect(native?.provenance.artifactMembers.find((member: { artifactPath: string }) => member.artifactPath === nestedPackageJson)).toBeUndefined();
      expect(native?.provenance.artifactMembers.find((member: { artifactPath: string }) => member.artifactPath.startsWith(`${nodePtyRoot}/`))).toMatchObject({
        sourcePaths: ["node_modules/node-pty"],
      });

      const omitted = structuredClone(regenerated);
      const omittedNative = omitted.components.find((component) => component.id === "native-binaries");
      omittedNative.provenance.packageMembers = omittedNative.provenance.packageMembers.filter((member) => member.packageJsonPath !== nestedPackageJson);
      expect(() => validateLicenseInventoryCoverage(omitted, manifest.entries, null, manifest.macho)).toThrow(
        /package member .*convex\/node_modules\/@esbuild\/darwin-arm64\/package\.json has no provenance record/,
      );

      const misassigned = structuredClone(regenerated);
      const misassignedNative = misassigned.components.find((component) => component.id === "native-binaries");
      const nestedMember = misassignedNative.provenance.packageMembers.find((member) => member.packageJsonPath === nestedPackageJson);
      misassignedNative.provenance.packageMembers = misassignedNative.provenance.packageMembers.filter((member) => member.packageJsonPath !== nestedPackageJson);
      const misassignedJs = misassigned.components.find((component) => component.id === "js-closure");
      misassignedJs.provenance.packageMembers = [...(misassignedJs.provenance.packageMembers ?? []), { ...nestedMember, component: "js-closure" }];
      expect(() => validateLicenseInventoryCoverage(misassigned, manifest.entries, null, manifest.macho)).toThrow(
        /js-closure child member .*convex\/node_modules\/@esbuild\/darwin-arm64\/package\.json is outside its component scope/,
      );
    },
  );

  it("domain-separates package-source identity and excludes only the two published M7 evidence files", () => {
    const head = "b".repeat(40);
    const dependencyArtifacts = { paseo: { expectedCommit: "c".repeat(40) } };
    expect(PACKAGE_SOURCE_EXCLUDED_PATHS).toEqual([
      "test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json",
      "test/evidence/m7/m7-f6-real-no-timestamp-signing-validation.json",
    ]);
    const [f3EvidencePath, f6EvidencePath] = PACKAGE_SOURCE_EXCLUDED_PATHS;
    const otherEvidencePath = "test/evidence/m7/other-controlled-proof.json";
    const files = [
      { path: f3EvidencePath, status: "??", mode: "644", sha256: "a".repeat(64) },
      { path: f6EvidencePath, status: "??", mode: "644", sha256: "b".repeat(64) },
      { path: otherEvidencePath, status: "??", mode: "644", sha256: "c".repeat(64) },
      { path: "packages/runtime/src/config.ts", status: " M", mode: "644", sha256: "d".repeat(64) },
    ];
    const packageSourceDigest = digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts });
    const packageInputDigest = digestJson({ sourceSnapshotDigest: packageSourceDigest, artifactInputDigest: "e".repeat(64) });
    const artifactDigest = digestJson({ packageInputDigest, artifactInputDigest: "e".repeat(64) });
    const f3EvidenceEdited = files.map((file) => file.path === f3EvidencePath ? { ...file, sha256: "e".repeat(64) } : file);
    const f6EvidenceAdded = files.map((file) => file.path === f6EvidencePath ? { ...file, sha256: "f".repeat(64) } : file);
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: f3EvidenceEdited, dependencyArtifacts })).toBe(packageSourceDigest);
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: f6EvidenceAdded, dependencyArtifacts })).toBe(packageSourceDigest);
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts })).toBe(
      digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: "default", head, files: f3EvidenceEdited, dependencyArtifacts })).not.toBe(
      digestSnapshot({ mode: "default", head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: "default", head, files: f6EvidenceAdded, dependencyArtifacts })).not.toBe(
      digestSnapshot({ mode: "default", head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts })).not.toBe(
      digestSnapshot({ mode: "default", head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: files.map((file) => file.path === otherEvidencePath ? { ...file, sha256: "e".repeat(64) } : file), dependencyArtifacts })).not.toBe(packageSourceDigest);
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: files.map((file) => file.path === "packages/runtime/src/config.ts" ? { ...file, sha256: "f".repeat(64) } : file), dependencyArtifacts })).not.toBe(packageSourceDigest);
    expect(snapshotFilesForMode(files, "default")).toEqual(files);
    expect(snapshotFilesForMode(files, PACKAGE_SOURCE_MODE)).toEqual(files.filter((file) => !PACKAGE_SOURCE_EXCLUDED_PATHS.includes(file.path)));
    expect(snapshotFilesForMode(files, "default").map((file) => file.path)).toEqual(expect.arrayContaining([f3EvidencePath, f6EvidencePath]));
    const f3PackageInputDigest = digestJson({ sourceSnapshotDigest: digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: f3EvidenceEdited, dependencyArtifacts }), artifactInputDigest: "e".repeat(64) });
    const f6PackageInputDigest = digestJson({ sourceSnapshotDigest: digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: f6EvidenceAdded, dependencyArtifacts }), artifactInputDigest: "e".repeat(64) });
    expect(f3PackageInputDigest).toBe(packageInputDigest);
    expect(f6PackageInputDigest).toBe(packageInputDigest);
    expect(digestJson({ packageInputDigest: f3PackageInputDigest, artifactInputDigest: "e".repeat(64) })).toBe(artifactDigest);
    expect(digestJson({ packageInputDigest: f6PackageInputDigest, artifactInputDigest: "e".repeat(64) })).toBe(artifactDigest);
    expect(PACKAGE_SOURCE_SNAPSHOT_COMMAND).toBe("node scripts/candidate-snapshot.mjs --mode=package-source");
  });

  it("rejects a broad or stale package-source evidence exclusion", () => {
    const broadFiles = [{ path: "test/evidence/m7/other-controlled-proof.json", status: "??", mode: "644", sha256: "a".repeat(64) }];
    expect(snapshotFilesForMode(broadFiles, PACKAGE_SOURCE_MODE)).toEqual(broadFiles);

    const manifest = completeManifest();
    manifest.candidateSnapshot.excludedPaths = [PACKAGE_SOURCE_EXCLUDED_PATHS[0]];
    expect(() => validateManifestDocument(manifest)).toThrow(
      /manifest candidate snapshot binding is missing or invalid.*rebuild from node scripts\/candidate-snapshot\.mjs/s,
    );
  });

  it("consumes NUL-delimited Git rename/copy pairs once at the current path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-snapshot-git-"));
    symlinkFixtureRoots.add(root);
    const git = (arguments_: string[]) => execFileSync("git", ["-C", root, ...arguments_], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Meetless fixture"]);
    const original = path.join(root, "scripts", "fixture", "original.txt");
    const current = path.join(root, "scripts", "fixture", "current.txt");
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, "rename fixture\n");
    git(["add", "scripts/fixture/original.txt"]);
    git(["commit", "-qm", "fixture"]);
    git(["mv", "scripts/fixture/original.txt", "scripts/fixture/current.txt"]);

    const renameEntries = parsePorcelainStatus(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    expect(renameEntries).toEqual([{
      status: "R ",
      path: "scripts/fixture/current.txt",
      previousPath: "scripts/fixture/original.txt",
    }]);
    expect(renameEntries.map((entry) => entry.path)).toEqual(["scripts/fixture/current.txt"]);
    expect(renameEntries.map((entry) => entry.path)).not.toContain("scripts/fixture/original.txt");
    expect(current).toBe(path.join(root, renameEntries[0].path));

    expect(parsePorcelainStatus("C  scripts/fixture/copy.txt\0scripts/fixture/current.txt\0")).toEqual([{
      status: "C  ".slice(0, 2),
      path: "scripts/fixture/copy.txt",
      previousPath: "scripts/fixture/current.txt",
    }]);
    expect(parsePorcelainStatus(" M scripts/fixture/modified.txt\0?? scripts/fixture/untracked.txt\0")).toEqual([
      { status: " M", path: "scripts/fixture/modified.txt" },
      { status: "??", path: "scripts/fixture/untracked.txt" },
    ]);
  });

  it.each([
    ["missing NUL terminator", "R  scripts/current.txt\0scripts/original.txt", /not terminated by NUL/],
    ["missing historical path", "R  scripts/current.txt\0", /has no historical path/],
    ["malformed status separator", "R scripts/current.txt\0scripts/original.txt\0", /no valid XY status separator/],
  ])("rejects %s Git status records with an actionable diagnostic", (_label, raw, diagnostic) => {
    expect(() => parsePorcelainStatus(raw)).toThrow(new RegExp(`${diagnostic.source}.*Authority: docs\/specs\/macos-artifact-validation\\.md.*Next action:`));
  });

  it("rejects acceptance evidence with the wrong source or artifact identity", () => {
    const manifest = completeManifest();
    const evidence = {
      candidate: {
        sourceSnapshotMode: manifest.candidateSnapshot.mode,
        sourceSnapshotExcludedPaths: manifest.candidateSnapshot.excludedPaths,
        sourceSnapshotDigest: manifest.candidateSnapshot.digest,
        sourceSnapshotHead: manifest.candidateSnapshot.head,
        packageInputDigest: manifest.packageInputs.digest,
        artifactInputDigest: manifest.packageInputs.artifactInput.digest,
        artifactDigest: manifest.artifactDigest,
        paseoCommit: manifest.candidateSnapshot.paseoCommit,
      },
    };
    expect(validateAcceptanceEvidenceBinding(evidence, manifest)).toEqual(evidence);

    const wrongSource = structuredClone(evidence);
    wrongSource.candidate.sourceSnapshotDigest = "f".repeat(64);
    expect(() => validateAcceptanceEvidenceBinding(wrongSource, manifest)).toThrow(/candidate identity differs/);

    const wrongArtifact = structuredClone(evidence);
    wrongArtifact.candidate.artifactDigest = "e".repeat(64);
    expect(() => validateAcceptanceEvidenceBinding(wrongArtifact, manifest)).toThrow(/candidate identity differs/);
  });

  it("accepts package and workspace child provenance, then rejects removal or misassignment", () => {
    const manifest = completeManifestWithMembers();
    expect(validateLicenseInventoryCoverage(
      manifest.inventory,
      manifest.entries,
      manifest.licenseInventory,
      manifest.macho,
    )).toEqual({ mappedPaths: manifest.entries.length, components: REQUIRED_LICENSE_COMPONENTS.length });

    const removed = completeManifestWithMembers();
    removed.inventory.components.find((component) => component.id === "js-closure").provenance.packageMembers = [];
    expect(() => validateLicenseInventoryCoverage(removed.inventory, removed.entries, removed.licenseInventory, removed.macho)).toThrow(
      /no provenance record/,
    );

    const misassigned = completeManifestWithMembers();
    const member = misassigned.inventory.components.find((component) => component.id === "js-closure").provenance.packageMembers[0];
    member.artifactPath = "Contents/Resources/meetless/node_modules/native-example";
    expect(() => validateLicenseInventoryCoverage(misassigned.inventory, misassigned.entries, misassigned.licenseInventory, misassigned.macho)).toThrow(
      /outside its component scope/,
    );

    const wrongOwner = completeManifestWithMembers();
    wrongOwner.inventory.components.find((component) => component.id === "js-closure").provenance.packageMembers[0].component = "native-binaries";
    expect(() => validateLicenseInventoryCoverage(wrongOwner.inventory, wrongOwner.entries, wrongOwner.licenseInventory, wrongOwner.macho)).toThrow(
      /provenance is malformed or duplicated/,
    );
  });

  it("rejects incomplete lock v3 evidence for a shipped package member", () => {
    const manifest = completeManifestWithMembers();
    const member = manifest.inventory.components.find((component) => component.id === "js-closure").provenance.packageMembers[0];
    member.lockEvidence.integrity = null;
    expect(() => validateLicenseInventoryCoverage(manifest.inventory, manifest.entries, manifest.licenseInventory, manifest.macho)).toThrow(
      /incomplete matched lock evidence.*integrity/,
    );
  });

  it("rejects an unmapped artifact path with the inventory rule", () => {
    const manifest = completeManifest();
    const inventory = structuredClone(manifest.inventory);
    const meetless = inventory.components.find((component) => component.id === "meetless");
    meetless.artifactPathScope.paths = meetless.artifactPathScope.paths.filter((entry) => entry !== "Contents/Info.plist");
    meetless.artifactPathScope.count = meetless.artifactPathScope.paths.length;
    expect(() => validateLicenseInventoryCoverage(inventory, manifest.entries, manifest.licenseInventory)).toThrow(
      /artifact path Contents\/Info\.plist has no component\/provenance mapping.*complete artifact closure/s,
    );
  });

  it("fails readiness while a required owner decision is unresolved", () => {
    expect(() => assertDistributionReadiness(completeManifest().inventory)).toThrow(
      /repository-declared technical obligations remain unresolved.*Human\/legal/s,
    );
  });

  it("requires non-empty, repository-bound resolution evidence for a resolved decision", async () => {
    const empty = completeManifest().inventory;
    empty.components[0].ownerDecision.status = "resolved";
    empty.components[0].ownerDecision.resolutionEvidence = {};
    expect(() => validateLicenseInventoryDocument(empty)).toThrow(/resolution evidence is empty or incomplete/);

    const stale = completeManifest().inventory;
    const authorityPath = "docs/decisions/0001-maintained-paseo-fork.md";
    const authoritySha256 = hash(await readFile(authorityPath));
    stale.components[0].ownerDecision.status = "resolved";
    stale.components[0].ownerDecision.resolutionEvidence = {
      authorityRecord: { path: authorityPath, sha256: authoritySha256 },
      ownerDecisionRecord: { path: authorityPath, sha256: authoritySha256 },
      relevantEvidence: [{ path: "docs/decisions/missing-owner-record.md", sha256: "0".repeat(64) }],
    };
    validateLicenseInventoryDocument(stale);
    await expect(validateResolutionEvidencePaths(stale, process.cwd())).rejects.toThrow(/missing or stale/);
  });

  it("accepts only verified text notice names and rejects mismatched notice bytes", () => {
    expect(isVerifiedNoticeName("LICENSE.md")).toBe(true);
    expect(isVerifiedNoticeName("COPYING.LGPLv3")).toBe(true);
    expect(isVerifiedNoticeName("notice.txt")).toBe(true);
    expect(isVerifiedNoticeName("notice.js")).toBe(false);
    expect(isVerifiedNoticeName("notice.ts")).toBe(false);

    const inventory = completeManifest().inventory;
    inventory.components[0].shippedNotice.records[0].artifactSha256 = "d".repeat(64);
    expect(() => validateLicenseInventoryDocument(inventory)).toThrow(/unbound or duplicated notice record/);
  });

  it("rejects a stale derived member count", () => {
    const manifest = completeManifest();
    manifest.inventory.summary.packageMemberCount = 1;
    expect(() => validateLicenseInventoryCoverage(manifest.inventory, manifest.entries, manifest.licenseInventory, manifest.macho)).toThrow(
      /package\/workspace member counts are stale/,
    );
  });
});

function completeManifest() {
  const inventoryPath = MACOS_LICENSE_INVENTORY_PATH;
  const entries = [
    { path: "Contents/Info.plist", type: "file", size: 3, sha256: "a".repeat(64) },
    { path: inventoryPath, type: "file", size: 3, sha256: "b".repeat(64) },
  ];
  const components = REQUIRED_LICENSE_COMPONENTS.map((id) => {
    const paths = id === "meetless" ? ["Contents/Info.plist", inventoryPath] : [];
    return {
      id,
      artifactPathScope: { kind: "exact-paths", count: paths.length, paths },
      provenance: {
        sourceType: "isolated-fixture",
        sourcePaths: ["fixture"],
        versionOrHash: { artifactScopeSha256: digestComponentEntries(entries, paths) },
      },
      declaredLicenseEvidence: { status: "available", paths: ["fixture"] },
      shippedNotice: {
        status: "available",
        paths: ["fixture"],
        records: [{
          artifactPath: "fixture",
          sourcePath: "fixture",
          sourceKind: "packaged-npm-member",
          sourceSha256: "c".repeat(64),
          artifactSha256: "c".repeat(64),
          byteBound: true,
        }],
      },
      sourceBuildMaterial: { status: "available", paths: ["fixture"] },
      ownerDecision: {
        required: true,
        owner: "Human/legal",
        status: "unresolved",
        rule: MACOS_LICENSE_INVENTORY_AUTHORITY,
        nextAction: "record the fixture decision",
      },
    };
  });
  const inventory = {
    schema: MACOS_LICENSE_INVENTORY_SCHEMA,
    authority: MACOS_LICENSE_INVENTORY_AUTHORITY,
    target: "macos-arm64",
    artifact: {
      bundlePath: "Meetless.app",
      manifestPath: MACOS_LICENSE_INVENTORY_MANIFEST_PATH,
      inventoryPath,
      candidateSnapshot: {
        command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
        mode: PACKAGE_SOURCE_MODE,
        excludedPaths: [...PACKAGE_SOURCE_EXCLUDED_PATHS],
        digest: "d".repeat(64),
        head: "b".repeat(40),
        paseoCommit: "7618cda71e2836f9ba7e821286504841203cb745",
      },
      entryBinding: {
        algorithm: "sha256",
        digest: digestArtifactEntries(entries),
        excludedPathPrefixes: MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES,
        excludedPaths: MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS,
      },
    },
    overlapRules: [],
    components,
    unresolvedOwnerDecisions: [],
  };
  const packageInputBase = {
    schema: MACOS_PACKAGE_INPUT_SCHEMA,
    authority: MACOS_PACKAGE_INPUT_AUTHORITY,
    sourceSnapshot: inventory.artifact.candidateSnapshot,
    inputs: [{
      id: "fixture-input",
      kind: "fixture",
      sourcePaths: ["fixture"],
      artifactPathPrefixes: ["Contents/"],
      content: { algorithm: "sha256", digest: "e".repeat(64), entryCount: 1 },
    }],
    packageMembers: [],
    workspaceMembers: [],
    lockMetadataGaps: [],
    artifactInput: {
      algorithm: "sha256",
      digest: digestArtifactEntries(entries, { excludedPaths: MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS }),
      entryCount: 1,
      excludedPaths: MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS,
    },
    packageMemberDigest: digestJson([]),
    workspaceMemberDigest: digestJson([]),
    lockMetadataGapCount: 0,
  };
  const packageInputs = { ...packageInputBase, digest: digestJson(packageInputBase) };
  inventory.artifact.packageInputBinding = {
    schema: packageInputs.schema,
    digest: packageInputs.digest,
    sourceSnapshotDigest: packageInputs.sourceSnapshot.digest,
    artifactInputDigest: packageInputs.artifactInput.digest,
    packageMemberDigest: packageInputs.packageMemberDigest,
    workspaceMemberDigest: packageInputs.workspaceMemberDigest,
    inputCount: packageInputs.inputs.length,
    packageMemberCount: 0,
    workspaceMemberCount: 0,
    lockMetadataGapCount: 0,
  };
  inventory.summary = {
    artifactEntryCount: entries.length,
    componentCount: components.length,
    componentPathCounts: Object.fromEntries(components.map((component) => [component.id, component.artifactPathScope.paths.length])),
    packageMemberCount: 0,
    packageMemberDigest: digestJson([]),
    workspaceMemberCount: 0,
    workspaceMemberDigest: digestJson([]),
    lockMetadataGapCount: 0,
    historicalAuthorityLockMetadataGapCount: 28,
    historicalAuthority: MACOS_LICENSE_INVENTORY_AUTHORITY,
    countRule: "All current counts are derived from this final inventory; 28 is the historical authority value and is not the current scan result.",
  };
  const signing = createSigningMetadata({
    mode: "local-ad-hoc",
    requestedIdentity: "-",
    order: { nestedMachO: [], outer: "Meetless.app", all: ["Meetless.app"] },
    outer: {
      path: "Meetless.app",
      identifier: "com.meetless.app",
      identity: "-",
      teamId: null,
      signature: "adhoc",
      authorities: [],
      flags: ["adhoc"],
      hardenedRuntime: false,
      entitlementsSha256: null,
      cdHash: "a".repeat(40),
      timestamp: "none",
      secureTimestamp: false,
    },
    nestedMachO: [],
  });
  const manifest = {
    schema: "MEETLESS_MACOS_PACKAGE v2",
    target: "macos-arm64",
    bundlePath: "Meetless.app",
    packageRoot: "Contents/Resources/meetless",
    packageMarker: "Contents/Resources/meetless/meetless-package.json",
    sourceCommit: "b".repeat(40),
    paseoCommit: "7618cda71e2836f9ba7e821286504841203cb745",
    candidateSnapshot: {
      command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
      mode: PACKAGE_SOURCE_MODE,
      excludedPaths: [...PACKAGE_SOURCE_EXCLUDED_PATHS],
      digest: "d".repeat(64),
      head: "b".repeat(40),
      paseoCommit: "7618cda71e2836f9ba7e821286504841203cb745",
    },
    host: {
      bundleIdentifier: "com.meetless.app",
      canonicalPath: "/Applications/Meetless.app",
      tccOwner: "sole Meetless host",
    },
    renderer: { entry: "Contents/Info.plist", sha256: "a".repeat(64), size: 3 },
    licenseInventory: {
      schema: MACOS_LICENSE_INVENTORY_SCHEMA,
      path: inventoryPath,
      sha256: "b".repeat(64),
      artifactEntryDigest: inventory.artifact.entryBinding.digest,
      excludedPathPrefixes: MACOS_LICENSE_INVENTORY_EXCLUDED_PATH_PREFIXES,
      excludedPaths: MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS,
      componentCount: components.length,
      packageInputDigest: packageInputs.digest,
      packageInputArtifactDigest: packageInputs.artifactInput.digest,
    },
    packageInputs,
    signing,
    entries,
    macho: [],
  };
  const candidate = { ...manifest, artifactDigest: digestManifest({ ...manifest, artifactDigest: undefined }) };
  Object.defineProperty(candidate, "inventory", { value: inventory, enumerable: false });
  return candidate;
}

function completeManifestWithNativePackages() {
  const manifest = completeManifest();
  const runtimeRoot = "Contents/Resources/meetless";
  const packages = [
    {
      name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      root: `${runtimeRoot}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`,
      descendants: ["package.json", "README.md", "claude"],
      macho: "claude",
    },
    {
      name: "@esbuild/darwin-arm64",
      root: `${runtimeRoot}/node_modules/@esbuild/darwin-arm64`,
      descendants: ["package.json", "README.md", "bin/esbuild"],
      macho: "bin/esbuild",
    },
    {
      name: "@esbuild/darwin-arm64",
      root: `${runtimeRoot}/node_modules/convex/node_modules/@esbuild/darwin-arm64`,
      descendants: ["package.json", "lib/package.json", "bin/esbuild"],
      macho: "bin/esbuild",
    },
    {
      name: "node-pty",
      root: `${runtimeRoot}/node_modules/convex/node_modules/node-pty`,
      descendants: ["package.json", "lib/index.js", "prebuilds/darwin-arm64/pty.node"],
      macho: "prebuilds/darwin-arm64/pty.node",
    },
  ];
  const entries = packages.flatMap(({ root, descendants }) => descendants.map((descendant) => ({
    path: `${root}/${descendant}`,
    type: "file",
    size: 1,
    sha256: hash(`${root}/${descendant}`),
  })));
  const packageMembers = packages.map(({ name, root }) => {
    const sourcePath = root.slice(`${runtimeRoot}/`.length);
    const packageJsonPath = `${root}/package.json`;
    return {
      memberType: "npm-package",
      component: "native-binaries",
      artifactPath: root,
      packageJsonPath,
      sourcePath,
      name,
      version: "1.0.0",
      declaredLicense: "MIT",
      noticePaths: [],
      lockEvidence: {
        matched: true,
        status: "matched",
        lockFile: "package-lock.json",
        lockPath: sourcePath,
        canonicalPath: sourcePath,
        matchMode: "canonical-path",
        packageName: name,
        paths: [sourcePath],
        version: "1.0.0",
        license: "MIT",
        licenses: null,
        integrity: "sha512-synthetic",
        resolved: "https://registry.example.invalid/synthetic-1.0.0.tgz",
        licenseMetadataStatus: "available",
      },
    };
  }).sort((left, right) => left.packageJsonPath.localeCompare(right.packageJsonPath));
  manifest.entries = [...manifest.entries, ...entries];
  manifest.macho = packages.map(({ root, macho }) => `${root}/${macho}`);

  const native = manifest.inventory.components.find((component) => component.id === "native-binaries");
  native.artifactPathScope.paths.push(...entries.map((entry) => entry.path));
  native.artifactPathScope.paths.sort();
  native.artifactPathScope.count = native.artifactPathScope.paths.length;
  native.provenance.packageMembers = packageMembers;
  native.provenance.artifactMembers = buildArtifactMembers("native-binaries", native.artifactPathScope.paths, {
    entries: manifest.entries,
    machoPaths: new Set(manifest.macho),
  });

  const excludedPaths = [...new Set([MACOS_LICENSE_INVENTORY_PATH, ...manifest.macho])].sort((left, right) => left.localeCompare(right));
  manifest.inventory.artifact.entryBinding.excludedPaths = excludedPaths;
  manifest.inventory.artifact.entryBinding.digest = digestArtifactEntries(manifest.entries, { excludedPaths });
  for (const component of manifest.inventory.components) {
    component.provenance.versionOrHash.artifactScopeSha256 = digestComponentEntries(
      manifest.entries,
      component.artifactPathScope.paths,
      { excludedPaths },
    );
  }

  const packageInputs = manifest.packageInputs;
  packageInputs.packageMembers = packageMembers;
  packageInputs.packageMemberDigest = digestJson(packageMembers);
  packageInputs.artifactInput.excludedPaths = excludedPaths;
  packageInputs.artifactInput.digest = digestArtifactEntries(manifest.entries, { excludedPaths });
  packageInputs.artifactInput.entryCount = manifest.entries.filter((entry) => !excludedPaths.includes(entry.path)).length;
  packageInputs.digest = digestJson({ ...packageInputs, digest: undefined });
  const packageInputBinding = manifest.inventory.artifact.packageInputBinding;
  packageInputBinding.digest = packageInputs.digest;
  packageInputBinding.artifactInputDigest = packageInputs.artifactInput.digest;
  packageInputBinding.packageMemberDigest = packageInputs.packageMemberDigest;
  packageInputBinding.packageMemberCount = packageMembers.length;
  manifest.inventory.summary.artifactEntryCount = manifest.entries.length;
  manifest.inventory.summary.componentPathCounts = Object.fromEntries(
    manifest.inventory.components.map((component) => [component.id, component.artifactPathScope.paths.length]),
  );
  manifest.inventory.summary.packageMemberCount = packageMembers.length;
  manifest.inventory.summary.packageMemberDigest = packageInputs.packageMemberDigest;
  manifest.licenseInventory.excludedPaths = excludedPaths;
  manifest.licenseInventory.artifactEntryDigest = manifest.inventory.artifact.entryBinding.digest;
  manifest.licenseInventory.packageInputDigest = packageInputs.digest;
  manifest.licenseInventory.packageInputArtifactDigest = packageInputs.artifactInput.digest;
  manifest.artifactDigest = digestManifest({ ...manifest, artifactDigest: undefined });
  return manifest;
}

function completeManifestWithMembers() {
  const manifest = completeManifest();
  const packageJsonPath = "Contents/Resources/meetless/node_modules/example/package.json";
  const packageArtifactPath = "Contents/Resources/meetless/node_modules/example";
  const workspaceJsonPath = "Contents/Resources/meetless/packages/runtime/package.json";
  const workspaceArtifactPath = "Contents/Resources/meetless/packages/runtime";
  manifest.entries = [
    ...manifest.entries,
    { path: packageJsonPath, type: "file", size: 2, sha256: "c".repeat(64) },
    { path: workspaceJsonPath, type: "file", size: 2, sha256: "d".repeat(64) },
  ];
  const packageMember = {
    memberType: "npm-package",
    component: "js-closure",
    artifactPath: packageArtifactPath,
    packageJsonPath,
    sourcePath: "node_modules/example",
    name: "example",
    version: "1.0.0",
    declaredLicense: "MIT",
    noticePaths: [],
    lockEvidence: {
      matched: true,
      status: "matched",
      lockFile: "package-lock.json",
      lockPath: "node_modules/example",
      canonicalPath: "node_modules/example",
      matchMode: "canonical-path",
      packageName: "example",
      paths: ["node_modules/example"],
      version: "1.0.0",
      license: "MIT",
      licenses: null,
      integrity: "sha512-example",
      resolved: "https://registry.example.invalid/example-1.0.0.tgz",
      licenseMetadataStatus: "available",
    },
  };
  const workspaceMember = {
    memberType: "workspace-package",
    component: "meetless",
    artifactPath: workspaceArtifactPath,
    packageJsonPath: workspaceJsonPath,
    sourcePath: "packages/runtime/package.json",
    name: "@meetless/runtime",
    version: "1.0.0",
    declaredLicense: null,
    declaredLicenseEvidence: {
      status: "not-declared",
      paths: ["packages/runtime/package.json"],
      unresolved: ["Workspace package manifest does not declare a license"],
    },
  };
  const jsClosure = manifest.inventory.components.find((component) => component.id === "js-closure");
  jsClosure.artifactPathScope.paths.push(packageJsonPath);
  jsClosure.artifactPathScope.paths.sort();
  jsClosure.artifactPathScope.count = jsClosure.artifactPathScope.paths.length;
  jsClosure.provenance.packageMembers = [packageMember];
  const meetless = manifest.inventory.components.find((component) => component.id === "meetless");
  meetless.artifactPathScope.paths.push(workspaceJsonPath);
  meetless.artifactPathScope.paths.sort();
  meetless.artifactPathScope.count = meetless.artifactPathScope.paths.length;
  meetless.provenance.workspaceMembers = [workspaceMember];
  for (const component of manifest.inventory.components) {
    component.provenance.versionOrHash.artifactScopeSha256 = digestComponentEntries(
      manifest.entries,
      component.artifactPathScope.paths,
    );
  }
  manifest.inventory.artifact.entryBinding.digest = digestArtifactEntries(manifest.entries);
  const packageInputs = manifest.packageInputs;
  packageInputs.packageMembers = [packageMember];
  packageInputs.workspaceMembers = [workspaceMember];
  packageInputs.packageMemberDigest = digestJson(packageInputs.packageMembers);
  packageInputs.workspaceMemberDigest = digestJson(packageInputs.workspaceMembers);
  packageInputs.artifactInput.digest = digestArtifactEntries(manifest.entries, {
    excludedPaths: MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS,
  });
  packageInputs.artifactInput.entryCount = manifest.entries.filter((entry) => !MACOS_LICENSE_INVENTORY_EXCLUDED_PATHS.includes(entry.path)).length;
  packageInputs.digest = digestJson({ ...packageInputs, digest: undefined });
  manifest.inventory.artifact.packageInputBinding.digest = packageInputs.digest;
  manifest.inventory.artifact.packageInputBinding.artifactInputDigest = packageInputs.artifactInput.digest;
  manifest.inventory.artifact.packageInputBinding.packageMemberDigest = packageInputs.packageMemberDigest;
  manifest.inventory.artifact.packageInputBinding.workspaceMemberDigest = packageInputs.workspaceMemberDigest;
  manifest.inventory.artifact.packageInputBinding.packageMemberCount = 1;
  manifest.inventory.artifact.packageInputBinding.workspaceMemberCount = 1;
  manifest.inventory.summary.artifactEntryCount = manifest.entries.length;
  manifest.inventory.summary.componentPathCounts = Object.fromEntries(manifest.inventory.components.map((component) => [component.id, component.artifactPathScope.paths.length]));
  manifest.inventory.summary.packageMemberCount = 1;
  manifest.inventory.summary.packageMemberDigest = packageInputs.packageMemberDigest;
  manifest.inventory.summary.workspaceMemberCount = 1;
  manifest.inventory.summary.workspaceMemberDigest = packageInputs.workspaceMemberDigest;
  manifest.licenseInventory.artifactEntryDigest = manifest.inventory.artifact.entryBinding.digest;
  manifest.licenseInventory.packageInputDigest = packageInputs.digest;
  manifest.licenseInventory.packageInputArtifactDigest = packageInputs.artifactInput.digest;
  return manifest;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function symlinkFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-package-symlink-"));
  symlinkFixtureRoots.add(root);
  await mkdir(path.join(root, "Contents"), { recursive: true });
  await writeFile(path.join(root, "Contents", "target.txt"), "inside\n");
  return root;
}
