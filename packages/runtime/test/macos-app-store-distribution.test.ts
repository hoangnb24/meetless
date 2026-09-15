import plist from "plist";
import { stageMacOSAppStoreEmbeddedProfile } from "../../../scripts/lib/macos-app-store-package-evidence.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMacAppStoreDistributionArguments, prepareDistributionInfo, validateDistributionInfo, validateDistributionProfile, validateDistributionSignature, validateDistributionSource, validateInstallerSignature, buildReviewedDistributionSource, rebuildDistributionSource, prepareDistributionEntitlements, validateDistributionEntitlements, validateDistributionIcon, validateDistributionReadableClosure } from "../../../scripts/lib/macos-app-store-distribution.mjs";
import { buildMacOSPackageInputSpecs, MACOS_PACKAGE_ELECTRON_LAYOUT_MAS } from "../../../scripts/lib/macos-package-inputs.mjs";
import { MACOS_APP_STORE_CONTRACT } from "../../../scripts/lib/macos-app-store-contract.mjs";
const appIdentity = "Apple Distribution: Example (63M98WD275)";
const installerIdentity = "3rd Party Mac Developer Installer: Example (63M98WD275)";
const inputs = { "proof-root": "/tmp/distribution", "provisioning-profile": "/tmp/store.provisionprofile", "signing-identity": appIdentity, "installer-identity": installerIdentity, keychain: "/tmp/release.keychain-db", "keychain-password-file": "/tmp/password", version: "1.0", "build-number": "1", "sandbox-url": "https://sandbox-test.convex.cloud", "production-url": "https://production-test.convex.cloud", "public-sdk-key": "appl_test12345678", "source-commit": "a".repeat(40), "source-snapshot-sha256": "b".repeat(64) };
const parse = (overrides = {}) => parseMacAppStoreDistributionArguments(Object.entries({ ...inputs, ...overrides }).map(([key, value]) => `--${key}=${value}`));
const profile = () => ({ Name: "Store", UUID: "uuid", Platform: ["OSX"], TeamIdentifier: ["63M98WD275"], ApplicationIdentifierPrefix: ["63M98WD275"], Entitlements: { "com.apple.application-identifier": "63M98WD275.com.meetless.app", "com.apple.developer.team-identifier": "63M98WD275" }, DeveloperCertificates: [Buffer.from("fixture")], ExpirationDate: new Date("2099-01-01") });
describe("explicit MAS distribution inputs", () => {
  it("binds version, routing, public SDK key and reviewed source in signed plist", () => {
    const options = parse();
    const info = prepareDistributionInfo({ CFBundleIdentifier: "com.meetless.app", MeetlessConvexURL: "https://old.convex.cloud" }, options);
    expect(info.CFBundleShortVersionString).toBe("1.0");
    expect(info.CFBundleVersion).toBe("1");
    expect(info.MeetlessStoreBackendRouting).toBe(true);
    expect(info.MeetlessConvexURL).toBeUndefined();
    expect(validateDistributionInfo(info, options)).toBe(info);
    for (const key of ["MeetlessConvexSandboxURL", "MeetlessSourceCommit", "CFBundleVersion", "MeetlessDistributionConfigurationSHA256"]) expect(() => validateDistributionInfo({ ...info, [key]: "changed" }, options)).toThrow(/differs/);
  });
  it.each([
    { "signing-identity": "Apple Development: Example (63M98WD275)" },
    { "installer-identity": "Developer ID Installer: Example (63M98WD275)" },
    { "signing-identity": "Apple Distribution: Example (OTHERTEAM)" },
    { "sandbox-url": inputs["production-url"] },
    { "production-url": "https://production-test.convex.cloud/" },
    { "production-url": "https://localhost" },
    { "production-url": "https://production-test.convex.cloud?override=1" },
    { "public-sdk-key": "sk_secret" },
    { "source-commit": "main" },
    { "source-snapshot-sha256": "latest" },
    { version: "1.0-beta" },
    { "build-number": "0" },
  ])("rejects incompatible distribution configuration %j", (override) => expect(() => parse(override)).toThrow());
  it("requires every input explicitly and rejects duplicate values", () => {
    const args = Object.entries(inputs).map(([key, value]) => `--${key}=${value}`);
    for (let i = 0; i < args.length; i++) expect(() => parseMacAppStoreDistributionArguments(args.filter((_, index) => index !== i))).toThrow(/Missing/);
    expect(() => parseMacAppStoreDistributionArguments([...args, "--version=2.0"])).toThrow(/Duplicate/);
  });
  it("rejects changed source even with the same HEAD", () => {
    const options = parse();
    const snapshot = { mode: "package-source", head: options.sourceCommit, digest: options.sourceSnapshotSha256 };
    expect(() => validateDistributionSource(snapshot, options)).not.toThrow();
    expect(() => validateDistributionSource({ ...snapshot, digest: "c".repeat(64) }, options)).toThrow(/reviewed/);
    expect(() => validateDistributionSource({ ...snapshot, head: "c".repeat(40) }, options)).toThrow(/reviewed/);
  });
});
describe("store signing eligibility", () => {
  it("accepts store profile and rejects device, wrong team/app, debug and expired profiles", () => {
    expect(validateDistributionProfile(profile())).toBeTruthy();
    for (const override of [{ ProvisionedDevices: [] }, { ProvisionsAllDevices: true }, { TeamIdentifier: ["OTHER"] }, { ExpirationDate: new Date(0) }, { DeveloperCertificates: [] }, { Platform: ["iOS"] }, { Entitlements: { ...profile().Entitlements, "get-task-allow": true } }, { Entitlements: { ...profile().Entitlements, "com.apple.application-identifier": "63M98WD275.other" } }]) expect(() => validateDistributionProfile({ ...profile(), ...override })).toThrow();
  });
  it("checks actual codesign identity, team, app and CDHash", () => {
    const output = `Identifier=com.meetless.app\nAuthority=${appIdentity}\nTeamIdentifier=63M98WD275\nCDHash=${"c".repeat(40)}\n`;
    expect(validateDistributionSignature(output, appIdentity).identity).toBe(appIdentity);
    for (const altered of [output.replace("com.meetless.app", "other"), output.replace("Authority=Apple Distribution", "Authority=Apple Development"), output.replace("TeamIdentifier=63M98WD275", "TeamIdentifier=OTHER"), output + "Signature=adhoc\n"]) expect(() => validateDistributionSignature(altered, appIdentity)).toThrow(/signature mismatch/);
  });
  it("binds observed Apple installer status to the selected certificate purpose, fingerprint and chain", async () => {
    const output = await readFile(new URL("./fixtures/mac-app-store-installer-pkgutil.txt", import.meta.url), "utf8");
    const certificatePem = await readFile(new URL("./fixtures/mac-app-store-installer-public-cert.pem", import.meta.url));
    const identity = "3rd Party Mac Developer Installer: Long Le (63M98WD275)";
    expect(validateInstallerSignature(output, identity, { certificatePem }).verified).toBe(true);
    expect(validateInstallerSignature(output.replace("signed by a developer certificate issued by Apple (Development)", "signed by a certificate trusted by macOS"), identity, { certificatePem }).verified).toBe(true);
    for (const altered of [output.replace("signed by a developer certificate issued by Apple (Development)", "no signature"), output.replace("Long Le", "Someone else"), output.replace("EC F2 5D", "00 00 00"), output.replace("Apple Root CA", "Untrusted Root"), output.replace("Apple Worldwide Developer Relations Certification Authority", "Untrusted Intermediate")]) expect(() => validateInstallerSignature(altered, identity, { certificatePem })).toThrow();
    expect(() => validateInstallerSignature(output, identity)).toThrow(/public certificate/);
    expect(() => validateInstallerSignature(output, installerIdentity, { certificatePem })).toThrow(/purpose or identity/);
  });
});


describe("distribution producer build freshness", () => {
  it("cannot reuse a stale artifact when the mandatory build fails", async () => {
    const options = parse();
    let artifact = "stale binary";
    let built = false;
    const snapshot = { mode: "package-source", head: options.sourceCommit, digest: options.sourceSnapshotSha256 };
    await expect(buildReviewedDistributionSource({ options, readSnapshot: async () => snapshot, clean: async () => { artifact = ""; }, build: async () => { built = true; throw new Error("compiler failure"); } })).rejects.toThrow("compiler failure");
    expect(artifact).toBe("");
    expect(built).toBe(true);
  });
  it("always cleans and rebuilds between source checks and rejects changes during compilation", async () => {
    const options = parse();
    const snapshot = { mode: "package-source", head: options.sourceCommit, digest: options.sourceSnapshotSha256 };
    const calls: string[] = [];
    let current = snapshot;
    const run = () => buildReviewedDistributionSource({ options, readSnapshot: async () => { calls.push("snapshot"); return current; }, clean: async () => { calls.push("clean"); }, build: async () => { calls.push("build"); } });
    expect((await run()).clean).toBe(true);
    expect(calls).toEqual(["snapshot", "clean", "build", "snapshot"]);
    await expect(buildReviewedDistributionSource({ options, readSnapshot: async () => current, clean: async () => {}, build: async () => { current = { ...snapshot, digest: "c".repeat(64) }; } })).rejects.toThrow(/reviewed/);
  });
});

it("actual producer cleanup removes stale compiled output before compiler failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-build-freshness-"));
  try {
    const options = parse();
    const stale = path.join(root, "packages/runtime/dist/cli.js");
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, "stale compiled output");
    const commands: string[] = [];
    await expect(rebuildDistributionSource({ repositoryRoot: root, options, readSnapshot: async () => ({ mode: "package-source", head: options.sourceCommit, digest: options.sourceSnapshotSha256 }), run: async (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      if (command === "npm") throw new Error("compiler failure");
    } })).rejects.toThrow("compiler failure");
    await expect(readFile(stale)).rejects.toThrow(/ENOENT/);
    expect(commands).toEqual(["swift package --package-path native/macos-host clean", "swift package --package-path native/macos-capture clean", "npm run build"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rebuilds real incremental TypeScript output after removing its cache outside dist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-tsc-freshness-"));
  const desktop = path.join(root, "vendor/paseo/packages/desktop");
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const execute = promisify(execFile);
  const compile = () => execute(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: desktop });
  try {
    await mkdir(path.join(desktop, "src"), { recursive: true });
    await writeFile(path.join(desktop, "src/main.ts"), "export const version = 1;\n");
    await writeFile(path.join(desktop, "tsconfig.json"), JSON.stringify({ compilerOptions: { incremental: true, outDir: "./dist", rootDir: "./src", types: [], skipLibCheck: true }, include: ["src/**/*"] }));
    await compile();
    expect(await readFile(path.join(desktop, "dist/main.js"), "utf8")).toContain("version");
    expect((await readFile(path.join(desktop, "tsconfig.tsbuildinfo"))).length).toBeGreaterThan(0);
    // Reproduce the rejected producer: cleaning dist alone leaves stale state
    // and tsc succeeds without recreating the missing emitted binary input.
    await rm(path.join(desktop, "dist"), { recursive: true });
    await compile();
    await expect(readFile(path.join(desktop, "dist/main.js"))).rejects.toThrow(/ENOENT/);
    const options = parse();
    await rebuildDistributionSource({ repositoryRoot: root, options, readSnapshot: async () => ({ mode: "package-source", head: options.sourceCommit, digest: options.sourceSnapshotSha256 }), run: async (command: string) => { if (command === "npm") await compile(); } });
    expect(await readFile(path.join(desktop, "dist/main.js"), "utf8")).toContain("version");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

describe("actual Apple submission requirements", () => {
  it("binds the icon only for distribution package inputs, preserving the development MAS shape", () => {
    const electronArchiveSource = {
      schema: "MEETLESS_MAS_ELECTRON_ARCHIVE_SOURCE v1",
      archiveName: MACOS_APP_STORE_CONTRACT.electron.archiveName,
      path: `/tmp/${MACOS_APP_STORE_CONTRACT.electron.archiveName}`,
      sha256: MACOS_APP_STORE_CONTRACT.electron.sha256,
    };
    const development = buildMacOSPackageInputSpecs({ electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS, electronArchiveSource });
    const distribution = buildMacOSPackageInputSpecs({ electronLayout: MACOS_PACKAGE_ELECTRON_LAYOUT_MAS, distribution: true, electronArchiveSource });
    const developmentNative = development.find(({ id }) => id === "meetless-native-sources");
    const distributionNative = distribution.find(({ id }) => id === "meetless-native-sources");
    expect(developmentNative?.artifactPathPrefixes).not.toContain("Contents/Resources/Meetless.icns");
    expect(distributionNative?.artifactPathPrefixes).toContain("Contents/Resources/Meetless.icns");
  });
  it("embeds Productivity category and a named ICNS icon in distribution metadata", () => {
    const options = parse();
    const info = prepareDistributionInfo({ CFBundleIdentifier: "com.meetless.app" }, options);
    expect(info.LSApplicationCategoryType).toBe("public.app-category.productivity");
    expect(info.CFBundleIconFile).toBe("Meetless.icns");
    for (const key of ["LSApplicationCategoryType", "CFBundleIconFile"]) expect(() => validateDistributionInfo({ ...info, [key]: undefined }, options)).toThrow(/differs/);
  });
  it("validates the actual committed brand ICNS 512pt@2x and rejects its removal or wrong dimensions", async () => {
    const icon = await readFile(new URL("../../../native/macos-host/Meetless.icns", import.meta.url));
    expect(validateDistributionIcon(icon).has512ptAt2x).toBe(true);
    let offset = 8;
    while (icon.toString("ascii", offset, offset + 4) !== "ic10") offset += icon.readUInt32BE(offset + 4);
    const missing = Buffer.from(icon); missing.write("xxxx", offset, "ascii");
    expect(() => validateDistributionIcon(missing)).toThrow(/missing required/);
    const wrong = Buffer.from(icon); wrong.writeUInt32BE(512, offset + 8 + 16);
    expect(() => validateDistributionIcon(wrong)).toThrow(/1024px/);
    expect(() => validateDistributionIcon(icon.subarray(0, 32))).toThrow(/container/);
  });
  it("signs exactly the profile app/team identity while retaining strict sandbox closure", async () => {
    const parent = plist.parse(await readFile(new URL("../../../native/macos-host/MeetlessAppStore.entitlements.plist", import.meta.url), "utf8"));
    const selected = profile();
    const prepared = prepareDistributionEntitlements(parent, selected);
    expect(prepared["com.apple.application-identifier"]).toBe("63M98WD275.com.meetless.app");
    expect(prepared["com.apple.developer.team-identifier"]).toBe("63M98WD275");
    expect(validateDistributionEntitlements(prepared, selected)).toBe(prepared);
    expect(() => validateDistributionEntitlements(parent, selected)).toThrow(/application-identifier/);
    expect(() => validateDistributionEntitlements({ ...prepared, "com.apple.application-identifier": "other" }, selected)).toThrow(/match/);
    expect(() => validateDistributionEntitlements({ ...prepared, "get-task-allow": true }, selected)).toThrow(/exactly/);
  });
  it("keeps only the embedded distribution profile publicly readable, preserving dev mode and rejecting unreadable payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-profile-mode-"));
    try {
      await chmod(root, 0o755); await mkdir(path.join(root, "Contents"), { mode: 0o755 });
      const bytes = Buffer.from("controlled public provisioning profile fixture");
      const dev = await stageMacOSAppStoreEmbeddedProfile({ bundlePath: root, profileBytes: bytes });
      const target = path.join(root, "Contents/embedded.provisionprofile");
      expect((await stat(target)).mode & 0o777).toBe(0o400);
      expect(dev.schema).toBe("MEETLESS_MACOS_MAS_EMBEDDED_PROFILE v1");
      await rm(target);
      const distribution = await stageMacOSAppStoreEmbeddedProfile({ bundlePath: root, profileBytes: bytes, profileMode: 0o444 });
      expect((await stat(target)).mode & 0o777).toBe(0o444);
      expect(distribution.schema).toBe("MEETLESS_MACOS_MAS_EMBEDDED_PROFILE v2");
      expect(distribution.mode).toBe(0o444);
      expect((await validateDistributionReadableClosure(root)).nonRootReadable).toBe(true);
      await chmod(target, 0o400);
      await expect(validateDistributionReadableClosure(root)).rejects.toThrow(/non-root/);
      await expect(stageMacOSAppStoreEmbeddedProfile({ bundlePath: root, profileBytes: bytes, profileMode: 0o666 })).rejects.toThrow(/Unsupported/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
