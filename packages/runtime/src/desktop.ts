import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const owned = new HostOwnedRuntimeShutdown(config);
  const shutdown = owned.signals;
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
      await owned.track("daemon", daemonChild);
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
        process.execPath,
        [path.join(REPOSITORY_ROOT, "node_modules", "expo", "bin", "cli"), "start", "--web", "--port", appPort],
        {
          cwd: path.join(REPOSITORY_ROOT, "packages", "meetless-app"),
          env: {
            ...config.environment,
            CI: "1",
            EXPO_PUBLIC_MEETLESS_DAEMON_URL: `ws://${config.listen}/ws`,
          },
          stdio: "inherit",
          detached: true,
        },
      );
      await owned.track("renderer", renderer);
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
      detached: true,
    });
    await owned.track("electron", electron);
    const result = await Promise.race([waitForExit(electron), waitForShutdown(shutdown.signal)]);
    return result.code ?? (result.signal ? 1 : 0);
  } finally {
    shutdown.dispose();
    await owned.shutdown({ daemonChild, daemonOwned });
  }
}

type OwnedGroupName = "daemon" | "renderer" | "electron";

interface ShutdownInspection {
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  groupRunning(pgid: number): boolean;
  listenerExists(port: string): boolean;
  socketExists(socketPath: string): Promise<boolean>;
  delay(milliseconds: number): Promise<void>;
}

const systemShutdownInspection: ShutdownInspection = {
  signalGroup: (pgid, signal) => {
    try { process.kill(-pgid, signal); } catch (error) {
      if (!isErrno(error, "ESRCH")) throw error;
    }
  },
  groupRunning: (pgid) => {
    try { process.kill(-pgid, 0); return true; } catch (error) {
      if (isErrno(error, "ESRCH")) return false;
      throw new Error(`Cannot inspect owned process group ${pgid}: ${describe(error)}`);
    }
  },
  listenerExists: (port) => {
    const inspected = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
    if (inspected.error) throw new Error(`Cannot inspect listener ${port}: ${inspected.error.message}`);
    if (inspected.status === 1 && inspected.stdout.trim() === "") return false;
    if (inspected.status !== 0) {
      throw new Error(`Cannot inspect listener ${port}: lsof exited ${inspected.status} (${inspected.stderr.trim()})`);
    }
    return inspected.stdout.trim().length > 0;
  },
  socketExists: async (socketPath) => {
    try { await stat(socketPath); return true; } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw new Error(`Cannot inspect recording socket ${socketPath}: ${describe(error)}`);
    }
  },
  delay,
};

export class HostOwnedRuntimeShutdown {
  readonly signals = installShutdownHandlers();
  private readonly groups = new Map<OwnedGroupName, number>();
  private readonly registryPath: string;
  private closing = false;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly inspection: ShutdownInspection = systemShutdownInspection,
  ) {
    this.registryPath = path.join(config.paths.root, "owned-process-groups.json");
  }

  async track(name: OwnedGroupName, child: ChildProcess): Promise<void> {
    if (!child.pid) throw new Error(`Cannot own ${name}: spawned process has no PID`);
    this.groups.set(name, child.pid);
    await this.writeRegistry();
    this.signals.signal.throwIfAborted();
  }

  async shutdown(input: { daemonChild: ChildProcess | null; daemonOwned: boolean }): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    let gracefulError: unknown;
    try {
      this.signal("electron", "SIGTERM");
      this.signal("renderer", "SIGTERM");

      if (input.daemonOwned && input.daemonChild?.pid) {
        const lock = await readPidLock(this.config.paths.pidLock).catch((error) => {
          throw new Error(`Cannot inspect owned daemon PID lock during shutdown: ${describe(error)}`);
        });
        if (lock && processIsRunning(lock.pid)) {
          authorizeOwnedDaemon(this.config, lock);
          process.kill(lock.pid, "SIGTERM");
        } else {
          this.signal("daemon", "SIGTERM");
        }
      }
    } catch (error) {
      gracefulError = error;
    }

    let released = false;
    try { released = await this.waitForRelease(15_000); } catch (error) { gracefulError ??= error; }
    if (!released) {
      try {
        for (const pgid of this.groups.values()) this.inspection.signalGroup(pgid, "SIGKILL");
      } catch (error) {
        gracefulError ??= error;
      }
      try { released = await this.waitForRelease(5_000); } catch (error) { gracefulError ??= error; }
    }
    if (!released || gracefulError) {
      throw new Error(
        `MeetlessHost shutdown failed closed: ${describe(gracefulError ?? "owned runtime did not release")}. ` +
        `Expected no owned process groups, listeners ${this.listenerPorts().join("/")}, or socket ${this.config.paths.recordingSocket}. ` +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Inspect only the repo-owned tree before retrying.",
      );
    }
    await rm(this.registryPath, { force: true });
  }

  private signal(name: OwnedGroupName, signal: NodeJS.Signals): void {
    const pgid = this.groups.get(name);
    if (pgid) this.inspection.signalGroup(pgid, signal);
  }

  private async waitForRelease(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.released()) return true;
      await this.inspection.delay(100);
    }
    return this.released();
  }

  private async released(): Promise<boolean> {
    if ([...this.groups.values()].some((pgid) => this.inspection.groupRunning(pgid))) return false;
    for (const port of this.listenerPorts()) if (this.inspection.listenerExists(port)) return false;
    return !(await this.inspection.socketExists(this.config.paths.recordingSocket));
  }

  private listenerPorts(): string[] {
    return [
      this.config.listen.slice(this.config.listen.lastIndexOf(":") + 1),
      new URL(this.config.rendererOrigin).port,
    ];
  }

  private async writeRegistry(): Promise<void> {
    await mkdir(this.config.paths.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${process.pid}.tmp`;
    const hostPid = Number(process.env.MEETLESS_HOST_PID);
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      hostPid: Number.isInteger(hostPid) ? hostPid : null,
      desktopPid: process.pid,
      groups: [...this.groups.entries()].map(([name, pgid]) => ({ name, pgid })),
    })}\n`, { mode: 0o600 });
    await rename(temporary, this.registryPath);
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
    if (lock?.desktopManaged === true && processIsRunning(lock.pid)) {
      const live = inspectLiveProcess({
        pid: lock.pid,
        expectedListen: config.listen,
        expectedPaseoHome: config.paths.paseoHome,
        expectedSupervisorEntrypoint: config.supervisorEntrypoint,
      });
      if (live.listener?.address === config.listen && live.listener.belongsToSupervisor) return lock;
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw new Error(`Cannot inspect process ${pid}: ${describe(error)}`);
  }
}
