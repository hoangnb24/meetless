import { spawnSync } from "node:child_process";
import { assertInstalledHostIdentity } from "../packages/runtime/dist/host.js";
import { resolveRuntimeConfig } from "../packages/runtime/dist/config.js";

const config = resolveRuntimeConfig();
const identity = await assertInstalledHostIdentity(config);
const inspected = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
if (inspected.error || inspected.status !== 0) throw new Error("Cannot inspect the MeetlessHost process");
const matches = inspected.stdout.split("\n").flatMap((line) => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
  if (!match || match[3] !== identity.executablePath || Number(match[2]) !== 1) return [];
  return [Number(match[1])];
});
if (matches.length === 0) {
  process.stdout.write("MeetlessHost is not running.\n");
  process.exit(0);
}
if (matches.length !== 1) throw new Error(`Refusing to stop ${matches.length} MeetlessHost processes`);
const pid = matches[0];
process.kill(pid, "SIGTERM");
const deadline = Date.now() + 15_000;
while (isRunning(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
if (isRunning(pid)) throw new Error(`Timed out stopping MeetlessHost PID ${pid}`);
process.stdout.write(`Stopped MeetlessHost PID ${pid}.\n`);

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
