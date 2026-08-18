import { describe, expect, test, vi } from "vitest";
import {
  DesktopRecordingClient,
  MeetlessClient,
  MeetlessFeatureUnavailableError,
  type MeetlessDaemonPort,
} from "../src/index.js";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";

function daemon(overrides: Partial<MeetlessDaemonPort> = {}): MeetlessDaemonPort {
  return {
    getLastServerInfoMessage: () => ({ features: { plugins: true } }),
    getPluginCatalog: async () => [{ id: "meetless", clientBundle: "bundle" }],
    invokePluginRpc: vi.fn(async (_id, method) =>
      method === "meeting.list"
        ? { meetings: [] }
        : {
            id: "m-1",
            title: "Design sync",
            status: "draft",
            createdAt: "2026-08-16T10:00:00.000Z",
            updatedAt: "2026-08-16T10:00:00.000Z",
          },
    ),
    ...overrides,
  };
}

describe("Meetless capability gate", () => {
  test("validates the feature and catalog once before focused methods", async () => {
    const port = daemon();
    const client = new MeetlessClient(port);
    await client.initialize();
    await client.initialize();
    await expect(client.createMeeting({ title: "Design sync" })).resolves.toMatchObject({
      id: "m-1",
      status: "draft",
    });
    await expect(client.listMeetings()).resolves.toEqual([]);
    expect(port.invokePluginRpc).toHaveBeenNthCalledWith(
      1,
      "meetless",
      "meeting.create",
      { title: "Design sync" },
    );
  });

  test("does not fall back when plugins are unsupported", async () => {
    const client = new MeetlessClient(
      daemon({ getLastServerInfoMessage: () => ({ features: { plugins: false } }) }),
    );
    await expect(client.initialize()).rejects.toThrow(MeetlessFeatureUnavailableError);
    await expect(client.createMeeting({ title: "No fallback" })).rejects.toThrow(
      "not initialized",
    );
  });

  test("does not invoke RPC when the meetless catalog entry is absent", async () => {
    const port = daemon({ getPluginCatalog: async () => [] });
    const client = new MeetlessClient(port);
    await expect(client.initialize()).rejects.toThrow('required "meetless" plugin');
    expect(port.invokePluginRpc).not.toHaveBeenCalled();
  });
});

const recordingStatus: RecordingStatusWire = {
  status: "recording", recordingId: "r-1", meetingId: "m-1", title: "Design sync",
  elapsedMs: 1_000, paused: false, chunks: [], outputPath: null, error: null,
};

describe("Electron-only recording transport", () => {
  test.each([
    ["Start without chunks", "start", { ...recordingStatus, status: "failed" as const, error: "capture start failed" }],
    ["Start with retained chunks", "start", { ...recordingStatus, status: "recoverable" as const, error: "capture start interrupted" }],
    ["Stop", "stop", { ...recordingStatus, status: "recoverable" as const, error: "finalization interrupted" }],
    ["finalization retry", "retryFinalization", { ...recordingStatus, status: "recoverable" as const, error: "MP3 retry failed" }],
  ] as const)("publishes authoritative %s failure status before rejecting and clears the pending request", async (_label, command, failureStatus) => {
    let handler: ((payload: unknown) => void) | null = null;
    const invoke = vi.fn(async (bridgeCommand: string, args?: Record<string, unknown>) => {
      if (bridgeCommand === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (bridgeCommand === "open_local_daemon_transport") return "session-error-status";
      if (bridgeCommand === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string; command: string };
        const failed = request.command === command;
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId,
          kind: "message",
          binaryBase64: Buffer.from(JSON.stringify({
            version: 1,
            requestId: request.requestId,
            ok: !failed,
            status: failed ? failureStatus : recordingStatus,
            error: failed ? `${command} rejected` : null,
          })).toString("base64"),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });
    const observed: RecordingStatusWire[] = [];
    client.subscribe((status) => observed.push(status));
    await client.connect();

    const operation = command === "start"
      ? client.start("Failure")
      : command === "stop"
        ? client.stop()
        : client.retryFinalization();
    await expect(operation).rejects.toThrow(`${command} rejected`);
    expect(observed).toEqual([failureStatus]);
    await expect(client.status()).resolves.toEqual(recordingStatus);
    await client.close();
  });

  test("decodes real Electron binary-shaped text frames so Start returns authoritative recording", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (command === "open_local_daemon_transport") return "session-binary";
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string; command: string };
        const response = JSON.stringify({
          version: 1, requestId: request.requestId, ok: true, status: recordingStatus, error: null,
        });
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId,
          kind: "message",
          binaryBase64: Buffer.from(response, "utf8").toString("base64"),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });

    await client.connect();
    await expect(client.start("Production call")).resolves.toEqual(recordingStatus);
    expect(invoke).toHaveBeenLastCalledWith("send_local_daemon_transport_message", expect.objectContaining({
      text: expect.stringContaining('"command":"start"'),
    }));
    await client.close();
  });

  test("reopens the same private socket after disconnect and publishes recovered authoritative status", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    let session = 0;
    const recovered = { ...recordingStatus, status: "recoverable" as const, error: "daemon restarted while capture was active" };
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (command === "open_local_daemon_transport") return `session-${++session}`;
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string };
        const status = session === 1 ? recordingStatus : recovered;
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId, kind: "message",
          binaryBase64: Buffer.from(JSON.stringify({
            version: 1, requestId: request.requestId, ok: true, status, error: null,
          })).toString("base64"),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });
    const observed: RecordingStatusWire[] = [];
    client.subscribe((status) => observed.push(status));
    await client.connect();
    handler?.({ sessionId: "session-1", kind: "close" });

    await vi.waitFor(() => expect(observed).toContainEqual(recovered));
    expect(session).toBe(2);
    expect(invoke).toHaveBeenCalledWith("open_local_daemon_transport", {
      transportType: "socket", transportPath: "/private/runtime/paseo-home/recording-control.sock",
    });
    await client.close();
  });

  test("derives the same short private socket for an overlong isolated daemon home", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    const home = `/private/var/folders/${"long-runtime-segment/".repeat(8)}paseo-home`;
    let openedPath = "";
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home };
      if (command === "open_local_daemon_transport") {
        openedPath = String(args?.transportPath);
        return "session-long-home";
      }
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string };
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId, kind: "message",
          text: JSON.stringify({ version: 1, requestId: request.requestId, ok: true, status: recordingStatus, error: null }),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });

    await client.connect();
    expect(openedPath).toMatch(/^\/private\/tmp\/meetless-recording-[a-f0-9]{24}\.sock$/u);
    expect(Buffer.byteLength(openedPath)).toBeLessThanOrEqual(103);
    await client.close();
  });

  test("derives the private socket only from Electron daemon state and reconnects without owning capture", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    let session = 0;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (command === "open_local_daemon_transport") return `session-${++session}`;
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string };
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId, kind: "message",
          text: JSON.stringify({ version: 1, requestId: request.requestId, ok: true, status: recordingStatus, error: null }),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });
    await expect(client.connect()).resolves.toEqual(recordingStatus);
    expect(invoke).toHaveBeenCalledWith("open_local_daemon_transport", {
      transportType: "socket", transportPath: "/private/runtime/paseo-home/recording-control.sock",
    });
    await client.close();
    await expect(client.connect()).resolves.toEqual(recordingStatus);
    expect(session).toBe(2);
    await client.close();
  });

  test("waits for the daemon-owned recording socket during route-independent startup", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    let opens = 0;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (command === "open_local_daemon_transport" && ++opens < 3) throw new Error("socket not ready");
      if (command === "open_local_daemon_transport") return "session-ready";
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string };
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId, kind: "message",
          text: JSON.stringify({ version: 1, requestId: request.requestId, ok: true, status: recordingStatus, error: null }),
        }));
      }
      return undefined;
    });
    const client = new DesktopRecordingClient({
      platform: "darwin", invoke,
      events: { on: async (_event, next) => { handler = next; return () => { handler = null; }; } },
    });

    await expect(client.connect()).resolves.toEqual(recordingStatus);
    expect(opens).toBe(3);
    await client.close();
  });

  test("rejects browser/mobile and non-macOS bridges instead of trusting URL parameters", () => {
    expect(() => new DesktopRecordingClient({ platform: "linux", invoke: vi.fn(), events: { on: vi.fn() } })).toThrow(
      /web, mobile, and URL parameters cannot grant it/,
    );
  });
});
