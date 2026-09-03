import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMasHostHandoff,
  inspectMasLiveState,
  installMasDevelopmentGate,
  launchMasDevelopmentGate,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  masLiveAbsentObservation,
  restoreInRequiredOrder,
  stopMasDevelopmentGate,
  validateMasHostHandoff,
} from "../../../scripts/macos-mas-development-gate.mjs";
import { beginMasGateSessionTransaction } from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";
import {
  MAS_GATE_LOCK_BASENAME,
  acquireMasGateLock,
  masGateLockPath,
  withMasGateLock,
} from "../../../scripts/lib/macos-mas-gate-lock.mjs";
import { fingerprintPath } from "../../../scripts/lib/macos-package-transaction.mjs";
import { freezeMasGateArtifactBinding } from "../../../scripts/lib/mas-gate-artifact-binding.mjs";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MAS development gate coordinator", () => {
  it("binds MAS state to the app-container contract and keeps the direct-DMG root separate", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    expect(context.runtimeRoot).toBe("/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless");
    expect(context.directRuntimeRoot).toBe("/Users/example/Library/Application Support/Meetless");
    expect(context.runtimeRoot).not.toBe(context.directRuntimeRoot);
    expect(context.identityPath).toBe(`${context.runtimeRoot}/host-identity.json`);
    expect(context.lockPath).toBe(`${context.parentPath}/${MAS_GATE_LOCK_BASENAME}`);
    expect(masGateRuntimeOptions(context, { requiredFreeBytes: 1 }).runtimeRoot).toBe(context.runtimeRoot);

    const directContract = { ...context.contract, userSupportRelativePath: "Library/Application Support/Meetless" };
    expect(() => masDevelopmentRuntimeContext({ userHome: "/Users/example", contract: directContract })).toThrow(/exact macAppStoreInstallationContract/);
  });

  it("returns only an exact absent observation and rejects malformed process/listener evidence", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const empty = {
      processRows: async () => [{ pid: 1, ppid: 0, executablePath: "/sbin/launchd", arguments: ["/sbin/launchd"] }],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    await expect(inspectMasLiveState(context, empty)).resolves.toEqual(masLiveAbsentObservation(context));

    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => undefined,
    })).rejects.toThrow(/complete process list/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "/usr/bin/tool", arguments: null }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      processRows: async () => [{ pid: 42, ppid: 1, executablePath: "", arguments: [] }],
    })).rejects.toThrow(/malformed process evidence/);
    await expect(inspectMasLiveState(context, {
      ...empty,
      listeners: async () => undefined,
    })).rejects.toThrow(/listener inspection returned malformed/);
  });

  it("does not use command substrings, but detects exact owned descendants, listeners, sockets, and handles", async () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const base = {
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
    };
    const substringOnly = {
      pid: 42,
      ppid: 1,
      executablePath: "/usr/bin/tool",
      arguments: ["/usr/bin/tool", `prefix${context.runtimeRoot}suffix`],
    };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [substringOnly] })).resolves.toMatchObject({ status: "absent" });

    const descendant = { ...substringOnly, arguments: ["/usr/bin/tool", `${context.runtimeRoot}/nested-state`] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [descendant] })).resolves.toMatchObject({
      status: "live",
      processes: [descendant],
    });

    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    await expect(inspectMasLiveState(context, { ...base, processRows: async () => [host] })).resolves.toMatchObject({ status: "live" });
    for (const row of [
      { pid: 44, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "desktop"] },
      { pid: 45, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.runtimeCliPath, "daemon"] },
      { pid: 46, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.daemonWorkerPath, "daemon"] },
      { pid: 47, ppid: 45, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, context.packagePaths.pluginPath] },
      { pid: 48, ppid: 43, executablePath: context.packagePaths.captureHelperPath, arguments: [context.packagePaths.captureHelperPath] },
    ]) {
      await expect(inspectMasLiveState(context, { ...base, processRows: async () => [row] })).resolves.toMatchObject({ status: "live", processes: [row] });
    }
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [{ pid: 49, ppid: 43, executablePath: context.packagePaths.nodePath, arguments: [context.packagePaths.nodePath, "/private/unknown-role.js"] }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      listeners: async () => [{ port: 16777 }],
    })).resolves.toMatchObject({ status: "live", listeners: [{ port: 16777 }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      sockets: async () => [{ path: context.runtimePaths.recordingSocket, type: "socket" }],
    })).resolves.toMatchObject({ status: "live" });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [],
      openHandles: async () => [{ path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ path: context.runtimeRoot }] });
    await expect(inspectMasLiveState(context, {
      ...base,
      processRows: async () => [host],
      openHandles: async () => [{ pid: host.pid, path: context.runtimeRoot }],
    })).resolves.toMatchObject({ status: "live", openHandles: [{ pid: host.pid, path: context.runtimeRoot }] });
  });

  it("uses one stable kernel lock and rejects contention until the holder releases", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lock-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });
    const first = await acquireMasGateLock({ parentPath: parent });
    expect(first.lockPath).toBe(masGateLockPath(parent));
    await expect(acquireMasGateLock({ parentPath: parent })).rejects.toThrow(/MAS gate lock failed/);
    await first.release();
    const second = await acquireMasGateLock({ parentPath: parent });
    await second.release();
    await expect(lstat(masGateLockPath(parent))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("requires a live kernel-holder assertion for every supplied lease", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-lease-test-")));
    roots.push(base);
    const parent = path.join(base, "support");
    await mkdir(parent, { mode: 0o700 });

    const released = await acquireMasGateLock({ parentPath: parent });
    await released.release();
    await expect(released.assertHeld()).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: released }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|not kernel-backed/);

    const killed = await acquireMasGateLock({ parentPath: parent });
    process.kill(killed.holderPid, "SIGKILL");
    await expect(killed.assertHeld()).rejects.toThrow(/no longer held|kernel lock|holder exited/);
    await expect(withMasGateLock({ parentPath: parent, lockLease: killed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/no longer held|kernel lock|holder exited|not kernel-backed/);

    const genuine = await acquireMasGateLock({ parentPath: parent });
    expect(Object.isFrozen(genuine)).toBe(true);
    const spoofed = { ...genuine };
    await expect(withMasGateLock({ parentPath: parent, lockLease: spoofed }, async () => {
      throw new Error("filesystem operation must not run");
    })).rejects.toThrow(/not kernel-backed|live holder/);
    await genuine.release();
  });

  it("releases the gate lock before waiting for the native host to claim the durable handoff", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-launch-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const absent = masLiveAbsentObservation(context);
    const options = {
      runtimeRoot: context.runtimeRoot,
      contractRuntimeRoot: context.runtimeRoot,
      runtimeRootParent: context.parentPath,
      activePath: context.activePath,
      identityRelativePath: context.identityRelativePath,
      identityPath: context.identityPath,
      requiredFreeBytes: 1,
      assertNoLiveOwnedRuntime: async () => absent,
    };
    const session = await beginMasGateSessionTransaction(options);
    const installed = {
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
    };
    const available = createMasHostHandoff(context, session, installed);
    await writeFile(path.join(session.activePath, "host-handoff.json"), `${JSON.stringify(available)}\n`, { mode: 0o600 });
    let launchCalled = false;
    const result = await launchMasDevelopmentGate({
      context,
      dependencies: {
        processRows: async () => [],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        launch: async () => {
          launchCalled = true;
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
        },
        waitForHandoff: async () => {
          const hostLease = await acquireMasGateLock({ parentPath: context.parentPath });
          await hostLease.release();
          return { ...available, state: "claimed", claimedByPid: process.pid, claimedAt: new Date().toISOString() };
        },
      },
    });
    expect(launchCalled).toBe(true);
    expect(result.status).toBe("launch-claimed");
    expect(result.handoff.state).toBe("claimed");
  });

  it("stops only the exact owned host through the coordinator and never through an ambient authority string", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-stop-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const host = { pid: 43, ppid: 1, executablePath: context.executablePath, arguments: [context.executablePath] };
    let live = true;
    const dependencies = {
      processRows: async () => live ? [host] : [],
      listeners: async () => [],
      sockets: async () => [],
      openHandles: async () => [],
      stopProcess: async (pid: number) => {
        expect(pid).toBe(host.pid);
        live = false;
      },
      waitForProcessExit: async () => undefined,
    };
    await expect(stopMasDevelopmentGate({ context, dependencies })).resolves.toMatchObject({ status: "stopped" });

    const masRoot = context.runtimeRoot;
    const forged = await execFile(process.execPath, ["scripts/stop-macos-host.mjs"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: base,
        MEETLESS_RUNTIME_ROOT: masRoot,
        MEETLESS_LISTEN: context.contract.listen,
        MEETLESS_MAS_COORDINATOR_AUTHORITY: "MAS_GATE_COORDINATOR v1",
      },
    }).catch((error) => error);
    expect(forged.code).not.toBe(0);
    expect(`${forged.stderr ?? ""}${forged.stdout ?? ""}`).toMatch(/refuses the MAS app-container runtime root/);
  });

  it("requires the exact MAS manifest and validates it before any transaction/package mutation", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-install-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    const proofRoot = path.join(base, "proof");
    const releaseRoot = path.join(proofRoot, "release", "macos");
    const bundle = path.join(releaseRoot, "Meetless.app");
    const manifestPath = path.join(releaseRoot, "app-store-development-manifest.json");
    await mkdir(bundle, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      bundlePath: "release/macos/Meetless.app",
      directComposition: { path: "release/macos/composition-manifest.direct.json" },
    })}\n`, { mode: 0o600 });
    const prior = path.join(context.runtimeRoot, "prior.txt");
    await mkdir(context.runtimeRoot, { recursive: true });
    await writeFile(prior, "prior\n");
    let validatorCalled = false;
    await expect(installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        validateArtifact: async ({ manifestPath: receivedManifest, bundlePath: receivedBundle }: { manifestPath: string; bundlePath: string }) => {
          validatorCalled = true;
          expect(receivedManifest).toBe(manifestPath);
          expect(receivedBundle).toBe(bundle);
          throw new Error("validator rejection");
        },
      },
    })).rejects.toThrow(/validator rejection/);
    expect(validatorCalled).toBe(true);
    await expect(readFile(prior, "utf8")).resolves.toBe("prior\n");
    await expect(lstat(context.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installMasDevelopmentGate({
      manifestPath: path.join(releaseRoot, "missing.json"),
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: { validateArtifact: async () => ({ status: "passed" }) },
    })).rejects.toThrow(/MAS development manifest/);
  });

  it("passes the complete immutable binding into the runtime and package composition seams", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-binding-composition-test-")));
    roots.push(base);
    const context = masDevelopmentRuntimeContext({ userHome: base });
    await mkdir(context.parentPath, { recursive: true, mode: 0o700 });
    await mkdir(context.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(context.runtimeRoot, "opaque-state"), "preserve me\n");

    const proofRoot = path.join(base, "proof");
    const releaseRoot = path.join(proofRoot, "release", "macos");
    const bundle = path.join(releaseRoot, "Meetless.app");
    const manifestPath = path.join(releaseRoot, "app-store-development-manifest.json");
    await mkdir(bundle, { recursive: true });
    const manifestBytes = Buffer.from(JSON.stringify({
      schema: "MEETLESS_MAC_APP_STORE_DEVELOPMENT v1",
      bundlePath: "release/macos/Meetless.app",
      directComposition: { path: "release/macos/composition-manifest.direct.json" },
    }));
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const bundleFingerprint = await fingerprintPath(bundle);
    if (!bundleFingerprint) throw new Error("binding fixture bundle fingerprint is missing");
    const publicKey = "test-public-sdk-key-not-crossing-the-boundary";
    const artifactBinding = freezeMasGateArtifactBinding({
      schema: "MAS_GATE_ARTIFACT_BINDING v1",
      version: 1,
      manifestPath,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      bundlePath: bundle,
      bundleFingerprint,
      artifactDigest: "a".repeat(64),
      candidateSnapshotDigest: "b".repeat(64),
      packageInputDigest: "c".repeat(64),
      artifactInputDigest: "d".repeat(64),
      licenseDigest: "e".repeat(64),
      signatureDigest: "f".repeat(64),
      publicSdkKeySha256: createHash("sha256").update(publicKey).digest("hex"),
    });
    const installed = {
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
    };
    let packageInput: Record<string, unknown> | null = null;
    const result = await installMasDevelopmentGate({
      manifestPath,
      bundlePath: bundle,
      requiredFreeBytes: 1,
      context,
      dependencies: {
        processRows: async () => [],
        listeners: async () => [],
        sockets: async () => [],
        openHandles: async () => [],
        validateArtifact: async () => ({ status: "passed", artifactBinding }),
        inspectBundle: async () => installed,
        replacePackageBundle: async (input: Record<string, unknown>) => {
          packageInput = input;
          return { schema: "MAS_PACKAGE_TRANSACTION v4", version: 4, artifactBinding: input.artifactBinding };
        },
      },
    });

    expect(result.status).toBe("installed");
    expect(result.session.schema).toBe("MAS_GATE_SESSION_TRANSACTION v2");
    expect(packageInput?.artifactBinding).toBe(result.packageTransaction.artifactBinding);
    expect(Object.isFrozen(packageInput?.artifactBinding)).toBe(true);
    expect(JSON.stringify(packageInput)).not.toContain(publicKey);
    await expect(readFile(path.join(context.runtimeRoot, "opaque-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(result.session.quarantinePath, "opaque-state"), "utf8")).resolves.toBe("preserve me\n");
  });

  it("binds a one-time host handoff to the owner, run, fresh-root identity, exact bundle, and exact executable", () => {
    const context = masDevelopmentRuntimeContext({ userHome: "/Users/example" });
    const session = {
      phase: "ready",
      stateScope: "runtime-root-only",
      ownerToken: "owner-token-abcdefghijklmnopqrstuvwxyz-0123456789",
      runId: "run-1",
      canonicalRuntimeRoot: context.runtimeRoot,
      parentPath: context.parentPath,
      activePath: context.activePath,
      identityRelativePath: context.identityRelativePath,
      identityPath: context.identityPath,
      freshRootIdentity: {
        type: "directory",
        mode: 448,
        uid: 501,
        gid: 20,
        dev: 1,
        ino: 2,
        nlink: 2,
        size: 0,
      },
    };
    const installed = {
      bundleIdentifier: context.contract.bundleIdentifier,
      bundlePath: context.bundlePath,
      bundleRealPath: context.bundlePath,
      executablePath: context.executablePath,
      designatedRequirement: "identifier \\\"com.meetless.app\\\"",
      cdHash: "a".repeat(40),
      binarySha256: "b".repeat(64),
      binaryDevice: 1,
      binaryInode: 3,
      binarySize: 10,
    };
    const handoff = createMasHostHandoff(context, session, installed);
    expect(validateMasHostHandoff(handoff, { context, session })).toBe(handoff);
    for (const change of [
      { ownerToken: "other-owner" },
      { canonicalRuntimeRoot: `${context.runtimeRoot}-other` },
      { bundlePath: `${context.bundlePath}-other` },
      { bundleIdentifier: "other.bundle" },
    ]) {
      expect(() => validateMasHostHandoff({ ...handoff, ...change }, { context, session })).toThrow(/not bound/);
    }
    const replay = { ...handoff, state: "claimed", claimedByPid: 99, claimedAt: new Date().toISOString() };
    expect(() => validateMasHostHandoff(replay, { context, session })).toThrow(/not bound/);
    expect(validateMasHostHandoff(replay, { context, session, state: "claimed" })).toBe(replay);
  });

  it("keeps restore ordering package-first and releases the reacquired lock last", async () => {
    const events: string[] = [];
    const lease = { release: async () => { events.push("release"); } };
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "ready-for-runtime-restore" }; },
      reacquireGateLock: async () => { events.push("lock"); return lease; },
      runtimeRestore: async () => { events.push("runtime-restore"); return { phase: "restored" }; },
      archiveSession: async () => { events.push("archive"); return { phase: "archived" }; },
    });
    expect(result.status).toBe("restored");
    expect(events).toEqual(["stop", "package-rollback", "lock", "runtime-restore", "archive", "release"]);
  });

  it("does not reacquire or mutate anything when stop proves no active session", async () => {
    const events: string[] = [];
    const result = await restoreInRequiredOrder({
      stop: async () => { events.push("stop"); return { status: "stopped" }; },
      rollbackPackage: async () => { events.push("package-rollback"); return { status: "nothing-to-restore", observation: masLiveAbsentObservation(masDevelopmentRuntimeContext({ userHome: "/Users/example" })) }; },
      reacquireGateLock: async () => { events.push("lock"); throw new Error("must not acquire"); },
      runtimeRestore: async () => { events.push("runtime"); return {}; },
      archiveSession: async () => { events.push("archive"); return {}; },
    });
    expect(result.status).toBe("nothing-to-restore");
    expect(events).toEqual(["stop", "package-rollback"]);
  });

});
