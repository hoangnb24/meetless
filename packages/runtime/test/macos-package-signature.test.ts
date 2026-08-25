import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyIndividualMachOSignature } from "../../../scripts/validate-macos-package.mjs";
import {
  buildSigningOrder,
  canonicalizeEntitlements,
  codesignArguments,
  collectMacOSSignatureEvidence,
  createSigningMetadata,
  digestSignatureState,
  normalizeSigningOptions,
  parseCertificateEvidence,
  parseSecurityIdentityOutput,
  parseSigningArguments,
  resolveDeveloperIdSigner,
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
    expect(() => normalizeSigningOptions({ mode: "release", signingIdentity: "Developer ID Application: Meetless" })).toThrow(
      /release entitlement file is missing/,
    );
    expect(() => normalizeSigningOptions({ mode: "release", signingIdentity: "-", entitlementsPath: "owner.plist" })).toThrow(
      /is ad-hoc/,
    );
  });

  it("preserves values after the first CLI equals and rejects an extra mode equals", () => {
    expect(parseSigningArguments([
      "--signing-mode=release",
      "--signing-identity=Developer ID Application: A=B (ABCDE12345)",
      "--entitlements=/tmp/owner=release.plist",
    ], { requireMode: true })).toMatchObject({
      signingMode: "release",
      signingIdentity: "Developer ID Application: A=B (ABCDE12345)",
      entitlementsPath: "/tmp/owner=release.plist",
    });
    expect(() => parseSigningArguments(["--signing-mode=release=unexpected"], { requireMode: true })).toThrow(/unsupported signing mode release=unexpected/);
  });

  it("resolves one exact Developer ID Application certificate and rejects invalid or ambiguous identities", async () => {
    const identity = "Developer ID Application: A=B (ABCDE12345)";
    const identityOutput = `  1) ${"a".repeat(40)} "${identity}"\n     1 valid identities found`;
    const certificateOutput = `SHA-256 hash: ${"b".repeat(64)}\nSHA-1 hash: ${"a".repeat(40)}\n`;
    await expect(resolveDeveloperIdSigner({
      requestedIdentity: identity,
      expectedTeamId: "ABCDE12345",
      findIdentityOutput: identityOutput,
      findCertificateOutput: certificateOutput,
    })).resolves.toEqual({
      identity,
      certificateSha1: "a".repeat(40),
      certificateFingerprint: "b".repeat(64),
      teamId: "ABCDE12345",
    });
    expect(parseSecurityIdentityOutput(identityOutput)).toHaveLength(1);
    expect(parseCertificateEvidence(certificateOutput, "a".repeat(40)).certificateFingerprint).toBe("b".repeat(64));

    for (const invalidIdentity of [
      "Apple Development: Meetless (ABCDE12345)",
      "Apple Distribution: Meetless (ABCDE12345)",
    ]) {
      await expect(resolveDeveloperIdSigner({
        requestedIdentity: invalidIdentity,
        findIdentityOutput: `  1) ${"a".repeat(40)} "${invalidIdentity}"`,
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

  it("adds hardened-runtime and owner entitlements only at the declared release boundary", () => {
    const nested = codesignArguments({
      mode: "release",
      identity: "Developer ID Application: Meetless (ABCDE12345)",
      target: "/tmp/nested",
      identifier: "com.meetless.nested",
      outer: false,
    });
    expect(nested).toContain("runtime");
    expect(nested).not.toContain("--entitlements");
    const outer = codesignArguments({
      mode: "release",
      identity: "Developer ID Application: Meetless (ABCDE12345)",
      target: "/tmp/Meetless.app",
      identifier: "com.meetless.app",
      entitlementsPath: "/tmp/owner.entitlements",
      outer: true,
    });
    expect(outer).toEqual(expect.arrayContaining(["--options", "runtime", "--entitlements", "/tmp/owner.entitlements"]));
    expect(codesignArguments({
      mode: "local-ad-hoc",
      identity: "-",
      target: "/tmp/local",
      identifier: "com.meetless.local",
      outer: false,
    })).not.toContain("runtime");
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
      entitlementFileSha256: fixture.entitlements.fileSha256,
      expectedTeamId: fixture.identity.teamId,
    })).toEqual(fixture);
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
    expect(() => validateSigningMetadata(fixture, { machoPaths: fixture.order.nestedMachO })).toThrow(
      /ad-hoc signer|hardened-runtime flag|Team ID evidence is mismatched|identity evidence is mismatched|Developer ID certificate evidence/,
    );
  });

  it("rejects stale entitlements, unsigned nested Mach-O, and post-signature mutation", () => {
    const staleEntitlements = releaseFixture();
    staleEntitlements.entitlements.fileSha256 = "f".repeat(64);
    expect(() => validateSigningMetadata(staleEntitlements, {
      machoPaths: staleEntitlements.order.nestedMachO,
      entitlementFileSha256: "e".repeat(64),
    })).toThrow(/entitlement file digest is stale/);

    const changedEntitlements = releaseFixture();
    changedEntitlements.entitlements.signedCanonicalSha256 = "d".repeat(64);
    changedEntitlements.signatureState.outer.entitlementsCanonicalSha256 = "d".repeat(64);
    changedEntitlements.signatureStateDigest = digestSignatureState({
      order: changedEntitlements.order,
      outer: changedEntitlements.signatureState.outer,
      nestedMachO: changedEntitlements.signatureState.nestedMachO,
    });
    changedEntitlements.manifestBinding.signatureStateDigest = changedEntitlements.signatureStateDigest;
    expect(() => validateSigningMetadata(changedEntitlements, { machoPaths: changedEntitlements.order.nestedMachO })).toThrow(/semantically differ/);

    const unsignedNested = releaseFixture();
    const actualWithoutNested = {
      order: unsignedNested.order,
      outer: unsignedNested.signatureState.outer,
      nestedMachO: [],
    };
    expect(() => validateSigningMetadata(unsignedNested, {
      machoPaths: unsignedNested.order.nestedMachO,
      actual: actualWithoutNested,
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

function releaseFixture() {
  const teamId = "ABCDE12345";
  const leafSigner = "Developer ID Application: Meetless (ABCDE12345)";
  const certificateSha1 = "1".repeat(40);
  const certificateFingerprint = "2".repeat(64);
  const canonicalEntitlements = "3".repeat(64);
  const nested = [
    {
      path: "Contents/Resources/meetless/native/macos-capture/meetless-capture",
      identifier: "com.meetless.capture",
      identity: leafSigner,
      teamId,
      signature: "cms",
      authorities: [leafSigner],
      flags: ["runtime"],
      hardenedRuntime: true,
      entitlementsSha256: null,
      entitlementsCanonicalSha256: null,
      certificateFingerprint,
      certificateSha1,
      cdHash: "b".repeat(40),
    },
  ];
  return createSigningMetadata({
    mode: "release",
    requestedIdentity: leafSigner,
    resolvedIdentity: leafSigner,
    expectedTeamId: teamId,
    certificateFingerprint,
    certificateSha1,
    entitlementFileSha256: "e".repeat(64),
    entitlementOwnerCanonicalSha256: canonicalEntitlements,
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
      entitlementsSha256: "f".repeat(64),
      entitlementsCanonicalSha256: canonicalEntitlements,
      certificateFingerprint,
      certificateSha1,
      cdHash: "a".repeat(40),
    },
    nestedMachO: nested,
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
