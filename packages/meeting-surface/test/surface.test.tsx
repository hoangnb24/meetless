import { readFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptWire } from "@meetless/meeting-contracts";
import {
  clearsElectronTitlebarHitTest,
  ELECTRON_TITLEBAR_HIT_TEST_HEIGHT,
  MeetingListSurface,
  RecordingStrip,
  recordingStripPointerGeometry,
} from "../src/index.js";

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: (props: Record<string, unknown>) => React.createElement("MaterialCommunityIcons", props),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("global recording strip", () => {
  test("clears desktop recording controls below the Electron titlebar hit-test region", async () => {
    const oldStripStyle = { minHeight: 64, paddingVertical: 9 };
    const controlHeight = 40;
    const oldControlTopY = oldStripStyle.paddingVertical;
    const oldControlCenterY = oldControlTopY + controlHeight / 2;
    expect(oldStripStyle).toEqual({ minHeight: 64, paddingVertical: 9 });
    expect(oldControlTopY).toBe(9);
    expect(oldControlCenterY).toBe(29);
    expect(clearsElectronTitlebarHitTest(oldControlCenterY)).toBe(false);

    expect(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT).toBe(29);
    const corrected = recordingStripPointerGeometry(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT);
    expect(corrected).toEqual({ controlTopY: 38, controlCenterY: 58, stripMinHeight: 87 });
    expect(clearsElectronTitlebarHitTest(corrected.controlCenterY)).toBe(true);

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={0} error="No valid committed media survived inventory reconciliation"
        onPause={async () => undefined} onResume={async () => undefined}
        onRetry={async () => undefined} onStart={async () => undefined} onStop={async () => undefined}
        pending={false} status={{ status: "failed", recordingId: "r-1", meetingId: "m-1", title: "Failed",
          elapsedMs: 0, paused: false, chunks: [], inventoryState: "pending", chunkCount: 0,
          microphoneCount: 0, systemCount: 0, inventoryDigest: null, retryEligible: false,
          outputPath: null, error: "No valid committed media survived inventory reconciliation" }} />);
    });
    expect(renderer!.root.findByProps({ testID: "global-recording-strip" }).props.style).toMatchObject({
      minHeight: 87,
      paddingTop: 38,
    });
    expect(renderer!.root.findByProps({ testID: "recording-titlebar-drag-region" }).props.style).toMatchObject({
      position: "absolute",
      top: 0,
      right: 0,
      left: 0,
      height: ELECTRON_TITLEBAR_HIT_TEST_HEIGHT,
      WebkitAppRegion: "drag",
    });
    expect(renderer!.root.findByProps({ testID: "recording-error" }).props.children)
      .toBe("No usable recording was preserved.");
    renderer!.unmount();
  });

  test("renders authoritative recoverable retry state independently of meeting-list content", async () => {
    const retry = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={12_000}
        error="encoder interrupted"
        onPause={async () => undefined}
        onResume={async () => undefined}
        onRetry={retry}
        onStart={async () => undefined}
        onStop={async () => undefined}
        pending={false}
        status={{ status: "recoverable", recordingId: "r-1", meetingId: "m-1", title: "Sync", elapsedMs: 12_000, paused: false, chunks: [],
          inventoryState: "complete", chunkCount: 2, microphoneCount: 1, systemCount: 1,
          inventoryDigest: "digest", retryEligible: true, outputPath: null, error: "encoder interrupted" }}
      />);
    });
    const button = renderer!.root.findByProps({ testID: "recording-retry" });
    await act(async () => { button.props.onPress(); });
    expect(retry).toHaveBeenCalledOnce();
    renderer!.unmount();
  });

  test("hides Retry while inventory reconciliation is incomplete", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={12_000} error={null} onPause={async () => undefined} onResume={async () => undefined}
        onRetry={async () => undefined} onStart={async () => undefined} onStop={async () => undefined}
        pending={false} status={{ status: "recoverable", recordingId: "r-1", meetingId: "m-1", title: "Sync",
          elapsedMs: 12_000, paused: false, chunks: [], inventoryState: "scanning", chunkCount: 20_136,
          microphoneCount: 12_926, systemCount: 7_210, inventoryDigest: null, retryEligible: false,
          outputPath: null, error: null }} />);
    });
    expect(renderer!.root.findAllByProps({ testID: "recording-retry" })).toHaveLength(0);
    renderer!.unmount();
  });

  test.each([
    ["microphone capture failed: permission denied", "Microphone access needs attention. Check microphone access, then try again."],
    ["system capture failed: permission denied", "System audio access needs attention. Check system audio access, then try again."],
    ["SCStreamErrorDomain Code=-3801: The user declined TCCs for application, window, display capture", "Recording needs attention. Try again."],
  ])("maps known %s failures to source-specific recovery copy", async (error, expected) => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={0}
        error={error}
        onPause={async () => undefined}
        onResume={async () => undefined}
        onRetry={async () => undefined}
        onStart={async () => undefined}
        onStop={async () => undefined}
        pending={false}
        status={{ status: "failed", recordingId: "r-1", meetingId: "m-1", title: "Failed",
          elapsedMs: 0, paused: false, chunks: [], inventoryState: "pending", chunkCount: 0,
          microphoneCount: 0, systemCount: 0, inventoryDigest: null, retryEligible: false,
          outputPath: null, error }}
      />);
    });
    expect(renderer!.root.findByProps({ testID: "recording-error" }).props.children).toBe(expected);
    expect(renderer!.root.findAllByType("Text").some((node) => node.props.children === error)).toBe(false);
    renderer!.unmount();
  });

  test("does not infer System Audio from localized display-capture text", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={0}
        error="SCStreamErrorDomain Code=-3801: The user declined TCCs for application, window, display capture"
        onPause={async () => undefined}
        onResume={async () => undefined}
        onRetry={async () => undefined}
        onStart={async () => undefined}
        onStop={async () => undefined}
        pending={false}
        status={{ status: "failed", recordingId: "r-1", meetingId: "m-1", title: "Failed",
          elapsedMs: 0, paused: false, chunks: [], inventoryState: "pending", chunkCount: 0,
          microphoneCount: 0, systemCount: 0, inventoryDigest: null, retryEligible: false,
          outputPath: null, error: "No valid committed media survived inventory reconciliation" }}
      />);
    });
    expect(renderer!.root.findByProps({ testID: "recording-error" }).props.children)
      .toBe("No usable recording was preserved.");
    renderer!.unmount();
  });

  test("keeps Start available after a TCC capture failure and shows source recovery copy", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canRecord
          layoutTier="desktop"
          connectionLabel="Host online"
          hostConnectionStatus="online"
          hostLabel="this host"
          meetings={[]}
          onRefresh={async () => undefined}
          recordingSetup={{
            available: true,
            pending: false,
            error: null,
            permissions: { microphone: "denied", systemAudio: "denied", checking: false, error: null },
            onStart: async () => undefined,
            onOpenPermissionSettings: async () => undefined,
            onRecheckPermissions: async () => undefined,
          }}
        />,
      );
    });
    await act(async () => { renderer!.root.findByProps({ testID: "record-meeting-entry" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "permission-guidance-microphone" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "permission-guidance-systemAudio" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "permission-settings-microphone" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "permission-recheck-systemAudio" })).toBeTruthy();
    const start = renderer!.root.findByProps({ testID: "recording-start" });
    expect(start.props.disabled).toBe(true);
    await act(async () => { renderer!.root.findByProps({ testID: "recording-setup-title" }).props.onChangeText("Retry source"); });
    expect(renderer!.root.findByProps({ testID: "recording-start" }).props.disabled).toBe(false);
    renderer!.unmount();
  });

  test("keeps transport failure actionable and renders rejected recovery actions", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canRecord
          layoutTier="desktop"
          connectionLabel="Host online"
          hostConnectionStatus="online"
          hostLabel="this host"
          meetings={[]}
          onRefresh={async () => undefined}
          recordingSetup={{
            available: true,
            pending: false,
            error: null,
            permissions: {
              microphone: null,
              systemAudio: null,
              checking: false,
              error: "Capture permission status is unavailable. Recheck to try again.",
            },
            onStart: async () => undefined,
            onRecheckPermissions: async () => { throw new Error("transport unavailable"); },
          }}
        />,
      );
    });
    await act(async () => { renderer!.root.findByProps({ testID: "record-meeting-entry" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "permission-guidance-unavailable" })).toBeTruthy();
    expect(renderer!.root.findAllByType("Text").filter((node) => node.props.children === "Proposed")).toHaveLength(2);
    await act(async () => { await renderer!.root.findByProps({ testID: "permission-recheck-unavailable" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "permission-recovery-error" }).props.children)
      .toContain("Permission recovery failed");
    renderer!.unmount();
  });
});

describe("companion meeting surface", () => {
  test("keeps a draggable Electron titlebar region above the meeting surface", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[]}
          onRefresh={async () => undefined}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: "app-titlebar-drag-region" }).props.style).toMatchObject({
      position: "absolute",
      top: 0,
      right: 0,
      left: 0,
      height: ELECTRON_TITLEBAR_HIT_TEST_HEIGHT,
      WebkitAppRegion: "drag",
    });
    renderer!.unmount();
  });

  test("shows host offline as unknown host state, not an empty meeting list", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          layoutTier="desktop"
          compact
          connectionLabel="Host offline"
          hostConnectionStatus="offline"
          hostLabel="paired host"
          meetings={[]}
          onRefresh={async () => undefined}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: "host-offline" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "meeting-state-unknown" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "meeting-empty" })).toHaveLength(0);
    renderer!.unmount();
  });

  test("retains the last host-owned list while reconnecting", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          layoutTier="desktop"
          compact
          connectionLabel="Reconnecting"
          hostConnectionStatus="reconnecting"
          hostLabel="paired host"
          meetings={[meeting("m-1")]}
          onRefresh={async () => undefined}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: "host-reconnecting" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "meeting-m-1" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "meeting-empty" })).toHaveLength(0);
    renderer!.unmount();
  });

  test("shows compact selected-detail reconnect state and disables every interaction until online", async () => {
    const onChangeHost = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          layoutTier="desktop"
          compact
          connectionLabel="Reconnecting to paired host…"
          hostConnectionStatus="reconnecting"
          hostLabel="paired host"
          meetings={[meeting("m-1")]}
          onRefresh={async () => undefined}
          onChangeHost={onChangeHost}
          onCitation={async () => undefined}
          onChatSelection={() => undefined}
          onAskQuestion={async () => undefined}
          onRetryQuestion={async () => undefined}
          selectedMeetingId="m-1"
          transcript={transcript("ready")}
          consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex"
          chatModel="gpt-5"
          chatThread={{
            meetingId: "m-1",
            status: "failed",
            messages: [{
              role: "assistant", outcome: "supported", text: "Decision",
              citations: [{ meetingId: "m-1", segmentId: "segment-1" }],
              createdAt: "2026-08-21T00:00:00.000Z",
            }],
            selection: { provider: "codex", model: "gpt-5" },
            failure: { message: "retry later", retryable: true },
          }}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: "detail-host-reconnecting" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "citation-segment-1" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ testID: "chat-provider-trigger" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ testID: "chat-citation-segment-1" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ testID: "chat-retry" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ testID: "chat-question-input" }).props.editable).toBe(false);
    expect(renderer!.root.findByProps({ testID: "chat-ask" }).props.disabled).toBe(true);
    await act(async () => { renderer!.root.findByProps({ testID: "detail-change-companion-host" }).props.onPress(); });
    expect(onChangeHost).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ testID: "change-host-confirmation" })).toBeTruthy();
    await act(async () => { renderer!.root.findByProps({ testID: "change-host-confirm" }).props.onPress(); });
    expect(onChangeHost).toHaveBeenCalledOnce();
    renderer!.unmount();
  });

  test("has no create controls and cannot invoke meeting creation", async () => {
    const onCreate = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[]}
          onCreate={onCreate}
          onRefresh={async () => undefined}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: "desktop-create-controls" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "meeting-create-button" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "record-meeting-entry" })).toHaveLength(0);
    expect(renderer!.root.findAllByType("Text").some((node) =>
      node.props.children === "Companion library · recording happens on desktop")).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
    renderer!.unmount();
  });

  test("passes only the stable segment citation identity to the playback path", async () => {
    const onCitation = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[{ id: "m-1", title: "Sync", status: "ready", createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" }]}
          onRefresh={async () => undefined}
          onCitation={onCitation}
          selectedMeetingId="m-1"
          consentStatus="granted"
          providerStatus="configured"
          transcript={{
            id: "t-1", meetingId: "m-1", recordingId: "r-1", status: "ready", plannerVersion: "m3-range-v1",
            audioDurationMs: 1_000,
            ranges: [{ ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" }],
            segments: [{ range: { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" }, text: "hello", completedAt: "2026-08-18T10:00:00.000Z", detectedLanguages: ["en"] }],
            requestCount: 1, usage: null, detectedLanguages: ["en"], failureReason: null,
          }}
        />,
      );
    });
    await act(async () => { renderer!.root.findByProps({ testID: "citation-segment-1" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-1" });
    renderer!.unmount();
  });

  test("renders durable chat, canonical insufficient evidence, and retry state", async () => {
    const onRetry = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false} layoutTier="desktop" connectionLabel="Connected" hostLabel="isolated host"
          meetings={[meeting("m-1")]} onRefresh={async () => undefined}
          selectedMeetingId="m-1" transcript={transcript("ready")} consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex" chatModel="gpt-5"
          premiumAccess={{ entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" }}
          chatThread={{
            meetingId: "m-1", status: "failed",
            messages: [
              { role: "user", text: "Unknown?", createdAt: "2026-08-21T00:00:00.000Z" },
              { role: "assistant", outcome: "insufficient_evidence", text: null, citations: [], createdAt: "2026-08-21T00:00:01.000Z" },
            ],
            selection: { provider: "codex", model: "gpt-5" },
            failure: { message: "provider timeout", retryable: true },
          }}
          onRetryQuestion={onRetry}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: "meeting-chat" })).toBeTruthy();
    expect(renderer!.root.findAllByType("Text").some((node) =>
      node.props.children === "The meeting does not contain enough evidence.")).toBe(true);
    expect(renderer!.root.findAllByType("Text").some((node) => node.props.children === "Retry question")).toBe(true);
    expect(renderer!.root.findAllByType("Text").some((node) => typeof node.props.children === "string" && node.props.children.includes("Unlock"))).toBe(false);
    expect(renderer!.root.findAllByProps({ testID: "premium-paywall" })).toHaveLength(0);
    await act(async () => { renderer!.root.findByProps({ testID: "chat-retry" }).props.onPress(); });
    expect(onRetry).toHaveBeenCalledOnce();
    renderer!.unmount();
  });

  test("submits a selected-model question and forwards only the chat citation identity", async () => {
    const onAsk = vi.fn(async () => undefined);
    const onCitation = vi.fn(async () => undefined);
    const selection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: {},
    } as const;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false} layoutTier="desktop" connectionLabel="Connected" hostLabel="isolated host"
          meetings={[meeting("m-1")]} onRefresh={async () => undefined}
          selectedMeetingId="m-1" transcript={transcript("ready")} consentStatus="granted"
          chatCatalog={{ providers: [{
            id: "codex", label: "Codex", status: "ready", models: [{
              id: "gpt-5", label: "GPT-5", isDefault: true,
              thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high",
            }], modes: [{ id: "worker", label: "Worker" }], defaultModeId: "worker", error: null,
          }] }}
          chatSelection={selection}
          chatFeatures={{ version: 1, selection, status: "ready", features: [], error: null }}
          chatProvider="codex" chatModel="gpt-5" onAskQuestion={onAsk} onCitation={onCitation}
          chatThread={{
            meetingId: "m-1", status: "ready",
            messages: [{ role: "assistant", outcome: "supported", text: "Decision", citations: [{ meetingId: "m-1", segmentId: "segment-1" }], createdAt: "2026-08-21T00:00:01.000Z" }],
            selection: { provider: "codex", model: "gpt-5" }, failure: null,
          }}
        />,
      );
    });
    const input = renderer!.root.findByProps({ testID: "chat-question-input" });
    const ask = renderer!.root.findByProps({ testID: "chat-ask" });
    expect(input.props.editable).toBe(true);
    expect(ask.props.disabled).toBe(true);
    await act(async () => { input.props.onChangeText(" Next step? "); });
    expect(renderer!.root.findByProps({ testID: "chat-question-input" }).props.value).toBe(" Next step? ");
    expect(renderer!.root.findByProps({ testID: "chat-ask" }).props.disabled).toBe(false);
    await act(async () => { renderer!.root.findByProps({ testID: "chat-ask" }).props.onPress(); });
    expect(onAsk).toHaveBeenCalledWith("Next step?");
    await act(async () => { renderer!.root.findByProps({ testID: "chat-citation-segment-1" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-1" });
    renderer!.unmount();
  });

  test.each([
    ["inactive", { entitlement: "premium", status: "inactive", packages: [], reason: null }],
    ["unavailable", { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" }],
    ["missing", null],
  ] as const)("keeps Ask free with %s Premium state", async (_state, premiumAccess) => {
    const onAsk = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false} layoutTier="desktop" connectionLabel="Connected" hostLabel="isolated host"
          meetings={[meeting("m-1")]} onRefresh={async () => undefined}
          selectedMeetingId="m-1" transcript={transcript("ready")} consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex" chatModel="gpt-5" onAskQuestion={onAsk}
          premiumAccess={premiumAccess}
        />,
      );
    });

    const input = renderer!.root.findByProps({ testID: "chat-question-input" });
    const ask = renderer!.root.findByProps({ testID: "chat-ask" });
    await act(async () => { input.props.onChangeText(" What changed? "); });
    expect(ask.props.disabled).toBe(false);
    expect(renderer!.root.findAllByType("Text").some((node) => node.props.children === "Ask")).toBe(true);
    expect(renderer!.root.findAllByType("Text").some((node) => typeof node.props.children === "string" && node.props.children.includes("Unlock"))).toBe(false);
    await act(async () => { renderer!.root.findByProps({ testID: "chat-ask" }).props.onPress(); });
    expect(onAsk).toHaveBeenCalledOnce();
    expect(onAsk).toHaveBeenCalledWith("What changed?");
    expect(renderer!.root.findByProps({ testID: "chat-question-input" }).props.value).toBe("");
    expect(renderer!.root.findAllByProps({ testID: "premium-paywall" })).toHaveLength(0);
    renderer!.unmount();
  });
});

describe("responsive meeting sidebar and transcript detail", () => {
  test("proof scripts use the whole meeting row and ready transcript state", () => {
    const m1Proof = readFileSync(new URL("../../../scripts/prove-m1.mjs", import.meta.url), "utf8");
    expect(m1Proof).toContain('locator("xpath=ancestor::*[@data-testid and @role=\'button\']")');
    expect(m1Proof).toContain("meeting-row ancestor is absent");
    expect(m1Proof).toContain("meeting-row ancestor is ambiguous");
    expect(m1Proof).toContain('getByTestId("record-meeting-entry")');
    expect(m1Proof).toContain('getByTestId("recording-setup-title")');
    expect(m1Proof).toContain('getByTestId("recording-start")');
    expect(m1Proof).not.toContain('getByText("Create meeting", { exact: true })');
    expect(m1Proof).not.toContain('electronMeetingTitle.locator("..")');
    expect(m1Proof).not.toContain('webMeetingTitle.locator("..")');
    const browserCleanup = m1Proof.indexOf("for (const browser of [webBrowser, electronBrowser])");
    const processCleanup = m1Proof.indexOf("for (const child of [...owned].reverse())");
    const hostCleanup = m1Proof.indexOf('path.join(repositoryRoot, "scripts/stop-macos-host.mjs")');
    expect(browserCleanup).toBeGreaterThan(-1);
    expect(processCleanup).toBeGreaterThan(browserCleanup);
    expect(hostCleanup).toBeGreaterThan(processCleanup);
    expect(m1Proof).toContain('errorWithLogTail(error, "host-stop", hostStopLog)');

    const postM3Proof = readFileSync(new URL("../../../scripts/prove-post-m3.mjs", import.meta.url), "utf8");
    expect(postM3Proof).toContain('const meetingRow = page.locator(`[data-testid="meeting-${storeSnapshot.meeting.id}"]`);');
    expect(postM3Proof).toContain('[data-testid="transcript-ready"]');
    expect(postM3Proof).toContain('getByTestId("chat-provider-trigger").click()');
    expect(postM3Proof).not.toContain("meeting-transcript-${storeSnapshot.meeting.id}");
    expect(postM3Proof).not.toContain('[data-testid="transcript-panel"]');
  });

  test("uses the full meeting row for selection and marks the selected row", async () => {
    const onOpenTranscript = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onOpenTranscript={onOpenTranscript}
          onRefresh={async () => undefined}
        />,
      );
    });

    const row = renderer!.root.findByProps({ testID: "meeting-m-1" });
    expect(row.props.accessibilityState).toEqual({ disabled: false, selected: false });
    expect(row.props["aria-selected"]).toBe(false);
    await act(async () => { row.props.onPress(); });
    expect(onOpenTranscript).toHaveBeenCalledWith("m-1");
    renderer!.unmount();

    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact={false}
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1"), meeting("m-2")]}
          onOpenTranscript={onOpenTranscript}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcript={transcript("ready")}
          consentStatus="granted"
        />,
      );
    });
    const selectedRow = renderer!.root.findByProps({ testID: "meeting-m-1" });
    const unselectedRow = renderer!.root.findByProps({ testID: "meeting-m-2" });
    expect(selectedRow.props.accessibilityState).toEqual({ disabled: false, selected: true });
    expect(selectedRow.props["aria-selected"]).toBe(true);
    expect(unselectedRow.props.accessibilityState).toEqual({ disabled: false, selected: false });
    expect(unselectedRow.props["aria-selected"]).toBe(false);
    expect(renderer!.root.findByProps({ testID: "meeting-sidebar-pane" }).props.style[0]).toMatchObject({ width: 272 });
    expect(renderer!.root.findByProps({ testID: "meeting-detail-pane" }).props.style).toMatchObject({ flex: 1, minWidth: 0 });
    renderer!.unmount();
  });

  test("shows a Back control for compact detail", async () => {
    const onBack = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onBack={onBack}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcriptLoading
        />,
      );
    });

    const back = renderer!.root.findByProps({ testID: "meeting-detail-back" });
    await act(async () => { back.props.onPress(); });
    expect(onBack).toHaveBeenCalledOnce();
    expect(renderer!.root.findByProps({ testID: "transcript-loading" })).toBeTruthy();
    renderer!.unmount();
  });

  test.each([
    { name: "loading", props: { transcriptLoading: true }, state: "transcript-loading" },
    { name: "empty", props: {}, state: "transcript-empty" },
    { name: "processing", props: { transcript: transcript("transcribing") }, state: "transcript-processing" },
    { name: "failed", props: { transcript: transcript("failed") }, state: "transcript-failed" },
    { name: "fetch failure", props: { transcriptError: "transcript request failed" }, state: "transcript-failed" },
    { name: "invalid provider", props: { providerStatus: "invalid" as const }, state: "transcript-failed" },
  ])("renders an explicit $name transcript state without segments", async ({ props, state }) => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          consentStatus="granted"
          {...props}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: state })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "transcript-segments" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-1" })).toHaveLength(0);
    renderer!.unmount();
  });

  test("renders every ready segment once and timestamp presses carry only stable identity", async () => {
    const onCitation = vi.fn(async () => undefined);
    const ready = transcript("ready");
    ready.segments.push({
      range: { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" },
      text: "second segment",
      completedAt: "2026-08-18T10:00:01.000Z",
      detectedLanguages: ["en"],
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onCitation={onCitation}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcript={ready}
          consentStatus="granted"
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-1" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-2" })).toHaveLength(1);
    await act(async () => { renderer!.root.findByProps({ testID: "citation-segment-2" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-2" });
    expect(Object.keys(onCitation.mock.calls[0]![0] as object).sort()).toEqual(["meetingId", "segmentId"]);
    renderer!.unmount();
  });
});

function meeting(id: string) {
  return { id, title: id, status: "ready" as const, createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" };
}

function transcript(status: TranscriptWire["status"]): TranscriptWire {
  const range = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" };
  return {
    id: "t-1",
    meetingId: "m-1",
    recordingId: "r-1",
    status,
    plannerVersion: "m3-range-v1",
    audioDurationMs: 2_000,
    ranges: [range, { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" }],
    segments: [{ range, text: "first segment", completedAt: "2026-08-18T10:00:00.000Z", detectedLanguages: ["en"] }],
    requestCount: 1,
    usage: null,
    detectedLanguages: ["en"],
    failureReason: status === "failed" ? "provider failed" : null,
  };
}
