import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  assertDesktopLaunchedByHost,
  assertInstalledHostIdentity,
  assertSupervisorOwnedByHost,
  expectedHostConfiguration,
  type HostIdentity,
} from "../src/host.js";

const execFileAsync = promisify(execFile);

describe("Meetless-owned production host invariant", () => {
  test("accepts only LaunchServices → exact MeetlessHost → desktop → supervisor", async () => {
    const config = resolveRuntimeConfig();
    const identity = fakeIdentity(config);
    const processes = new Map([
      [100, { pid: 100, ppid: 1, executablePath: identity.executablePath, arguments: [identity.executablePath] }],
      [200, {
        pid: 200,
        ppid: 100,
        executablePath: identity.configuration.nodePath,
        arguments: [identity.configuration.nodePath, identity.configuration.runtimeCliPath, "desktop"],
      }],
      [300, { pid: 300, ppid: 200, executablePath: process.execPath, arguments: [process.execPath, "daemon"] }],
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

  test("rejects Paseo.app, Terminal-style ancestry, and a changed installed identity", async () => {
    const config = resolveRuntimeConfig();
    const identity = fakeIdentity(config);
    const desktop = {
      pid: 200,
      ppid: 100,
      executablePath: identity.configuration.nodePath,
      arguments: [identity.configuration.nodePath, identity.configuration.runtimeCliPath, "desktop"],
    };
    const paseoAncestor = {
      pid: 100,
      ppid: 1,
      executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      arguments: ["/Applications/Paseo.app/Contents/MacOS/Paseo"],
    };
    await expect(assertDesktopLaunchedByHost(
      config,
      200,
      fakeDependencies(identity, new Map([[100, paseoAncestor], [200, desktop]])),
    )).rejects.toThrow(/Paseo\.app.*rejected.*Authority.*host:install/s);

    const terminalAncestor = { ...paseoAncestor, executablePath: identity.executablePath, ppid: 42 };
    await expect(assertDesktopLaunchedByHost(
      config,
      200,
      fakeDependencies(identity, new Map([[100, terminalAncestor], [200, desktop]])),
    )).rejects.toThrow(/LaunchServices.*Terminal, Codex, Paseo.*not accepted/s);

    const drifted = { ...identity, cdHash: "b".repeat(40) } as HostIdentity;
    await expect(assertInstalledHostIdentity(config, {
      inspectInstalled: async () => drifted,
      readRecorded: async () => identity,
    })).rejects.toThrow(/identity drifted.*--replace.*grant capture only to ~\/Applications\/Meetless\.app/s);
  });

  test("production CLI fails closed when launched directly outside MeetlessHost", async () => {
    await expect(execFileAsync(process.execPath, [path.resolve("packages/runtime/dist/cli.js"), "desktop"], {
      cwd: process.cwd(),
      timeout: 5_000,
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
    ].map((file) => readFile(file, "utf8")));
    const joined = sources.join("\n");
    expect(joined).not.toMatch(/tccutil|com\.apple\.TCC|TCC\.db|\/Applications\/Paseo\.app|com\.paseo/u);
    expect(await readFile("scripts/launch-macos-host.mjs", "utf8")).toMatch(/execFileAsync\("open"/u);
    expect(await readFile("scripts/launch-macos-host.mjs", "utf8")).not.toMatch(/Contents\/MacOS/u);
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
  processes: Map<number, { pid: number; ppid: number; executablePath: string; arguments: string[] }>,
) {
  return {
    inspectInstalled: async () => identity,
    readRecorded: async () => identity,
    inspectProcess: async (pid: number) => {
      const process = processes.get(pid);
      if (!process) throw new Error(`missing fake PID ${pid}`);
      return process;
    },
  };
}
