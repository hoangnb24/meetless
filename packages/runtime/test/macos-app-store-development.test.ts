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
  resolveR5DevelopmentProfilePath,
  validateMacAppStoreDevelopmentInfo,
  validateR5DevelopmentElectronFileOutput,
  validateR5DevelopmentElectronInfo,
  validateR5DevelopmentProfile,
  validateR5DevelopmentSignature,
  validateRevenueCatPublicSdkKey,
} from "../../../scripts/lib/macos-app-store-development.mjs";

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
