import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  MACOS_APP_STORE_CHILD_ENTITLEMENTS,
  MACOS_APP_STORE_CONTRACT,
  MACOS_APP_STORE_ELECTRON_BUNDLE_ID,
  MACOS_APP_STORE_PARENT_ENTITLEMENTS,
  resolveMacAppStoreApplicationGroup,
  validateEntitlementKeys,
  validateMacAppStoreEntitlementClosure,
  validateMacAppStoreContract,
} from "../../../scripts/lib/macos-app-store-contract.mjs";

describe("Mac App Store distribution contract", () => {
  test("pins the MAS Electron artifact and container-owned writable state", async () => {
    expect(JSON.parse(await readFile("scripts/lib/macos-app-store-contract.json", "utf8"))).toEqual(MACOS_APP_STORE_CONTRACT);
    expect(MACOS_APP_STORE_CONTRACT).toMatchObject({
      target: "macos-app-store-arm64",
      bundleIdentifier: "com.meetless.app",
      electron: {
        version: "41.2.0",
        platform: "mas",
        arch: "arm64",
        bundleIdentifier: MACOS_APP_STORE_ELECTRON_BUNDLE_ID,
        archiveName: "electron-v41.2.0-mas-arm64.zip",
        sha256: "e153b855ba023f1edfcad4a07b22c30b4d48af57530c04808cffc6c75e17bc7d",
      },
      state: { owner: "app-container", externalExport: "user-selected-security-scoped-destination" },
      signing: {
        identityKind: "Apple Distribution",
        inAppPurchaseCapability: "App Store Connect",
        applicationGroup: {
          source: "build-input",
          defaultValue: "63M98WD275.com.meetless.app",
        },
      },
    });
  });

  test("rejects the direct Electron artifact and unrestricted writable paths", () => {
    expect(() => validateMacAppStoreContract({
      ...MACOS_APP_STORE_CONTRACT,
      electron: { ...MACOS_APP_STORE_CONTRACT.electron, platform: "darwin" },
    })).toThrow(/mas arm64 artifact/);
    expect(() => validateMacAppStoreContract({
      ...MACOS_APP_STORE_CONTRACT,
      electron: { ...MACOS_APP_STORE_CONTRACT.electron, sha256: "0".repeat(64) },
    })).toThrow(/SHA-256/);
    expect(() => validateMacAppStoreContract({
      ...MACOS_APP_STORE_CONTRACT,
      state: { ...MACOS_APP_STORE_CONTRACT.state, owner: "user-home" },
    })).toThrow(/app-container owned/);
  });

  test("keeps the nested Electron identity distinct from the App Store host", () => {
    expect(MACOS_APP_STORE_CONTRACT.electron.bundleIdentifier).toBe(MACOS_APP_STORE_ELECTRON_BUNDLE_ID);
    expect(validateMacAppStoreContract(MACOS_APP_STORE_CONTRACT)).toBe(MACOS_APP_STORE_CONTRACT);
    expect(() => validateMacAppStoreContract({
      ...MACOS_APP_STORE_CONTRACT,
      electron: { ...MACOS_APP_STORE_CONTRACT.electron, bundleIdentifier: MACOS_APP_STORE_CONTRACT.bundleIdentifier },
    })).toThrow(/must differ from the parent bundle identifier/);
    expect(() => validateMacAppStoreContract({
      ...MACOS_APP_STORE_CONTRACT,
      electron: { ...MACOS_APP_STORE_CONTRACT.electron, bundleIdentifier: "com.github.Electron" },
    })).toThrow(/nested Electron bundle identifier must be/);
  });

  test("requires the exact parent and inherited-child sandbox closure", () => {
    const applicationGroup = resolveMacAppStoreApplicationGroup();
    const parent = Object.fromEntries(MACOS_APP_STORE_PARENT_ENTITLEMENTS.map((key) => [
      key,
      key === "com.apple.security.application-groups" ? [applicationGroup.applicationGroup] : true,
    ]));
    const child = Object.fromEntries(MACOS_APP_STORE_CHILD_ENTITLEMENTS.map((key) => [key, true]));
    expect(validateMacAppStoreEntitlementClosure(parent, child)).toEqual(applicationGroup);
    for (const permission of ["com.apple.security.files.user-selected.read-write", "com.apple.security.files.bookmarks.app-scope"]) {
      expect(parent[permission]).toBe(true);
      expect(() => validateMacAppStoreEntitlementClosure({ ...parent, [permission]: undefined }, child)).toThrow();
    }
    expect(() => validateMacAppStoreEntitlementClosure({ ...parent, "com.apple.security.temporary-exception.files.home-relative-path.read-write": ["/"] }, child)).toThrow(/exactly/);
    expect(validateEntitlementKeys(parent, MACOS_APP_STORE_PARENT_ENTITLEMENTS, "parent app", applicationGroup)).toEqual(parent);
    expect(validateEntitlementKeys(child, MACOS_APP_STORE_CHILD_ENTITLEMENTS, "child")).toEqual(child);
    expect(() => validateMacAppStoreEntitlementClosure(
      { ...parent, "com.apple.security.application-groups": ["ABCDE12345.com.meetless.app"] },
      child,
    )).toThrow(/expected 63M98WD275\.com\.meetless\.app/);
    expect(() => validateMacAppStoreEntitlementClosure(
      { ...parent, "com.apple.security.application-groups": undefined },
      child,
    )).toThrow(/application-groups/);
    expect(() => validateEntitlementKeys({ ...child, "com.apple.security.network.client": true }, MACOS_APP_STORE_CHILD_ENTITLEMENTS, "child"))
      .toThrow(/exactly/);
    expect(() => validateEntitlementKeys({ ...parent, "com.apple.developer.in-app-payments": true }, MACOS_APP_STORE_PARENT_ENTITLEMENTS, "parent app"))
      .toThrow(/exactly|Apple Pay/);
  });

  test("accepts an explicit build-time Team ID/application-group input and rejects a mismatch", () => {
    expect(resolveMacAppStoreApplicationGroup({ teamId: "ABCDE12345" })).toEqual({
      teamId: "ABCDE12345", applicationGroup: "ABCDE12345.com.meetless.app",
    });
    expect(resolveMacAppStoreApplicationGroup({ applicationGroup: "ABCDE12345.com.meetless.app" })).toEqual({
      teamId: "ABCDE12345", applicationGroup: "ABCDE12345.com.meetless.app",
    });
    expect(() => resolveMacAppStoreApplicationGroup({
      teamId: "ABCDE12345", applicationGroup: "63M98WD275.com.meetless.app",
    })).toThrow(/does not belong/);
    expect(() => resolveMacAppStoreApplicationGroup({ applicationGroup: "ABCDE12345.com.other.app" }))
      .toThrow(/expected/);
  });
});
