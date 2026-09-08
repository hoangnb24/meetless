import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  newPackageTransactionId,
  fingerprintPath,
  finalizePackageTransaction,
  packageTransactionPaths,
  readPackageRecoveryProof,
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
const MAS_LSOF_MAX_BUFFER_BYTES = 256 * 1024;
const MAS_LSOF_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };

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
      inspect: async (bundlePath: string) => makePublishedHostIdentity({ root, source, target, identityPath }, bundlePath),
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

    for (const state of ["prepared", "staged", "target-backed-up", "candidate-installed", "identity-published", "committed"]) {
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

  it("proves every known package rollback state from the fixed journal before resuming recovery", async () => {
    for (const state of ["prepared", "staged", "target-backed-up", "candidate-installed", "identity-published", "committed"]) {
      const root = await setup({ identity: false });
      const manifestPath = path.join(root.root, `app-store-development-recovery-${state}.json`);
      const binding = await makeBinding(root.source, manifestPath, `recovery-proof-${state}`);
      const ownerToken = `M7-recovery-proof-${state}`;
      const runId = newPackageTransactionId();
      await expect(replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken,
        runId,
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
        faultAt: state,
      })).rejects.toThrow(`injected package transaction interruption at ${state}`);

      const proof = await readPackageRecoveryProof({
        target: root.target,
        identityPath: root.identityPath,
        ownerToken,
        runId,
        runtimeRootPath: root.root,
        expectedArtifactBinding: binding,
      });
      expect(proof).toMatchObject({ status: "recoverable", state, ownerToken, runId });
      await recoverPackageTransaction(packageTransactionPaths(root.target, runId).journal, {
        ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
        requireRecoveryProof: true,
        expectedArtifactBinding: binding,
      });
      await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
      await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    }

    for (const state of ["restoring", "target-displaced", "target-restored", "identity-restored"]) {
      const root = await setup({ identity: false });
      const manifestPath = path.join(root.root, `app-store-development-recovery-${state}.json`);
      const binding = await makeBinding(root.source, manifestPath, `recovery-proof-${state}`);
      const ownerToken = `M7-recovery-proof-${state}`;
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken,
        runId: newPackageTransactionId(),
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
      });
      await expect(restorePackageTransaction(transaction, {
        ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
        requireRecoveryProof: true,
        expectedArtifactBinding: binding,
        faultAt: state,
      })).rejects.toThrow(`injected package transaction interruption at ${state}`);
      const proof = await readPackageRecoveryProof({
        target: root.target,
        identityPath: root.identityPath,
        ownerToken,
        runId: transaction.runId,
        runtimeRootPath: root.root,
        expectedArtifactBinding: binding,
      });
      expect(proof).toMatchObject({ status: "recoverable", state });
      await recoverPackageTransaction(packageTransactionPaths(root.target, transaction.runId).journal, {
        ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
        requireRecoveryProof: true,
        expectedArtifactBinding: binding,
      });
      await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
      await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps fresh-target package recovery bound to prior target absence", async () => {
    const root = await setup({ identity: false });
    await rm(root.target, { recursive: true });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-fresh-target.json"), "fresh-target-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-fresh-target-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await expect(readPackageRecoveryProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
      expectedArtifactBinding: binding,
    })).resolves.toMatchObject({ status: "recoverable", state: "committed" });
    await expect(readPackageTransactionProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
      expectedArtifactBinding: binding,
    })).resolves.toMatchObject({ status: "committed" });
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    await expect(lstat(root.target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an in-flight package cleanup intent before rollback", async () => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-cleanup.json"), "cleanup-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-cleanup-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const cleanupPath = `${transaction.target}.m7-cleanup-${transaction.runId}-${createHash("sha256")
      .update(`${transaction.target}\0installed package`).digest("hex").slice(0, 16)}`;
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    journal.state = "restoring";
    journal.cleanupPath = cleanupPath;
    journal.cleanupSource = transaction.target;
    journal.cleanupFingerprint = transaction.candidateFingerprint;
    journal.cleanupIdentity = transaction.candidateIdentity;
    await rename(transaction.target, cleanupPath);
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    await expect(readPackageRecoveryProof({
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
      expectedArtifactBinding: binding,
    })).resolves.toMatchObject({ status: "recoverable", state: "restoring" });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(cleanupPath)).resolves.toBeDefined();
    await expect(lstat(transaction.paths.journal)).resolves.toBeDefined();
    const retained = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(retained.retainedPackageDisposables.records).toHaveLength(1);
  });

  it("holds the package lease before absence and binds the runtime root before recovery mutation", async () => {
    for (const operation of ["recover", "restore", "finalize"] as const) {
      const root = await setup({ identity: false });
      const runtimeRoot = path.join(root.root, "runtime-root");
      const identityPath = path.join(runtimeRoot, "host-identity.json");
      await mkdir(runtimeRoot, { mode: 0o700 });
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath,
        ownerToken: `M7-lease-order-${operation}`,
        runId: newPackageTransactionId(),
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      });
      const events: string[] = [];
      const assertNoLiveHost = async () => {
        const contender = await acquireMasGateLock({ parentPath: path.dirname(root.target) })
          .then(async (lease) => {
            await lease.release();
            return null;
          }, (error) => error);
        expect(contender).toBeInstanceOf(Error);
        events.push("lease-acquired");

        const result = spawnSync("/usr/sbin/lsof", ["-nP", "+D", runtimeRoot, "-Fpcn"], {
          encoding: "utf8",
          maxBuffer: MAS_LSOF_MAX_BUFFER_BYTES,
          env: MAS_LSOF_ENV,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        events.push("absence");
      };
      const options = {
        ownerToken: transaction.ownerToken,
        target: root.target,
        identityPath,
        runtimeRootPath: runtimeRoot,
        assertNoLiveHost,
      };

      if (operation === "recover") {
        await recoverPackageTransaction(transaction.paths.journal, options);
      } else if (operation === "restore") {
        await restorePackageTransaction(transaction, options);
      } else {
        await finalizePackageTransaction(transaction, options);
      }
      events.push("mutation-complete");
      expect(events).toEqual(["lease-acquired", "absence", "mutation-complete"]);
      if (operation === "finalize") {
        await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("candidate\n");
        await expect(readFile(identityPath)).resolves.toEqual(transaction.nextIdentityBytes);
      } else {
        await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
        await expect(lstat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (operation === "finalize") {
        await expect(lstat(transaction.paths.journal)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(lstat(transaction.paths.journal)).resolves.toBeDefined();
        const retained = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
        expect(retained.retainedPackageDisposables.records.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not treat a missing journal with a fixed package residue as absent", async () => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-missing-journal.json"), "missing-journal-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-missing-journal-owner",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await rm(transaction.paths.journal);
    await cp(root.source, transaction.paths.staging, { recursive: true });
    await rm(root.identityPath);
    const before = await capturePackageState(root, transaction);
    const proofInput = {
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      runtimeRootPath: root.root,
      expectedArtifactBinding: binding,
      allowMissing: true,
    };
    await expect(readPackageRecoveryProof(proofInput)).rejects.toThrow(/journal is missing while package staging is present/);
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    })).rejects.toThrow(/journal is missing at the fixed target\/run-derived path/);
    await expect(capturePackageState(root, transaction)).resolves.toEqual(before);
  });

  it("rejects malformed, foreign, colliding, and impossible recovery states before any rollback mutation", async () => {
    const cases: Array<{
      label: string;
      mutate: (root: PackageFixture, transaction: any, binding: any) => Promise<Record<string, unknown> | void>;
      message: RegExp;
      options?: (root: PackageFixture, transaction: any, binding: any) => Record<string, unknown>;
    }> = [
      {
        label: "altered identity bytes",
        mutate: async (root) => {
          const bytes = await readFile(root.identityPath, "utf8");
          await writeFile(root.identityPath, bytes.replace("com.meetless.app", "com.other.app"));
        },
        message: /published identity.*bytes, digest, or metadata/,
      },
      {
        label: "altered identity format",
        mutate: async (root) => {
          const bytes = await readFile(root.identityPath, "utf8");
          await writeFile(root.identityPath, JSON.stringify(JSON.parse(bytes)));
        },
        message: /published identity.*bytes, digest, or metadata/,
      },
      {
        label: "missing identity",
        mutate: async (root) => { await rm(root.identityPath); },
        message: /published identity.*bytes, digest, or metadata/,
      },
      {
        label: "symlink identity",
        mutate: async (root) => {
          const bytes = await readFile(root.identityPath);
          const destination = path.join(root.root, "identity-copy.json");
          await writeFile(destination, bytes, { mode: 0o600 });
          await rm(root.identityPath);
          await symlink(destination, root.identityPath);
        },
        message: /published identity.*bytes, digest, or metadata/,
      },
      {
        label: "staging collision",
        mutate: async (root, transaction) => { await cp(root.source, transaction.paths.staging, { recursive: true }); },
        message: /unexpected staging artifact or collision/,
      },
      {
        label: "displaced collision",
        mutate: async (root, transaction) => { await cp(root.source, transaction.paths.displaced, { recursive: true }); },
        message: /unexpected displaced candidate or collision/,
      },
      {
        label: "identity temporary collision",
        mutate: async (root, transaction) => {
          await writeFile(`${root.identityPath}.m7.${transaction.runId}.identity.tmp`, await readFile(root.identityPath), { mode: 0o600 });
        },
        message: /unjournaled identity temporary or collision/,
      },
      {
        label: "malformed journal",
        mutate: async (_root, transaction) => { await writeFile(transaction.paths.journal, "not-json\n"); },
        message: /journal is malformed/,
      },
      {
        label: "unknown state",
        mutate: async (_root, transaction) => {
          const record = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
          record.state = "unknown-state";
          await writeFile(transaction.paths.journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        },
        message: /unknown or non-rollback state/,
      },
      {
        label: "impossible target-restored state",
        mutate: async (_root, transaction) => {
          const record = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
          record.state = "target-restored";
          await writeFile(transaction.paths.journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        },
        message: /unexpected prior-package backup|target-restored state is not the exact prior-target shape/,
      },
      {
        label: "wrong owner",
        mutate: async () => undefined,
        message: /owner token mismatch/,
        options: () => ({ ownerToken: "M7-foreign-owner" }),
      },
      {
        label: "wrong artifact",
        mutate: async () => undefined,
        message: /artifact binding differs from the authorized artifact/,
        options: (_root, _transaction, binding) => ({ expectedArtifactBinding: { ...binding, artifactDigest: "0".repeat(64) } }),
      },
      {
        label: "wrong run",
        mutate: async () => undefined,
        message: /journal is missing at the fixed target\/run-derived path/,
        options: (root, transaction) => ({
          runId: `${transaction.runId}-foreign`,
          target: root.target,
          identityPath: root.identityPath,
        }),
      },
      {
        label: "wrong identity path",
        mutate: async () => undefined,
        message: /identity path is not the fixed canonical identity/,
        options: (root, transaction) => ({
          runId: transaction.runId,
          target: root.target,
          identityPath: path.join(root.root, "foreign-identity.json"),
        }),
      },
      {
        label: "wrong runtime root",
        mutate: async () => undefined,
        message: /outside the exact runtime root|published host identity contains an invalid strict value/,
        options: (root) => ({ runtimeRootPath: path.join(root.root, "foreign-runtime") }),
      },
      {
        label: "wrong target path",
        mutate: async () => undefined,
        message: /target is not the fixed canonical target|journal is missing at the fixed target\/run-derived path/,
        options: (root, transaction) => ({
          runId: transaction.runId,
          target: path.join(root.root, "foreign.app"),
          identityPath: root.identityPath,
        }),
      },
      {
        label: "wrong candidate fingerprint",
        mutate: async (_root, transaction) => {
          const record = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
          record.candidateFingerprint = "0".repeat(64);
          await writeFile(transaction.paths.journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        },
        message: /artifact binding does not match the exact candidate fingerprint/,
      },
    ];

    for (const testCase of cases) {
      const root = await setup({ identity: false });
      const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-negative-${testCase.label.replaceAll(" ", "-")}.json`), `negative-${testCase.label}`);
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: "M7-recovery-negative-owner",
        runId: newPackageTransactionId(),
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
      });
      await testCase.mutate(root, transaction, binding);
      const before = await capturePackageState(root, transaction);
      const proofInput = {
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        runtimeRootPath: root.root,
        expectedArtifactBinding: binding,
        ...testCase.options?.(root, transaction, binding),
      };
      await expect(readPackageRecoveryProof(proofInput)).rejects.toThrow(testCase.message);
      const restoreTransaction = testCase.label === "wrong run"
        ? {
          ...transaction,
          runId: `${transaction.runId}-foreign`,
          paths: packageTransactionPaths(root.target, `${transaction.runId}-foreign`),
        }
        : transaction;
      await expect(restorePackageTransaction(restoreTransaction, {
        ownerToken: transaction.ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
        requireRecoveryProof: true,
        expectedArtifactBinding: binding,
        ...(testCase.options?.(root, transaction, binding) ?? {}),
      })).rejects.toThrow(testCase.message);
      await expect(capturePackageState(root, transaction)).resolves.toEqual(before);
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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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

  it("treats only the exact regular Apple receipt as fingerprint-neutral and retains it with the displaced candidate", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-receipt-proof.json"), "receipt-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-receipt-proof-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const installedReceipt = appleReceiptPaths(root.target).receiptPath;
    await mkdir(path.dirname(installedReceipt), { recursive: true });
    await writeFile(installedReceipt, Buffer.from([0x52, 0x43, 0x50, 0x54, 0x01]), { mode: 0o644 });
    await chmod(installedReceipt, 0o644);
    const receiptFilesystem = receiptMetadataFilesystem(installedReceipt);
    const ordinaryBefore = await captureNonReceiptTree(root.target);
    const receiptBefore = await lstat(installedReceipt);

    await expect(fingerprintPath(root.target)).resolves.toBe(transaction.candidateFingerprint);
    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "committed", candidateFingerprint: binding.bundleFingerprint });

    await chmod(installedReceipt, 0o644);
    await writeFile(installedReceipt, Buffer.from([0x52, 0x43, 0x50, 0x54, 0x02, 0xff]), { mode: 0o644 });
    await chmod(installedReceipt, 0o644);
    const proof = await readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    });
    expect(proof.status).toBe("recoverable");
    expect(JSON.stringify(proof.transaction)).not.toContain("5253505402ff");

    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      faultAt: "target-displaced",
      filesystem: receiptFilesystem,
    })).rejects.toThrow("injected package transaction interruption at target-displaced");
    const displacedReceipt = appleReceiptPaths(transaction.paths.displaced).receiptPath;
    await expect(lstat(displacedReceipt)).resolves.toBeDefined();
    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "target-displaced" });

    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem: receiptFilesystem,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    const retainedCleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const retainedReceipt = appleReceiptPaths(retainedCleanupPath).receiptPath;
    const retainedBefore = await lstat(retainedReceipt);
    await expectNonReceiptTreePreserved(retainedCleanupPath, ordinaryBefore);
    await expect(lstat(retainedReceipt)).resolves.toMatchObject({ mode: receiptBefore.mode, ino: receiptBefore.ino, nlink: 1 });
    await expect(lstat(transaction.paths.journal)).resolves.toBeDefined();
    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "identity-restored" });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem: receiptFilesystem,
    });
    await expect(lstat(retainedReceipt)).resolves.toMatchObject({ ino: retainedBefore.ino, mode: retainedBefore.mode, nlink: 1 });
    await expectNonReceiptTreePreserved(retainedCleanupPath, ordinaryBefore);
  });

  it("retains a complete no-receipt rollback package without invoking disposable deletion", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-no-receipt-retention.json"), "no-receipt-retention");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-no-receipt-retention-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const ordinaryBefore = await captureNonReceiptTree(root.target);
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const disposableDeletionCandidates: string[] = [];
    const filesystem = receiptMetadataFilesystem(
      appleReceiptPaths(cleanupPath).receiptPath,
      [],
      undefined,
      async (candidate) => {
        disposableDeletionCandidates.push(candidate);
        if (candidate === cleanupPath) throw new Error("rollback package trees must not reach disposable deletion");
      },
    );

    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });

    expect(disposableDeletionCandidates).not.toContain(cleanupPath);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expectNonReceiptTreePreserved(cleanupPath, ordinaryBefore);
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(journal.retainedPackageDisposables.records).toHaveLength(1);
    expect(journal.retainedCleanup).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      path: cleanupPath,
      receiptChain: null,
      receipt: null,
      inventory: {
        schema: "MAS_PACKAGE_RECEIPT_INVENTORY v2",
        version: 2,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        entryCount: expect.any(Number),
      },
      stableAttestation: {
        schema: "MAS_PACKAGE_STABLE_ORDINARY_ATTESTATION v1",
        version: 1,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        entryCount: expect.any(Number),
      },
    });

    await rm(root.source, { recursive: true, force: true });
    const retainedRootBefore = await lstat(cleanupPath);
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });
    expect(disposableDeletionCandidates).not.toContain(cleanupPath);
    await expect(lstat(cleanupPath)).resolves.toMatchObject({ ino: retainedRootBefore.ino });
    await expectNonReceiptTreePreserved(cleanupPath, ordinaryBefore);
  });

  it("accepts the historical Resources receipt boundary and retains its opaque bytes", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const masElectronApp = path.join(root.source, "Contents", "Helpers", "Electron.app");
    const legacyElectronApp = path.join(root.source, "Contents", "Resources", "meetless", "runtime", "electron", "Electron.app");
    await mkdir(path.dirname(legacyElectronApp), { recursive: true });
    await rename(masElectronApp, legacyElectronApp);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-legacy-receipt-layout.json"), "legacy-receipt-layout");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-legacy-receipt-layout-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const legacyReceipt = appleReceiptPaths(root.target, "legacy").receiptPath;
    await mkdir(path.dirname(legacyReceipt), { recursive: true });
    await writeFile(legacyReceipt, Buffer.from([0x4c, 0x45, 0x47, 0x41, 0x43, 0x59]), { mode: 0o644 });
    const filesystem = receiptMetadataFilesystem(legacyReceipt);
    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "committed" });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const retainedReceipt = appleReceiptPaths(cleanupPath, "legacy").receiptPath;
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(journal.retainedCleanup.receipt.relative).toBe(
      "Contents/Resources/meetless/runtime/electron/Electron.app/Contents/_MASReceipt/receipt",
    );
    await expect(lstat(retainedReceipt)).resolves.toMatchObject({ nlink: 1 });
    expect(JSON.stringify(journal)).not.toContain("4c4547414359");
  });

  it("appends multiple rollback package disposables without overwriting an earlier retained record", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-multiple-retentions.json"), "multiple-retentions");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-multiple-retentions-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const ordinaryBefore = await captureNonReceiptTree(root.target);
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });

    const firstJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const firstRecord = firstJournal.retainedPackageDisposables.records[0];
    const secondStaging = transaction.paths.staging;
    await cp(firstRecord.path, secondStaging, { recursive: true, verbatimSymlinks: true });
    const secondOrdinaryBefore = await captureNonReceiptTree(secondStaging);
    const secondStagingInfo = await lstat(secondStaging);
    const secondJournal = {
      ...firstJournal,
      state: "target-restored",
      stagingFingerprint: transaction.candidateFingerprint,
      stagingIdentity: packageIdentityFromStat(secondStagingInfo),
    };
    await writeFile(transaction.paths.journal, `${JSON.stringify(secondJournal, null, 2)}\n`, { mode: 0o600 });

    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });

    const finalJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const retainedRecords = finalJournal.retainedPackageDisposables.records;
    expect(retainedRecords).toHaveLength(2);
    expect(retainedRecords.map((record: any) => record.source)).toEqual([
      transaction.paths.displaced,
      transaction.paths.staging,
    ]);
    expect(finalJournal.retainedCleanup).toEqual(retainedRecords[0]);
    const secondCleanupPath = packageCleanupPath(transaction.paths.staging, transaction.runId, "package staging");
    await expectNonReceiptTreePreserved(firstRecord.path, ordinaryBefore);
    await expectNonReceiptTreePreserved(secondCleanupPath, secondOrdinaryBefore);
    await expect(lstat(transaction.paths.staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");

    const firstRootBefore = await lstat(firstRecord.path);
    const secondRootBefore = await lstat(secondCleanupPath);
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    await expect(lstat(firstRecord.path)).resolves.toMatchObject({ ino: firstRootBefore.ino });
    await expect(lstat(secondCleanupPath)).resolves.toMatchObject({ ino: secondRootBefore.ino });
    await expectNonReceiptTreePreserved(firstRecord.path, ordinaryBefore);
    await expectNonReceiptTreePreserved(secondCleanupPath, secondOrdinaryBefore);
  });

  it("resumes a one-shot identity cleanup interruption beside retained package evidence", async () => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-mixed-recovery.json"), "mixed-recovery");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-mixed-recovery-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const packageCleanup = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const identityCleanup = packageCleanupPath(transaction.identityPath, transaction.runId, "package identity");
    let interruptOnce = true;
    const filesystem = {
      resolvePath: (candidate: string) => candidate,
      lstat: (candidate: string) => lstat(candidate),
      beforeDisposableRemoval: async (candidate: string) => {
        if (candidate === identityCleanup && interruptOnce) {
          interruptOnce = false;
          throw new Error("one-shot identity cleanup interruption after rename");
        }
      },
    };

    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    })).rejects.toThrow("one-shot identity cleanup interruption after rename");

    const interrupted = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(interrupted.state).toBe("target-restored");
    expect(interrupted.cleanupSource).toBe(transaction.identityPath);
    expect(interrupted.cleanupPath).toBe(identityCleanup);
    expect(interrupted.retainedPackageDisposables.records).toHaveLength(1);
    expect(interrupted.retainedPackageDisposables.records[0].path).toBe(packageCleanup);
    const retainedPackageRootBefore = await lstat(packageCleanup);
    const retainedPackageMarkerBefore = await readFile(path.join(packageCleanup, "Contents", "marker"), "utf8");
    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: transaction.target,
      identityPath: transaction.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "target-restored" });

    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(packageCleanup)).resolves.toMatchObject({ ino: retainedPackageRootBefore.ino });
    await expect(readFile(path.join(packageCleanup, "Contents", "marker"), "utf8")).resolves.toBe(retainedPackageMarkerBefore);
    const resumed = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(resumed.state).toBe("identity-restored");
    expect(resumed.cleanupSource).toBeNull();
    expect(resumed.retainedPackageDisposables.records).toHaveLength(1);

    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });
    await expect(lstat(packageCleanup)).resolves.toMatchObject({ ino: retainedPackageRootBefore.ino });
    await expect(readFile(path.join(packageCleanup, "Contents", "marker"), "utf8")).resolves.toBe(retainedPackageMarkerBefore);
  });

  it("retains a prior package backup with its own role and fingerprint and replays it idempotently", async () => {
    const { root, transaction, filesystem } = await makePriorBackupRetentionFixture();
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      filesystem,
    });

    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const record = journal.retainedPackageDisposables.records.find((candidate: any) => candidate.source === transaction.paths.backup);
    expect(record).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      source: transaction.paths.backup,
      label: "prior package backup",
      packageRole: "prior",
      packageFingerprint: transaction.previous.targetFingerprint,
    });
    const retainedRootBefore = await lstat(record.path);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");

    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      filesystem,
    });
    await expect(lstat(record.path)).resolves.toMatchObject({ ino: retainedRootBefore.ino });
    const replayed = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(replayed.retainedPackageDisposables.records).toEqual([record]);
  });

  it.each([
    ["bytes", async (record: any) => writeFile(path.join(record.path, "Contents", "marker"), "tampered prior\n"), /fingerprint no longer matches/iu],
    ["identity", async (record: any) => chmod(record.path, 0o700), /disposable root has changed type, ownership, or identity/iu],
    ["fingerprint binding", async (record: any) => {
      const journal = JSON.parse((await readFile(record.journalPath)).toString("utf8"));
      journal.retainedPackageDisposables.records[0].packageFingerprint = "0".repeat(64);
      journal.retainedCleanup.packageFingerprint = "0".repeat(64);
      await writeFile(record.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    }, /role and fingerprint|package fingerprint/iu],
    ["legacy prior schema", async (record: any) => {
      const journal = JSON.parse((await readFile(record.journalPath)).toString("utf8"));
      const legacy = {
        ...journal.retainedPackageDisposables.records[0],
        schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v1",
        version: 1,
        candidateFingerprint: journal.retainedPackageDisposables.records[0].packageFingerprint,
      };
      delete legacy.packageRole;
      delete legacy.packageFingerprint;
      delete legacy.stableAttestation;
      journal.retainedPackageDisposables.records[0] = legacy;
      journal.retainedCleanup = legacy;
      await writeFile(record.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    }, /legacy candidate-only provenance|prior package/iu],
  ] as const)("rejects prior retained-package %s drift before mutation", async (_label, mutate, message) => {
    const { root, transaction, filesystem } = await makePriorBackupRetentionFixture();
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      filesystem,
    });
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const retained = journal.retainedPackageDisposables.records[0];
    const retainedRootBefore = await lstat(retained.path);
    await mutate({ ...retained, journalPath: transaction.paths.journal });
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      filesystem,
    })).rejects.toThrow(message);
    await expect(lstat(retained.path)).resolves.toMatchObject({ ino: retainedRootBefore.ino });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("recovers exact post-EACCES receipt residue, journals provenance, and is idempotent", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const sourceReceipt = appleReceiptPaths(root.source).receiptPath;
    await mkdir(path.dirname(sourceReceipt), { recursive: true });
    await writeFile(sourceReceipt, Buffer.from([0x52, 0x45, 0x54, 0x41, 0x49, 0x4e]), { mode: 0o644 });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-receipt-residue.json"), "receipt-residue");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-receipt-residue-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      faultAt: "target-restored",
    })).rejects.toThrow("injected package transaction interruption at target-restored");

    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    await rename(transaction.paths.displaced, cleanupPath);
    await modelPartialReceiptResidue(cleanupPath);
    let interruptAfterRetentionRecord = true;
    const residueFilesystem = receiptMetadataFilesystem(appleReceiptPaths(cleanupPath).receiptPath, [
      { prefix: path.join(root.source, "Contents"), uid: 501, gid: 0, devOffset: 1 },
      { prefix: path.join(cleanupPath, "Contents"), uid: 501, gid: 80, devOffset: 2 },
    ], undefined, undefined, undefined, async (record) => {
      if (record.path === cleanupPath && interruptAfterRetentionRecord) {
        interruptAfterRetentionRecord = false;
        throw new Error("one-shot interruption after durable retained package record");
      }
    });
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    journal.cleanupPath = cleanupPath;
    journal.cleanupSource = transaction.paths.displaced;
    journal.cleanupFingerprint = transaction.candidateFingerprint;
    journal.cleanupIdentity = transaction.candidateIdentity;
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem: residueFilesystem,
    })).rejects.toThrow("one-shot interruption after durable retained package record");

    const interruptedJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(interruptedJournal.state).toBe("target-restored");
    expect(interruptedJournal.cleanupPath).toBe(cleanupPath);
    expect(interruptedJournal.cleanupSource).toBe(transaction.paths.displaced);
    expect(interruptedJournal.retainedPackageDisposables.records).toHaveLength(1);
    expect(interruptedJournal.retainedPackageDisposables.records[0].path).toBe(cleanupPath);
    const ordinaryBefore = await captureNonReceiptTree(cleanupPath);
    const retainedRootBefore = await lstat(cleanupPath);
    const receiptBefore = await lstat(appleReceiptPaths(cleanupPath).receiptPath);

    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: residueFilesystem,
    })).resolves.toMatchObject({ status: "recoverable", state: "target-restored" });

    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem: residueFilesystem,
    });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNonReceiptTreePreserved(cleanupPath, ordinaryBefore);
    await expect(lstat(cleanupPath)).resolves.toMatchObject({ ino: retainedRootBefore.ino, mode: retainedRootBefore.mode, nlink: retainedRootBefore.nlink });
    await expect(lstat(appleReceiptPaths(cleanupPath).receiptPath)).resolves.toMatchObject({ ino: receiptBefore.ino, mode: receiptBefore.mode, nlink: receiptBefore.nlink });
    const retainedJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(retainedJournal.state).toBe("identity-restored");
    expect(retainedJournal.cleanupPath).toBeNull();
    expect(retainedJournal.cleanupSource).toBeNull();
    expect(retainedJournal.retainedCleanup).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      source: transaction.paths.displaced,
      path: cleanupPath,
      packageRole: "candidate",
      packageFingerprint: transaction.candidateFingerprint,
      inventory: {
        schema: "MAS_PACKAGE_RECEIPT_INVENTORY v2",
        version: 2,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        entryCount: expect.any(Number),
      },
    });
    expect(retainedJournal.retainedCleanup.inventory).not.toHaveProperty("entries");
    expect(retainedJournal.retainedPackageDisposables.records).toHaveLength(1);
    expect(JSON.stringify(retainedJournal)).not.toContain("52455441494e");

    await rm(root.source, { recursive: true, force: true });
    const beforeIdempotent = await lstat(appleReceiptPaths(cleanupPath).receiptPath);
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem: residueFilesystem,
    });
    await expect(lstat(appleReceiptPaths(cleanupPath).receiptPath)).resolves.toMatchObject({
      ino: beforeIdempotent.ino,
      mode: beforeIdempotent.mode,
      nlink: 1,
    });
    await expect(lstat(transaction.paths.journal)).resolves.toBeDefined();
  });

  it("rejects a retained package plus an extra cleanup collision before recovery mutation", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-retained-collision.json"), "retained-collision");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-retained-collision-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });

    const journalBefore = await readFile(transaction.paths.journal);
    const journal = JSON.parse(journalBefore.toString("utf8"));
    const retained = journal.retainedPackageDisposables.records[0];
    const retainedBefore = await lstat(retained.path);
    const extraCollision = packageCleanupPath(transaction.paths.staging, transaction.runId, "package staging");
    await mkdir(extraCollision, { recursive: true });
    await writeFile(path.join(extraCollision, "unexpected"), "foreign cleanup collision\n");
    const runtimeBefore = await captureNonReceiptTree(root.root);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    };

    await expect(readPackageRecoveryProof(proofInput)).rejects.toMatchObject({ code: "MAS-GATE-CLEANUP-001" });
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    })).rejects.toThrow(/unexpected cleanup collision for package staging/);
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expectNonReceiptTreePreserved(root.root, runtimeBefore);
    await expect(lstat(retained.path)).resolves.toMatchObject({ ino: retainedBefore.ino });
    await expect(lstat(extraCollision)).resolves.toBeDefined();
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("rejects a retained package, pending identity, and extra cleanup collision before recovery mutation", async () => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-retained-identity-collision.json"), "retained-identity-collision");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-retained-identity-collision-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const identityCleanup = packageCleanupPath(transaction.identityPath, transaction.runId, "package identity");
    let interruptOnce = true;
    const filesystem = {
      resolvePath: (candidate: string) => candidate,
      lstat: (candidate: string) => lstat(candidate),
      beforeDisposableRemoval: async (candidate: string) => {
        if (candidate === identityCleanup && interruptOnce) {
          interruptOnce = false;
          throw new Error("one-shot pending identity cleanup interruption");
        }
      },
    };
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    })).rejects.toThrow("one-shot pending identity cleanup interruption");

    const journalBefore = await readFile(transaction.paths.journal);
    const journal = JSON.parse(journalBefore.toString("utf8"));
    expect(journal.retainedPackageDisposables.records).toHaveLength(1);
    expect(journal.cleanupSource).toBe(transaction.identityPath);
    const retained = journal.retainedPackageDisposables.records[0];
    const retainedBefore = await lstat(retained.path);
    const identityCleanupBefore = await lstat(identityCleanup);
    const extraCollision = packageCleanupPath(transaction.paths.staging, transaction.runId, "package staging");
    await mkdir(extraCollision, { recursive: true });
    await writeFile(path.join(extraCollision, "unexpected"), "foreign cleanup collision\n");
    const runtimeBefore = await captureNonReceiptTree(root.root);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    };

    await expect(readPackageRecoveryProof(proofInput)).rejects.toMatchObject({ code: "MAS-GATE-CLEANUP-001" });
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    })).rejects.toThrow(/unexpected cleanup collision for package staging/);
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expectNonReceiptTreePreserved(root.root, runtimeBefore);
    await expect(lstat(retained.path)).resolves.toMatchObject({ ino: retainedBefore.ino });
    await expect(lstat(identityCleanup)).resolves.toMatchObject({ ino: identityCleanupBefore.ino });
    await expect(lstat(extraCollision)).resolves.toBeDefined();
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("upgrades a late receipt only after durable provenance and replays after a crash", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-late-receipt.json"), "late-receipt");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-late-receipt-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    let interruptAfterRetentionRecord = true;
    const initialFilesystem = receiptMetadataFilesystem(
      appleReceiptPaths(cleanupPath).receiptPath,
      [],
      undefined,
      undefined,
      undefined,
      async (record) => {
        if (record.path === cleanupPath && interruptAfterRetentionRecord) {
          interruptAfterRetentionRecord = false;
          throw new Error("one-shot interruption after durable no-receipt package record");
        }
      },
    );
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      filesystem: initialFilesystem,
    })).rejects.toThrow("one-shot interruption after durable no-receipt package record");

    const journalBefore = await readFile(transaction.paths.journal);
    const journal = JSON.parse(journalBefore.toString("utf8"));
    expect(journal.state).toBe("target-restored");
    expect(journal.cleanupPath).toBe(cleanupPath);
    expect(journal.cleanupSource).toBe(transaction.paths.displaced);
    const retained = journal.retainedPackageDisposables.records[0];
    const retainedRootBefore = await lstat(retained.path);
    const receiptPath = appleReceiptPaths(retained.path).receiptPath;
    let lateReceiptInjected = false;
    let interruptAfterUpgradeWrite = true;
    const receiptFilesystem = receiptMetadataFilesystem(
      receiptPath,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      async (records) => {
        if (records.some((record) => record.path === retained.path) && interruptAfterUpgradeWrite) {
          interruptAfterUpgradeWrite = false;
          throw new Error("one-shot interruption after durable late-receipt upgrade");
        }
      },
      async (pending) => {
        if (pending.path !== retained.path || lateReceiptInjected) return;
        lateReceiptInjected = true;
        await mkdir(path.dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, Buffer.from([0x4c, 0x41, 0x54, 0x45, 0x52, 0x43, 0x50, 0x54]), { mode: 0o644 });
      },
    );
    const ordinaryBefore = await captureNonReceiptTree(retained.path);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    };

    const proof = await readPackageRecoveryProof(proofInput);
    expect(proof).toMatchObject({
      status: "recoverable",
      state: "target-restored",
      retainedPackageUpgrades: [],
    });
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    })).rejects.toThrow("one-shot interruption after durable late-receipt upgrade");
    const upgradedJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(upgradedJournal.state).toBe("target-restored");
    expect(upgradedJournal.cleanupPath).toBe(cleanupPath);
    expect(upgradedJournal.retainedPackageDisposables.records[0]).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3",
      receiptChain: expect.any(Array),
      receipt: { relative: "Contents/Helpers/Electron.app/Contents/_MASReceipt/receipt" },
    });
    expect(upgradedJournal.retainedCleanup).toEqual(upgradedJournal.retainedPackageDisposables.records[0]);
    expect(upgradedJournal.cleanupPath).toBe(cleanupPath);
    expect(upgradedJournal.cleanupSource).toBe(transaction.paths.displaced);
    await expect(lstat(root.identityPath)).resolves.toBeDefined();
    await expectNonReceiptTreePreserved(retained.path, ordinaryBefore);
    await expect(lstat(retained.path)).resolves.toMatchObject({ ino: retainedRootBefore.ino });
    const receiptBefore = await lstat(receiptPath);
    await expect(lstat(receiptPath)).resolves.toMatchObject({ ino: receiptBefore.ino, mode: receiptBefore.mode, nlink: receiptBefore.nlink });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");

    await recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    });
    const replayedJournal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(replayedJournal.state).toBe("identity-restored");
    expect(replayedJournal.cleanupPath).toBeNull();
    expect(replayedJournal.retainedPackageDisposables.records[0]).toEqual(upgradedJournal.retainedPackageDisposables.records[0]);
    await expect(lstat(root.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNonReceiptTreePreserved(retained.path, ordinaryBefore);
    await expect(lstat(receiptPath)).resolves.toMatchObject({ ino: receiptBefore.ino, mode: receiptBefore.mode, nlink: receiptBefore.nlink });
  });

  it.each([
    ["bytes", async (retainedPath: string, journalPath: string) => {
      await writeFile(path.join(retainedPath, "Contents", "marker"), "late ordinary mutation\n");
    }],
    ["path", async (retainedPath: string, journalPath: string) => {
      await writeFile(path.join(retainedPath, "ordinary-added-after-retention"), "added ordinary path\n");
    }],
    ["mode", "mode"],
    ["uid", "uid"],
    ["gid", "gid"],
    ["dev", "dev"],
    ["ino", "ino"],
    ["nlink", "nlink"],
    ["size", "size"],
    ["stable digest", async (_retainedPath: string, journalPath: string) => {
      const journal = JSON.parse((await readFile(journalPath)).toString("utf8"));
      const record = journal.retainedPackageDisposables.records[0];
      record.stableAttestation.digest = "0".repeat(64);
      journal.retainedCleanup = record;
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    }],
    ["stable entry count", async (_retainedPath: string, journalPath: string) => {
      const journal = JSON.parse((await readFile(journalPath)).toString("utf8"));
      const record = journal.retainedPackageDisposables.records[0];
      record.inventory.entryCount += 1;
      journal.retainedCleanup = record;
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    }],
  ] as const)("fails closed before mutation when late-receipt stable evidence drifts: %s", async (_label, mutation) => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-late-receipt-negative-${_label.replaceAll(" ", "-")}.json`), `late-receipt-negative-${_label}`);
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: `M7-late-receipt-negative-${_label.replaceAll(" ", "-")}`,
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const retained = journal.retainedPackageDisposables.records[0];
    const receiptPath = appleReceiptPaths(retained.path).receiptPath;
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, "opaque late receipt fixture\n", { mode: 0o600 });
    const ordinaryPath = path.join(retained.path, "Contents", "marker");
    const filesystem = typeof mutation === "string"
      ? ordinaryMetadataDriftFilesystem(receiptPath, ordinaryPath, mutation)
      : receiptMetadataFilesystem(receiptPath);
    if (typeof mutation === "function") await mutation(retained.path, transaction.paths.journal);
    const journalBefore = await readFile(transaction.paths.journal);
    const receiptBefore = await lstat(receiptPath);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    };

    await expect(readPackageRecoveryProof(proofInput)).rejects.toThrow(/stable ordinary attestation changed/);
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    })).rejects.toThrow(/stable ordinary attestation changed/);
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expect(lstat(receiptPath)).resolves.toMatchObject({ ino: receiptBefore.ino, nlink: 1 });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it.each([
    ["mode", false],
    ["uid", false],
    ["gid", false],
    ["dev", false],
    ["ino", false],
    ["nlink", true],
    ["size", true],
  ] as const)("uses directory binding for a pending retained root while handling root %s drift", async (field, passes) => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-retained-root-${field}.json`), `retained-root-${field}`);
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: `M7-retained-root-${field}-owner`,
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    let interruptAfterRecord = true;
    const initialFilesystem = {
      resolvePath: (candidate: string) => candidate,
      lstat: (candidate: string) => lstat(candidate),
      afterPackageRetentionRecordWrite: async (record: any) => {
        if (record.path === cleanupPath && interruptAfterRecord) {
          interruptAfterRecord = false;
          throw new Error("one-shot pending retained root interruption after durable record");
        }
      },
    };
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      expectedArtifactBinding: binding,
      filesystem: initialFilesystem,
    })).rejects.toThrow("one-shot pending retained root interruption after durable record");

    const journalBefore = await readFile(transaction.paths.journal);
    const journal = JSON.parse(journalBefore.toString("utf8"));
    const retained = journal.retainedPackageDisposables.records[0];
    const filesystem = retainedRootMetadataFilesystem(retained.path, field);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    };

    if (!passes) {
      await expect(readPackageRecoveryProof(proofInput)).rejects.toMatchObject({ code: "MAS-GATE-CLEANUP-001" });
      await expect(recoverPackageTransaction(transaction.paths.journal, {
        ...proofInput,
        requireRecoveryProof: true,
      })).rejects.toMatchObject({ code: "MAS-GATE-CLEANUP-001" });
      await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
      return;
    }

    await expect(readPackageRecoveryProof(proofInput)).resolves.toMatchObject({
      status: "recoverable",
      state: "target-restored",
      retainedPackageUpgrades: [],
    });
    await recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    });
    const recovered = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(recovered.cleanupPath).toBeNull();
    expect(recovered.retainedPackageDisposables.records).toHaveLength(1);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
    await expect(lstat(retained.path)).resolves.toBeDefined();
  });

  it("fails closed when a legacy v2 no-receipt record receives a late receipt", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-legacy-late-receipt.json"), "legacy-late-receipt");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-legacy-late-receipt-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });

    const journalBeforeLegacy = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const retained = journalBeforeLegacy.retainedPackageDisposables.records[0];
    const legacyRecord = {
      ...retained,
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v2",
      version: 2,
      candidateFingerprint: retained.packageFingerprint,
    };
    delete legacyRecord.packageRole;
    delete legacyRecord.packageFingerprint;
    delete legacyRecord.stableAttestation;
    journalBeforeLegacy.retainedPackageDisposables.records[0] = legacyRecord;
    journalBeforeLegacy.retainedCleanup = legacyRecord;
    await writeFile(transaction.paths.journal, `${JSON.stringify(journalBeforeLegacy, null, 2)}\n`, { mode: 0o600 });

    const receiptPath = appleReceiptPaths(retained.path).receiptPath;
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, Buffer.from([0x4c, 0x45, 0x47, 0x41, 0x43, 0x59, 0x32]), { mode: 0o644 });
    const receiptFilesystem = receiptMetadataFilesystem(receiptPath);
    const ordinaryBefore = await captureNonReceiptTree(retained.path);
    const journalBeforeRecovery = await readFile(transaction.paths.journal);
    const proofInput = {
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem: receiptFilesystem,
    };

    await expect(readPackageRecoveryProof(proofInput)).rejects.toThrow(/retained receipt provenance no longer matches/);
    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ...proofInput,
      requireRecoveryProof: true,
    })).rejects.toThrow(/retained receipt provenance no longer matches/);
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBeforeRecovery);
    await expectNonReceiptTreePreserved(retained.path, ordinaryBefore);
    await expect(lstat(receiptPath)).resolves.toMatchObject({ nlink: 1 });
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("normalizes a legacy v3 retained-cleanup scalar without dropping its provenance", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-legacy-retention.json"), "legacy-retention");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-legacy-retention-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const receiptPath = appleReceiptPaths(root.target).receiptPath;
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, Buffer.from([0x4c, 0x45, 0x47, 0x41, 0x43, 0x59]), { mode: 0o644 });
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const filesystem = receiptMetadataFilesystem(appleReceiptPaths(cleanupPath).receiptPath);
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });

    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const legacyRecord = {
      ...journal.retainedCleanup,
      schema: "MAS_PACKAGE_RECEIPT_RETENTION v3",
      version: 3,
      candidateFingerprint: journal.retainedCleanup.packageFingerprint,
    };
    delete legacyRecord.packageRole;
    delete legacyRecord.packageFingerprint;
    delete legacyRecord.stableAttestation;
    delete journal.retainedPackageDisposables;
    journal.retainedCleanup = legacyRecord;
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    const proof = await readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
      filesystem,
    });
    expect(proof.status).toBe("recoverable");
    expect(proof.transaction.retainedPackageDisposables).toMatchObject({
      schema: "MAS_PACKAGE_DISPOSABLE_RETENTION_SET v1",
      version: 1,
      records: [legacyRecord],
    });
    expect(proof.transaction.retainedCleanup).toEqual(legacyRecord);

    const retainedReceipt = appleReceiptPaths(cleanupPath).receiptPath;
    const retainedBefore = await lstat(retainedReceipt);
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      filesystem,
    });
    await expect(lstat(retainedReceipt)).resolves.toMatchObject({ ino: retainedBefore.ino, nlink: 1 });
    const onDisk = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(onDisk.retainedPackageDisposables).toBeUndefined();
    expect(onDisk.retainedCleanup).toEqual(legacyRecord);
  });

  it.each([
    ["v1", "MAS_PACKAGE_DISPOSABLE_RETENTION v1", 1],
    ["v2", "MAS_PACKAGE_DISPOSABLE_RETENTION v2", 2],
  ] as const)("reads a legacy %s candidate-only package record without treating it as prior-package evidence", async (_label, schema, version) => {
    const root = await setup({ identity: false });
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-legacy-package-retention.json"), "legacy-package-retention");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-legacy-package-retention-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    const legacyRecord = {
      ...journal.retainedPackageDisposables.records[0],
      schema,
      version,
      candidateFingerprint: journal.retainedPackageDisposables.records[0].packageFingerprint,
    };
    delete legacyRecord.packageRole;
    delete legacyRecord.packageFingerprint;
    delete legacyRecord.stableAttestation;
    delete journal.retainedPackageDisposables;
    journal.retainedCleanup = legacyRecord;
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: transaction.target,
      identityPath: transaction.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    })).resolves.toMatchObject({
      status: "recoverable",
      transaction: { retainedCleanup: legacyRecord, retainedPackageDisposables: { records: [legacyRecord] } },
    });
    await recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    const onDisk = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(onDisk.retainedPackageDisposables).toBeUndefined();
    expect(onDisk.retainedCleanup).toEqual(legacyRecord);
  });

  it("refuses finalization before mutation when any disposable is receipt-bearing", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-finalization-receipt.json"), "finalization-receipt");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-finalization-receipt-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await cp(root.source, transaction.paths.displaced, { recursive: true, verbatimSymlinks: true });
    const receipt = appleReceiptPaths(transaction.paths.displaced).receiptPath;
    await mkdir(path.dirname(receipt), { recursive: true });
    await writeFile(receipt, Buffer.from([0x46, 0x49, 0x4e, 0x41, 0x4c]), { mode: 0o644 });
    const receiptBefore = await lstat(receipt);
    const journalBefore = await readFile(transaction.paths.journal);

    await expect(finalizePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/finalization found receipt-bearing/);
    await expect(lstat(receipt)).resolves.toMatchObject({ ino: receiptBefore.ino, nlink: 1 });
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expect(lstat(transaction.paths.displaced)).resolves.toBeDefined();

    for (const state of ["finalizing", "finalized"] as const) {
      const finalizationState = { ...transaction, state };
      await expect(finalizePackageTransaction(finalizationState, {
        ownerToken: transaction.ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
      })).rejects.toThrow(/finalization found receipt-bearing/);
      await expect(lstat(receipt)).resolves.toMatchObject({ ino: receiptBefore.ino, nlink: 1 });
      await expect(lstat(transaction.paths.displaced)).resolves.toBeDefined();
    }
  });

  it("retains a receipt that appears after rename before retention attestation", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-receipt-toctou.json"), "receipt-toctou");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-receipt-toctou-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
    const receiptPath = appleReceiptPaths(cleanupPath).receiptPath;
    const ordinaryBefore = await captureNonReceiptTree(root.target);
    let beforeRetentionAttestationCalls = 0;
    const filesystem = receiptMetadataFilesystem(receiptPath, [], undefined, undefined, async (candidate) => {
      if (candidate !== cleanupPath) return;
      beforeRetentionAttestationCalls += 1;
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, Buffer.from([0x54, 0x4f, 0x43, 0x54, 0x4f, 0x55]), { mode: 0o644 });
    });

    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      filesystem,
    });
    await expect(lstat(receiptPath)).resolves.toMatchObject({ nlink: 1 });
    await expectNonReceiptTreePreserved(cleanupPath, ordinaryBefore);
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    expect(journal.retainedCleanup).toMatchObject({ path: cleanupPath, schema: "MAS_PACKAGE_DISPOSABLE_RETENTION v3", packageRole: "candidate", packageFingerprint: transaction.candidateFingerprint });
    expect(beforeRetentionAttestationCalls).toBe(1);
  });

  it("never deletes a cleanup disposable after the journal records receipt observation", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-receipt-sticky.json"), "receipt-sticky");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-receipt-sticky-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const cleanupPath = packageCleanupPath(transaction.target, transaction.runId, "installed package");
    await rename(transaction.target, cleanupPath);
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    journal.state = "restoring";
    journal.cleanupPath = cleanupPath;
    journal.cleanupSource = transaction.target;
    journal.cleanupFingerprint = transaction.candidateFingerprint;
    journal.cleanupIdentity = transaction.candidateIdentity;
    journal.cleanupReceiptObserved = true;
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const before = await lstat(cleanupPath);

    await expect(recoverPackageTransaction(transaction.paths.journal, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
    })).rejects.toThrow(/receipt-bearing cleanup boundary disappeared or changed before deletion resumed/);
    await expect(lstat(cleanupPath)).resolves.toMatchObject({ ino: before.ino });
    await expect(readFile(transaction.paths.journal, "utf8")).resolves.toContain('"cleanupReceiptObserved": true');
  });

  it("fails closed with the cleanup diagnostic when retained provenance is malformed", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-malformed-retention.json"), "malformed-retention");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-malformed-retention-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const receipt = appleReceiptPaths(root.target).receiptPath;
    await mkdir(path.dirname(receipt), { recursive: true });
    await writeFile(receipt, Buffer.from([0x52, 0x45, 0x54, 0x41, 0x49, 0x4e]), { mode: 0o644 });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
    journal.retainedCleanup.inventory.digest = "0".repeat(64);
    await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const journalBefore = await readFile(transaction.paths.journal);
    const error = await readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    }).then(() => null, (failure) => failure as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).code).toBe("MAS-GATE-CLEANUP-001");
    await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("rejects duplicate, missing, and unrepresented retained-package records before recovery mutation", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-retained-set-negative.json"), "retained-set-negative");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-retained-set-negative-owner",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: transaction.target,
      identityPath: transaction.identityPath,
      runtimeRootPath: root.root,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
    });
    const journalBytes = await readFile(transaction.paths.journal);
    const baseline = JSON.parse(journalBytes.toString("utf8"));
    const record = baseline.retainedPackageDisposables.records[0];
    const retainedRootBefore = await lstat(record.path);
    const cases: Array<{
      label: string;
      mutate: (journal: any) => void;
      message: RegExp;
    }> = [
      {
        label: "duplicate record",
        mutate: (journal) => { journal.retainedPackageDisposables.records = [record, record]; },
        message: /duplicate retained package source or path/,
      },
      {
        label: "missing records array",
        mutate: (journal) => { delete journal.retainedPackageDisposables.records; },
        message: /retained package disposables is malformed/,
      },
      {
        label: "legacy scalar not represented",
        mutate: (journal) => { journal.retainedPackageDisposables.records = []; },
        message: /legacy retained cleanup is not represented/,
      },
    ];

    for (const testCase of cases) {
      const journal = JSON.parse(JSON.stringify(baseline));
      testCase.mutate(journal);
      await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      const error = await readPackageRecoveryProof({
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        target: root.target,
        identityPath: root.identityPath,
        expectedArtifactBinding: binding,
        runtimeRootPath: root.root,
      }).then(() => null, (failure) => failure as Error);
      expect(error, testCase.label).toBeInstanceOf(Error);
      expect((error as Error).code, testCase.label).toBe("MAS-GATE-CLEANUP-001");
      expect((error as Error).message, testCase.label).toMatch(testCase.message);
      await expect(lstat(record.path)).resolves.toMatchObject({ ino: retainedRootBefore.ino });
      await writeFile(transaction.paths.journal, journalBytes, { mode: 0o600 });
    }
  });

  it("rejects malformed receipt residue before any recovery mutation", async () => {
    const cases: Array<{
      label: string;
      mutate: (root: PackageFixture, cleanupPath: string, transaction: any) => Promise<void>;
      message: RegExp;
    }> = [
      {
        label: "extra disposable sibling",
        mutate: async (_root, cleanupPath) => writeFile(path.join(cleanupPath, "unexpected"), "unexplained\n"),
        message: /unexpected sibling or missing path|added ordinary path|changed type, ownership, or identity/,
      },
      {
        label: "modified ordinary entry",
        mutate: async (_root, cleanupPath) => writeFile(path.join(cleanupPath, "Contents", "Resources", "branch-a", "deep", "a.txt"), "changed\n"),
        message: /changed bytes or symlink target|changed outside the exact Apple-managed receipt boundary/,
      },
      {
        label: "changed ordinary symlink",
        mutate: async (root, cleanupPath) => {
          const linkPath = path.join(cleanupPath, "Contents", "Resources", "branch-link");
          await rm(linkPath);
          await symlink("branch-b/b.txt", linkPath);
          await writeFile(path.join(root.root, "foreign-target"), "foreign\n");
        },
        message: /changed bytes or symlink target|changed outside the exact Apple-managed receipt boundary/,
      },
      {
        label: "extra receipt sibling",
        mutate: async (_root, cleanupPath) => writeFile(path.join(appleReceiptPaths(cleanupPath).receiptDirectory, "sibling"), "unexplained\n"),
        message: /Apple-managed receipt boundary|exactly one receipt leaf and no sibling/,
      },
      {
        label: "receipt symlink",
        mutate: async (root, cleanupPath) => {
          const receipt = appleReceiptPaths(cleanupPath).receiptPath;
          await rm(receipt);
          await symlink(path.join(root.root, "foreign-receipt"), receipt);
        },
        message: /Apple-managed receipt boundary|regular non-symlink/,
      },
      {
        label: "receipt hardlink",
        mutate: async (root, cleanupPath) => {
          const receipt = appleReceiptPaths(cleanupPath).receiptPath;
          const other = path.join(root.root, "receipt-hardlink-source");
          await writeFile(other, "opaque receipt fixture\n", { mode: 0o600 });
          await rm(receipt);
          await link(other, receipt);
        },
        message: /hard-link collision|regular non-symlink/,
      },
      {
        label: "wrong ownership",
        mutate: async (_root, _cleanupPath, transaction) => {
          const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
          journal.cleanupIdentity.uid = journal.cleanupIdentity.uid === 0 ? 1 : 0;
          await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
        },
        message: /wrong ownership|changed type, ownership, or identity/,
      },
      {
        label: "changed cleanup root identity",
        mutate: async (_root, cleanupPath) => chmod(cleanupPath, 0o700),
        message: /disposable root has changed type, ownership, or identity/,
      },
      {
        label: "wrong path",
        mutate: async (_root, cleanupPath, transaction) => {
          const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
          journal.cleanupPath = `${cleanupPath}-wrong`;
          await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
        },
        message: /exact deterministic sibling/,
      },
      {
        label: "missing source proof",
        mutate: async (root) => rm(root.source, { recursive: true, force: true }),
        message: /artifact-bound source is missing|unchanged-subset proof/,
      },
    ];

    for (const testCase of cases) {
      const root = await setup({ identity: false });
      await addNestedElectronFixture(root);
      const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-residue-${testCase.label.replaceAll(" ", "-")}.json`), `residue-${testCase.label}`);
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: `M7-residue-negative-${testCase.label.replaceAll(" ", "-")}`,
        runId: newPackageTransactionId(),
        inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
      });
      const receipt = appleReceiptPaths(root.target).receiptPath;
      await mkdir(path.dirname(receipt), { recursive: true });
      await writeFile(receipt, Buffer.from([0x4e, 0x45, 0x56, 0x45, 0x52]), { mode: 0o644 });
      await chmod(receipt, 0o644);
      await expect(restorePackageTransaction(transaction, {
        ownerToken: transaction.ownerToken,
        target: root.target,
        identityPath: root.identityPath,
        runtimeRootPath: root.root,
        requireRecoveryProof: true,
        expectedArtifactBinding: binding,
        faultAt: "target-restored",
      })).rejects.toThrow("injected package transaction interruption at target-restored");
      const cleanupPath = packageCleanupPath(transaction.paths.displaced, transaction.runId, "displaced package");
      await rename(transaction.paths.displaced, cleanupPath);
      await modelPartialReceiptResidue(cleanupPath);
      const journal = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
      journal.cleanupPath = cleanupPath;
      journal.cleanupSource = transaction.paths.displaced;
      journal.cleanupFingerprint = transaction.candidateFingerprint;
      journal.cleanupIdentity = transaction.candidateIdentity;
      await writeFile(transaction.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      await testCase.mutate(root, cleanupPath, transaction);
      const journalBefore = await readFile(transaction.paths.journal);
      const error = await readPackageRecoveryProof({
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        target: root.target,
        identityPath: root.identityPath,
        expectedArtifactBinding: binding,
        runtimeRootPath: root.root,
      }).then(() => null, (failure) => failure as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).code, testCase.label).toBe("MAS-GATE-CLEANUP-001");
      expect((error as Error).message, testCase.label).toMatch(testCase.message);
      await expect(readFile(transaction.paths.journal)).resolves.toEqual(journalBefore);
      await expect(lstat(root.target)).resolves.toBeDefined();
    }
  });

  it("rejects an ordinary candidate mutation outside the Apple receipt boundary with an actionable diagnostic", async () => {
    const root = await setup({ identity: false });
    await addNestedElectronFixture(root);
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-receipt-ordinary-negative.json"), "receipt-ordinary-negative");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-receipt-ordinary-negative",
      runId: newPackageTransactionId(),
      inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    await writeFile(path.join(root.target, "Contents", "marker"), "ordinary mutation\n");

    const error = await readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    }).then(() => null, (failure) => failure as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/candidate package is missing or changed outside the exact Apple-managed receipt boundary/);
    expect((error as Error).message).toContain("Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md");
    expect((error as Error).message).toContain("Next action: restore the exact signed package and rerun MAS artifact validation");
  });

  it("rejects malformed and colliding Apple receipt boundaries without reading receipt bytes", async () => {
    const cases: Array<{
      label: string;
      mutate: (root: PackageFixture, paths: ReturnType<typeof appleReceiptPaths>) => Promise<void>;
      reason: RegExp;
    }> = [
      {
        label: "receipt under another app bundle",
        mutate: async (root) => {
          const foreignReceiptDirectory = path.join(root.target, "Contents", "Resources", "other.app", "Contents", "_MASReceipt");
          await mkdir(foreignReceiptDirectory, { recursive: true });
          await writeFile(path.join(foreignReceiptDirectory, "receipt"), Buffer.from([0x06, 0x07]), { mode: 0o600 });
        },
        reason: /outside the exact accepted nested Electron app boundary/,
      },
      {
        label: "symlinked _MASReceipt",
        mutate: async (root, paths) => symlink(path.join(root.root, "receipt-boundary-target"), paths.receiptDirectory),
        reason: /_MASReceipt must be one non-symlink directory/,
      },
      {
        label: "non-directory _MASReceipt",
        mutate: async (_root, paths) => writeFile(paths.receiptDirectory, Buffer.from([0x01, 0x02])),
        reason: /_MASReceipt must be one non-symlink directory/,
      },
      {
        label: "symlinked receipt leaf",
        mutate: async (root, paths) => {
          await mkdir(paths.receiptDirectory, { recursive: true });
          await symlink(path.join(root.root, "receipt-leaf-target"), paths.receiptPath);
        },
        reason: /receipt leaf must be one regular non-symlink file/,
      },
      {
        label: "non-regular receipt leaf",
        mutate: async (_root, paths) => {
          await mkdir(paths.receiptPath, { recursive: true });
        },
        reason: /receipt leaf must be one regular non-symlink file/,
      },
      {
        label: "unexpected receipt sibling",
        mutate: async (_root, paths) => {
          await mkdir(paths.receiptDirectory, { recursive: true });
          await writeFile(paths.receiptPath, Buffer.from([0x03, 0x04]), { mode: 0o600 });
          await writeFile(path.join(paths.receiptDirectory, "unexpected-sibling"), Buffer.from([0x05]), { mode: 0o600 });
        },
        reason: /exactly one regular receipt leaf and no sibling or nested entry/,
      },
      {
        label: "fixed and historical receipt boundaries",
        mutate: async (root, paths) => {
          const legacy = appleReceiptPaths(root.target, "legacy");
          await mkdir(legacy.receiptDirectory, { recursive: true });
          await writeFile(legacy.receiptPath, Buffer.from([0x08, 0x09]), { mode: 0o600 });
          await mkdir(paths.receiptDirectory, { recursive: true });
          await writeFile(paths.receiptPath, Buffer.from([0x0a, 0x0b]), { mode: 0o600 });
        },
        reason: /both the fixed MAS and historical Apple receipt boundaries/,
      },
    ];

    for (const testCase of cases) {
      const root = await setup({ identity: false });
      await addNestedElectronFixture(root);
      const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-${testCase.label.replaceAll(" ", "-")}.json`), `receipt-${testCase.label}`);
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: `M7-receipt-negative-${testCase.label.replaceAll(" ", "-")}`,
        runId: newPackageTransactionId(),
        inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
      });
      const paths = appleReceiptPaths(root.target);
      await testCase.mutate(root, paths);

      const error = await readPackageRecoveryProof({
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        target: root.target,
        identityPath: root.identityPath,
        expectedArtifactBinding: binding,
        runtimeRootPath: root.root,
      }).then(() => null, (failure) => failure as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(testCase.reason);
      expect((error as Error).message).toContain("Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md");
      expect((error as Error).message).toContain("Next action: restore the exact signed package and rerun MAS artifact validation");
      expect((error as Error).message).not.toContain("5253505402ff");
    }
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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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

  it("accepts an atomic same-content identity republication with only a changed inode for recovery", async () => {
    const root = await setup({ identity: false });
    const manifestPath = path.join(root.root, "app-store-development-rollback-proof.json");
    const binding = await makeBinding(root.source, manifestPath, "test-public-sdk-key-rollback-proof");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-package-proof-rollback",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
      artifactBinding: binding,
    });
    const identityBytes = await readFile(root.identityPath);
    const originalIdentity = await lstat(root.identityPath);
    const replacement = `${root.identityPath}.native-republication`;
    await writeFile(replacement, identityBytes, { mode: 0o600 });
    await rename(replacement, root.identityPath);
    const republishedIdentity = await lstat(root.identityPath);
    expect(republishedIdentity.ino).not.toBe(originalIdentity.ino);

    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath: root.identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    })).resolves.toMatchObject({ status: "recoverable", state: "committed" });
    await expect(restorePackageTransaction(transaction, {
      ownerToken: transaction.ownerToken,
      target: root.target,
      identityPath: root.identityPath,
      requireArtifactBinding: true,
      requireRecoveryProof: true,
      expectedArtifactBinding: binding,
      runtimeRootPath: root.root,
    })).resolves.toBeDefined();
    await expect(readFile(path.join(root.target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
  });

  it("rejects a symlinked identity ancestry even when bytes and leaf metadata still match", async () => {
    const root = await setup({ identity: false });
    const runtimeRoot = path.join(root.root, "runtime");
    const identityPath = path.join(runtimeRoot, "identity.json");
    await mkdir(runtimeRoot, { mode: 0o700 });
    const fixture = { ...root, root: runtimeRoot, identityPath };
    const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-symlink-ancestry.json"), "symlink-ancestry");
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath,
      ownerToken: "M7-package-proof-symlink-ancestry",
      runId: newPackageTransactionId(),
      inspect: async (bundlePath: string) => makePublishedHostIdentity(fixture, bundlePath),
      artifactBinding: binding,
      runtimeRootPath: runtimeRoot,
    });
    const realRuntimeRoot = path.join(root.root, "runtime-real");
    await rename(runtimeRoot, realRuntimeRoot);
    await symlink(realRuntimeRoot, runtimeRoot);

    await expect(readPackageRecoveryProof({
      ownerToken: transaction.ownerToken,
      runId: transaction.runId,
      target: root.target,
      identityPath,
      expectedArtifactBinding: binding,
      runtimeRootPath: runtimeRoot,
    })).rejects.toThrow(/symlink ancestor/);
  });

  it.each(["uid", "gid", "mode", "dev", "nlink", "size"] as const)(
    "rejects same-content republication when %s also differs from the journaled identity",
    async (field) => {
      const root = await setup({ identity: false });
      const binding = await makeBinding(root.source, path.join(root.root, `app-store-development-${field}.json`), `metadata-${field}`);
      const transaction = await replacePackageBundle({
        source: root.source,
        target: root.target,
        identityPath: root.identityPath,
        ownerToken: `M7-package-proof-${field}`,
        runId: newPackageTransactionId(),
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
        artifactBinding: binding,
      });
      const replacement = `${root.identityPath}.native-republication`;
      await writeFile(replacement, await readFile(root.identityPath), { mode: 0o600 });
      await rename(replacement, root.identityPath);
      const record = JSON.parse((await readFile(transaction.paths.journal)).toString("utf8"));
      record.identityPublishedIdentity[field] += 1;
      await writeFile(transaction.paths.journal, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

      await expect(readPackageRecoveryProof({
        ownerToken: transaction.ownerToken,
        runId: transaction.runId,
        target: root.target,
        identityPath: root.identityPath,
        expectedArtifactBinding: binding,
        runtimeRootPath: root.root,
      })).rejects.toThrow(/published identity.*bytes, digest, or metadata/);
    },
  );

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
      inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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
        inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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
          inspect: async (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
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

async function makePriorBackupRetentionFixture() {
  const root = await setup({ identity: false });
  const binding = await makeBinding(root.source, path.join(root.root, "app-store-development-prior-backup-retention.json"), "prior-backup-retention");
  const transaction = await replacePackageBundle({
    source: root.source,
    target: root.target,
    identityPath: root.identityPath,
    ownerToken: "M7-prior-backup-retention-owner",
    runId: newPackageTransactionId(),
    inspect: (bundlePath: string) => makePublishedHostIdentity(root, bundlePath),
    artifactBinding: binding,
  });
  // Model the only useful way to exercise the defensive duplicate-backup
  // branch: the target contains prior bytes while the transaction-owned backup
  // still exists. The adapter projects the target root identity to the
  // journaled prior identity so the fixture remains an authorized collision
  // scenario, not a foreign package.
  await rm(transaction.target, { recursive: true, force: true });
  await cp(transaction.paths.backup, transaction.target, { recursive: true, verbatimSymlinks: true });
  transaction.state = "restoring";
  return { root, transaction, filesystem: priorBackupIdentityFilesystem(transaction) };
}

type PackageFixture = {
  root: string;
  source: string;
  target: string;
  identityPath: string;
};

function appleReceiptPaths(bundlePath: string, layout: "mas" | "legacy" = "mas") {
  const electronContents = layout === "legacy"
    ? path.join(
      bundlePath,
      "Contents",
      "Resources",
      "meetless",
      "runtime",
      "electron",
      "Electron.app",
      "Contents",
    )
    : path.join(bundlePath, "Contents", "Helpers", "Electron.app", "Contents");
  const receiptDirectory = path.join(electronContents, "_MASReceipt");
  return {
    electronContents,
    receiptDirectory,
    receiptPath: path.join(receiptDirectory, "receipt"),
  };
}

function packageCleanupPath(candidate: string, runId: string, label: string) {
  const suffix = createHash("sha256").update(`${candidate}\0${label}`).digest("hex").slice(0, 16);
  return `${candidate}.m7-cleanup-${runId}-${suffix}`;
}

function packageIdentityFromStat(info: any) {
  return {
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special",
    mode: Number(info.mode),
    uid: Number(info.uid),
    gid: Number(info.gid),
    dev: Number(info.dev),
    ino: Number(info.ino),
    nlink: Number(info.nlink),
    size: Number(info.size),
  };
}

function priorBackupIdentityFilesystem(transaction: any) {
  const priorIdentity = transaction.previous.targetIdentity;
  return {
    resolvePath: (candidate: string) => candidate,
    lstat: async (candidate: string) => {
      const info = await lstat(candidate);
      if (candidate !== transaction.target) return info;
      Object.defineProperties(info, Object.fromEntries(
        ["mode", "uid", "gid", "dev", "ino", "nlink", "size"].map((field) => [field, { value: priorIdentity[field], enumerable: true }]),
      ));
      return info;
    },
  };
}

async function modelPartialReceiptResidue(root: string) {
  // Model a real interrupted recursive cleanup: remove one ordinary file,
  // while leaving unrelated ordinary sibling branches and the receipt tree.
  await rm(path.join(root, "Contents", "marker"), { force: true });
  await rm(path.join(root, "ordinary-sibling-a"), { recursive: true, force: true });
}

async function addNestedElectronFixture(root: PackageFixture) {
  const paths = appleReceiptPaths(root.source);
  await mkdir(paths.electronContents, { recursive: true });
  await writeFile(path.join(paths.electronContents, "ordinary"), "nested ordinary resource\n");
  const resources = path.join(root.source, "Contents", "Resources");
  await mkdir(path.join(resources, "branch-a", "deep"), { recursive: true });
  await mkdir(path.join(resources, "branch-b"), { recursive: true });
  await mkdir(path.join(resources, "branch-c"), { recursive: true });
  await writeFile(path.join(resources, "branch-a", "deep", "a.txt"), "branch-a\n");
  await writeFile(path.join(resources, "branch-b", "b.txt"), "branch-b\n");
  await writeFile(path.join(resources, "branch-c", "c.txt"), "branch-c\n");
  await symlink("branch-a/deep/a.txt", path.join(resources, "branch-link"));
  await mkdir(path.join(root.root, "ordinary-sibling-a"), { recursive: true });
  await mkdir(path.join(root.root, "ordinary-sibling-b"), { recursive: true });
  await writeFile(path.join(root.root, "ordinary-sibling-a", "a.txt"), "side-a\n");
  await writeFile(path.join(root.root, "ordinary-sibling-b", "b.txt"), "side-b\n");
  return paths;
}

function receiptMetadataFilesystem(receiptPath: string, metadataPrefixes: Array<{
  prefix: string;
  uid: number;
  gid: number;
  devOffset: number;
}> = [], onLstat?: (candidate: string, call: number) => Promise<void>, beforeDisposableRemoval?: (candidate: string) => Promise<void>, beforePackageRetentionAttestation?: (candidate: string) => Promise<void>, afterPackageRetentionRecordWrite?: (record: any) => Promise<void>, afterPackageRetentionUpgradeWrite?: (records: any[]) => Promise<void>, beforePendingRetainedInspection?: (record: any) => Promise<void>) {
  let lstatCall = 0;
  return {
    resolvePath: (candidate: string) => candidate,
    lstat: async (candidate: string) => {
      lstatCall += 1;
      await onLstat?.(candidate, lstatCall);
      const info = await lstat(candidate);
      const metadata = metadataPrefixes.find(({ prefix }) => candidate === prefix || candidate.startsWith(`${prefix}${path.sep}`));
      if (metadata) {
        Object.defineProperties(info, {
          uid: { value: metadata.uid, enumerable: true },
          gid: { value: metadata.gid, enumerable: true },
          dev: { value: info.dev + metadata.devOffset, enumerable: true },
        });
      }
      if (candidate === receiptPath || candidate.endsWith(path.join("_MASReceipt", "receipt"))) {
        // Model Apple/root ownership without requiring chown in the fixture.
        Object.defineProperties(info, {
          uid: { value: 0, enumerable: true },
          gid: { value: 0, enumerable: true },
        });
      }
      return info;
    },
    beforeDisposableRemoval,
    beforePackageRetentionAttestation,
    beforePendingRetainedInspection,
    afterPackageRetentionRecordWrite,
    afterPackageRetentionUpgradeWrite,
  };
}

function ordinaryMetadataDriftFilesystem(
  receiptPath: string,
  ordinaryPath: string,
  field: "mode" | "uid" | "gid" | "dev" | "ino" | "nlink" | "size",
) {
  return {
    resolvePath: (candidate: string) => candidate,
    lstat: async (candidate: string) => {
      const info = await lstat(candidate);
      if (candidate === ordinaryPath) {
        const current = Number(info[field]);
        const value = field === "mode" ? current ^ 0o1 : current + 1;
        Object.defineProperty(info, field, { value, enumerable: true });
      }
      if (candidate === receiptPath || candidate.endsWith(path.join("_MASReceipt", "receipt"))) {
        Object.defineProperties(info, {
          uid: { value: 0, enumerable: true },
          gid: { value: 0, enumerable: true },
        });
      }
      return info;
    },
  };
}

function retainedRootMetadataFilesystem(
  retainedPath: string,
  field: "mode" | "uid" | "gid" | "dev" | "ino" | "nlink" | "size",
) {
  return {
    resolvePath: (candidate: string) => candidate,
    lstat: async (candidate: string) => {
      const info = await lstat(candidate);
      if (candidate === retainedPath) {
        const current = Number(info[field]);
        const value = field === "mode" ? current ^ 0o1 : current + 1;
        Object.defineProperty(info, field, { value, enumerable: true });
      }
      return info;
    },
  };
}

async function captureNonReceiptTree(root: string) {
  const result: Record<string, unknown> = {};
  const receiptDirectories = [
    appleReceiptPaths(root).receiptDirectory,
    appleReceiptPaths(root, "legacy").receiptDirectory,
  ];
  async function visit(candidate: string) {
    const info = await lstat(candidate);
    const relative = path.relative(root, candidate).split(path.sep).join("/") || ".";
    if (receiptDirectories.some((receiptDirectory) => candidate === receiptDirectory || candidate.startsWith(`${receiptDirectory}${path.sep}`))) return;
    const identity = {
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      dev: info.dev,
      ino: info.ino,
      nlink: info.nlink,
      size: info.size,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special",
    };
    result[relative] = {
      identity,
      bytes: info.isFile() ? (await readFile(candidate)).toString("base64") : undefined,
      target: info.isSymbolicLink() ? await readlink(candidate) : undefined,
    };
    if (info.isDirectory()) {
      for (const name of await readdir(candidate)) await visit(path.join(candidate, name));
    }
  }
  await visit(root);
  return result;
}

async function expectNonReceiptTreePreserved(root: string, expected: Record<string, any>) {
  const actual = await captureNonReceiptTree(root);
  const normalize = (tree: Record<string, any>) => Object.fromEntries(
    Object.entries(tree).map(([relative, entry]) => {
      const identity = { ...entry.identity };
      if (identity.type === "directory") {
        // Adding the receipt subtree legitimately changes ancestor directory
        // link-count/size bookkeeping; all copy-stable identity and content
        // fields remain part of the retention proof.
        delete identity.nlink;
        delete identity.size;
      }
      return [relative, { ...entry, identity }];
    }),
  );
  expect(normalize(actual)).toEqual(normalize(expected));
}

function makePublishedHostIdentity(root: PackageFixture, bundlePath: string) {
  return {
    ...identityGoldenVector,
    bundlePath,
    bundleRealPath: bundlePath,
    executablePath: path.join(bundlePath, "Contents", "MacOS", "MeetlessHost"),
    configuration: {
      ...identityGoldenVector.configuration,
      runtimeRoot: root.root,
      identityPath: root.identityPath,
    },
  };
}

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

async function capturePackageState(root: PackageFixture, transaction: any) {
  const candidates = [
    root.source,
    root.target,
    root.identityPath,
    ...Object.values(transaction.paths),
    `${root.identityPath}.m7.${transaction.runId}.identity.tmp`,
  ];
  return Promise.all(candidates.map(async (candidate) => {
    const info = await lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    return {
      candidate,
      type: info?.isDirectory() ? "directory" : info?.isFile() ? "file" : info?.isSymbolicLink() ? "symlink" : info ? "special" : null,
      fingerprint: await fingerprintPath(candidate),
      bytes: info?.isFile() ? await readFile(candidate) : null,
    };
  }));
}
