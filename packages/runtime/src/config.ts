import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PINNED_PASEO_COMMIT = "ee3420e80d93f7f0c875fcd45e816a5a9d06188f";
export const DEFAULT_MEETLESS_LISTEN = "127.0.0.1:6777";
const DARWIN_UNIX_SOCKET_PATH_BYTES = 103;

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(packageDirectory, "../../..");

export interface RuntimePaths {
  root: string;
  paseoHome: string;
  electronUserData: string;
  meetingStore: string;
  logs: string;
  daemonLog: string;
  identity: string;
  pidLock: string;
  supervisorMarker: string;
  config: string;
  manifest: string;
  plugin: string;
  captureHelper: string;
  recordingSocket: string;
  transcriptionSocket: string;
  transcriptionStaging: string;
  recordingExports: string;
}

export interface RuntimeConfig {
  listen: string;
  rendererOrigin: string;
  supervisorEntrypoint: string;
  paths: RuntimePaths;
  host: {
    bundle: string;
    identity: string;
  };
  environment: NodeJS.ProcessEnv;
}

export class IsolationViolationError extends Error {
  constructor(message: string) {
    super(
      `${message} (authority: docs/plans/active/v1-paseo-foundation.md, decision 2026-08-16). ` +
        "Choose an isolated Meetless runtime root and a non-6767 loopback endpoint.",
    );
    this.name = "IsolationViolationError";
  }
}

export function resolveRuntimeConfig(input: {
  runtimeRoot?: string;
  listen?: string;
  userHome?: string;
  repositoryRoot?: string;
  rendererOrigin?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): RuntimeConfig {
  const sourceEnvironment = input.environment ?? process.env;
  const userHome = path.resolve(input.userHome ?? homedir());
  const repositoryRoot = path.resolve(input.repositoryRoot ?? REPOSITORY_ROOT);
  const root = path.resolve(input.runtimeRoot ?? path.join(repositoryRoot, ".meetless-runtime"));
  const listen = (input.listen ?? DEFAULT_MEETLESS_LISTEN).trim();
  const rendererOrigin = resolveRendererOrigin(
    input.rendererOrigin ?? sourceEnvironment.MEETLESS_RENDERER_ORIGIN ?? "http://127.0.0.1:8082",
  );
  const supervisorEntrypoint = path.join(
    repositoryRoot,
    "vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  const paths: RuntimePaths = {
    root,
    paseoHome: path.join(root, "paseo-home"),
    electronUserData: path.join(root, "electron-user-data"),
    meetingStore: path.join(root, "meeting-store"),
    logs: path.join(root, "logs"),
    daemonLog: path.join(root, "logs", "daemon.log"),
    identity: path.join(root, "paseo-home", "server-id"),
    pidLock: path.join(root, "paseo-home", "paseo.pid"),
    supervisorMarker: path.join(root, "paseo-home", "meetless-supervisor-owner.json"),
    config: path.join(root, "paseo-home", "config.json"),
    manifest: path.join(root, "runtime.json"),
    plugin: path.join(repositoryRoot, "packages", "meetless-plugin"),
    captureHelper: path.join(repositoryRoot, "native", "macos-capture", ".build", "release", "meetless-capture"),
    recordingSocket: resolveRecordingSocket(path.join(root, "paseo-home")),
    transcriptionSocket: path.join(root, "transcription.sock"),
    transcriptionStaging: path.join(root, "meeting-store", "transcription-ranges"),
    recordingExports: path.resolve(sourceEnvironment.MEETLESS_EXPORT_ROOT?.trim() || path.join(userHome, "Documents", "meetings")),
  };
  assertIsolated(paths, listen, userHome);
  const inheritedEnvironment = copyEnvironmentWithoutOpenAiSecrets(sourceEnvironment);
  return {
    listen,
    rendererOrigin,
    supervisorEntrypoint,
    paths,
    host: {
      bundle: path.join(userHome, "Applications", "Meetless.app"),
      identity: path.join(userHome, "Library", "Application Support", "Meetless", "host-identity.json"),
    },
    environment: {
      ...inheritedEnvironment,
      PASEO_HOME: paths.paseoHome,
      PASEO_LISTEN: listen,
      PASEO_ELECTRON_USER_DATA_DIR: paths.electronUserData,
      PASEO_LOG_FILE_PATH: paths.daemonLog,
      PASEO_RELAY_ENABLED: "false",
      PASEO_MCP_ENABLED: "false",
      PASEO_DESKTOP_MANAGED: "1",
      MEETLESS_RUNTIME_ROOT: paths.root,
      MEETLESS_STORE_ROOT: paths.meetingStore,
      MEETLESS_RENDERER_ORIGIN: rendererOrigin,
      MEETLESS_PINNED_SUPERVISOR_ENTRYPOINT: supervisorEntrypoint,
      PASEO_TEST_APP_NAME: "Meetless",
      MEETLESS_CAPTURE_HELPER: paths.captureHelper,
      MEETLESS_RECORDING_SOCKET: paths.recordingSocket,
      MEETLESS_TRANSCRIPTION_SOCKET: paths.transcriptionSocket,
      MEETLESS_TRANSCRIPTION_STAGING: paths.transcriptionStaging,
      MEETLESS_EXPORT_ROOT: paths.recordingExports,
      MEETLESS_FFMPEG: resolveHostTool("MEETLESS_FFMPEG", "ffmpeg", sourceEnvironment),
      MEETLESS_FFPROBE: resolveHostTool("MEETLESS_FFPROBE", "ffprobe", sourceEnvironment),
    },
  };
}

export function copyEnvironmentWithoutOpenAiSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => !isOpenAiSecretEnvironmentEntry(key, value)),
  );
}

export function isOpenAiSecretEnvironmentEntry(key: string, value: string | undefined): boolean {
  const normalizedKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const openAiSecretName = normalizedKey.includes("OPENAI") &&
    ["KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD"].some((marker) => normalizedKey.includes(marker));
  const openAiSecretValue = /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}$/.test(value?.trim() ?? "");
  return openAiSecretName || openAiSecretValue;
}

function resolveHostTool(environmentName: string, executable: string, environment = process.env): string {
  const configured = environment[environmentName]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`${environmentName} must be an absolute path`);
    return configured;
  }
  const resolved = execFileSync("which", [executable], {
    encoding: "utf8",
    env: copyEnvironmentWithoutOpenAiSecrets(environment),
  }).trim();
  if (!path.isAbsolute(resolved)) throw new Error(`Could not resolve an absolute ${executable} path`);
  return resolved;
}

function resolveRendererOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new IsolationViolationError(`Meetless renderer origin must be loopback HTTP, received ${value}`);
  }
  return url.origin;
}

export function assertIsolated(paths: RuntimePaths, listen: string, userHome = homedir()): void {
  const parsed = parseLoopbackListen(listen);
  if (parsed.port === 6767) {
    throw new IsolationViolationError(`Refusing production Paseo port 6767 (${listen})`);
  }
  if (parsed.port < 1024 || parsed.port > 65535) {
    throw new IsolationViolationError(`Refusing invalid Meetless daemon port (${listen})`);
  }
  const productionHome = path.resolve(userHome, ".paseo");
  if (isSameOrDescendant(paths.root, productionHome) || isSameOrDescendant(productionHome, paths.root)) {
    throw new IsolationViolationError(`Refusing production Paseo home ${productionHome}`);
  }
  const productionUserData = productionElectronPaths(path.resolve(userHome));
  for (const candidate of Object.values(paths)) {
    if (
      candidate === paths.plugin || candidate === paths.captureHelper ||
      candidate === paths.recordingSocket || candidate === paths.transcriptionSocket || candidate === paths.recordingExports
    ) continue;
    if (!isSameOrDescendant(candidate, paths.root)) {
      throw new IsolationViolationError(`Runtime path escapes the isolated root: ${candidate}`);
    }
    if (productionUserData.some((production) => isSameOrDescendant(candidate, production))) {
      throw new IsolationViolationError(`Refusing production Paseo Electron user-data ${candidate}`);
    }
  }
}

function resolveRecordingSocket(paseoHome: string): string {
  const inHome = path.join(paseoHome, "recording-control.sock");
  if (process.platform !== "darwin" || Buffer.byteLength(inHome) <= DARWIN_UNIX_SOCKET_PATH_BYTES) {
    return inHome;
  }
  const identity = createHash("sha256").update(paseoHome).digest("hex").slice(0, 24);
  return `/private/tmp/meetless-recording-${identity}.sock`;
}

function parseLoopbackListen(listen: string): { host: string; port: number } {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(listen);
  if (!match) {
    throw new IsolationViolationError(
      `Meetless Milestone 1 requires an explicit loopback host:port, received "${listen}"`,
    );
  }
  return { host: match[1] ?? "", port: Number(match[2]) };
}

function productionElectronPaths(userHome: string): string[] {
  return [
    path.join(userHome, "Library", "Application Support", "Paseo"),
    path.join(userHome, ".config", "Paseo"),
    path.join(userHome, "AppData", "Roaming", "Paseo"),
  ].map((candidate) => path.resolve(candidate));
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function prepareRuntime(config: RuntimeConfig): Promise<void> {
  assertPinnedPaseo(config.paths.plugin);
  await Promise.all(
    [
      config.paths.root,
      config.paths.paseoHome,
      config.paths.electronUserData,
      config.paths.meetingStore,
      config.paths.logs,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  await assertExistingConfigReadable(config.paths.config);
  const daemonConfig = {
    version: 1,
    daemon: {
      listen: config.listen,
      cors: { allowedOrigins: [config.rendererOrigin] },
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
      browserTools: { enabled: false },
    },
    pluginsEnabled: true,
    plugins: {
      meetless: {
        source: "directory",
        path: config.paths.plugin,
        enabled: true,
      },
    },
    log: { file: { path: config.paths.daemonLog } },
  };
  const manifest = {
    version: 1,
    paseoCommit: PINNED_PASEO_COMMIT,
    listen: config.listen,
    paths: config.paths,
  };
  await writeJsonAtomic(config.paths.config, daemonConfig);
  await writeJsonAtomic(config.paths.manifest, manifest);
}

function assertPinnedPaseo(pluginPath: string): void {
  const paseoRoot = path.resolve(pluginPath, "..", "..", "vendor", "paseo");
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: paseoRoot,
    encoding: "utf8",
    env: copyEnvironmentWithoutOpenAiSecrets(process.env),
  }).trim();
  if (actual !== PINNED_PASEO_COMMIT) {
    throw new Error(
      `Pinned Paseo mismatch: expected ${PINNED_PASEO_COMMIT}, found ${actual}. ` +
        "Restore the accepted vendor/paseo submodule before launching Meetless.",
    );
  }
}

async function assertExistingConfigReadable(configPath: string): Promise<void> {
  try {
    const existing = await readFile(configPath, "utf8");
    z.record(z.string(), z.unknown()).parse(JSON.parse(existing));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new IsolationViolationError(
      `Existing isolated daemon config is unreadable at ${configPath}; it was not replaced`,
    );
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    created = false;
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
