import { describe, expect, test, vi } from "vitest";
import type { HostProcessRegistration } from "@meetless/plugin/readiness-protocol";
import { resolveRuntimeConfig } from "../src/config.js";
import { waitForDaemonForTest } from "../src/desktop.js";
import type { LiveProcessIdentity, PidLockIdentity } from "../src/lifecycle.js";

const managedLock: PidLockIdentity = {
  pid: 4242,
  startedAt: "2026-09-05T00:00:00.000Z",
  hostname: "localhost",
  uid: 501,
  listen: "127.0.0.1:6777",
  desktopManaged: true,
};

describe("daemon startup readiness diagnostics", () => {
  test("accepts the packaged daemon only after its matching registration is attested", async () => {
    const context = readinessContext({ registrations: [registration({ attested: true })] });

    await expect(context.wait()).resolves.toEqual(managedLock);
    expect(context.dependencies.inspectRegistrations).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["PID-lock read or parse error", { readError: syntaxError("credential=lock-secret") }, /pidLock=read-error,registration=not-applicable,errorType=SyntaxError/],
    ["missing PID lock", { lock: null }, /pidLock=missing,registration=not-applicable/],
    ["non-desktopManaged PID lock", { lock: { ...managedLock, desktopManaged: false } }, /pidLock=non-desktop-managed,registration=not-applicable,pid=4242/],
    ["dead PID", { running: false }, /pidLock=dead-pid,registration=not-applicable,pid=4242/],
    ["native registration inspection error", { registrationError: codedError("ownerToken=native-secret", "EACCES") }, /pidLock=live-desktop-managed,registration=inspection-error,pid=4242,errorType=Error,errorCode=EACCES/],
    ["matching registration absent", { registrations: [] }, /pidLock=live-desktop-managed,registration=matching-registration-absent,pid=4242/],
    ["matching registration has attested false", { registrations: [registration({ attested: false })] }, /pidLock=live-desktop-managed,registration=attested-false,pid=4242/],
  ])("distinguishes %s at the deadline", async (_label, options, expected) => {
    const context = readinessContext(options);

    await expect(context.wait()).rejects.toThrow(expected);
  });

  test("retains bounded prior observations and succeeds after transient readiness recovery", async () => {
    let lockAttempts = 0;
    let registrationAttempts = 0;
    const context = readinessContext({
      readLock: async () => (++lockAttempts === 1 ? null : managedLock),
      inspectRegistrations: async () => {
        registrationAttempts += 1;
        return registrationAttempts === 1 ? [] : [registration({ attested: true })];
      },
      timeoutMs: 500,
    });

    await expect(context.wait()).resolves.toEqual(managedLock);
    expect(lockAttempts).toBe(3);
    expect(registrationAttempts).toBe(2);
  });

  test("reports all bounded statuses observed before a deadline", async () => {
    const locks = [null, { ...managedLock, desktopManaged: false }, managedLock];
    let lockIndex = 0;
    const context = readinessContext({
      readLock: async () => lockIndex < locks.length ? locks[lockIndex++]! : managedLock,
      registrations: [],
      timeoutMs: 300,
    });

    await expect(context.wait()).rejects.toThrow(
      /observedPidLock=\[live-desktop-managed,missing,non-desktop-managed\]; observedRegistration=\[matching-registration-absent,not-applicable\]/,
    );
  });

  test("keeps the production daemon-start deadline at 30 seconds with 100 ms polls", async () => {
    const context = readinessContext({ lock: null, useProductionDeadline: true });

    await expect(context.wait()).rejects.toThrow("Timed out starting isolated Meetless daemon");
    expect(context.dependencies.wait).toHaveBeenCalledTimes(300);
    expect(context.dependencies.wait).toHaveBeenCalledWith(100);
  });

  test("keeps error messages, credentials, environment values, and protocol tokens out of diagnostics", async () => {
    const secret = "MEETLESS_HOST_PROCESS_TOKEN=protocol-secret ownerToken=owner-secret password=credential-secret";
    const context = readinessContext({ registrationError: codedError(secret, "EACCES") });

    const error = await context.wait().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("registration=inspection-error");
    expect((error as Error).message).toContain("errorCode=EACCES");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain("protocol-secret");
    expect((error as Error).message).not.toContain("owner-secret");
    expect((error as Error).message).not.toContain("credential-secret");

    const hostileMetadata = codedError("raw-message-secret", "OWNER_TOKEN_SECRET");
    hostileMetadata.name = "CredentialSecret";
    const hostileContext = readinessContext({ registrationError: hostileMetadata });
    const hostileError = await hostileContext.wait().catch((failure: unknown) => failure) as Error;
    expect(hostileError.message).toContain("errorType=Error");
    expect(hostileError.message).not.toContain("CredentialSecret");
    expect(hostileError.message).not.toContain("OWNER_TOKEN_SECRET");
    expect(hostileError.message).not.toContain("raw-message-secret");
  });

  test("preserves immediate child-exit and cancellation behavior", async () => {
    const exited = readinessContext({ childExitCode: 17 });
    await expect(exited.wait()).rejects.toThrow("Meetless daemon exited during startup (17)");
    expect(exited.dependencies.readLock).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new Error("desktop shutdown requested"));
    const cancelled = readinessContext({ signal: controller.signal });
    await expect(cancelled.wait()).rejects.toThrow("desktop shutdown requested");
    expect(cancelled.dependencies.readLock).not.toHaveBeenCalled();
  });

  test("preserves direct-development live-listener readiness without native registration inspection", async () => {
    const inspectDevelopmentProcess = vi.fn(() => liveDevelopmentProcess());
    const context = readinessContext({ packaged: false, inspectDevelopmentProcess });

    await expect(context.wait()).resolves.toEqual(managedLock);
    expect(inspectDevelopmentProcess).toHaveBeenCalledWith(expect.objectContaining({ pid: managedLock.pid }));
    expect(context.dependencies.inspectRegistrations).not.toHaveBeenCalled();
  });
});

interface ReadinessContextOptions {
  packaged?: boolean;
  lock?: PidLockIdentity | null;
  readError?: Error;
  readLock?: () => Promise<PidLockIdentity | null>;
  running?: boolean;
  registrations?: HostProcessRegistration[];
  registrationError?: Error;
  inspectRegistrations?: () => Promise<HostProcessRegistration[]>;
  inspectDevelopmentProcess?: () => LiveProcessIdentity;
  childExitCode?: number | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  useProductionDeadline?: boolean;
}

function readinessContext(options: ReadinessContextOptions = {}) {
  let now = 0;
  const base = resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-daemon-readiness-diagnostics" });
  const packaged = options.packaged ?? true;
  const config = {
    ...base,
    packaged,
    endpoints: { ...base.endpoints, mode: packaged ? "packaged" as const : "development" as const },
  };
  const readLock = vi.fn(options.readLock ?? (async () => {
    if (options.readError) throw options.readError;
    return options.lock === undefined ? managedLock : options.lock;
  }));
  const inspectRegistrations = vi.fn(options.inspectRegistrations ?? (async () => {
    if (options.registrationError) throw options.registrationError;
    return options.registrations ?? [registration({ attested: true })];
  }));
  const dependencies = {
    readLock,
    running: vi.fn(() => options.running ?? true),
    inspectRegistrations,
    inspectDevelopmentProcess: vi.fn(options.inspectDevelopmentProcess ?? (() => liveDevelopmentProcess())),
    now: () => now,
    wait: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
  };
  return {
    dependencies,
    wait: () => waitForDaemonForTest(
      config,
      { exitCode: options.childExitCode ?? null },
      options.signal ?? new AbortController().signal,
      dependencies,
      options.useProductionDeadline ? undefined : options.timeoutMs ?? 100,
    ),
  };
}

function registration(input: { attested: boolean }): HostProcessRegistration {
  return {
    role: "daemon",
    pid: managedLock.pid,
    attested: input.attested,
    identity: {},
  } as HostProcessRegistration;
}

function liveDevelopmentProcess(): LiveProcessIdentity {
  return {
    running: true,
    startedAt: managedLock.startedAt,
    hostname: managedLock.hostname,
    uid: managedLock.uid,
    commandLine: "meetless daemon",
    paseoHomeMatches: true,
    supervisorEntrypointMatches: true,
    desktopManagedMarkerMatches: true,
    listener: { pid: managedLock.pid, address: managedLock.listen!, belongsToSupervisor: true },
  };
}

function syntaxError(message: string): SyntaxError {
  return new SyntaxError(message);
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
