import { open, type FileHandle } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prepareRuntime, resolveRuntimeConfig, type RuntimeConfig } from "./config.js";
import { assertSupervisorOwnedByHost, attestPackagedProcess, isPackagedRuntime } from "./host.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";
import { activateUiTestRun } from "./ui-test-envelope.js";

let supervisorOwnershipMarker: FileHandle | undefined;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const config = resolveRuntimeConfig({
    runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT,
    listen: process.env.MEETLESS_LISTEN,
  });
  if (command === "daemon") {
    await assertPackagedDaemonOwnedByHost(config);
    await activateUiTestRun(config);
    await prepareRuntime(config);
    Object.assign(process.env, config.environment);
    supervisorOwnershipMarker = await open(config.paths.supervisorMarker, "w+", 0o600);
    await supervisorOwnershipMarker.writeFile(
      `${JSON.stringify({
        paseoHome: config.paths.paseoHome,
        supervisorEntrypoint: config.supervisorEntrypoint,
        listen: config.listen,
        desktopManaged: true,
      })}\n`,
    );
    await supervisorOwnershipMarker.sync();
    await import(pathToFileURL(config.supervisorEntrypoint).href);
    return;
  }
  if (command === "desktop") {
    const { runMeetlessDesktop } = await import("./desktop.js");
    process.exitCode = await runMeetlessDesktop(config);
    return;
  }
  if (command === "preowner") {
    if (isPackagedRuntime(config)) {
      throw new Error(
        "Packaged pre-owner readiness is owned by the attested Meetless desktop; direct packaged CLI ownership is rejected.",
      );
    }
    const lock = await readPidLock(config.paths.pidLock);
    if (!lock || !isRunning(lock.pid)) {
      throw new Error(
        "Production pre-owner readiness requires a live MeetlessHost-owned runtime. " +
        "Launch it with npm run runtime:host; direct npm runtime ownership is rejected. " +
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md.",
      );
    }
    const { assertSupervisorOwnedByHost } = await import("./host.js");
    const host = await assertSupervisorOwnedByHost(config, lock.pid);
    const {
      assertPreOwnerRecordingReady,
      inspectRuntimeReadiness,
      prepareCollisionEvidence,
      waitForRecordingRuntime,
    } = await import("./readiness.js");
    const status = await waitForRecordingRuntime(config, { timeoutMs: 10_000 });
    const inspected = await inspectRuntimeReadiness(config, status);
    assertPreOwnerRecordingReady(inspected);
    const report = await prepareCollisionEvidence(config, inspected);
    process.stdout.write(`${JSON.stringify({ ...report, host }, null, 2)}\n`);
    return;
  }
  const lock = await readPidLock(config.paths.pidLock);
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(
        {
          running: lock ? isRunning(lock.pid) : false,
          lock,
          listen: config.listen,
          rendererOrigin: config.rendererOrigin,
          supervisorEntrypoint: config.supervisorEntrypoint,
          paths: config.paths,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "stop") {
    if (isPackagedRuntime(config)) {
      throw new Error(
        "Packaged runtime shutdown is owned by the attested Meetless desktop; direct packaged CLI stop is rejected.",
      );
    }
    if (!lock || !isRunning(lock.pid)) {
      process.stdout.write("Meetless isolated daemon is not running.\n");
      return;
    }
    assertStopAuthorization({
      lock,
      expectedListen: config.listen,
      expectedPaseoHome: config.paths.paseoHome,
      expectedSupervisorEntrypoint: config.supervisorEntrypoint,
      live: inspectLiveProcess({
        pid: lock.pid,
        expectedListen: config.listen,
        expectedPaseoHome: config.paths.paseoHome,
        expectedSupervisorEntrypoint: config.supervisorEntrypoint,
      }),
    });
    process.kill(lock.pid, "SIGTERM");
    process.stdout.write(`Stopped isolated Meetless daemon PID ${lock.pid}.\n`);
    return;
  }
  throw new Error(`Unknown runtime command: ${command}`);
}

export async function assertPackagedDaemonOwnedByHost(
  config: RuntimeConfig,
  currentPid = process.pid,
  ownershipCheck: typeof assertSupervisorOwnedByHost = assertSupervisorOwnedByHost,
): Promise<void> {
  if (isPackagedRuntime(config)) {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await attestPackagedProcess(config, "daemon", currentPid);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("packaged daemon native attestation timed out");
  }
  if (config.packaged) await ownershipCheck(config, currentPid);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

void supervisorOwnershipMarker;
