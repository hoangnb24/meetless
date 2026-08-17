import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
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
const ownedBefore = descendantsOf(pid, inspected.stdout);
process.kill(pid, "SIGTERM");
const deadline = Date.now() + 35_000;
while (isRunning(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
if (isRunning(pid)) throw new Error(`Timed out stopping MeetlessHost PID ${pid}`);
const releaseDeadline = Date.now() + 5_000;
while (!(await released()) && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
const survivors = ownedBefore.filter(isRunning);
if (survivors.length > 0 || !(await released())) {
  throw new Error(
    `MeetlessHost PID ${pid} exited but owned runtime cleanup is incomplete ` +
    `(survivors=${survivors.join(",") || "none"}, listen=${identity.configuration.listen}, ` +
    `socket=${config.paths.recordingSocket}). Inspect only this repo-owned tree; Paseo 6767 is out of scope.`,
  );
}
process.stdout.write(`Stopped MeetlessHost PID ${pid}.\n`);

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw new Error(`Cannot inspect owned PID ${pid} during shutdown: ${String(error)}`);
  }
}

function descendantsOf(rootPid, output) {
  const children = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const child = Number(match[1]); const parent = Number(match[2]);
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const result = []; const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift();
    result.push(current);
    pending.push(...(children.get(current) ?? []));
  }
  return result;
}

async function released() {
  let socketGone = false;
  try { await stat(config.paths.recordingSocket); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") socketGone = true;
    else throw new Error(`Cannot inspect recording socket during shutdown: ${String(error)}`);
  }
  const ports = [
    identity.configuration.listen.slice(identity.configuration.listen.lastIndexOf(":") + 1),
    new URL(config.rendererOrigin).port,
  ];
  for (const port of ports) {
    const listener = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
    if (listener.error) throw new Error(`Cannot inspect listener ${port}: ${listener.error.message}`);
    if (listener.status === 1 && listener.stdout.trim() === "") continue;
    if (listener.status !== 0) throw new Error(`Cannot inspect listener ${port}: lsof exited ${listener.status}`);
    if (listener.stdout.trim()) return false;
  }
  return socketGone;
}
