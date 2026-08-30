import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ChatControlsCatalogWire,
  ChatFeatureDiscoveryWire,
  ChatProfileWire,
  ChatSelectionWire,
  RecordingStatusWire,
  TranscriptWire,
} from "@meetless/meeting-contracts";
import { chatPickerGeometry, MeetingListSurface, RecordingStrip, surfaceLayout } from "../src/index.js";

const baseMeeting = {
  id: "m-1",
  title: "Weekly sync",
  status: "ready" as const,
  createdAt: "2026-08-18T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z",
};

const baseTranscript: TranscriptWire = {
  id: "t-1",
  meetingId: "m-1",
  recordingId: "r-1",
  status: "ready",
  plannerVersion: "m3-range-v1",
  audioDurationMs: 2_000,
  ranges: [
    { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" },
    { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" },
  ],
  segments: [
    {
      range: { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" },
      text: "The first decision is recorded here.",
      completedAt: "2026-08-18T10:00:00.000Z",
      detectedLanguages: ["en"],
    },
    {
      range: { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" },
      text: "The second decision is recorded here.",
      completedAt: "2026-08-18T10:00:01.000Z",
      detectedLanguages: ["en"],
    },
  ],
  requestCount: 1,
  usage: null,
  detectedLanguages: ["en"],
  failureReason: null,
};

const controlsCatalog: ChatControlsCatalogWire = {
  providers: [
    {
      id: "codex", label: "Codex", status: "ready", error: null, defaultModeId: "worker",
      modes: [{ id: "worker", label: "Worker" }],
      models: [{
        id: "gpt-5", label: "GPT-5", isDefault: true,
        thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
        defaultThinkingOptionId: "low",
      }],
    },
    {
      id: "anthropic", label: "Anthropic", status: "ready", error: null, defaultModeId: null,
      modes: [],
      models: [{ id: "sonnet", label: "Sonnet", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null }],
    },
  ],
};

const controlsSelection: ChatSelectionWire = {
  provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "low", featureValues: { fast_mode: false },
};

const controlsProfile: ChatProfileWire = {
  id: "profile-1", name: "Fast review", icon: "✦", color: "blue",
  selection: { ...controlsSelection, thinkingOptionId: "high", featureValues: { fast_mode: true } },
};

const controlsFeatures: ChatFeatureDiscoveryWire = {
  version: 1, selection: controlsSelection, status: "ready", error: null,
  features: [{ type: "toggle", id: "fast_mode", label: "Fast mode", value: false }],
};

function renderSurface(props: Record<string, unknown>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MeetingListSurface
        connectionLabel="Host online"
        hostConnectionStatus="online"
        hostLabel="this host"
        meetings={[baseMeeting]}
        onRefresh={async () => undefined}
        {...props}
      />,
    );
  });
  return renderer;
}

describe("new-design composition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("maps the three width tiers to their intended composition model", () => {
    expect(surfaceLayout("phone")).toMatchObject({ row: { direction: "column" }, content: { padding: 12 } });
    expect(surfaceLayout("tablet")).toMatchObject({ row: { direction: "column" }, content: { padding: 16 } });
    expect(surfaceLayout("desktop")).toMatchObject({ row: { direction: "row" }, content: { padding: 24, maxWidth: 1200 } });
  });

  test.each([
    {
      name: "877px tablet viewport",
      viewport: { width: 877, height: 768 },
      trigger: { top: 690, right: 325, bottom: 722, left: 203 },
      expectedLeft: 203,
    },
    {
      name: "desktop viewport",
      viewport: { width: 1440, height: 900 },
      trigger: { top: 820, right: 1250, bottom: 852, left: 1100 },
      expectedLeft: 1100,
    },
  ])("keeps the model picker above a bottom composer trigger inside the $name", ({ viewport, trigger, expectedLeft }) => {
    const geometry = chatPickerGeometry(trigger, viewport);
    expect(geometry.placement).toBe("above");
    expect(geometry.left).toBe(expectedLeft);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(trigger.top);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(viewport.width);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(viewport.height);
  });

  test("opens one Record meeting setup with Proposed sources and no Create meeting task", async () => {
    const onStart = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "desktop",
      meetings: [],
      canRecord: true,
      recordingSetup: { available: true, pending: false, error: null, onStart },
    });

    expect(renderer.root.findAllByProps({ testID: "record-meeting-entry" }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "Create meeting")).toBe(false);
    await act(async () => { renderer.root.findByProps({ testID: "record-meeting-entry" }).props.onPress(); });

    expect(renderer.root.findByProps({ testID: "recording-setup" })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: "recording-source-microphone" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: "recording-source-system-audio" })).toHaveLength(1);
    expect(renderer.root.findAllByType("Text").filter((node) => node.props.children === "Proposed")).toHaveLength(2);

    const start = renderer.root.findByProps({ testID: "recording-start" });
    expect(start.props.disabled).toBe(true);
    await act(async () => { renderer.root.findByProps({ testID: "recording-setup-title" }).props.onChangeText("  Weekly design sync  "); });
    expect(renderer.root.findByProps({ testID: "recording-start" }).props.disabled).toBe(false);
    await act(async () => { renderer.root.findByProps({ testID: "recording-start" }).props.onPress(); });

    expect(onStart).toHaveBeenCalledWith("Weekly design sync");
    expect(renderer.root.findAllByProps({ testID: "recording-setup" })).toHaveLength(0);
    renderer.unmount();
  });

  test("keeps desktop transcript and Ask scroll contexts independent and narrows to one task", async () => {
    const desktop = renderSurface({ layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted" });
    expect(desktop.root.findByProps({ testID: "transcript-pane-scroll" })).toBeTruthy();
    expect(desktop.root.findByProps({ testID: "ask-pane-scroll" })).toBeTruthy();
    expect(desktop.root.findAllByProps({ testID: "task-switcher" })).toHaveLength(0);
    desktop.unmount();

    const tablet = renderSurface({ layoutTier: "tablet", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted" });
    expect(tablet.root.findByProps({ testID: "task-switcher" })).toBeTruthy();
    expect(tablet.root.findByProps({ testID: "transcript-detail-scroll" })).toBeTruthy();
    expect(tablet.root.findAllByProps({ testID: "ask-pane" })).toHaveLength(0);
    await act(async () => { tablet.root.findByProps({ testID: "task-tab-ask" }).props.onPress(); });
    expect(tablet.root.findByProps({ testID: "ask-pane-scroll" })).toBeTruthy();
    expect(tablet.root.findAllByProps({ testID: "transcript-detail-scroll" })).toHaveLength(0);
    tablet.unmount();

    const phoneList = renderSurface({ layoutTier: "phone" });
    expect(phoneList.root.findByProps({ testID: "meeting-layout-phone" })).toBeTruthy();
    expect(phoneList.root.findByProps({ testID: "meeting-sidebar" })).toBeTruthy();
    expect(phoneList.root.findAllByProps({ testID: "meeting-detail" })).toHaveLength(0);
    expect(phoneList.root.findByProps({ testID: "phone-list-surface" }).props["aria-hidden"]).toBe(false);
    phoneList.unmount();

    const phoneDetail = renderSurface({ layoutTier: "phone", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted" });
    expect(phoneDetail.root.findByProps({ testID: "meeting-detail-back" })).toBeTruthy();
    expect(phoneDetail.root.findByProps({ testID: "transcript-detail-scroll" })).toBeTruthy();
    expect(phoneDetail.root.findByProps({ testID: "phone-list-surface" }).props.style[1]).toBeTruthy();
    expect(phoneDetail.root.findByProps({ testID: "phone-detail-surface" }).props["aria-hidden"]).toBe(false);
    phoneDetail.unmount();
  });

  test("hides the meeting-list scrollbar while retaining scrolling", () => {
    const renderer = renderSurface({ layoutTier: "desktop", meetings: [baseMeeting] });
    const list = renderer.root.findByProps({ testID: "meeting-surface" });
    expect(list.props.showsVerticalScrollIndicator).toBe(false);
    expect(list.props.scrollEnabled).toBe(true);
    renderer.unmount();
  });

  test("keeps the phone list instance mounted across detail navigation", async () => {
    const renderer = renderSurface({ layoutTier: "phone" });
    const listBefore = renderer.root.findByProps({ testID: "meeting-surface" });
    await act(async () => {
      renderer.update(
        <MeetingListSurface
          connectionLabel="Host online"
          hostConnectionStatus="online"
          hostLabel="this host"
          meetings={[baseMeeting]}
          onRefresh={async () => undefined}
          layoutTier="phone"
          selectedMeetingId="m-1"
          transcript={baseTranscript}
          consentStatus="granted"
        />,
      );
    });
    expect(renderer.root.findByProps({ testID: "meeting-surface" })).toBe(listBefore);
    renderer.unmount();
  });

  test("offers Retry transcription on a failed transcript and keeps saved-audio language", async () => {
    const onRetry = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "phone",
      selectedMeetingId: "m-1",
      transcript: { ...baseTranscript, status: "failed", failureReason: "provider failed" },
      consentStatus: "granted",
      onRetryTranscription: onRetry,
    });
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "Your saved audio is safe. Retry transcription when you are ready.")).toBe(true);
    await act(async () => { renderer.root.findByProps({ testID: "transcription-retry" }).props.onPress(); });
    expect(onRetry).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  test("explains host replacement before clearing the saved pairing", async () => {
    const onChangeHost = vi.fn(async () => undefined);
    const renderer = renderSurface({ layoutTier: "desktop", onChangeHost });
    await act(async () => { renderer.root.findByProps({ testID: "change-companion-host" }).props.onPress(); });
    expect(onChangeHost).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: "change-host-confirmation" })).toBeTruthy();
    const copy = renderer.root.findAllByType("Text").map((node) => node.props.children).join(" ");
    expect(copy).toContain("replaces the saved pairing information on this device");
    expect(copy).toContain("meetings remain on the desktop host");
    await act(async () => { renderer.root.findByProps({ testID: "change-host-confirm" }).props.onPress(); });
    expect(onChangeHost).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  test("names the meeting, warns that deletion is permanent, and disables pending confirmation", async () => {
    const onRequest = vi.fn();
    const onConfirm = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    const renderer = renderSurface({
      layoutTier: "desktop",
      selectedMeetingId: "m-1",
      transcript: baseTranscript,
      onRequestDeleteMeeting: onRequest,
      onCancelDeleteMeeting: onCancel,
      onConfirmDeleteMeeting: onConfirm,
    });
    await act(async () => { renderer.root.findByProps({ testID: "meeting-delete-action" }).props.onPress(); });
    expect(onRequest).toHaveBeenCalledWith("m-1");

    await act(async () => {
      renderer.update(<MeetingListSurface
        connectionLabel="Host online" hostConnectionStatus="online" hostLabel="this host"
        meetings={[baseMeeting]} onRefresh={async () => undefined} layoutTier="desktop"
        selectedMeetingId="m-1" transcript={baseTranscript}
        deleteConfirmationMeetingId="m-1" deletePending
        onRequestDeleteMeeting={onRequest} onCancelDeleteMeeting={onCancel} onConfirmDeleteMeeting={onConfirm}
      />);
    });
    const copy = JSON.stringify(renderer.toJSON());
    expect(copy).toContain("Delete “");
    expect(copy).toContain("Weekly sync");
    expect(copy).toContain("permanently deletes");
    expect(copy).toContain("cannot undo");
    expect(renderer.root.findByProps({ testID: "meeting-delete-confirm" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: "meeting-delete-cancel" }).props.disabled).toBe(true);
    renderer.unmount();
  });

  test("disables delete during active work and shows a safe failure", () => {
    const renderer = renderSurface({
      layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript,
      deleteDisabled: true, deleteError: "We could not delete this meeting. It is still in your library.",
      onRequestDeleteMeeting: vi.fn(),
    });
    expect(renderer.root.findByProps({ testID: "meeting-delete-action" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: "meeting-delete-error" }).props.children).toContain("still in your library");
    renderer.unmount();
  });

  test("keeps provider and model selection compact until expanded and can choose any option", async () => {
    const onSelection = vi.fn();
    const renderer = renderSurface({
      layoutTier: "desktop",
      selectedMeetingId: "m-1",
      transcript: baseTranscript,
      consentStatus: "granted",
      chatProviders: [
        { id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }, { id: "gpt-4o", label: "GPT-4o", isDefault: false }] },
        { id: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet", label: "Claude Sonnet", isDefault: true }] },
      ],
      chatProvider: "codex",
      chatModel: "gpt-5",
      onChatSelection: onSelection,
    });
    const trigger = renderer.root.findByProps({ testID: "chat-provider-trigger" });
    expect(trigger.props.accessibilityState).toMatchObject({ disabled: false, expanded: false });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(true);
    await act(async () => { trigger.props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(false);
    const selected = renderer.root.findByProps({ testID: "chat-model-codex-gpt-5" });
    expect(selected.props.accessibilityState).toMatchObject({ disabled: false, selected: true });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-anthropic-claude-sonnet" }).props.onPress(); });
    expect(onSelection).toHaveBeenCalledWith("anthropic", "claude-sonnet");
    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(true);
    renderer.unmount();
  });

  test("shows profiles before providers, applies profiles immediately, and keeps provider rows browse-only", async () => {
    const onSelection = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [controlsProfile], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: onSelection,
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    const text = renderer.root.findAllByType("Text").map((node) => node.props.children).join(" ");
    expect(text.indexOf("Profiles")).toBeLessThan(text.indexOf("Providers"));
    await act(async () => { renderer.root.findByProps({ testID: "chat-provider-anthropic" }).props.onPress(); });
    expect(onSelection).not.toHaveBeenCalled();
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-anthropic-sonnet" }).props.onPress(); });
    expect(onSelection).toHaveBeenCalledWith({
      provider: "anthropic", model: "sonnet", modeId: null, thinkingOptionId: null, featureValues: {},
    });
    renderer.unmount();
  });

  test("applies full profile, conditional thinking, and dynamic Fast feature controls", async () => {
    const onSelection = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "phone", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [controlsProfile], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: onSelection,
    });
    await act(async () => { renderer.root.findByProps({ testID: "task-tab-ask" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-thinking-trigger" })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: "chat-fast-toggle" })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ testID: "chat-fast-toggle" }).props.onPress(); });
    expect(onSelection).toHaveBeenCalledWith({ ...controlsSelection, featureValues: { fast_mode: true } });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "chat-profile-profile-1" }).props.onPress(); });
    expect(onSelection).toHaveBeenLastCalledWith(controlsProfile.selection);
    expect(renderer.root.findAllByProps({ testID: "chat-model-picker" })).toHaveLength(0);
    renderer.unmount();
  });

  test("uses a bottom-sheet dismissal target on phone", async () => {
    const renderer = renderSurface({
      layoutTier: "phone", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: vi.fn(),
    });
    await act(async () => { renderer.root.findByProps({ testID: "task-tab-ask" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-picker-dismiss" })).toBeTruthy();
    const pickerStyle = Object.assign(
      {},
      ...(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity),
    );
    expect(pickerStyle).toMatchObject({
      position: "fixed", top: "auto", right: 8, bottom: 8, left: 8, width: "auto", maxHeight: "78vh",
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-picker-dismiss" }).props.onPress(); });
    expect(renderer.root.findAllByProps({ testID: "chat-model-picker" })).toHaveLength(0);
    renderer.unmount();
  });

  test("opens the full provider/model inventory for an invalid saved selection", () => {
    const renderer = renderSurface({
      layoutTier: "desktop",
      selectedMeetingId: "m-1",
      transcript: baseTranscript,
      consentStatus: "granted",
      chatProviders: [{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }],
      chatProvider: "removed-provider",
      chatModel: "removed-model",
      onChatSelection: vi.fn(),
    });
    expect(renderer.root.findByProps({ testID: "chat-provider-trigger" }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(false);
    renderer.unmount();
  });

  test("closes provider/model options on an outside pointer without consuming that interaction", async () => {
    let outsidePointer: ((event: { target: object }) => void) | null = null;
    const outsideAction = vi.fn();
    const pickerNode = { contains: (target: object) => target === pickerNode };
    vi.stubGlobal("document", {
      addEventListener: vi.fn((type: string, listener: (event: { target: object }) => void) => {
        if (type === "pointerdown") outsidePointer = listener;
      }),
      removeEventListener: vi.fn(),
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MeetingListSurface
          connectionLabel="Host online"
          hostConnectionStatus="online"
          hostLabel="this host"
          meetings={[baseMeeting]}
          layoutTier="desktop"
          selectedMeetingId="m-1"
          transcript={baseTranscript}
          consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex"
          chatModel="gpt-5"
          onChatSelection={vi.fn()}
          onRefresh={async () => undefined}
        />,
        { createNodeMock: (element) => element.props.testID === "chat-provider-picker" ? pickerNode : {} },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-provider-trigger" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(false);
    expect(outsidePointer).toEqual(expect.any(Function));

    await act(async () => {
      outsidePointer?.({ target: {} });
      outsideAction();
    });

    expect(renderer.root.findByProps({ testID: "chat-provider-options" }).props["aria-hidden"]).toBe(true);
    expect(outsideAction).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  test.each([
    ["resolving", "Resolving evidence…", true],
    ["playing", "Playing evidence · 00:01–00:02", false],
    ["completed", "Evidence played · 00:01–00:02", false],
    ["failed", "Playback failed", false],
  ] as const)("renders %s citation evidence with stable identity and transcript highlight", async (status, label, disabled) => {
    const onCitation = vi.fn();
    const renderer = renderSurface({
      layoutTier: "desktop",
      selectedMeetingId: "m-1",
      transcript: baseTranscript,
      consentStatus: "granted",
      onCitation,
      citationEvidence: {
        meetingId: "m-1", segmentId: "segment-2", startMs: 1_000, endMs: 2_000,
        text: "The validated answer evidence.", status, error: status === "failed" ? "Playback could not start. Try again." : null,
      },
    });
    const highlighted = renderer.root.findByProps({ testID: "transcript-segment-segment-2" });
    expect(highlighted.props.style[1]).toBeTruthy();
    expect(renderer.root.findByProps({ testID: "citation-evidence-status" }).props.children).toBe("Evidence · validated transcript segment");
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === label)).toBe(true);
    expect(renderer.root.findByProps({ testID: "citation-play-from-here" }).props.disabled).toBe(disabled);
    expect(renderer.root.findAllByProps({ testID: "playback-pause" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: "playback-stop" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: "playback-seek" })).toHaveLength(0);
    if (!disabled) {
      await act(async () => { renderer.root.findByProps({ testID: "citation-play-from-here" }).props.onPress(); });
      expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-2" });
    }
    renderer.unmount();
  });

  test("keeps known meetings as disabled stale context while offline and offers Try again", async () => {
    const onRetry = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "tablet",
      hostConnectionStatus: "offline",
      connectionLabel: "Host offline",
      selectedMeetingId: "m-1",
      onOpenTranscript: async () => undefined,
      onRetryConnection: onRetry,
    });
    const row = renderer.root.findByProps({ testID: "meeting-m-1" });
    expect(row.props.disabled).toBe(true);
    expect(row.props.accessibilityState).toMatchObject({ disabled: true, selected: true });
    expect(row.props["aria-disabled"]).toBe(true);
    expect(renderer.root.findAllByProps({ testID: "meeting-empty" })).toHaveLength(0);
    await act(async () => { renderer.root.findByProps({ testID: "host-offline-try-again" }).props.onPress(); });
    expect(onRetry).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  test.each([
    ["interrupted", "Recording interrupted"],
    ["finalizing", "Saving local audio"],
    ["saved", "Audio saved locally"],
    ["failed", "Recording needs attention"],
  ] as const)("maps %s recording state to user language", async (status, title) => {
    const recording: RecordingStatusWire = {
      status,
      recordingId: "r-1",
      meetingId: "m-1",
      title: "Weekly sync",
      elapsedMs: 2_000,
      paused: false,
      chunks: [],
      inventoryState: status === "saved" ? "complete" : "pending",
      chunkCount: 1,
      microphoneCount: 1,
      systemCount: 0,
      inventoryDigest: null,
      retryEligible: false,
      outputPath: null,
      error: "provider internals must stay out of the UI",
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <RecordingStrip
          elapsedMs={2_000}
          error="provider internals must stay out of the UI"
          onPause={async () => undefined}
          onResume={async () => undefined}
          onRetry={async () => undefined}
          onStart={async () => undefined}
          onStop={async () => undefined}
          pending={false}
          status={recording}
        />,
      );
    });
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === title)).toBe(true);
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "provider internals must stay out of the UI")).toBe(false);
    expect(renderer.root.findAllByProps({ testID: "recording-pause-resume" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: "recording-stop" })).toHaveLength(0);
    renderer.unmount();
  });
});
