import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
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
  digestArtifactEntries,
  digestComponentEntries,
  isVerifiedNoticeName,
} from "../../../scripts/lib/macos-license-inventory.mjs";
import { MACOS_PACKAGE_INPUT_AUTHORITY, MACOS_PACKAGE_INPUT_SCHEMA, digestJson, validateMacOSPackageInputDocument } from "../../../scripts/lib/macos-package-inputs.mjs";
import { createSigningMetadata } from "../../../scripts/lib/macos-package-signing.mjs";
import { assertDistributionReadiness } from "../../../scripts/check-macos-distribution-readiness.mjs";
import {
  PACKAGE_SOURCE_EXCLUDED_PATHS,
  PACKAGE_SOURCE_MODE,
  PACKAGE_SOURCE_SNAPSHOT_COMMAND,
  digestSnapshot,
  snapshotFilesForMode,
} from "../../../scripts/candidate-snapshot.mjs";

const symlinkFixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...symlinkFixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  symlinkFixtureRoots.clear();
});

describe("macOS package composition manifest", () => {
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

  it("domain-separates package-source identity and excludes only the published M7 evidence", () => {
    const head = "b".repeat(40);
    const dependencyArtifacts = { paseo: { expectedCommit: "c".repeat(40) } };
    const evidencePath = PACKAGE_SOURCE_EXCLUDED_PATHS[0];
    const otherEvidencePath = "test/evidence/m7/other-controlled-proof.json";
    const files = [
      { path: evidencePath, status: "??", mode: "644", sha256: "a".repeat(64) },
      { path: otherEvidencePath, status: "??", mode: "644", sha256: "b".repeat(64) },
      { path: "packages/runtime/src/config.ts", status: " M", mode: "644", sha256: "c".repeat(64) },
    ];
    const evidenceEdited = files.map((file) => file.path === evidencePath ? { ...file, sha256: "d".repeat(64) } : file);
    const packageSourceDigest = digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts });
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: evidenceEdited, dependencyArtifacts })).toBe(packageSourceDigest);
    expect(digestSnapshot({ mode: "default", head, files: evidenceEdited, dependencyArtifacts })).not.toBe(
      digestSnapshot({ mode: "default", head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files, dependencyArtifacts })).not.toBe(
      digestSnapshot({ mode: "default", head, files, dependencyArtifacts }),
    );
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: files.map((file) => file.path === otherEvidencePath ? { ...file, sha256: "e".repeat(64) } : file), dependencyArtifacts })).not.toBe(packageSourceDigest);
    expect(digestSnapshot({ mode: PACKAGE_SOURCE_MODE, head, files: files.map((file) => file.path === "packages/runtime/src/config.ts" ? { ...file, sha256: "f".repeat(64) } : file), dependencyArtifacts })).not.toBe(packageSourceDigest);
    expect(snapshotFilesForMode(files, "default")).toEqual(files);
    expect(snapshotFilesForMode(files, PACKAGE_SOURCE_MODE)).toEqual(files.filter((file) => file.path !== evidencePath));
    expect(PACKAGE_SOURCE_SNAPSHOT_COMMAND).toBe("node scripts/candidate-snapshot.mjs --mode=package-source");
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
        paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e",
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
    },
    nestedMachO: [],
  });
  const manifest = {
    schema: "MEETLESS_MACOS_PACKAGE v1",
    target: "macos-arm64",
    bundlePath: "Meetless.app",
    packageRoot: "Contents/Resources/meetless",
    packageMarker: "Contents/Resources/meetless/meetless-package.json",
    sourceCommit: "b".repeat(40),
    paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e",
    candidateSnapshot: {
      command: PACKAGE_SOURCE_SNAPSHOT_COMMAND,
      mode: PACKAGE_SOURCE_MODE,
      excludedPaths: [...PACKAGE_SOURCE_EXCLUDED_PATHS],
      digest: "d".repeat(64),
      head: "b".repeat(40),
      paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e",
    },
    host: {
      bundleIdentifier: "com.meetless.app",
      canonicalPath: path.join(homedir(), "Applications", "Meetless.app"),
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
