import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RecordingRuntimeReadinessResponse } from "@meetless/plugin/readiness-protocol";
import { resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  RECORDING_READINESS_AUTHORITY,
  assertAttestedProcessOwnership,
  assertPreOwnerRecordingReady,
  inspectNativeArgumentVector,
  prepareCollisionEvidence,
  requestRecordingRuntimeReadiness,
  type DaemonMeetlessPluginAttestation,
  type RuntimeReadinessReport,
  verifyCollisionEvidence,
  waitForRecordingRuntime,
} from "../src/readiness.js";
import {
  activateUiTestRun,
  createUiTestExportLease,
  newUiTestEnvelope,
  writeUiTestEnvelope,
} from "../src/ui-test-envelope.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("production recording readiness invariant", () => {
  test("accepts an idempotent current-runtime identity only after plugin bootstrap", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config);
    const bootstrapPlugin = vi.fn(async () => daemonAttestation(config, response));
    const requestReadiness = vi.fn(async () => response);
    const verifyOwnership = vi.fn(async () => undefined);

    const first = await waitForRecordingRuntime(config, {
      timeoutMs: 500,
      dependencies: { bootstrapPlugin, requestReadiness, verifyOwnership },
    });
    const second = await waitForRecordingRuntime(config, {
      timeoutMs: 500,
      dependencies: { bootstrapPlugin, requestReadiness, verifyOwnership },
    });

    expect(first.runtime.instanceId).toBe(response.runtime.instanceId);
    expect(second.runtime.instanceId).toBe(response.runtime.instanceId);
    expect(first.status).toEqual(idleStatus());
    expect(bootstrapPlugin).toHaveBeenCalledTimes(2);
    expect(verifyOwnership).toHaveBeenCalledTimes(2);
  });

  test("immediate relaunch waits for exact catalog bootstrap, rejects stale socket state, and reaches recoverable", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const recovered = { ...idleStatus(), status: "recoverable" as const, recordingId: "retained-recording", meetingId: "retained-meeting", error: "daemon restarted while capture was active" };
    const response = await runtimeResponse(config, { status: recovered });
    let bootstrapAttempts = 0;
    let statusAttempts = 0;
    const result = await waitForRecordingRuntime(config, {
      timeoutMs: 500,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => {
          bootstrapAttempts += 1;
          if (bootstrapAttempts < 3) throw new Error('daemon catalog does not contain the required "meetless" plugin yet');
          return daemonAttestation(config, response);
        },
        requestReadiness: async () => {
          statusAttempts += 1;
          if (statusAttempts === 1) throw new Error("stale recording socket closed before response");
          return response;
        },
        verifyOwnership: async () => undefined,
      },
    });

    expect(bootstrapAttempts).toBe(3);
    expect(statusAttempts).toBe(2);
    expect(result.status).toEqual(recovered);
  });

  test("outer startup timeout bounds a hung catalog/bootstrap operation", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const started = Date.now();
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 25,
      dependencies: { bootstrapPlugin: () => new Promise<DaemonMeetlessPluginAttestation>(() => undefined) },
    })).rejects.toThrow(/failed closed at Meetless plugin bootstrap.*outer startup deadline/s);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("outer startup timeout aborts bootstrap before late initialization and connection effects", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    let initialized = false;
    let connectionOpen = true;
    let observedAbort = false;
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 25,
      dependencies: {
        bootstrapPlugin: async (_config, { signal }) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { initialized = true; resolve(); }, 200);
            signal.addEventListener("abort", () => {
              observedAbort = true;
              connectionOpen = false;
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          throw new Error("bootstrap must not complete");
        },
      },
    })).rejects.toThrow(/failed closed at Meetless plugin bootstrap.*outer startup deadline/s);
    await delay(225);
    expect(observedAbort).toBe(true);
    expect(connectionOpen).toBe(false);
    expect(initialized).toBe(false);
  });

  test("desktop shutdown aborts an in-flight bootstrap and closes its owned operation", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const controller = new AbortController();
    let connectionOpen = true;
    let initialized = false;
    const pending = waitForRecordingRuntime(config, {
      timeoutMs: 5_000,
      signal: controller.signal,
      dependencies: {
        bootstrapPlugin: async (_config, { signal }) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { initialized = true; resolve(); }, 500);
            signal.addEventListener("abort", () => {
              connectionOpen = false;
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          throw new Error("bootstrap must not complete after desktop shutdown");
        },
      },
    });
    await delay(10);
    controller.abort(new Error("Meetless desktop received SIGTERM"));
    await expect(pending).rejects.toThrow("Meetless desktop received SIGTERM");
    await delay(525);
    expect(connectionOpen).toBe(false);
    expect(initialized).toBe(false);
  });

  test("a replaced socket fails even when the old listener returns a matching request ID", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "recording.sock");
    const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);
    const firstHttp = createServer();
    const firstWs = new WebSocketServer({ noServer: true });
    let replacementHttp: Server | null = null;
    firstHttp.on("upgrade", (request, socket, head) => {
      firstWs.handleUpgrade(request, socket, head, (client) => firstWs.emit("connection", client, request));
    });
    firstWs.on("connection", (client) => {
      client.on("message", (data) => void (async () => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        await unlink(socketPath);
        replacementHttp = createServer();
        await listen(replacementHttp, socketPath);
        const replacement = await stat(socketPath);
        client.send(JSON.stringify(await runtimeResponse(config, {
          requestId: request.requestId,
          instanceId: "e9250d8e-419d-4f90-98cb-e52fc47e8d7a",
          pluginPid: 321,
          socketIdentity: { device: replacement.dev, inode: replacement.ino },
        })));
      })());
    });
    await listen(firstHttp, socketPath);
    try {
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 100,
        retryMs: 1,
        dependencies: {
          bootstrapPlugin: async () => ({
            pluginId: "meetless",
            sourcePath: config.paths.plugin,
            status: "running",
            runtimeInstanceId: "e9250d8e-419d-4f90-98cb-e52fc47e8d7a",
            pluginPid: 321,
          }),
          verifyOwnership: async () => undefined,
        },
      })).rejects.toThrow(
        new RegExp(`failed closed at authoritative recording status.*Socket existence.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
      );
    } finally {
      await closeWebSocketServer(firstWs);
      await closeServer(firstHttp);
      if (replacementHttp) await closeServer(replacementHttp);
    }
  });

  test("connects to a recording socket whose path contains spaces", async () => {
    const root = await mkdtemp("/tmp/meetless readiness-");
    roots.add(root);
    const socketDirectory = path.join(root, "Application Support");
    const socketPath = path.join(socketDirectory, "recording-control.sock");
    await mkdir(socketDirectory, { recursive: true });
    const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);
    const http = createServer();
    const websocket = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
    });
    websocket.on("connection", (client) => {
      client.on("message", (data) => void (async () => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        const identity = await stat(socketPath);
        client.send(JSON.stringify(await runtimeResponse(config, {
          requestId: request.requestId,
          socketIdentity: { device: identity.dev, inode: identity.ino },
        })));
      })());
    });
    await listen(http, socketPath);
    try {
      const response = await requestRecordingRuntimeReadiness(socketPath);
      expect(response.ok).toBe(true);
      expect(response.runtime.socketPath).toBe(socketPath);
    } finally {
      await closeWebSocketServer(websocket);
      await closeServer(http);
    }
  });

  test("timed-out socket status terminates every readiness connection", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "recording.sock");
    const config = withSocket(resolveRuntimeConfig({ runtimeRoot: root }), socketPath);
    const http = createServer();
    const websocket = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
    });
    await listen(http, socketPath);
    const response = await runtimeResponse(config);
    try {
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 35,
        retryMs: 1,
        dependencies: {
          bootstrapPlugin: async () => daemonAttestation(config, response),
          verifyOwnership: async () => undefined,
        },
      })).rejects.toThrow(/failed closed at authoritative recording status.*outer startup deadline/s);
      await vi.waitFor(() => expect(websocket.clients.size).toBe(0));
    } finally {
      await closeWebSocketServer(websocket);
      await closeServer(http);
    }
  });

  test("an unavailable plugin fails before the desktop can expose controls", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 100,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => { throw new Error('required "meetless" plugin is absent'); },
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at Meetless plugin bootstrap.*no desktop controls were exposed.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}`, "s"),
    );
  });

  test("rejects every fixture-helper argument mode and equivalent production argv", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    for (const argument of ["--fixture", "--timeline-fixture", "--invalid-claim-fixture", "--jitter-fixture", "--future-fixture-mode"]) {
      const response = await runtimeResponse(config, { arguments: [argument] });
      await expect(waitForRecordingRuntime(config, {
        timeoutMs: 20,
        retryMs: 1,
        dependencies: {
          bootstrapPlugin: async () => daemonAttestation(config, response),
          requestReadiness: async () => response,
        },
      })).rejects.toThrow(new RegExp(`helper arguments are forbidden in production: ${argument}`));
    }
  });

  test("fixture capture and differing daemon export configuration cannot pass", async () => {
    const resolved = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const fixtureConfig = {
      ...resolved,
      environment: { ...resolved.environment, MEETLESS_CAPTURE_MODE: "fixture" },
    };
    await expect(waitForRecordingRuntime(fixtureConfig, { timeoutMs: 20 })).rejects.toThrow(/rejects MEETLESS_CAPTURE_MODE=fixture.*Authority/s);

    const wrongExport = await runtimeResponse(resolved, { exportRoot: path.join(resolved.paths.root, "other-exports") });
    await expect(waitForRecordingRuntime(resolved, {
      timeoutMs: 20,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => daemonAttestation(resolved, wrongExport),
        requestReadiness: async () => wrongExport,
      },
    })).rejects.toThrow(/daemon export root differs from launcher configuration/u);
  });

  test("controlled readiness requires the consumed lease root and generation parity", async () => {
    const root = await temporaryRoot();
    const lease = await createUiTestExportLease({
      proofSessionId: `readiness-${randomUUID().slice(0, 12)}`,
      restartGeneration: 1,
      runtimeRoot: root,
      repositoryRoot: process.cwd(),
    });
    roots.add(lease.exportRoot);
    const envelope = newUiTestEnvelope({ cdpPort: 45_401, transcriptionMode: "fake", exportLease: lease });
    await writeUiTestEnvelope(root, envelope);
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    const marker = await activateUiTestRun(config, controlledHostIdentity());
    expect(marker?.restartGeneration).toBe(1);
    expect(config.paths.recordingExports).toBe(lease.exportRoot);

    const response = await runtimeResponse(config, {
      captureMode: "fixture",
      exportRoot: lease.exportRoot,
      uiTest: marker!.identity,
    });
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 250,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => daemonAttestation(config, response),
        requestReadiness: async () => response,
        verifyOwnership: async () => undefined,
      },
    })).resolves.toMatchObject({ runtime: { export: { root: lease.exportRoot } } });

    const wrongRoot = path.join(lease.exportRoot, "wrong");
    const wrongResponse = await runtimeResponse(config, {
      captureMode: "fixture",
      exportRoot: wrongRoot,
      uiTest: marker.identity,
    });
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 50,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => daemonAttestation(config, wrongResponse),
        requestReadiness: async () => wrongResponse,
        verifyOwnership: async () => undefined,
      },
    })).rejects.toThrow(/daemon export root differs from launcher configuration/u);
  });

  test("binds to the daemon-routed plugin PID when multiple plugin descendants exist", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config, { pluginPid: 21, helperPid: 31 });
    const processes = [
      { pid: 10, ppid: 1, command: "daemon" },
      { pid: 20, ppid: 10, command: "node /wrong/plugin-process.js" },
      { pid: 21, ppid: 10, command: "node /right/plugin-process.js" },
      { pid: 30, ppid: 20, command: "/repo/meetless-capture --fixture" },
      { pid: 31, ppid: 21, command: "/repo/meetless-capture" },
    ];
    const inspection = {
      executablePath: async () => response.runtime.capture.executable.configuredPath,
      argumentVector: async () => [response.runtime.capture.executable.configuredPath],
    };
    await expect(assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, daemonPluginPid: 21, helperPid: 31,
      helperExecutable: response.runtime.capture.executable, helperArguments: [], processes, inspection,
    })).resolves.toBeUndefined();
    await expect(assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, daemonPluginPid: 21, helperPid: 30,
      helperExecutable: response.runtime.capture.executable, helperArguments: [], processes, inspection,
    })).rejects.toThrow(/not a descendant of plugin PID 21/u);
  });

  test("rejects wrapper executables, argv0 spoofing, and arguments without splitting paths on spaces", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config, { pluginPid: 21, helperPid: 31 });
    const processes = [
      { pid: 10, ppid: 1, command: "daemon" },
      { pid: 21, ppid: 10, command: "node plugin-process.js" },
      { pid: 31, ppid: 21, command: "untrusted flattened text" },
    ];
    await expect(assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, daemonPluginPid: 21, helperPid: 31,
      helperExecutable: response.runtime.capture.executable, helperArguments: [], processes,
      inspection: {
        executablePath: async () => "/bin/sh",
        argumentVector: async () => [response.runtime.capture.executable.configuredPath],
      },
    })).rejects.toThrow(/does not match the attested production helper.*authority/s);

    const spacedExecutable = {
      ...response.runtime.capture.executable,
      configuredPath: "/Applications/Meetless Helper/bin/capture helper",
    };
    await expect(assertAttestedProcessOwnership({
      daemonPid: 10, pluginPid: 21, daemonPluginPid: 21, helperPid: 31,
      helperExecutable: spacedExecutable, helperArguments: [], processes,
      inspection: {
        executablePath: async () => response.runtime.capture.executable.configuredPath,
        argumentVector: async () => [spacedExecutable.configuredPath, "--timeline-fixture", "value with spaces"],
      },
    })).rejects.toThrow(/unexpected native argv.*timeline-fixture.*production requires exactly/s);

    for (const argumentVector of [
      [],
      [""],
      [" "],
      [response.runtime.capture.executable.configuredPath, ""],
      [response.runtime.capture.executable.configuredPath, " "],
      [response.runtime.capture.executable.configuredPath, "--fixture"],
    ]) {
      await expect(assertAttestedProcessOwnership({
        daemonPid: 10, pluginPid: 21, daemonPluginPid: 21, helperPid: 31,
        helperExecutable: response.runtime.capture.executable, helperArguments: [], processes,
        inspection: {
          executablePath: async () => response.runtime.capture.executable.configuredPath,
          argumentVector: async () => argumentVector,
        },
      })).rejects.toThrow(/unexpected native argv.*production requires exactly/s);
    }
  });

  test("native macOS argv inspection preserves empty, whitespace, and argument boundaries", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)", "", " ", "--fixture=value with spaces"], {
      stdio: "ignore",
    });
    try {
      await waitForSpawn(child);
      const arguments_ = await inspectNativeArgumentVector(child.pid!);
      expect(arguments_.slice(-3)).toEqual(["", " ", "--fixture=value with spaces"]);
    } finally {
      await stopChild(child);
    }
  });

  test("exact no-argument native process invocation passes production helper ownership", async () => {
    const executablePath = "/usr/bin/yes";
    const child = spawn(executablePath, [], { stdio: "ignore" });
    try {
      await waitForSpawn(child);
      const [info, resolved, bytes] = await Promise.all([
        stat(executablePath),
        realpath(executablePath),
        readFile(executablePath),
      ]);
      await expect(assertAttestedProcessOwnership({
        daemonPid: 10,
        pluginPid: 21,
        daemonPluginPid: 21,
        helperPid: child.pid!,
        helperExecutable: {
          configuredPath: executablePath,
          realPath: resolved,
          device: info.dev,
          inode: info.ino,
          byteLength: info.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        helperArguments: [],
        processes: [
          { pid: 10, ppid: 1, command: "daemon" },
          { pid: 21, ppid: 10, command: "plugin" },
          { pid: child.pid!, ppid: 21, command: "ignored flattened text" },
        ],
      })).resolves.toBeUndefined();
    } finally {
      await stopChild(child);
    }
  });

  test("rejects an unrelated generic plugin worker/listener returning otherwise matching readiness", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    const response = await runtimeResponse(config);
    const unrelatedSource = path.join(root, "generic-plugin");
    await mkdir(unrelatedSource);
    const generic: DaemonMeetlessPluginAttestation = {
      ...daemonAttestation(config, response),
      pluginId: "generic" as "meetless",
      sourcePath: unrelatedSource,
    };
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 50,
      dependencies: {
        bootstrapPlugin: async () => generic,
        requestReadiness: async () => response,
        verifyOwnership: async () => undefined,
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at daemon Meetless plugin identity.*generic.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
    );
  });

  test("wrong attested plugin ownership fails with the accepted authority and next action", async () => {
    const config = resolveRuntimeConfig({ runtimeRoot: await temporaryRoot() });
    const response = await runtimeResponse(config);
    await expect(waitForRecordingRuntime(config, {
      timeoutMs: 30,
      retryMs: 1,
      dependencies: {
        bootstrapPlugin: async () => daemonAttestation(config, response),
        requestReadiness: async () => response,
        verifyOwnership: async () => { throw new Error("authoritative Meetless plugin PID is not owned"); },
      },
    })).rejects.toThrow(
      new RegExp(`failed closed at authoritative recording status.*plugin PID is not owned.*${escapeRegex(RECORDING_READINESS_AUTHORITY)}.*runtime:stop`, "s"),
    );
  });

  test("pre-owner report accepts only daemon-bound collision evidence and preserves source chunks", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    const sourceEvidence = path.join(root, "meeting-store", "sessions", "recording-1", "microphone.wav");
    await mkdir(path.dirname(sourceEvidence), { recursive: true });
    await writeFile(sourceEvidence, "source evidence remains\n");
    const collisionPath = path.join(root, "collision.mp3");
    await writeFile(collisionPath, "sentinel\n");
    const collisionBytes = await readFile(collisionPath);
    const report = activeReport(sourceEvidence);
    const response = await runtimeResponse(config, {
      instanceId: report.plugin.instanceId,
      pluginPid: report.plugin.pid,
      helperPid: report.helper?.pid ?? null,
      socketIdentity: { device: report.socket.device, inode: report.socket.inode },
      status: activeStatus(),
      collision: {
        path: collisionPath,
        byteLength: collisionBytes.byteLength,
        sha256: createHash("sha256").update(collisionBytes).digest("hex"),
        plannedPublishedPath: path.join(root, "planned.mp3"),
        recordingId: "recording-1",
        runtimeInstanceId: report.plugin.instanceId,
        exportRoot: config.paths.recordingExports,
        exportStamp: "2026-08-17T14:59:59.000+07:00",
        preparedAt: "2026-08-17T08:00:00.000Z",
        validUntil: null,
      },
    });
    const prepared = await prepareCollisionEvidence(config, report, async () => response);

    expect(prepared.stopTarget.prepared).toBe(true);
    expect(prepared.collisionTarget?.plannedPublishedPath).toBe(path.join(root, "planned.mp3"));
    expect(await verifyCollisionEvidence(prepared)).toBe(true);
    await expect(access(sourceEvidence)).resolves.toBeUndefined();
  });

  test("pre-owner failure surfaces the recorder cause and corrective route", () => {
    const report = activeReport("/tmp/chunk.wav");
    report.session.status = "failed";
    report.session.error = "The user declined TCCs for application, window, display capture";
    report.helper = null;
    report.chunks = { microphone: 0, system: 0, total: 0, evidencePaths: [] };
    expect(() => assertPreOwnerRecordingReady(report)).toThrow(
      /recorder error: The user declined TCCs.*Start recording only through the Electron controls.*Authority/s,
    );
  });
});

async function runtimeResponse(config: RuntimeConfig, overrides: {
  requestId?: string;
  instanceId?: string;
  pluginPid?: number;
  helperPid?: number | null;
  arguments?: string[];
  exportRoot?: string;
  captureMode?: "production" | "fixture";
  uiTest?: RecordingRuntimeReadinessResponse["runtime"]["uiTest"];
  socketIdentity?: { device: number; inode: number };
  status?: RecordingRuntimeReadinessResponse["status"];
  collision?: RecordingRuntimeReadinessResponse["collision"];
} = {}): Promise<RecordingRuntimeReadinessResponse> {
  const [helperInfo, helperRealPath, helperBytes] = await Promise.all([
    stat(config.paths.captureHelper),
    realpath(config.paths.captureHelper),
    readFile(config.paths.captureHelper),
  ]);
  return {
    version: 1,
    type: "recording.runtime.readiness",
    requestId: overrides.requestId ?? "request",
    ok: true,
    runtime: {
      instanceId: overrides.instanceId ?? randomUUID(),
      startedAt: "2026-08-17T08:00:00.000Z",
      pluginPid: overrides.pluginPid ?? 321,
      socketPath: config.paths.recordingSocket,
      socketIdentity: overrides.socketIdentity ?? { device: 1, inode: 2 },
      capture: {
        mode: overrides.captureMode ?? "production",
        executable: {
          configuredPath: config.paths.captureHelper,
          realPath: helperRealPath,
          device: helperInfo.dev,
          inode: helperInfo.ino,
          byteLength: helperInfo.size,
          sha256: createHash("sha256").update(helperBytes).digest("hex"),
        },
        arguments: overrides.arguments ?? [],
        helperPid: overrides.helperPid ?? null,
      },
      export: { root: overrides.exportRoot ?? config.paths.recordingExports, fixtureStampApplied: false },
      uiTest: overrides.uiTest,
    },
    status: overrides.status ?? idleStatus(),
    collision: overrides.collision ?? null,
    error: null,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-readiness-"));
  roots.add(root);
  return root;
}

function withSocket(config: RuntimeConfig, recordingSocket: string): RuntimeConfig {
  return {
    ...config,
    paths: { ...config.paths, recordingSocket },
    endpoints: {
      ...config.endpoints,
      recording: { ...config.endpoints.recording, bindArgument: recordingSocket, canonicalPath: recordingSocket },
    },
  };
}

function idleStatus() {
  return { status: "idle" as const, recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [],
    inventoryState: null, chunkCount: 0, microphoneCount: 0, systemCount: 0, inventoryDigest: null,
    retryEligible: false, outputPath: null, error: null };
}

function activeStatus() {
  return { ...idleStatus(), status: "recording" as const, recordingId: "recording-1", meetingId: "meeting-1", title: "Ready" };
}

function activeReport(sourceEvidence: string): RuntimeReadinessReport {
  return {
    authority: RECORDING_READINESS_AUTHORITY,
    captureMode: "production",
    supervisor: { pid: 1, live: true },
    daemon: { pid: 2, listen: "127.0.0.1:6777" },
    plugin: {
      id: "meetless",
      pid: 3,
      live: true,
      instanceId: "a10ff4d8-1a5d-4e8f-b4f1-c37080b958d8",
      startedAt: "2026-08-17T08:00:00.000Z",
      sourcePath: "/repo/meetless-plugin",
      sourceRealPath: "/repo/meetless-plugin",
    },
    socket: { path: "/tmp/recording.sock", live: true, authoritativeStatus: true, device: 1, inode: 2 },
    helper: { pid: 4, live: true, mode: "production", path: "/repo/helper", realPath: "/repo/helper", sha256: "a".repeat(64), arguments: [] },
    session: { status: "recording", recordingId: "recording-1", meetingId: "meeting-1", paused: false, error: null },
    chunks: { microphone: 1, system: 1, total: 2, evidencePaths: [sourceEvidence] },
    stopTarget: { command: "Electron recording control: stop", prepared: false },
    collisionTarget: null,
  };
}

function daemonAttestation(
  config: RuntimeConfig,
  response: RecordingRuntimeReadinessResponse,
): DaemonMeetlessPluginAttestation {
  return {
    pluginId: "meetless",
    sourcePath: config.paths.plugin,
    status: "running",
    runtimeInstanceId: response.runtime.instanceId,
    pluginPid: response.runtime.pluginPid,
  };
}

function controlledHostIdentity() {
  return {
    version: 1 as const,
    bundleIdentifier: "com.meetless.app",
    bundlePath: "/Applications/Meetless.app",
    bundleRealPath: "/Applications/Meetless.app",
    executablePath: "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
    designatedRequirement: "identifier \"com.meetless.app\"",
    cdHash: "a".repeat(40),
    binarySha256: "b".repeat(64),
    binaryDevice: 1,
    binaryInode: 2,
    binarySize: 3,
    configuration: {
      repositoryRoot: process.cwd(),
      runtimeRoot: "/tmp/meetless",
      listen: "127.0.0.1:6777",
      rendererOrigin: "http://127.0.0.1:8082",
      transcriptionSocket: "/tmp/transcription.sock",
      transcriptionStaging: "/tmp/transcription-ranges",
      nodePath: process.execPath,
      runtimeCliPath: "/tmp/packages/runtime/dist/cli.js",
      identityPath: "/tmp/host-identity.json",
    },
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
