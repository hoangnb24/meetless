import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  PROOF_PORTS,
  assertAllowedExecInvocation,
  assertLoopbackUrl,
  assertMinimalChildEnvironment,
  assertProofChildEnvironment,
  assertProofPathContainment,
  assertProofInputEnvironment,
  assertExactConvexCliInvocation,
  guardedExecFile,
  guardedFetch,
} from "../scripts/prove-managed-convex-guard.mjs";
import {
  appendStderrRing,
  cleanupOwnedProcesses,
  redactDiagnostic,
  runBoundedOwnedCommand,
  startBoundedOwnedProcess,
  terminateOwnedProcess,
} from "../scripts/prove-managed-convex-runtime.mjs";

const proofHome = "/private/tmp/meetless-managed-convex-proof";
const cleanChildEnvironment = {
  CI: "1",
  DISABLE_BEACON: "1",
  HOME: proofHome,
};

function proofPaths(root: string) {
  return {
    root,
    home: path.join(root, "home"),
    xdgConfigHome: path.join(root, "xdg-config"),
    xdgCacheHome: path.join(root, "xdg-cache"),
    xdgDataHome: path.join(root, "xdg-data"),
    xdgStateHome: path.join(root, "xdg-state"),
    tmpDir: path.join(root, "tmp"),
    convexTmpDir: path.join(root, "convex-tmp"),
    storage: path.join(root, "storage"),
    sqlite: path.join(root, "sqlite"),
    project: path.join(root, "project"),
    envDir: path.join(root, "env"),
  };
}

function childEnvironmentFor(paths: ReturnType<typeof proofPaths>) {
  return {
    CI: "1",
    DISABLE_BEACON: "1",
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
}

class FakeOwnedChild extends EventEmitter {
  pid = 7_331;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stderr = new EventEmitter();
  kill = vi.fn((signal: string) => signal);
}

describe("managed Convex local-proof guard", () => {
  test("accepts only the proof-owned loopback origins and minimal child environment", async () => {
    expect(assertLoopbackUrl(`http://127.0.0.1:${PROOF_PORTS.backend}/api`, { port: PROOF_PORTS.backend }).origin).toBe(`http://127.0.0.1:${PROOF_PORTS.backend}`);
    expect(assertLoopbackUrl(`http://127.0.0.1:${PROOF_PORTS.site}/http`, { port: PROOF_PORTS.site }).pathname).toBe("/http");
    expect(assertMinimalChildEnvironment(cleanChildEnvironment)).toBe(cleanChildEnvironment);
    expect(assertProofInputEnvironment({ CI: "1" })).toBeUndefined();

    const fetchSpy = vi.fn(async () => ({ url: `http://127.0.0.1:${PROOF_PORTS.backend}/api`, redirected: false }));
    await expect(guardedFetch(`http://127.0.0.1:${PROOF_PORTS.backend}/api`, { method: "GET" }, { fetchImpl: fetchSpy })).resolves.toMatchObject({ redirected: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });

    const execSpy = vi.fn(() => ({ pid: 42 }));
    expect(guardedExecFile({
      filePath: "/usr/bin/node",
      args: ["--version"],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
      execFileImpl: execSpy,
    })).toMatchObject({ pid: 42 });
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects cloud, DNS, wrong-port, credentialed, query, and fragment URLs before fetch", async () => {
    const fetchSpy = vi.fn();
    const invalidUrls = [
      "https://cloud.example.invalid/api",
      `http://localhost:${PROOF_PORTS.backend}/api`,
      `http://127.0.0.1:${PROOF_PORTS.backend + 1}/api`,
      `http://user:password@127.0.0.1:${PROOF_PORTS.backend}/api`,
      `http://127.0.0.1:${PROOF_PORTS.backend}/api?x=1`,
      `http://127.0.0.1:${PROOF_PORTS.backend}/api#fragment`,
    ];
    for (const url of invalidUrls) {
      await expect(guardedFetch(url, {}, { fetchImpl: fetchSpy })).rejects.toThrow(/guard rejected/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects selectors, deploy credentials, proxies, preload/TLS overrides, and shell tools before process or network calls", async () => {
    const fetchSpy = vi.fn();
    const execSpy = vi.fn();
    const forbiddenInputs = [
      { CONVEX_DEPLOYMENT: "present" },
      { CONVEX_DEPLOY_KEY: "present" },
      { CONVEX_DEPLOYMENT_TOKEN: "present" },
      { CONVEX_OVERRIDE_ACCESS_TOKEN: "present" },
      { CONVEX_PROVISION_HOST: "present" },
      { HTTPS_PROXY: "present" },
      { NODE_OPTIONS: "present" },
      { NODE_EXTRA_CA_CERTS: "present" },
      { SENTRY_DSN: "present" },
      { CONVEX_VERSION_API_ORIGIN: "present" },
      { CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS: "present" },
      { NPM_CONFIG_USERCONFIG: "present" },
      { COREPACK_HOME: "present" },
    ];
    for (const input of forbiddenInputs) expect(() => assertProofInputEnvironment(input)).toThrow(/environment input/i);
    expect(() => assertAllowedExecInvocation({
      filePath: "/usr/bin/node",
      args: ["--deployment", "local"],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
    })).toThrow(/selector/i);
    expect(() => assertAllowedExecInvocation({
      filePath: "/usr/bin/node",
      args: ["npx", "convex"],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
    })).toThrow(/npx\/curl/i);
    expect(() => assertAllowedExecInvocation({
      filePath: "/usr/bin/curl",
      args: ["http://127.0.0.1:3210"],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
    })).toThrow(/allowlisted/i);
    expect(() => assertAllowedExecInvocation({
      filePath: "/usr/bin/node",
      args: ["--version"],
      options: { shell: true },
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
    })).toThrow(/shell/i);
    expect(() => assertAllowedExecInvocation({
      filePath: "/usr/bin/node",
      args: ["--version"],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: { ...cleanChildEnvironment, HTTP_PROXY: "present" },
    })).toThrow(/unrelated|environment input/i);
    expect(() => assertMinimalChildEnvironment({ ...cleanChildEnvironment, PATH: "/bin" })).toThrow(/unrelated/i);
    for (const args of [
      ["--prod"],
      ["--admin-key", "fixture-token"],
      ["--proxy", "http://127.0.0.1:3210"],
      ["--redirect", "follow"],
      ["CONVEX_DEPLOYMENT_TOKEN=fixture-token"],
      ["--url", "https://cloud.example.invalid"],
    ]) {
      expect(() => assertAllowedExecInvocation({
        filePath: "/usr/bin/node",
        args,
        options: {},
        allowedPaths: ["/usr/bin/node"],
        childEnvironment: cleanChildEnvironment,
      })).toThrow(/cloud|selector|proxy|token|redirect|credential|URL/i);
    }
    await expect(guardedFetch(`http://127.0.0.1:${PROOF_PORTS.backend}/api`, { redirect: "follow" }, { fetchImpl: fetchSpy })).rejects.toThrow(/redirect/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => guardedExecFile({
      filePath: "/usr/bin/curl",
      args: [],
      options: {},
      allowedPaths: ["/usr/bin/node"],
      childEnvironment: cleanChildEnvironment,
      execFileImpl: execSpy,
    })).toThrow(/allowlisted/i);
    expect(execSpy).not.toHaveBeenCalled();
  });

  test("rejects a returned redirect or cloud URL after the local fetch boundary", async () => {
    const redirectedResponse = vi.fn(async () => ({ url: "https://cloud.example.invalid/redirect", redirected: true }));
    await expect(guardedFetch(`http://127.0.0.1:${PROOF_PORTS.backend}/api`, {}, { fetchImpl: redirectedResponse })).rejects.toThrow(/HTTP|loopback|redirect/i);
    expect(redirectedResponse).toHaveBeenCalledTimes(1);
  });

  test("bounds every guarded fetch with an abort signal", async () => {
    const fetchSpy = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("fetch aborted by guard deadline")), { once: true });
    }));
    await expect(guardedFetch(`http://127.0.0.1:${PROOF_PORTS.backend}/api`, {}, { fetchImpl: fetchSpy, timeoutMs: 5 })).rejects.toThrow(/aborted/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("requires explicit self-hosted connection variables without allowing extras", () => {
    const environment = {
      ...cleanChildEnvironment,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${PROOF_PORTS.backend}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: "local-admin-key",
    };
    expect(assertMinimalChildEnvironment(environment, { requireSelfHosted: true })).toBe(environment);
    expect(() => assertMinimalChildEnvironment({ ...environment, CONVEX_DEPLOYMENT: "present" }, { requireSelfHosted: true })).toThrow(/unrelated|environment/i);
    expect(() => assertMinimalChildEnvironment({ ...environment, CONVEX_SELF_HOSTED_URL: "https://cloud.example.invalid" }, { requireSelfHosted: true })).toThrow(/HTTP|loopback/i);
  });

  test("accepts only the exact local Convex CLI script and argv", () => {
    const exact = {
      nodePath: "/usr/bin/node",
      convexCliPath: "/repo/node_modules/convex/bin/main.js",
      envFilePath: "/private/tmp/proof/env/convex-cli.env",
      envFileRoot: "/private/tmp/proof/env",
    };
    const args = [
      exact.convexCliPath,
      "dev",
      "--once",
      "--typecheck", "enable",
      "--codegen", "enable",
      "--tail-logs", "disable",
      "--env-file", exact.envFilePath,
    ];
    expect(() => assertExactConvexCliInvocation({ filePath: exact.nodePath, args, ...exact })).not.toThrow();
    expect(() => assertExactConvexCliInvocation({ filePath: exact.nodePath, args: ["/tmp/arbitrary.js", ...args.slice(1)], ...exact })).toThrow(/exact.*script|argv/i);
    expect(() => assertExactConvexCliInvocation({ filePath: exact.nodePath, args: [...args, "--deployment", "local"], ...exact })).toThrow(/exact.*script|argv/i);
    expect(() => assertExactConvexCliInvocation({ filePath: exact.nodePath, args, ...exact, envFilePath: "/private/tmp/outside.env" })).toThrow(/environment root/i);
  });

  test("kills and settles a timed-out owned child with bounded diagnostics", async () => {
    const child = new FakeOwnedChild();
    const execSpy = vi.fn(() => child);
    const terminate = vi.fn(async (candidate: FakeOwnedChild) => {
      candidate.exitCode = 137;
      candidate.signalCode = "SIGKILL";
    });
    const reporter = vi.fn();
    await expect(runBoundedOwnedCommand({
      filePath: "/usr/bin/node",
      args: ["--version"],
      environment: cleanChildEnvironment,
      allowedPaths: ["/usr/bin/node"],
      execFileImpl: execSpy,
      timeoutMs: 5,
      terminate,
      reporter,
      stage: "timeout-child",
    })).rejects.toThrow(/deadline exceeded/);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(child);
    expect(reporter).toHaveBeenNthCalledWith(1, "[managed-convex-diagnostic] timeout-child:start");
    expect(reporter).toHaveBeenLastCalledWith("[managed-convex-diagnostic] timeout-child:end");
  });

  test("keeps stderr diagnostics bounded and redacts secret-shaped values", async () => {
    const ring = { text: "" };
    appendStderrRing(ring, "prefix-", 8);
    appendStderrRing(ring, "suffix", 8);
    expect(Buffer.byteLength(ring.text, "utf8")).toBeLessThanOrEqual(8);
    expect(redactDiagnostic("authorization: fixture-secret-value", ["fixture-secret-value"])).toBe("authorization: <redacted>");

    const child = new FakeOwnedChild();
    const secret = "fixture-admin-secret";
    const execSpy = vi.fn(() => {
      queueMicrotask(() => child.stderr.emit("data", `${"x".repeat(8_000)}authorization: ${secret}\n`));
      return child;
    });
    const terminate = vi.fn(async (candidate: FakeOwnedChild) => {
      candidate.exitCode = 137;
      candidate.signalCode = "SIGKILL";
    });
    const result = runBoundedOwnedCommand({
      filePath: "/usr/bin/node",
      args: ["--version"],
      environment: cleanChildEnvironment,
      allowedPaths: ["/usr/bin/node"],
      execFileImpl: execSpy,
      timeoutMs: 5,
      terminate,
      secrets: [secret],
      stage: "redacted-stderr",
    });
    await expect(result).rejects.toThrow(/deadline exceeded/);
    try {
      await result;
    } catch (error) {
      const message = String(error?.message ?? error);
      expect(message).not.toContain(secret);
      expect(message).toContain("<redacted>");
      const stderrTail = (error as { stderrTail?: string }).stderrTail ?? "";
      expect(Buffer.byteLength(stderrTail, "utf8")).toBeLessThanOrEqual(4_096);
    }
  });

  test("terminates only the recorded process group with SIGTERM then bounded SIGKILL", async () => {
    const child = new FakeOwnedChild();
    const signals: Array<[number, string]> = [];
    const killProcessImpl = vi.fn((pid: number, signal: string) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        child.exitCode = 137;
        child.signalCode = "SIGKILL";
      }
    });
    await expect(terminateOwnedProcess(child, { killProcessImpl, termTimeoutMs: 5, killTimeoutMs: 5 })).resolves.toMatchObject({ terminated: true, forced: true });
    expect(signals).toEqual([[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test.each([
    ["startup error", (child: FakeOwnedChild) => queueMicrotask(() => child.emit("error", { code: "EACCES" }))],
    ["startup exit", (child: FakeOwnedChild) => queueMicrotask(() => child.emit("exit", 1, null))],
  ])("settles a backend that reports %s before startup", async (_label, scheduleFailure) => {
    const child = new FakeOwnedChild();
    const execSpy = vi.fn(() => {
      scheduleFailure(child);
      return child;
    });
    const terminate = vi.fn(async (candidate: FakeOwnedChild) => { candidate.exitCode = 1; });
    await expect(startBoundedOwnedProcess({
      filePath: "/usr/bin/node",
      args: ["--version"],
      environment: cleanChildEnvironment,
      allowedPaths: ["/usr/bin/node"],
      execFileImpl: execSpy,
      timeoutMs: 100,
      terminate,
      reporter: vi.fn(),
      stage: "backend-startup",
    })).rejects.toThrow(/startup|EACCES|code 1/i);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(child);
  });

  test("settles an owned backend after spawn and records a later exit", async () => {
    const child = new FakeOwnedChild();
    const runtimeFailure = vi.fn();
    const execSpy = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await expect(startBoundedOwnedProcess({
      filePath: "/usr/bin/node",
      args: ["--version"],
      environment: cleanChildEnvironment,
      allowedPaths: ["/usr/bin/node"],
      execFileImpl: execSpy,
      timeoutMs: 100,
      reporter: vi.fn(),
      onRuntimeFailure: runtimeFailure,
      stage: "backend-startup",
    })).resolves.toBe(child);
    child.emit("exit", 1, null);
    expect(runtimeFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: "backend-startup" }));
  });

  test("terminates owned children before bounded optional cleanup", async () => {
    const child = new FakeOwnedChild();
    const events: string[] = [];
    const errors = await cleanupOwnedProcesses({
      children: [child],
      terminate: vi.fn(async (candidate: FakeOwnedChild) => {
        events.push("terminate");
        candidate.exitCode = 0;
      }),
      optionalCleanup: async () => {
        events.push("optional-cleanup");
        await new Promise(() => undefined);
      },
      cleanupTimeoutMs: 5,
    });
    expect(events).toEqual(["terminate", "optional-cleanup"]);
    expect(errors).toEqual(["optional diagnostic cleanup failed or timed out"]);
  });

  test("contains every writable/state path in one canonical proof root", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-guard-root-")));
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-guard-outside-")));
    try {
      const paths = proofPaths(root);
      const environment = childEnvironmentFor(paths);
      await expect(assertProofPathContainment({
        root,
        paths,
        forbiddenRoots: [homedir(), path.resolve("."), path.join(path.resolve("."), ".convex"), path.join(path.resolve("."), ".env.local")],
      })).resolves.toMatchObject({ root });
      expect(assertProofChildEnvironment(environment, { paths })).toBe(environment);
      const execSpy = vi.fn(() => ({ pid: 42 }));
      expect(guardedExecFile({
        filePath: "/usr/bin/node",
        args: ["--version"],
        options: {},
        allowedPaths: ["/usr/bin/node"],
        childEnvironment: environment,
        proofPaths: paths,
        execFileImpl: execSpy,
      })).toMatchObject({ pid: 42 });
      expect(execSpy).toHaveBeenCalledTimes(1);

      const invalidPathCases = [
        { name: "real HOME", paths: { ...paths, home: homedir() } },
        { name: "real XDG config", paths: { ...paths, xdgConfigHome: path.join(homedir(), ".config") } },
        { name: "real XDG cache", paths: { ...paths, xdgCacheHome: path.join(homedir(), ".cache") } },
        { name: "repository .convex", paths: { ...paths, storage: path.resolve(".convex") } },
        { name: "repository .env.local", paths: { ...paths, envDir: path.resolve(".env.local") } },
        { name: "outside temp path", paths: { ...paths, project: path.join(outside, "project") } },
        { name: "parent traversal", paths: { ...paths, project: `${root}/../outside-project` } },
      ];
      const escapedLink = path.join(root, "escaped-link");
      await symlink(outside, escapedLink);
      invalidPathCases.push({ name: "symlink escape", paths: { ...paths, project: path.join(escapedLink, "project") } });

      for (const invalid of invalidPathCases) {
        await expect(assertProofPathContainment({
          root,
          paths: invalid.paths,
          forbiddenRoots: [homedir(), path.resolve("."), path.join(path.resolve("."), ".convex"), path.join(path.resolve("."), ".env.local")],
        })).rejects.toThrow(/guard rejected|proof root|escapes|overlaps|canonical|parent traversal/i);
      }

      const inheritedEnvironment = { ...environment, HOME: homedir() };
      expect(() => assertProofChildEnvironment(inheritedEnvironment, { paths })).toThrow(/proof-owned/);
      const realXdgEnvironment = { ...environment, XDG_CONFIG_HOME: path.join(homedir(), ".config") };
      expect(() => assertProofChildEnvironment(realXdgEnvironment, { paths })).toThrow(/proof-owned/);
      expect(() => guardedExecFile({
        filePath: "/usr/bin/node",
        args: ["--version"],
        options: {},
        allowedPaths: ["/usr/bin/node"],
        childEnvironment: inheritedEnvironment,
        proofPaths: paths,
        execFileImpl: execSpy,
      })).toThrow(/proof-owned/);
      expect(execSpy).toHaveBeenCalledTimes(1);
      const fetchSpy = vi.fn();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("keeps the proof orchestration free of selector, shared-state, shell, and scan fallbacks", () => {
    const source = readFileSync(path.resolve("scripts/prove-managed-convex-local.mjs"), "utf8");
    expect(source).not.toContain("npx");
    expect(source).not.toContain("--deployment");
    expect(source).toContain("path.join(repositoryRoot, \".env.local\")");
    expect(source).not.toContain(".convex/local/default");
    expect(source).not.toContain("execFileSync");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("lsof");
    expect(source).not.toMatch(/\bps\b/u);
    expect(source).toContain("guardedFetch");
    expect(source).toContain("runBoundedOwnedCommand");
    expect(source).toContain("startBoundedOwnedProcess");
    expect(source).toContain("--diagnostic-only");
    expect(source).toContain("network-denied sandbox");
    expect(source).toContain("instance_name");
    expect(source).toContain("exactConvexCli");
    expect(source).toContain("withDeadline");
    expect(source).toContain("update_environment_variables");
  });
});
