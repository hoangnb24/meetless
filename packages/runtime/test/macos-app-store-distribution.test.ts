import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMacAppStoreDistributionArguments, prepareDistributionInfo, validateDistributionInfo, validateDistributionProfile, validateDistributionSignature, validateDistributionSource, validateInstallerSignature, buildReviewedDistributionSource, rebuildDistributionSource } from "../../../scripts/lib/macos-app-store-distribution.mjs";
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
  it("requires trusted Installer signature from selected identity", () => {
    const output = `Status: signed by a certificate trusted by Mac OS X\nCertificate Chain:\n 1. ${installerIdentity}\n`;
    expect(validateInstallerSignature(output, installerIdentity).verified).toBe(true);
    expect(() => validateInstallerSignature(output.replace("trusted", "untrusted"), installerIdentity)).toThrow();
    expect(() => validateInstallerSignature(output.replace("Example", "Someone else"), installerIdentity)).toThrow();
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
