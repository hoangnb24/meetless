import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  allocateMacChromiumTemp,
  buildElectronSpawnOptions,
  copyEnvironmentWithoutMacChromiumTmpDir,
  desktopChildEnvironment,
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
    expect(first!.socketPath).toBe(path.join(first!.directory, "S"));
    expect(Buffer.byteLength(first!.socketPath, "utf8")).toBeLessThanOrEqual(
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

  test("retains a replacement directory when an owned path is swapped", async () => {
    const fixture = await makeMasFixture();
    const allocation = await allocateMacChromiumTemp(fixture.config, new AbortController().signal);
    expect(allocation).not.toBeNull();
    await rm(allocation!.directory, { recursive: true, force: true });
    await mkdir(allocation!.directory, { mode: 0o700 });

    await expect(allocation!.release()).rejects.toThrow(/changed identity|Refusing MAS Chromium temp cleanup/u);
    expect(await exists(allocation!.directory)).toBe(true);
  });

  test("rejects a final Unicode socket path above the pinned 253-byte allowance", async () => {
    const fixture = await makeMasFixture({ userHomeSegment: "用户".repeat(36) });
    await expect(allocateMacChromiumTemp(fixture.config, new AbortController().signal))
      .rejects.toThrow(/process-singleton path is \d+ UTF-8 bytes.*253/u);
    expect(await listFreshTempChildren(fixture.tempRoot)).toEqual([]);
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
});

async function makeMasFixture(options: { userHomeSegment?: string } = {}): Promise<{
  root: string;
  config: RuntimeConfig;
  tempRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-desktop-private-temp-"));
  fixtureRoots.push(root);
  const userHome = path.join(root, options.userHomeSegment ?? "home");
  const supportRoot = path.join(
    userHome,
    "Library/Containers/com.meetless.app/Data/Library/Application Support",
  );
  await mkdir(supportRoot, { recursive: true, mode: 0o700 });
  const runtimeRoot = path.join(supportRoot, "Meetless");
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
    tempRoot: path.join(path.resolve(supportRoot, "..", ".."), "tmp"),
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
