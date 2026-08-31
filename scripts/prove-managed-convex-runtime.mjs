import { guardedExecFile } from "./prove-managed-convex-guard.mjs";

export const DEFAULT_OWNED_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_OWNED_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_OWNED_TERM_TIMEOUT_MS = 5_000;
export const DEFAULT_OWNED_KILL_TIMEOUT_MS = 2_000;
export const DEFAULT_STDERR_RING_BYTES = 4_096;

function safeText(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

export function redactDiagnostic(value, secrets = []) {
  let text = safeText(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join("<redacted>");
  }
  return text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "<redacted-private-key>")
    .replace(/((?:authorization|token|secret|password|private[_ -]?key|admin[_ -]?key)[^:=\n]*[:=]\s*)[^\s,;]+/giu, "$1<redacted>")
    .replace(/\b(?:sk|rk|pk)[-_][a-z0-9_-]{8,}\b/giu, "<redacted-token>");
}

export function appendStderrRing(ring, chunk, maxBytes = DEFAULT_STDERR_RING_BYTES) {
  if (!ring || typeof ring !== "object") throw new Error("stderr ring state is required");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("stderr ring size must be positive");
  const next = `${ring.text ?? ""}${safeText(chunk)}`;
  ring.text = Buffer.byteLength(next, "utf8") <= maxBytes ? next : Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
  return ring.text;
}

function stageMessage(stage, state) {
  return `[managed-convex-diagnostic] ${stage}:${state}`;
}

function reportStage(reporter, stage, state) {
  try {
    (reporter ?? ((message) => process.stderr.write(`${message}\n`)))(stageMessage(stage, state));
  } catch {
    // Diagnostics must never change lifecycle settlement.
  }
}

function processExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function addOnce(child, event, listener) {
  if (!child || typeof child.once !== "function") throw new Error("owned child does not expose event lifecycle");
  child.once(event, listener);
}

function safeFailure(stage, reason, ring, secrets = []) {
  const tail = redactDiagnostic(ring?.text ?? "", secrets).trim();
  const error = new Error(`managed Convex diagnostic stage ${stage} failed: ${redactDiagnostic(reason, secrets)}${tail ? `; redacted stderr tail: ${tail}` : ""}`);
  error.stage = stage;
  error.stderrTail = tail;
  return error;
}

function sendOwnedSignal(child, signal, killProcessImpl) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("owned child PID is missing or invalid");
  if (typeof killProcessImpl === "function" && process.platform !== "win32") {
    try {
      killProcessImpl(-pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (typeof child.kill !== "function") throw new Error("owned child cannot be terminated");
  child.kill(signal);
}

function waitForOwnedExit(child, timeoutMs) {
  if (processExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(processExited(child)), timeoutMs);
    addOnce(child, "exit", () => finish(true));
    addOnce(child, "close", () => finish(true));
  });
}

export async function terminateOwnedProcess(
  child,
  {
    killProcessImpl = process.kill,
    termTimeoutMs = DEFAULT_OWNED_TERM_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_OWNED_KILL_TIMEOUT_MS,
  } = {},
) {
  if (!child || processExited(child)) return { terminated: true, forced: false };
  sendOwnedSignal(child, "SIGTERM", killProcessImpl);
  if (await waitForOwnedExit(child, termTimeoutMs)) return { terminated: true, forced: false };
  sendOwnedSignal(child, "SIGKILL", killProcessImpl);
  const terminated = await waitForOwnedExit(child, killTimeoutMs);
  return { terminated, forced: true };
}

export async function withDeadline(operation, { timeoutMs, label = "operation" } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} deadline must be positive`);
  let timer;
  const operationPromise = Promise.resolve().then(() => typeof operation === "function" ? operation() : operation);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupOwnedProcesses({
  children = [],
  terminate = terminateOwnedProcess,
  optionalCleanup,
  cleanupTimeoutMs = 2_000,
} = {}) {
  const errors = [];
  for (const child of children) {
    try {
      await terminate(child);
    } catch {
      errors.push("owned process termination failed");
    }
  }
  if (optionalCleanup) {
    try {
      await withDeadline(optionalCleanup, { timeoutMs: cleanupTimeoutMs, label: "optional diagnostic cleanup" });
    } catch {
      errors.push("optional diagnostic cleanup failed or timed out");
    }
  }
  return errors;
}

export function runBoundedOwnedCommand({
  filePath,
  args,
  environment,
  cwd,
  maxBuffer = 8 * 1024 * 1024,
  allowedPaths,
  proofPaths,
  exactConvexCli,
  execFileImpl,
  stage = "owned-command",
  timeoutMs = DEFAULT_OWNED_COMMAND_TIMEOUT_MS,
  terminate = terminateOwnedProcess,
  reporter,
  secrets = [],
  onChild,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${stage} deadline must be positive`);
  reportStage(reporter, stage, "start");
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let callbackSettled = false;
    let timer = null;
    const ring = { text: "" };
    const finish = (error, stdout = "", force = false) => {
      if (settled || (timedOut && !force)) return;
      settled = true;
      clearTimeout(timer);
      reportStage(reporter, stage, "end");
      if (error) reject(error instanceof Error ? error : safeFailure(stage, "command failed", ring, secrets));
      else resolve(stdout);
    };
    const fail = (reason) => finish(safeFailure(stage, reason, ring, secrets));
    const onClose = (code, signal) => {
      if (code !== 0 || signal) {
        fail(`process exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
      } else if (!callbackSettled) {
        setImmediate(() => { if (!callbackSettled) finish(null, ""); });
      }
    };
    try {
      child = guardedExecFile({
        filePath,
        args,
        options: { cwd, encoding: "utf8", maxBuffer, detached: true },
        allowedPaths,
        childEnvironment: environment,
        proofPaths,
        exactConvexCli,
        execFileImpl,
        callback: (error, stdout, stderr) => {
          callbackSettled = true;
          if (stderr) appendStderrRing(ring, stderr);
          if (error) finish(safeFailure(stage, error.code ?? error.name ?? "command failed", ring, secrets));
          else finish(null, stdout ?? "");
        },
      });
      onChild?.(child);
      if (!child || typeof child.once !== "function") {
        fail("child process did not expose lifecycle events");
        return;
      }
      if (child.stderr?.on) child.stderr.on("data", (chunk) => appendStderrRing(ring, chunk));
      addOnce(child, "error", (error) => fail(error?.code ?? error?.name ?? "child process error"));
      addOnce(child, "close", onClose);
      if (settled) return;
      timer = setTimeout(async () => {
        timedOut = true;
        let terminationError = null;
        try { await terminate(child); } catch (error) { terminationError = error; }
        finish(terminationError ?? safeFailure(stage, `deadline exceeded after ${timeoutMs}ms`, ring, secrets), "", true);
      }, timeoutMs);
    } catch (error) {
      finish(safeFailure(stage, error?.name ?? "child process could not start", ring, secrets));
    }
  });
}

export function startBoundedOwnedProcess({
  filePath,
  args,
  environment,
  cwd,
  maxBuffer = 8 * 1024 * 1024,
  allowedPaths,
  proofPaths,
  execFileImpl,
  stage = "owned-process-startup",
  timeoutMs = DEFAULT_OWNED_STARTUP_TIMEOUT_MS,
  terminate = terminateOwnedProcess,
  reporter,
  secrets = [],
  onChild,
  onRuntimeFailure,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${stage} startup deadline must be positive`);
  reportStage(reporter, stage, "start");
  return new Promise((resolve, reject) => {
    let child = null;
    let spawned = false;
    let settled = false;
    let runtimeReported = false;
    const ring = { text: "" };
    const timer = setTimeout(async () => {
      if (settled || spawned) return;
      let terminationError = null;
      try { await terminate(child); } catch (error) { terminationError = error; }
      if (settled) return;
      settled = true;
      reportStage(reporter, stage, "end");
      reject(terminationError ?? safeFailure(stage, `startup deadline exceeded after ${timeoutMs}ms`, ring, secrets));
    }, timeoutMs);
    const finishStartupFailure = async (reason) => {
      if (settled || spawned) return;
      clearTimeout(timer);
      let terminationError = null;
      try { if (child) await terminate(child); } catch (error) { terminationError = error; }
      if (settled) return;
      settled = true;
      reportStage(reporter, stage, "end");
      reject(terminationError ?? safeFailure(stage, reason, ring, secrets));
    };
    const runtimeFailure = (reason) => {
      if (runtimeReported) return;
      runtimeReported = true;
      onRuntimeFailure?.(safeFailure(stage, reason, ring, secrets));
    };
    try {
      child = guardedExecFile({
        filePath,
        args,
        options: { cwd, encoding: "utf8", maxBuffer, detached: true },
        allowedPaths,
        childEnvironment: environment,
        proofPaths,
        execFileImpl,
      });
      onChild?.(child);
      if (!child || typeof child.once !== "function") {
        void finishStartupFailure("child process did not expose lifecycle events");
        return;
      }
      if (child.stderr?.on) child.stderr.on("data", (chunk) => appendStderrRing(ring, chunk));
      addOnce(child, "spawn", () => {
        if (settled || spawned) return;
        spawned = true;
        clearTimeout(timer);
        settled = true;
        reportStage(reporter, stage, "end");
        resolve(child);
      });
      addOnce(child, "error", (error) => {
        if (!spawned) void finishStartupFailure(error?.code ?? error?.name ?? "child process error");
        else runtimeFailure(error?.code ?? error?.name ?? "child process error");
      });
      addOnce(child, "exit", (code, signal) => {
        if (!spawned) void finishStartupFailure(`process exited before startup with ${signal ? `signal ${signal}` : `code ${code}`}`);
        else if (code !== 0 || signal) runtimeFailure(`process exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
      });
    } catch (error) {
      void finishStartupFailure(error?.name ?? "child process could not start");
    }
  });
}
