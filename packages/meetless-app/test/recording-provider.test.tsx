import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RecordingStrip } from "@meetless/meeting-surface";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";
import { RecordingProvider, useRecording } from "../src/recording-provider.js";

vi.mock("@expo/vector-icons", () => ({ MaterialCommunityIcons: (props: Record<string, unknown>) => React.createElement("MaterialCommunityIcons", props) }));

// The real client requires the same versioned endpoint composition as the host URL.
const rendererHref = `http://127.0.0.1/?meetlessEndpoints=${encodeURIComponent(JSON.stringify({
  schema: "MEETLESS_RUNTIME_ENDPOINTS v1", mode: "packaged", workingDirectory: "/private/runtime",
  recording: { role: "recording", name: "recording.sock", bindArgument: "recording.sock", canonicalPath: "/private/runtime/recording.sock" },
  transcription: { role: "transcription", name: "transcription.sock", bindArgument: "transcription.sock", canonicalPath: "/private/runtime/transcription.sock" },
}))}`;

const idle: RecordingStatusWire = {
  status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0,
  paused: false, chunks: [], inventoryState: null, chunkCount: 0, microphoneCount: 0, systemCount: 0,
  inventoryDigest: null, retryEligible: false, outputPath: null, error: null,
};
const recording: RecordingStatusWire = {
  status: "recording", recordingId: "recording-production", meetingId: "meeting-production",
  title: "Production call", elapsedMs: 1_000, paused: false, chunks: [], inventoryState: "pending",
  chunkCount: 0, microphoneCount: 0, systemCount: 0, inventoryDigest: null,
  retryEligible: false, outputPath: null, error: null,
};

function ConnectedStrip() {
  const state = useRecording();
  return <RecordingStrip
    elapsedMs={state.displayElapsedMs}
    error={state.error}
    onPause={state.pause}
    onResume={state.resume}
    onRetry={state.retry}
    onStart={state.start}
    onStop={state.stop}
    pending={state.pending}
    pendingAction={state.pendingAction}
    status={state.status}
  />;
}

function ProbeView(_props: { state: ReturnType<typeof useRecording> }) { return null; }
function ConnectedPermissionProbe() { return <ProbeView state={useRecording()} />; }

describe("production recording UI status delivery", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    let intent = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: true,
      json: async () => input.includes("/intent")
        ? ({ intentToken: `intent-${++intent}`, expiresAt: Date.now() + 5_000 })
        : input.includes("/settings")
          ? ({ settingsOpened: true })
          : ({ microphone: "authorized", systemAudio: "authorized" }),
    })));
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  test("a real-shaped binary Start response immediately replaces Start with authoritative controls and elapsed time", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let handler: ((payload: unknown) => void) | null = null;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (command === "open_local_daemon_transport") return "production-session";
      if (command === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string; command: string };
        const status = request.command === "start" ? recording : idle;
        queueMicrotask(() => handler?.({
          sessionId: args?.sessionId,
          kind: "message",
          binaryBase64: Buffer.from(JSON.stringify({
            version: 1, requestId: request.requestId, ok: true, status, error: null,
          }), "utf8").toString("base64"),
        }));
      }
      return undefined;
    });
    vi.stubGlobal("window", { location: { href: rendererHref },
      paseoDesktop: {
        platform: "darwin", invoke,
        events: { on: async (_event: string, next: (payload: unknown) => void) => {
          handler = next; return () => { handler = null; };
        } },
      },
    });

    await act(async () => {
      renderer = create(<RecordingProvider enabled><ConnectedStrip /></RecordingProvider>);
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "send_local_daemon_transport_message",
      expect.objectContaining({ text: expect.stringContaining('\"command\":\"status\"') }),
    ));

    await act(async () => {
      await renderer!.root.findByType(RecordingStrip).props.onStart("Production call");
    });

    expect(renderer!.root.findByProps({ testID: "recording-stop" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "recording-pause-resume" })).toBeTruthy();
    expect(renderer!.root.findAllByType("Text").map((node) => node.children.join(""))).toContain("Recording · 00:01");
  });

  test.each([
    {
      caseName: "Start failure without chunks",
      command: "start",
      initial: idle,
      response: { ...recording, status: "failed" as const, error: "capture start failed" },
      expectedError: "No usable recording was preserved.",
      retryVisible: false,
    },
    {
      caseName: "Start failure with retained chunks",
      command: "start",
      initial: idle,
      response: { ...recording, status: "recoverable" as const, error: "capture start interrupted" },
      expectedError: "Audio is not saved yet. Recorded chunks are still being checked; retry is not available.",
      retryVisible: false,
    },
    {
      caseName: "Stop failure",
      command: "stop",
      initial: recording,
      response: { ...recording, status: "recoverable" as const, inventoryState: "complete" as const,
        chunkCount: 2, microphoneCount: 1, systemCount: 1, inventoryDigest: "digest", retryEligible: true,
        error: "finalization interrupted" },
      expectedError: "Audio could not be saved. Retry saving the recorded chunks.",
      retryVisible: true,
    },
    {
      caseName: "Finalization retry failure",
      command: "retryFinalization",
      initial: { ...recording, status: "recoverable" as const, inventoryState: "complete" as const,
        chunkCount: 2, microphoneCount: 1, systemCount: 1, inventoryDigest: "digest", retryEligible: true,
        error: "previous interruption" },
      response: { ...recording, status: "recoverable" as const, inventoryState: "complete" as const,
        chunkCount: 2, microphoneCount: 1, systemCount: 1, inventoryDigest: "digest", retryEligible: true,
        error: "MP3 retry failed" },
      expectedError: "Audio could not be saved. Retry saving the recorded chunks.",
      retryVisible: true,
    },
  ])("uses the correlated $caseName status when no separate status event arrives", async ({ command, initial, response, expectedError, retryVisible }) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let handler: ((payload: unknown) => void) | null = null;
    const invoke = vi.fn(async (bridgeCommand: string, args?: Record<string, unknown>) => {
      if (bridgeCommand === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (bridgeCommand === "open_local_daemon_transport") return "production-failure-session";
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
            status: failed ? response : initial,
            error: failed ? expectedError : null,
          })).toString("base64"),
        }));
      }
      return undefined;
    });
    vi.stubGlobal("window", { location: { href: rendererHref },
      paseoDesktop: {
        platform: "darwin", invoke,
        events: { on: async (_event: string, next: (payload: unknown) => void) => {
          handler = next; return () => { handler = null; };
        } },
      },
    });

    await act(async () => {
      renderer = create(<RecordingProvider enabled><ConnectedStrip /></RecordingProvider>);
    });
    await vi.waitFor(() => expect(renderer!.root.findByType(RecordingStrip).props.status).toEqual(initial));
    await act(async () => {
      const strip = renderer!.root.findByType(RecordingStrip).props;
      const operation = command === "start"
        ? strip.onStart("Failure")
        : command === "stop"
          ? strip.onStop()
          : strip.onRetry();
      await operation.catch(() => undefined);
    });

    expect(renderer!.root.findByType(RecordingStrip).props.status).toEqual(response);
    expect(renderer!.root.findByProps({ testID: "recording-error" }).children.join("")).toBe(expectedError);
    expect(renderer!.root.findAllByProps({ testID: "recording-retry" }).length > 0).toBe(retryVisible);
  });

  test.each([
    ["stop", true],
    ["retryFinalization", true],
    ["retryFinalization", false],
  ] as const)("%s reports progress, blocks duplicates, and handles saved response ok=%s", async (command, savedResponseOk) => {
    let handler: ((payload: unknown) => void) | null = null;
    const recoverable: RecordingStatusWire = { ...recording, status: "recoverable", inventoryState: "complete",
      chunkCount: 2, microphoneCount: 1, systemCount: 1, inventoryDigest: "digest", retryEligible: true,
      error: "encoder interrupted" };
    const initial = command === "stop" ? recording : recoverable;
    let respond: ((status: RecordingStatusWire, ok: boolean) => void) | null = null;
    const requests: string[] = [];
    const invoke = vi.fn(async (bridgeCommand: string, args?: Record<string, unknown>) => {
      if (bridgeCommand === "desktop_daemon_status") return { home: "/private/runtime/paseo-home" };
      if (bridgeCommand === "open_local_daemon_transport") return "delayed-session";
      if (bridgeCommand === "send_local_daemon_transport_message") {
        const request = JSON.parse(String(args?.text)) as { requestId: string; command: string };
        const deliver = (status: RecordingStatusWire, ok: boolean) => handler?.({
          sessionId: args?.sessionId, kind: "message", text: JSON.stringify({
            version: 1, requestId: request.requestId, ok, status, error: ok ? null : status.status === "saved" ? "saved recording cleanup failed" : "encoder interrupted",
          }),
        });
        if (request.command === "status") queueMicrotask(() => deliver(initial, true));
        else { requests.push(request.command); respond = deliver; }
      }
    });
    vi.stubGlobal("window", { location: { href: rendererHref }, paseoDesktop: { platform: "darwin", invoke,
      events: { on: async (_event: string, next: (payload: unknown) => void) => { handler = next; return () => { handler = null; }; } },
    } });
    await act(async () => { renderer = create(<RecordingProvider enabled><ConnectedStrip /></RecordingProvider>); });
    await vi.waitFor(() => expect(renderer!.root.findByType(RecordingStrip).props.status).toEqual(initial));
    const buttonId = command === "stop" ? "recording-stop" : "recording-retry";
    await act(async () => {
      const press = renderer!.root.findByProps({ testID: buttonId }).props.onPress;
      press(); press();
    });
    expect(requests).toEqual([command]);
    expect(renderer!.root.findByProps({ testID: buttonId }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ testID: "recording-state" }).children.join(""))
      .toBe(command === "stop" ? "Saving audio…" : "Retrying save…");
    expect(renderer!.root.findAllByProps({ testID: "recording-error" })).toHaveLength(0);
    await act(async () => { respond!(recoverable, false); });
    expect(renderer!.root.findByProps({ testID: "recording-retry" }).props.disabled).toBe(false);
    expect(renderer!.root.findByProps({ testID: "recording-error" }).children.join(""))
      .toBe("Audio could not be saved. Retry saving the recorded chunks.");
    await act(async () => { renderer!.root.findByProps({ testID: "recording-error-details-toggle" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "recording-error-details" }).children.join(""))
      .toContain("recording-production");
    await act(async () => { renderer!.root.findByProps({ testID: "recording-retry" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "recording-state" }).children.join("")).toBe("Retrying save…");
    const saved = { ...recoverable, status: "saved" as const, retryEligible: false, outputPath: "/private/recording.mp3" };
    await act(async () => { respond!(saved, savedResponseOk); });
    expect(requests).toEqual([command, "retryFinalization"]);
    expect(renderer!.root.findByType(RecordingStrip).props.status).toEqual(saved);
    expect(renderer!.root.findByProps({ testID: "recording-state" }).children.join("")).toBe("Audio saved locally");
    if (savedResponseOk) {
      expect(renderer!.root.findAllByProps({ testID: "recording-error" })).toHaveLength(0);
    } else {
      expect(renderer!.root.findByProps({ testID: "recording-error" }).children.join(""))
        .toBe("Audio is saved locally, but the last action could not finish. Check Error details.");
      await act(async () => { renderer!.root.findByProps({ testID: "recording-error-details-toggle" }).props.onPress(); });
      expect(renderer!.root.findByProps({ testID: "recording-error-details" }).children.join(""))
        .toContain("saved recording cleanup failed");
    }
    expect(renderer!.root.findAllByProps({ testID: "recording-retry" })).toHaveLength(0);
  });

  test("does not send Start when a user-initiated permission request returns denied", async () => {
    let intent = 0;
    const fetchMock = vi.fn(async (input: string) => ({
      ok: true,
      json: async () => input.includes("/intent")
        ? ({ intentToken: `denied-intent-${++intent}`, expiresAt: Date.now() + 5_000 })
        : input.endsWith("/request")
          ? ({ microphone: "denied", systemAudio: "authorized" })
          : ({ microphone: "notDetermined", systemAudio: "authorized" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const invoke = vi.fn(async (command: string) => command === "open_local_daemon_transport" ? "permission-session" : undefined);
    vi.stubGlobal("window", { location: { href: rendererHref },
      paseoDesktop: { platform: "darwin", invoke, events: { on: async () => () => undefined } },
    });
    await act(async () => { renderer = create(<RecordingProvider enabled><ConnectedStrip /></RecordingProvider>); });
    await act(async () => {
      await renderer!.root.findByType(RecordingStrip).props.onStart("Denied").catch(() => undefined);
    });
    expect(fetchMock).toHaveBeenCalledWith("/__meetless/capture-permissions/intent", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith("/__meetless/capture-permissions/request", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Meetless-Permission-Intent": "denied-intent-1" }),
    }));
    expect(invoke).not.toHaveBeenCalledWith("send_local_daemon_transport_message", expect.objectContaining({ text: expect.stringContaining('"command":"start"') }));
  });

  test("rechecks not-determined access and exposes supported settings recovery", async () => {
    let statusCalls = 0;
    let intent = 0;
    const fetchMock = vi.fn(async (input: string) => ({
      ok: true,
      json: async () => {
        if (input.includes("/intent")) return { intentToken: `recheck-intent-${++intent}`, expiresAt: Date.now() + 5_000 };
        if (input.includes("/settings")) return { settingsOpened: true, settingsNavigation: "best-effort-pane-url" };
        statusCalls += 1;
        return statusCalls === 1
          ? { microphone: "notDetermined", systemAudio: "notDetermined" }
          : { microphone: "authorized", systemAudio: "authorized" };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: rendererHref }, paseoDesktop: { platform: "darwin", invoke: async (command: string) => command === "open_local_daemon_transport" ? "recheck-session" : undefined, events: { on: async () => () => undefined } } });
    await act(async () => { renderer = create(<RecordingProvider enabled><ConnectedPermissionProbe /></RecordingProvider>); });
    await vi.waitFor(() => expect(renderer!.root.findByType(ProbeView).props.state.permissions.microphone).toBe("notDetermined"));
    await act(async () => { await renderer!.root.findByType(ProbeView).props.state.recheckPermissions(); });
    expect(renderer!.root.findByType(ProbeView).props.state.permissions).toMatchObject({ microphone: "authorized", systemAudio: "authorized" });
    await act(async () => { await renderer!.root.findByType(ProbeView).props.state.openPermissionSettings("microphone"); });
    expect(fetchMock).toHaveBeenCalledWith("/__meetless/capture-permissions/settings?source=microphone", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Meetless-Permission-Intent": "recheck-intent-1" }),
    }));
  });

  test("turns initial status transport failure into actionable recheck and recovers", async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input !== "/__meetless/capture-permissions") throw new Error("unexpected mutation");
      statusCalls += 1;
      if (statusCalls === 1) throw new Error("renderer boundary unavailable");
      return {
        ok: true,
        json: async () => ({ microphone: "authorized", systemAudio: "authorized" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: rendererHref }, paseoDesktop: { platform: "darwin", invoke: async (command: string) => command === "open_local_daemon_transport" ? "transport-recovery-session" : undefined, events: { on: async () => () => undefined } } });

    await act(async () => { renderer = create(<RecordingProvider enabled><ConnectedPermissionProbe /></RecordingProvider>); });
    await vi.waitFor(() => expect(renderer!.root.findByType(ProbeView).props.state.permissions).toMatchObject({
      microphone: null,
      systemAudio: null,
      checking: false,
      error: expect.stringContaining("Recheck"),
    }));
    await expect(act(async () => {
      await renderer!.root.findByType(ProbeView).props.state.recheckPermissions();
    })).resolves.toBeUndefined();
    expect(renderer!.root.findByType(ProbeView).props.state.permissions).toMatchObject({
      microphone: "authorized",
      systemAudio: "authorized",
      checking: false,
      error: null,
    });
  });

  test.each([
    ["settingsOpened=false", async () => ({ ok: true, json: async () => ({ settingsOpened: false }) })],
    ["settings transport error", async () => { throw new Error("settings transport unavailable"); }],
  ])("surfaces %s without rejecting the user action", async (_caseName, settingsResult) => {
    let intent = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/intent")) return {
        ok: true,
        json: async () => ({ intentToken: `settings-intent-${++intent}`, expiresAt: Date.now() + 5_000 }),
      };
      if (input.includes("/settings")) return settingsResult();
      return { ok: true, json: async () => ({ microphone: "denied", systemAudio: "authorized" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: rendererHref }, paseoDesktop: { platform: "darwin", invoke: async (command: string) => command === "open_local_daemon_transport" ? "settings-failure-session" : undefined, events: { on: async () => () => undefined } } });

    await act(async () => { renderer = create(<RecordingProvider enabled><ConnectedPermissionProbe /></RecordingProvider>); });
    await vi.waitFor(() => expect(renderer!.root.findByType(ProbeView).props.state.permissions.microphone).toBe("denied"));
    await expect(act(async () => {
      await renderer!.root.findByType(ProbeView).props.state.openPermissionSettings("microphone");
    })).resolves.toBeUndefined();
    expect(renderer!.root.findByType(ProbeView).props.state.permissions.error)
      .toContain("could not open System Settings");
  });
});
