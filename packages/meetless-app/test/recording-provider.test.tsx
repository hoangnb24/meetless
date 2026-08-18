import { afterEach, describe, expect, test, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RecordingStrip } from "@meetless/meeting-surface";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";
import { RecordingProvider, useRecording } from "../src/recording-provider.js";

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
    status={state.status}
  />;
}

describe("production recording UI status delivery", () => {
  let renderer: ReactTestRenderer | null = null;

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
    vi.stubGlobal("window", {
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
    expect(renderer!.root.findAllByType("Text").map((node) => node.children.join(""))).toContain("00:01 · recording");
  });

  test.each([
    {
      caseName: "Start failure without chunks",
      command: "start",
      initial: idle,
      response: { ...recording, status: "failed" as const, error: "capture start failed" },
      expectedError: "start rejected",
      retryVisible: false,
    },
    {
      caseName: "Start failure with retained chunks",
      command: "start",
      initial: idle,
      response: { ...recording, status: "recoverable" as const, error: "capture start interrupted" },
      expectedError: "start rejected with retained chunks",
      retryVisible: false,
    },
    {
      caseName: "Stop failure",
      command: "stop",
      initial: recording,
      response: { ...recording, status: "recoverable" as const, inventoryState: "complete" as const,
        chunkCount: 2, microphoneCount: 1, systemCount: 1, inventoryDigest: "digest", retryEligible: true,
        error: "finalization interrupted" },
      expectedError: "stop rejected",
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
      expectedError: "retryFinalization rejected",
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
    vi.stubGlobal("window", {
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
    expect(renderer!.root.findAllByProps({ testID: "recording-retry" }).length).toBe(retryVisible ? 1 : 0);
  });
});
