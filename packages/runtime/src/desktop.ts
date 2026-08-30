import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "./config.js";
import { copyEnvironmentWithoutDirectPasswordSecrets, prepareRuntime, REPOSITORY_ROOT } from "./config.js";
import { assertDesktopLaunchedByHost, assertSupervisorOwnedByHost } from "./host.js";
import { assertStopAuthorization, inspectLiveProcess, readPidLock } from "./lifecycle.js";
import { activateUiTestRun, removeUiTestRunState } from "./ui-test-envelope.js";

const rendererAbortListeners = new WeakMap<Server, { signal: AbortSignal; listener: () => void }>();
const capturePermissionIntentHeader = "x-meetless-permission-intent";
const capturePermissionIntentLifetimeMs = 5_000;

export function buildRendererUrl(config: RuntimeConfig): string {
  const configured = process.env.MEETLESS_RENDERER_URL?.trim();
  const url = new URL(configured || config.rendererOrigin);
  if (url.origin !== config.rendererOrigin) {
    throw new Error(
      `Meetless renderer URL origin ${url.origin} does not match isolated allowed origin ${config.rendererOrigin}`,
    );
  }
  url.searchParams.set("daemon", localDaemonWebSocketUrl(config.listen));
  if (config.environment.MEETLESS_UI_TEST_MODE === "1" && config.environment.MEETLESS_UI_TEST_RUN_ID) {
    url.searchParams.set("uiTestRunId", config.environment.MEETLESS_UI_TEST_RUN_ID);
    url.searchParams.set("uiTestDesktopId", "com.meetless.desktop");
  }
  return url.toString();
}

export function localDaemonWebSocketUrl(listen: string): string {
  const destination = listen.startsWith("0.0.0.0:")
    ? `127.0.0.1:${listen.slice("0.0.0.0:".length)}`
    : listen;
  return `ws://${destination}/ws`;
}

export async function runMeetlessDesktop(config: RuntimeConfig): Promise<number> {
  const owned = new HostOwnedRuntimeShutdown(config);
  const shutdown = owned.signals;
  let daemonChild: ChildProcess | null = null;
  let renderer: ChildProcess | null = null;
  let rendererServer: Server | null = null;
  let electron: ChildProcess | null = null;
  let daemonOwned = false;
  let hostAttested = false;
  try {
    const hostIdentity = await assertDesktopLaunchedByHost(config);
    hostAttested = true;
    const uiTest = await activateUiTestRun(config, hostIdentity);
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
      `Meetless ${uiTest ? `controlled ${uiTest.transcriptionMode}` : "production"} recorder instance ` +
        `${recorder.runtime.instanceId} answered authoritative status: ${recorder.status.status}.\n`,
    );

    const rendererUrl = buildRendererUrl(config);
    const nonSecretChildEnvironment = copyEnvironmentWithoutDirectPasswordSecrets(config.environment);
    if (config.packaged) {
      rendererServer = await startPackagedRenderer(config, shutdown.signal);
      await waitForHttp(config.rendererOrigin, null, shutdown.signal);
    } else if (!process.env.MEETLESS_RENDERER_URL) {
      const appPort = new URL(config.rendererOrigin).port;
      renderer = spawn(
        process.execPath,
        [path.join(REPOSITORY_ROOT, "node_modules", "expo", "bin", "cli"), "start", "--web", "--port", appPort],
        {
          cwd: path.join(REPOSITORY_ROOT, "packages", "meetless-app"),
          env: {
            ...nonSecretChildEnvironment,
            CI: "1",
            EXPO_PUBLIC_MEETLESS_DAEMON_URL: localDaemonWebSocketUrl(config.listen),
          },
          stdio: "inherit",
          detached: true,
        },
      );
      await owned.track("renderer", renderer);
      await waitForHttp(config.rendererOrigin, renderer, shutdown.signal);
    }

    const bootstrap = path.join(REPOSITORY_ROOT, "scripts/electron-bootstrap.mjs");
    const electronCommand = config.packageResources?.electronBinary ?? process.execPath;
    const electronArguments = config.packaged
      ? [bootstrap]
      : [fileURLToPath(import.meta.resolve("electron/cli.js")), bootstrap];
    electron = spawn(electronCommand, electronArguments, {
      cwd: REPOSITORY_ROOT,
      env: {
        ...nonSecretChildEnvironment,
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
    await closeRendererServer(rendererServer);
    if (hostAttested) await owned.shutdown({ daemonChild, daemonOwned });
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
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. Inspect only the repo-owned tree before retrying.",
      );
    }
    await removeUiTestRunState(this.config.paths.root);
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

export interface CapturePermissionBoundaryOptions {
  nativeRequest?: typeof nativeCapturePermissionRequest;
  now?: () => number;
}

async function startPackagedRenderer(
  config: RuntimeConfig,
  signal: AbortSignal,
  boundaryOptions: CapturePermissionBoundaryOptions = {},
): Promise<Server> {
  const rendererRoot = config.packageResources?.rendererRoot;
  if (!rendererRoot) {
    throw new Error(
      "Packaged Meetless renderer resource is unavailable. Authority: docs/specs/macos-artifact-validation.md. " +
        "Next action: rebuild the complete macOS package; packaged mode does not start an Expo or repository renderer.",
    );
  }
  const indexPath = path.join(rendererRoot, "index.html");
  if (!(await stat(indexPath).catch(() => null))?.isFile()) {
    throw new Error(
      `Packaged Meetless renderer entry is missing: ${indexPath}. Authority: docs/specs/macos-artifact-validation.md. ` +
        "Next action: rebuild the emitted renderer before launching the package.",
    );
  }
  const origin = new URL(config.rendererOrigin);
  const port = Number(origin.port);
  const host = origin.hostname === "localhost" ? "127.0.0.1" : origin.hostname.replace(/^\[|\]$/gu, "");
  const permissionBoundary = createCapturePermissionBoundary(
    origin,
    config.paths?.transcriptionSocket,
    boundaryOptions,
  );
  const server = createServer((request, response) => {
    void servePackagedRendererRequest(rendererRoot, request, response, permissionBoundary);
  });
  let aborted = signal.aborted;
  const closeOnAbort = () => {
    aborted = true;
    if (server.listening) server.close();
  };
  signal.addEventListener("abort", closeOnAbort);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      if (aborted) {
        server.close();
        reject(new Error("Packaged Meetless renderer start was aborted after listener registration"));
        return;
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  }).catch((error) => {
    signal.removeEventListener("abort", closeOnAbort);
    if (server.listening) server.close();
    throw new Error(
      `Packaged Meetless renderer could not bind ${origin}: ${describe(error)}. ` +
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. Next action: use the package's isolated renderer endpoint.",
    );
  });
  rendererAbortListeners.set(server, { signal, listener: closeOnAbort });
  if (signal.aborted) {
    await closeRendererServer(server);
    signal.throwIfAborted();
  }
  return server;
}

export async function startPackagedRendererForTest(
  rendererRoot: string,
  rendererOrigin: string,
  signal: AbortSignal,
  options: CapturePermissionBoundaryOptions & { nativeSocket?: string } = {},
): Promise<Server> {
  return startPackagedRenderer({
    packageResources: { rendererRoot } as RuntimeConfig["packageResources"],
    rendererOrigin,
    paths: { transcriptionSocket: options.nativeSocket } as RuntimeConfig["paths"],
  } as RuntimeConfig, signal, options);
}

export async function closePackagedRendererForTest(server: Server): Promise<void> {
  await closeRendererServer(server);
}

async function servePackagedRendererRequest(
  rendererRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
  permissionBoundary: CapturePermissionBoundary,
): Promise<void> {
  const requestUrl = request.url ?? "/";
  const method = request.method ?? "GET";
  if (requestUrl.startsWith("/__meetless/capture-permissions")) {
    await serveCapturePermissionRequest(request, response, permissionBoundary);
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  const candidate = path.resolve(rendererRoot, `.${pathname}`);
  const relative = path.relative(rendererRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const inspected = await stat(candidate).catch(() => null);
  const filePath = inspected?.isFile()
    ? candidate
    : inspected?.isDirectory()
    ? path.join(candidate, "index.html")
    : path.join(rendererRoot, "index.html");
  const file = await readFile(filePath).catch(() => null);
  if (!file) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": contentType(filePath), "Content-Length": file.byteLength });
  if (method === "HEAD") response.end();
  else response.end(file);
}

type CapturePermissionOperation = "capturePermissionStatus" | "capturePermissionRequest" | "capturePermissionSettings";

interface CapturePermissionBoundary {
  rendererOrigin: URL;
  nativeSocket?: string;
  nativeRequest: typeof nativeCapturePermissionRequest;
  now: () => number;
  intents: Map<string, number>;
}

function createCapturePermissionBoundary(
  rendererOrigin: URL,
  nativeSocket: string | undefined,
  options: CapturePermissionBoundaryOptions,
): CapturePermissionBoundary {
  return {
    rendererOrigin,
    nativeSocket,
    nativeRequest: options.nativeRequest ?? nativeCapturePermissionRequest,
    now: options.now ?? Date.now,
    intents: new Map(),
  };
}

async function serveCapturePermissionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  boundary: CapturePermissionBoundary,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", boundary.rendererOrigin);
  const noStoreHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const statusPath = "/__meetless/capture-permissions";
  const intentPath = `${statusPath}/intent`;
  const requestPath = `${statusPath}/request`;
  const settingsPath = `${statusPath}/settings`;

  if (url.pathname === statusPath) {
    if (method !== "GET" || url.searchParams.size !== 0) {
      respondJson(response, 405, { error: "capture permission status accepts GET only" }, noStoreHeaders);
      return;
    }
    if (!boundary.nativeSocket) {
      respondJson(response, 503, { error: "capture permission boundary unavailable" }, noStoreHeaders);
      return;
    }
    await invokeCapturePermissionBoundary(response, boundary, "capturePermissionStatus", null);
    return;
  }

  if (url.pathname === intentPath) {
    if (method !== "POST" || url.searchParams.size !== 0 || !isTrustedRendererMutation(request, boundary)) {
      respondJson(response, 403, { error: "trusted renderer intent required" }, noStoreHeaders);
      return;
    }
    const now = boundary.now();
    removeExpiredIntents(boundary, now);
    const intentToken = randomUUID();
    const expiresAt = now + capturePermissionIntentLifetimeMs;
    boundary.intents.set(intentToken, expiresAt);
    respondJson(response, 200, { intentToken, expiresAt }, noStoreHeaders);
    return;
  }

  if (url.pathname !== requestPath && url.pathname !== settingsPath) {
    respondJson(response, 404, { error: "capture permission route not found" }, noStoreHeaders);
    return;
  }
  if (method !== "POST" || !isTrustedRendererMutation(request, boundary)) {
    respondJson(response, 403, { error: "trusted renderer mutation required" }, noStoreHeaders);
    return;
  }
  const token = singleHeader(request, capturePermissionIntentHeader);
  if (!token || !consumeFreshIntent(boundary, token)) {
    respondJson(response, 409, { error: "fresh one-use permission intent required" }, noStoreHeaders);
    return;
  }
  if (!boundary.nativeSocket) {
    respondJson(response, 503, { error: "capture permission boundary unavailable" }, noStoreHeaders);
    return;
  }

  if (url.pathname === requestPath) {
    if (url.searchParams.size !== 0) {
      respondJson(response, 400, { error: "capture permission request source is not accepted" }, noStoreHeaders);
      return;
    }
    await invokeCapturePermissionBoundary(response, boundary, "capturePermissionRequest", null);
    return;
  }

  const sources = url.searchParams.getAll("source");
  const source = sources.length === 1 ? sources[0] : null;
  if (url.searchParams.size !== 1 || (source !== "microphone" && source !== "systemAudio")) {
    respondJson(response, 400, { error: "capture permission settings source is invalid" }, noStoreHeaders);
    return;
  }
  await invokeCapturePermissionBoundary(response, boundary, "capturePermissionSettings", source);
}

function isTrustedRendererMutation(request: IncomingMessage, boundary: CapturePermissionBoundary): boolean {
  const contentType = singleHeader(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return singleHeader(request, "host") === boundary.rendererOrigin.host
    && singleHeader(request, "origin") === boundary.rendererOrigin.origin
    && contentType === "application/json";
}

function singleHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function removeExpiredIntents(boundary: CapturePermissionBoundary, now: number): void {
  for (const [token, expiresAt] of boundary.intents) if (expiresAt <= now) boundary.intents.delete(token);
}

function consumeFreshIntent(boundary: CapturePermissionBoundary, token: string): boolean {
  const expiresAt = boundary.intents.get(token);
  boundary.intents.delete(token);
  return expiresAt !== undefined && expiresAt > boundary.now();
}

async function invokeCapturePermissionBoundary(
  response: ServerResponse,
  boundary: CapturePermissionBoundary,
  operation: CapturePermissionOperation,
  source: string | null,
): Promise<void> {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  try {
    const result = await boundary.nativeRequest(boundary.nativeSocket!, operation, source);
    respondJson(response, 200, result, headers);
  } catch (error) {
    respondJson(response, 503, { error: describe(error) }, headers);
  }
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void {
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

export function nativeCapturePermissionRequest(
  socketPath: string,
  operation: CapturePermissionOperation,
  source: string | null = null,
): Promise<unknown> {
  const requestId = randomUUID();
  const payload = JSON.stringify({ version: 1, requestId, operation, ...(source ? { source } : {}) });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${payload}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        const decoded = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        if (decoded.requestId !== requestId || decoded.type !== "capture.permissions" || decoded.ok !== true) {
          throw new Error("native capture permission response is invalid");
        }
        resolve(decoded);
      } catch (error) { reject(error); }
    });
  });
}

function contentType(filePath: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  } as Record<string, string>)[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function closeRendererServer(server: Server | null): Promise<void> {
  if (!server) return;
  const abortRegistration = rendererAbortListeners.get(server);
  if (abortRegistration) {
    rendererAbortListeners.delete(server);
    abortRegistration.signal.removeEventListener("abort", abortRegistration.listener);
  }
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForHttp(origin: string, child: ChildProcess | null, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child && child.exitCode !== null) throw new Error(`Meetless renderer exited during startup (${child.exitCode})`);
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
