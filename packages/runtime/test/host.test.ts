import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { assertPackagedDaemonOwnedByHost } from "../src/cli.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { HostOwnedRuntimeShutdown } from "../src/desktop.js";
import {
  assertDesktopLaunchedByHost,
  assertInstalledHostIdentity,
  assertSupervisorOwnedByHost,
  expectedHostConfiguration,
  resolveHostConfiguration,
  type HostIdentity,
} from "../src/host.js";

const execFileAsync = promisify(execFile);

describe("Meetless-owned production host invariant", () => {
  test("projects the accepted development config envelope into launch configuration", () => {
    const launch = {
      repositoryRoot: process.cwd(),
      runtimeRoot: "/tmp/meetless-development-host",
      listen: "127.0.0.1:6777",
      rendererOrigin: "http://127.0.0.1:8082",
      transcriptionSocket: "/tmp/meetless-development-host/transcription.sock",
      transcriptionStaging: "/tmp/meetless-development-host/transcription",
      nodePath: process.execPath,
      runtimeCliPath: path.resolve("packages/runtime/dist/cli.js"),
      identityPath: "/tmp/meetless-development-host/host-identity.json",
    };

    expect(resolveHostConfiguration({
      schema: "MEETLESS_MACOS_HOST_CONFIG v2",
      mode: "development",
      bundleIdentifier: "com.meetless.app",
      ...launch,
    }, "/Applications/Meetless.app")).toEqual(launch);
  });

  test("accepts only LaunchServices → exact MeetlessHost → desktop → supervisor", async () => {
    const config = resolveRuntimeConfig();
    const identity = fakeIdentity(config);
    const processes = new Map([
      [100, processIdentity(identity, { pid: 100, ppid: 1, executablePath: identity.executablePath, arguments: [identity.executablePath] })],
      [200, {
        pid: 200,
        ppid: 100,
        executablePath: identity.configuration.nodePath,
        arguments: [identity.configuration.nodePath, identity.configuration.runtimeCliPath, "desktop"],
        executableDevice: 4, executableInode: 5, executableSize: 6,
      }],
      [300, { pid: 300, ppid: 200, executablePath: process.execPath, arguments: [process.execPath, "daemon"], executableDevice: 7, executableInode: 8, executableSize: 9 }],
    ]);
    const dependencies = fakeDependencies(identity, processes);

    await expect(assertDesktopLaunchedByHost(config, 200, dependencies)).resolves.toEqual(identity);
    await expect(assertSupervisorOwnedByHost(config, 300, dependencies)).resolves.toEqual({
      identity,
      hostPid: 100,
      desktopPid: 200,
      supervisorPid: 300,
    });
  });

  test("rejects a direct packaged daemon before activation or media preparation while preserving development behavior", async () => {
    const packagedConfig = { ...resolveRuntimeConfig(), packaged: true };
    let ownershipChecked = false;
    await expect(assertPackagedDaemonOwnedByHost(
      packagedConfig,
      300,
      async () => {
        ownershipChecked = true;
        throw new Error("direct packaged daemon has no verified host topology");
      },
    )).rejects.toThrow(/direct packaged daemon has no verified host topology/);
    expect(ownershipChecked).toBe(true);

    let developmentOwnershipChecked = false;
    await expect(assertPackagedDaemonOwnedByHost(
      { ...packagedConfig, packaged: false },
      300,
      async () => {
        developmentOwnershipChecked = true;
        throw new Error("development must not require packaged host ownership");
      },
    )).resolves.toBeUndefined();
    expect(developmentOwnershipChecked).toBe(false);

    const source = await readFile("packages/runtime/src/cli.ts", "utf8");
    const daemonStart = source.indexOf('if (command === "daemon")');
    const ownershipGate = source.indexOf("await assertPackagedDaemonOwnedByHost(config);", daemonStart);
    const activation = source.indexOf("await activateUiTestRun(config);", daemonStart);
    const preparation = source.indexOf("await prepareRuntime(config);", daemonStart);
    expect(daemonStart).toBeGreaterThanOrEqual(0);
    expect(ownershipGate).toBeGreaterThan(daemonStart);
    expect(ownershipGate).toBeLessThan(activation);
    expect(ownershipGate).toBeLessThan(preparation);
  });

  test("rejects Paseo.app, Terminal-style ancestry, and a changed installed identity", async () => {
    const config = resolveRuntimeConfig();
    const identity = fakeIdentity(config);
    const desktop = {
      pid: 200,
      ppid: 100,
      executablePath: identity.configuration.nodePath,
      arguments: [identity.configuration.nodePath, identity.configuration.runtimeCliPath, "desktop"],
      executableDevice: 4, executableInode: 5, executableSize: 6,
    };
    const paseoAncestor = {
      pid: 100,
      ppid: 1,
      executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      arguments: ["/Applications/Paseo.app/Contents/MacOS/Paseo"],
      executableDevice: 10, executableInode: 11, executableSize: 12,
    };
    await expect(assertDesktopLaunchedByHost(
      config,
      200,
      fakeDependencies(identity, new Map([[100, paseoAncestor], [200, desktop]])),
    )).rejects.toThrow(/Paseo\.app.*rejected.*Authority.*host:install/s);

    const terminalAncestor = processIdentity(identity, {
      pid: 100, ppid: 42, executablePath: identity.executablePath, arguments: [identity.executablePath],
    });
    await expect(assertDesktopLaunchedByHost(
      config,
      200,
      fakeDependencies(identity, new Map([[100, terminalAncestor], [200, desktop]])),
    )).rejects.toThrow(/LaunchServices.*Terminal, Codex, Paseo.*not accepted/s);

    const drifted = { ...identity, cdHash: "b".repeat(40) } as HostIdentity;
    await expect(assertInstalledHostIdentity(config, {
      inspectInstalled: async () => drifted,
      readRecorded: async () => identity,
    })).rejects.toThrow(/identity drifted.*--replace.*grant capture only to \/Applications\/Meetless\.app/s);

    const exactHost = processIdentity(identity, {
      pid: 100, ppid: 1, executablePath: identity.executablePath, arguments: [identity.executablePath],
    });
    await expect(assertDesktopLaunchedByHost(config, 200, {
      ...fakeDependencies(identity, new Map([[100, exactHost], [200, desktop]])),
      inspectLiveHost: async () => drifted,
    })).rejects.toThrow(/live host executable hash\/CDHash\/designated requirement differs.*Authority/s);
  });

  test("production CLI fails closed when launched directly outside MeetlessHost", async () => {
    await expect(execFileAsync(process.execPath, [path.resolve("packages/runtime/dist/cli.js"), "desktop"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEETLESS_RUNTIME_ROOT: `/tmp/meetless-direct-cli-test-${process.pid}`,
        MEETLESS_LISTEN: "127.0.0.1:16777",
      },
      timeout: 20_000,
    })).rejects.toMatchObject({
      stderr: expect.stringMatching(/Production Meetless host attestation failed closed.*host:install/s),
    });
  });

  test("host path never reads or mutates TCC state and launches only through LaunchServices", async () => {
    const sources = await Promise.all([
      "packages/runtime/src/host.ts",
      "scripts/install-macos-host.mjs",
      "scripts/launch-macos-host.mjs",
      "scripts/stop-macos-host.mjs",
      "native/macos-host/MeetlessHost.swift",
      "packages/meetless-plugin/src/production-host.ts",
    ].map((file) => readFile(file, "utf8")));
    const joined = sources.join("\n");
    expect(joined).not.toMatch(/tccutil|com\.apple\.TCC|TCC\.db|\/Applications\/Paseo\.app|com\.paseo/u);
    expect(await readFile("scripts/launch-macos-host.mjs", "utf8")).toMatch(/execFileAsync\("open"/u);
    expect(await readFile("scripts/launch-macos-host.mjs", "utf8")).not.toMatch(/Contents\/MacOS/u);
    const installer = await readFile("scripts/install-macos-host.mjs", "utf8");
    expect(installer).toContain("/usr/bin/lockf");
    expect(installer).toContain("MEETLESS_HOST_INSTALL_LOCK_HELD");
    expect(await readFile("native/macos-host/MeetlessHost.swift", "utf8"))
      .toMatch(/flock\(lockDescriptor, LOCK_EX \| LOCK_NB\)/u);
    const plist = await readFile("native/macos-host/Info.plist", "utf8");
    expect(plist).toMatch(/<key>CFBundleIdentifier<\/key>\s*<string>com\.meetless\.app<\/string>/u);
    expect(plist).toMatch(/<key>LSMinimumSystemVersion<\/key>\s*<string>15\.0<\/string>/u);
    for (const key of [
      "NSScreenCaptureUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSAudioCaptureUsageDescription",
    ]) {
      expect(plist).toMatch(new RegExp(`<key>${key}<\\/key>\\s*<string>[^<]+<\\/string>`, "u"));
    }
  });

  test("central shutdown owns pre-lock and full-UI process groups and rejects inspection failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-owned-shutdown-"));
    const config = resolveRuntimeConfig({ runtimeRoot: root, rendererOrigin: "http://127.0.0.1:18082" });
    const running = new Map([[101, true], [102, true], [103, true]]);
    const signaled: Array<[number, NodeJS.Signals]> = [];
    const inspection = {
      signalGroup: (pgid: number, signal: NodeJS.Signals) => { signaled.push([pgid, signal]); running.set(pgid, false); },
      groupRunning: (pgid: number) => running.get(pgid) === true,
      listenerExists: () => false,
      socketExists: async () => false,
      delay: async () => undefined,
    };
    const owner = new HostOwnedRuntimeShutdown(config, inspection);
    const daemon = fakeChild(101, () => running.set(101, false));
    try {
      await owner.track("daemon", daemon);
      await owner.track("renderer", fakeChild(102));
      await owner.track("electron", fakeChild(103));
      await owner.shutdown({ daemonChild: daemon, daemonOwned: true });
      expect(running).toEqual(new Map([[101, false], [102, false], [103, false]]));
      expect(signaled).toEqual(expect.arrayContaining([
        [101, "SIGTERM"],
        [102, "SIGTERM"],
        [103, "SIGTERM"],
      ]));
    } finally {
      owner.signals.dispose();
      await rm(root, { recursive: true, force: true });
    }

    const failedRoot = await mkdtemp(path.join(tmpdir(), "meetless-shutdown-inspection-"));
    const failedOwner = new HostOwnedRuntimeShutdown(
      resolveRuntimeConfig({ runtimeRoot: failedRoot, rendererOrigin: "http://127.0.0.1:18083" }),
      {
        ...inspection,
        listenerExists: () => { throw new Error("injected lsof failure"); },
      },
    );
    try {
      await expect(failedOwner.shutdown({ daemonChild: null, daemonOwned: false }))
        .rejects.toThrow(/failed closed.*injected lsof failure.*Authority/s);
    } finally {
      failedOwner.signals.dispose();
      await rm(failedRoot, { recursive: true, force: true });
    }
  });
});

function fakeIdentity(config: ReturnType<typeof resolveRuntimeConfig>): HostIdentity {
  return {
    version: 1,
    bundleIdentifier: "com.meetless.app",
    bundlePath: path.resolve(config.host.bundle),
    bundleRealPath: path.resolve(config.host.bundle),
    executablePath: "/usr/bin/true",
    designatedRequirement: 'identifier "com.meetless.app" and anchor cdhash H"abc"',
    cdHash: "a".repeat(40),
    binarySha256: "c".repeat(64),
    binaryDevice: 1,
    binaryInode: 2,
    binarySize: 3,
    configuration: expectedHostConfiguration(config),
  };
}

function fakeDependencies(
  identity: HostIdentity,
  processes: Map<number, {
    pid: number; ppid: number; executablePath: string; arguments: string[];
    executableDevice: number; executableInode: number; executableSize: number;
  }>,
) {
  return {
    inspectInstalled: async () => identity,
    readRecorded: async () => identity,
    inspectProcess: async (pid: number) => {
      const process = processes.get(pid);
      if (!process) throw new Error(`missing fake PID ${pid}`);
      return process;
    },
    inspectLiveHost: async () => identity,
  };
}

function processIdentity(identity: HostIdentity, process: {
  pid: number; ppid: number; executablePath: string; arguments: string[];
}) {
  return {
    ...process,
    executableDevice: identity.binaryDevice,
    executableInode: identity.binaryInode,
    executableSize: identity.binarySize,
  };
}

function fakeChild(pid: number, onKill: () => void = () => undefined) {
  return { pid, kill: () => { onKill(); return true; } } as unknown as import("node:child_process").ChildProcess;
}
