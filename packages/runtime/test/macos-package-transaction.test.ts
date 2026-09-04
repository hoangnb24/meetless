import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  newPackageTransactionId,
  fingerprintPath,
  packageTransactionPaths,
  recoverPackageTransaction,
  readPackageTransactionProof,
  replacePackageBundle,
  serializeSortedJson,
  restorePackageTransaction,
} from "../../../scripts/lib/macos-package-transaction.mjs";
import { MAS_GATE_LOCK_BASENAME, acquireMasGateLock } from "../../../scripts/lib/macos-mas-gate-lock.mjs";
import { freezeMasGateArtifactBinding } from "../../../scripts/lib/mas-gate-artifact-binding.mjs";
import {
  MACOS_PACKAGE_PARENT_SYSTEM_PATH,
  evaluateMacOSPackageParentPolicy,
} from "../../../scripts/lib/macos-package-parent-policy.mjs";
import {
  archiveMasGateSessionTransaction,
  beginMasGateSessionTransaction,
  MAS_GATE_SESSION_INDEX_BASENAME,
  MAS_GATE_SESSION_INDEX_INTENT_BASENAME,
  MAS_GATE_SESSION_INDEX_SCHEMA,
  MAS_GATE_SESSION_INDEX_VERSION,
  restoreMasGateSessionTransaction,
} from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

const identityGoldenVector = {
  version: 1,
  bundleIdentifier: "com.meetless.app",
  bundlePath: "/Applications/Meetless.app",
  bundleRealPath: "/Applications/Meetless.app",
  executablePath: "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
  designatedRequirement: "identifier \"com.meetless.app\": path \"https://example.test/a/b\" literal marker",
  cdHash: "a".repeat(40),
  binarySha256: "b".repeat(64),
  binaryDevice: 42,
  binaryInode: 987654321,
  binarySize: 123456,
  configuration: {
    repositoryRoot: "/Users/example/Meetless / source",
    runtimeRoot: "/Users/example/Library/Application Support/Meetless",
    listen: "127.0.0.1:16777",
    rendererOrigin: "http://127.0.0.1:18082/path/a/b",
    transcriptionSocket: "/Users/example/Library/Application Support/Meetless/transcription.sock",
    transcriptionStaging: "/Users/example/Library/Application Support/Meetless/meeting-store/transcription-ranges",
    nodePath: "/Users/example/Meetless / source/runtime/node",
    runtimeCliPath: "/Users/example/Meetless / source/packages/runtime/dist/cli.js",
    identityPath: "/Users/example/Library/Application Support/Meetless/paseo-home/server-id",
    captureHelperPath: undefined,
    endpointPolicy: undefined,
    endpointWorkingDirectory: undefined,
    recordingEndpointName: undefined,
    transcriptionEndpointName: undefined,
  },
};

const recursiveGoldenVector = {
  array: ["a/b", "quote\": / and \\\\backslash", 17],
  emptyArray: [],
  emptyObject: {},
  escaped: "<\/script> \"quoted\": value \\\\ newline\n separator ",
  nested: { z: "last", a: "first" },
  nullValue: null,
  optionalOmitted: undefined,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function absentRuntime(runtimeRoot: string, parentPath: string) {
  return {
    status: "absent",
    runtimeRoot,
    parentPath,
    stateScope: "runtime-root-only",
    processes: [],
    listeners: [],
    sockets: [],
    openHandles: [],
  };
}

describe("macOS package-parent policy", () => {
  const currentUid = process.getuid?.() ?? 501;
  const wrongUid = currentUid === 0 ? 501 : currentUid;

  it("accepts synthetic exact /Applications metadata only with admin membership", () => {
    const systemMetadata = {
      type: "directory",
      isDirectory: true,
      isSymbolicLink: false,
      uid: 0,
      gid: 80,
      mode: 0o775,
    };
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      resolvedPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      metadata: systemMetadata,
      currentUid,
      effectiveUid: wrongUid,
      supplementaryGroups: [80],
      adminGroupId: 80,
    })).toMatchObject({ accepted: true, classification: "system-applications" });

    expect(evaluateMacOSPackageParentPolicy({
      parentPath: "/private/tmp/not-Applications",
      resolvedPath: "/private/tmp/not-Applications",
      metadata: systemMetadata,
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [80],
      adminGroupId: 80,
    })).toMatchObject({ accepted: false });
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      resolvedPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      metadata: systemMetadata,
      currentUid,
      effectiveUid: wrongUid,
      supplementaryGroups: [],
      adminGroupId: 80,
    })).toMatchObject({ accepted: false });
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: "/private/tmp/private-package-parent",
      resolvedPath: "/private/tmp/private-package-parent",
      metadata: {
        type: "directory",
        isDirectory: true,
        isSymbolicLink: false,
        uid: currentUid,
        gid: 20,
        mode: 0o700,
      },
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [],
    })).toMatchObject({ accepted: true, classification: "private" });
  });

  it.each([
    ["wrong uid", { uid: wrongUid, gid: 80, mode: 0o775 }],
    ["wrong gid", { uid: 0, gid: 20, mode: 0o775 }],
    ["wrong mode", { uid: 0, gid: 80, mode: 0o755 }],
    ["symlink", { type: "symlink", isDirectory: false, isSymbolicLink: true, uid: 0, gid: 80, mode: 0o775 }],
  ] as const)("rejects /Applications %s metadata", (_label, change) => {
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      resolvedPath: MACOS_PACKAGE_PARENT_SYSTEM_PATH,
      metadata: {
        type: "directory",
        isDirectory: true,
        isSymbolicLink: false,
        uid: 0,
        gid: 80,
        mode: 0o775,
        ...change,
      },
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [80],
      adminGroupId: 80,
    })).toMatchObject({ accepted: false });
  });

  it("rejects aliases, writable private parents, and a writable runtime parent", () => {
    const metadata = { type: "directory", isDirectory: true, isSymbolicLink: false, uid: currentUid, gid: 20, mode: 0o700 };
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: "/private/tmp/package-alias",
      resolvedPath: "/private/tmp/real-package-parent",
      metadata,
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [],
    })).toMatchObject({ accepted: false });
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: "/private/tmp/private-package-parent",
      resolvedPath: "/private/tmp/private-package-parent",
      metadata: { ...metadata, mode: 0o775 },
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [],
    })).toMatchObject({ accepted: false });
    expect(evaluateMacOSPackageParentPolicy({
      parentPath: "/private/tmp/runtime-parent",
      resolvedPath: "/private/tmp/runtime-parent",
      metadata: { ...metadata, mode: 0o775 },
      currentUid,
      effectiveUid: currentUid,
      supplementaryGroups: [],
    })).toMatchObject({ accepted: false });
  });

  it("exercises the native package-parent policy against modeled system and private metadata", async () => {
    if (process.platform !== "darwin") return;
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-native-package-parent-policy-test-")));
    roots.push(root);
    const executable = path.join(root, "policy-test");
    await execFile("xcrun", [
      "swiftc",
      "-DMEETLESS_MAS_GATE_POLICY_TESTING",
      "native/macos-host/mas-gate-mutation/main.swift",
      "-o",
      executable,
    ], { cwd: path.resolve(".") });
    await execFile(executable, [], { cwd: path.resolve(".") });
  });

  it("keeps the native helper fail-closed for a group-writable non-system parent", async () => {
    if (process.platform !== "darwin") return;
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-native-package-parent-negative-test-")));
    roots.push(root);
    const lockParent = path.join(root, "runtime-parent");
    const packageParent = path.join(root, "package-parent");
    await mkdir(lockParent, { mode: 0o700 });
    await mkdir(packageParent, { mode: 0o700 });
    await chmod(packageParent, 0o775);
    const result = await execFile(
      path.resolve("native/macos-host/.build/release/MeetlessMasGateMutation"),
      [`--parent=${lockParent}`, `--lock=${path.join(lockParent, MAS_GATE_LOCK_BASENAME)}`, `--package-parent=${packageParent}`],
      { cwd: path.resolve(".") },
    ).then(() => null, (error) => error);
    expect(result?.code).not.toBe(0);
    expect(`${result?.stdout ?? ""}${result?.stderr ?? ""}`).toMatch(/package parent/);
    await expect(lstat(path.join(lockParent, MAS_GATE_LOCK_BASENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("macOS package replacement transaction", () => {
  it("rejects an invalid package parent before preparing the runtime lock", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-package-parent-order-test-")));
    roots.push(root);
    const lockParent = path.join(root, "runtime-parent");
    const packageParent = path.join(root, "package-parent");
    await mkdir(lockParent, { mode: 0o700 });
    await mkdir(packageParent, { mode: 0o700 });
    await chmod(packageParent, 0o775);

    await expect(acquireMasGateLock({ parentPath: lockParent, packageParentPath: packageParent }))
      .rejects.toThrow(/package parent policy/);
    await expect(lstat(path.join(lockParent, MAS_GATE_LOCK_BASENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back package identity before restoring the prior runtime root", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-m7-composition-test-")));
    roots.push(root);
    const parent = path.join(root, "support");
    const runtime = path.join(parent, "Meetless");
    const identityPath = path.join(runtime, "host-identity.json");
    const source = path.join(root, "source.app");
    const target = path.join(root, "Applications", "Meetless.app");
    await mkdir(path.dirname(target), { mode: 0o700 });
    await mkdir(path.join(runtime, "prior"), { recursive: true });
    await writeFile(
      path.join(parent, MAS_GATE_SESSION_INDEX_BASENAME),
      `${JSON.stringify({
        schema: MAS_GATE_SESSION_INDEX_SCHEMA,
        version: MAS_GATE_SESSION_INDEX_VERSION,
        runtimeRoot: runtime,
        parentPath: parent,
        activePath: path.join(parent, ".meetless-mas-gate-session.active"),
        indexPath: path.join(parent, MAS_GATE_SESSION_INDEX_BASENAME),
        indexIntentPath: path.join(parent, MAS_GATE_SESSION_INDEX_INTENT_BASENAME),
        entries: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(path.join(runtime, "prior", "opaque.txt"), "prior runtime\n");
    await writeFile(identityPath, "prior identity\n");
    const runtimeTransaction = await beginMasGateSessionTransaction({
      runtimeRoot: runtime,
      contractRuntimeRoot: runtime,
      runtimeRootParent: parent,
      identityRelativePath: "host-identity.json",
      identityPath,
      requiredFreeBytes: 1,
      assertNoLiveOwnedRuntime: async () => absentRuntime(runtime, parent),
    });
    await mkdir(path.join(source, "Contents"), { recursive: true });
    await writeFile(path.join(source, "Contents", "marker"), "candidate\n");
    const packageTransaction = await replacePackageBundle({
      source,
      target,
      identityPath,
      ownerToken: "M7-composition-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
    });
    await expect(readFile(identityPath, "utf8")).resolves.toContain("com.meetless.app");

    await restorePackageTransaction(packageTransaction, {
      ownerToken: "M7-composition-owner",
      target,
      identityPath,
    });
    await expect(lstat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await restoreMasGateSessionTransaction(runtimeTransaction, {
      runtimeRoot: runtime,
      contractRuntimeRoot: runtime,
      runtimeRootParent: parent,
      activePath: runtimeTransaction.activePath,
      identityRelativePath: "host-identity.json",
      identityPath,
      assertNoLiveOwnedRuntime: async () => absentRuntime(runtime, parent),
    });
    await expect(readFile(path.join(runtime, "prior", "opaque.txt"), "utf8")).resolves.toBe("prior runtime\n");
    await expect(readFile(identityPath, "utf8")).resolves.toBe("prior identity\n");
    await archiveMasGateSessionTransaction(runtimeTransaction, {
      runtimeRoot: runtime,
      contractRuntimeRoot: runtime,
      runtimeRootParent: parent,
      activePath: runtimeTransaction.activePath,
      identityRelativePath: "host-identity.json",
      identityPath,
      assertNoLiveOwnedRuntime: async () => absentRuntime(runtime, parent),
    });
  });

  it("recovers replacement interruption at every published state", async () => {
    const root = await setup();
    const { source, target, identityPath } = root;
    const ownerToken = "M7-test-owner";
    const inspect = async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath });

    for (const state of ["staged", "target-backed-up", "candidate-installed", "identity-published", "committed"]) {
      const runId = newPackageTransactionId();
      await expect(replacePackageBundle({ source, target, identityPath, ownerToken, runId, inspect, faultAt: state }))
        .rejects.toThrow(`injected package transaction interruption at ${state}`);
      await recoverPackageTransaction(packageTransactionPaths(target, runId).journal, {
        ownerToken,
        target,
        identityPath,
      });
      await expect(readFile(path.join(target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
      await expect(readFile(identityPath, "utf8")).resolves.toBe("prior identity\n");
    }
  });

  it("refuses restoration after an outside target mutation", async () => {
    const root = await setup();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => ({ bundleIdentifier: "com.meetless.app" }),
    });
    await writeFile(path.join(root.target, "outside-change"), "do not remove\n");
    await expect(restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/changed outside the package transaction/);
    await expect(readFile(path.join(root.target, "outside-change"), "utf8")).resolves.toBe("do not remove\n");
  });

  it("uses native-style recursive sorted identity bytes and rejects outside identity mutation", async () => {
    const root = await setup();
    const inspected = {
      z: "outer",
      configuration: {
        z: "nested-last",
        a: "nested-first",
      },
    };
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => inspected,
    });

    expect(transaction.nextIdentityBytes.toString()).toBe(
      '{\n  "configuration" : {\n    "a" : "nested-first",\n    "z" : "nested-last"\n  },\n  "z" : "outer"\n}\n',
    );
    expect(transaction.nextIdentityBytes).toEqual(serializeSortedJson(inspected));

    await writeFile(root.identityPath, serializeSortedJson(inspected));
    await restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    });
    await expect(readFile(root.identityPath, "utf8")).resolves.toBe("prior identity\n");

    const second = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => inspected,
    });
    await writeFile(root.identityPath, serializeSortedJson({ ...inspected, z: "outside mutation" }));
    await expect(restorePackageTransaction(second, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/identity changed outside package transaction/);
  });

  it("matches Foundation JSONEncoder bytes for complete identity and recursive values", () => {
    expect(serializeSortedJson(identityGoldenVector)).toEqual(Buffer.from(
      "ewogICJiaW5hcnlEZXZpY2UiIDogNDIsCiAgImJpbmFyeUlub2RlIiA6IDk4NzY1NDMyMSwKICAiYmluYXJ5U2hhMjU2IiA6ICJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwKICAiYmluYXJ5U2l6ZSIgOiAxMjM0NTYsCiAgImJ1bmRsZUlkZW50aWZpZXIiIDogImNvbS5tZWV0bGVzcy5hcHAiLAogICJidW5kbGVQYXRoIiA6ICJcL0FwcGxpY2F0aW9uc1wvTWVldGxlc3MuYXBwIiwKICAiYnVuZGxlUmVhbFBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHAiLAogICJjZEhhc2giIDogImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLAogICJjb25maWd1cmF0aW9uIiA6IHsKICAgICJpZGVudGl0eVBhdGgiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC9wYXNlby1ob21lXC9zZXJ2ZXItaWQiLAogICAgImxpc3RlbiIgOiAiMTI3LjAuMC4xOjE2Nzc3IiwKICAgICJub2RlUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9ydW50aW1lXC9ub2RlIiwKICAgICJyZW5kZXJlck9yaWdpbiIgOiAiaHR0cDpcL1wvMTI3LjAuMC4xOjE4MDgyXC9wYXRoXC9hXC9iIiwKICAgICJyZXBvc2l0b3J5Um9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlIiwKICAgICJydW50aW1lQ2xpUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9wYWNrYWdlc1wvcnVudGltZVwvZGlzdFwvY2xpLmpzIiwKICAgICJydW50aW1lUm9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTGlicmFyeVwvQXBwbGljYXRpb24gU3VwcG9ydFwvTWVldGxlc3MiLAogICAgInRyYW5zY3JpcHRpb25Tb2NrZXQiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC90cmFuc2NyaXB0aW9uLnNvY2siLAogICAgInRyYW5zY3JpcHRpb25TdGFnaW5nIiA6ICJcL1VzZXJzXC9leGFtcGxlXC9MaWJyYXJ5XC9BcHBsaWNhdGlvbiBTdXBwb3J0XC9NZWV0bGVzc1wvbWVldGluZy1zdG9yZVwvdHJhbnNjcmlwdGlvbi1yYW5nZXMiCiAgfSwKICAiZGVzaWduYXRlZFJlcXVpcmVtZW50IiA6ICJpZGVudGlmaWVyIFwiY29tLm1lZXRsZXNzLmFwcFwiOiBwYXRoIFwiaHR0cHM6XC9cL2V4YW1wbGUudGVzdFwvYVwvYlwiIGxpdGVyYWwgbWFya2VyIiwKICAiZXhlY3V0YWJsZVBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHBcL0NvbnRlbnRzXC9NYWNPU1wvTWVldGxlc3NIb3N0IiwKICAidmVyc2lvbiIgOiAxCn0K",
      "base64",
    ));
    expect(serializeSortedJson(recursiveGoldenVector)).toEqual(Buffer.from(
      "ewogICJhcnJheSIgOiBbCiAgICAiYVwvYiIsCiAgICAicXVvdGVcIjogXC8gYW5kIFxcXFxiYWNrc2xhc2giLAogICAgMTcKICBdLAogICJlbXB0eUFycmF5IiA6IFsKCiAgXSwKICAiZW1wdHlPYmplY3QiIDogewoKICB9LAogICJlc2NhcGVkIiA6ICI8XC9zY3JpcHQ+IFwicXVvdGVkXCI6IHZhbHVlIFxcXFwgbmV3bGluZVxuIHNlcGFyYXRvcuKAqCIsCiAgIm5lc3RlZCIgOiB7CiAgICAiYSIgOiAiZmlyc3QiLAogICAgInoiIDogImxhc3QiCiAgfSwKICAibnVsbFZhbHVlIiA6IG51bGwKfQo=",
      "base64",
    ));
  });

  it("rejects scalar and formatting mutations outside exact identity-byte ownership", async () => {
    const root = await setup();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => identityGoldenVector,
    });

    await writeFile(root.identityPath, serializeSortedJson({ ...identityGoldenVector, binarySize: 123457 }));
    await expect(restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/identity changed outside package transaction/);
    await expect(readFile(root.identityPath)).resolves.toEqual(
      serializeSortedJson({ ...identityGoldenVector, binarySize: 123457 }),
    );

    await writeFile(root.identityPath, Buffer.from(
      serializeSortedJson(identityGoldenVector).toString().replace(/"version" : 1/u, '"version": 1'),
    ));
    await expect(restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/identity changed outside package transaction/);
  });

  it("carries a complete immutable artifact binding through staging and installation", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-manifest.json");
    const publicKey = "test-public-sdk-key-never-journaled";
    const binding = await makeBinding(root.source, manifestPath, publicKey);
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-binding-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });

    expect(transaction.schema).toBe("MAS_PACKAGE_TRANSACTION v4");
    expect(Object.isFrozen(transaction.artifactBinding)).toBe(true);
    expect(transaction.artifactBinding).not.toHaveProperty("publicSdkKey");
    expect(JSON.stringify(transaction)).not.toContain(publicKey);
    expect(transaction.sourceFingerprint).toBe(binding.bundleFingerprint);
    expect(transaction.stagingFingerprint).toBe(binding.bundleFingerprint);
    expect(transaction.candidateFingerprint).toBe(binding.bundleFingerprint);
    await expect(fingerprintPath(root.target)).resolves.toBe(binding.bundleFingerprint);
  });

  it("proves only the exact committed fresh-root package identity by bytes and metadata", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-proof.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-proof");
    const ownerToken = "M7-package-proof-owner";
    const runId = newPackageTransactionId();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });

    const proof = await readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
    });
    expect(proof.status).toBe("committed");
    expect(proof.journalPath).toBe(packageTransactionPaths(root.target, runId).journal);
    expect(proof.transaction).toMatchObject({ state: "committed", ownerToken, runId });
    expect(proof.currentIdentityBytes).toEqual(transaction.nextIdentityBytes);
    expect(proof.currentIdentityFingerprint).toBe(transaction.nextIdentityFingerprint);

    const semanticRewrite = JSON.stringify(JSON.parse(transaction.nextIdentityBytes.toString("utf8"))) + "\n";
    await writeFile(root.identityPath, semanticRewrite);
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/current bytes do not exactly match/);
  });

  it("rejects altered package identity metadata before an authorized rollback", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-metadata-proof.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-metadata-proof");
    const ownerToken = "M7-package-proof-metadata";
    const runId = newPackageTransactionId();
    await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });
    const identityBytes = await readFile(root.identityPath);
    await rm(root.identityPath, { force: true });
    await writeFile(root.identityPath, identityBytes, { mode: 0o600 });
    const priorTarget = await readFile(path.join(root.target, "Contents", "marker"), "utf8");

    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/metadata does not exactly match/);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe(priorTarget);
  });

  it.each([
    ["wrong owner", (root: PackageFixture, transaction: any) => ({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-wrong-owner",
      runId: transaction.runId,
      runtimeRootPath: root.root,
    })],
    ["wrong identity path", (root: PackageFixture, transaction: any) => ({
      target: root.target,
      identityPath: path.join(root.root, "different-identity.json"),
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
    })],
    ["wrong target path", (root: PackageFixture, transaction: any) => ({
      target: path.join(root.root, "Other.app"),
      identityPath: root.identityPath,
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
    })],
  ] as const)("rejects %s before using package proof", async (_label, makeInput) => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, `app-store-development-${_label.replaceAll(" ", "-")}.json`);
    const binding = await makeBinding(root.source, manifestPath, `test-public-sdk-key-${_label}`);
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-proof-binding-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });
    await expect(readPackageTransactionProof(makeInput(root, transaction, binding))).rejects.toThrow(/owner token mismatch|identity path|missing at the fixed/iu);
  });

  it("rejects wrong run, artifact, non-committed, missing, and symlink identities before package mutation", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-negative-proof.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-negative-proof");
    const ownerToken = "M7-package-proof-negative";
    const runId = newPackageTransactionId();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });
    const journalPath = packageTransactionPaths(root.target, runId).journal;
    const journalBytes = await readFile(journalPath);
    const candidateMarker = await readFile(path.join(root.target, "Contents", "marker"), "utf8");
    const identityBytes = await readFile(root.identityPath);

    const wrongRun = `${runId}-wrong`;
    await writeFile(packageTransactionPaths(root.target, wrongRun).journal, journalBytes, { mode: 0o600 });
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId: wrongRun,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/run ID does not equal/);

    const mutateJournal = async (mutator: (record: any) => void, message: RegExp) => {
      const record = JSON.parse(journalBytes.toString("utf8"));
      mutator(record);
      await writeFile(journalPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await expect(readPackageTransactionProof({
        target: root.target,
        identityPath: root.identityPath,
        ownerToken,
        runId,
        runtimeRootPath: root.root,
      })).rejects.toThrow(message);
      await writeFile(journalPath, journalBytes, { mode: 0o600 });
    };
    await mutateJournal((record) => { record.candidateFingerprint = "0".repeat(64); }, /candidate fingerprint/);
    await mutateJournal((record) => { record.state = "identity-published"; }, /requires committed package state/);

    await rm(root.identityPath);
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/published identity is missing/);
    await writeFile(root.identityPath, identityBytes, { mode: 0o600 });

    await rm(journalPath);
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
      allowMissing: true,
    })).rejects.toThrow(/journal is missing while the package identity path is present/);
    await writeFile(journalPath, journalBytes, { mode: 0o600 });

    const symlinkTarget = path.join(root.root, "identity-target.json");
    await writeFile(symlinkTarget, identityBytes, { mode: 0o600 });
    await rm(root.identityPath);
    await symlink(symlinkTarget, root.identityPath);
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken,
      runId,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/metadata does not exactly match/);

    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe(candidateMarker);
  });

  it("preflights exact package authorization before any strict rollback mutation", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-rollback-proof.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-rollback-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-package-proof-rollback",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
    });
    const identityBytes = await readFile(root.identityPath);
    await rm(root.identityPath);
    await writeFile(root.identityPath, identityBytes, { mode: 0o600 });
    const candidateMarker = await readFile(path.join(root.target, "Contents", "marker"), "utf8");

    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      requireArtifactBinding: true,
      requireAuthorizedIdentity: true,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/metadata does not exactly match/);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe(candidateMarker);
  });

  it("retains a same-content destination collision instead of deleting it during recovery", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-collision.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-collision");
    const runId = newPackageTransactionId();
    await expect(replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-collision-owner",
      runId,
      inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
      artifactBinding: binding,
      beforeRename: async ({ label, destination }: { label: string; destination: string }) => {
        if (label === "package staging install rename") {
          await cp(root.source, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
        }
      },
    })).rejects.toThrow(/EEXIST/);

    const journal = packageTransactionPaths(root.target, runId).journal;
    await expect(recoverPackageTransaction(journal, {
      ownerToken: "M7-collision-owner",
      target: root.target,
      identityPath: root.identityPath,
      requireArtifactBinding: true,
    })).rejects.toThrow(/unowned candidate-content collision/);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
    await expect(readFile(path.join(root.source, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
    await expect(readFile(path.join(packageTransactionPaths(root.target, runId).staging, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
    await expect(readFile(path.join(packageTransactionPaths(root.target, runId).backup, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("retains a same-content identity collision instead of deleting it during recovery", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-identity-collision.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-identity-collision");
    const installedIdentity = { bundleIdentifier: "com.meetless.app", bundleRealPath: root.source };
    const runId = newPackageTransactionId();
    await expect(replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-identity-collision-owner",
      runId,
      inspect: async () => installedIdentity,
      artifactBinding: binding,
      afterRenameSyscall: async ({ label }: { label: string }) => {
        if (label === "package identity publication rename") {
          await rm(root.identityPath, { force: true });
          await writeFile(root.identityPath, serializeSortedJson(installedIdentity), { mode: 0o600 });
        }
      },
    })).rejects.toThrow(/published package identity differs from the transaction-owned temporary identity/);

    const journal = packageTransactionPaths(root.target, runId).journal;
    await expect(recoverPackageTransaction(journal, {
      ownerToken: "M7-identity-collision-owner",
      target: root.target,
      identityPath: root.identityPath,
      requireArtifactBinding: true,
    })).rejects.toThrow(/unowned same-content collision/);
    await expect(readFile(root.identityPath, "utf8")).resolves.toBe(serializeSortedJson(installedIdentity).toString("utf8"));
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
    await expect(readFile(path.join(root.source, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
    await expect(readFile(path.join(packageTransactionPaths(root.target, runId).backup, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("rejects source mutation after staged validation before moving the prior app", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-manifest.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key");
    let mutated = false;
    const runId = newPackageTransactionId();
    await expect(replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-binding-owner",
      runId,
      inspect: async (bundlePath: string) => {
        if (!mutated) {
          mutated = true;
          await writeFile(path.join(root.source, "Contents", "marker"), "changed-after-validation\n");
        }
        return { bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath };
      },
      artifactBinding: binding,
    })).rejects.toThrow(/validated MAS artifact source changed/);
    await recoverPackageTransaction(packageTransactionPaths(root.target, runId).journal, {
      ownerToken: "M7-binding-owner",
      target: root.target,
      identityPath: root.identityPath,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects manifest mutation after staged validation before moving the prior app", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-manifest.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key");
    const runId = newPackageTransactionId();
    await expect(replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-binding-owner",
      runId,
      inspect: async () => {
        await writeFile(manifestPath, "changed after validation\n");
        return { bundleIdentifier: "com.meetless.app", bundleRealPath: root.source };
      },
      artifactBinding: binding,
    })).rejects.toThrow(/validated MAS manifest changed/);
    await recoverPackageTransaction(packageTransactionPaths(root.target, runId).journal, {
      ownerToken: "M7-binding-owner",
      target: root.target,
      identityPath: root.identityPath,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a package move after the native holder dies after syscall and before acknowledgement", async () => {
    const root = await setup({ identity: false });
    const lease = await acquireMasGateLock({ parentPath: path.dirname(root.target) });
    const runId = newPackageTransactionId();
    try {
      await expect(replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: "M7-death-owner",
        runId,
        inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
        lockLease: lease,
        afterRenameSyscall: ({ label }: { label: string }) => {
          if (label === "package staging install rename") {
            process.kill(lease.holderPid, "SIGKILL");
            return new Promise((resolve) => setTimeout(resolve, 100));
          }
          return undefined;
        },
      })).rejects.toThrow(/holder exited|applied before its acknowledgement|MAS gate lock/);
    } finally {
      await lease.release();
    }
    await recoverPackageTransaction(packageTransactionPaths(root.target, runId).journal, {
      ownerToken: "M7-death-owner",
      target: root.target,
      identityPath: root.identityPath,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(readFile(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("journals identity construction before no-replace publication and recovers either helper death point", async () => {
    for (const deathPoint of ["before", "after"]) {
      const root = await setup({ identity: false });
      const manifestPath = path.join(root.root, `app-store-development-${deathPoint}.json`);
      const binding = await makeBinding(root.source, manifestPath, `test-public-sdk-key-${deathPoint}`);
      const lease = await acquireMasGateLock({ parentPath: path.dirname(root.target) });
      const runId = newPackageTransactionId();
      try {
        await expect(replacePackageBundle({
          source: root.source,
          target: root.target,
          identityPath: root.identityPath,
          ownerToken: `M7-identity-death-${deathPoint}`,
          runId,
          inspect: async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath }),
          artifactBinding: binding,
          lockLease: lease,
          beforeRename: deathPoint === "before" ? () => process.kill(lease.holderPid, "SIGKILL") : undefined,
          afterRenameSyscall: deathPoint === "after" ? ({ label }: { label: string }) => {
            if (label === "package identity publication rename") {
              process.kill(lease.holderPid, "SIGKILL");
              return new Promise((resolve) => setTimeout(resolve, 100));
            }
            return undefined;
          } : undefined,
        })).rejects.toThrow(/holder exited|applied before its acknowledgement|MAS gate lock/);
      } finally {
        await lease.release();
      }
      const journal = packageTransactionPaths(root.target, runId).journal;
      await recoverPackageTransaction(journal, {
        ownerToken: `M7-identity-death-${deathPoint}`,
        target: root.target,
        identityPath: root.identityPath,
        requireArtifactBinding: true,
      });
      const temporaryIdentityPath = `${root.identityPath}.m7.${runId}.identity.tmp`;
      await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
      await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(`${root.identityPath}.m7.${runId}.identity.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

async function setup({ identity = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-m7-package-transaction-test-")));
  roots.push(root);
  const source = path.join(root, "source.app");
  const target = path.join(root, "Applications", "Meetless.app");
  const identityPath = path.join(root, "identity.json");
  await mkdir(path.join(source, "Contents"), { recursive: true });
  await writeFile(path.join(source, "Contents", "marker"), "candidate\n");
  await mkdir(path.join(target, "Contents"), { recursive: true });
  await writeFile(path.join(target, "Contents", "marker"), "prior\n");
  if (identity) await writeFile(identityPath, "prior identity\n");
  return { root, source, target, identityPath };
}

type PackageFixture = {
  root: string;
  source: string;
  target: string;
  identityPath: string;
};

async function makeBinding(source: string, manifestPath: string, publicKey: string) {
  const manifestBytes = Buffer.from("retained manifest fixture\n");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const bundleFingerprint = await fingerprintPath(source);
  if (!bundleFingerprint) throw new Error("fixture source fingerprint is missing");
  return freezeMasGateArtifactBinding({
    schema: "MAS_GATE_ARTIFACT_BINDING v1",
    version: 1,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    bundlePath: source,
    bundleFingerprint,
    artifactDigest: "a".repeat(64),
    candidateSnapshotDigest: "b".repeat(64),
    packageInputDigest: "c".repeat(64),
    artifactInputDigest: "d".repeat(64),
    licenseDigest: "e".repeat(64),
    signatureDigest: "f".repeat(64),
    publicSdkKeySha256: createHash("sha256").update(publicKey).digest("hex"),
  });
}
