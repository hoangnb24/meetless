import { realpath } from "node:fs/promises";
import path from "node:path";

export const PROOF_PORTS = Object.freeze({
  backend: 3210,
  site: 3211,
});

export const DEFAULT_GUARDED_FETCH_TIMEOUT_MS = 10_000;

export const FORBIDDEN_PROOF_INPUT_NAMES = Object.freeze([
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
  "CONVEX_PROVISION_HOST",
]);

export const UNSAFE_PROOF_INPUT_NAMES = Object.freeze([
  ...FORBIDDEN_PROOF_INPUT_NAMES,
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS",
  "CONVEX_VERSION_API_ORIGIN",
  "CONVEX_AGENT_MODE",
  "CONVEX_ALLOW_ANONYMOUS",
  "CONVEX_VERSION_OVERRIDE",
  "CONVEX_RUNNING_LIVE_IN_MONOREPO",
  "CONVEX_IGNORE_SUSPICIOUS_ENV_VARS",
  "CONVEX_VERBOSE",
  "CONVEX_MIN_DOCUMENTS_FOR_INDEX_DELETE_WARNING",
  "CONVEX_IMPORT_CHUNK_SIZE",
  "CONVEX_URL",
  "CONVEX_SITE_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "VITE_CONVEX_URL",
  "VITE_CONVEX_SITE_URL",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
  "COREPACK_HOME",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CONVEX_TMPDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
]);

export const MINIMAL_CHILD_ENV_NAMES = Object.freeze([
  "CI",
  "DISABLE_BEACON",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CONVEX_TMPDIR",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
]);

const FORBIDDEN_PROOF_ARGUMENTS = Object.freeze([
  "--deployment",
  "--local",
  "--cloud",
  "--configure",
  "--prod",
  "--production",
  "--team",
  "--team-id",
  "--organization",
  "--organization-id",
  "--admin-key",
  "--access-token",
  "--deploy-key",
  "--deployment-key",
  "--proxy",
  "--http-proxy",
  "--https-proxy",
  "--redirect",
  "--follow-redirects",
]);

export const PROOF_STATE_PATH_NAMES = Object.freeze([
  "home",
  "xdgConfigHome",
  "xdgCacheHome",
  "xdgDataHome",
  "xdgStateHome",
  "tmpDir",
  "convexTmpDir",
  "storage",
  "sqlite",
  "project",
  "envDir",
]);

export class LocalProofGuardError extends Error {
  constructor(message) {
    super(`Managed Convex local-proof guard rejected the operation: ${message}`);
    this.name = "LocalProofGuardError";
  }
}

function reject(message) {
  throw new LocalProofGuardError(message);
}

export function assertProofInputEnvironment(environment = {}) {
  for (const name of UNSAFE_PROOF_INPUT_NAMES) {
    if (Object.hasOwn(environment, name)) {
      reject(`environment input ${name} is not permitted`);
    }
  }
}

function assertAbsolutePath(rawPath, name) {
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) reject(`${name} must be an absolute path`);
  if (rawPath.includes("\0")) reject(`${name} contains a NUL byte`);
  if (rawPath.split(path.sep).includes("..")) reject(`${name} must not contain parent traversal`);
  return path.normalize(rawPath);
}

function isWithinPath(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalPathOrParent(rawPath, name, realpathImpl) {
  const normalized = assertAbsolutePath(rawPath, name);
  try {
    return await realpathImpl(normalized);
  } catch (error) {
    if (error?.code !== "ENOENT") reject(`${name} could not be canonicalized safely`);
    const suffix = [];
    let cursor = normalized;
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) reject(`${name} has no canonical parent`);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      try {
        const canonicalParent = await realpathImpl(cursor);
        return path.join(canonicalParent, ...suffix);
      } catch (parentError) {
        if (parentError?.code !== "ENOENT") reject(`${name} parent could not be canonicalized safely`);
      }
    }
  }
}

async function canonicalBlockedPath(rawPath, name, realpathImpl) {
  try {
    return await canonicalPathOrParent(rawPath, name, realpathImpl);
  } catch (error) {
    if (error instanceof LocalProofGuardError) {
      return assertAbsolutePath(rawPath, name);
    }
    throw error;
  }
}

export async function assertProofPathContainment({
  root,
  paths,
  forbiddenRoots = [],
  realpathImpl = realpath,
} = {}) {
  const canonicalRoot = await canonicalPathOrParent(root, "proof root", realpathImpl);
  const canonicalForbiddenRoots = [];
  for (const [index, forbiddenRoot] of forbiddenRoots.entries()) {
    canonicalForbiddenRoots.push(await canonicalBlockedPath(forbiddenRoot, `forbidden root ${index + 1}`, realpathImpl));
  }
  for (const forbiddenRoot of canonicalForbiddenRoots) {
    if (isWithinPath(canonicalRoot, forbiddenRoot)) reject("proof root overlaps a user or repository state path");
  }

  if (!paths || typeof paths !== "object") reject("proof state paths are missing");
  const entries = [];
  for (const name of PROOF_STATE_PATH_NAMES) {
    if (!Object.hasOwn(paths, name)) reject(`proof state path ${name} is missing`);
    const canonical = await canonicalPathOrParent(paths[name], `proof state path ${name}`, realpathImpl);
    if (!isWithinPath(canonical, canonicalRoot) || canonical === canonicalRoot) reject(`proof state path ${name} escapes the proof root`);
    for (const forbiddenRoot of canonicalForbiddenRoots) {
      if (isWithinPath(canonical, forbiddenRoot)) reject(`proof state path ${name} overlaps a user or repository state path`);
    }
    entries.push({ name, canonical });
  }

  for (let index = 0; index < entries.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      if (isWithinPath(entries[index].canonical, entries[otherIndex].canonical) || isWithinPath(entries[otherIndex].canonical, entries[index].canonical)) {
        reject(`proof state paths ${entries[index].name} and ${entries[otherIndex].name} overlap`);
      }
    }
  }
  return { root: canonicalRoot, paths: Object.fromEntries(entries.map(({ name, canonical }) => [name, canonical])) };
}

export function assertProofChildEnvironment(environment, { paths, requireSelfHosted = false } = {}) {
  assertMinimalChildEnvironment(environment, { requireSelfHosted });
  if (!paths || typeof paths !== "object") reject("proof child environment paths are missing");
  const expected = {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_STATE_HOME: paths.xdgStateHome,
    TMPDIR: paths.tmpDir,
    TMP: paths.tmpDir,
    TEMP: paths.tmpDir,
    CONVEX_TMPDIR: paths.convexTmpDir,
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (typeof expectedValue !== "string" || environment[name] !== expectedValue) reject(`child environment ${name} is not proof-owned`);
  }
  return environment;
}

export function assertLoopbackUrl(rawUrl, { name = "URL", port } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) reject(`${name} must be a non-empty string`);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) reject(`${name} has no valid proof-owned port`);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    reject(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== "http:") reject(`${name} must use HTTP`);
  if (parsed.hostname !== "127.0.0.1") reject(`${name} must use literal loopback 127.0.0.1`);
  if (parsed.port !== String(port)) reject(`${name} must use proof-owned port ${port}`);
  if (parsed.username || parsed.password) reject(`${name} must not contain credentials`);
  if (parsed.search || parsed.hash) reject(`${name} must not contain a query or fragment`);
  if (parsed.origin !== `http://127.0.0.1:${port}`) reject(`${name} has an unexpected origin`);
  return parsed;
}

export function assertResponseUrl(rawUrl, options = {}) {
  return assertLoopbackUrl(rawUrl, { ...options, name: options.name ?? "response URL" });
}

export function assertRedirectPolicy(init = {}) {
  if (init.redirect !== undefined && init.redirect !== "error") {
    reject("redirect policy must be error");
  }
}

function boundedAbortSignal(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) reject("fetch timeout must be a positive finite number");
  if (signal !== undefined && (typeof signal !== "object" || typeof signal.addEventListener !== "function")) {
    reject("fetch signal is invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("guarded fetch deadline exceeded")), timeoutMs);
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromCaller);
    },
  };
}

export async function guardedFetch(
  rawUrl,
  init = {},
  {
    fetchImpl = globalThis.fetch,
    port = PROOF_PORTS.backend,
    name = "request URL",
    timeoutMs = DEFAULT_GUARDED_FETCH_TIMEOUT_MS,
  } = {},
) {
  assertLoopbackUrl(rawUrl, { name, port });
  assertRedirectPolicy(init);
  if (typeof fetchImpl !== "function") reject("fetch implementation is missing");
  const boundedSignal = boundedAbortSignal(init.signal, timeoutMs);
  try {
    const response = await fetchImpl(rawUrl, { ...init, signal: boundedSignal.signal, redirect: "error" });
    if (!response || typeof response.url !== "string" || response.url.length === 0) {
      reject("response did not expose a URL for revalidation");
    }
    assertResponseUrl(response.url, { port, name: "response URL" });
    if (response.redirected === true) reject("redirected responses are not permitted");
    return response;
  } finally {
    boundedSignal.dispose();
  }
}

export function assertMinimalChildEnvironment(environment, { requireSelfHosted = false } = {}) {
  if (!environment || typeof environment !== "object") reject("child environment must be an object");
  const allowed = new Set(MINIMAL_CHILD_ENV_NAMES);
  for (const name of Object.keys(environment)) {
    if (!allowed.has(name)) reject(`child environment contains unrelated variable ${name}`);
  }
  if (environment.CI !== "1") reject("child environment must require CI=1");
  if (environment.DISABLE_BEACON !== "1") reject("child environment must require DISABLE_BEACON=1");
  if (typeof environment.HOME !== "string" || !path.isAbsolute(environment.HOME)) reject("child environment must use an absolute proof-owned HOME");
  const hasUrl = Object.hasOwn(environment, "CONVEX_SELF_HOSTED_URL");
  const hasAdminKey = Object.hasOwn(environment, "CONVEX_SELF_HOSTED_ADMIN_KEY");
  if (requireSelfHosted && (!hasUrl || !hasAdminKey)) reject("self-hosted CLI environment must include both explicit connection variables");
  if (hasUrl) assertLoopbackUrl(environment.CONVEX_SELF_HOSTED_URL, { name: "CONVEX_SELF_HOSTED_URL", port: PROOF_PORTS.backend });
  if (hasAdminKey && (typeof environment.CONVEX_SELF_HOSTED_ADMIN_KEY !== "string" || environment.CONVEX_SELF_HOSTED_ADMIN_KEY.length === 0)) reject("self-hosted admin key is missing");
  return environment;
}

export function assertAllowedExecutable(filePath, allowedPaths) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) reject("executable path must be absolute");
  if (!Array.isArray(allowedPaths) || !allowedPaths.includes(filePath)) reject("executable path is not allowlisted");
  return filePath;
}

function assertProofArgument(arg) {
  const urlMatch = arg.match(/[a-z][a-z\d+.-]*:\/\/[^\s]+/iu);
  if (urlMatch) {
    let parsed;
    try {
      parsed = new URL(urlMatch[0]);
    } catch {
      reject("URL argument is not valid");
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || !Object.values(PROOF_PORTS).includes(port)) reject("URL argument must use a proof-owned loopback port");
    assertLoopbackUrl(urlMatch[0], { name: "exec URL argument", port });
  }
  if (FORBIDDEN_PROOF_ARGUMENTS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
    reject("cloud, selector, proxy, token, or redirect flags are not permitted");
  }
  if (FORBIDDEN_PROOF_INPUT_NAMES.some((name) => arg === name || arg.startsWith(`${name}=`))) {
    reject("deployment credentials are not permitted in executable arguments");
  }
}

function assertExactAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || value.split(path.sep).includes("..")) {
    reject(`${name} must be a normalized absolute path`);
  }
  return path.normalize(value);
}

export function assertExactConvexCliInvocation({ filePath, args = [], nodePath, convexCliPath, envFilePath, envFileRoot }) {
  const expectedNodePath = assertExactAbsolutePath(nodePath, "Convex CLI Node executable");
  const expectedCliPath = assertExactAbsolutePath(convexCliPath, "Convex CLI script");
  const expectedEnvFilePath = assertExactAbsolutePath(envFilePath, "Convex CLI environment file");
  if (envFileRoot !== undefined) {
    const expectedRoot = assertExactAbsolutePath(envFileRoot, "Convex CLI environment root");
    if (!isWithinPath(expectedEnvFilePath, expectedRoot) || expectedEnvFilePath === expectedRoot) reject("Convex CLI environment file is outside the proof-owned environment root");
  }
  if (filePath !== expectedNodePath) reject("Convex CLI must run through the exact absolute Node executable");
  const expectedArgs = [
    expectedCliPath,
    "dev",
    "--once",
    "--typecheck", "enable",
    "--codegen", "enable",
    "--tail-logs", "disable",
    "--env-file", expectedEnvFilePath,
  ];
  if (args.length !== expectedArgs.length || args.some((arg, index) => arg !== expectedArgs[index])) {
    reject("Convex CLI script or argv is outside the exact local diagnostic allowlist");
  }
}

export function assertAllowedExecInvocation({ filePath, args = [], options = {}, allowedPaths, childEnvironment, proofPaths, exactConvexCli }) {
  assertAllowedExecutable(filePath, allowedPaths);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) reject("exec arguments must be strings");
  if (options.shell) reject("shell execution is not permitted");
  if (Object.hasOwn(options, "env")) reject("child environment must be supplied through the guarded environment boundary");
  for (const arg of args) {
    if (arg === "npx" || arg === "curl" || arg.includes("npx") || arg.includes("curl")) reject("npx/curl execution is not permitted");
    assertProofArgument(arg);
  }
  if (exactConvexCli) assertExactConvexCliInvocation({ filePath, args, ...exactConvexCli });
  if (childEnvironment !== undefined) {
    const requireSelfHosted = Object.hasOwn(childEnvironment, "CONVEX_SELF_HOSTED_URL") || Object.hasOwn(childEnvironment, "CONVEX_SELF_HOSTED_ADMIN_KEY");
    if (proofPaths) assertProofChildEnvironment(childEnvironment, { paths: proofPaths, requireSelfHosted });
    else assertMinimalChildEnvironment(childEnvironment, { requireSelfHosted });
  }
}

export function guardedExecFile({ filePath, args = [], options = {}, allowedPaths, childEnvironment, proofPaths, exactConvexCli, execFileImpl, callback }) {
  assertAllowedExecInvocation({ filePath, args, options, allowedPaths, childEnvironment, proofPaths, exactConvexCli });
  if (typeof execFileImpl !== "function") reject("execFile implementation is missing");
  return execFileImpl(filePath, args, { ...options, shell: false, env: childEnvironment }, callback);
}
