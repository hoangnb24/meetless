import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "./config.js";
import { prepareRuntime, REPOSITORY_ROOT } from "./config.js";
import { assertDesktopLaunchedByHost, assertSupervisorOwnedByHost } from "./host.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";

export function buildRendererUrl(config: RuntimeConfig): string {
  const configured = process.env.MEETLESS_RENDERER_URL?.trim();
  const url = new URL(configured || config.rendererOrigin);
  if (url.origin !== config.rendererOrigin) {
    throw new Error(
      `Meetless renderer URL origin ${url.origin} does not match isolated allowed origin ${config.rendererOrigin}`,
    );
  }
  url.searchParams.set("daemon", `ws://${config.listen}/ws`);
  return url.toString();
}

export async function runMeetlessDesktop(config: RuntimeConfig): Promise<number> {
  const shutdown = installShutdownHandlers();
  let daemonChild: ChildProcess | null = null;
  let renderer: ChildProcess | null = null;
  let electron: ChildProcess | null = null;
  let daemonOwned = false;
  try {
    await assertDesktopLaunchedByHost(config);
    shutdown.signal.throwIfAborted();
    await prepareRuntime(config);
    const { waitForRecordingRuntime } = await import("./readiness.js");
    await writeDesktopSettings(config.paths.electronUserData);
    let lock = await readPidLock(config.paths.pidLock);
    if (lock && processIsRunning(lock.pid)) {
      authorizeOwnedDaemon(config, lock);
      await assertSupervisorOwnedByHost(config, lock.pid);
    } else {
      const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
      daemonChild = spawn(process.execPath, [cliPath, "daemon"], {
        cwd: REPOSITORY_ROOT,
        env: config.environment,
        stdio: "inherit",
        detached: true,
      });
      daemonOwned = true;
      lock = await waitForDaemon(config, daemonChild, shutdown.signal);
      await assertSupervisorOwnedByHost(config, lock.pid);
    }

    const recorder = await waitForRecordingRuntime(config, { signal: shutdown.signal });
    process.stdout.write(
      `Meetless production recorder instance ${recorder.runtime.instanceId} answered authoritative status: ${recorder.status.status}.\n`,
    );

    const rendererUrl = buildRendererUrl(config);
    if (!process.env.MEETLESS_RENDERER_URL) {
      const appPort = new URL(config.rendererOrigin).port;
      renderer = spawn(
        "npm",
        ["run", "start:web", "--workspace=@meetless/app", "--", "--port", appPort],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...config.environment,
            CI: "1",
            EXPO_PUBLIC_MEETLESS_DAEMON_URL: `ws://${config.listen}/ws`,
          },
          stdio: "inherit",
        },
      );
      await waitForHttp(config.rendererOrigin, renderer, shutdown.signal);
    }

    const electronCli = fileURLToPath(import.meta.resolve("electron/cli.js"));
    const bootstrap = path.join(REPOSITORY_ROOT, "scripts/electron-bootstrap.mjs");
    electron = spawn(process.execPath, [electronCli, bootstrap], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...config.environment,
        EXPO_DEV_URL: rendererUrl,
        PASEO_TEST_APP_NAME: "Meetless",
      },
      stdio: "inherit",
    });
    const result = await Promise.race([waitForExit(electron), waitForShutdown(shutdown.signal)]);
    return result.code ?? (result.signal ? 1 : 0);
  } finally {
    shutdown.dispose();
    await terminateChild(electron, 5_000);
    await terminateChild(renderer, 5_000);
    if (daemonOwned) {
      const lock = await readPidLock(config.paths.pidLock).catch(() => null);
      if (lock && processIsRunning(lock.pid)) {
        authorizeOwnedDaemon(config, lock);
        process.kill(lock.pid, "SIGTERM");
        const released = await waitForRuntimeRelease(config, lock.pid, 15_000);
        if (!released && daemonChild?.pid) {
          try { process.kill(-daemonChild.pid, "SIGKILL"); } catch { /* already exited */ }
          await waitForRuntimeRelease(config, lock.pid, 5_000);
        }
      }
    }
    await waitForExit(daemonChild, 1_000).catch(() => undefined);
    if (daemonOwned && !(await runtimeReleased(config))) {
      throw new Error(
        `MeetlessHost shutdown failed closed: owned runtime still holds ${config.listen} or ${config.paths.recordingSocket}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Inspect the repo-owned process tree before retrying.",
      );
    }
  }
}

async function writeDesktopSettings(userData: string): Promise<void> {
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(userData, "desktop-settings.json"),
    `${JSON.stringify(
      {
        version: 1,
        settings: {
          releaseChannel: "stable",
          notifications: { playSound: false },
          daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
        },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function waitForDaemon(config: RuntimeConfig, child: ChildProcess, signal: AbortSignal): Promise<NonNullable<Awaited<ReturnType<typeof readPidLock>>>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null) throw new Error(`Meetless daemon exited during startup (${child.exitCode})`);
    const lock = await readPidLock(config.paths.pidLock).catch(() => null);
    if (lock?.listen === config.listen && processIsRunning(lock.pid)) return lock;
    await delay(100);
  }
  throw new Error(`Timed out starting isolated Meetless daemon at ${config.listen}`);
}

async function waitForHttp(origin: string, child: ChildProcess, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null) throw new Error(`Meetless renderer exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(origin, { signal });
      if (response.ok) return;
    } catch {
      // Expo has not bound its HTTP listener yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out starting Meetless renderer at ${origin}`);
}

async function waitForExit(
  child: ChildProcess | null,
  timeoutMs?: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (!child) return { code: 0, signal: null };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => reject(new Error(`Timed out waiting for PID ${child.pid ?? "unknown"}`)), timeoutMs)
      : null;
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function installShutdownHandlers(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => controller.abort(new Error(`Meetless desktop received ${name}`));
    handlers.set(name, handler);
    process.once(name, handler);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [name, handler] of handlers) process.off(name, handler);
    },
  };
}

function waitForShutdown(signal: AbortSignal): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const finish = () => resolve({ code: 0, signal: null });
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

async function terminateChild(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, timeoutMs).then(() => true, () => false)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000).catch(() => undefined);
}

async function waitForRuntimeRelease(config: RuntimeConfig, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid) && await runtimeReleased(config)) return true;
    await delay(100);
  }
  return !processIsRunning(pid) && await runtimeReleased(config);
}

async function runtimeReleased(config: RuntimeConfig): Promise<boolean> {
  const socketExists = await stat(config.paths.recordingSocket).then(() => true, () => false);
  const port = config.listen.slice(config.listen.lastIndexOf(":") + 1);
  const listener = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  const listenerExists = listener.status === 0 && listener.stdout.trim().length > 0;
  return !socketExists && !listenerExists;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authorizeOwnedDaemon(
  config: RuntimeConfig,
  lock: NonNullable<Awaited<ReturnType<typeof readPidLock>>>,
): void {
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
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
