import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { inspectPackageMachOEntries, parseMachOHeader, parseMachOHeaders } from "../../../scripts/lib/macos-package-inventory.mjs";
import { verifyIndividualMachOSignature } from "../../../scripts/validate-macos-package.mjs";
import {
  buildSigningOrder,
  canonicalizeEntitlements,
  codesignArguments,
  collectMacOSSignatureEvidence,
  createSigningMetadata,
  digestSignatureState,
  loadEntitlementPolicy,
  MACOS_APPROVED_ENTITLEMENT_MAP,
  MACOS_APPROVED_OUTER_ENTITLEMENT,
  MACOS_ENTITLEMENT_MAP_PATH,
  MACOS_REQUIRED_MACHO_ARCHITECTURE,
  MACOS_REQUIRED_MACHO_FILE_TYPE,
  MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1,
  MACOS_REQUIRED_DEVELOPER_ID_TEAM,
  MACOS_LOCAL_TIMESTAMP_ARGUMENT,
  MACOS_RELEASE_TIMESTAMP_ARGUMENT,
  normalizeSigningOptions,
  parseCertificateEvidence,
  parseCodesignDisplay,
  parseSecurityIdentityOutput,
  parseSigningArguments,
  resolveDeveloperIdSigner,
  validateApprovedEntitlementMachOEntries,
  validateMacOSPurposeStrings,
  validateSigningMetadata,
} from "../../../scripts/lib/macos-package-signing.mjs";

const execFileAsync = promisify(execFile);

describe("macOS standalone Mach-O signing boundary", () => {
  it("accepts a final individually signed Mach-O", async () => {
    const fixture = await signedTemporaryMachO();
    try {
      await expect(verifyIndividualMachOSignature("Contents/Resources/fixture", fixture.binary)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a modified signed Mach-O with its actionable path", async () => {
    const fixture = await signedTemporaryMachO();
    try {
      const bytes = await readFile(fixture.binary);
      bytes[872] ^= 1;
      await writeFile(fixture.binary, bytes);
      await expect(verifyIndividualMachOSignature("Contents/Resources/fixture", fixture.binary)).rejects.toThrow(
        /standalone Mach-O Contents\/Resources\/fixture failed individual codesign verification.*sign every final manifest Mach-O/s,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires an explicit release identity and entitlement input", () => {
    expect(() => parseSigningArguments([], { requireMode: true })).toThrow(/signing mode is not explicit/);
    expect(() => normalizeSigningOptions({ mode: "release" })).toThrow(/release signing identity is missing/);
    expect(() => normalizeSigningOptions({ mode: "release", signingIdentity: "Developer ID Application: Meetless", entitlementMapPath: "owner-map.json" })).toThrow(
      /entitlement map override/,
    );
    expect(() => normalizeSigningOptions({ mode: "release", signingIdentity: "-", entitlementMapPath: "owner-map.json" })).toThrow(
      /is ad-hoc/,
    );
    expect(() => normalizeSigningOptions({ mode: "release", signingIdentity: "Developer ID Application: Meetless (ABCDE12345)", entitlementsPath: "owner.plist", entitlementMapPath: "owner-map.json" })).toThrow(
      /single outer-app entitlement file/,
    );
  });

  it("preserves values after the first CLI equals and rejects an extra mode equals", () => {
    expect(parseSigningArguments([
      "--signing-mode=release",
      "--signing-identity=Developer ID Application: A=B (ABCDE12345)",
      "/tmp/manifest=release.json",
    ], { requireMode: true })).toMatchObject({
      signingMode: "release",
      signingIdentity: "Developer ID Application: A=B (ABCDE12345)",
      manifestPath: "/tmp/manifest=release.json",
    });
    expect(() => parseSigningArguments(["--entitlement-map=/tmp/policy=release.json"])).toThrow(/cannot be overridden/);
    expect(() => parseSigningArguments(["--signing-mode=release=unexpected"], { requireMode: true })).toThrow(/unsupported signing mode release=unexpected/);
  });

  it("resolves one exact Developer ID Application certificate and rejects invalid or ambiguous identities", async () => {
    const identity = `Developer ID Application: A=B (${MACOS_REQUIRED_DEVELOPER_ID_TEAM})`;
    const identityOutput = `  1) ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1} "${identity}"\n     1 valid identities found`;
    const certificateOutput = `SHA-256 hash: ${"b".repeat(64)}\nSHA-1 hash: ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1}\n`;
    await expect(resolveDeveloperIdSigner({
      requestedIdentity: identity,
      expectedTeamId: MACOS_REQUIRED_DEVELOPER_ID_TEAM,
      findIdentityOutput: identityOutput,
      findCertificateOutput: certificateOutput,
    })).resolves.toEqual({
      identity,
      certificateSha1: MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1,
      certificateFingerprint: "b".repeat(64),
      teamId: MACOS_REQUIRED_DEVELOPER_ID_TEAM,
    });
    expect(parseSecurityIdentityOutput(identityOutput)).toHaveLength(1);
    expect(parseCertificateEvidence(certificateOutput, MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1).certificateFingerprint).toBe("b".repeat(64));

    for (const invalidIdentity of [
      "Apple Development: Meetless (ABCDE12345)",
      "Apple Distribution: Meetless (ABCDE12345)",
    ]) {
      await expect(resolveDeveloperIdSigner({
        requestedIdentity: invalidIdentity,
        findIdentityOutput: `  1) ${MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1} "${invalidIdentity}"`,
        findCertificateOutput: certificateOutput,
      })).rejects.toThrow(/not a Developer ID Application leaf signer/);
    }
    await expect(resolveDeveloperIdSigner({
      requestedIdentity: identity,
      findIdentityOutput: `${identityOutput}\n  2) ${"c".repeat(40)} "${identity}"`,
      findCertificateOutput: certificateOutput,
    })).rejects.toThrow(/ambiguous/);
    await expect(resolveDeveloperIdSigner({
      requestedIdentity: identity,
      expectedTeamId: "WRONGTEAM",
      findIdentityOutput: identityOutput,
      findCertificateOutput: certificateOutput,
    })).rejects.toThrow(/differs from requested Team ID/);
    await expect(resolveDeveloperIdSigner({
      requestedIdentity: identity,
      findIdentityOutput: identityOutput,
      findCertificateOutput: "",
    })).rejects.toThrow(/certificate evidence.*absent/);
  });

  it("compares entitlement plist semantics after canonicalization", async () => {
    const first = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>b</key><string>two</string><key>a</key><string>one</string></dict></plist>`;
    const equivalent = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>\n  <key>a</key><string>one</string>\n  <key>b</key><string>two</string>\n</dict></plist>`;
    const changed = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>a</key><string>changed</string><key>b</key><string>two</string></dict></plist>`;
    const extra = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>a</key><string>one</string><key>b</key><string>two</string><key>extra</key><true/></dict></plist>`;
    const missing = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>a</key><string>one</string></dict></plist>`;
    await expect(canonicalizeEntitlements(Buffer.from(first))).resolves.toMatchObject({ sha256: expect.any(String) });
    await expect(canonicalizeEntitlements(Buffer.from(first))).resolves.toMatchObject(await canonicalizeEntitlements(Buffer.from(equivalent)));
    await expect(canonicalizeEntitlements(Buffer.from(first))).resolves.not.toMatchObject(await canonicalizeEntitlements(Buffer.from(changed)));
    await expect(canonicalizeEntitlements(Buffer.from(first))).resolves.not.toMatchObject(await canonicalizeEntitlements(Buffer.from(extra)));
    await expect(canonicalizeEntitlements(Buffer.from(first))).resolves.not.toMatchObject(await canonicalizeEntitlements(Buffer.from(missing)));
  });

  it("loads the exact owner-approved outer plus two-plist executable map", async () => {
    const policy = await loadEntitlementPolicy({
      entitlementMapPath: MACOS_ENTITLEMENT_MAP_PATH,
      repositoryRoot: process.cwd(),
    });
    expect(policy.mapPath).toBe(MACOS_ENTITLEMENT_MAP_PATH);
    expect(policy.sourcePlists.map((source) => source.path)).toEqual([
      "scripts/macos-entitlements/entitlements/audio-input.plist",
      "scripts/macos-entitlements/entitlements/jit.plist",
    ]);
    expect(policy.entries.map(({ path, class: policyClass, plist }) => ({ path, class: policyClass, plist }))).toEqual(
      MACOS_APPROVED_ENTITLEMENT_MAP.map(({ path, class: policyClass, plist }) => ({ path, class: policyClass, plist })),
    );
    expect(policy.outer).toMatchObject(MACOS_APPROVED_OUTER_ENTITLEMENT);
  });

  it.each([
    ["false-valued key", (plist: string) => plist.replace("<true/>", "<false/>")],
    ["extra key", (plist: string) => plist.replace("</dict>", "<key>com.apple.security.cs.disable-library-validation</key><true/></dict>")],
    ["changed key", (plist: string) => plist.replace("com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input")],
  ])("rejects %s in an owner plist", async (_label, mutate) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-entitlement-policy-test-"));
    try {
      await writeFile(path.join(root, "entitlement-map.json"), await readFile("scripts/macos-entitlements/entitlement-map.json"));
      await mkdir(path.join(root, "entitlements"), { recursive: true });
      await copyFile("scripts/macos-entitlements/entitlements/audio-input.plist", path.join(root, "entitlements/audio-input.plist"));
      await copyFile("scripts/macos-entitlements/entitlements/jit.plist", path.join(root, "entitlements/jit.plist"));
      const jitPath = path.join(root, "entitlements/jit.plist");
      const jit = (await readFile(jitPath, "utf8"));
      await writeFile(jitPath, mutate(jit));
      await expect(loadEntitlementPolicy({ entitlementMapPath: path.join(root, "entitlement-map.json"), repositoryRoot: root })).rejects.toThrow(/owner entitlement plist|observed keys|expected policy/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins release policy loading to non-symlink, in-repository authority paths", async () => {
    const cases = [
      {
        label: "symlink parent",
        mutate: async (root: string, outside: string) => {
          await mkdir(path.join(root, "real"), { recursive: true });
          await copyPolicyFixture(path.join(root, "real"));
          await symlink(path.join(root, "real"), path.join(root, "alias"));
          return path.join(root, "alias", "entitlement-map.json");
        },
        expected: /symlink component/,
      },
      {
        label: "symlink final map",
        mutate: async (root: string, outside: string) => {
          await copyPolicyFixture(root);
          await symlink(path.join(root, "entitlement-map.json"), path.join(root, "map-link.json"));
          return path.join(root, "map-link.json");
        },
        expected: /symlink component/,
      },
      {
        label: "symlink plist",
        mutate: async (root: string, outside: string) => {
          await copyPolicyFixture(root);
          await writeFile(path.join(outside, "jit.plist"), await readFile(path.join(root, "entitlements", "jit.plist")));
          await rm(path.join(root, "entitlements", "jit.plist"));
          await symlink(path.join(outside, "jit.plist"), path.join(root, "entitlements", "jit.plist"));
          return path.join(root, "entitlement-map.json");
        },
        expected: /symlink component/,
      },
      {
        label: "traversal",
        mutate: async (root: string) => {
          await copyPolicyFixture(root);
          return `${root}/../${path.basename(root)}/entitlement-map.json`;
        },
        expected: /traversal path/,
      },
      {
        label: "absolute escape",
        mutate: async (root: string, outside: string) => {
          await copyPolicyFixture(root);
          return path.join(outside, "entitlement-map.json");
        },
        expected: /escapes repository authority/,
      },
    ];
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), "meetless-entitlement-authority-test-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "meetless-entitlement-external-test-"));
      try {
        const mapPath = await testCase.mutate(root, outside);
        await expect(loadEntitlementPolicy({ entitlementMapPath: mapPath, repositoryRoot: root })).rejects.toThrow(testCase.expected);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  });

  it("requires every approved entitlement path to be a regular arm64 MH_EXECUTE", () => {
    const entries = MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({ path: mapping.path, type: "file" }));
    const machoEntries = MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({
      path: mapping.path,
      machOSlices: [{ fileType: MACOS_REQUIRED_MACHO_FILE_TYPE, architecture: MACOS_REQUIRED_MACHO_ARCHITECTURE }],
    }));
    const policy = { entries: MACOS_APPROVED_ENTITLEMENT_MAP };
    expect(() => validateApprovedEntitlementMachOEntries({ entries, machoEntries, policy })).not.toThrow();
    for (const invalidType of ["MH_DYLIB", "MH_BUNDLE", "MH_OBJECT"]) {
      expect(() => validateApprovedEntitlementMachOEntries({
        entries,
        machoEntries: machoEntries.map((entry) => entry.path.endsWith("runtime/node") ? { ...entry, machOSlices: [{ architecture: "arm64", fileType: invalidType }] } : entry),
        policy,
      })).toThrow(/runtime\/node.*expected exactly \[arm64\/all MH_EXECUTE\]/);
    }
    expect(() => validateApprovedEntitlementMachOEntries({
      entries: entries.map((entry) => entry.path.endsWith("runtime/node") ? { ...entry, type: "symlink" } : entry),
      machoEntries,
      policy,
    })).toThrow(/runtime\/node.*not a regular file/);
    expect(parseMachOHeader("Mach header\nMH_MAGIC_64 ARM64 ALL 0x00 EXECUTE 20 0 0")).toEqual({
      machOFileType: MACOS_REQUIRED_MACHO_FILE_TYPE,
      machOArchitecture: MACOS_REQUIRED_MACHO_ARCHITECTURE,
    });
  });

  it("validates every Mach-O architecture slice before entitlement signing", () => {
    const entries = MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({ path: mapping.path, type: "file" }));
    const policy = { entries: MACOS_APPROVED_ENTITLEMENT_MAP };
    const validSlices = [{ architecture: "arm64", fileType: "MH_EXECUTE" }];
    expect(parseMachOHeaders([
      "Mach header",
      "MH_MAGIC_64 ARM64 ALL 0x00 EXECUTE 20 0 0",
      "Mach header",
      "MH_MAGIC_64 X86_64 ALL 0x00 EXECUTE 20 0 0",
    ].join("\n"), "universal-fixture")).toMatchObject({
      machOSlices: [
        { architecture: "arm64", fileType: "MH_EXECUTE" },
        { architecture: "x86_64", fileType: "MH_EXECUTE" },
      ],
    });

    for (const [label, slices] of [
      ["universal arm64+x86_64", [{ architecture: "arm64", fileType: "MH_EXECUTE" }, { architecture: "x86_64", fileType: "MH_EXECUTE" }]],
      ["universal arm64+arm64e", [{ architecture: "arm64", fileType: "MH_EXECUTE" }, { architecture: "arm64e", fileType: "MH_EXECUTE" }]],
      ["arm64e-only", [{ architecture: "arm64e", fileType: "MH_EXECUTE" }]],
      ["x86_64-only", [{ architecture: "x86_64", fileType: "MH_EXECUTE" }]],
      ["multi-header MH_DYLIB", [{ architecture: "arm64", fileType: "MH_DYLIB" }, { architecture: "arm64e", fileType: "MH_DYLIB" }]],
    ] as const) {
      const machoEntries = MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({
        path: mapping.path,
        machOSlices: mapping.path.endsWith("runtime/node") ? slices : validSlices,
      }));
      let codesignCalls = 0;
      expect(() => {
        validateApprovedEntitlementMachOEntries({ entries, machoEntries, policy });
        codesignCalls += 1;
      }, label).toThrow(/runtime\/node.*observed Mach-O slices.*expected exactly \[arm64\/all MH_EXECUTE\]/);
      expect(codesignCalls, `${label} must reject before codesign`).toBe(0);
    }

    expect(() => parseMachOHeaders([
      "Mach header",
      "MH_MAGIC_64 ARM64 ALL 0x00 EXECUTE 20 0 0",
      "Mach header",
      "MH_MAGIC_64 ARM64 ALL 0x00 DYLIB 20 0 0",
    ].join("\n"), "duplicate-fixture")).toThrow(/duplicate or ambiguous architecture arm64/);

    expect(() => validateApprovedEntitlementMachOEntries({
      entries,
      machoEntries: MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({ path: mapping.path, machOSlices: validSlices })),
      policy,
    })).not.toThrow();
  });

  it("uses actual otool -arch all inventory evidence for universal, arm64e, and thin arm64 fixtures", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-macho-arch-all-test-"));
    try {
      const universalEntries = await inspectPackageMachOEntries("/usr/bin", [{ path: "file", type: "file" }]);
      const universal = universalEntries.find((entry) => entry.path === "file");
      expect(universal?.machOSlices).toEqual([
        { architecture: "arm64", cpuType: "arm64", cpuSubtype: "all", fileType: "MH_EXECUTE" },
        { architecture: "arm64e", cpuType: "arm64", cpuSubtype: "e", fileType: "MH_EXECUTE" },
        { architecture: "x86_64", cpuType: "x86_64", cpuSubtype: "all", fileType: "MH_EXECUTE" },
      ]);
      const universalPolicy = { entries: [{ path: "file", class: "jit" }] };
      let codesignCalls = 0;
      expect(() => {
        validateApprovedEntitlementMachOEntries({
          entries: [{ path: "file", type: "file" }],
          machoEntries: universalEntries,
          policy: universalPolicy,
        });
        codesignCalls += 1;
      }).toThrow(/file.*observed Mach-O slices.*arm64e\/e.*x86_64\/all/);
      expect(codesignCalls).toBe(0);

      await execFileAsync("lipo", ["-thin", "arm64e", "/usr/bin/file", "-output", path.join(root, "arm64e-fixture")]);
      const arm64eEntries = await inspectPackageMachOEntries(root, [{ path: "arm64e-fixture", type: "file" }]);
      expect(arm64eEntries[0]?.machOSlices).toEqual([
        { architecture: "arm64e", cpuType: "arm64", cpuSubtype: "e", fileType: "MH_EXECUTE" },
      ]);
      expect(() => validateApprovedEntitlementMachOEntries({
        entries: [{ path: "arm64e-fixture", type: "file" }],
        machoEntries: arm64eEntries,
        policy: { entries: [{ path: "arm64e-fixture", class: "jit" }] },
      })).toThrow(/arm64e-fixture.*arm64e\/e.*expected exactly \[arm64\/all MH_EXECUTE\]/);

      await execFileAsync("lipo", ["-thin", "arm64", "/usr/bin/file", "-output", path.join(root, "arm64-fixture")]);
      const arm64Entries = await inspectPackageMachOEntries(root, [{ path: "arm64-fixture", type: "file" }]);
      expect(arm64Entries[0]?.machOSlices).toEqual([
        { architecture: "arm64", cpuType: "arm64", cpuSubtype: "all", fileType: "MH_EXECUTE" },
      ]);
      expect(() => validateApprovedEntitlementMachOEntries({
        entries: [{ path: "arm64-fixture", type: "file" }],
        machoEntries: arm64Entries,
        policy: { entries: [{ path: "arm64-fixture", class: "jit" }] },
      })).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records deterministic deepest-first signing and outer-last order", () => {
    const order = buildSigningOrder([
      "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
      "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "Contents/MacOS/MeetlessHost",
    ]);
    expect(order.nestedMachO).toEqual([
      "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/MacOS/Electron",
      "Contents/MacOS/MeetlessHost",
    ]);
    expect(order.all.at(-1)).toBe("Meetless.app");
  });

  it("adds hardened-runtime and exact mapped plists to approved nested and outer targets", () => {
    const nested = codesignArguments({
      mode: "release",
      identity: "Developer ID Application: Meetless (ABCDE12345)",
      target: "/tmp/nested",
      identifier: "com.meetless.nested",
      entitlementsPath: "/tmp/jit.plist",
      outer: false,
    });
    expect(nested).toContain("runtime");
    expect(nested).toContain(MACOS_RELEASE_TIMESTAMP_ARGUMENT);
    expect(nested).toEqual(expect.arrayContaining(["--entitlements", "/tmp/jit.plist"]));
    const outer = codesignArguments({
      mode: "release",
      identity: "Developer ID Application: Meetless (ABCDE12345)",
      target: "/tmp/Meetless.app",
      identifier: "com.meetless.app",
      outer: true,
    });
    expect(outer).toEqual(expect.arrayContaining(["--options", "runtime"]));
    expect(outer).toContain(MACOS_RELEASE_TIMESTAMP_ARGUMENT);
    expect(outer).toEqual(expect.arrayContaining(["--entitlements", path.resolve("scripts/macos-entitlements/entitlements/audio-input.plist")]));
    expect(codesignArguments({
      mode: "release",
      identity: "Developer ID Application: Meetless (ABCDE12345)",
      target: "/tmp/Meetless.app",
      identifier: "com.meetless.app",
      entitlementsPath: "/tmp/owner.entitlements",
      outer: true,
    })).toEqual(expect.arrayContaining(["--entitlements", "/tmp/owner.entitlements"]));
    expect(codesignArguments({
      mode: "local-ad-hoc",
      identity: "-",
      target: "/tmp/local",
      identifier: "com.meetless.local",
      outer: false,
    })).not.toContain("runtime");
    expect(codesignArguments({
      mode: "local-ad-hoc",
      identity: "-",
      target: "/tmp/local",
      identifier: "com.meetless.local",
    })).toContain(MACOS_LOCAL_TIMESTAMP_ARGUMENT);
  });

  it("requires every outer TCC purpose string and names the compliant next action", () => {
    const valid = Object.fromEntries(["NSMicrophoneUsageDescription", "NSScreenCaptureUsageDescription", "NSAudioCaptureUsageDescription"].map((key) => [key, "Meetless needs access."]));
    expect(() => validateMacOSPurposeStrings(valid)).not.toThrow();
    for (const key of Object.keys(valid)) {
      expect(() => validateMacOSPurposeStrings({ ...valid, [key]: "" })).toThrow(new RegExp(`${key}.*native/macos-host/Info\\.plist.*docs/plans/active/v1-paseo-foundation\\.md`, "s"));
    }
  });

  it("parses secure timestamp evidence and rejects a release signature without it", () => {
    const common = [
      "Identifier=com.meetless.fixture",
      "TeamIdentifier=63M98WD275",
      "Authority=Developer ID Application: Meetless (63M98WD275)",
      "Signature=CMS",
      "flags=0x10000(runtime)",
      "CDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ].join("\n");
    expect(parseCodesignDisplay(`${common}\nTimestamp=none`, "nested")).toMatchObject({ timestamp: "none", secureTimestamp: false });
    expect(parseCodesignDisplay(`${common}\nTimestamp=Aug 27, 2026 at 12:00:00 +0000`, "nested")).toMatchObject({ secureTimestamp: true });
    const fixture = releaseFixture();
    fixture.signatureState.nestedMachO[0].timestamp = "none";
    fixture.signatureState.nestedMachO[0].secureTimestamp = false;
    fixture.signatureStateDigest = digestSignatureState(fixture.signatureState);
    fixture.manifestBinding.signatureStateDigest = fixture.signatureStateDigest;
    expect(() => validateSigningMetadata(fixture, { machoPaths: fixture.order.nestedMachO, entitlementPolicy: fixture.policy })).toThrow(/secure timestamp/);
  });

  it("keeps local-ad-hoc metadata and every image entitlement-free", () => {
    const fixture = localFixture();
    expect(fixture.entitlements.observed.every((image: any) => image.signedSha256 === null && image.signedCanonicalSha256 === null && image.observedKeys.length === 0)).toBe(true);
    fixture.signatureState.nestedMachO[0].entitlementsSha256 = "a".repeat(64);
    fixture.signatureState.nestedMachO[0].entitlementsCanonicalSha256 = "b".repeat(64);
    fixture.signatureState.nestedMachO[0].entitlementKeys = ["com.apple.security.cs.disable-library-validation"];
    fixture.signatureStateDigest = digestSignatureState(fixture.signatureState);
    fixture.manifestBinding.signatureStateDigest = fixture.signatureStateDigest;
    expect(() => validateSigningMetadata(fixture, { machoPaths: fixture.order.nestedMachO })).toThrow(
      /local ad-hoc image .*has entitlement keys.*remove --entitlements/,
    );
  });

  it("accepts a structural Developer ID and hardened-runtime contract without a credential", () => {
    const fixture = releaseFixture();
    expect(validateSigningMetadata(fixture, {
      machoPaths: fixture.order.nestedMachO,
      actual: {
        order: fixture.order,
        outer: fixture.signatureState.outer,
        nestedMachO: fixture.signatureState.nestedMachO,
      },
      expectedMode: "release",
      expectedIdentity: fixture.identity.requested,
      entitlementPolicy: fixture.policy,
      expectedTeamId: fixture.identity.teamId,
    })).toEqual(fixture);
  });

  it.each([
    ["JIT on the outer app", (fixture: any) => {
      fixture.signatureState.outer.entitlementsSha256 = "4".repeat(64);
      fixture.signatureState.outer.entitlementsCanonicalSha256 = "3".repeat(64);
      fixture.signatureState.outer.entitlementKeys = ["com.apple.security.cs.allow-jit"];
    }, /entitlement path Meetless\.app.*expected policy class audio-input/],
    ["audio input on the JIT executable", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path.endsWith("runtime/node"));
      image.entitlementsSha256 = "6".repeat(64);
      image.entitlementsCanonicalSha256 = "5".repeat(64);
      image.entitlementKeys = ["com.apple.security.device.audio-input"];
    }, /entitlement path .*runtime\/node.*expected policy class jit/],
    ["missing entitlement on an approved executable", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path.endsWith("runtime/node"));
      image.entitlementsSha256 = null;
      image.entitlementsCanonicalSha256 = null;
      image.entitlementKeys = [];
    }, /entitlement path .*runtime\/node.*observed keys \[\]/],
    ["missing audio input on MeetlessHost", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path === "Contents/MacOS/MeetlessHost");
      image.entitlementsSha256 = null; image.entitlementsCanonicalSha256 = null; image.entitlementKeys = [];
    }, /Contents\/MacOS\/MeetlessHost.*observed keys \[\].*docs\/plans\/active\/v1-paseo-foundation\.md/],
    ["missing audio input on meetless-capture", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path.endsWith("meetless-capture"));
      image.entitlementsSha256 = null; image.entitlementsCanonicalSha256 = null; image.entitlementKeys = [];
    }, /meetless-capture.*observed keys \[\].*docs\/plans\/active\/v1-paseo-foundation\.md/],
    ["outer re-sign state with dropped host entitlement", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path === "Contents/MacOS/MeetlessHost");
      image.entitlementsSha256 = null; image.entitlementsCanonicalSha256 = null; image.entitlementKeys = [];
    }, /Contents\/MacOS\/MeetlessHost.*sign the approved executable/],
    ["audio input on an unapproved image", (fixture: any) => {
      fixture.signatureState.nestedMachO.push({
        ...fixture.signatureState.nestedMachO[0], path: "Contents/Resources/unapproved-tool",
        entitlementsSha256: "7".repeat(64), entitlementsCanonicalSha256: "5".repeat(64),
        entitlementKeys: ["com.apple.security.device.audio-input"],
      });
      fixture.order.nestedMachO.push("Contents/Resources/unapproved-tool");
      fixture.order.all = [...fixture.order.nestedMachO, fixture.order.outer];
    }, /unmapped entitlement-bearing image Contents\/Resources\/unapproved-tool.*v1-paseo-foundation.*approved/s],
    ["union entitlement plist", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path.endsWith("runtime/node"));
      image.entitlementsSha256 = "d".repeat(64);
      image.entitlementsCanonicalSha256 = "e".repeat(64);
      image.entitlementKeys = ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"];
    }, /entitlement path .*runtime\/node.*observed keys/],
    ["risky entitlement key", (fixture: any) => {
      const image = fixture.signatureState.nestedMachO.find((entry: any) => entry.path.endsWith("runtime/node"));
      image.entitlementsSha256 = "d".repeat(64);
      image.entitlementsCanonicalSha256 = "e".repeat(64);
      image.entitlementKeys = ["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"];
    }, /entitlement path .*runtime\/node.*observed keys/],
  ])("rejects %s", (_label, mutate, expected) => {
    const fixture = releaseFixture();
    mutate(fixture);
    expect(() => rebuildStructuralSigning(fixture)).toThrow(expected);
  });

  it("populates each final signature from its own observed certificate evidence", async () => {
    const nestedPaths = ["Contents/MacOS/Helper", "Contents/MacOS/Electron"];
    const certificate = { certificateSha1: "a".repeat(40), certificateFingerprint: "b".repeat(64) };
    const calls: string[] = [];
    const observed = await collectMacOSSignatureEvidence({
      bundlePath: "/tmp/structural-Meetless.app",
      machoPaths: nestedPaths,
      requireCertificateEvidence: true,
      runCodesign: async (_command: string, arguments_: string[]) => {
        if (arguments_.includes("--verify")) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (arguments_.includes("-dvvv")) {
          return {
            stdout: Buffer.from([
              "Identifier=com.meetless.structural",
              "TeamIdentifier=ABCDE12345",
              "Authority=Developer ID Application: Meetless (ABCDE12345)",
              "Signature=CMS",
              "flags=0x10000(runtime)",
              "CDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "",
            ].join("\n")),
            stderr: Buffer.alloc(0),
          };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      extractCertificateEvidence: async (_binaryPath: string, relativePath: string) => {
        calls.push(relativePath);
        return { ...certificate };
      },
    });
    expect(calls).toEqual([...observed.order.nestedMachO, "Meetless.app"]);
    expect(observed.nestedMachO).toHaveLength(2);
    expect(observed.nestedMachO.every((entry) => entry.certificateSha1 === certificate.certificateSha1 && entry.certificateFingerprint === certificate.certificateFingerprint)).toBe(true);
    expect(observed.outer.certificateSha1).toBe(certificate.certificateSha1);
    expect(observed.outer.certificateFingerprint).toBe(certificate.certificateFingerprint);
  });

  it("reads each image's signed entitlement plist independently", async () => {
    const jitPlist = Buffer.from("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>");
    const audioPlist = Buffer.from("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>");
    const codesignCalls: Array<{ command: string; arguments_: string[] }> = [];
    const observed = await collectMacOSSignatureEvidence({
      bundlePath: "/tmp/structural-Meetless.app",
      machoPaths: ["Contents/Resources/meetless/runtime/node", "Contents/Resources/meetless/native/macos-capture/meetless-capture"],
      ownerMode: true,
      runCodesign: async (command: string, arguments_: string[]) => {
        codesignCalls.push({ command, arguments_ });
        if (arguments_.includes("-dvvv")) {
          return {
            stdout: Buffer.from([
              "Identifier=com.meetless.structural",
              "TeamIdentifier=ABCDE12345",
              "Authority=Developer ID Application: Meetless (ABCDE12345)",
              "Signature=CMS",
              "flags=0x10000(runtime)",
              "CDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "",
            ].join("\n")),
            stderr: Buffer.alloc(0),
          };
        }
        if (arguments_.includes("--entitlements")) {
          const binaryPath = String(arguments_.at(-1));
          return { stdout: binaryPath.endsWith("Meetless.app") ? Buffer.alloc(0) : (binaryPath.endsWith("meetless-capture") ? audioPlist : jitPlist), stderr: Buffer.alloc(0) };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const entitlementCalls = codesignCalls.filter(({ arguments_ }) => arguments_.includes("--entitlements"));
    expect(entitlementCalls).toHaveLength(3);
    expect(codesignCalls.every(({ command }) => command === "/usr/bin/codesign")).toBe(true);
    expect(entitlementCalls.every(({ arguments_ }) => arguments_.includes("--xml") && arguments_.includes("-") && !arguments_.includes(":-"))).toBe(true);
    expect(observed.nestedMachO.map((entry) => entry.entitlementKeys)).toEqual([
      ["com.apple.security.device.audio-input"],
      ["com.apple.security.cs.allow-jit"],
    ]);
    expect(observed.outer.entitlementKeys).toEqual([]);
    expect(observed.outer.entitlementsSha256).toBeNull();
    expect(observed.outer.entitlementsCanonicalSha256).toBeNull();
  });

  it.each([
    ["abstract codesign output", Buffer.from("[Dict]\n[Key] = com.apple.security.cs.allow-jit\n[Bool] = true\n")],
    ["malformed XML", Buffer.from("<?xml version=\"1.0\"?><plist><dict>")],
  ])("rejects %s as a signed-entitlement extraction format defect", async (_label, output) => {
    await expect(collectMacOSSignatureEvidence({
      bundlePath: "/tmp/structural-Meetless.app",
      machoPaths: ["Contents/Resources/meetless/runtime/node"],
      ownerMode: true,
      runCodesign: async (command: string, arguments_: string[]) => {
        expect(command).toBe("/usr/bin/codesign");
        if (arguments_.includes("-dvvv")) {
          return {
            stdout: Buffer.from([
              "Identifier=com.meetless.structural",
              "TeamIdentifier=ABCDE12345",
              "Authority=Developer ID Application: Meetless (ABCDE12345)",
              "Signature=CMS",
              "flags=0x10000(runtime)",
              "CDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "",
            ].join("\n")),
            stderr: Buffer.alloc(0),
          };
        }
        if (arguments_.includes("--entitlements")) {
          expect(arguments_).toEqual(["-d", "--entitlements", "-", "--xml", "/tmp/structural-Meetless.app/Contents/Resources/meetless/runtime/node"]);
          return { stdout: output, stderr: Buffer.alloc(0) };
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    })).rejects.toThrow(/signed entitlement extraction format/);
  });

  it.each([
    ["ad-hoc signer", (fixture: any) => { fixture.signatureState.outer.signature = "adhoc"; fixture.signatureState.outer.identity = "-"; fixture.signatureState.outer.teamId = null; }],
    ["missing hardened-runtime flag", (fixture: any) => { fixture.signatureState.outer.flags = []; fixture.signatureState.outer.hardenedRuntime = false; }],
    ["wrong Team ID", (fixture: any) => { fixture.signatureState.nestedMachO[0].teamId = "WRONGTEAM"; }],
    ["resolved signer Team ID mismatch", (fixture: any) => { fixture.identity.teamId = "WRONGTEAM"; fixture.signatureState.outer.teamId = "WRONGTEAM"; fixture.signatureState.nestedMachO[0].teamId = "WRONGTEAM"; }],
    ["same leaf and Team ID with different certificate", (fixture: any) => { fixture.signatureState.nestedMachO[0].certificateSha1 = "3".repeat(40); fixture.signatureState.nestedMachO[0].certificateFingerprint = "4".repeat(64); }],
    ["missing per-image certificate evidence", (fixture: any) => { fixture.signatureState.nestedMachO[0].certificateSha1 = null; fixture.signatureState.nestedMachO[0].certificateFingerprint = null; }],
    ["mismatched observed leaf signer", (fixture: any) => { fixture.signatureState.outer.identity = "Developer ID Application: Other (ABCDE12345)"; }],
    ["missing leaf certificate fingerprint", (fixture: any) => { fixture.identity.certificateFingerprint = null; }],
  ])("rejects a release contract with %s", (_label, mutate) => {
    const fixture = releaseFixture();
    mutate(fixture);
    fixture.signatureStateDigest = digestSignatureState({
      order: fixture.order,
      outer: fixture.signatureState.outer,
      nestedMachO: fixture.signatureState.nestedMachO,
    });
    fixture.manifestBinding.signatureStateDigest = fixture.signatureStateDigest;
    expect(() => validateSigningMetadata(fixture, { machoPaths: fixture.order.nestedMachO, entitlementPolicy: fixture.policy })).toThrow(
      /ad-hoc signer|hardened-runtime flag|Team ID evidence is mismatched|identity evidence is mismatched|Developer ID certificate evidence/,
    );
  });

  it("rejects stale entitlements, unsigned nested Mach-O, and post-signature mutation", () => {
    const staleEntitlements = releaseFixture();
    staleEntitlements.entitlements.mapSha256 = "f".repeat(64);
    expect(() => validateSigningMetadata(staleEntitlements, {
      machoPaths: staleEntitlements.order.nestedMachO,
      entitlementPolicy: staleEntitlements.policy,
    })).toThrow(/entitlement map.*stale|mismatched/);

    const changedEntitlements = releaseFixture();
    changedEntitlements.entitlements.bindings[0].signedCanonicalSha256 = "d".repeat(64);
    changedEntitlements.signatureState.nestedMachO[0].entitlementsCanonicalSha256 = "d".repeat(64);
    changedEntitlements.signatureState.nestedMachO[0].entitlementKeys = ["changed"];
    changedEntitlements.signatureStateDigest = digestSignatureState({
      order: changedEntitlements.order,
      outer: changedEntitlements.signatureState.outer,
      nestedMachO: changedEntitlements.signatureState.nestedMachO,
    });
    changedEntitlements.manifestBinding.signatureStateDigest = changedEntitlements.signatureStateDigest;
    expect(() => validateSigningMetadata(changedEntitlements, { machoPaths: changedEntitlements.order.nestedMachO, entitlementPolicy: changedEntitlements.policy })).toThrow(/entitlement map.*stale|observed keys/);

    const unsignedNested = releaseFixture();
    const actualWithoutNested = {
      order: unsignedNested.order,
      outer: unsignedNested.signatureState.outer,
      nestedMachO: [],
    };
    expect(() => validateSigningMetadata(unsignedNested, {
      machoPaths: unsignedNested.order.nestedMachO,
      actual: actualWithoutNested,
      entitlementPolicy: unsignedNested.policy,
    })).toThrow(/post-signature signing metadata differs/);

    const mutated = releaseFixture();
    mutated.signatureState.outer.cdHash = "c".repeat(40);
    mutated.signatureStateDigest = digestSignatureState({
      order: mutated.order,
      outer: mutated.signatureState.outer,
      nestedMachO: mutated.signatureState.nestedMachO,
    });
    mutated.manifestBinding.signatureStateDigest = mutated.signatureStateDigest;
    expect(() => validateSigningMetadata(mutated, {
      machoPaths: mutated.order.nestedMachO,
      entitlementPolicy: mutated.policy,
      actual: {
        order: mutated.order,
        outer: releaseFixture().signatureState.outer,
        nestedMachO: mutated.signatureState.nestedMachO,
      },
    })).toThrow(/post-signature signing metadata differs/);
  });

  it("keeps signing metadata deterministic and acyclic", () => {
    const first = releaseFixture();
    const second = releaseFixture();
    expect(first).toEqual(second);
    expect(first.manifestBinding.signatureStateDigest).toBe(first.signatureStateDigest);
    expect(first).not.toHaveProperty("artifactDigest");
  });
});

async function copyPolicyFixture(root: string) {
  await writeFile(path.join(root, "entitlement-map.json"), await readFile("scripts/macos-entitlements/entitlement-map.json"));
  await mkdir(path.join(root, "entitlements"), { recursive: true });
  await copyFile("scripts/macos-entitlements/entitlements/audio-input.plist", path.join(root, "entitlements/audio-input.plist"));
  await copyFile("scripts/macos-entitlements/entitlements/jit.plist", path.join(root, "entitlements/jit.plist"));
}

function localFixture() {
  const nested = [{
    path: "Contents/MacOS/MeetlessHost",
    identifier: "com.meetless.local.host",
    identity: "-",
    teamId: null,
    signature: "adhoc",
    authorities: [],
    flags: [],
    hardenedRuntime: false,
    machOSlices: [{ fileType: "MH_EXECUTE", architecture: "arm64" }],
    machOFileType: "MH_EXECUTE",
    machOArchitecture: "arm64",
    entitlementsSha256: null,
    entitlementsCanonicalSha256: null,
    entitlementKeys: [],
    certificateFingerprint: null,
    certificateSha1: null,
    cdHash: "a".repeat(40),
    timestamp: "none",
    secureTimestamp: false,
  }];
  return createSigningMetadata({
    mode: "local-ad-hoc",
    requestedIdentity: "-",
    order: buildSigningOrder(nested),
    outer: {
      path: "Meetless.app",
      identifier: "com.meetless.app",
      identity: "-",
      teamId: null,
      signature: "adhoc",
      authorities: [],
      flags: [],
      hardenedRuntime: false,
      machOSlices: [],
      machOFileType: null,
      machOArchitecture: null,
      entitlementsSha256: null,
      entitlementsCanonicalSha256: null,
      entitlementKeys: [],
      certificateFingerprint: null,
      certificateSha1: null,
      cdHash: "b".repeat(40),
      timestamp: "none",
      secureTimestamp: false,
    },
    nestedMachO: nested,
  });
}

function releaseFixture() {
  const teamId = MACOS_REQUIRED_DEVELOPER_ID_TEAM;
  const leafSigner = `Developer ID Application: Meetless (${teamId})`;
  const certificateSha1 = MACOS_REQUIRED_DEVELOPER_ID_CERTIFICATE_SHA1;
  const certificateFingerprint = "2".repeat(64);
  const policy = structuralPolicy();
  const nested = policy.entries.map((mapping, index) => ({
    path: mapping.path,
    identifier: `com.meetless.structural.${index}`,
    identity: leafSigner,
    teamId,
    signature: "cms",
    authorities: [leafSigner],
    flags: ["runtime"],
    hardenedRuntime: true,
    machOSlices: [{ fileType: MACOS_REQUIRED_MACHO_FILE_TYPE, architecture: MACOS_REQUIRED_MACHO_ARCHITECTURE }],
    machOFileType: MACOS_REQUIRED_MACHO_FILE_TYPE,
    machOArchitecture: MACOS_REQUIRED_MACHO_ARCHITECTURE,
    entitlementsSha256: mapping.class === "jit" ? "4".repeat(64) : "6".repeat(64),
    entitlementsCanonicalSha256: mapping.ownerCanonicalSha256,
    entitlementKeys: mapping.ownerKeys,
    certificateFingerprint,
    certificateSha1,
    cdHash: ["b", "c", "d", "e", "f", "a"][index]!.repeat(40),
    timestamp: "Aug 27, 2026 at 12:00:00 +0000",
    secureTimestamp: true,
  }));
  const signing = createSigningMetadata({
    mode: "release",
    requestedIdentity: leafSigner,
    resolvedIdentity: leafSigner,
    expectedTeamId: teamId,
    certificateFingerprint,
    certificateSha1,
    entitlementPolicy: policy,
    order: buildSigningOrder(nested),
    outer: {
      path: "Meetless.app",
      identifier: "com.meetless.app",
      identity: leafSigner,
      teamId,
      signature: "cms",
      authorities: [leafSigner],
      flags: ["runtime"],
      hardenedRuntime: true,
      machOSlices: [],
      machOFileType: null,
      machOArchitecture: null,
      entitlementsSha256: "7".repeat(64),
      entitlementsCanonicalSha256: "5".repeat(64),
      entitlementKeys: ["com.apple.security.device.audio-input"],
      certificateFingerprint,
      certificateSha1,
      cdHash: "a".repeat(40),
      timestamp: "Aug 27, 2026 at 12:00:00 +0000",
      secureTimestamp: true,
    },
    nestedMachO: nested,
  });
  return { ...signing, policy };
}

function structuralPolicy() {
  const jitCanonicalSha256 = "3".repeat(64);
  const audioCanonicalSha256 = "5".repeat(64);
  const sourcePlists = [
    {
      path: "scripts/macos-entitlements/entitlements/audio-input.plist",
      fileSha256: "7".repeat(64),
      canonicalSha256: audioCanonicalSha256,
    },
    {
      path: "scripts/macos-entitlements/entitlements/jit.plist",
      fileSha256: "8".repeat(64),
      canonicalSha256: jitCanonicalSha256,
    },
  ];
  return {
    schema: "MEETLESS_MACOS_ENTITLEMENT_MAP v1",
    mapPath: MACOS_ENTITLEMENT_MAP_PATH,
    mapAbsolutePath: path.resolve(MACOS_ENTITLEMENT_MAP_PATH),
    mapSha256: "9".repeat(64),
    mapCanonicalSha256: "a".repeat(64),
    sourcePlists,
    outer: {
      ...MACOS_APPROVED_OUTER_ENTITLEMENT,
      sourcePath: sourcePlists[0].path,
      absolutePath: path.resolve("scripts/macos-entitlements/entitlements/audio-input.plist"),
      ownerFileSha256: sourcePlists[0].fileSha256,
      ownerCanonicalSha256: audioCanonicalSha256,
      ownerKeys: [MACOS_APPROVED_OUTER_ENTITLEMENT.key],
    },
    entries: MACOS_APPROVED_ENTITLEMENT_MAP.map((mapping) => ({
      ...mapping,
      sourcePath: mapping.class === "jit" ? sourcePlists[1].path : sourcePlists[0].path,
      absolutePath: path.resolve(mapping.plist),
      ownerFileSha256: mapping.class === "jit" ? sourcePlists[1].fileSha256 : sourcePlists[0].fileSha256,
      ownerCanonicalSha256: mapping.class === "jit" ? jitCanonicalSha256 : audioCanonicalSha256,
      ownerKeys: [mapping.key],
    })),
  };
}

function rebuildStructuralSigning(fixture: any) {
  return createSigningMetadata({
    mode: "release",
    requestedIdentity: fixture.identity.requested,
    resolvedIdentity: fixture.identity.resolved,
    expectedTeamId: fixture.identity.teamId,
    certificateFingerprint: fixture.identity.certificateFingerprint,
    certificateSha1: fixture.identity.certificateSha1,
    entitlementPolicy: fixture.policy,
    order: fixture.order,
    outer: fixture.signatureState.outer,
    nestedMachO: fixture.signatureState.nestedMachO,
  });
}

async function signedTemporaryMachO() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("standalone Mach-O signing tests require macOS arm64");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "meetless-macho-signature-test-"));
  const universal = path.join(root, "universal-fixture");
  const binary = path.join(root, "fixture");
  await copyFile("/usr/bin/true", universal);
  await execFileAsync("lipo", ["-thin", "arm64e", universal, "-output", binary]);
  await execFileAsync("codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.meetless.test.fixture",
    "--timestamp=none",
    binary,
  ]);
  return { root, binary };
}
