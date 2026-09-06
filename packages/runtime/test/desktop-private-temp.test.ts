import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  allocateMacChromiumTemp,
  buildElectronSpawnOptions,
  cleanupMeetlessDesktopForTest,
  copyEnvironmentWithoutMacChromiumTmpDir,
  desktopChildEnvironment,
  isMacAppStoreDesktop,
  MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES,
  spawnMeetlessElectron,
  spawnMeetlessElectronWithMacChromiumTemp,
  shutdownOwnedRuntimeAndReleaseMacChromiumTemp,
  type MacChromiumTempAllocation,
} from "../src/desktop.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MAS Chromium private temp allocation", () => {
  test("derives canonical Data/tmp, allocates distinct private children, and preserves existing data", async () => {
    const fixture = await makeMasFixture();
    const beforeUserData = fixture.config.paths.electronUserData;
    const sentinel = path.join(fixture.tempRoot, "pre-existing");
    await mkdir(fixture.tempRoot, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "retain\n");

    const first = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    const second = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.directory).not.toBe(second!.directory);
    expect(first!.directory).toBe(path.join(fixture.tempRoot, path.basename(first!.directory)));
    expect(first!.socketPath).toBe(path.join(first!.directory, "S", "SingletonSocket"));
    expect(first!.cookiePath).toBe(path.join(first!.directory, "S", "SingletonCookie"));
    expect(Buffer.byteLength(first!.socketPath, "utf8")).toBeLessThanOrEqual(
      MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES,
    );
    expect(Buffer.byteLength(first!.cookiePath, "utf8")).toBeLessThanOrEqual(
      MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES,
    );
    expect((await lstat(first!.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(first!.directory)).isSymbolicLink()).toBe(false);
    expect(fixture.config.paths.electronUserData).toBe(beforeUserData);

    await first!.release();
    expect(await exists(first!.directory)).toBe(false);
    expect(await exists(sentinel)).toBe(true);
    await second!.release();
    expect(await exists(second!.directory)).toBe(false);
    expect(await exists(sentinel)).toBe(true);
  });

  test("rejects an untrusted temp root without following a symlink", async () => {
    const fixture = await makeMasFixture();
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(fixture.tempRoot), { recursive: true, mode: 0o700 });
    await symlink(outside, fixture.tempRoot);

    await expect(allocateMacChromiumTemp(fixture.config, new AbortController().signal))
      .rejects.toThrow(/non-symlink directory|canonical path/u);
    expect(await readdir(outside)).toEqual([]);
  });

  test("requires the packaged MAS root relation and preserves direct packaged ambient behavior", async () => {
    const fixture = await makeMasFixture();
    expect(isMacAppStoreDesktop(fixture.config)).toBe(true);

    const directRoot = path.join(fixture.root, "direct", "Library/Application Support/Meetless");
    const directPackaged = {
      ...fixture.config,
      packaged: true,
      endpoints: { ...fixture.config.endpoints, mode: "packaged" as const },
      paths: {
        ...fixture.config.paths,
        root: directRoot,
        recordingExports: path.join(directRoot, "recordings"),
      },
    };
    expect(isMacAppStoreDesktop(directPackaged)).toBe(false);
    expect(desktopChildEnvironment(directPackaged, fixture.config.environment))
      .toBe(fixture.config.environment);
    expect(await allocateMacChromiumTemp(directPackaged, new AbortController().signal)).toBeNull();
    expect(buildElectronSpawnOptions(
      directPackaged,
      "http://127.0.0.1:18082/",
      fixture.config.environment,
      null,
    ).options.env?.MAC_CHROMIUM_TMPDIR).toBe("/ambient/not-owned");
  });

  test("retains a replacement directory when an owned path is swapped", async () => {
    const fixture = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    await rm(allocation!.directory, { recursive: true, force: true });
    await mkdir(allocation!.directory, { mode: 0o700 });
    await writeFile(path.join(allocation!.directory, "replacement-data"), "must survive\n");

    await expect(allocation!.release()).rejects.toThrow(/changed identity|Refusing MAS Chromium temp cleanup/u);
    expect(await readFile(path.join(allocation!.directory, "replacement-data"), "utf8"))
      .toBe("must survive\n");
  });

  test("retains nonempty owned roots instead of recursively deleting their contents", async () => {
    const fixture = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    const retained = path.join(allocation!.directory, "retained-data");
    await writeFile(retained, "must survive\n");

    await expect(allocation!.release()).rejects.toThrow(/retained because the owned fresh root is non-empty/u);
    expect(await readFile(retained, "utf8")).toBe("must survive\n");
  });

  test("enforces the pinned 253-byte UTF-8 allowance for SingletonSocket and SingletonCookie", async () => {
    const exact = await makeMasFixture({ singletonPathBytes: MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES });
    const allocation = await allocateMacChromiumTemp(exact.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    expect(Buffer.byteLength(allocation!.socketPath, "utf8"))
      .toBe(MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES);
    expect(Buffer.byteLength(allocation!.cookiePath, "utf8"))
      .toBe(MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES);
    await allocation!.release();

    const above = await makeMasFixture({ singletonPathBytes: MAC_CHROMIUM_PROCESS_SINGLETON_PATH_BYTES + 1 });
    await expect(allocateMacChromiumTemp(above.config, new AbortController().signal))
      .rejects.toThrow(/process-singleton SingletonSocket path is \d+ UTF-8 bytes.*253/u);
    expect(await listFreshTempChildren(above.tempRoot)).toEqual([]);
  });

  test("checks cancellation before creation and after creating the owned child", async () => {
    const before = await makeMasFixture();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("cancelled before allocation"));
    await expect(allocateMacChromiumTemp(before.config, alreadyAborted.signal)).rejects.toThrow(
      /cancelled before allocation/,
    );
    expect(await exists(before.tempRoot)).toBe(false);

    const after = await makeMasFixture();
    let checks = 0;
    const abortAfterCreate = {
      throwIfAborted: () => {
        checks += 1;
        if (checks === 3) throw new Error("cancelled after allocation");
      },
    } as unknown as AbortSignal;
    await expect(allocateMacChromiumTemp(after.config, abortAfterCreate)).rejects.toThrow(
      /cancelled after allocation/,
    );
    expect(await listFreshTempChildren(after.tempRoot)).toEqual([]);
  });

  test("captures the actual Electron spawn environment and keeps direct/dev behavior unchanged", async () => {
    const fixture = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const child = { pid: 1201 } as ChildProcess;
    const masEnvironment = {
      ...fixture.config.environment,
      MAC_CHROMIUM_TMPDIR: "/ambient/not-owned",
    };
    const spawned = spawnMeetlessElectron(
      fixture.config,
      "http://127.0.0.1:18082/",
      masEnvironment,
      allocation!.directory,
      new AbortController().signal,
      (command, args, options) => {
        calls.push({ command, args, env: options.env ?? {} });
        return child;
      },
    );
    expect(spawned).toBe(child);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.MAC_CHROMIUM_TMPDIR).toBe(allocation!.directory);
    expect(calls[0]!.env.MAC_CHROMIUM_TMPDIR).not.toBe("/ambient/not-owned");
    expect(calls[0]!.env.PASEO_ELECTRON_USER_DATA_DIR).toBe(fixture.config.paths.electronUserData);
    expect(buildElectronSpawnOptions(
      fixture.config,
      "http://127.0.0.1:18082/",
      masEnvironment,
      allocation!.directory,
    ).options.env?.MAC_CHROMIUM_TMPDIR).toBe(allocation!.directory);
    expect(copyEnvironmentWithoutMacChromiumTmpDir(masEnvironment)).not.toHaveProperty("MAC_CHROMIUM_TMPDIR");
    expect(desktopChildEnvironment(fixture.config, masEnvironment)).not.toHaveProperty("MAC_CHROMIUM_TMPDIR");

    const direct = makeDirectConfig(fixture.config);
    expect(desktopChildEnvironment(direct, masEnvironment)).toBe(masEnvironment);
    expect(buildElectronSpawnOptions(
      direct,
      "http://127.0.0.1:8082/",
      masEnvironment,
      null,
    ).options.env?.MAC_CHROMIUM_TMPDIR).toBe("/ambient/not-owned");
    expect(await allocateMacChromiumTemp(direct, new AbortController().signal)).toBeNull();
    await allocation!.release();
  });

  test("releases only after successful owner shutdown and preserves the allocation on failure", async () => {
    const normal = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(normal.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    const order: string[] = [];
    await shutdownOwnedRuntimeAndReleaseMacChromiumTemp(allocation, async () => {
      order.push("shutdown");
      expect(await exists(allocation!.directory)).toBe(true);
    });
    expect(order).toEqual(["shutdown"]);
    expect(await exists(allocation!.directory)).toBe(false);

    const failed = await makeMasFixture();
    const failedAllocation = await allocateMacChromiumTemp(failed.config, new AbortController().signal);
    expect(failedAllocation).not.toBeNull();
    await expect(shutdownOwnedRuntimeAndReleaseMacChromiumTemp(failedAllocation, async () => {
      throw new Error("owner shutdown failed closed");
    })).rejects.toThrow(/owner shutdown failed closed/);
    expect(await exists(failedAllocation!.directory)).toBe(true);
    await failedAllocation!.release();

    const dualFailure = await makeMasFixture();
    const dualAllocation = await allocateMacChromiumTemp(dualFailure.config, new AbortController().signal);
    expect(dualAllocation).not.toBeNull();
    let cleanupError: unknown;
    try {
      await cleanupMeetlessDesktopForTest(
        null,
        dualAllocation,
        async () => { throw new Error("renderer close failed"); },
        async () => { throw new Error("owner shutdown failed"); },
      );
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: renderer close failed",
      "Error: owner shutdown failed",
    ]);
    expect(await exists(dualAllocation!.directory)).toBe(true);
    await dualAllocation!.release();
  });

  test("releases an owned allocation when the Electron spawn call fails", async () => {
    const fixture = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    await expect(spawnMeetlessElectronWithMacChromiumTemp(
      fixture.config,
      "http://127.0.0.1:18082/",
      fixture.config.environment,
      allocation,
      new AbortController().signal,
      () => { throw new Error("injected spawn failure"); },
    )).rejects.toThrow(/injected spawn failure/);
    expect(await exists(allocation!.directory)).toBe(false);
  });

  test("runMeetlessDesktop keeps shutdown in the renderer-close failure path", async () => {
    const source = await readFile("packages/runtime/src/desktop.ts", "utf8");
    const runStart = source.indexOf("export async function runMeetlessDesktop");
    const runEnd = source.indexOf("type OwnedGroupName", runStart);
    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(runStart, runEnd)).toContain("await cleanupMeetlessDesktop(");

    const root = await mkdtemp(path.join(tmpdir(), "meetless-desktop-lifecycle-"));
    fixtureRoots.push(root);
    const config = resolveRuntimeConfig({ runtimeRoot: root, rendererOrigin: "http://127.0.0.1:18082" });
    const previousRendererUrl = process.env.MEETLESS_RENDERER_URL;
    process.env.MEETLESS_RENDERER_URL = config.rendererOrigin;
    let readPidLockCalls = 0;
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const spawn = vi.fn((_command: string, args: string[]) => ({
        pid: args.at(-1) === "daemon" ? 4_001_001 : 4_001_002,
        exitCode: args.at(-1) === "daemon" ? null : 0,
        signalCode: null,
      }) as unknown as ChildProcess);
      const spawnSync = vi.fn(() => ({ error: undefined, status: 1, stdout: "", stderr: "" }));
      return { ...actual, spawn, spawnSync };
    });
    vi.doMock("../src/config.js", async () => {
      const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
      return { ...actual, prepareRuntime: vi.fn(async () => undefined) };
    });
    vi.doMock("../src/host.js", async () => {
      const actual = await vi.importActual<typeof import("../src/host.js")>("../src/host.js");
      return {
        ...actual,
        assertDesktopLaunchedByHost: vi.fn(async () => ({})),
        assertSupervisorOwnedByHost: vi.fn(async () => undefined),
      };
    });
    vi.doMock("../src/lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lifecycle.js")>("../src/lifecycle.js");
      return {
        ...actual,
        readPidLock: vi.fn(async () => {
          readPidLockCalls += 1;
          return readPidLockCalls === 2
            ? { pid: process.pid, desktopManaged: true }
            : null;
        }),
        inspectLiveProcess: vi.fn((input: { expectedListen: string }) => ({
          listener: { address: input.expectedListen, belongsToSupervisor: true },
        })),
      };
    });
    vi.doMock("../src/readiness.js", () => ({
      waitForRecordingRuntime: vi.fn(async () => ({
        runtime: { instanceId: "lifecycle-fixture" },
        status: { status: "idle" },
      })),
    }));
    vi.doMock("../src/ui-test-envelope.js", async () => {
      const actual = await vi.importActual<typeof import("../src/ui-test-envelope.js")>("../src/ui-test-envelope.js");
      return {
        ...actual,
        activateUiTestRun: vi.fn(async () => null),
        removeUiTestRunState: vi.fn(async () => undefined),
      };
    });

    try {
      const { runMeetlessDesktop } = await import("../src/desktop.js?lifecycle-wiring");
      await expect(runMeetlessDesktop(config, {
        closeRenderer: async () => { throw new Error("renderer close failed"); },
      })).rejects.toThrow(/renderer close failed/u);
      expect(readPidLockCalls).toBe(3);
    } finally {
      if (previousRendererUrl === undefined) delete process.env.MEETLESS_RENDERER_URL;
      else process.env.MEETLESS_RENDERER_URL = previousRendererUrl;
      vi.doUnmock("node:child_process");
      vi.doUnmock("../src/config.js");
      vi.doUnmock("../src/host.js");
      vi.doUnmock("../src/lifecycle.js");
      vi.doUnmock("../src/readiness.js");
      vi.doUnmock("../src/ui-test-envelope.js");
      await vi.resetModules();
    }
  });
});

async function makeMasFixture(options: { userHomeSegment?: string; singletonPathBytes?: number } = {}): Promise<{
  root: string;
  config: RuntimeConfig;
  tempRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-desktop-private-temp-"));
  fixtureRoots.push(root);
  const canonicalRoot = await realpath(root);
  const userHomeSegment = options.userHomeSegment ?? (options.singletonPathBytes === undefined
    ? "home"
    : utf8SegmentForLength(
      options.singletonPathBytes - Buffer.byteLength(path.join(
        canonicalRoot,
        "Library/Containers/com.meetless.app/Data/tmp/m-XXXXXX/S/SingletonSocket",
      ), "utf8") - 1,
    ));
  const userHome = path.join(root, userHomeSegment);
  const supportRoot = path.join(
    userHome,
    "Library/Containers/com.meetless.app/Data/Library/Application Support",
  );
  await mkdir(supportRoot, { recursive: true, mode: 0o700 });
  const runtimeRoot = path.join(supportRoot, "Meetless");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const base = resolveRuntimeConfig({
    userHome,
    runtimeRoot,
    environment: {
      MEETLESS_RUNTIME_ROOT: runtimeRoot,
      MAC_CHROMIUM_TMPDIR: "/ambient/not-owned",
      MEETLESS_FFMPEG: process.execPath,
      MEETLESS_FFPROBE: process.execPath,
    },
  });
  const config: RuntimeConfig = {
    ...base,
    packaged: true,
    endpoints: { ...base.endpoints, mode: "packaged" },
    host: {
      ...base.host,
      identity: path.join(runtimeRoot, "host-identity.json"),
    },
    paths: {
      ...base.paths,
      recordingExports: path.join(runtimeRoot, "recordings"),
    },
    environment: {
      ...base.environment,
      MEETLESS_APP_CONTAINER_SUPPORT_ROOT: supportRoot,
      MEETLESS_RUNTIME_PACKAGED: "1",
      MAC_CHROMIUM_TMPDIR: "/ambient/not-owned",
    },
  };
  return {
    root,
    config,
    tempRoot: path.join(path.resolve(await realpath(supportRoot), "..", ".."), "tmp"),
  };
}

function makeDirectConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    packaged: false,
    endpoints: { ...config.endpoints, mode: "development" },
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function listFreshTempChildren(tempRoot: string): Promise<string[]> {
  if (!(await exists(tempRoot))) return [];
  return (await readdir(tempRoot)).filter((name) => /^m-[A-Za-z0-9]{6}$/u.test(name));
}

function utf8SegmentForLength(byteLength: number): string {
  if (byteLength < 1) throw new Error(`fixture path byte length must be positive, received ${byteLength}`);
  return "é".repeat(Math.floor(byteLength / 2)) + (byteLength % 2 === 1 ? "a" : "");
}
