import { execFile, execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertInstalledHostIdentity } from "../packages/runtime/dist/host.js";
import {
  MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH,
  resolveRuntimeConfig,
} from "../packages/runtime/dist/config.js";

const execFileAsync = promisify(execFile);
const config = resolveRuntimeConfig({
  runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT,
  listen: process.env.MEETLESS_LISTEN,
});
await assertDirectRuntimeTarget(config.paths.root);
const identity = await assertInstalledHostIdentity(config);
await execFileAsync("open", ["-g", "-a", identity.bundleRealPath]);
const deadline = Date.now() + 5_000;
let hostPid = null;
while (Date.now() < deadline) {
  hostPid = exactHostPid(identity.executablePath);
  if (hostPid) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!hostPid) {
  const lockPath = path.join(path.dirname(config.paths.root), ".meetless-mas-gate.lock");
  const owner = await readFile(lockPath, "utf8").then((value) => value.trim(), () => "unknown owner");
  throw new Error(
    `LaunchServices did not establish the exact MeetlessHost while the shared install/start lock reports ${owner}. ` +
    "Wait for installation to finish, then rerun npm run runtime:host.",
  );
}
process.stdout.write(
  `Launched ${identity.bundleIdentifier} through LaunchServices at ${identity.bundleRealPath} ` +
  `(PID ${hostPid}, CDHash ${identity.cdHash}).\n`,
);

function exactHostPid(executablePath) {
  const inspected = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const matches = inspected.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match && Number(match[2]) === 1 && match[3] === executablePath ? [Number(match[1])] : [];
  });
  if (matches.length > 1) throw new Error(`Multiple exact MeetlessHost processes are live: ${matches.join(", ")}`);
  return matches[0] ?? null;
}

async function assertDirectRuntimeTarget(runtimeRoot) {
  const masRoot = path.resolve(homedir(), ...MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH.split("/"));
  const lexicalRoot = path.resolve(runtimeRoot);
  const resolvedRoot = await resolvePathThroughExistingAncestor(lexicalRoot);
  const isProtectedMasPath = (candidate) => candidate === masRoot || candidate.startsWith(`${masRoot}${path.sep}`);
  if (isProtectedMasPath(lexicalRoot) || isProtectedMasPath(resolvedRoot ?? "")) {
    throw new Error(
      `runtime:host refuses the MAS app-container runtime root ${masRoot}. ` +
      "Use npm run runtime:mas:development launch so the active transaction and one-time host handoff are verified. " +
      "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md.",
    );
  }
}

async function resolvePathThroughExistingAncestor(candidate) {
  const suffix = [];
  let current = candidate;
  while (true) {
    const resolved = await realpath(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (resolved) return path.join(resolved, ...suffix);
    const parent = path.dirname(current);
    if (parent === current) return null;
    suffix.unshift(path.basename(current));
    current = parent;
  }
}
