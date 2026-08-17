import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import { inspectNativeArgumentVector, RECORDING_READINESS_AUTHORITY } from "./readiness.js";

export const MEETLESS_HOST_BUNDLE_ID = "com.meetless.app";
export const MEETLESS_HOST_EXECUTABLE = "MeetlessHost";

const HostLaunchConfigurationSchema = z.object({
  repositoryRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  listen: z.string().min(1),
  nodePath: z.string().min(1),
  runtimeCliPath: z.string().min(1),
  identityPath: z.string().min(1),
}).strict();

export type HostLaunchConfiguration = z.infer<typeof HostLaunchConfigurationSchema>;

export const HostIdentitySchema = z.object({
  version: z.literal(1),
  bundleIdentifier: z.literal(MEETLESS_HOST_BUNDLE_ID),
  bundlePath: z.string().min(1),
  bundleRealPath: z.string().min(1),
  executablePath: z.string().min(1),
  designatedRequirement: z.string().min(1),
  cdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryDevice: z.number().int().nonnegative(),
  binaryInode: z.number().int().nonnegative(),
  binarySize: z.number().int().positive(),
  configuration: HostLaunchConfigurationSchema,
}).strict();

export type HostIdentity = z.infer<typeof HostIdentitySchema>;

interface ProcessIdentity {
  pid: number;
  ppid: number;
  executablePath: string;
  arguments: string[];
  executableDevice: number;
  executableInode: number;
  executableSize: number;
}

interface HostInspectionDependencies {
  inspectInstalled(bundlePath: string): Promise<HostIdentity>;
  readRecorded(identityPath: string): Promise<HostIdentity>;
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  inspectLiveHost(bundlePath: string): Promise<HostIdentity>;
}

const defaultDependencies: HostInspectionDependencies = {
  inspectInstalled: inspectHostBundle,
  readRecorded: readHostIdentity,
  inspectProcess,
  inspectLiveHost: inspectHostBundle,
};

export async function inspectHostBundle(bundlePath: string): Promise<HostIdentity> {
  const canonicalBundle = await realpath(bundlePath);
  const bundleIdentifier = inspectRequired(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(bundlePath, "Contents", "Info.plist")],
    "bundle identifier",
  );
  if (bundleIdentifier !== MEETLESS_HOST_BUNDLE_ID) {
    throw new Error(`installed host bundle identifier is ${bundleIdentifier}, expected ${MEETLESS_HOST_BUNDLE_ID}`);
  }
  const executablePath = path.join(canonicalBundle, "Contents", "MacOS", MEETLESS_HOST_EXECUTABLE);
  const [binary, binaryInfo, configurationText] = await Promise.all([
    readFile(executablePath),
    stat(executablePath),
    readFile(path.join(canonicalBundle, "Contents", "Resources", "host-config.json"), "utf8"),
  ]);
  const requirementOutput = inspectRequiredOutput("codesign", ["-d", "-r-", canonicalBundle], "designated requirement");
  const designatedRequirement = /^(?:# )?designated => (.+)$/mu.exec(requirementOutput)?.[1];
  if (!designatedRequirement) throw new Error("codesign did not report a designated requirement for Meetless.app");
  const signatureOutput = inspectRequiredOutput("codesign", ["-d", "--verbose=4", canonicalBundle], "CDHash");
  const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(signatureOutput)?.[1];
  if (!cdHash) throw new Error("codesign did not report a 40-character CDHash for Meetless.app");
  inspectRequired("codesign", ["--verify", "--deep", "--strict", canonicalBundle], "signature verification");
  return HostIdentitySchema.parse({
    version: 1,
    bundleIdentifier,
    bundlePath: path.resolve(bundlePath),
    bundleRealPath: canonicalBundle,
    executablePath,
    designatedRequirement,
    cdHash,
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    binaryDevice: binaryInfo.dev,
    binaryInode: binaryInfo.ino,
    binarySize: binaryInfo.size,
    configuration: HostLaunchConfigurationSchema.parse(JSON.parse(configurationText)),
  });
}

export async function readHostIdentity(identityPath: string): Promise<HostIdentity> {
  return HostIdentitySchema.parse(JSON.parse(await readFile(identityPath, "utf8")));
}

export async function assertInstalledHostIdentity(
  config: RuntimeConfig,
  dependencies: Pick<HostInspectionDependencies, "inspectInstalled" | "readRecorded"> = defaultDependencies,
): Promise<HostIdentity> {
  let installed: HostIdentity;
  let recorded: HostIdentity;
  try {
    [installed, recorded] = await Promise.all([
      dependencies.inspectInstalled(config.host.bundle),
      dependencies.readRecorded(config.host.identity),
    ]);
  } catch (error) {
    throw hostFailure(`cannot attest the installed host: ${message(error)}`);
  }
  if (JSON.stringify(installed) !== JSON.stringify(recorded)) {
    throw hostFailure(
      "installed bundle identity drifted from its recorded designated requirement/CDHash/binary identity",
    );
  }
  const expectedConfiguration = expectedHostConfiguration(config);
  if (
    installed.configuration.repositoryRoot !== expectedConfiguration.repositoryRoot ||
    installed.configuration.runtimeRoot !== expectedConfiguration.runtimeRoot ||
    installed.configuration.listen !== expectedConfiguration.listen ||
    installed.configuration.runtimeCliPath !== expectedConfiguration.runtimeCliPath ||
    installed.configuration.identityPath !== expectedConfiguration.identityPath ||
    !path.isAbsolute(installed.configuration.nodePath)
  ) {
    throw hostFailure("installed host repository/runtime configuration differs from this production runtime");
  }
  if (
    installed.bundlePath !== path.resolve(config.host.bundle) ||
    installed.bundleRealPath !== path.resolve(config.host.bundle)
  ) {
    throw hostFailure(`installed host is not at the canonical path ${config.host.bundle}`);
  }
  return installed;
}

export async function assertDesktopLaunchedByHost(
  config: RuntimeConfig,
  currentPid = process.pid,
  dependencies: HostInspectionDependencies = defaultDependencies,
): Promise<HostIdentity> {
  const identity = await assertInstalledHostIdentity(config, dependencies);
  const desktop = await dependencies.inspectProcess(currentPid);
  const host = await dependencies.inspectProcess(desktop.ppid);
  await assertExactTopology(identity, desktop, host, config, dependencies.inspectLiveHost);
  return identity;
}

export async function assertSupervisorOwnedByHost(
  config: RuntimeConfig,
  supervisorPid: number,
  dependencies: HostInspectionDependencies = defaultDependencies,
): Promise<{
  identity: HostIdentity;
  hostPid: number;
  desktopPid: number;
  supervisorPid: number;
}> {
  const identity = await assertInstalledHostIdentity(config, dependencies);
  const supervisor = await dependencies.inspectProcess(supervisorPid);
  const desktop = await dependencies.inspectProcess(supervisor.ppid);
  const host = await dependencies.inspectProcess(desktop.ppid);
  await assertExactTopology(identity, desktop, host, config, dependencies.inspectLiveHost);
  return { identity, hostPid: host.pid, desktopPid: desktop.pid, supervisorPid };
}

export function expectedHostConfiguration(config: RuntimeConfig): HostLaunchConfiguration {
  return {
    repositoryRoot: path.resolve(config.paths.plugin, "..", ".."),
    runtimeRoot: config.paths.root,
    listen: config.listen,
    nodePath: process.execPath,
    runtimeCliPath: path.join(path.resolve(config.paths.plugin, "..", ".."), "packages", "runtime", "dist", "cli.js"),
    identityPath: config.host.identity,
  };
}

async function assertExactTopology(
  identity: HostIdentity,
  desktop: ProcessIdentity,
  host: ProcessIdentity,
  config: RuntimeConfig,
  inspectLiveHost: (bundlePath: string) => Promise<HostIdentity>,
): Promise<void> {
  if (path.resolve(host.executablePath) !== path.resolve(identity.executablePath)) {
    throw hostFailure(
      `responsible ancestor ${host.executablePath} is not the installed MeetlessHost executable; ` +
      "Paseo.app, Terminal, Codex, and other outer applications are rejected",
    );
  }
  const [desktopExecutable, configuredNode, hostExecutable, installedExecutable] = await Promise.all([
    realpath(desktop.executablePath),
    realpath(identity.configuration.nodePath),
    realpath(host.executablePath),
    realpath(identity.executablePath),
  ]);
  if (
    host.executableDevice !== identity.binaryDevice ||
    host.executableInode !== identity.binaryInode ||
    host.executableSize !== identity.binarySize
  ) {
    throw hostFailure("live host executable device/inode/size differs from the installed identity");
  }
  const expectedDesktopArguments = [
    identity.configuration.nodePath,
    identity.configuration.runtimeCliPath,
    "desktop",
  ];
  if (
    desktopExecutable !== configuredNode ||
    desktop.arguments.length !== expectedDesktopArguments.length ||
    desktop.arguments.some((argument, index) => argument !== expectedDesktopArguments[index])
  ) {
    throw hostFailure(`runtime PID ${desktop.pid} is not the exact installed host desktop CLI child`);
  }
  if (host.ppid !== 1 || hostExecutable !== installedExecutable) {
    throw hostFailure(
      `runtime ancestry is not LaunchServices → ${config.host.bundle} → desktop; ` +
      "Terminal, Codex, Paseo, and direct executable launch are not accepted responsible ancestors",
    );
  }
  const liveIdentity = await inspectLiveHost(identity.bundleRealPath);
  if (JSON.stringify(liveIdentity) !== JSON.stringify(identity)) {
    throw hostFailure("live host executable hash/CDHash/designated requirement differs from the installed identity");
  }
}

async function inspectProcess(pid: number): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid process PID ${pid}`);
  const ppid = Number(inspectRequired("ps", ["-p", String(pid), "-o", "ppid="], `parent PID for ${pid}`));
  if (!Number.isInteger(ppid)) throw new Error(`cannot inspect parent PID for ${pid}`);
  const inspected = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-FDsin"], {
    encoding: "utf8",
  });
  if (inspected.error || inspected.status !== 0) throw new Error(`cannot inspect executable for PID ${pid}`);
  const entry = inspected.stdout.split("ftxt\n").slice(1).map((block) =>
    Object.fromEntries(block.split("\n").filter(Boolean).map((line) => [line[0], line.slice(1)])),
  ).find((fields) => fields.n && fields.D && fields.i && fields.s);
  if (!entry?.n?.startsWith("/") || !entry.D || !entry.i || !entry.s) {
    throw new Error(`lsof did not report an executable for PID ${pid}`);
  }
  return {
    pid,
    ppid,
    executablePath: entry.n,
    arguments: await inspectNativeArgumentVector(pid),
    executableDevice: Number(entry.D),
    executableInode: Number(entry.i),
    executableSize: Number(entry.s),
  };
}

function inspectRequired(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Meetless host ${fact}: ${result.stderr.trim() || result.error?.message || result.status}`);
  }
  return result.stdout.trim();
}

function inspectRequiredOutput(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect Meetless host ${fact}: ${result.stderr.trim() || result.error?.message || result.status}`);
  }
  return `${result.stdout}\n${result.stderr}`.trim();
}

function hostFailure(reason: string): Error {
  return new Error(
    `Production Meetless host attestation failed closed: ${reason}. ` +
    `Authority: ${RECORDING_READINESS_AUTHORITY}. Next action: run npm run host:install; ` +
    `if identity drift is reported, run npm run host:install -- --replace and grant capture only to ~/Applications/Meetless.app.`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
