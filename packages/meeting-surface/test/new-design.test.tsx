import React from "react";
import { readFileSync } from "node:fs";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Platform, ScrollView } from "react-native";
import type {
  ChatControlsCatalogWire,
  ChatFeatureDiscoveryWire,
  ChatProfileWire,
  ChatSelectionWire,
  RecordingStatusWire,
  TranscriptWire,
} from "@meetless/meeting-contracts";
import { chatPickerGeometry, MeetingListSurface, RecordingStrip, surfaceLayout } from "../src/index.js";

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: (props: Record<string, unknown>) => React.createElement("MaterialCommunityIcons", props),
}));

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
  features: [
    { type: "toggle", id: "fast_mode", label: "Fast mode", tooltip: "Use faster responses", value: false },
    { type: "toggle", id: "plan_mode", label: "Plan mode", description: "Plan before responding", value: false },
    { type: "toggle", id: "custom_mode", label: "Custom mode", value: false },
    { type: "select", id: "response_style", label: "Response style", value: "brief", options: [
      { id: "brief", label: "Brief" }, { id: "detailed", label: "Detailed" },
    ] },
  ],
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
    Platform.OS = "web";
    vi.unstubAllGlobals();
  });

  test("maps the three width tiers to their intended composition model", () => {
    expect(surfaceLayout("phone")).toMatchObject({ row: { direction: "column" }, content: { padding: 12 } });
    expect(surfaceLayout("tablet")).toMatchObject({ row: { direction: "column" }, content: { padding: 16 } });
    expect(surfaceLayout("desktop")).toMatchObject({ row: { direction: "row" }, content: { padding: 24, maxWidth: 1200 } });
  });

  test("anchors a short-content picker exactly eight pixels above the composer trigger", () => {
    const trigger = { top: 820, right: 1250, bottom: 852, left: 1100 };
    const geometry = chatPickerGeometry(trigger, { width: 1440, height: 900 }, 180);
    expect(geometry.placement).toBe("above");
    expect(geometry).toMatchObject({ top: 632, left: 1100, width: 300, maxHeight: 180 });
    expect(geometry.top + geometry.maxHeight).toBe(trigger.top - 8);
  });

  test("caps tall content and keeps the 877px tablet picker inside the viewport", () => {
    const viewport = { width: 877, height: 768 };
    const trigger = { top: 690, right: 325, bottom: 722, left: 203 };
    const geometry = chatPickerGeometry(trigger, viewport, 700);
    expect(geometry).toMatchObject({ placement: "above", top: 262, left: 203, width: 300, maxHeight: 420 });
    expect(geometry.maxHeight).toBeLessThan(700);
    expect(geometry.top + geometry.maxHeight).toBe(trigger.top - 8);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(viewport.width);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(viewport.height);
  });

  test("places short content below when there is not enough room above", () => {
    const trigger = { top: 40, right: 325, bottom: 72, left: 203 };
    const geometry = chatPickerGeometry(trigger, { width: 877, height: 768 }, 180);
    expect(geometry).toMatchObject({ placement: "below", top: 80, left: 203, width: 300, maxHeight: 180 });
  });

  test.each([
    [390, { top: 20, right: 52, bottom: 64, left: 8 }, 600],
    [877, { top: 700, right: 875, bottom: 744, left: 830 }, 700],
    [1440, { top: 420, right: 1438, bottom: 464, left: 1400 }, 180],
  ] as const)("shared chat popup geometry clamps every edge at %ipx", (width, trigger, contentHeight) => {
    const viewport = { width, height: width === 390 ? 844 : 900 };
    const geometry = chatPickerGeometry(trigger, viewport, contentHeight);
    expect(geometry.left, "shared-popup rule: left edge keeps the 12px design margin").toBeGreaterThanOrEqual(12);
    expect(geometry.left + geometry.width, "shared-popup rule: right edge keeps the 12px design margin").toBeLessThanOrEqual(width - 12);
    expect(geometry.top, "shared-popup rule: top edge keeps the 12px design margin").toBeGreaterThanOrEqual(12);
    expect(geometry.top + geometry.maxHeight, "shared-popup rule: bottom edge keeps the 12px design margin").toBeLessThanOrEqual(viewport.height - 12);
  });

  test("all four named chat consumers compose through the shared popup presenter", () => {
    const source = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
    for (const consumer of ["model", "thinking", "feature", "legacy-provider"]) {
      expect(source, `${consumer} violates shared-popup rule (design/DESIGN.md): compose it through ChatPopupPresenter`)
        .toContain(`consumer="${consumer}"`);
    }
    expect(source.match(/<ChatPopupPresenter/g), "shared-popup rule requires exactly four production consumer compositions").toHaveLength(4);
    expect(source, "shared-popup rule forbids the former absolute/downward-only chatMiniMenu geometry").not.toContain("chatMiniMenu:");
    expect(source, "shared-popup rule forbids the former absolute/downward-only pickerOptions geometry").not.toContain("pickerOptions:");
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
    expect(renderer.root.findByProps({ testID: "chat-provider-chevron-box" }).props.style).toMatchObject({ width: 12, height: 12 });
    expect(renderer.root.findByProps({ testID: "chat-provider-chevron-icon" }).props.name).toBe("chevron-down");
    expect(renderer.root.findAllByProps({ testID: "chat-provider-options" })).toHaveLength(0);
    await act(async () => { trigger.props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" })).toBeTruthy();
    const selected = renderer.root.findByProps({ testID: "chat-model-codex-gpt-5" });
    expect(selected.props.accessibilityState).toMatchObject({ disabled: false, selected: true });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-anthropic-claude-sonnet" }).props.onPress(); });
    expect(onSelection).toHaveBeenCalledWith("anthropic", "claude-sonnet");
    expect(renderer.root.findAllByProps({ testID: "chat-provider-options" })).toHaveLength(0);
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

  test("uses real compact icons for chat selectors and known feature toggles", async () => {
    const onSelection = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "phone", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [controlsProfile], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: onSelection,
    });
    await act(async () => { renderer.root.findByProps({ testID: "task-tab-ask" }).props.onPress(); });
    const modelChevronBox = renderer.root.findByProps({ testID: "chat-model-chevron-box" });
    const thinkingChevronBox = renderer.root.findByProps({ testID: "chat-thinking-chevron-box" });
    expect(modelChevronBox.props.style).toMatchObject({ width: 12, height: 12, alignItems: "center", justifyContent: "center" });
    expect(thinkingChevronBox.props.style).toMatchObject({ width: 12, height: 12, alignItems: "center", justifyContent: "center" });
    expect(renderer.root.findByProps({ testID: "chat-model-chevron-icon" }).props.name).toBe("chevron-down");
    expect(renderer.root.findByProps({ testID: "chat-thinking-chevron-icon" }).props.name).toBe("chevron-down");
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "⌄")).toBe(false);

    const fast = renderer.root.findByProps({ testID: "chat-fast-toggle" });
    const plan = renderer.root.findByProps({ testID: "chat-plan-toggle" });
    expect(renderer.root.findByProps({ testID: "chat-fast-toggle-icon" }).props.name).toBe("lightning-bolt");
    expect(renderer.root.findByProps({ testID: "chat-plan-toggle-icon" }).props.name).toBe("format-list-checks");
    expect(fast.props.accessibilityLabel).toBe("Fast off");
    expect(fast.props.accessibilityHint).toBe("Use faster responses");
    expect(fast.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
    expect(plan.props.accessibilityLabel).toBe("Plan off");
    expect(plan.props.accessibilityHint).toBe("Plan before responding");
    expect(plan.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "Fast" || node.props.children === "Plan")).toBe(false);
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "Custom mode")).toBe(true);
    expect(Object.assign({}, ...(fast.props.style as object[]).filter(Boolean))).toMatchObject({ width: 44, height: 44 });
    expect(Object.assign({}, ...(plan.props.style as object[]).filter(Boolean))).toMatchObject({ width: 44, height: 44 });

    await act(async () => { fast.props.onPress(); });
    expect(onSelection).toHaveBeenCalledWith({ ...controlsSelection, featureValues: { fast_mode: true } });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "chat-profile-profile-1" }).props.onPress(); });
    expect(onSelection).toHaveBeenLastCalledWith(controlsProfile.selection);
    expect(renderer.root.findAllByProps({ testID: "chat-model-picker" })).toHaveLength(0);
    renderer.unmount();
  });

  test("distinguishes active Fast and Plan controls while desktop targets stay 32 pixels", async () => {
    const activeFeatures: ChatFeatureDiscoveryWire = {
      ...controlsFeatures,
      features: controlsFeatures.features?.map((feature) => feature.type === "toggle" && feature.id !== "custom_mode"
        ? { ...feature, value: true }
        : feature) ?? [],
    };
    const renderer = renderSurface({
      layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [], chatSelection: controlsSelection,
      chatFeatures: activeFeatures, onChatSelectionBundle: vi.fn(),
    });
    const fast = renderer.root.findByProps({ testID: "chat-fast-toggle" });
    const plan = renderer.root.findByProps({ testID: "chat-plan-toggle" });
    const fastStyle = Object.assign({}, ...(fast.props.style as object[]).filter(Boolean));
    const planStyle = Object.assign({}, ...(plan.props.style as object[]).filter(Boolean));
    expect(fastStyle).toMatchObject({ width: 32, height: 32, borderColor: "rgba(234,179,8,0.5)", backgroundColor: "rgba(234,179,8,0.13)" });
    expect(planStyle).toMatchObject({ width: 32, height: 32, borderColor: "rgba(130,143,255,0.5)", backgroundColor: "rgba(94,106,210,0.16)" });
    expect(fastStyle).not.toEqual(planStyle);
    expect(fast.props.accessibilityState.selected).toBe(true);
    expect(plan.props.accessibilityState.selected).toBe(true);
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
    expect(renderer.root.findByProps({ testID: "chat-model-picker-dismiss" })).toBeTruthy();
    const pickerStyle = Object.assign(
      {},
      ...(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity),
    );
    expect(pickerStyle).toMatchObject({
      position: "fixed", top: "auto", right: 12, bottom: 12, left: 12, width: "auto", maxHeight: "calc(100vh - 24px)",
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-picker-dismiss" }).props.onPress(); });
    expect(renderer.root.findAllByProps({ testID: "chat-model-picker" })).toHaveLength(0);
    renderer.unmount();
  });

  test("thinking and dynamic select-feature consumers preserve selection through the shared presenter", async () => {
    const onSelection = vi.fn(async () => undefined);
    const renderer = renderSurface({
      layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: onSelection,
    });

    await act(async () => { renderer.root.findByProps({ testID: "chat-thinking-trigger" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-popup-presenter-thinking" })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: "chat-thinking-menu" })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ testID: "chat-thinking-high" }).props.onPress(); });
    expect(onSelection, "thinking consumer shared-popup rule preserves thinking selection").toHaveBeenLastCalledWith({
      ...controlsSelection, thinkingOptionId: "high",
    });

    await act(async () => { renderer.root.findByProps({ testID: "chat-feature-select-response_style" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-popup-presenter-feature" })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: "chat-feature-menu-response_style" })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ testID: "chat-feature-response_style-detailed" }).props.onPress(); });
    expect(onSelection, "select-feature consumer shared-popup rule preserves feature selection").toHaveBeenLastCalledWith({
      ...controlsSelection, featureValues: { ...controlsSelection.featureValues, response_style: "detailed" },
    });
    renderer.unmount();
  });

  test("shared popup owns constrained internal scrolling, resize reposition, Escape, focus containment and return", async () => {
    let keydown: ((event: { key: string; shiftKey?: boolean; preventDefault(): void }) => void) | null = null;
    let resize: (() => void) | null = null;
    const triggerFocus = vi.fn();
    const firstFocus = { focus: vi.fn(), getAttribute: () => null };
    const lastFocus = { focus: vi.fn(), getAttribute: () => null };
    const triggerNode = { focus: triggerFocus, getBoundingClientRect: () => ({ top: 700, right: 360, bottom: 744, left: 340 }) };
    const rootNode = { contains: () => false, querySelector: () => triggerNode };
    const popupNode = {
      scrollHeight: 700,
      getBoundingClientRect: () => ({ height: 420 }),
      querySelector: () => firstFocus,
      querySelectorAll: () => [firstFocus, lastFocus],
    };
    const documentMock = {
      activeElement: lastFocus,
      addEventListener: vi.fn((type: string, listener: typeof keydown) => { if (type === "keydown") keydown = listener; }),
      removeEventListener: vi.fn(),
    };
    const windowMock = {
      innerWidth: 877,
      innerHeight: 768,
      addEventListener: vi.fn((type: string, listener: () => void) => { if (type === "resize") resize = listener; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", documentMock);
    vi.stubGlobal("window", windowMock);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MeetingListSurface
          connectionLabel="Host online" hostConnectionStatus="online" hostLabel="this host"
          meetings={[baseMeeting]} layoutTier="desktop" selectedMeetingId="m-1" transcript={baseTranscript}
          consentStatus="granted" chatCatalog={controlsCatalog} chatProfiles={[]} chatSelection={controlsSelection}
          chatFeatures={controlsFeatures} onChatSelectionBundle={vi.fn()} onRefresh={async () => undefined}
        />,
        { createNodeMock: (element) => {
          if (element.props.testID === "chat-popup-presenter-model") return rootNode;
          if (element.props.testID === "chat-model-picker") return popupNode;
          return {};
        } },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    const popup = renderer.root.findByProps({ testID: "chat-model-picker" });
    const scroller = popup.children[0] as { props: { style: Record<string, unknown> } };
    expect(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style.flat(Infinity))
      .toEqual(expect.arrayContaining([expect.objectContaining({ position: "fixed" })]));
    expect(resize, "model consumer shared-popup rule registers resize reposition").toEqual(expect.any(Function));
    expect(scroller.type, "shared-popup rule assigns scrolling to the presenter").toBe(ScrollView);
    expect(scroller.props.style, "shared-popup rule constrains overflow inside the popup").toMatchObject({ flexShrink: 1, minHeight: 0 });

    await act(async () => { keydown?.({ key: "Tab", preventDefault: vi.fn() }); });
    expect(firstFocus.focus, "shared-popup rule contains focus at the last tabbable item").toHaveBeenCalled();
    windowMock.innerWidth = 390;
    await act(async () => { resize?.(); });
    const positioned = Object.assign({}, ...(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity));
    expect(positioned.left, "shared-popup rule repositions after viewport resize").toBeGreaterThanOrEqual(12);
    await act(async () => { keydown?.({ key: "Escape", preventDefault: vi.fn() }); });
    expect(renderer.root.findAllByProps({ testID: "chat-model-picker" })).toHaveLength(0);
    expect(triggerFocus, "model consumer shared-popup rule returns focus to its trigger after Escape").toHaveBeenCalled();
    renderer.unmount();
  });

  test("remeasures model drilldown from intrinsic content instead of the previous popup constraint", async () => {
    const models = Array.from({ length: 40 }, (_, index) => ({
      id: `model-${index}`,
      label: `Model ${index}`,
      isDefault: index === 0,
      thinkingOptions: [],
      defaultThinkingOptionId: null,
    }));
    const catalog: ChatControlsCatalogWire = {
      providers: [{
        id: "codex", label: "Codex", status: "ready", error: null, defaultModeId: "worker",
        modes: [{ id: "worker", label: "Worker" }], models,
      }],
    };
    const popupNode = { scrollHeight: 121, getBoundingClientRect: () => ({ height: 121 }), querySelector: () => null, querySelectorAll: () => [] };
    const contentNode = { scrollHeight: 1_820, getBoundingClientRect: () => ({ height: 1_820 }) };
    const triggerNode = { getBoundingClientRect: () => ({ top: 700, right: 360, bottom: 744, left: 340 }) };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MeetingListSurface
          connectionLabel="Host online" hostConnectionStatus="online" hostLabel="this host"
          meetings={[baseMeeting]} layoutTier="desktop" selectedMeetingId="m-1" transcript={baseTranscript}
          consentStatus="granted" chatCatalog={catalog} chatProfiles={[]} chatSelection={{ ...controlsSelection, model: "model-0" }}
          chatFeatures={controlsFeatures} onChatSelectionBundle={vi.fn()} onRefresh={async () => undefined}
        />,
        { createNodeMock: (element) => {
          if (element.props.testID === "chat-popup-presenter-model") return { contains: () => false, querySelector: () => triggerNode };
          if (element.props.testID === "chat-model-picker") return popupNode;
          if (element.props.testID === "chat-model-picker-content") return contentNode;
          return {};
        } },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "chat-provider-codex" }).props.onPress(); });

    const style = Object.assign({}, ...(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity));
    expect(style.maxHeight, "intrinsic content growth must replace the stale 121px popup constraint").toBe(420);
    expect(renderer.root.findByProps({ testID: "chat-model-picker-content" })).toBeTruthy();
    renderer.unmount();
  });

  test("does not reset popup focus when query content rerenders", async () => {
    const initialFocus = { focus: vi.fn(), getAttribute: () => null };
    const retainedFocus = { focus: vi.fn(), getAttribute: () => null };
    const popupNode = {
      getBoundingClientRect: () => ({ height: 180 }),
      querySelector: () => initialFocus,
      querySelectorAll: () => [initialFocus, retainedFocus],
    };
    vi.stubGlobal("document", {
      activeElement: retainedFocus,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      body: {},
      documentElement: {},
    });
    vi.stubGlobal("window", { innerWidth: 877, innerHeight: 768, addEventListener: vi.fn(), removeEventListener: vi.fn() });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MeetingListSurface
          connectionLabel="Host online" hostConnectionStatus="online" hostLabel="this host"
          meetings={[baseMeeting]} layoutTier="desktop" selectedMeetingId="m-1" transcript={baseTranscript}
          consentStatus="granted" chatCatalog={controlsCatalog} chatProfiles={[]} chatSelection={controlsSelection}
          chatFeatures={controlsFeatures} onChatSelectionBundle={vi.fn()} onRefresh={async () => undefined}
        />,
        { createNodeMock: (element) => {
          if (element.props.testID === "chat-popup-presenter-model") return { contains: () => false, querySelector: () => ({ getBoundingClientRect: () => ({ top: 700, right: 360, bottom: 744, left: 340 }) }) };
          if (element.props.testID === "chat-model-picker") return popupNode;
          if (element.props.testID === "chat-model-picker-content") return { scrollHeight: 180 };
          return {};
        } },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    expect(initialFocus.focus).toHaveBeenCalledOnce();
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-search" }).props.onChangeText("codex"); });
    expect(initialFocus.focus, "content/query rerender must preserve the user's current focus").toHaveBeenCalledOnce();
    renderer.unmount();
  });

  test("keeps focus in a replacement thinking popup when switching directly from model", async () => {
    const modelTriggerFocus = vi.fn();
    const thinkingFocus = { focus: vi.fn(), getAttribute: () => null, isConnected: true };
    const documentMock = {
      activeElement: thinkingFocus,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      body: {},
      documentElement: {},
    };
    vi.stubGlobal("document", documentMock);
    vi.stubGlobal("window", { innerWidth: 877, innerHeight: 768, addEventListener: vi.fn(), removeEventListener: vi.fn() });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MeetingListSurface
          connectionLabel="Host online" hostConnectionStatus="online" hostLabel="this host"
          meetings={[baseMeeting]} layoutTier="desktop" selectedMeetingId="m-1" transcript={baseTranscript}
          consentStatus="granted" chatCatalog={controlsCatalog} chatProfiles={[]} chatSelection={controlsSelection}
          chatFeatures={controlsFeatures} onChatSelectionBundle={vi.fn()} onRefresh={async () => undefined}
        />,
        { createNodeMock: (element) => {
          if (element.props.testID === "chat-popup-presenter-model") return { contains: () => false, querySelector: () => ({ focus: modelTriggerFocus, getBoundingClientRect: () => ({ top: 700, right: 360, bottom: 744, left: 340 }) }) };
          if (element.props.testID === "chat-popup-presenter-thinking") return { contains: (node: object) => node === thinkingFocus, querySelector: () => ({ getBoundingClientRect: () => ({ top: 700, right: 460, bottom: 744, left: 400 }) }) };
          if (element.props.testID === "chat-model-picker") return { getBoundingClientRect: () => ({ height: 180 }), querySelector: () => ({ focus: vi.fn() }), querySelectorAll: () => [] };
          if (element.props.testID === "chat-thinking-menu") return { getBoundingClientRect: () => ({ height: 88 }), querySelector: () => thinkingFocus, querySelectorAll: () => [thinkingFocus] };
          if (String(element.props.testID).endsWith("-content")) return { scrollHeight: 180 };
          return {};
        } },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "chat-thinking-trigger" }).props.onPress(); });

    expect(renderer.root.findByProps({ testID: "chat-thinking-menu" })).toBeTruthy();
    expect(thinkingFocus.focus).toHaveBeenCalledOnce();
    expect(modelTriggerFocus, "closing model presenter must not steal focus from its replacement").not.toHaveBeenCalled();
    renderer.unmount();
  });

  test("uses visible native-valid absolute popup fallbacks with bounded presenter scrolling", async () => {
    Platform.OS = "ios";
    const renderer = renderSurface({
      layoutTier: "desktop", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: vi.fn(),
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });

    const popupStyle = Object.assign({}, ...(renderer.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity));
    expect(popupStyle).toMatchObject({ position: "absolute", right: 0, width: 300, maxHeight: 420 });
    expect(popupStyle.opacity, "native fallback must never inherit hidden web pending geometry").toBeUndefined();
    expect(renderer.root.findByProps({ testID: "chat-model-picker" }).findByType(ScrollView).props.style)
      .toMatchObject({ flexShrink: 1, minHeight: 0 });
    renderer.unmount();

    const phone = renderSurface({
      layoutTier: "phone", selectedMeetingId: "m-1", transcript: baseTranscript, consentStatus: "granted",
      chatCatalog: controlsCatalog, chatProfiles: [], chatSelection: controlsSelection,
      chatFeatures: controlsFeatures, onChatSelectionBundle: vi.fn(),
    });
    await act(async () => { phone.root.findByProps({ testID: "task-tab-ask" }).props.onPress(); });
    await act(async () => { phone.root.findByProps({ testID: "chat-model-trigger" }).props.onPress(); });
    const phonePopupStyle = Object.assign({}, ...(phone.root.findByProps({ testID: "chat-model-picker" }).props.style as object[]).flat(Infinity));
    expect(phonePopupStyle).toMatchObject({ position: "absolute", right: 0, bottom: 52, left: 0, maxHeight: 420 });
    expect(Object.values(phonePopupStyle).some((value) => typeof value === "string" && (value.includes("vh") || value === "fixed" || value === "auto")))
      .toBe(false);
    expect(phone.root.findByProps({ testID: "chat-model-picker-dismiss" }).props.style)
      .toMatchObject({ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 });
    expect(phone.root.findByProps({ testID: "chat-model-picker" }).findByType(ScrollView)).toBeTruthy();
    phone.unmount();
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
    expect(renderer.root.findByProps({ testID: "chat-provider-options" })).toBeTruthy();
    renderer.unmount();
  });

  test("closes provider/model options on an outside pointer without consuming that interaction", async () => {
    let outsidePointer: ((event: { target: object }) => void) | null = null;
    const outsideAction = vi.fn();
    const focus = vi.fn();
    const pickerNode = { contains: (target: object) => target === pickerNode, querySelector: () => ({ focus }) };
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
        { createNodeMock: (element) => element.props.testID === "chat-popup-presenter-legacy-provider" ? pickerNode : {} },
      );
    });
    await act(async () => { renderer.root.findByProps({ testID: "chat-provider-trigger" }).props.onPress(); });
    expect(renderer.root.findByProps({ testID: "chat-provider-options" })).toBeTruthy();
    expect(outsidePointer).toEqual(expect.any(Function));

    await act(async () => {
      outsidePointer?.({ target: {} });
      outsideAction();
    });

    expect(renderer.root.findAllByProps({ testID: "chat-provider-options" })).toHaveLength(0);
    expect(outsideAction).toHaveBeenCalledOnce();
    expect(focus, "legacy provider shared-popup rule returns focus to its trigger").toHaveBeenCalledOnce();
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
