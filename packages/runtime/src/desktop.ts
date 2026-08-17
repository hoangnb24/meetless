import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "./config.js";
import { prepareRuntime, REPOSITORY_ROOT } from "./config.js";
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
  await prepareRuntime(config);
  const { waitForRecordingRuntime } = await import("./readiness.js");
  await writeDesktopSettings(config.paths.electronUserData);
  const owned: ChildProcess[] = [];
  let daemonOwned = false;
  try {
    let lock = await readPidLock(config.paths.pidLock);
    if (lock && processIsRunning(lock.pid)) {
      authorizeOwnedDaemon(config, lock);
    } else {
      const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
      const daemon = spawn(process.execPath, [cliPath, "daemon"], {
        cwd: REPOSITORY_ROOT,
        env: config.environment,
        stdio: "inherit",
      });
      owned.push(daemon);
      daemonOwned = true;
      lock = await waitForDaemon(config, daemon);
    }

    const recorder = await waitForRecordingRuntime(config);
    process.stdout.write(
      `Meetless production recorder answered authoritative status: ${recorder.status}.\n`,
    );

    const rendererUrl = buildRendererUrl(config);
    if (!process.env.MEETLESS_RENDERER_URL) {
      const appPort = new URL(config.rendererOrigin).port;
      const renderer = spawn(
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
      owned.push(renderer);
      await waitForHttp(config.rendererOrigin, renderer);
    }

    const electronCli = fileURLToPath(import.meta.resolve("electron/cli.js"));
    const bootstrap = path.join(REPOSITORY_ROOT, "scripts/electron-bootstrap.mjs");
    const electron = spawn(process.execPath, [electronCli, bootstrap], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...config.environment,
        EXPO_DEV_URL: rendererUrl,
        PASEO_TEST_APP_NAME: "Meetless",
      },
      stdio: "inherit",
    });
    owned.push(electron);
    const result = await waitForExit(electron);
    return result.code ?? (result.signal ? 1 : 0);
  } finally {
    if (daemonOwned) {
      const lock = await readPidLock(config.paths.pidLock).catch(() => null);
      if (lock && processIsRunning(lock.pid)) {
        authorizeOwnedDaemon(config, lock);
        process.kill(lock.pid, "SIGTERM");
      }
    }
    for (const child of [...owned].reverse()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.all(owned.map((child) => waitForExit(child, 8_000).catch(() => undefined)));
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

async function waitForDaemon(config: RuntimeConfig, child: ChildProcess): Promise<NonNullable<Awaited<ReturnType<typeof readPidLock>>>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Meetless daemon exited during startup (${child.exitCode})`);
    const lock = await readPidLock(config.paths.pidLock).catch(() => null);
    if (lock?.listen === config.listen && processIsRunning(lock.pid)) return lock;
    await delay(100);
  }
  throw new Error(`Timed out starting isolated Meetless daemon at ${config.listen}`);
}

async function waitForHttp(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Meetless renderer exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Expo has not bound its HTTP listener yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out starting Meetless renderer at ${origin}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs?: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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
