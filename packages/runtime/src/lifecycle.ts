import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

export interface PidLockIdentity {
  pid: number;
  startedAt: string;
  hostname: string;
  uid: number;
  listen: string | null;
  desktopManaged: boolean;
}

export interface LiveListenerIdentity {
  pid: number;
  address: string;
  belongsToSupervisor: boolean;
}

export interface LiveProcessIdentity {
  running: boolean;
  startedAt: string | null;
  hostname: string;
  uid: number | null;
  commandLine: string;
  paseoHomeMatches: boolean;
  supervisorEntrypointMatches: boolean;
  desktopManagedMarkerMatches: boolean;
  listener: LiveListenerIdentity | null;
}

const PID_LOCK_ACQUISITION_MAX_DELAY_MS = 5_000;

export function readProcessStartInstance(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Cannot inspect invalid process PID ${pid}`);
  const startedAt = inspectRequired("ps", ["-p", String(pid), "-o", "lstart="], `start time for ${pid}`).trim();
  if (!startedAt) throw new Error(`Cannot inspect process start instance for PID ${pid}`);
  return startedAt;
}

export async function readPidLock(filePath: string): Promise<PidLockIdentity | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 1 ||
      typeof parsed.startedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.startedAt)) ||
      typeof parsed.hostname !== "string" ||
      !parsed.hostname.trim() ||
      typeof parsed.uid !== "number" ||
      !Number.isInteger(parsed.uid) ||
      !(typeof parsed.listen === "string" || parsed.listen === null) ||
      typeof parsed.desktopManaged !== "boolean"
    ) {
      throw new Error(`Invalid isolated PID lock identity at ${filePath}`);
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      hostname: parsed.hostname,
      uid: parsed.uid,
      listen: parsed.listen,
      desktopManaged: parsed.desktopManaged,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function inspectLiveProcess(input: {
  pid: number;
  expectedListen: string;
  expectedPaseoHome: string;
  expectedSupervisorEntrypoint: string;
}): LiveProcessIdentity {
  const { pid, expectedListen, expectedPaseoHome, expectedSupervisorEntrypoint } = input;
  if (!isRunning(pid)) return stoppedIdentity();

  const commandLine = inspectRequired("ps", ["-p", String(pid), "-o", "command="], "command");
  const processStartedAt = inspectRequired("ps", ["-p", String(pid), "-o", "lstart="], "start time");
  const uidText = inspectRequired("ps", ["-p", String(pid), "-o", "uid="], "uid");
  const marker = inspectOwnershipMarker({
    pid,
    expectedListen,
    expectedPaseoHome,
    expectedSupervisorEntrypoint,
  });
  const parsedStart = new Date(processStartedAt);
  const uid = Number(uidText);
  if (!Number.isInteger(uid)) {
    throw new Error(`Cannot safely inspect UID for isolated supervisor PID ${pid}; refusing ownership`);
  }

  return {
    running: true,
    startedAt: Number.isNaN(parsedStart.getTime()) ? null : parsedStart.toISOString(),
    hostname: hostname(),
    uid,
    commandLine,
    paseoHomeMatches: marker.paseoHomeMatches,
    supervisorEntrypointMatches: marker.supervisorEntrypointMatches,
    desktopManagedMarkerMatches: marker.desktopManagedMatches,
    listener: inspectListener(expectedListen, pid),
  };
}

export function assertStopAuthorization(input: {
  lock: PidLockIdentity;
  expectedListen: string;
  expectedPaseoHome: string;
  expectedSupervisorEntrypoint: string;
  live: LiveProcessIdentity;
}): void {
  const {
    lock,
    expectedListen,
    expectedPaseoHome: _expectedPaseoHome,
    expectedSupervisorEntrypoint: _expectedSupervisorEntrypoint,
    live,
  } = input;
  const refuse = (reason: string): never => {
    throw new Error(
      `Refusing to stop PID ${lock.pid}: ${reason}. The isolated PID lock may be stale or reused; ` +
        "remove it only after confirming the original process is gone.",
    );
  };
  if (!live.running) refuse("the recorded process is not running");
  if (lock.listen !== null && lock.listen !== expectedListen) {
    refuse(`lock endpoint ${lock.listen} does not match isolated endpoint ${expectedListen}`);
  }
  if (lock.hostname !== live.hostname) {
    refuse(`lock hostname ${lock.hostname} does not match local hostname ${live.hostname}`);
  }
  if (live.uid === null) refuse("the live process UID cannot be verified on this platform");
  if (lock.uid !== live.uid) refuse(`lock uid ${lock.uid} does not match live process uid ${live.uid}`);
  if (lock.desktopManaged !== true) refuse("lock is not marked desktopManaged");
  if (!live.desktopManagedMarkerMatches) {
    refuse("live supervisor ownership marker is not desktopManaged=true");
  }
  if (!live.paseoHomeMatches) {
    refuse("live supervisor PASEO_HOME does not match the expected isolated home");
  }
  if (!live.supervisorEntrypointMatches) {
    refuse("live supervisor does not carry the exact pinned entrypoint marker");
  }
  const liveStartedAt = live.startedAt;
  if (!liveStartedAt) return refuse("live process start time cannot be verified");
  const lockAcquisitionDelay = Date.parse(lock.startedAt) - Date.parse(liveStartedAt);
  if (
    !Number.isFinite(lockAcquisitionDelay) ||
    lockAcquisitionDelay < 0 ||
    lockAcquisitionDelay > PID_LOCK_ACQUISITION_MAX_DELAY_MS
  ) {
    refuse(
      `lock start ${lock.startedAt} does not follow live process start ${liveStartedAt} ` +
        `within ${PID_LOCK_ACQUISITION_MAX_DELAY_MS}ms`,
    );
  }
  if (live.commandLine !== "Paseo Supervisor") {
    refuse(`live command is not exactly the pinned Paseo supervisor identity (${live.commandLine || "empty"})`);
  }
  const listener = live.listener;
  if (!listener) {
    return refuse(`no live daemon worker listens on isolated endpoint ${expectedListen}`);
  }
  if (listener.address !== expectedListen) {
    refuse(`live daemon worker listens on ${listener.address}, not ${expectedListen}`);
  }
  if (listener.pid === lock.pid) {
    refuse("isolated endpoint is owned by the supervisor rather than its daemon worker");
  }
  if (!listener.belongsToSupervisor) {
    refuse(`listener PID ${listener.pid} does not belong to the locked supervisor process tree`);
  }
}

function inspectListener(expectedListen: string, supervisorPid: number): LiveListenerIdentity | null {
  const port = expectedListen.slice(expectedListen.lastIndexOf(":") + 1);
  const inspected = spawnSync(
    "lsof",
    ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
    { encoding: "utf8" },
  );
  if (inspected.error) {
    throw new Error("Cannot safely inspect the isolated listener with lsof; refusing ownership");
  }
  if (inspected.status === 1 && inspected.stdout.trim() === "") return null;
  if (inspected.status !== 0) {
    throw new Error(`Cannot safely inspect the isolated listener (lsof status ${inspected.status})`);
  }
  const listeners = parseLsofListeners(inspected.stdout);
  const matching = listeners.filter((listener) => listenerAddressMatchesExpected(listener.address, expectedListen));
  if (matching.length !== 1) return null;
  const listener = matching[0];
  if (!listener) return null;
  return {
    ...listener,
    address: expectedListen,
    belongsToSupervisor: isProcessDescendant(listener.pid, supervisorPid),
  };
}

export function listenerAddressMatchesExpected(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const separator = expected.lastIndexOf(":");
  if (separator < 0 || expected.slice(0, separator) !== "0.0.0.0") return false;
  return actual === `*:${expected.slice(separator + 1)}`;
}

function parseLsofListeners(output: string): Array<{ pid: number; address: string }> {
  const results: Array<{ pid: number; address: string }> = [];
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      results.push({ pid, address: line.slice(1) });
    }
  }
  return results;
}

function isProcessDescendant(candidatePid: number, ancestorPid: number): boolean {
  let current = candidatePid;
  const visited = new Set<number>();
  while (current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true;
    visited.add(current);
    const parentText = inspectRequired("ps", ["-p", String(current), "-o", "ppid="], "process tree");
    const parent = Number(parentText);
    if (!Number.isInteger(parent)) {
      throw new Error(`Cannot safely inspect parent PID for listener ${candidatePid}`);
    }
    current = parent;
  }
  return false;
}

function inspectOwnershipMarker(input: {
  pid: number;
  expectedListen: string;
  expectedPaseoHome: string;
  expectedSupervisorEntrypoint: string;
}): {
  paseoHomeMatches: boolean;
  supervisorEntrypointMatches: boolean;
  desktopManagedMatches: boolean;
} {
  const markerPath = path.join(input.expectedPaseoHome, "meetless-supervisor-owner.json");
  let canonicalMarkerPath: string;
  try {
    canonicalMarkerPath = realpathSync(markerPath);
  } catch {
    return {
      paseoHomeMatches: false,
      supervisorEntrypointMatches: false,
      desktopManagedMatches: false,
    };
  }
  const inspected = spawnSync("lsof", ["-nP", "-a", "-p", String(input.pid), "-Fn"], {
    encoding: "utf8",
  });
  if (inspected.error || inspected.status !== 0) {
    throw new Error("Cannot safely inspect the isolated supervisor ownership marker; refusing ownership");
  }
  const holdsExactMarker = inspected.stdout
    .split("\n")
    .some((line) => line === `n${canonicalMarkerPath}`);
  if (!holdsExactMarker) {
    return {
      paseoHomeMatches: false,
      supervisorEntrypointMatches: false,
      desktopManagedMatches: false,
    };
  }
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      paseoHomeMatches: false,
      supervisorEntrypointMatches: false,
      desktopManagedMatches: false,
    };
  }
  return {
    paseoHomeMatches: marker.paseoHome === input.expectedPaseoHome && marker.listen === input.expectedListen,
    supervisorEntrypointMatches:
      marker.supervisorEntrypoint === input.expectedSupervisorEntrypoint,
    desktopManagedMatches: marker.desktopManaged === true,
  };
}

function inspectRequired(command: string, args: string[], fact: string): string {
  const inspected = spawnSync(command, args, { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`Cannot safely inspect live supervisor ${fact}; refusing ownership`);
  }
  return inspected.stdout.trim();
}

function stoppedIdentity(): LiveProcessIdentity {
  return {
    running: false,
    startedAt: null,
    hostname: hostname(),
    uid: null,
    commandLine: "",
    paseoHomeMatches: false,
    supervisorEntrypointMatches: false,
    desktopManagedMarkerMatches: false,
    listener: null,
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
