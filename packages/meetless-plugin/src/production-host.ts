import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const AUTHORITY = "docs/plans/active/v1-paseo-foundation.md";
const HostIdentitySchema = z.object({
  version: z.literal(1),
  bundleIdentifier: z.literal("com.meetless.app"),
  bundlePath: z.string().min(1),
  bundleRealPath: z.string().min(1),
  executablePath: z.string().min(1),
  designatedRequirement: z.string().min(1),
  cdHash: z.string().regex(/^[a-f0-9]{40}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binaryDevice: z.number().int().nonnegative(),
  binaryInode: z.number().int().nonnegative(),
  binarySize: z.number().int().positive(),
}).passthrough();

interface ProcessExecutable {
  path: string;
  device: number;
  inode: number;
  size: number;
}

interface ProductionHostDependencies {
  parentPid(pid: number): number;
  executable(pid: number): ProcessExecutable;
  readIdentity(file: string): Promise<z.infer<typeof HostIdentitySchema>>;
  inspectCode(bundle: string): { cdHash: string; designatedRequirement: string };
}

const defaultDependencies: ProductionHostDependencies = {
  parentPid: (pid) => Number(inspectRequired("ps", ["-p", String(pid), "-o", "ppid="], `parent PID for ${pid}`)),
  executable: inspectProcessExecutable,
  readIdentity: async (file) => HostIdentitySchema.parse(JSON.parse(await readFile(file, "utf8"))),
  inspectCode: inspectCodeIdentity,
};

export async function assertProductionHostProvenance(
  environment: NodeJS.ProcessEnv = process.env,
  pluginPid = process.pid,
  dependencies: ProductionHostDependencies = defaultDependencies,
): Promise<void> {
  if (environment.MEETLESS_CAPTURE_MODE === "fixture") return;
  const hostPid = Number(environment.MEETLESS_HOST_PID);
  const bundlePath = environment.MEETLESS_HOST_BUNDLE_PATH?.trim();
  const identityPath = environment.MEETLESS_HOST_IDENTITY_PATH?.trim();
  if (!Number.isInteger(hostPid) || hostPid <= 1 || !bundlePath || !identityPath) {
    throw hostFailure("the daemon/plugin environment has no complete MeetlessHost attestation");
  }
  if (!isAncestor(pluginPid, hostPid, dependencies.parentPid)) {
    throw hostFailure(`configured host PID ${hostPid} is not an ancestor of plugin PID ${pluginPid}`);
  }

  let identity: z.infer<typeof HostIdentitySchema>;
  let live: ProcessExecutable;
  try {
    [identity, live] = await Promise.all([
      dependencies.readIdentity(identityPath),
      Promise.resolve(dependencies.executable(hostPid)),
    ]);
  } catch (error) {
    throw hostFailure(`cannot inspect the responsible host: ${describe(error)}`);
  }
  const canonicalBundle = await realpath(bundlePath).catch((error) => {
    throw hostFailure(`cannot resolve the responsible host bundle: ${describe(error)}`);
  });
  const canonicalExecutable = await realpath(live.path).catch((error) => {
    throw hostFailure(`cannot resolve the live host executable: ${describe(error)}`);
  });
  if (
    canonicalBundle !== identity.bundleRealPath ||
    canonicalExecutable !== identity.executablePath ||
    live.device !== identity.binaryDevice ||
    live.inode !== identity.binaryInode ||
    live.size !== identity.binarySize
  ) {
    throw hostFailure("the live host executable path/device/inode/size differs from the installed identity");
  }
  const binary = await readFile(canonicalExecutable);
  const digest = createHash("sha256").update(binary).digest("hex");
  if (digest !== identity.binarySha256) throw hostFailure("the live host executable hash differs from the installed identity");
  const code = dependencies.inspectCode(canonicalBundle);
  if (code.cdHash !== identity.cdHash || code.designatedRequirement !== identity.designatedRequirement) {
    throw hostFailure("the live host CDHash/designated requirement differs from the installed identity");
  }
}

function isAncestor(candidatePid: number, ancestorPid: number, parentPid: (pid: number) => number): boolean {
  let current = candidatePid;
  const visited = new Set<number>();
  while (current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true;
    visited.add(current);
    current = parentPid(current);
    if (!Number.isInteger(current)) return false;
  }
  return false;
}

function inspectProcessExecutable(pid: number): ProcessExecutable {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-FDsin"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`lsof cannot inspect PID ${pid}`);
  const entries = result.stdout.split("ftxt\n").slice(1);
  for (const entry of entries) {
    const fields = Object.fromEntries(entry.split("\n").filter(Boolean).map((line) => [line[0], line.slice(1)]));
    if (!fields.n || !fields.D || !fields.i || !fields.s) continue;
    return {
      path: fields.n,
      device: Number(fields.D),
      inode: Number(fields.i),
      size: Number(fields.s),
    };
  }
  throw new Error(`lsof did not report a live executable identity for PID ${pid}`);
}

function inspectCodeIdentity(bundle: string): { cdHash: string; designatedRequirement: string } {
  const details = inspectRequiredOutput("codesign", ["-d", "--verbose=4", "-r-", bundle], "code identity");
  const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(details)?.[1];
  const designatedRequirement = /^(?:# )?designated => (.+)$/mu.exec(details)?.[1];
  if (!cdHash || !designatedRequirement) throw new Error("codesign did not report the host CDHash/designated requirement");
  return { cdHash, designatedRequirement };
}

function inspectRequired(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect ${fact}`);
  return result.stdout.trim();
}

function inspectRequiredOutput(command: string, arguments_: string[], fact: string): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`cannot inspect ${fact}`);
  return `${result.stdout}\n${result.stderr}`.trim();
}

function hostFailure(reason: string): Error {
  return new Error(
    `Production recording start rejected before helper spawn: ${reason}. Authority: ${AUTHORITY}. ` +
    "Next action: stop the direct daemon/plugin runtime and launch with npm run runtime:host.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
