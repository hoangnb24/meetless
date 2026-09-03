import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMasHostHandoff,
  inspectMasLiveState,
  launchMasDevelopmentGate,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  masLiveAbsentObservation,
  restoreInRequiredOrder,
  validateMasHostHandoff,
} from "../../../scripts/macos-mas-development-gate.mjs";
import { beginMasGateSessionTransaction } from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";
import {
  MAS_GATE_LOCK_BASENAME,
  acquireMasGateLock,
  masGateLockPath,
} from "../../../scripts/lib/macos-mas-gate-lock.mjs";

const roots: string[] = [];

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
