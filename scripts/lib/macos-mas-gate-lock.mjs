import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAS_GATE_LOCK_SCHEMA = "MAS_GATE_LOCK v1";
export const MAS_GATE_LOCK_BASENAME = ".meetless-mas-gate.lock";
export const MAS_GATE_LOCK_HOLDER_ARGUMENT = "--hold-mas-gate-lock";
export const MAS_GATE_LOCK_COMMAND = "/usr/bin/lockf";

const modulePath = fileURLToPath(import.meta.url);
const MAS_GATE_LOCK_LEASE = Symbol("MAS_GATE_LOCK_LEASE");
const LIVE_MAS_GATE_LOCK_LEASES = new WeakSet();

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
 * Hold the same fcntl/lockf advisory lock used by the native host. The child
 * process owns the descriptor so a parent crash releases the kernel lock;
 * the returned lease is plain control data plus an explicit release method.
 */
export async function acquireMasGateLock({ parentPath, blocking = false } = {}) {
  const requestedLockPath = typeof parentPath === "string" && parentPath.length > 0
    ? path.join(path.resolve(parentPath), MAS_GATE_LOCK_BASENAME)
    : "<unknown>";
  try {
    const canonicalParent = canonicalAbsolute(parentPath, "MAS gate lock parent");
    await assertLockParent(canonicalParent);
    const lockPath = masGateLockPath(canonicalParent);
    await prepareLockFile(lockPath, canonicalParent);

    const lockArguments = blocking
      ? ["-k", lockPath, process.execPath, modulePath, MAS_GATE_LOCK_HOLDER_ARGUMENT]
      : ["-t", "0", "-k", lockPath, process.execPath, modulePath, MAS_GATE_LOCK_HOLDER_ARGUMENT];
    const child = spawn(MAS_GATE_LOCK_COMMAND, lockArguments, {
      cwd: canonicalParent,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });

    const lease = await waitForLock(child, lockPath);
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
    throw lockFailure(requestedLockPath, `kernel lock acquisition failed: ${describe(error)}`, error);
  }
}

export async function withMasGateLock(options, operation) {
  if (typeof operation !== "function") throw new Error("MAS gate lock operation must be a function");
  const supplied = options?.lockLease;
  if (supplied && !LIVE_MAS_GATE_LOCK_LEASES.has(supplied)) {
    throw lockFailure(String(options?.parentPath ?? "<unknown>"), "the supplied MAS gate lock lease is not kernel-backed");
  }
  const lease = supplied ?? await acquireMasGateLock(options);
  if (!lease || !LIVE_MAS_GATE_LOCK_LEASES.has(lease) || typeof lease.release !== "function" || typeof lease.assertHeld !== "function" ||
      lease.lockPath !== masGateLockPath(options.parentPath)) {
    throw lockFailure(String(options?.parentPath ?? "<unknown>"), "the supplied MAS gate lock lease is not bound to the exact live holder and runtime-root parent");
  }
  let ownsLease = !supplied;
  try {
    // A caller-supplied object can retain the lock-file inode after its
    // kernel lease has been released or its holder has died.  The live
    // holder assertion is part of the lease contract, before any caller
    // operation is allowed to inspect or mutate transaction state.
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

export async function writeMasGateLockMetadata(lease, metadata) {
  if (!lease || !LIVE_MAS_GATE_LOCK_LEASES.has(lease) || typeof lease.lockPath !== "string" || typeof lease.assertHeld !== "function") {
    throw new Error("MAS gate lock metadata requires a live lock lease");
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

async function waitForLock(child, lockPath) {
  let ready = false;
  let settled = false;
  let stdout = "";
  let stderr = "";
  let protocolBuffer = "";
  let holderProcessExited = false;
  const pendingAssertions = [];
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    protocolBuffer += chunk;
    const lines = protocolBuffer.split("\n");
    protocolBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!ready && line === "locked") {
        ready = true;
        resolveReady();
      } else if (line === "asserted") {
        pendingAssertions.shift()?.resolve();
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    rejectReady(lockFailure(lockPath, `lockf could not start: ${error.message}`, error));
  });
  child.once("close", (code, signal) => {
    holderProcessExited = true;
    for (const pending of pendingAssertions.splice(0)) {
      pending.reject(lockFailure(lockPath, "the MAS gate lock holder exited during a live assertion"));
    }
    if (ready) return;
    if (settled) return;
    settled = true;
    const detail = stderr.trim() || stdout.trim() || `exit ${code ?? "unknown"}${signal ? `/${signal}` : ""}`;
    rejectReady(lockFailure(lockPath, `kernel lock acquisition was not completed: ${detail}`));
  });
  await readyPromise;

  let released = false;
  const assertHeld = async () => {
    if (released || holderProcessExited || child.exitCode !== null || child.signalCode !== null) {
      throw lockFailure(lockPath, "the MAS gate lock lease is no longer held");
    }
    await assertKernelLockHeld(lockPath);
    if (released || holderProcessExited || child.exitCode !== null || child.signalCode !== null) {
      throw lockFailure(lockPath, "the MAS gate lock lease holder exited during assertion");
    }
    await new Promise((resolve, reject) => {
      pendingAssertions.push({ resolve, reject });
      child.stdin.write("assert\n", (error) => {
        if (error) {
          const index = pendingAssertions.findIndex((pending) => pending.resolve === resolve);
          if (index >= 0) pendingAssertions.splice(index, 1);
          reject(lockFailure(lockPath, `the MAS gate lock holder assertion could not be sent: ${error.message}`, error));
        }
      });
    });
  };
  const lease = {
    [MAS_GATE_LOCK_LEASE]: true,
    lockPath,
    holderPid: child.pid,
    assertHeld,
    async release() {
      if (released) return;
      released = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end("release\n");
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", resolve);
      });
    },
  };
  LIVE_MAS_GATE_LOCK_LEASES.add(lease);
  return lease;
}

/**
 * lockf(1) has no query operation for the current holder.  A non-blocking
 * probe therefore proves that the lock remains held while the lease's own
 * holder challenge below proves that this live lease is the holder.  A
 * released or killed holder cannot authorize a filesystem operation merely
 * because its lock-file inode still exists.
 */
async function assertKernelLockHeld(lockPath) {
  const probe = spawn(MAS_GATE_LOCK_COMMAND, ["-t", "0", "-k", lockPath, "/usr/bin/true"], {
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const result = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code === 75) return;
  throw lockFailure(
    lockPath,
    `the kernel lock is not held by this lease (probe exit ${result.code ?? "unknown"}${result.signal ? `/${result.signal}` : ""})`,
  );
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

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("MAS gate lock ownership requires process UID support");
  return process.getuid();
}

function lockFailure(lockPath, reason, cause) {
  const error = new Error(`MAS-GATE-CLEANUP-001: repository-authorized MAS gate lock failed for ${lockPath}. Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md and docs/decisions/0005-mac-app-store-and-revenuecat.md. Next action: leave every runtime root intact; run MAS gate status/recovery. Reason: ${reason}`);
  error.code = "MAS-GATE-CLEANUP-001";
  if (cause) error.cause = cause;
  return error;
}

function describe(error) { return error instanceof Error ? error.message : String(error); }

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath && process.argv[2] === MAS_GATE_LOCK_HOLDER_ARGUMENT) {
  const holderParentPid = process.ppid;
  process.stdout.write("locked\n");
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("assert")) {
      if (process.ppid !== holderParentPid) {
        process.stderr.write("lock holder parent exited\n");
        process.exit(73);
      }
      process.stdout.write("asserted\n");
    }
    if (chunk.includes("release")) process.exit(0);
  });
  process.stdin.on("end", () => process.exit(0));
}
