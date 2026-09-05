import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  prepareMacAppStoreDevelopmentInfo,
  parseMacAppStoreDevelopmentArguments,
  R5_APP_STORE_DEVELOPMENT_DEVICE_UDID,
  R5_APP_STORE_DEVELOPMENT_IDENTITY,
  R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME,
  R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
  R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
  MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES,
  classifyMacAppStoreDevelopmentMachO,
  createMacAppStoreDevelopmentSigningOptions,
  parseMacAppStoreDevelopmentEntitlementResult,
  parseUnsignedCodesignProfileDiagnostic,
  projectMacAppStoreDevelopmentEntitlementEvidence,
  resolveR5DevelopmentPaseoCommit,
  resolveR5DevelopmentProfilePath,
  resolveMacAppStoreDevelopmentEmbeddedProfilePath,
  validateMacAppStoreDevelopmentInfo,
  validateR5DevelopmentElectronFileOutput,
  validateR5DevelopmentElectronInfo,
  validateR5DevelopmentProfile,
  validateR5DevelopmentSignature,
  validateRevenueCatPublicSdkKey,
} from "../../../scripts/lib/macos-app-store-development.mjs";
import {
  validateEntitlementKeys,
} from "../../../scripts/lib/macos-app-store-contract.mjs";

const CODESIGN_ENTITLEMENT_WARNING = "warning: Specifying ':' in the path is deprecated and will not work in a future release";

function entitlementCommandResult(executablePath, stdout = "", { warning = true } = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: `Executable=${path.resolve(executablePath)}\n${warning ? `${CODESIGN_ENTITLEMENT_WARNING}\n` : ""}`,
  };
}

function profile() {
  return {
    Name: R5_APP_STORE_DEVELOPMENT_PROFILE_NAME,
    UUID: R5_APP_STORE_DEVELOPMENT_PROFILE_UUID,
    Entitlements: {
      "com.apple.application-identifier": "63M98WD275.com.meetless.app",
      "com.apple.developer.team-identifier": "63M98WD275",
    },
    ApplicationIdentifierPrefix: ["63M98WD275"],
    TeamIdentifier: ["63M98WD275"],
    ExpirationDate: "2027-09-01T15:21:30Z",
    ProvisionedDevices: [R5_APP_STORE_DEVELOPMENT_DEVICE_UDID],
  };
}

describe("Mac App Store development package boundary", () => {
  test("requires explicit disposable/profile/identity inputs", () => {
    expect(parseMacAppStoreDevelopmentArguments([
      "--proof-root=/private/tmp/meetless-mas-proof",
      "--provisioning-profile=/tmp/meetless.provisionprofile",
      `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
      "--build-number=1",
    ])).toEqual({
      proofRoot: "/private/tmp/meetless-mas-proof",
      provisioningProfile: "/tmp/meetless.provisionprofile",
      signingIdentity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
      buildNumber: "1",
    });
    expect(() => parseMacAppStoreDevelopmentArguments([])).toThrow(/proof-root/);
    expect(() => parseMacAppStoreDevelopmentArguments([
      "--proof-root=/private/tmp/x", "--provisioning-profile=/tmp/x", "--signing-identity=-",
    ])).toThrow(/Apple Development/);
    expect(() => parseMacAppStoreDevelopmentArguments([
      "--proof-root=relative", "--provisioning-profile=/tmp/x", `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
    ])).toThrow(/absolute disposable/);
    expect(() => parseMacAppStoreDevelopmentArguments([
      "--proof-root=/private/tmp/x", "--provisioning-profile=relative", `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`,
    ])).toThrow(/absolute path/);
    expect(() => parseMacAppStoreDevelopmentArguments([
      "--proof-root=/private/tmp/x", "--provisioning-profile=/tmp/x", `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`, "--build-number=0",
    ])).toThrow(/positive integer/);
    expect(() => parseMacAppStoreDevelopmentArguments([
      "--proof-root=/private/tmp/x", "--provisioning-profile=/tmp/x", `--signing-identity=${R5_APP_STORE_DEVELOPMENT_IDENTITY}`, "--proof-root=/private/tmp/y",
    ])).toThrow(/more than once/);
  });

  test("accepts only an Apple public SDK key", () => {
    expect(validateRevenueCatPublicSdkKey("appl_1234567890")).toBe("appl_1234567890");
    expect(() => validateRevenueCatPublicSdkKey("sk_secret")).toThrow(/public Apple SDK key/);
    expect(() => validateRevenueCatPublicSdkKey("appl_short")).toThrow(/public Apple SDK key/);
    expect(() => validateRevenueCatPublicSdkKey(undefined)).toThrow(/public Apple SDK key/);
  });

  test("adds and validates only build-scoped public SDK metadata", () => {
    const prepared = prepareMacAppStoreDevelopmentInfo(
      { CFBundleIdentifier: "com.meetless.app", CFBundleName: "Meetless" },
      "appl_1234567890",
    );
    expect(prepared).toMatchObject({
      CFBundleIdentifier: "com.meetless.app",
      ElectronTeamID: "63M98WD275",
      MeetlessRevenueCatAPIKey: "appl_1234567890",
    });
    expect(validateMacAppStoreDevelopmentInfo(prepared, { publicSdkKey: "appl_1234567890" })).toBe(prepared);
    expect(() => validateMacAppStoreDevelopmentInfo({ ...prepared, CFBundleIdentifier: "com.other.app" })).toThrow(/bundle identifier/);
    expect(() => validateMacAppStoreDevelopmentInfo({ ...prepared, MeetlessRevenueCatAPIKey: "sk_secret" })).toThrow(/public Apple SDK key/);
    expect(() => validateMacAppStoreDevelopmentInfo(prepared, { publicSdkKey: "appl_0987654321" })).toThrow(/different/);
  });

  test("proves the pinned MAS Electron and certificate-backed signature shape", () => {
    expect(validateR5DevelopmentElectronInfo({
      CFBundleExecutable: "Electron",
      CFBundleVersion: "41.2.0",
    })).toMatchObject({ CFBundleExecutable: "Electron" });
    expect(validateR5DevelopmentElectronFileOutput("Electron: Mach-O 64-bit executable arm64")).toEqual({ architecture: "arm64" });
    expect(() => validateR5DevelopmentElectronInfo({ CFBundleExecutable: "Electron", CFBundleVersion: "40.0.0" })).toThrow(/41.2.0/);
    expect(() => validateR5DevelopmentElectronFileOutput("Electron: Mach-O universal binary with 2 architectures: [arm64:x86_64]")).toThrow(/thin arm64/);
    expect(() => validateR5DevelopmentElectronFileOutput("Electron: Mach-O 64-bit executable arm64e")).toThrow(/thin arm64/);

    const details = [
      "Identifier=com.meetless.app",
      "TeamIdentifier=63M98WD275",
      "Authority=Apple Development: Long Le (335C7MY4H4)",
      "Signature=CMS",
      "CDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ].join("\n");
    expect(validateR5DevelopmentSignature(details)).toMatchObject({
      identifier: "com.meetless.app",
      teamId: "63M98WD275",
      identity: R5_APP_STORE_DEVELOPMENT_IDENTITY,
    });
    expect(() => validateR5DevelopmentSignature(details.replace("Signature=CMS", "Signature=ADHOC"))).toThrow(/ad-hoc/);
    expect(() => validateR5DevelopmentSignature(details.replace("TeamIdentifier=63M98WD275", "TeamIdentifier=OTHER"))).toThrow(/Team ID/);
    expect(() => validateR5DevelopmentSignature(details.replace("Apple Development: Long Le (335C7MY4H4)", "Apple Distribution: Long Le (63M98WD275)"))).toThrow(/identity/);
    expect(validateR5DevelopmentSignature(details.replace("Identifier=com.meetless.app", "Identifier=com.meetless.helper"), "nested", { expectedBundleIdentifier: null })).toMatchObject({ identifier: "com.meetless.helper" });
  });

  test("ignores only the normalized embedded profile and preserves code-object signing routes", () => {
    const bundlePath = "/tmp/mas-proof/release/Meetless.app";
    const parentEntitlementsPath = "/tmp/mas-proof/parent.entitlements.plist";
    const childEntitlementsPath = "/tmp/mas-proof/child.entitlements.plist";
    const signingOptions = createMacAppStoreDevelopmentSigningOptions({
      bundlePath,
      parentEntitlementsPath,
      childEntitlementsPath,
    });
    const embeddedProfilePath = resolveMacAppStoreDevelopmentEmbeddedProfilePath(bundlePath);
    const exactNormalizedProfilePath = `${bundlePath}/Contents/Resources/../embedded.provisionprofile`;
    const paths = [
      embeddedProfilePath,
      exactNormalizedProfilePath,
      path.join(bundlePath, "Contents", "embedded.provisionprofile.mobileprovision.bak"),
      path.join(bundlePath, "Contents", "Embedded.provisionprofile"),
      path.join(bundlePath, "Contents", "Resources", "Nested.app", "Contents", "embedded.provisionprofile"),
      bundlePath,
      path.join(bundlePath, "Contents", "MacOS", "MeetlessHost"),
      path.join(bundlePath, "Contents", "Resources", "Electron.app"),
      path.join(bundlePath, "Contents", "Frameworks", "Example.framework"),
    ];
    const optionsForFileCalls: string[] = [];
    const routed = paths.flatMap((filePath) => {
      if (signingOptions.ignore(filePath)) return [];
      optionsForFileCalls.push(filePath);
      return [{ filePath, options: signingOptions.optionsForFile(filePath) }];
    });

    expect(signingOptions.ignore(exactNormalizedProfilePath)).toBe(true);
    expect(optionsForFileCalls).not.toContain(embeddedProfilePath);
    expect(routed).toHaveLength(paths.length - 2);
    expect(routed.find(({ filePath }) => filePath === bundlePath)?.options).toEqual({
      entitlements: parentEntitlementsPath,
      hardenedRuntime: false,
      timestamp: "none",
    });
    expect(routed.filter(({ filePath }) => filePath !== bundlePath).every(({ options }) => options.entitlements === childEntitlementsPath)).toBe(true);
    expect(paths.slice(2).every((filePath) => !signingOptions.ignore(filePath))).toBe(true);
  });

  test("classifies Mach-O entitlement policy from authoritative file type", () => {
    const outer = classifyMacAppStoreDevelopmentMachO({
      path: "Contents/MacOS/MeetlessHost",
      machOFileType: "MH_EXECUTE",
    });
    expect(outer).toEqual({
      fileType: "MH_EXECUTE",
      entitlementPolicy: MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.PARENT,
      expectedEntitlementKeys: [
        "com.apple.security.app-sandbox",
        "com.apple.security.application-groups",
        "com.apple.security.device.audio-input",
        "com.apple.security.network.client",
        "com.apple.security.network.server",
      ],
    });

    const child = classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
      machOFileType: "MH_EXECUTE",
    });
    expect(child.entitlementPolicy).toBe(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD);
    expect(child.expectedEntitlementKeys).toEqual([
      "com.apple.security.app-sandbox",
      "com.apple.security.inherit",
    ]);

    expect(classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      machOFileType: "MH_BUNDLE",
    }).entitlementPolicy).toBe(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE);
    expect(classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node",
      machOFileType: "MH_DYLIB",
    }).entitlementPolicy).toBe(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.NONE);
    expect(classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/node_modules/pty.node",
      machOFileType: "MH_EXECUTE",
    }).entitlementPolicy).toBe(MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD);

    expect(() => classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/node_modules/unknown.node",
      machOFileType: null,
    })).toThrow(/unknown or ambiguous Mach-O file type/);
    expect(() => classifyMacAppStoreDevelopmentMachO({
      path: "Contents/Resources/meetless/node_modules/unknown.node",
      machOFileType: "MH_OBJECT",
    })).toThrow(/unknown or ambiguous Mach-O file type/);
    expect(() => classifyMacAppStoreDevelopmentMachO({
      path: "Contents/MacOS/MeetlessHost",
      machOFileType: "MH_DYLIB",
    })).toThrow(/must be an MH_EXECUTE/);
  });

  test("requires exact entitlement command output and type-specific presence", () => {
    const profilePath = "/tmp/Meetless.app/Contents/Resources/meetless/node_modules/node-pty/prebuilds/darwin-arm64/pty.node";
    const noEntitlementObjects = [
      {
        path: profilePath,
        label: "pty.node",
        policy: classifyMacAppStoreDevelopmentMachO({ path: "pty.node", machOFileType: "MH_BUNDLE" }),
      },
      {
        path: "/tmp/Meetless.app/Contents/Resources/meetless/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node",
        label: "sherpa-onnx.node",
        policy: classifyMacAppStoreDevelopmentMachO({ path: "sherpa-onnx.node", machOFileType: "MH_DYLIB" }),
      },
    ];
    for (const { path: executablePath, label, policy } of noEntitlementObjects) {
      expect(parseMacAppStoreDevelopmentEntitlementResult(
        entitlementCommandResult(executablePath),
        { entitlementPolicy: policy.entitlementPolicy, executablePath, label },
      )).toEqual({ kind: "absent", entitlementPolicy: "none" });
    }
    expect(parseMacAppStoreDevelopmentEntitlementResult(
      entitlementCommandResult(profilePath, "", { warning: false }),
      {
        entitlementPolicy: noEntitlementObjects[0].policy.entitlementPolicy,
        executablePath: profilePath,
        label: "pty.node",
      },
    )).toEqual({ kind: "absent", entitlementPolicy: "none" });

    expect(() => parseMacAppStoreDevelopmentEntitlementResult(
      entitlementCommandResult(profilePath),
      { entitlementPolicy: MACOS_APP_STORE_DEVELOPMENT_MACHO_ENTITLEMENT_POLICIES.CHILD, executablePath: profilePath, label: "executable" },
    )).toThrow(/missing its required entitlement plist/);

    const childPath = "/tmp/Meetless.app/Contents/MacOS/helper";
    const childPolicy = classifyMacAppStoreDevelopmentMachO({ path: "helper", machOFileType: "MH_EXECUTE" });
    const childPlist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.inherit</key><true/></dict></plist>\n";
    expect(parseMacAppStoreDevelopmentEntitlementResult(
      entitlementCommandResult(childPath, childPlist),
      { entitlementPolicy: childPolicy.entitlementPolicy, executablePath: childPath, label: "helper" },
    )).toMatchObject({ kind: "plist", entitlementPolicy: "child", plist: childPlist });
    expect(parseMacAppStoreDevelopmentEntitlementResult(
      entitlementCommandResult(childPath, childPlist, { warning: false }),
      { entitlementPolicy: childPolicy.entitlementPolicy, executablePath: childPath, label: "helper" },
    )).toMatchObject({ kind: "plist", entitlementPolicy: "child", plist: childPlist });
    expect(projectMacAppStoreDevelopmentEntitlementEvidence({
      "com.apple.security.app-sandbox": true,
      "com.apple.security.inherit": true,
    }, childPolicy.entitlementPolicy, "helper")).toEqual({
      entitlementKeys: ["com.apple.security.app-sandbox", "com.apple.security.inherit"],
    });
    expect(projectMacAppStoreDevelopmentEntitlementEvidence(
      null,
      noEntitlementObjects[0].policy.entitlementPolicy,
      "pty.node",
    )).toEqual({ entitlementKeys: [] });
    expect(() => projectMacAppStoreDevelopmentEntitlementEvidence(
      null,
      childPolicy.entitlementPolicy,
      "helper",
    )).toThrow(/missing its required entitlement plist/);
    expect(() => projectMacAppStoreDevelopmentEntitlementEvidence(
      { "com.apple.security.app-sandbox": true },
      noEntitlementObjects[0].policy.entitlementPolicy,
      "pty.node",
    )).toThrow(/must not contain an entitlement plist or entitlement keys/);
    expect(() => validateEntitlementKeys({
      "com.apple.security.app-sandbox": true,
      "com.apple.security.inherit": true,
      "com.apple.security.network.client": true,
    }, childPolicy.expectedEntitlementKeys, "helper")).toThrow(/exactly/);

    const signedBundlePlist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>\n";
    for (const { path: executablePath, label, policy } of noEntitlementObjects) {
      expect(() => parseMacAppStoreDevelopmentEntitlementResult(
        entitlementCommandResult(executablePath, signedBundlePlist),
        { entitlementPolicy: policy.entitlementPolicy, executablePath, label },
      )).toThrow(/must not contain an entitlement plist/);
    }
    expect(() => parseMacAppStoreDevelopmentEntitlementResult(
      { exitCode: 1, stdout: "", stderr: "Permission denied\n" },
      { entitlementPolicy: noEntitlementObjects[0].policy.entitlementPolicy, executablePath: profilePath, label: "pty.node" },
    )).toThrow(/entitlement inspection failed/);
    expect(() => parseMacAppStoreDevelopmentEntitlementResult(
      entitlementCommandResult(profilePath, "not plist\n"),
      { entitlementPolicy: noEntitlementObjects[0].policy.entitlementPolicy, executablePath: profilePath, label: "pty.node" },
    )).toThrow(/malformed plist output/);
    expect(() => parseMacAppStoreDevelopmentEntitlementResult(
      { ...entitlementCommandResult(profilePath), stderr: `${entitlementCommandResult(profilePath).stderr}unexpected\n` },
      { entitlementPolicy: noEntitlementObjects[0].policy.entitlementPolicy, executablePath: profilePath, label: "pty.node" },
    )).toThrow(/malformed codesign diagnostics/);
    expect(() => parseMacAppStoreDevelopmentEntitlementResult(
      { ...entitlementCommandResult(profilePath, "", { warning: false }), stderr: "Executable=/tmp/other\n" },
      { entitlementPolicy: noEntitlementObjects[0].policy.entitlementPolicy, executablePath: profilePath, label: "pty.node" },
    )).toThrow(/malformed codesign diagnostics/);
  });

  test("accepts only the expected unsigned embedded-profile codesign diagnostic", () => {
    expect(parseUnsignedCodesignProfileDiagnostic({
      exitCode: 1,
      stderr: "/tmp/Meetless.app/Contents/embedded.provisionprofile: code object is not signed at all\n",
    })).toEqual({ exitCode: 1, diagnostic: "code object is not signed at all" });
    expect(() => parseUnsignedCodesignProfileDiagnostic({
      exitCode: 0,
      stdout: "signed code object",
    })).toThrow(/unsigned-code-object diagnostic/);
    expect(() => parseUnsignedCodesignProfileDiagnostic({
      exitCode: 1,
      stderr: "code object is signed",
    })).toThrow(/unsigned-code-object diagnostic/);
    expect(() => parseUnsignedCodesignProfileDiagnostic({
      exitCode: 1,
      stderr: "permission denied",
    })).toThrow(/unsigned-code-object diagnostic/);
    expect(() => parseUnsignedCodesignProfileDiagnostic({
      exitCode: 1,
      stderr: "/tmp/Meetless.app/Contents/embedded.provisionprofile: code object is not signed at all\nunrelated failure",
    })).toThrow(/unsigned-code-object diagnostic/);
  });

  test("keeps the direct package command unchanged and makes MAS inputs explicit", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["package:macos:arm64"]).toBe(
      "npm run build && node scripts/package-macos.mjs --signing-mode=local-ad-hoc --proof-root=$(mktemp -d /private/tmp/meetless-package-proof.XXXXXX)",
    );
    expect(packageJson.scripts["package:macos:app-store:development"]).toContain(
      "--proof-root=$(mktemp -d /private/tmp/meetless-mas-development-proof.XXXXXX)",
    );
    expect(packageJson.scripts["package:macos:app-store:development"]).toContain(R5_APP_STORE_DEVELOPMENT_PROFILE_UUID);
    expect(packageJson.scripts["package:macos:app-store:development"]).toContain(
      `$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/${R5_APP_STORE_DEVELOPMENT_PROFILE_FILENAME}`,
    );
    expect(packageJson.scripts["package:macos:app-store:development"]).not.toContain("Library/MobileDevice/Provisioning Profiles");
    expect(packageJson.scripts["package:macos:app-store:development"]).toContain(R5_APP_STORE_DEVELOPMENT_IDENTITY);
    expect(packageJson.scripts["package:macos:app-store:development"]).not.toContain("MEETLESS_REVENUECAT_PUBLIC_SDK_KEY");
  });

  test("resolves the accepted profile from the current user's Xcode directory", () => {
    expect(resolveR5DevelopmentProfilePath("/Users/example")).toBe(
      "/Users/example/Library/Developer/Xcode/UserData/Provisioning Profiles/828a0bac-887f-4e60-9e4b-9da7690178bc.mobileprovision",
    );
  });

  test("binds the MAS marker to the pinned Paseo commit without running the packager", async () => {
    const calls: unknown[][] = [];
    const commit = await resolveR5DevelopmentPaseoCommit("/workspace/meetless", {
      execute: async (...arguments_) => {
        calls.push(arguments_);
        return { stdout: "a2c8ff349ffdf6f500eb09270c7f44af4c018bfc\n" };
      },
    });
    expect(commit).toBe("a2c8ff349ffdf6f500eb09270c7f44af4c018bfc");
    expect(calls).toEqual([[
      "git",
      ["-C", "/workspace/meetless/vendor/paseo", "rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: "/workspace/meetless" },
    ]]);

    await expect(resolveR5DevelopmentPaseoCommit("/workspace/meetless", {
      execute: async () => ({ stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }),
    })).rejects.toThrow(/Paseo is pinned.*docs\/decisions\/0001-maintained-paseo-fork\.md.*restore vendor\/paseo/s);
    await expect(resolveR5DevelopmentPaseoCommit("/workspace/meetless", {
      execute: async () => ({ stdout: "not-a-commit\n" }),
    })).rejects.toThrow(/invalid Paseo commit marker/);
    await expect(resolveR5DevelopmentPaseoCommit("relative-repository", {
      execute: async () => ({ stdout: "a2c8ff349ffdf6f500eb09270c7f44af4c018bfc" }),
    })).rejects.toThrow(/absolute repository root/);
  });

  test("binds the exact profile, team, app, and one current Mac", () => {
    expect(validateR5DevelopmentProfile(profile())).toEqual(profile());
    expect(() => validateR5DevelopmentProfile({ ...profile(), ProvisionedDevices: [] })).toThrow(/accepted Mac Studio/);
    expect(() => validateR5DevelopmentProfile({ ...profile(), ProvisionsAllDevices: true })).toThrow(/all devices/);
    expect(() => validateR5DevelopmentProfile({ ...profile(), UUID: "other" })).toThrow(/accepted R5 profile/);
    expect(() => validateR5DevelopmentProfile({ ...profile(), ProvisionedDevices: ["other"] })).toThrow(/accepted Mac Studio/);
    expect(() => validateR5DevelopmentProfile(profile(), { now: new Date("2027-09-01T15:21:30Z") })).toThrow(/expired/);
    expect(() => validateR5DevelopmentProfile({ ...profile(), ExpirationDate: "not-a-date" })).toThrow(/expired/);
    expect(() => validateR5DevelopmentProfile({
      ...profile(),
      Entitlements: { ...profile().Entitlements, "com.apple.developer.team-identifier": "OTHER" },
    })).toThrow(/team identifier/);
    expect(() => validateR5DevelopmentProfile({ ...profile(), TeamIdentifier: ["OTHER"] })).toThrow(/TeamIdentifier/);
  });
});
