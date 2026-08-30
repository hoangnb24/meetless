import { describe, expect, test, vi } from "vitest";
import {
  DesktopRecordingClient,
  MeetlessClient,
  MeetlessFeatureUnavailableError,
  type MeetlessDaemonPort,
} from "../src/index.js";
import type {
  ChatControlsWire,
  ChatFeatureDiscoveryWire,
  ChatSelectionWire,
  RecordingStatusWire,
} from "@meetless/meeting-contracts";

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

  test("routes strict chat discovery, durable get, ask, and retry RPCs", async () => {
    const thread = {
      meetingId: "m-1", status: "running" as const,
      messages: [{ role: "user" as const, text: "Question", createdAt: "2026-08-21T00:00:00.000Z" }],
      selection: { provider: "codex", model: "gpt-5" }, failure: null,
    };
    const invokePluginRpc = vi.fn(async (_id: string, method: string) => {
      if (method === "meeting.chat.providers") return {
        providers: [{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }],
        compatibilityCheck: "on_question_start",
      };
      if (method === "meeting.chat.get") return { thread };
      return thread;
    });
    const client = new MeetlessClient(daemon({ invokePluginRpc }));
    await client.initialize();

    await expect(client.listChatProviders()).resolves.toMatchObject({ compatibilityCheck: "on_question_start" });
    await expect(client.getMeetingChat("m-1")).resolves.toEqual(thread);
    await expect(client.askMeetingQuestion({
      meetingId: "m-1", question: "Question", provider: "codex", model: "gpt-5",
    })).resolves.toEqual(thread);
    await expect(client.retryMeetingQuestion({
      meetingId: "m-1", provider: "codex", model: "gpt-5",
    })).resolves.toEqual(thread);
    expect(invokePluginRpc.mock.calls.map((call) => call[1])).toEqual([
      "meeting.chat.providers", "meeting.chat.get", "meeting.chat.ask", "meeting.chat.retry",
    ]);
  });

  test("routes the complete selection capability without falling back to legacy chat RPCs", async () => {
    const selection: ChatSelectionWire = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    };
    const controls: ChatControlsWire = {
      version: 1,
      catalog: { providers: [] },
      profiles: [],
      catalogError: null,
      lastSelection: selection,
      lastSelectionState: "available",
      lastSelectionError: null,
    };
    const features: ChatFeatureDiscoveryWire = {
      version: 1, selection, status: "ready", features: [], error: null,
    };
    const thread = {
      meetingId: "m-1", status: "running" as const,
      messages: [{ role: "user" as const, text: "Question", createdAt: "2026-08-21T00:00:00.000Z" }],
      selection: { provider: "codex", model: "gpt-5" }, failure: null,
    };
    const invokePluginRpc = vi.fn(async (_id: string, method: string) => {
      if (method === "meeting.chat.controls.v1") return controls;
      if (method === "meeting.chat.features.v1") return features;
      if (method === "meeting.chat.selection.v1") return { version: 1, selection };
      return thread;
    });
    const client = new MeetlessClient(daemon({ invokePluginRpc }));
    await client.initialize();

    await expect(client.getChatControls()).resolves.toEqual(controls);
    await expect(client.discoverChatFeatures(selection)).resolves.toEqual(features);
    await expect(client.applyChatSelection(selection)).resolves.toEqual(selection);
    await expect(client.askMeetingQuestionWithSelection({ meetingId: "m-1", question: "Question", selection })).resolves.toEqual(thread);
    await expect(client.retryMeetingQuestionWithSelection({ meetingId: "m-1", selection })).resolves.toEqual(thread);
    expect(invokePluginRpc.mock.calls.map((call) => call[1])).toEqual([
      "meeting.chat.controls.v1",
      "meeting.chat.features.v1",
      "meeting.chat.selection.v1",
      "meeting.chat.ask.v1",
      "meeting.chat.retry.v1",
    ]);
  });

  test("routes meeting deletion with only the plain meeting ID", async () => {
    const invokePluginRpc = vi.fn(async () => ({ meetingId: "m-1", outcome: "deleted", reason: null }));
    const client = new MeetlessClient(daemon({ invokePluginRpc }));
    await client.initialize();

    await expect(client.deleteMeeting("m-1")).resolves.toEqual({ meetingId: "m-1", outcome: "deleted", reason: null });
    expect(invokePluginRpc).toHaveBeenCalledWith("meetless", "meeting.delete", { meetingId: "m-1" });
  });

  test("routes Premium status, purchase, and restore through strict plugin RPCs", async () => {
    const access = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [{
        packageId: "monthly" as const,
        productId: "com.meetless.app.premium.monthly",
        localizedPrice: "$9.99",
        trialEligible: true,
      }],
      reason: null,
    };
    const invokePluginRpc = vi.fn(async (_id: string, method: string) =>
      method === "meeting.premium.status" ? access : { outcome: "active", access: { ...access, status: "active" } },
    );
    const client = new MeetlessClient(daemon({ invokePluginRpc }));
    await client.initialize();

    await expect(client.getPremiumAccess()).resolves.toEqual(access);
    await expect(client.purchasePremium("monthly")).resolves.toMatchObject({ outcome: "active" });
    await expect(client.restorePremium()).resolves.toMatchObject({ outcome: "active" });
    expect(invokePluginRpc.mock.calls).toEqual([
      ["meetless", "meeting.premium.status", {}],
      ["meetless", "meeting.premium.purchase", { packageId: "monthly" }],
      ["meetless", "meeting.premium.restore", {}],
    ]);
  });
});

const recordingStatus: RecordingStatusWire = {
  status: "recording", recordingId: "r-1", meetingId: "m-1", title: "Design sync",
  elapsedMs: 1_000, paused: false, chunks: [], inventoryState: "pending", chunkCount: 0,
  microphoneCount: 0, systemCount: 0, inventoryDigest: null, retryEligible: false,
  outputPath: null, error: null,
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
