import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_ARTIFACT_BASELINE,
  MACOS_ARTIFACT_OWNER_EVIDENCE_SCHEMA,
  MACOS_ARTIFACT_OWNER_STATUS_NAME,
  MACOS_ARTIFACT_OWNER_STATUS_SCHEMA,
  MACOS_ARTIFACT_RESIGN_AUTHORITY,
  MACOS_OUTER_CODE_RESOURCES_PATH,
  MACOS_MACHO_PAYLOAD_NORMALIZER,
  MACOS_MACHO_PAYLOAD_SCHEMA,
  acquireArtifactStageCapability,
  assertArtifactResignLifecycleOrder,
  assertExternalRetainedSuccess,
  assertFinalOuterClosure,
  captureOwnerParentBinding,
  assertBaselineArtifactClosure,
  assertBaselineIdentity,
  assertMachOPayloadClosure,
  assertOwnerTerminalResult,
  assertRegularFileIdentity,
  assertReboundDigestEquality,
  assertExternalArtifactStageRoot,
  assertInventoryPolicyPreserved,
  assertSigningBoundClosure,
  assertSigningOrder,
  assertStagePolicyBinding,
  assertStageWritableSurface,
  buildArtifactResignManifest,
  buildPreOuterSigningBoundDescriptor,
  buildOwnerTerminalEvidence,
  captureRegularFileIdentity,
  classifySigningBoundPath,
  copyOwnerTree,
  createOwnerStage,
  createOwnerSignalController,
  createOwnerStatusDocument,
  createSigningBoundDescriptor,
  createStagePolicyEvidence,
  parseArtifactResignArguments,
  resolveOwnerTemporaryParent,
  normalizeMachOPayload,
  rebindLicenseInventory,
  rebindPackageInputManifest,
  runOwnedCodesignChild,
  signNestedMachOClosure,
  signOuterApp,
  transitionOwnerStatus,
  validateOwnerTerminalFacts,
  validateOwnerTerminalEvidence,
  validateArtifactResignMetadata,
  validateArtifactStageMarker,
  validateArtifactResignLifecycleEvidence,
  validateArtifactStageRoot,
  validateArtifactBaseline,
  validateExactEntitlementPolicy,
  validateMachOPayloadBindings,
  writeArtifactMetadataAtomically,
  writeOwnerFailureStatusAtomically,
} from "../../../scripts/lib/macos-artifact-resign.mjs";
import * as artifactLifecycle from "../../../scripts/lib/macos-artifact-resign.mjs";
import { run as runArtifactResign } from "../../../scripts/resign-macos-artifact.mjs";
import * as artifactResignCommand from "../../../scripts/resign-macos-artifact.mjs";
import { enumeratePackageEntries, inspectPackageMachOEntries, MACOS_OWNER_TOOL_PATHS as MACOS_INVENTORY_OWNER_TOOL_PATHS } from "../../../scripts/lib/macos-package-inventory.mjs";
import * as packageValidator from "../../../scripts/validate-macos-package.mjs";
import {
  commitRetainedMacOSPackageSuccess,
  digestManifest,
  validateMacOSPackage,
} from "../../../scripts/validate-macos-package.mjs";
import {
  MACOS_APPROVED_ENTITLEMENT_MAP,
  MACOS_APPROVED_OUTER_ENTITLEMENT,
  MACOS_ENTITLEMENT_MAP_PATH,
  loadEntitlementPolicy,
  MACOS_OWNER_TOOL_PATHS as MACOS_SIGNING_OWNER_TOOL_PATHS,
  buildSigningOrder,
} from "../../../scripts/lib/macos-package-signing.mjs";
import {
  MACOS_LICENSE_INVENTORY_PATH,
  digestArtifactEntries,
} from "../../../scripts/lib/macos-license-inventory.mjs";

const fixtureRoots = new Set<string>();
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

describe("macOS artifact-only re-sign foundation", () => {
  it("signs the exact 46 nested objects deepest-first and the outer app last", async () => {
    const fixture = await createFixture();
    const policy = fixturePolicy();
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-signing-"));
    fixtureRoots.add(root);
    const bundlePath = path.join(root, "Meetless.app");
    await mkdir(bundlePath, { recursive: true });
    for (const entry of fixture.entries) {
      if (entry.type !== "file") continue;
      const target = path.join(bundlePath, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "fixture");
    }
    const calls: Array<{ arguments_: string[]; context: { outer: boolean; entitlement: unknown; relativePath: string } }> = [];
    const signTarget = async (arguments_: string[], context: { outer: boolean; entitlement: unknown; relativePath: string; target: string }) => {
      calls.push({ arguments_, context });
      expect(arguments_).toContain("--timestamp");
      expect(arguments_).not.toContain("--timestamp=none");
      if (!context.outer) await writeFile(context.target, "signed-nested");
      else {
        for (const relativePath of fixture.codeResources) {
          await writeFile(path.join(bundlePath, relativePath), "signed-CodeResources");
        }
      }
    };

    const nested = await signNestedMachOClosure({
      bundlePath,
      machoPaths: fixture.macho,
      signingInputs: { identity: "a".repeat(40) },
      entitlementPolicy: policy,
      signTarget,
    });
    const outer = await signOuterApp({
      bundlePath,
      signingInputs: { identity: "a".repeat(40) },
      signTarget,
    });

    expect(calls).toHaveLength(47);
    expect(calls.map((call) => call.context.relativePath)).toEqual([
      ...buildSigningOrder(fixture.macho).nestedMachO,
      "Meetless.app",
    ]);
    expect(calls.filter((call) => call.context.entitlement !== null)).toHaveLength(6);
    expect(calls.filter((call) => call.arguments_.includes("--entitlements"))).toHaveLength(7);
    expect(calls.at(-1)?.context.outer).toBe(true);
    expect(nested.order.all).toEqual([...nested.order.nestedMachO, "Meetless.app"]);
    expect(outer.observed).toEqual(["Meetless.app"]);
  });

  it("rebounds package and license metadata without changing policy projection", () => {
    const fixture = createFixture();
    const preOuterEntries = createPreOuterEntries(fixture);
    const signingBound = buildPreOuterSigningBoundDescriptor({
      machoPaths: fixture.macho,
      machoPayloads: fixture.machoPayloads,
      codeResourcePaths: fixture.codeResources.filter((relativePath) => relativePath !== "Contents/_CodeSignature/CodeResources"),
      baselinePackageInputs: fixture.packageInputs,
      preOuterEntries,
      baselineInventory: fixture.inventory,
    });
    const packageInputs = rebindPackageInputManifest({
      baseline: fixture.packageInputs,
      preOuterEntries,
      signingBound,
    });
    const inventory = rebindLicenseInventory({
      baseline: fixture.inventory,
      packageInputs,
      preOuterEntries,
      signingBound,
    });

    expect(packageInputs.signingBound).toEqual(signingBound);
    expect(packageInputs.artifactInput.excludedPaths).toEqual(signingBound.ordinaryArtifactInput.excludedPaths);
    expect(packageInputs.digest).not.toBe(fixture.packageInputs.digest);
    expect(inventory.artifact.entryBinding.signingBound).toEqual(signingBound);
    expect(inventory.artifact.packageInputBinding.digest).toBe(packageInputs.digest);
    expect(inventory.components[0].provenance.versionOrHash.artifactScopeSha256).not.toBe("old-scope");
    expect(assertInventoryPolicyPreserved(fixture.inventory, inventory)).toBe(inventory);
    expect(assertReboundDigestEquality({ scopedEntries: preOuterEntries, packageInputs, inventory })).toBe(packageInputs.artifactInput.digest);
    expect(() => assertReboundDigestEquality({ scopedEntries: preOuterEntries, packageInputs: { ...packageInputs, artifactInput: { ...packageInputs.artifactInput, digest: "f".repeat(64) } }, inventory })).toThrow(/artifact digests diverge/);
  });

  it.each([
    ["ordinary payload", (entries: Entry[]) => mutateEntry(entries, "Contents/Info.plist", { sha256: "f".repeat(64) }), /ordinary payload/],
    ["package member", (entries: Entry[]) => mutateEntry(entries, "Contents/Resources/meetless/node_modules/example/package.json", { sha256: "f".repeat(64) }), /ordinary payload/],
    ["notice text", (entries: Entry[]) => mutateEntry(entries, "Contents/Resources/meetless/notices/Node-LICENSE", { sha256: "f".repeat(64) }), /notice\/license text/],
    ["symlink target", (entries: Entry[]) => mutateEntry(entries, "Contents/Resources/meetless/runtime/current-node", { target: "other-node", sha256: hash("other-node") }), /symlink target/],
  ])("rejects changed %s after signing", (_label, mutate, expected) => {
    const fixture = createFixture();
    expect(() => assertSigningBoundClosure({
      baselineEntries: fixture.entries,
      finalEntries: mutate(fixture.finalEntries),
      machoPaths: fixture.macho,
    })).toThrow(expected);
  });

  it("rejects missing and extra CodeResources paths", () => {
    const fixture = createFixture();
    expect(() => assertSigningBoundClosure({
      baselineEntries: fixture.entries,
      finalEntries: fixture.finalEntries.filter((entry) => entry.path !== fixture.codeResources[0]),
      machoPaths: fixture.macho,
    })).toThrow(/CodeResources path set/);
    expect(() => assertSigningBoundClosure({
      baselineEntries: fixture.entries,
      finalEntries: [...fixture.finalEntries, fileEntry("Contents/Extra.app/Contents/_CodeSignature/CodeResources", "x")],
      machoPaths: fixture.macho,
    })).toThrow(/CodeResources path set/);
  });

  it("rejects policy, mapping, stale-baseline, canonical-target, and order changes", () => {
    const fixture = createFixture();
    const signingBound = createSigningBoundDescriptor({ phase: "final", machoPaths: fixture.macho, machoPayloads: fixture.machoPayloads, codeResourcePaths: fixture.codeResources });
    const policy = fixturePolicy();
    expect(() => validateExactEntitlementPolicy({
      ...policy,
      entries: policy.entries.map((entry, index) => index === 0 ? { ...entry, key: "wrong.key" } : entry),
    }, { machoPaths: fixture.macho })).toThrow(/F5 entitlement paths or keys/);
    expect(() => validateExactEntitlementPolicy({
      ...policy,
      entries: policy.entries.map((entry, index) => index === 0 ? { ...entry, path: "Contents/changed" } : entry),
    }, { machoPaths: fixture.macho })).toThrow(/F5 entitlement paths or keys/);
    expect(() => assertInventoryPolicyPreserved(fixture.inventory, {
      ...fixture.inventory,
      components: [{ ...fixture.inventory.components[0], artifactPathScope: { paths: ["Contents/changed"], count: 1 } }],
    })).toThrow(/component mapping/);
    expect(() => assertInventoryPolicyPreserved(fixture.inventory, {
      ...fixture.inventory,
      components: [{
        ...fixture.inventory.components[0],
        provenance: {
          ...fixture.inventory.components[0].provenance,
          packageMembers: [{ packageJsonPath: "Contents/Resources/meetless/node_modules/example/package.json" }],
        },
      }],
    })).toThrow(/component mapping/);
    expect(() => assertSigningOrder(["Meetless.app", ...buildSigningOrder(fixture.macho).nestedMachO], buildSigningOrder(fixture.macho).all)).toThrow(/signing order/);
    expect(() => assertExternalArtifactStageRoot({ stageRoot: process.cwd(), repositoryRoot: process.cwd() })).toThrow(/canonical repository/);
    expect(() => assertBaselineIdentity({
      manifest: baselineManifestForTest(),
      expected: {
        schema: ACCEPTED_ARTIFACT_BASELINE.schema,
        sourceAncestorSnapshotDigest: ACCEPTED_ARTIFACT_BASELINE.sourceAncestorSnapshotDigest,
        sourceSnapshotDigest: "source",
        sourceSnapshotHead: "h".repeat(40),
        packageInputDigest: "package",
        artifactInputDigest: "artifact",
        artifactDigest: "artifact-final",
        signatureStateDigest: "signature",
        manifestSha256: "m".repeat(64),
        paseoCommit: "paseo",
        machoCount: 1,
        codeResourcesCount: 1,
        codeObjectCount: 2,
        machoPayloads: [],
      },
    })).toThrow(/baseline/);
    expect(() => validateArtifactStageMarker({
      schema: "MEETLESS_MACOS_ARTIFACT_STAGE v1",
      stageRoot: "/tmp/stage",
      bundlePath: "Meetless.app",
      manifestPath: "composition-manifest.json",
      baseline: { ...ACCEPTED_ARTIFACT_BASELINE, packageInputDigest: "stale" },
    }, { stageRoot: "/tmp/stage" })).toThrow(/baseline/);
    expect(classifySigningBoundPath(fixture.codeResources[0], { machoPaths: fixture.macho })).toBe("code-resources");
    expect(classifySigningBoundPath(MACOS_LICENSE_INVENTORY_PATH, { machoPaths: fixture.macho })).toBe("license-inventory");
    expect(signingBound.counts.total).toBe(57);
  });

  it("binds the owner stage marker to the exact F5 policy evidence", () => {
    const policy = fixturePolicy();
    const evidence = createStagePolicyEvidence(policy);
    expect(assertStagePolicyBinding(evidence, policy)).toEqual(evidence);
    expect(() => assertStagePolicyBinding({ ...evidence, mapSha256: "stale" }, policy)).toThrow(/policy evidence/);
  });

  it("binds Mach-O bytes while excluding only LC_CODE_SIGNATURE data", () => {
    const original = syntheticMachO("signature-a", "payload-a");
    const reboundSignature = syntheticMachO("signature-b-expanded", "payload-a");
    const replacedPayload = syntheticMachO("signature-b-expanded", "payload-b");
    const before = { path: "Contents/MacOS/fixture", ...normalizeMachOPayload(original, "Contents/MacOS/fixture") };
    const changedSignature = { path: before.path, ...normalizeMachOPayload(reboundSignature, before.path) };
    const changedPayload = { path: before.path, ...normalizeMachOPayload(replacedPayload, before.path) };

    expect(changedSignature.payloadSha256).toBe(before.payloadSha256);
    expect(changedSignature.fileByteCount).toBeGreaterThan(before.fileByteCount);
    expect(changedSignature.metadata?.slices[0].signatureDataSize).toBeGreaterThan(before.metadata?.slices[0].signatureDataSize ?? 0);
    expect(changedSignature.metadata?.slices[0].linkeditFileSize).toBeGreaterThan(before.metadata?.slices[0].linkeditFileSize ?? 0);
    expect(changedSignature.metadata?.slices[0].linkeditVmSize).toBe(before.metadata?.slices[0].linkeditVmSize);
    expect(assertMachOPayloadClosure({ baselinePayloads: [before], finalPayloads: [changedSignature] })).toEqual([changedSignature]);
    let codesignCalls = 0;
    expect(() => {
      assertMachOPayloadClosure({ baselinePayloads: [before], finalPayloads: [changedPayload] });
      codesignCalls += 1;
    }).toThrow(/payload changed outside LC_CODE_SIGNATURE/);
    expect(codesignCalls).toBe(0);
    expect(() => normalizeMachOPayload(Buffer.from("not-mach-o"), before.path)).toThrow(/shorter than a Mach-O header/);
  });

  it.each<[string, (bytes: Buffer) => void, RegExp]>([
    ["unaligned load-command size", (bytes) => bytes.writeUInt32LE(73, 36), /cmdsize 73.*not divisible by 4/],
    ["LC_CODE_SIGNATURE dataoff", (bytes) => bytes.writeUInt32LE(0x4000 + Buffer.byteLength("linkedit-prefix") + 1, 184), /invalid LC_CODE_SIGNATURE data range/],
    ["LC_CODE_SIGNATURE datasize", (bytes) => bytes.writeUInt32LE(1, 188), /inconsistent LC_CODE_SIGNATURE\/__LINKEDIT extent/],
    ["__LINKEDIT fileoff", (bytes) => bytes.writeBigUInt64LE(0x5000n, 144), /segment range outside its bounded slice/],
    ["__LINKEDIT vmaddr", (bytes) => bytes.writeBigUInt64LE(0x8000n, 128), /payload changed outside LC_CODE_SIGNATURE/],
    ["__LINKEDIT protections", (bytes) => bytes.writeUInt32LE(7, 160), /payload changed outside LC_CODE_SIGNATURE/],
    ["__LINKEDIT name", (bytes) => Buffer.from("__DATA").copy(bytes, 112), /__LINKEDIT segments/],
    ["__LINKEDIT filesize", (bytes) => bytes.writeBigUInt64LE(0x4000n, 152), /segment range outside its bounded slice|inconsistent LC_CODE_SIGNATURE\/__LINKEDIT extent/],
    ["__LINKEDIT vmsize", (bytes) => bytes.writeBigUInt64LE(0x8000n, 136), /inconsistent __LINKEDIT vmsize/],
    ["non-__LINKEDIT segment field", (bytes) => bytes.writeUInt32LE(7, 88), /payload changed outside LC_CODE_SIGNATURE/],
    ["slice architecture header", (bytes) => bytes.writeUInt32LE(0x01000007, 4), /inconsistent __LINKEDIT vmsize|payload changed outside LC_CODE_SIGNATURE/],
    ["load-command header", (bytes) => bytes.writeUInt32LE(161, 20), /LC_CODE_SIGNATURE commands/],
    ["missing signature command", (bytes) => bytes.writeUInt32LE(0, 176), /0 LC_CODE_SIGNATURE commands/],
    ["overlapping segment range", (bytes) => bytes.writeBigUInt64LE(0x4001n, 80), /overlapping segment file ranges/],
  ])("rejects %s or inconsistent Mach-O metadata", (_label, mutate, expected) => {
    const before = { path: "Contents/MacOS/fixture", ...normalizeMachOPayload(syntheticMachO("signature-a", "payload-a"), "Contents/MacOS/fixture") };
    const finalBytes = syntheticMachO("signature-b-expanded", "payload-a");
    mutate(finalBytes);
    expect(() => {
      const final = { path: before.path, ...normalizeMachOPayload(finalBytes, before.path) };
      assertMachOPayloadClosure({ baselinePayloads: [before], finalPayloads: [final] });
    }).toThrow(expected);
  });

  it("rejects truncated and out-of-slice Mach-O ranges before payload comparison", () => {
    const before = { path: "Contents/MacOS/fixture", ...normalizeMachOPayload(syntheticMachO("signature-a", "payload-a"), "Contents/MacOS/fixture") };
    expect(() => normalizeMachOPayload(syntheticMachO("signature-a", "payload-a").subarray(0, 180), before.path)).toThrow(/load commands outside its bounded slice/);
    const outOfSlice = syntheticMachO("signature-a", "payload-a");
    outOfSlice.writeUInt32LE(0xffff, 184);
    expect(() => normalizeMachOPayload(outOfSlice, before.path)).toThrow(/invalid LC_CODE_SIGNATURE data range/);
    expect(() => normalizeMachOPayload(syntheticMachO("signature-a", "payload-a", { signatureCommandCount: 2 }), before.path)).toThrow(/2 LC_CODE_SIGNATURE commands/);
  });

  it("supports bounded fat slices and rejects truncated or overlapping slice tables", () => {
    const beforeBytes = syntheticFatMachO("signature-a", "signature-c");
    const finalBytes = syntheticFatMachO("signature-b", "signature-d");
    const before = { path: "Contents/MacOS/fat-fixture", ...normalizeMachOPayload(beforeBytes, "Contents/MacOS/fat-fixture") };
    const final = { path: before.path, ...normalizeMachOPayload(finalBytes, before.path) };
    expect(assertMachOPayloadClosure({ baselinePayloads: [before], finalPayloads: [final] })).toEqual([final]);

    const overlapping = syntheticFatMachO("signature-a", "signature-c");
    overlapping.writeUInt32BE(0x1000, 8 + 20 + 8);
    expect(() => normalizeMachOPayload(overlapping, before.path)).toThrow(/overlapping fat slices/);
    expect(() => normalizeMachOPayload(beforeBytes.subarray(0, 40), before.path)).toThrow(/invalid fat slice table/);

    const tableCpuMismatch = syntheticFatMachO("signature-a", "signature-c");
    tableCpuMismatch.writeUInt32BE(0x01000007, 8);
    expect(() => normalizeMachOPayload(tableCpuMismatch, before.path)).toThrow(/FAT architecture key mismatch/);

    const tableSubtypeMismatch = syntheticFatMachO("signature-a", "signature-c");
    tableSubtypeMismatch.writeUInt32BE(1, 12);
    expect(() => normalizeMachOPayload(tableSubtypeMismatch, before.path)).toThrow(/FAT architecture key mismatch/);

    const duplicateArchitecture = syntheticFatMachO("signature-a", "signature-c", { firstSubtype: 0, secondSubtype: 0 });
    expect(() => normalizeMachOPayload(duplicateArchitecture, before.path)).toThrow(/duplicate FAT architecture key/);
  });

  it("requires one precise payload binding for every signing-bound Mach-O", () => {
    const fixture = createFixture();
    expect(validateMachOPayloadBindings(fixture.machoPayloads, fixture.macho)).toHaveLength(46);
    expect(() => createSigningBoundDescriptor({ phase: "final", machoPaths: fixture.macho, codeResourcePaths: fixture.codeResources })).toThrow(/payload bindings/);
    expect(() => validateMachOPayloadBindings(fixture.machoPayloads.slice(1), fixture.macho)).toThrow(/exact Mach-O path set/);
  });

  it("requires every phase-split artifact re-sign lifecycle field", () => {
    const graph = createPhaseGraph();
    const markerBytes = Buffer.from("marker");
    const evidence = graph.manifest.artifactResign;
    expect(validateArtifactResignLifecycleEvidence(evidence, { markerBytes })).toBe(evidence);
    for (const field of ["schema", "baseline", "preOuter", "final", "stage", "rebind"]) {
      const broken = structuredClone(evidence) as Record<string, unknown>;
      if (field === "schema") broken.schema = undefined;
      else broken[field] = undefined;
      expect(() => validateArtifactResignLifecycleEvidence(broken, { markerBytes })).toThrow(/lifecycle|stage marker|baseline|signing-bound|phase|rebind/);
    }
  });

  it("uses a private exclusive stage capability and rejects writable or shared stage files", async () => {
    const stage = await createStageFixture();
    await expect(validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd() })).resolves.toMatchObject({ stageRoot: stage.stageRoot });
    await expect(assertStageWritableSurface(stage)).resolves.toMatchObject({ uid: process.getuid?.() });
    const capability = await acquireArtifactStageCapability({ stageRoot: stage.stageRoot, markerBytes: Buffer.from("marker") });
    await expect(acquireArtifactStageCapability({ stageRoot: stage.stageRoot, markerBytes: Buffer.from("marker") })).rejects.toThrow(/active capability/);
    await capability.release();

    const payload = path.join(stage.bundlePath, "payload.txt");
    await chmod(payload, 0o666);
    await expect(assertStageWritableSurface(stage)).rejects.toThrow(/group\/world writable/);
    await chmod(payload, 0o600);
    const hardlink = path.join(stage.bundlePath, "shared.txt");
    await link(payload, hardlink);
    await expect(assertStageWritableSurface(stage)).rejects.toThrow(/hard links/);
  });

  it("preserves the previous metadata file when an atomic write is interrupted or races", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-atomic-"));
    fixtureRoots.add(root);
    const target = path.join(root, "metadata.json");
    await writeFile(target, "{\"old\":true}\n", { mode: 0o600 });
    const before = await captureRegularFileIdentity(target, "atomic fixture metadata");
    await expect(writeArtifactMetadataAtomically({
      filePath: target,
      value: { new: true },
      label: "atomic fixture metadata",
      expectedTarget: before,
      beforeRename: async () => { throw new Error("simulated interruption"); },
    })).rejects.toThrow(/cannot atomically write/);
    expect(await readFile(target, "utf8")).toBe("{\"old\":true}\n");
    expect((await captureRegularFileIdentity(target, "atomic fixture metadata")).ino).toBe(before.ino);

    const external = path.join(root, "external.json");
    await writeFile(external, "{\"external\":true}\n", { mode: 0o600 });
    await expect(writeArtifactMetadataAtomically({
      filePath: target,
      value: { new: true },
      label: "atomic fixture metadata",
      expectedTarget: before,
      beforeRename: async () => { await (await import("node:fs/promises")).rename(external, target); },
    })).rejects.toThrow(/changed during the atomic write/);
    expect(await readFile(target, "utf8")).toBe("{\"external\":true}\n");
  });

  it("linearizes an interruptible success write at the synchronous status rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-commit-"));
    fixtureRoots.add(root);
    const target = path.join(root, "status.json");
    await writeFile(target, "{\"state\":\"consumed\"}\n", { mode: 0o600 });
    const before = await captureRegularFileIdentity(target, "commit boundary fixture");
    const signalSource = new EventEmitter();
    const controller = createOwnerSignalController({ signalSource, killGraceMs: 1 });
    await expect(writeArtifactMetadataAtomically({
      filePath: target,
      value: { state: "retained-success" },
      label: "commit boundary fixture",
      expectedTarget: before,
      beforeCommit: () => {
        signalSource.emit("SIGINT");
        controller.assertNotInterrupted();
      },
    })).rejects.toThrow(/interrupted/);
    expect(await readFile(target, "utf8")).toBe("{\"state\":\"consumed\"}\n");
    controller.close();

    const postCommitSignals = new EventEmitter();
    const postCommitController = createOwnerSignalController({ signalSource: postCommitSignals, killGraceMs: 1 });
    const current = await captureRegularFileIdentity(target, "commit boundary fixture");
    await writeArtifactMetadataAtomically({
      filePath: target,
      value: { state: "retained-success" },
      label: "commit boundary fixture",
      expectedTarget: current,
      beforeCommit: () => postCommitController.assertNotInterrupted(),
    });
    postCommitSignals.emit("SIGTERM");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ state: "retained-success" });
    postCommitController.close();
  });

  it("rejects unsupported package lstat types with an actionable authority diagnostic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-types-"));
    fixtureRoots.add(root);
    await execFileAsync("mkfifo", [path.join(root, "unsupported-fifo")]);
    await expect(enumeratePackageEntries(root)).rejects.toThrow(/unsupported lstat type.*Authority:.*Next action/);
  });

  it("rejects a symlink bundle root before ordinary package validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-root-"));
    fixtureRoots.add(root);
    const canonicalManifest = await readFile(path.join(process.cwd(), "release/macos/composition-manifest.json"));
    await writeFile(path.join(root, "composition-manifest.json"), canonicalManifest, { mode: 0o600 });
    await symlink(path.resolve(process.cwd(), "release/macos/Meetless.app"), path.join(root, "Meetless.app"));
    await expect(validateMacOSPackage(path.join(root, "composition-manifest.json"), {
      artifactOnly: true,
      repositoryRoot: process.cwd(),
      signingMode: "local-ad-hoc",
      signingIdentity: "-",
    })).rejects.toThrow(/manifest signing contract is invalid|bundle root is a symlink/);
  });

  it("does not let retained artifact-only mode fall back to ordinary identity resolution", async () => {
    await expect(validateMacOSPackage(path.join(process.cwd(), "release/macos/composition-manifest.json"), {
      artifactOnly: true,
      retainedArtifactOnly: true,
      repositoryRoot: process.cwd(),
    })).rejects.toThrow(/manifest signing contract is invalid|embedded retained signing evidence/);
  });

  it("parses credential-free preparation and requires an explicit retained stage for owner mode", () => {
    expect(parseArtifactResignArguments(["--prepare", "--source-root=/tmp/source"])).toEqual({
      prepare: true,
      sourceRoot: "/tmp/source",
      stageRoot: null,
      signingIdentity: null,
      expectedTeamId: null,
      ownerMode: false,
    });
    expect(parseArtifactResignArguments(["--stage-root=/tmp/stage", "--signing-identity=identity", "--team-id=63M98WD275"])).toEqual({
      prepare: false,
      sourceRoot: null,
      stageRoot: "/tmp/stage",
      signingIdentity: "identity",
      expectedTeamId: "63M98WD275",
      ownerMode: true,
    });
    expect(() => parseArtifactResignArguments(["--signing-identity=identity", "--team-id=63M98WD275"])).toThrow(/stage root/);
    expect(() => parseArtifactResignArguments(["--codesign=/tmp/fake", "--signing-identity=identity", "--team-id=63M98WD275"])).toThrow(/unsupported artifact re-sign option/);
  });

  it("separates pre-outer rebound metadata from final entry and signature evidence", () => {
    const graph = createPhaseGraph();
    expect(graph.preOuterSigningBound.schema).toBe("MEETLESS_MACOS_SIGNING_BOUND_PATHS v2");
    expect(graph.preOuterSigningBound.phase).toBe("pre-outer");
    expect(graph.preOuterSigningBound.codeResources).toHaveLength(9);
    expect(graph.finalSigningBound.phase).toBe("final");
    expect(graph.finalSigningBound.codeResources).toHaveLength(10);
    expect(graph.packageInputs.signingBound).toEqual(graph.preOuterSigningBound);
    expect(graph.inventory.artifact.entryBinding.signingBound).toEqual(graph.preOuterSigningBound);
    expect(graph.manifest.artifactResign.preOuter.signingBound).toEqual(graph.preOuterSigningBound);
    expect(graph.manifest.artifactResign.final.signingBound).toEqual(graph.finalSigningBound);
    expect(graph.manifest.artifactResign.preOuter.entrySetDigest).not.toBe(graph.manifest.artifactResign.final.entrySetDigest);
    expect(graph.manifest.licenseInventory.artifactEntryScope).toBe("pre-outer");
    expect(graph.manifest.licenseInventory.signingBoundPhase).toBe("pre-outer");
    expect(() => rebindLicenseInventory({
      baseline: graph.fixture.inventory,
      packageInputs: graph.packageInputs,
      preOuterEntries: graph.preOuterEntries,
      signingBound: graph.finalSigningBound,
    })).toThrow(/pre-outer/);
  });

  it("keeps final outer signing state out of package and inventory bindings", () => {
    const graph = createPhaseGraph();
    const baselineManifest = graph.baselineManifest;
    const finalOnlyPackage = structuredClone(graph.manifest.packageInputs);
    finalOnlyPackage.signingBound = graph.finalSigningBound;
    const finalOnlyManifest = structuredClone(graph.manifest);
    finalOnlyManifest.packageInputs = finalOnlyPackage;
    expect(() => validateArtifactResignMetadata({
      baselineManifest,
      baselineEntries: graph.fixture.entries,
      baselineMachOPayloads: graph.fixture.machoPayloads,
      baselineInventory: graph.fixture.inventory,
      manifest: finalOnlyManifest,
      preOuterEntries: graph.preOuterEntries,
      preOuterMachOPayloads: graph.fixture.machoPayloads,
      finalEntries: graph.finalEntries,
      finalMachOPayloads: graph.fixture.machoPayloads,
      finalInventory: graph.inventory,
      markerBytes: Buffer.from("marker"),
    })).toThrow(/pre-outer descriptor/);

    const finalOnlyInventory = structuredClone(graph.inventory);
    finalOnlyInventory.artifact.entryBinding.signingBound = graph.finalSigningBound;
    expect(() => validateArtifactResignMetadata({
      baselineManifest,
      baselineEntries: graph.fixture.entries,
      baselineMachOPayloads: graph.fixture.machoPayloads,
      baselineInventory: graph.fixture.inventory,
      manifest: graph.manifest,
      preOuterEntries: graph.preOuterEntries,
      preOuterMachOPayloads: graph.fixture.machoPayloads,
      finalEntries: graph.finalEntries,
      finalMachOPayloads: graph.fixture.machoPayloads,
      finalInventory: finalOnlyInventory,
      markerBytes: Buffer.from("marker"),
    })).toThrow(/pre-outer descriptor/);
  });

  it("rejects phase identity fields that are not bound to the rebind record", () => {
    const graph = createPhaseGraph();
    const forged = structuredClone(graph.manifest.artifactResign);
    forged.preOuter.artifactInputDigest = "f".repeat(64);
    expect(() => validateArtifactResignLifecycleEvidence(forged, { markerBytes: Buffer.from("marker") })).toThrow(/phase identities/);
  });

  it("binds final entry, CodeResources, signature, and artifact identities separately", () => {
    const graph = createPhaseGraph();
    expect(graph.manifest.entries).toEqual(graph.finalEntries);
    expect(graph.manifest.artifactResign.final.codeResourcesCount).toBe(10);
    expect(graph.manifest.artifactResign.codeObjectCount).toBe(47);
    expect(graph.manifest.signing.signatureState.nestedMachO).toHaveLength(46);
    expect(graph.manifest.artifactResign.final.signatureStateDigest).toBe(graph.manifest.signing.signatureStateDigest);
    expect(graph.manifest.artifactResign.final.entrySetDigest).not.toBe(graph.manifest.artifactResign.preOuter.entrySetDigest);
    expect(graph.manifest.artifactResign.final.signingBound).not.toEqual(graph.manifest.artifactResign.preOuter.signingBound);
    expect(graph.manifest.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates the complete phase graph without an artifact digest cycle", () => {
    const graph = createPhaseGraph();
    expect(validateArtifactResignMetadata({
      baselineManifest: graph.baselineManifest,
      baselineEntries: graph.fixture.entries,
      baselineMachOPayloads: graph.fixture.machoPayloads,
      baselineInventory: graph.fixture.inventory,
      manifest: graph.manifest,
      preOuterEntries: graph.preOuterEntries,
      preOuterMachOPayloads: graph.fixture.machoPayloads,
      finalEntries: graph.finalEntries,
      finalMachOPayloads: graph.fixture.machoPayloads,
      finalInventory: graph.inventory,
      markerBytes: Buffer.from("marker"),
    })).toBe(graph.manifest);
    expect(digestManifest({ ...graph.manifest, artifactDigest: undefined })).toBe(graph.manifest.artifactDigest);
  });

  it.each([
    ["nested CodeResources", (entries: Entry[], graph: PhaseGraph) => mutateEntry(entries, graph.preOuterSigningBound.codeResources[0], { sha256: "f".repeat(64) }), /nested CodeResources/],
    ["license inventory", (entries: Entry[]) => mutateEntry(entries, MACOS_LICENSE_INVENTORY_PATH, { sha256: "f".repeat(64) }), /license inventory/],
  ])("rejects a post-outer %s mutation at the final boundary", (_label, mutate, expected) => {
    const graph = createPhaseGraph();
    expect(() => assertFinalOuterClosure({
      preOuterEntries: graph.preOuterEntries,
      finalEntries: mutate(graph.finalEntries, graph),
      preOuterSigningBound: graph.preOuterSigningBound,
      finalSigningBound: graph.finalSigningBound,
    })).toThrow(expected);
  });

  it("rejects obsolete single-phase metadata and keeps the phase schema strict", () => {
    const graph = createPhaseGraph();
    const old = structuredClone(graph.manifest.artifactResign);
    old.schema = "MEETLESS_MACOS_ARTIFACT_RESIGN v1";
    old.signingBound = old.final.signingBound;
    delete old.preOuter;
    delete old.final;
    expect(() => validateArtifactResignLifecycleEvidence(old, { markerBytes: Buffer.from("marker") })).toThrow(/schema|obsolete single-phase/);

    const forged = structuredClone(graph.manifest.artifactResign);
    forged.signingBound = forged.final.signingBound;
    expect(() => validateArtifactResignLifecycleEvidence(forged, { markerBytes: Buffer.from("marker") })).toThrow(/obsolete single-phase/);
  });

  it("proves the only success event order and rejects a reordered sequence", () => {
    const events = [
      "nested-signing-complete",
      "inventory-rebound",
      "inventory-written",
      "outer-sign-complete",
      "signature-evidence-complete",
      "metadata-observed",
      "inventory-reread",
      "final-observation",
      "manifest-built",
      "manifest-validated",
      "manifest-written",
      "retained-validation-start",
      "retained-validation-complete",
      "terminal-retained-success",
    ];
    expect(assertArtifactResignLifecycleOrder(events)).toEqual(events);
    const reordered = [...events];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    expect(() => assertArtifactResignLifecycleOrder(reordered)).toThrow(/event order/);
  });

  it("rejects caller replacements of production lifecycle authorities", async () => {
    await expect(runArtifactResign([
      "--stage-root=/tmp/stage",
      "--signing-identity=Developer ID Application: Long Le (63M98WD275)",
      "--team-id=63M98WD275",
    ], { validatePackage: async () => ({ status: "passed" }) })).rejects.toThrow(/rejects caller lifecycle collaborators/);
  });

  it("structurally composes one end-to-end retained-success operation with no callable pre-success evidence path", async () => {
    const source = await readFile(path.resolve("scripts/resign-macos-artifact.mjs"), "utf8");
    const syntax = ts.createSourceFile("resign-macos-artifact.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const runPreparedStage = syntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "runPreparedStage");
    expect(runPreparedStage).toBeDefined();
    const calls = collectCallExpressions(runPreparedStage as ts.Node);
    const callNames = calls.map((call) => ts.isIdentifier(call.expression) ? call.expression.text : "");
    expect(callNames).toEqual(expect.arrayContaining([
      "commitRetainedMacOSPackageSuccess",
    ]));
    expect(callNames).not.toEqual(expect.arrayContaining(["validateMacOSArtifactEvidence", "retainOwnerTerminalOutcome"]));
    const operationCall = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "commitRetainedMacOSPackageSuccess");
    expect(operationCall?.arguments[0] && ts.isObjectLiteralExpression(operationCall.arguments[0])).toBe(true);
    const operationProperties = operationCall && ts.isObjectLiteralExpression(operationCall.arguments[0])
      ? operationCall.arguments[0].properties.map((property) => "name" in property ? property.name.getText(syntax) : "")
      : [];
    expect(operationProperties).toEqual(expect.arrayContaining(["manifestPath", "repositoryRoot", "expectedStatusIdentity", "expectedStageBinding", "result", "signalController"]));
    const consumedTransition = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "transitionOwnerStatus" && ts.isObjectLiteralExpression(call.arguments[0]) && call.arguments[0].properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(syntax) === "state" && ts.isStringLiteral(property.initializer) && property.initializer.text === "consumed"));
    const consumedCapture = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "captureRegularFileIdentity" && ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === "consumed owner attempt status");
    expect(consumedTransition?.pos).toBeLessThan(consumedCapture?.pos ?? 0);
    expect(consumedCapture?.pos).toBeLessThan(operationCall?.pos ?? 0);
    const successEvent = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "emitCommandLifecycleEvent" && ts.isStringLiteral(call.arguments[2]) && call.arguments[2].text === "terminal-retained-success");
    expect(operationCall?.pos).toBeLessThan(successEvent?.pos ?? 0);
    expect(Object.keys(artifactResignCommand)).toEqual(["run"]);

    const validatorSource = await readFile(path.resolve("scripts/validate-macos-package.mjs"), "utf8");
    const validatorSyntax = ts.createSourceFile("validate-macos-package.mjs", validatorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const operation = validatorSyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "commitRetainedMacOSPackageSuccess");
    expect(operation?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    const operationCalls = collectCallExpressions(operation as ts.Node);
    const operationCallNames = operationCalls.map((call) => ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "");
    expect(operationCallNames).toEqual(expect.arrayContaining([
      "validateArtifactStageRoot",
      "assertRegularFileIdentity",
      "assertConsumedRetainedStatus",
      "validateMacOSPackageImplementation",
      "assertOwnerTerminalResult",
      "transitionPrivateRetainedSuccess",
      "captureRegularFileIdentity",
      "assertExternalRetainedSuccess",
    ]));
    const operationTransition = operationCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "transitionPrivateRetainedSuccess");
    expect(operationTransition && ts.isObjectLiteralExpression(operationTransition.arguments[0]) && operationTransition.arguments[0].properties.some((property) => "name" in property && property.name.getText(validatorSyntax) === "expectedCurrentIdentity")).toBe(true);
    expect(operationTransition && ts.isObjectLiteralExpression(operationTransition.arguments[0]) && operationTransition.arguments[0].properties.some((property) => "name" in property && property.name.getText(validatorSyntax) === "beforeCommit")).toBe(true);
    const coreValidation = operationCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "validateMacOSPackageImplementation");
    const terminalCommit = operationCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "transitionPrivateRetainedSuccess");
    const committedRead = operationCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "captureRegularFileIdentity" && ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === "committed retained-success status");
    const committedVerification = operationCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "assertExternalRetainedSuccess");
    const operationReturns: ts.ReturnStatement[] = [];
    const collectReturns = (node: ts.Node) => {
      if (ts.isReturnStatement(node)) operationReturns.push(node);
      ts.forEachChild(node, collectReturns);
    };
    collectReturns(operation as ts.Node);
    expect(coreValidation?.pos).toBeLessThan(terminalCommit?.pos ?? 0);
    expect(terminalCommit?.pos).toBeLessThan(committedRead?.pos ?? 0);
    expect(committedRead?.pos).toBeLessThan(committedVerification?.pos ?? 0);
    expect(committedVerification?.pos).toBeLessThan(operationReturns.at(-1)?.pos ?? 0);

    const exportedFunctions = validatorSyntax.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
    const exportedPreSuccessCoreCallers = exportedFunctions.filter((statement) => collectCallExpressions(statement).some((call) => {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "validateMacOSPackageImplementation") return false;
      const policy = call.arguments[2];
      return Boolean(policy && ts.isObjectLiteralExpression(policy) && policy.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(validatorSyntax) === "requireRetainedSuccess" && property.initializer.kind === ts.SyntaxKind.FalseKeyword));
    }));
    expect(exportedPreSuccessCoreCallers.map((statement) => statement.name?.text)).toEqual(["commitRetainedMacOSPackageSuccess"]);
    expect(Object.keys(packageValidator)).not.toEqual(expect.arrayContaining(["validateMacOSArtifactEvidence", "validateRetainedMacOSArtifactEvidence", "validateRetainedSigningPolicyAuthority", "buildPrivateSuccessEvidence", "createPrivateSuccessStatus", "transitionPrivateRetainedSuccess"]));
    const validatorFunction = validatorSyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "validateMacOSPackageImplementation");
    const ownerMode = validatorFunction && findVariableDeclaration(validatorFunction, "ownerMode");
    expect(ownerMode?.initializer && ts.isConditionalExpression(ownerMode.initializer)).toBe(true);
    const ownerModeExpression = ownerMode?.initializer as ts.ConditionalExpression;
    expect(ts.isIdentifier(ownerModeExpression.condition) && ownerModeExpression.condition.text === "retainedArtifactOnly").toBe(true);
    expect(ownerModeExpression.whenTrue.kind).toBe(ts.SyntaxKind.TrueKeyword);
    expect(validatorSyntax.statements.some((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "RETAINED_EVIDENCE_ONLY"))).toBe(false);

    const retainedBinding = validatorFunction && findVariableDeclaration(validatorFunction, "retainedBinding");
    const retainedBindingCalls = collectCallExpressions(retainedBinding as ts.Node);
    const retainedBindingCallNames = retainedBindingCalls.map((call) => ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "");
    expect(retainedBindingCallNames).toEqual(expect.arrayContaining([
      "validateArtifactStageRoot",
      "assertRegularFileIdentity",
      "assertOwnerParentBinding",
      "captureRegularFileIdentity",
      "enumeratePackageEntries",
      "compareManifestEntrySets",
      "validatePackageSymlinkClosure",
      "assertStageWritableSurface",
    ]));
    const stageRevalidation = retainedBindingCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "validateArtifactStageRoot" && ts.isObjectLiteralExpression(call.arguments[0]) && call.arguments[0].properties.some((property) => "name" in property && property.name.getText(validatorSyntax) === "temporaryPath"));
    expect(stageRevalidation).toBeDefined();

    const librarySource = await readFile(path.resolve("scripts/lib/macos-artifact-resign.mjs"), "utf8");
    const librarySyntax = ts.createSourceFile("macos-artifact-resign.mjs", librarySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const atomicWrite = librarySyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "writeJsonAtomically");
    expect(atomicWrite?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).not.toBe(true);
    expect(Object.keys(artifactLifecycle)).not.toContain("writeJsonAtomically");
    expect(Object.keys(artifactLifecycle).filter((name) => /^write/u.test(name)).sort()).toEqual(["writeArtifactMetadataAtomically", "writeOwnerFailureStatusAtomically"]);
    const exportedLifecycleFunctions = librarySyntax.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
    const exportedAtomicCallers = exportedLifecycleFunctions
      .filter((statement) => collectCallExpressions(statement).some((call) => ts.isIdentifier(call.expression) && call.expression.text === "writeJsonAtomically"))
      .map((statement) => statement.name?.text)
      .sort();
    expect(exportedAtomicCallers).toEqual(["createOwnerStage", "transitionOwnerStatus", "writeArtifactMetadataAtomically", "writeOwnerFailureStatusAtomically"]);
    const privateSuccessWriter = validatorSyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "writePrivateSuccessStatusAtomically");
    const privateSuccessTransition = validatorSyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "transitionPrivateRetainedSuccess");
    expect(privateSuccessWriter?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).not.toBe(true);
    expect(privateSuccessTransition?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).not.toBe(true);
    const atomicCalls = collectCallExpressions(atomicWrite as ts.Node);
    const interruptionDecision = atomicCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "beforeCommit");
    const synchronousCommit = atomicCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "renameSync");
    expect(interruptionDecision?.pos).toBeLessThan(synchronousCommit?.pos ?? 0);
    expect(interruptionDecision?.parent.parent).toBe(synchronousCommit?.parent.parent);

    const privateWriter = validatorSyntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "writePrivateSuccessStatusAtomically");
    const privateWriterSource = privateWriter?.getText(validatorSyntax) ?? "";
    const privateWriterCalls = collectCallExpressions(privateWriter as ts.Node);
    const privateRename = privateWriterCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "renameSync");
    const committedStatusRead = privateWriterCalls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "captureRegularFileIdentity" && ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === "committed retained-success status");
    expect(privateWriterSource).toMatch(/postCommitDiagnostic/u);
    expect(privateWriterSource).toMatch(/POST_COMMIT_DURABILITY_CONCERN/u);
    expect(validatorSource).toMatch(/function postCommitVerificationError[\s\S]*ownerCommitted/u);
    expect(privateRename?.pos).toBeLessThan(committedStatusRead?.pos ?? 0);
  });

  it("rejects a replaced marker and added root state during final stage revalidation", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const consumed = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "consumed", attempt: 1 });
    await writeFile(statusPath, JSON.stringify(consumed) + "\n", { mode: 0o600 });

    const preparedStage = await validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true });
    const statusBefore = await readFile(statusPath);
    const temporaryPath = path.join(stage.stageRoot, `.${MACOS_ARTIFACT_OWNER_STATUS_NAME}.test.tmp`);
    await writeFile(temporaryPath, "pending\n", { mode: 0o600 });
    await expect(validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true, temporaryPath })).resolves.toMatchObject({ status: consumed });

    const replacement = path.join(stage.stageRoot, "replacement-marker.json");
    await writeFile(replacement, markerBytes, { mode: 0o600 });
    await rename(replacement, stage.markerPath);
    const replacedStage = await validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true, temporaryPath });
    expect(() => assertRegularFileIdentity(replacedStage.markerIdentity, preparedStage.markerIdentity, "final stage marker")).toThrow(/identity changed after validation/);
    expect(await readFile(statusPath)).toEqual(statusBefore);

    await writeFile(path.join(stage.stageRoot, "unexpected-root-state"), "unexpected\n", { mode: 0o600 });
    await expect(validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true, temporaryPath })).rejects.toThrow(/unexpected or missing entries/);
    expect(await readFile(statusPath)).toEqual(statusBefore);
  });

  it("fails the end-to-end success operation before artifact validation for missing, wrong, or replaced consumed status", async () => {
    const stage = await createStageFixture();
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const markerBytes = await readFile(stage.markerPath);
    const result = retainedResultFixture();
    const signalSource = new EventEmitter();
    const signalController = createOwnerSignalController({ signalSource, killGraceMs: 1 });
    await expect(commitRetainedMacOSPackageSuccess({
      manifestPath: stage.manifestPath,
      repositoryRoot: process.cwd(),
      expectedStatusIdentity: { dev: 0, ino: 0, sha256: "0".repeat(64) },
      result,
      signalController,
    })).rejects.toThrow(/one authoritative owner lifecycle status record/);

    const prepared = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "prepared", attempt: 0 });
    await writeFile(statusPath, JSON.stringify(prepared) + "\n", { mode: 0o600 });
    const preparedIdentity = await captureRegularFileIdentity(statusPath, "prepared owner status");
    await expect(commitRetainedMacOSPackageSuccess({
      manifestPath: stage.manifestPath,
      repositoryRoot: process.cwd(),
      expectedStatusIdentity: preparedIdentity,
      result,
      signalController,
    })).rejects.toThrow(/requires exactly consumed attempt 1/);

    const consumed = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "consumed", attempt: 1 });
    await writeFile(statusPath, JSON.stringify(consumed) + "\n", { mode: 0o600 });
    const consumedIdentity = await captureRegularFileIdentity(statusPath, "consumed owner status");
    const replacement = path.join(stage.stageRoot, "replacement-status.json");
    await writeFile(replacement, JSON.stringify(consumed) + "\n", { mode: 0o600 });
    await rename(replacement, statusPath);
    await expect(commitRetainedMacOSPackageSuccess({
      manifestPath: stage.manifestPath,
      repositoryRoot: process.cwd(),
      expectedStatusIdentity: consumedIdentity,
      result,
      signalController,
    })).rejects.toThrow(/identity changed after validation/);
    signalController.close();
  });

  it("rejects success evidence creation and retained-success transition through every shared lifecycle helper", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const result = retainedResultFixture();
    const consumed = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "consumed", attempt: 1 });
    const successEvidence = successTerminalFixture({ stageRoot: stage.stageRoot, markerBytes, result });
    const successStatus = successStatusFixture({ stageRoot: stage.stageRoot, markerBytes, terminal: successEvidence });

    expect(() => buildOwnerTerminalEvidence({
      stageRoot: stage.stageRoot,
      markerBytes,
      status: consumed,
      outcome: "success",
      result,
    })).toThrow(/shared owner evidence helper cannot create success terminal evidence/);
    expect(() => createOwnerStatusDocument({
      stageRoot: stage.stageRoot,
      markerBytes,
      state: "retained-success",
      attempt: 1,
      outcome: "success",
      terminal: successEvidence,
    })).toThrow(/shared owner status helper cannot create retained-success/);

    const prepared = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "prepared", attempt: 0 });
    const preparationFailureEvidence = buildOwnerTerminalEvidence({ stageRoot: stage.stageRoot, markerBytes, status: prepared, outcome: "preparation-failure", error: new Error("fixture") });
    const preparationFailure = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "retained-preparation-failure", attempt: 0, outcome: "preparation-failure", terminal: preparationFailureEvidence });
    await writeOwnerFailureStatusAtomically({
      filePath: statusPath,
      value: preparationFailure,
      stageRoot: stage.stageRoot,
      markerBytes,
      allowMissingTarget: true,
    });
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toEqual(preparationFailure);

    await writeFile(statusPath, JSON.stringify(consumed) + "\n", { mode: 0o600 });
    const before = await captureRegularFileIdentity(statusPath, "shared helper success rejection status");
    await expect(writeArtifactMetadataAtomically({
      filePath: statusPath,
      value: successStatus,
      expectedTarget: before,
    })).rejects.toThrow(/shared artifact metadata writer cannot target the owner lifecycle status/);
    await expect(writeOwnerFailureStatusAtomically({
      filePath: statusPath,
      value: successStatus,
      stageRoot: stage.stageRoot,
      markerBytes,
      expectedTarget: before,
    })).rejects.toThrow(/shared owner failure writer accepts only/);
    await expect(transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath,
      markerBytes,
      from: "consumed",
      state: "retained-success",
      attempt: 1,
      outcome: "success",
      terminal: successEvidence,
      expectedCurrentIdentity: before,
    })).rejects.toThrow(/shared owner lifecycle helper cannot transition to retained-success/);
    expect((await captureRegularFileIdentity(statusPath, "shared helper success rejection status")).sha256).toBe(before.sha256);
  });

  it("binds status identity and exact success result and rejects every stale variant", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const consumed = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "consumed", attempt: 1 });
    await writeFile(statusPath, JSON.stringify(consumed) + "\n", { mode: 0o600 });
    const expectedIdentity = await captureRegularFileIdentity(statusPath, "expected consumed status");
    const replacementPath = path.join(stage.stageRoot, "replacement-status.json");
    await writeFile(replacementPath, JSON.stringify(consumed) + "\n", { mode: 0o600 });
    await rename(replacementPath, statusPath);
    const replacementIdentity = await captureRegularFileIdentity(statusPath, "replacement consumed status");
    expect(() => assertRegularFileIdentity(replacementIdentity, expectedIdentity, "consumed status race")).toThrow(/identity changed after validation/);
    await expect(transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath,
      markerBytes,
      from: "consumed",
      state: "retained-failure",
      attempt: 1,
      outcome: "failure",
      terminal: buildOwnerTerminalEvidence({ stageRoot: stage.stageRoot, markerBytes, status: consumed, outcome: "failure", error: new Error("fixture") }),
      expectedCurrentIdentity: expectedIdentity,
    })).rejects.toThrow(/identity changed after validation/);

    const result = retainedResultFixture();
    const terminal = successTerminalFixture({ stageRoot: stage.stageRoot, markerBytes, result });
    const retainedSuccess = successStatusFixture({ stageRoot: stage.stageRoot, markerBytes, terminal });
    expect(assertOwnerTerminalResult(terminal, result, { stageRoot: stage.stageRoot, markerBytes })).toEqual(result);
    expect(assertExternalRetainedSuccess(retainedSuccess, result, { stageRoot: stage.stageRoot, markerBytes })).toBe(retainedSuccess);
    const prepared = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "prepared", attempt: 0 });
    const preparationFailureEvidence = buildOwnerTerminalEvidence({ stageRoot: stage.stageRoot, markerBytes, status: prepared, outcome: "preparation-failure", error: new Error("preparation fixture") });
    const forbiddenStatuses = [
      prepared,
      createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "preflight", attempt: 0 }),
      consumed,
      createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "retained-preparation-failure", attempt: 0, outcome: "preparation-failure", terminal: preparationFailureEvidence }),
    ];
    for (const outcome of ["failure", "interrupted"] as const) {
      const failureEvidence = buildOwnerTerminalEvidence({ stageRoot: stage.stageRoot, markerBytes, status: consumed, outcome, error: new Error(`${outcome} fixture`) });
      forbiddenStatuses.push(createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: outcome === "failure" ? "retained-failure" : "retained-interrupted", attempt: 1, outcome, terminal: failureEvidence }));
    }
    for (const status of forbiddenStatuses) {
      expect(() => assertExternalRetainedSuccess(status, result, { stageRoot: stage.stageRoot, markerBytes })).toThrow(/requires exactly retained-success/);
    }
    for (const field of ["artifactDigest", "packageInputDigest", "artifactInputDigest", "signatureStateDigest", "entries", "macho", "codeResources"] as const) {
      const changed = { ...result, [field]: typeof result[field] === "number" ? result[field] + 1 : "f".repeat(64) };
      expect(() => assertOwnerTerminalResult(terminal, changed, { stageRoot: stage.stageRoot, markerBytes })).toThrow(/differs from the exact validated artifact result/);
    }
  });

  it("keeps retained F5 authority private and loads canonical files with fixed owner tools", async () => {
    const canonical = await loadEntitlementPolicy({ repositoryRoot: process.cwd(), ownerMode: true });
    const originalPath = process.env.PATH;
    process.env.PATH = "/definitely-not-a-tool-path";
    try {
      await expect(loadEntitlementPolicy({ repositoryRoot: process.cwd(), ownerMode: true })).resolves.toMatchObject({ mapSha256: canonical.mapSha256 });
    } finally {
      process.env.PATH = originalPath;
    }
    expect(Object.keys(packageValidator)).not.toContain("validateRetainedSigningPolicyAuthority");
    const source = await readFile(path.resolve("scripts/validate-macos-package.mjs"), "utf8");
    const syntax = ts.createSourceFile("validate-macos-package.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const authorityFunction = syntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "validateRetainedSigningPolicyAuthority");
    expect(authorityFunction?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).not.toBe(true);
    const authorityCalls = collectCallExpressions(authorityFunction as ts.Node);
    expect(authorityCalls.some((call) => ts.isIdentifier(call.expression) && call.expression.text === "loadEntitlementPolicy")).toBe(true);
    const comparisonFunction = syntax.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "buildRetainedArtifactSigningInputs");
    const comparisonThrows: ts.ThrowStatement[] = [];
    const collectThrows = (node: ts.Node) => {
      if (ts.isThrowStatement(node)) comparisonThrows.push(node);
      ts.forEachChild(node, collectThrows);
    };
    collectThrows(comparisonFunction as ts.Node);
    expect(comparisonThrows.some((statement) => ts.isNewExpression(statement.expression)
      && statement.expression.arguments?.some((argument) => ts.isStringLiteral(argument) && argument.text === "embedded retained F5 policy differs from the canonical checked-in map or plist authority"))).toBe(true);
  });

  it("durably consumes one attempt and rejects reuse after consumed or terminal state", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const parentBinding = await captureOwnerParentBinding(stage.stageRoot);
    await writeFile(statusPath, JSON.stringify(createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes })) + "\n", { mode: 0o600 });
    await transitionOwnerStatus({ stageRoot: stage.stageRoot, statusPath, markerBytes, from: "prepared", state: "preflight", attempt: 0, parentBinding });
    await transitionOwnerStatus({ stageRoot: stage.stageRoot, statusPath, markerBytes, from: "preflight", state: "consumed", attempt: 1, parentBinding });
    await expect(transitionOwnerStatus({ stageRoot: stage.stageRoot, statusPath, markerBytes, from: "preflight", state: "consumed", attempt: 1 })).rejects.toThrow(/not an allowed preflight transition/);

    const status = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes, state: "consumed", attempt: 1 });
    await expect(validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true })).resolves.toMatchObject({ status: { state: "consumed", inDoubt: true, terminal: null } });
    const evidence = buildOwnerTerminalEvidence({ stageRoot: stage.stageRoot, markerBytes, status, outcome: "failure", error: new Error("fixture failure") });
    await transitionOwnerStatus({ stageRoot: stage.stageRoot, statusPath, markerBytes, from: "consumed", state: "retained-failure", attempt: 1, outcome: "failure", terminal: evidence, parentBinding });
    await expect(validateArtifactStageRoot({ stageRoot: stage.stageRoot, repositoryRoot: process.cwd(), ownerMode: true })).resolves.toMatchObject({ status: { state: "retained-failure", attempt: 1, terminal: evidence } });
    await expect(transitionOwnerStatus({ stageRoot: stage.stageRoot, statusPath, markerBytes, from: "consumed", state: "retained-failure", attempt: 1, outcome: "failure", terminal: evidence })).rejects.toThrow(/not an allowed consumed transition/);
    expect(validateOwnerTerminalEvidence(evidence, { stageRoot: stage.stageRoot, markerBytes }).outcome).toBe("failure");
    expect(await (await import("node:fs/promises")).lstat(path.join(stage.stageRoot, ".meetless-artifact-resign-evidence.json")).catch(() => null)).toBeNull();
  });

  it.each(["success", "failure", "interrupted"])("validates bounded %s terminal owner evidence", (outcome) => {
    const markerBytes = Buffer.from("marker");
    const status = createOwnerStatusDocument({ stageRoot: "/tmp/owner-stage", markerBytes, state: "consumed", attempt: 1 });
    const result = outcome === "success" ? {
      artifactDigest: "a".repeat(64),
      packageInputDigest: "b".repeat(64),
      artifactInputDigest: "c".repeat(64),
      signatureStateDigest: "d".repeat(64),
      entries: 13774,
      macho: 46,
      codeResources: 10,
    } : null;
    const evidence = outcome === "success"
      ? successTerminalFixture({ stageRoot: "/tmp/owner-stage", markerBytes, result: result as ReturnType<typeof retainedResultFixture> })
      : buildOwnerTerminalEvidence({
        stageRoot: "/tmp/owner-stage",
        markerBytes,
        status,
        outcome,
        result,
        error: new Error("bounded fixture diagnostic"),
      });
    expect(validateOwnerTerminalEvidence(evidence, { stageRoot: "/tmp/owner-stage", markerBytes }).outcome).toBe(outcome);
  });

  it("keeps the old owner status on interruption and the competing inode on a race", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const initial = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes });
    await writeFile(statusPath, JSON.stringify(initial) + "\n", { mode: 0o600 });
    const before = await captureRegularFileIdentity(statusPath, "owner attempt status");
    await expect(transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath,
      markerBytes,
      from: "prepared",
      state: "preflight",
      attempt: 0,
      beforeRename: async () => { throw new Error("simulated interruption"); },
    })).rejects.toThrow(/cannot atomically write/);
    expect((await captureRegularFileIdentity(statusPath, "owner attempt status")).ino).toBe(before.ino);

    const external = path.join(stage.stageRoot, "external-status.json");
    await writeFile(external, JSON.stringify(initial) + "\n", { mode: 0o600 });
    await expect(transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath,
      markerBytes,
      from: "prepared",
      state: "preflight",
      attempt: 0,
      beforeRename: async () => { await (await import("node:fs/promises")).rename(external, statusPath); },
    })).rejects.toThrow(/changed during the atomic write/);
    expect(await readFile(statusPath, "utf8")).toBe(JSON.stringify(initial) + "\n");
  });

  it("copies only regular bytes and internal relative symlinks into a fresh owner stage", async () => {
    const source = await createOwnerSourceFixture();
    const created: string[] = [];
    const stage = await createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: ({ stageRoot }: { stageRoot: string }) => { created.push(stageRoot); fixtureRoots.add(stageRoot); },
    });
    expect(created).toEqual([stage.stageRoot]);
    expect(await readFile(path.join(stage.bundlePath, "payload.txt"), "utf8")).toBe("payload");
    expect(await (await import("node:fs/promises")).readlink(path.join(stage.bundlePath, "current"))).toBe("payload.txt");
    expect(await (await import("node:fs/promises")).readdir(stage.stageRoot)).toEqual([
      ".meetless-artifact-resign-status.json",
      ".meetless-artifact-stage.json",
      "Meetless.app",
      "composition-manifest.json",
    ]);
    expect(stage.status?.state).toBe("prepared");
    expect(stage.status?.attempt).toBe(0);
    expect(stage.status?.outcome).toBeNull();
    expect(stage.status?.terminal).toBeNull();
  });

  it("rejects a retargeted symlink before creating its destination entry", async () => {
    const source = await createOwnerSourceFixture();
    await writeFile(path.join(source.bundlePath, "other.txt"), "other", { mode: 0o600 });
    let retainedStage: string | null = null;
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: async ({ stageRoot }: { stageRoot: string }) => {
        retainedStage = stageRoot;
        fixtureRoots.add(stageRoot);
        await unlink(path.join(source.bundlePath, "current"));
        await symlink("other.txt", path.join(source.bundlePath, "current"));
      },
    })).rejects.toThrow(/symlink target or digest changed/);
    expect(retainedStage).not.toBeNull();
    await expect(lstat(path.join(retainedStage as string, "Meetless.app", "current"))).rejects.toThrow();
  });

  it.each(["regular", "symlink", "directory", "unsupported"]) ("rejects an added source %s before creating a destination entry", async (kind) => {
    const source = await createOwnerSourceFixture();
    const addedName = `added-${kind}`;
    const addedPath = path.join(source.bundlePath, addedName);
    let retainedStage: string | null = null;
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: async ({ stageRoot }: { stageRoot: string }) => {
        retainedStage = stageRoot;
        fixtureRoots.add(stageRoot);
        if (kind === "regular") await writeFile(addedPath, "added", { mode: 0o600 });
        else if (kind === "symlink") await symlink("payload.txt", addedPath);
        else if (kind === "directory") await mkdir(addedPath, { mode: 0o700 });
        else await execFileAsync("mkfifo", [addedPath]);
      },
    })).rejects.toThrow(/added or missing from the accepted snapshot/);
    expect(retainedStage).not.toBeNull();
    await expect(lstat(path.join(retainedStage as string, "Meetless.app", addedName))).rejects.toThrow();
  });

  it("rejects missing expected source entries without retaining a destination entry", async () => {
    const source = await createOwnerSourceFixture();
    let retainedStage: string | null = null;
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: async ({ stageRoot }: { stageRoot: string }) => {
        retainedStage = stageRoot;
        fixtureRoots.add(stageRoot);
        await unlink(path.join(source.bundlePath, "current"));
        await unlink(path.join(source.bundlePath, "payload.txt"));
      },
    })).rejects.toThrow(/entries are missing from the accepted snapshot/);
    expect(retainedStage).not.toBeNull();
    await expect(lstat(path.join(retainedStage as string, "Meetless.app", "current"))).rejects.toThrow();
    await expect(lstat(path.join(retainedStage as string, "Meetless.app", "payload.txt"))).rejects.toThrow();
  });

  it.each(["external symlink", "hardlink", "FIFO"])("rejects %s during owner preparation before any signing call", async (kind) => {
    const source = await createOwnerSourceFixture();
    let signingCalls = 0;
    if (kind === "external symlink") {
      await writeFile(path.join(source.root, "outside.txt"), "outside", { mode: 0o600 });
      await symlink(path.join(source.root, "outside.txt"), path.join(source.bundlePath, "escape"));
    } else if (kind === "hardlink") {
      await link(path.join(source.bundlePath, "payload.txt"), path.join(source.bundlePath, "shared.txt"));
    } else {
      await execFileAsync("mkfifo", [path.join(source.bundlePath, "unsupported-fifo")]);
    }
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: ({ stageRoot }: { stageRoot: string }) => fixtureRoots.add(stageRoot),
    })).rejects.toThrow(kind === "external symlink" ? /escapes|outside/ : kind === "hardlink" ? /hard links/ : /unsupported lstat type/);
    signingCalls += 0;
    expect(signingCalls).toBe(0);
  });

  it("rejects source mutation after stage creation before any signing call", async () => {
    const source = await createOwnerSourceFixture();
    let signingCalls = 0;
    let retainedStage: string | null = null;
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: process.cwd(),
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: async ({ stageRoot }: { stageRoot: string }) => {
        retainedStage = stageRoot;
        fixtureRoots.add(stageRoot);
        await writeFile(path.join(source.bundlePath, "payload.txt"), "mutated", { mode: 0o600 });
      },
    })).rejects.toThrow(/source regular file changed|canonical app source changed/);
    signingCalls += 0;
    expect(signingCalls).toBe(0);
    expect(retainedStage).not.toBeNull();
    await expect(readFile(path.join(retainedStage as string, "Meetless.app", "payload.txt"))).rejects.toThrow();
  });

  it("owns one inherited-stdio codesign child and handles success, failure, and signals", async () => {
    const signalSource = new EventEmitter();
    const successfulChild = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    successfulChild.kill = () => true;
    let command = "";
    let stdio: unknown;
    let ownerEnvironment: Record<string, string> | undefined;
    const success = runOwnedCodesignChild(["--timestamp=none"], { relativePath: "fixture" }, {
      ownerMode: true,
      signalSource,
      spawnChild: (childCommand: string, _arguments: string[], options: { stdio: unknown; env?: Record<string, string> }) => {
        command = childCommand;
        stdio = options.stdio;
        ownerEnvironment = options.env;
        queueMicrotask(() => successfulChild.emit("close", 0, null));
        return successfulChild;
      },
    });
    await expect(success).resolves.toMatchObject({ code: 0 });
    expect(command).toBe("/usr/bin/codesign");
    expect(stdio).toEqual(["inherit", "inherit", "inherit"]);
    expect(ownerEnvironment?.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");

    const failedChild = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    failedChild.kill = () => true;
    await expect(runOwnedCodesignChild([], { relativePath: "failed" }, {
      signalSource,
      spawnChild: () => {
        queueMicrotask(() => failedChild.emit("close", 7, null));
        return failedChild;
      },
    })).rejects.toThrow(/exited 7/);

    const interruptedChild = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    const killed: string[] = [];
    interruptedChild.kill = (signal) => {
      killed.push(signal);
      queueMicrotask(() => interruptedChild.emit("close", null, signal));
      return true;
    };
    const interrupted = runOwnedCodesignChild([], { relativePath: "interrupted" }, {
      signalSource,
      spawnChild: () => interruptedChild,
      killGraceMs: 1,
    });
    signalSource.emit("SIGTERM");
    await expect(interrupted).rejects.toThrow(/interrupted by SIGTERM/);
    expect(killed).toEqual(["SIGTERM"]);
  });

  it("keeps owner signal handling active across child absence and marks the lifecycle interrupted", async () => {
    const signalSource = new EventEmitter();
    const controller = createOwnerSignalController({ signalSource, killGraceMs: 1 });
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    const killed: string[] = [];
    child.kill = (signal) => {
      killed.push(signal);
      queueMicrotask(() => controller.markChildClosed());
      return true;
    };
    controller.attachChild(child, "fixture");
    signalSource.emit("SIGINT");
    await controller.waitForChildAbsence();
    expect(killed).toEqual(["SIGINT"]);
    expect(() => controller.assertNotInterrupted()).toThrow(/owner lifecycle received SIGINT/);
    controller.close();
  });

  it("uses fixed owner tool paths and a sanitized environment so PATH shims receive zero calls", async () => {
    expect(MACOS_INVENTORY_OWNER_TOOL_PATHS.file).toBe("/usr/bin/file");
    expect(MACOS_INVENTORY_OWNER_TOOL_PATHS.otool).toBe("/usr/bin/otool");
    expect(MACOS_SIGNING_OWNER_TOOL_PATHS.codesign).toBe("/usr/bin/codesign");
    expect(MACOS_SIGNING_OWNER_TOOL_PATHS.security).toBe("/usr/bin/security");
    expect(MACOS_SIGNING_OWNER_TOOL_PATHS.plutil).toBe("/usr/bin/plutil");

    const root = await mkdtemp(path.join(os.tmpdir(), "meetless-owner-path-shim-"));
    fixtureRoots.add(root);
    const calls = path.join(root, "calls");
    const shimDirectory = path.join(root, "bin");
    await mkdir(shimDirectory, { recursive: true, mode: 0o700 });
    for (const name of ["file", "otool", "security", "plutil", "codesign"]) {
      const shim = path.join(shimDirectory, name);
      await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' ${name} >> ${JSON.stringify(calls)}\nexit 99\n`, { mode: 0o700 });
      await chmod(shim, 0o700);
    }
    const previousPath = process.env.PATH;
    process.env.PATH = shimDirectory;
    try {
      await inspectPackageMachOEntries("/usr/bin", [{ path: "file", type: "file" }], { ownerMode: true });
      await loadEntitlementPolicy({ repositoryRoot: process.cwd(), ownerMode: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await expect(readFile(calls, "utf8")).rejects.toThrow();
  });

  it("rejects a temporary parent inside the repository before creating or announcing a stage", async () => {
    const source = await createOwnerSourceFixture();
    const fakeRepository = await mkdtemp(path.join(os.tmpdir(), "meetless-owner-repository-"));
    fixtureRoots.add(fakeRepository);
    const inside = path.join(fakeRepository, "tmp");
    await mkdir(inside, { mode: 0o700 });
    let announced = 0;
    await expect(resolveOwnerTemporaryParent({ temporaryParent: inside, repositoryRoot: fakeRepository })).rejects.toThrow(/inside the canonical workspace or release root/);
    await expect(createOwnerStage({
      sourceRoot: source.sourceRoot,
      sourceBundlePath: source.bundlePath,
      sourceManifestPath: source.manifestPath,
      repositoryRoot: fakeRepository,
      temporaryParentPath: inside,
      marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
      onStageCreated: () => { announced += 1; },
    })).rejects.toThrow(/inside the canonical workspace or release root/);
    expect(announced).toBe(0);
    expect(await (await import("node:fs/promises")).readdir(inside)).toEqual([]);

    const unwritable = await mkdtemp(path.join(os.tmpdir(), "meetless-owner-unwritable-parent-"));
    fixtureRoots.add(unwritable);
    await chmod(unwritable, 0o500);
    try {
      await expect(createOwnerStage({
        sourceRoot: source.sourceRoot,
        sourceBundlePath: source.bundlePath,
        sourceManifestPath: source.manifestPath,
        repositoryRoot: fakeRepository,
        temporaryParentPath: unwritable,
        marker: (paths: { stageRoot: string }) => ownerMarker(paths.stageRoot),
        onStageCreated: () => { announced += 1; },
      })).rejects.toThrow(/cannot create|permission|EACCES|temporary/iu);
      expect(announced).toBe(0);
      expect(await (await import("node:fs/promises")).readdir(unwritable)).toEqual([]);
    } finally {
      await chmod(unwritable, 0o700);
    }
  });

  it("rejects a status-parent replacement after temp write without reporting a candidate", async () => {
    const stage = await createStageFixture();
    const markerBytes = await readFile(stage.markerPath);
    const statusPath = path.join(stage.stageRoot, MACOS_ARTIFACT_OWNER_STATUS_NAME);
    const parentBinding = await captureOwnerParentBinding(stage.stageRoot);
    const initial = createOwnerStatusDocument({ stageRoot: stage.stageRoot, markerBytes });
    await writeFile(statusPath, JSON.stringify(initial) + "\n", { mode: 0o600 });
    const moved = `${stage.stageRoot}-moved`;
    await expect(transitionOwnerStatus({
      stageRoot: stage.stageRoot,
      statusPath,
      markerBytes,
      from: "prepared",
      state: "preflight",
      attempt: 0,
      parentBinding,
      beforeRename: async () => {
        await rename(stage.stageRoot, moved);
        fixtureRoots.add(moved);
        await mkdir(stage.stageRoot, { mode: 0o700 });
      },
    })).rejects.toThrow(/parent realpath, device, inode/);
    expect(JSON.parse(await readFile(path.join(moved, MACOS_ARTIFACT_OWNER_STATUS_NAME), "utf8")).state).toBe("prepared");
    await expect(readFile(statusPath, "utf8")).rejects.toThrow();
  });

  it("requires all three native TTY streams and rejects remote or multiplexed facts", () => {
    expect(() => validateOwnerTerminalFacts({ stdinIsTTY: false, stdoutIsTTY: true, stderrIsTTY: true, environment: {} })).toThrow(/TTY/);
    expect(() => validateOwnerTerminalFacts({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, environment: { TMUX: "1" } })).toThrow(/multiplexed/);
    expect(validateOwnerTerminalFacts({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, environment: {} })).toEqual({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true });
  });
});

type Entry = {
  path: string;
  type: "file" | "symlink";
  size?: number;
  target?: string;
  sha256: string;
};

function createFixture() {
  const approved = MACOS_APPROVED_ENTITLEMENT_MAP.map((entry) => entry.path);
  const synthetic = Array.from({ length: 40 }, (_, index) => "Contents/Resources/fixture/" + String(index).padStart(2, "0") + "/binary");
  const macho = [...approved, ...synthetic];
  const machoPayloads = macho.map((relativePath, index) => payloadBinding(relativePath, index));
  const codeResources = [
    "Contents/_CodeSignature/CodeResources",
    ...Array.from({ length: 9 }, (_, index) => `Contents/Resources/fixture-${String(index).padStart(2, "0")}.app/Contents/_CodeSignature/CodeResources`),
  ];
  const entries: Entry[] = [
    fileEntry("Contents/Info.plist", "ordinary"),
    fileEntry("Contents/Resources/meetless/node_modules/example/package.json", "package-member"),
    fileEntry("Contents/Resources/meetless/notices/Node-LICENSE", "notice"),
    fileEntry(MACOS_LICENSE_INVENTORY_PATH, "inventory"),
    { path: "Contents/Resources/meetless/runtime/current-node", type: "symlink", target: "node", sha256: hash("node") },
    ...macho.map((relativePath) => fileEntry(relativePath, "macho")),
    ...codeResources.map((relativePath) => fileEntry(relativePath, "CodeResources")),
  ];
  const packageInputs = {
    schema: "MEETLESS_MACOS_PACKAGE_INPUTS v1",
    sourceSnapshot: { digest: "d".repeat(64) },
    inputs: [{ id: "fixture", sourcePaths: ["package.json"], artifactPathPrefixes: ["Contents/"] }],
    packageMembers: [],
    workspaceMembers: [],
    lockMetadataGaps: [],
    packageMemberDigest: "p".repeat(64),
    workspaceMemberDigest: "w".repeat(64),
    lockMetadataGapCount: 0,
    artifactInput: {
      algorithm: "sha256",
      digest: digestArtifactEntries(entries, { excludedPaths: [MACOS_LICENSE_INVENTORY_PATH, ...macho] }),
      entryCount: entries.length - macho.length - 1,
      excludedPaths: [MACOS_LICENSE_INVENTORY_PATH, ...macho],
    },
    digest: hash("package-baseline"),
  };
  const inventory = {
    schema: "MEETLESS_MACOS_LICENSE_INVENTORY v2",
    artifact: {
      entryBinding: {
        digest: "inventory-baseline",
        excludedPaths: [MACOS_LICENSE_INVENTORY_PATH, ...macho],
        excludedPathPrefixes: ["Contents/_CodeSignature/"],
      },
      packageInputBinding: { digest: packageInputs.digest },
    },
    components: [{
      id: "meetless",
      artifactPathScope: { paths: ["Contents/Info.plist"], count: 1 },
      provenance: { versionOrHash: { artifactScopeSha256: "old-scope" } },
      ownerDecision: { status: "unresolved" },
    }],
    policy: "accepted",
  };
  return { entries, finalEntries: mutateSigningBound(entries, macho, codeResources), macho, machoPayloads, codeResources, packageInputs, inventory };
}

function fixturePolicy() {
  return {
    schema: "MEETLESS_MACOS_ENTITLEMENT_MAP v1",
    mapPath: MACOS_ENTITLEMENT_MAP_PATH,
    mapSha256: "a".repeat(64),
    mapCanonicalSha256: "b".repeat(64),
    sourcePlists: [
      { path: "scripts/macos-entitlements/entitlements/audio-input.plist", fileSha256: "a".repeat(64), canonicalSha256: "b".repeat(64) },
      { path: "scripts/macos-entitlements/entitlements/jit.plist", fileSha256: "d".repeat(64), canonicalSha256: "e".repeat(64) },
    ],
    outer: {
      ...MACOS_APPROVED_OUTER_ENTITLEMENT,
      sourcePath: "scripts/macos-entitlements/entitlements/audio-input.plist",
      absolutePath: "/tmp/entitlements/audio-input.plist",
      ownerFileSha256: "a".repeat(64),
      ownerCanonicalSha256: "b".repeat(64),
      ownerKeys: [MACOS_APPROVED_OUTER_ENTITLEMENT.key],
    },
    entries: MACOS_APPROVED_ENTITLEMENT_MAP.map((entry) => ({
      ...entry,
      absolutePath: "/tmp/" + entry.plist,
    })),
  };
}

function mutateSigningBound(entries: Entry[], macho: string[], codeResources: string[]) {
  const signingPaths = new Set([...macho, ...codeResources, MACOS_LICENSE_INVENTORY_PATH]);
  return entries.map((entry) => signingPaths.has(entry.path) ? { ...entry, size: (entry.size ?? 0) + 1, sha256: "b".repeat(64) } : { ...entry });
}

function createPreOuterEntries(fixture: ReturnType<typeof createFixture>): Entry[] {
  const nestedCodeResources = fixture.codeResources.filter((relativePath) => relativePath !== MACOS_OUTER_CODE_RESOURCES_PATH);
  return fixture.entries.map((entry) => {
    if (fixture.macho.includes(entry.path) || nestedCodeResources.includes(entry.path) || entry.path === MACOS_LICENSE_INVENTORY_PATH) {
      return { ...entry, size: (entry.size ?? 0) + 1, sha256: "b".repeat(64) };
    }
    return { ...entry };
  });
}

function mutateEntry(entries: Entry[], relativePath: string, changes: Partial<Entry>) {
  return entries.map((entry) => entry.path === relativePath ? { ...entry, ...changes } : { ...entry });
}

function fileEntry(relativePath: string, contents: string): Entry {
  return { path: relativePath, type: "file", size: contents.length, sha256: hash(contents) };
}

function payloadBinding(relativePath: string, index: number) {
  return {
    path: relativePath,
    schema: MACOS_MACHO_PAYLOAD_SCHEMA,
    normalizer: MACOS_MACHO_PAYLOAD_NORMALIZER,
    algorithm: "sha256",
    payloadSha256: hash("payload-" + String(index)),
    payloadByteCount: 32,
    fileByteCount: 64,
    sliceCount: 1,
    signatureRangeCount: 1,
    metadata: {
      schema: "MEETLESS_MACOS_MACHO_DERIVED_METADATA v1",
      slices: [{
        offset: 0,
        size: 64,
        pageSize: 0x1000,
        signatureCommandOffset: 16,
        signatureDataOffset: 32,
        signatureDataSize: 32,
        linkeditCommandOffset: 8,
        linkeditFileOffset: 0,
        linkeditFileSize: 64,
        linkeditVmAddress: 0,
        linkeditVmSize: 0x1000,
        requiredLinkeditVmSize: 0x1000,
      }],
    },
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function collectCallExpressions(root: ts.Node) {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function findVariableDeclaration(root: ts.Node, name: string) {
  let match: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) match = node;
    if (!match) ts.forEachChild(node, visit);
  };
  visit(root);
  return match;
}

function retainedResultFixture() {
  return {
    artifactDigest: "a".repeat(64),
    packageInputDigest: "b".repeat(64),
    artifactInputDigest: "c".repeat(64),
    signatureStateDigest: "d".repeat(64),
    entries: 13775,
    macho: 46,
    codeResources: 10,
  };
}

function successTerminalFixture({ stageRoot, markerBytes, result }: { stageRoot: string; markerBytes: Buffer; result: ReturnType<typeof retainedResultFixture> }) {
  return {
    schema: MACOS_ARTIFACT_OWNER_EVIDENCE_SCHEMA,
    authority: MACOS_ARTIFACT_RESIGN_AUTHORITY,
    stageRoot,
    markerSha256: createHash("sha256").update(markerBytes).digest("hex"),
    attempt: 1,
    state: "retained-success",
    outcome: "success",
    result: { ...result },
    error: null,
  };
}

function successStatusFixture({ stageRoot, markerBytes, terminal }: { stageRoot: string; markerBytes: Buffer; terminal: ReturnType<typeof successTerminalFixture> }) {
  return {
    schema: MACOS_ARTIFACT_OWNER_STATUS_SCHEMA,
    authority: MACOS_ARTIFACT_RESIGN_AUTHORITY,
    stageRoot,
    markerSha256: createHash("sha256").update(markerBytes).digest("hex"),
    state: "retained-success",
    attempt: 1,
    outcome: "success",
    inDoubt: false,
    terminal,
  };
}

function retainedSigningFixture(policy: any) {
  const identity = "Developer ID Application: Long Le (63M98WD275)";
  return {
    mode: "release",
    localOnly: false,
    identity: {
      requested: identity,
      resolved: identity,
      certificateFingerprint: "a".repeat(64),
      certificateSha1: "b".repeat(40),
      teamId: "63M98WD275",
    },
    entitlements: {
      schema: policy.schema,
      mapPath: policy.mapPath,
      mapSha256: policy.mapSha256,
      mapCanonicalSha256: policy.mapCanonicalSha256,
      sourcePlists: policy.sourcePlists.map((source: any) => ({ ...source })),
      bindings: policy.entries.map((entry: any) => ({
        path: entry.path,
        sourcePath: entry.sourcePath,
        fileSha256: entry.ownerFileSha256,
        ownerCanonicalSha256: entry.ownerCanonicalSha256,
        expectedKeys: [...entry.ownerKeys],
      })),
    },
  };
}

function baselineManifestForTest() {
  const macho = ["Contents/MacOS/fixture"];
  return {
    candidateSnapshot: { digest: "source", paseoCommit: "paseo" },
    packageInputs: { digest: "changed", artifactInput: { digest: "artifact" } },
    artifactDigest: "artifact-final",
    signing: {
      mode: "local-ad-hoc",
      localOnly: true,
      identity: { requested: "-" },
      order: { outer: "Meetless.app", all: ["Contents/MacOS/fixture", "Meetless.app"] },
    },
    macho,
    entries: [{ path: "Contents/_CodeSignature/CodeResources" }],
  };
}

function testBaseline(machoPayloads = Array.from({ length: ACCEPTED_ARTIFACT_BASELINE.machoCount }, (_, index) => payloadBinding(`Contents/MacOS/fixture-${String(index).padStart(2, "0")}`, index)), fixture: ReturnType<typeof createFixture> | null = null) {
  return {
    ...ACCEPTED_ARTIFACT_BASELINE,
    sourceSnapshotDigest: "a".repeat(64),
    sourceSnapshotHead: "b".repeat(40),
    packageInputDigest: fixture?.packageInputs.digest ?? "c".repeat(64),
    artifactInputDigest: fixture?.packageInputs.artifactInput.digest ?? "d".repeat(64),
    artifactDigest: "e".repeat(64),
    signatureStateDigest: "f".repeat(64),
    manifestSha256: "1".repeat(64),
    machoPayloads,
  };
}

function baselineManifestForFixture(fixture: ReturnType<typeof createFixture>, baseline: ReturnType<typeof testBaseline>) {
  const inventoryEntry = fixture.entries.find((entry) => entry.path === MACOS_LICENSE_INVENTORY_PATH);
  return {
    candidateSnapshot: {
      digest: baseline.sourceSnapshotDigest,
      head: baseline.sourceSnapshotHead,
      paseoCommit: baseline.paseoCommit,
    },
    packageInputs: structuredClone(fixture.packageInputs),
    artifactDigest: baseline.artifactDigest,
    signing: {
      mode: "local-ad-hoc",
      localOnly: true,
      identity: { requested: "-" },
      order: buildSigningOrder(fixture.macho),
      signatureStateDigest: baseline.signatureStateDigest,
    },
    macho: [...fixture.macho],
    entries: structuredClone(fixture.entries),
    licenseInventory: {
      sha256: inventoryEntry?.sha256,
      artifactEntryDigest: fixture.inventory.artifact.entryBinding.digest,
      packageInputDigest: fixture.packageInputs.digest,
    },
  };
}

function syntheticMachO(signature: string, payload: string, { signatureCommandCount = 1, cpusubtype = 0 }: { signatureCommandCount?: number; cpusubtype?: number } = {}) {
  const headerSize = 32;
  const segmentCommandSize = 72;
  const signatureCommandSize = 16;
  const commandBytes = segmentCommandSize * 2 + signatureCommandSize * signatureCommandCount;
  const linkeditFileOffset = 0x4000;
  const linkeditPrefix = Buffer.from("linkedit-prefix");
  const dataOffset = linkeditFileOffset + linkeditPrefix.length;
  const signatureBytes = Buffer.from(signature);
  const payloadBytes = Buffer.from(payload);
  const bytes = Buffer.alloc(dataOffset + signatureBytes.length);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(cpusubtype, 8);
  bytes.writeUInt32LE(1, 12);
  bytes.writeUInt32LE(2 + signatureCommandCount, 16);
  bytes.writeUInt32LE(commandBytes, 20);
  bytes.writeUInt32LE(0, 24);
  writeSyntheticSegment(bytes, headerSize, "__TEXT", 0, 0x4000, 0, 0x4000, 0x5, 0x5);
  const linkeditFileSize = linkeditPrefix.length + signatureBytes.length;
  writeSyntheticSegment(bytes, headerSize + segmentCommandSize, "__LINKEDIT", 0x4000, Math.ceil(linkeditFileSize / 0x4000) * 0x4000, linkeditFileOffset, linkeditFileSize, 0x1, 0x1);
  const signatureCommandOffset = headerSize + segmentCommandSize * 2;
  for (let index = 0; index < signatureCommandCount; index += 1) {
    const commandOffset = signatureCommandOffset + signatureCommandSize * index;
    bytes.writeUInt32LE(0x1d, commandOffset);
    bytes.writeUInt32LE(signatureCommandSize, commandOffset + 4);
    bytes.writeUInt32LE(dataOffset, commandOffset + 8);
    bytes.writeUInt32LE(signatureBytes.length, commandOffset + 12);
  }
  payloadBytes.copy(bytes, 0x200);
  linkeditPrefix.copy(bytes, linkeditFileOffset);
  signatureBytes.copy(bytes, dataOffset);
  return bytes;
}

function writeSyntheticSegment(bytes: Buffer, offset: number, name: string, vmaddr: number, vmsize: number, fileoff: number, filesize: number, maxprot: number, initprot: number) {
  bytes.writeUInt32LE(0x19, offset);
  bytes.writeUInt32LE(72, offset + 4);
  Buffer.from(name).copy(bytes, offset + 8);
  bytes.writeBigUInt64LE(BigInt(vmaddr), offset + 24);
  bytes.writeBigUInt64LE(BigInt(vmsize), offset + 32);
  bytes.writeBigUInt64LE(BigInt(fileoff), offset + 40);
  bytes.writeBigUInt64LE(BigInt(filesize), offset + 48);
  bytes.writeUInt32LE(maxprot, offset + 56);
  bytes.writeUInt32LE(initprot, offset + 60);
  bytes.writeUInt32LE(0, offset + 64);
  bytes.writeUInt32LE(0, offset + 68);
}

function syntheticFatMachO(firstSignature: string, secondSignature: string, { firstSubtype = 0, secondSubtype = 2 }: { firstSubtype?: number; secondSubtype?: number } = {}) {
  const first = syntheticMachO(firstSignature, "payload-a", { cpusubtype: firstSubtype });
  const second = syntheticMachO(secondSignature, "payload-b", { cpusubtype: secondSubtype });
  const firstOffset = 0x1000;
  const secondOffset = Math.ceil((firstOffset + first.length) / 0x1000) * 0x1000;
  const bytes = Buffer.alloc(secondOffset + second.length);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(2, 4);
  writeSyntheticFatArch(bytes, 8, 0x0100000c, firstSubtype, firstOffset, first.length);
  writeSyntheticFatArch(bytes, 8 + 20, 0x0100000c, secondSubtype, secondOffset, second.length);
  first.copy(bytes, firstOffset);
  second.copy(bytes, secondOffset);
  return bytes;
}

function writeSyntheticFatArch(bytes: Buffer, offset: number, cputype: number, cpusubtype: number, sliceOffset: number, sliceSize: number) {
  bytes.writeUInt32BE(cputype, offset);
  bytes.writeUInt32BE(cpusubtype, offset + 4);
  bytes.writeUInt32BE(sliceOffset, offset + 8);
  bytes.writeUInt32BE(sliceSize, offset + 12);
  bytes.writeUInt32BE(12, offset + 16);
}

async function createOwnerSourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetless-owner-source-"));
  fixtureRoots.add(root);
  const sourceRootPath = path.join(root, "release", "macos");
  await mkdir(sourceRootPath, { recursive: true, mode: 0o700 });
  const sourceRoot = await realpath(sourceRootPath);
  const bundlePath = path.join(sourceRoot, "Meetless.app");
  const manifestPath = path.join(sourceRoot, "composition-manifest.json");
  await mkdir(bundlePath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(bundlePath, "payload.txt"), "payload", { mode: 0o600 });
  await symlink("payload.txt", path.join(bundlePath, "current"));
  await writeFile(manifestPath, "{}\n", { mode: 0o600 });
  return { root, sourceRoot, bundlePath, manifestPath };
}

function ownerMarker(stageRoot: string) {
  return {
    schema: "MEETLESS_MACOS_ARTIFACT_STAGE v1",
    stageRoot,
    bundlePath: "Meetless.app",
    manifestPath: "composition-manifest.json",
    baseline: testBaseline(),
    policy: createStagePolicyEvidence(fixturePolicy()),
  };
}

async function createStageFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "meetless-artifact-resign-stage-"));
  const stageRoot = await realpath(temporaryRoot);
  fixtureRoots.add(temporaryRoot);
  fixtureRoots.add(stageRoot);
  const bundlePath = path.join(stageRoot, "Meetless.app");
  const manifestPath = path.join(stageRoot, "composition-manifest.json");
  const markerPath = path.join(stageRoot, ".meetless-artifact-stage.json");
  await mkdir(bundlePath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(bundlePath, "payload.txt"), "payload", { mode: 0o600 });
  await writeFile(manifestPath, "{}\n", { mode: 0o600 });
  const marker = {
    schema: "MEETLESS_MACOS_ARTIFACT_STAGE v1",
    stageRoot,
    bundlePath: "Meetless.app",
    manifestPath: "composition-manifest.json",
    baseline: testBaseline(),
    policy: {
      schema: "MEETLESS_MACOS_ENTITLEMENT_MAP v1",
      mapPath: MACOS_ENTITLEMENT_MAP_PATH,
      mapSha256: "a".repeat(64),
      mapCanonicalSha256: "b".repeat(64),
      sourcePlists: [
        { path: "scripts/macos-entitlements/entitlements/audio-input.plist", fileSha256: "c".repeat(64), canonicalSha256: "d".repeat(64) },
        { path: "scripts/macos-entitlements/entitlements/jit.plist", fileSha256: "e".repeat(64), canonicalSha256: "f".repeat(64) },
      ],
    },
  };
  await writeFile(markerPath, JSON.stringify(marker) + "\n", { mode: 0o600 });
  await chmod(stageRoot, 0o700);
  return { stageRoot, bundlePath, manifestPath, markerPath };
}

type PhaseGraph = {
  fixture: ReturnType<typeof createFixture>;
  baseline: Record<string, any>;
  baselineManifest: Record<string, any>;
  preOuterEntries: Entry[];
  finalEntries: Entry[];
  preOuterSigningBound: Record<string, any>;
  finalSigningBound: Record<string, any>;
  packageInputs: Record<string, any>;
  inventory: Record<string, any>;
  manifest: Record<string, any>;
};

function createPhaseGraph(): PhaseGraph {
  const fixture = createFixture();
  const baseline = testBaseline(fixture.machoPayloads, fixture);
  const nestedCodeResources = fixture.codeResources.filter((relativePath) => relativePath !== MACOS_OUTER_CODE_RESOURCES_PATH);
  const preOuterEntries = createPreOuterEntries(fixture);
  const preOuterSigningBound = buildPreOuterSigningBoundDescriptor({
    machoPaths: fixture.macho,
    machoPayloads: fixture.machoPayloads,
    codeResourcePaths: nestedCodeResources,
    baselinePackageInputs: fixture.packageInputs,
    preOuterEntries,
    baselineInventory: fixture.inventory,
  });
  const packageInputs = rebindPackageInputManifest({
    baseline: fixture.packageInputs,
    preOuterEntries,
    signingBound: preOuterSigningBound,
  });
  const inventory = rebindLicenseInventory({
    baseline: fixture.inventory,
    packageInputs,
    preOuterEntries,
    signingBound: preOuterSigningBound,
  });
  const finalEntries = preOuterEntries.map((entry) => entry.path === MACOS_OUTER_CODE_RESOURCES_PATH
    ? { ...entry, size: (entry.size ?? 0) + 1, sha256: "d".repeat(64) }
    : { ...entry });
  const finalSigningBound = createSigningBoundDescriptor({
    phase: "final",
    machoPaths: fixture.macho,
    machoPayloads: fixture.machoPayloads,
    codeResourcePaths: fixture.codeResources,
  });
  const baselineManifest = baselineManifestForFixture(fixture, baseline);
  const signing = {
    signatureStateDigest: "e".repeat(64),
    signatureState: {
      outer: { path: "Meetless.app", observed: true },
      nestedMachO: fixture.macho.map((path) => ({ path, observed: true })),
    },
  };
  const manifest = buildArtifactResignManifest({
    baselineManifest,
    packageInputs,
    inventory,
    signing,
    preOuterEntries,
    finalEntries,
    preOuterSigningBound,
    finalSigningBound,
    baseline,
    markerBytes: Buffer.from("marker"),
  });
  return { fixture, baseline, baselineManifest, preOuterEntries, finalEntries, preOuterSigningBound, finalSigningBound, packageInputs, inventory, manifest };
}
