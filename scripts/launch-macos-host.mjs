import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertInstalledHostIdentity } from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";

const execFileAsync = promisify(execFile);
const config = resolveRuntimeConfig({
  runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT,
  listen: process.env.MEETLESS_LISTEN,
});
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
  const lockPath = path.join(config.paths.root, "meetless-host.lock");
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
