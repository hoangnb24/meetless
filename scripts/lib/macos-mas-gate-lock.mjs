import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMacOSPackageParent } from "./macos-package-parent-policy.mjs";

export const MAS_GATE_LOCK_SCHEMA = "MAS_GATE_LOCK v1";
export const MAS_GATE_LOCK_BASENAME = ".meetless-mas-gate.lock";
export const MAS_GATE_LOCK_MUTATION_SCHEMA = "MAS_GATE_MUTATION v2";
export const MAS_GATE_LOCK_MUTATION_VERSION = 2;
export const MAS_GATE_LOCK_COMMAND = "MeetlessMasGateMutation";
export const MAS_GATE_LOCK_HOLDER_EXITED_CODE = "MAS-GATE-HOLDER-EXITED";

const modulePath = fileURLToPath(import.meta.url);
const mutationHelperPath = path.resolve(path.dirname(modulePath), "../../native/macos-host/.build/release/MeetlessMasGateMutation");
const MAS_GATE_LOCK_LEASE = Symbol("MAS_GATE_LOCK_LEASE");
const LIVE_MAS_GATE_LOCK_LEASES = new WeakSet();
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Return the one stable kernel-lock path for a runtime-root parent. The lock
 * is deliberately a sibling of the movable runtime root, never a child of
 * the root that a session may rename.
 */
export function masGateLockPath(parentPath) {
  const canonical = canonicalAbsolute(parentPath, "MAS gate lock parent");
  return path.join(canonical, MAS_GATE_LOCK_BASENAME);
}

/**
 * Start the persistent native mutation session. The helper owns the same
 * lockf descriptor as MeetlessHost and every protected renameatx_np call, so a Node
 * liveness check cannot become a later JavaScript filesystem mutation.
 */
export async function acquireMasGateLock({ parentPath, packageParentPath = parentPath, blocking = false } = {}) {
  const requestedLockPath = typeof parentPath === "string" && parentPath.length > 0
    ? path.join(path.resolve(parentPath), MAS_GATE_LOCK_BASENAME)
    : "<unknown>";
  if (blocking) throw lockFailure(requestedLockPath, "blocking MAS gate lock acquisition is not supported; retry the bounded operation");
  try {
    const canonicalParent = canonicalAbsolute(parentPath, "MAS gate lock parent");
    const canonicalPackageParent = canonicalAbsolute(packageParentPath, "MAS gate package parent");
    await assertLockParent(canonicalParent);
    await assertMacOSPackageParent(canonicalPackageParent);
    const lockPath = masGateLockPath(canonicalParent);
    await prepareLockFile(lockPath, canonicalParent);
    const child = spawn(mutationHelperPath, [`--parent=${canonicalParent}`, `--lock=${lockPath}`, `--package-parent=${canonicalPackageParent}`], {
      cwd: canonicalParent,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    const lease = await waitForLock(child, lockPath, canonicalPackageParent);
    try {
      const lockIdentity = await assertHeldLockFile(lockPath, canonicalParent);
      lease.lockIdentity = lockIdentity;
      Object.freeze(lease);
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  } catch (error) {
    if (error?.code === "MAS-GATE-CLEANUP-001") throw error;
    throw lockFailure(requestedLockPath, `native mutation-session acquisition failed: ${describe(error)}`, error);
  }
}

export async function withMasGateLock(options, operation) {
  if (typeof operation !== "function") throw new Error("MAS gate lock operation must be a function");
  const supplied = options?.lockLease;
  if (supplied) assertMasGateMutationLease(supplied);
  const lease = supplied ?? await acquireMasGateLock(options);
  if (lease.lockPath !== masGateLockPath(options.parentPath)) {
    throw lockFailure(String(options?.parentPath ?? "<unknown>"), "the supplied MAS gate lock lease is not bound to the exact live native mutation session");
  }
  let ownsLease = !supplied;
  try {
    await lease.assertHeld();
    await assertHeldLockFile(lease.lockPath, canonicalAbsolute(options.parentPath, "MAS gate lock parent"), lease.lockIdentity);
    return await operation(lease);
  } finally {
    if (ownsLease) {
      ownsLease = false;
      await lease.release();
    }
  }
}

export function assertMasGateMutationLease(lease) {
  if (!lease || !LIVE_MAS_GATE_LOCK_LEASES.has(lease) || typeof lease.release !== "function" ||
      typeof lease.assertHeld !== "function" || typeof lease.bindRuntimeRoot !== "function" ||
      typeof lease.renameNoReplace !== "function") {
    throw lockFailure(String(lease?.lockPath ?? "<unknown>"), "the supplied MAS gate lock lease is not kernel-backed");
  }
  return lease;
}

export function isMasGateMutationHolderDeath(error) {
  return error?.code === MAS_GATE_LOCK_HOLDER_EXITED_CODE;
}

export async function writeMasGateLockMetadata(lease, metadata) {
  if (!lease || !LIVE_MAS_GATE_LOCK_LEASES.has(lease) || typeof lease.lockPath !== "string" ||
      typeof lease.assertHeld !== "function") {
    throw new Error("MAS gate lock metadata requires a live native mutation-session lease");
  }
  await lease.assertHeld();
  await assertHeldLockFile(lease.lockPath, path.dirname(lease.lockPath), lease.lockIdentity);
  const bytes = Buffer.from(`${JSON.stringify({ schema: MAS_GATE_LOCK_SCHEMA, ...metadata })}\n`);
  const handle = await open(lease.lockPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function waitForLock(child, lockPath, packageParentPath) {
  let ready = false;
  let settled = false;
  let holderProcessExited = false;
  let protocolBuffer = "";
  let resolveReady;
  let rejectReady;
  const pending = new Map();
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const failPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    protocolBuffer += chunk;
    if (protocolBuffer.length > 256 * 1024) {
      const error = lockFailure(lockPath, "native mutation-session protocol output exceeded its bound");
      failPending(error);
      if (!settled) {
        settled = true;
        rejectReady(error);
      }
      child.kill("SIGKILL");
      return;
    }
    const lines = protocolBuffer.split("\n");
    protocolBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        const error = lockFailure(lockPath, "native mutation-session returned malformed JSON");
        failPending(error);
        if (!settled) {
          settled = true;
          rejectReady(error);
        }
        child.kill("SIGKILL");
        return;
      }
      if (message.kind === "ready") {
        if (ready || message.schema !== MAS_GATE_LOCK_MUTATION_SCHEMA || message.version !== MAS_GATE_LOCK_MUTATION_VERSION || message.packageParentPath !== packageParentPath) {
          const error = lockFailure(lockPath, "native mutation-session returned an invalid ready record");
          if (!settled) {
            settled = true;
            rejectReady(error);
          }
          child.kill("SIGKILL");
          return;
        }
        ready = true;
        resolveReady();
        continue;
      }
      if (message.kind === "fatal") {
        const error = lockFailure(lockPath, `native mutation-session failed: ${message.code ?? "unknown"} ${message.message ?? ""}`);
        failPending(error);
        if (!settled) {
          settled = true;
          rejectReady(error);
        }
        continue;
      }
      const request = pending.get(message.requestId);
      if (!request) continue;
      if (message.kind === "mutation-applied") {
        request.mutationApplied = true;
        request.mutationAppliedPromise = Promise.resolve().then(() => (
          typeof request.onMutationApplied === "function" ? request.onMutationApplied(message) : undefined
        )).then(async () => {
          // Let the child close event run before acknowledging a mutation.
          // This keeps a holder death between the native syscall and the
          // protocol response on the recovery path, even when both native
          // records arrive in one stdout chunk.
          await new Promise((resolve) => setImmediate(resolve));
        }).catch((error) => {
          request.mutationCallbackError = error;
        });
        continue;
      }
      if (message.kind !== "response") continue;
      const settle = () => {
        if (!pending.has(message.requestId)) return;
        pending.delete(message.requestId);
        clearTimeout(request.timeout);
        if (request.mutationCallbackError) request.reject(request.mutationCallbackError);
        else if (message.ok === true) request.resolve(message);
        else request.reject(protocolError(lockPath, message));
      };
      if (request.mutationAppliedPromise) request.mutationAppliedPromise.then(settle);
      else settle();
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
  });
  child.once("error", (error) => {
    const failure = lockFailure(lockPath, `native mutation-session could not start: ${error.message}`, error);
    failPending(failure);
    if (!settled) {
      settled = true;
      rejectReady(failure);
    }
  });
  child.once("close", (code, signal) => {
    holderProcessExited = true;
    const detail = stderr.trim() || `exit ${code ?? "unknown"}${signal ? `/${signal}` : ""}`;
    const failure = holderExitFailure(lockPath, `native mutation-session holder exited: ${detail}`);
    failPending(failure);
    if (!ready && !settled) {
      settled = true;
      rejectReady(failure);
    }
  });
  await readyPromise;

  let released = false;
  const send = (command, payload = {}, { onMutationApplied } = {}) => {
    if (released) {
      return Promise.reject(lockFailure(lockPath, "the native mutation-session lease is no longer held"));
    }
    if (holderProcessExited || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(holderExitFailure(lockPath, "the native mutation-session holder exited; the lease is no longer held"));
    }
    if (pending.size >= 32) return Promise.reject(lockFailure(lockPath, "native mutation-session command bound exceeded"));
    const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(lockFailure(lockPath, `native mutation-session command ${command} exceeded its bound`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timeout, onMutationApplied });
      try {
        child.stdin.write(`${JSON.stringify({
          schema: MAS_GATE_LOCK_MUTATION_SCHEMA,
          version: MAS_GATE_LOCK_MUTATION_VERSION,
          requestId,
          command,
          ...payload,
        })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(requestId);
        reject(lockFailure(lockPath, `native mutation-session command could not be sent: ${error.message}`, error));
      }
    });
  };
  const lease = {
    [MAS_GATE_LOCK_LEASE]: true,
    lockPath,
    packageParentPath,
    holderPid: child.pid,
    lockIdentity: null,
    assertHeld: async () => {
      await send("assert-held");
      if (released) throw lockFailure(lockPath, "native mutation-session lease was released during assertion");
      if (holderProcessExited) throw holderExitFailure(lockPath, "native mutation-session holder exited during assertion");
      await assertHeldLockFile(lockPath, path.dirname(lockPath), lease.lockIdentity);
    },
    bindRuntimeRoot: async (runtimeRootPath) => {
      const canonicalRoot = canonicalAbsolute(runtimeRootPath, "protected runtime root");
      await lease.assertHeld();
      await send("bind-runtime-root", { runtimeRootPath: canonicalRoot });
    },
    renameNoReplace: async (source, destination, { pathClass, authorizedParentPath, authorizedRootPath, onMutationApplied } = {}) => {
      const mutation = mutationPathClassPayload(pathClass, { authorizedParentPath, authorizedRootPath });
      await lease.assertHeld();
      await send("rename-excl", {
        source: canonicalAbsolute(source, "protected move source"),
        destination: canonicalAbsolute(destination, "protected move destination"),
        ...mutation,
      }, { onMutationApplied });
    },
    async release() {
      if (released) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        released = true;
        LIVE_MAS_GATE_LOCK_LEASES.delete(lease);
        return;
      }
      try { await send("release"); } catch { /* death already releases the kernel lock */ }
      released = true;
      LIVE_MAS_GATE_LOCK_LEASES.delete(lease);
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      await waitForChildClose(child);
    },
  };
  LIVE_MAS_GATE_LOCK_LEASES.add(lease);
  return lease;
}

async function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("close", resolve));
}

function protocolError(lockPath, message) {
  const error = lockFailure(lockPath, `native mutation-session command failed: ${message.code ?? "unknown"} ${message.message ?? ""}`);
  error.code = message.code ?? "MAS_GATE_MUTATION_FAILED";
  return error;
}

async function assertLockParent(parentPath) {
  const info = await lstat(parentPath).catch((error) => {
    throw lockFailure(masGateLockPath(parentPath), `lock parent is unavailable: ${error.message}`, error);
  });
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid() || (info.mode & 0o022) !== 0) {
    throw lockFailure(masGateLockPath(parentPath), "lock parent is not one secure current-owner directory");
  }
  const resolved = await realpath(parentPath);
  if (resolved !== parentPath) throw lockFailure(masGateLockPath(parentPath), "lock parent is a symlink alias");
}

async function prepareLockFile(lockPath, parentPath) {
  const existing = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw lockFailure(lockPath, "lock path inspection failed", error);
  });
  if (existing?.isSymbolicLink() || (existing && (!existing.isFile() || existing.uid !== currentUid() || existing.nlink !== 1))) {
    throw lockFailure(lockPath, "lock path is not one current-owner regular file");
  }
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    throw lockFailure(lockPath, `lock file preparation failed: ${error.message}`, error);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  await assertHeldLockFile(lockPath, parentPath);
}

async function assertHeldLockFile(lockPath, parentPath, expectedIdentity) {
  const [lock, parent] = await Promise.all([lstat(lockPath), lstat(parentPath)]);
  if (lock.isSymbolicLink() || !lock.isFile() || lock.uid !== currentUid() || lock.nlink !== 1 || (lock.mode & 0o7777) !== 0o600) {
    throw lockFailure(lockPath, "lock path changed to an insecure or aliased file");
  }
  if (lock.dev !== parent.dev) throw lockFailure(lockPath, "lock path is on a different device from its parent");
  const identity = { dev: lock.dev, ino: lock.ino, mode: lock.mode, uid: lock.uid };
  if (expectedIdentity && Object.entries(expectedIdentity).some(([field, value]) => identity[field] !== value)) {
    throw lockFailure(lockPath, "lock path identity changed while the transaction was active");
  }
  return identity;
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || value.includes("\0") || path.resolve(value) !== value) {
    throw new Error(`${label} must be one exact canonical absolute path`);
  }
  return value;
}

function mutationPathClassPayload(pathClass, { authorizedParentPath = undefined, authorizedRootPath = undefined } = {}) {
  if (pathClass === "runtime-sibling") {
    if (authorizedParentPath !== undefined || authorizedRootPath !== undefined) {
      throw new Error("runtime-sibling protected move cannot carry an authorized path override");
    }
    return { pathClass };
  }
  if (pathClass === "package-sibling") {
    if (typeof authorizedParentPath !== "string" || authorizedRootPath !== undefined) {
      throw new Error("package-sibling protected move requires its exact authorized parent path");
    }
    return {
      pathClass,
      authorizedParentPath: canonicalAbsolute(authorizedParentPath, "authorized package parent"),
    };
  }
  if (pathClass === "runtime-child") {
    if (typeof authorizedRootPath !== "string" || authorizedParentPath !== undefined) {
      throw new Error("runtime-child protected move requires its exact authorized runtime root path");
    }
    return {
      pathClass,
      authorizedRootPath: canonicalAbsolute(authorizedRootPath, "authorized runtime root"),
    };
  }
  throw new Error("protected move requires one recognized path class");
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("MAS gate lock requires process UID support");
  return process.getuid();
}

function lockFailure(lockPath, reason, cause) {
  const error = new Error(
    `MAS gate lock failed for ${lockPath}: ${reason}. ` +
    "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. " +
    "Next action: leave every runtime root intact and run MAS gate status/recovery.",
  );
  if (cause) error.cause = cause;
  return error;
}

function holderExitFailure(lockPath, reason, cause) {
  const error = lockFailure(lockPath, reason, cause);
  error.code = MAS_GATE_LOCK_HOLDER_EXITED_CODE;
  return error;
}

function describe(error) { return error instanceof Error ? error.message : String(error); }
