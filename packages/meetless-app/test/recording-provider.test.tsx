import { afterEach, describe, expect, test, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RecordingStrip } from "@meetless/meeting-surface";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";
import { RecordingProvider, useRecording } from "../src/recording-provider.js";

const idle: RecordingStatusWire = {
  status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0,
  paused: false, chunks: [], outputPath: null, error: null,
};
const recording: RecordingStatusWire = {
  status: "recording", recordingId: "recording-production", meetingId: "meeting-production",
  title: "Production call", elapsedMs: 1_000, paused: false, chunks: [], outputPath: null, error: null,
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
});
