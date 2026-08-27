import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  MEETLESS_INSTALLATION_PATH,
  MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH,
  MEETLESS_USER_SUPPORT_RELATIVE_PATH,
  resolveRuntimeConfig,
} from "../src/config.js";
import {
  assertExactInstalledHostPath,
  assertStableHostIdentity,
  expectedHostConfiguration,
  type HostIdentity,
} from "../src/host.js";
import {
  MACOS_DMG_AUTHORITY,
  MACOS_DMG_SCHEMA,
  assertMacOSDmgLayoutMatches,
  assertDmgSourceUnchanged,
  attestMacOSDmgLayout,
  digestMacOSDmgLayout,
  expectedMacOSDmgLayout,
  parseMacOSDmgArguments,
  parseMacOSProofRootArguments,
  resolveMacOSDmgPaths,
  validateMacOSDmgLayout,
  validateMacOSDmgSidecar,
} from "../../../scripts/lib/macos-dmg-contract.mjs";
import {
  MACOS_INSTALLATION_CONTRACT,
  acceptedMacOSPackagePaths,
  installationContractSha256,
  installationContractBytes,
  packagedHostConfiguration,
  packagedMarker,
} from "../../../scripts/lib/macos-package-contract.mjs";
import { validateHostConfig, validatePackagedMarker } from "../../../scripts/validate-macos-package.mjs";
import { fingerprintPath } from "../../../scripts/lib/macos-package-transaction.mjs";

const execFileAsync = promisify(execFile);

describe("M7 direct-DMG installation contract", () => {
  test("owns the exact install, per-user state, export, and package-relative values", async () => {
    const contract = JSON.parse(await readFile("scripts/lib/macos-package-contract.json", "utf8"));
    expect(contract).toEqual(MACOS_INSTALLATION_CONTRACT);
    expect(contract).toMatchObject({
      schema: "MEETLESS_INSTALLATION_CONTRACT v1",
      bundleIdentifier: "com.meetless.app",
      installPath: MEETLESS_INSTALLATION_PATH,
      userSupportRelativePath: MEETLESS_USER_SUPPORT_RELATIVE_PATH,
      recordingExportsRelativePath: MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH,
      package: {
        rootRelativeToBundle: "Contents/Resources/meetless",
        resources: {
          rendererRoot: "packages/meetless-app/dist",
          nodeBinary: "runtime/node",
          ffmpeg: "runtime/media/bin/ffmpeg",
          ffprobe: "runtime/media/bin/ffprobe",
        },
      },
    });
    expect(installationContractSha256()).toMatch(/^[a-f0-9]{64}$/u);

    const paths = acceptedMacOSPackagePaths("/Users/example");
    expect(paths).toMatchObject({
      canonicalBundlePath: "/Applications/Meetless.app",
      runtimeRoot: "/Users/example/Library/Application Support/Meetless",
      identityPath: "/Users/example/Library/Application Support/Meetless/host-identity.json",
      recordingExports: "/Users/example/Documents/meetings",
    });
    const config = resolveRuntimeConfig({ userHome: "/Users/example", repositoryRoot: process.cwd() });
    expect(config.host).toEqual({
      bundle: "/Applications/Meetless.app",
      identity: "/Users/example/Library/Application Support/Meetless/host-identity.json",
    });
    expect(config.paths.recordingExports).toBe("/Users/example/Documents/meetings");
    for (const candidate of [
      config.paths.root,
      config.paths.paseoHome,
      config.paths.electronUserData,
      config.paths.meetingStore,
      config.paths.logs,
      config.paths.daemonLog,
      config.paths.identity,
      config.paths.pidLock,
      config.paths.supervisorMarker,
      config.paths.config,
      config.paths.manifest,
      config.paths.recordingSocket,
      config.paths.transcriptionSocket,
      config.paths.transcriptionStaging,
      config.host.identity,
    ]) {
      expect(candidate.startsWith(config.paths.root + "/") || candidate === config.paths.root).toBe(true);
    }
    expect(config.paths.recordingExports).toBe("/Users/example/Documents/meetings");
    expect(config.paths.plugin).not.toContain("/private/tmp/meetless-package-runtime");
  });

  test.each([
    "/Volumes/Meetless/Meetless.app",
    "/Users/example/Desktop/Meetless.app",
    "/Applications/Other.app",
  ])("rejects an alternate runtime host path before ownership", (candidate) => {
    expect(() => assertExactInstalledHostPath(candidate)).toThrow(/Move Meetless\.app to \/Applications\/Meetless\.app.*mounted disk image/s);
  });

  test("keeps native alternate-path guidance diagnostics actionable", async () => {
    const source = await readFile("native/macos-host/MeetlessHost.swift", "utf8");
    expect(source).toContain("Move Meetless.app to /Applications/Meetless.app");
    expect(source).toContain("Do not launch Meetless from a mounted disk image");
    expect(source).toContain("NSAlert()");
    expect(source).toContain("MeetlessLaunchCoordinator");
    for (const diagnostic of [
      "packaged (label)",
      "at (resource)",
      "bundle identifier is (bundleIdentifier)",
      "expected (meetlessBundleIdentifier)",
    ]) {
      expect(source).not.toContain(diagnostic);
    }
    expect(source).not.toContain("/private/tmp/meetless-package-runtime");
  });

  test("allows identity refresh only when path, bundle ID, and designated requirement stay stable", () => {
    const config = resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-f23-identity", repositoryRoot: process.cwd() });
    const base = fakeIdentity(config);
    expect(() => assertStableHostIdentity(base, { ...base, cdHash: "b".repeat(40), binarySha256: "d".repeat(64) })).not.toThrow();
    expect(() => assertStableHostIdentity(base, { ...base, bundlePath: "/Volumes/Meetless/Meetless.app" })).toThrow(/exact installed path/);
    expect(() => assertStableHostIdentity(base, { ...base, bundleIdentifier: "com.other.app" } as HostIdentity)).toThrow(/bundle identifier/);
    expect(() => assertStableHostIdentity(base, { ...base, designatedRequirement: "identifier \"other\"" })).toThrow(/designated requirement/);
  });

  test("accepts the exact DMG layout and rejects extra, missing, or retargeted entries", () => {
    const expected = expectedMacOSDmgLayout();
    expect(validateMacOSDmgLayout(expected)).toEqual(expected);
    expect(digestMacOSDmgLayout(expected)).toBe(digestMacOSDmgLayout([...expected].reverse()));
    expect(() => validateMacOSDmgLayout([...expected, { name: ".DS_Store", type: "file" }])).toThrow(/exact app-plus-Applications/);
    expect(() => validateMacOSDmgLayout(expected.filter((entry) => entry.name !== "Applications"))).toThrow(/exact app-plus-Applications/);
    expect(() => validateMacOSDmgLayout(expected.map((entry) => entry.name === "Applications" ? { ...entry, target: "/Users/example/Applications" } : entry))).toThrow(/exact app-plus-Applications/);
  });

  test("routes package and DMG output through one explicit disposable root", () => {
    const options = parseMacOSDmgArguments(["--proof-root=/private/tmp/meetless-f23-dmg-proof"]);
    const paths = resolveMacOSDmgPaths(process.cwd(), options);
    expect(paths.proofRoot).toBe("/private/tmp/meetless-f23-dmg-proof");
    expect(paths.outputRoot).toBe("/private/tmp/meetless-f23-dmg-proof/release/macos");
    expect(paths.dmgPath).toBe("/private/tmp/meetless-f23-dmg-proof/release/macos/Meetless.dmg");
    expect(paths.sidecarPath).toBe("/private/tmp/meetless-f23-dmg-proof/release/macos/Meetless.dmg.json");
    expect(paths.sourceAppPath).toBe("/private/tmp/meetless-f23-dmg-proof/release/macos/Meetless.app");
    expect(paths.manifestPath).toBe("/private/tmp/meetless-f23-dmg-proof/release/macos/composition-manifest.json");
    expect(paths.dmgPath).not.toBe(path.resolve("release/macos/Meetless.dmg"));
    expect(() => parseMacOSDmgArguments(["--output-dir=relative-proof"])).toThrow(/absolute disposable directory/);
    expect(() => parseMacOSDmgArguments(["--proof-root=relative-proof"])).toThrow(/absolute disposable directory/);
    expect(parseMacOSProofRootArguments(["--signing-mode=local-ad-hoc", "--proof-root", "/private/tmp/proof"]).remainingArguments)
      .toEqual(["--signing-mode=local-ad-hoc"]);
    expect(() => resolveMacOSDmgPaths(process.cwd(), {
      outputDir: path.resolve("release/macos/Meetless.app"),
    })).toThrow(/mutate the source Meetless\.app/);
  });

  test("routes retained release DMG output to a distinct external sibling", () => {
    const paths = resolveMacOSDmgPaths(process.cwd(), {
      stageRoot: "/private/tmp/meetless-retained-stage",
      outputDir: "/private/tmp/meetless-retained-dmg",
    });
    expect(paths).toMatchObject({
      mode: "retained-release",
      stageRoot: "/private/tmp/meetless-retained-stage",
      sourceAppPath: "/private/tmp/meetless-retained-stage/Meetless.app",
      manifestPath: "/private/tmp/meetless-retained-stage/composition-manifest.json",
      outputRoot: "/private/tmp/meetless-retained-dmg",
    });
    expect(() => resolveMacOSDmgPaths(process.cwd(), { stageRoot: "/private/tmp/stage" })).toThrow(/output directory is not explicit/);
    expect(() => resolveMacOSDmgPaths(process.cwd(), { stageRoot: "/private/tmp/stage", outputDir: "/private/tmp/stage/out" })).toThrow(/distinct external sibling/);
    expect(() => resolveMacOSDmgPaths(process.cwd(), { proofRoot: "/private/tmp/proof", stageRoot: "/private/tmp/stage", outputDir: "/private/tmp/out" })).toThrow(/combine/);
  });

  test("does not wrap the DMG proof around the retained release package command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.scripts["package:macos:dmg"]).toContain("--build-package");
    expect(packageJson.scripts["package:macos:dmg"]).toContain("--proof-root=");
    expect(packageJson.scripts["package:macos:dmg"]).not.toContain("package:macos:arm64 &&");
  });

  test("fails closed before any write when local package or DMG proof has no disposable root", async () => {
    const packageFailure = await execFileAsync(process.execPath, [path.resolve("scripts/package-macos.mjs"), "--signing-mode=local-ad-hoc"], { cwd: process.cwd() })
      .then(() => null, (error) => error);
    expect(`${packageFailure?.stderr ?? ""}${packageFailure?.message ?? ""}`).toMatch(/refusing to mutate release\/macos/);

    const dmgFailure = await execFileAsync(process.execPath, [path.resolve("scripts/package-macos-dmg.mjs")], { cwd: process.cwd() })
      .then(() => null, (error) => error);
    expect(`${dmgFailure?.stderr ?? ""}${dmgFailure?.message ?? ""}`).toMatch(/refusing to mutate release\/macos/);
  });

  test("rejects a symlinked output root and an ancestor resolving into the source app", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-f23-output-root-"));
    const sourceApp = path.join(root, "release", "macos", "Meetless.app");
    const outputLink = path.join(root, "output-link");
    const ancestorLink = path.join(root, "ancestor-link");
    try {
      await mkdir(sourceApp, { recursive: true });
      await symlink(sourceApp, outputLink, "dir");
      expect(() => resolveMacOSDmgPaths(root, { outputDir: outputLink })).toThrow(/output root is a symlink/);

      await symlink(sourceApp, ancestorLink, "dir");
      expect(() => resolveMacOSDmgPaths(root, { outputDir: path.join(ancestorLink, "proof") }))
        .toThrow(/resolves inside .*Meetless\.app/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attests the actual mounted image instead of trusting a declared sidecar layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-f23-adversarial-dmg-"));
    const staging = path.join(root, "staging");
    const image = path.join(root, "Meetless.dmg");
    try {
      await mkdir(path.join(staging, "Meetless.app"), { recursive: true });
      await symlink("/Users/not-the-Applications-folder", path.join(staging, "Applications"));
      await execFileAsync("hdiutil", [
        "create",
        "-volname", "Meetless",
        "-srcfolder", staging,
        "-ov",
        "-format", "UDZO",
        image,
      ], { cwd: process.cwd() });

      const declared = expectedMacOSDmgLayout();
      expect(() => validateMacOSDmgLayout(declared)).not.toThrow();
      await expect(attestMacOSDmgLayout(image)).rejects.toThrow(/exact app-plus-Applications/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the retained release root unchanged for a disposable proof", async () => {
    const retainedRoot = path.resolve("release/macos");
    const beforeFingerprint = await fingerprintPath(retainedRoot);
    const root = await mkdtemp(path.join(tmpdir(), "meetless-f23-retained-root-"));
    const sentinel = path.join(root, "retained-root-sentinel");
    try {
      await writeFile(sentinel, "proof-root-only\n");
      const paths = resolveMacOSDmgPaths(process.cwd(), { proofRoot: root });
      expect(paths.releaseRoot).toBe(path.join(root, "release", "macos"));
      expect(paths.releaseRoot).not.toBe(retainedRoot);
      expect(await readFile(sentinel, "utf8")).toBe("proof-root-only\n");
      expect(await fingerprintPath(retainedRoot)).toBe(beforeFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(await fingerprintPath(retainedRoot)).toBe(beforeFingerprint);
  });

  test("binds local-only DMG metadata and catches source mutation", () => {
    const source = "a".repeat(64);
    const artifact = "b".repeat(64);
    const layout = expectedMacOSDmgLayout();
    const sidecar = {
      schema: MACOS_DMG_SCHEMA,
      authority: MACOS_DMG_AUTHORITY,
      target: "macos-arm64",
      sourceAppPath: "Meetless.app",
      sourceAppSha256: source,
      sourceAppBeforeSha256: source,
      sourceAppAfterSha256: source,
      artifactPath: "Meetless.dmg",
      artifactSha256: artifact,
      manifestSha256: "c".repeat(64),
      artifactDigest: "d".repeat(64),
      signatureStateDigest: "e".repeat(64),
      layout,
      layoutSha256: digestMacOSDmgLayout(layout),
      localOnly: true,
      mode: "local-ad-hoc",
      signingMode: "local-ad-hoc",
      stageStatus: "local-ad-hoc-candidate",
      stageRoot: null,
      releaseAcceptance: "not-claimed",
      proofRoot: "external-disposable",
      compositionManifest: "composition-manifest.json",
      compositionArtifactDigest: "d".repeat(64),
    };
    expect(validateMacOSDmgSidecar(sidecar, { sourceAppSha256: source, artifactSha256: artifact })).toEqual(sidecar);
    expect(() => assertDmgSourceUnchanged(source, "c".repeat(64))).toThrow(/changed the source Meetless\.app/);
    expect(() => validateMacOSDmgSidecar({ ...sidecar, localOnly: false })).toThrow(/mode|retained-stage status/);
  });

  test("binds retained release DMG metadata and rejects every binding mutation", () => {
    const source = "a".repeat(64);
    const artifact = "b".repeat(64);
    const manifest = "c".repeat(64);
    const artifactDigest = "d".repeat(64);
    const signature = "e".repeat(64);
    const layout = expectedMacOSDmgLayout();
    const sidecar = {
      schema: MACOS_DMG_SCHEMA,
      authority: MACOS_DMG_AUTHORITY,
      target: "macos-arm64",
      sourceAppPath: "Meetless.app",
      sourceAppSha256: source,
      sourceAppBeforeSha256: source,
      sourceAppAfterSha256: source,
      artifactPath: "Meetless.dmg",
      artifactSha256: artifact,
      manifestSha256: manifest,
      artifactDigest,
      compositionArtifactDigest: artifactDigest,
      signatureStateDigest: signature,
      layout,
      layoutSha256: digestMacOSDmgLayout(layout),
      localOnly: false,
      mode: "retained-release",
      signingMode: "release",
      stageStatus: "retained-success",
      stageRoot: "/private/tmp/retained-stage",
      releaseAcceptance: "not-claimed",
      proofRoot: "external-retained-sibling",
      compositionManifest: "composition-manifest.json",
    };
    const expected = { sourceAppSha256: source, artifactSha256: artifact, manifestSha256: manifest, artifactDigest, signatureStateDigest: signature };
    expect(validateMacOSDmgSidecar(sidecar, expected)).toEqual(sidecar);
    for (const [field, value] of Object.entries({
      sourceAppSha256: "f".repeat(64),
      manifestSha256: "f".repeat(64),
      artifactDigest: "f".repeat(64),
      signatureStateDigest: "f".repeat(64),
      artifactSha256: "f".repeat(64),
    })) {
      expect(() => validateMacOSDmgSidecar({ ...sidecar, [field]: value }, expected)).toThrow();
    }
    expect(() => validateMacOSDmgSidecar({ ...sidecar, compositionArtifactDigest: "f".repeat(64) })).toThrow(/aliases differ/);
    expect(() => validateMacOSDmgSidecar({ ...sidecar, layout: [...layout, { name: "extra", type: "file" }] })).toThrow(/exact app-plus-Applications/);
    expect(() => validateMacOSDmgSidecar({ ...sidecar, stageStatus: "retained-failure" })).toThrow(/retained-stage status/);
  });

  test("derives host identity configuration from the same runtime contract", () => {
    const config = resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-f23-host-config", repositoryRoot: process.cwd() });
    const expected = expectedHostConfiguration(config);
    expect(expected.repositoryRoot).toBe(path.resolve(config.paths.plugin, "..", ".."));
    expect(expected.runtimeRoot).toBe(config.paths.root);
    expect(expected.identityPath).toBe(config.host.identity);
  });

  test("validates a relative packaged marker and host config, including tamper rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-f23-marker-"));
    try {
      await writeFile(path.join(root, "installation-contract.json"), installationContractBytes());
      const marker = packagedMarker({ paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e" });
      expect(validatePackagedMarker(marker, root)).toBeUndefined();
      expect(validateHostConfig(packagedHostConfiguration(), "/Applications/Meetless.app")).toBeUndefined();
      expect(() => validatePackagedMarker({ ...marker, hostBundlePath: "/Users/example/Applications/Meetless.app" }, root)).toThrow(/direct-install locations/);
      expect(() => validateHostConfig({ ...packagedHostConfiguration(), nodePath: "/Users/builder/node" }, "/Applications/Meetless.app")).toThrow(/relative-path contract/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeIdentity(config: ReturnType<typeof resolveRuntimeConfig>): HostIdentity {
  return {
    version: 1,
    bundleIdentifier: "com.meetless.app",
    bundlePath: "/Applications/Meetless.app",
    bundleRealPath: "/Applications/Meetless.app",
    executablePath: "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
    designatedRequirement: 'identifier "com.meetless.app" and anchor cdhash H"abc"',
    cdHash: "a".repeat(40),
    binarySha256: "c".repeat(64),
    binaryDevice: 1,
    binaryInode: 2,
    binarySize: 3,
    configuration: expectedHostConfiguration(config),
  };
}
