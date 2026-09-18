import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, test, vi } from "vitest";
import { ManagedMeetingChatAgentPort, managedAskSelection } from "../packages/meetless-plugin/src/managed-ask";

const { connectMeetlessClient } = vi.hoisted(() => ({ connectMeetlessClient: vi.fn() }));
vi.mock("@meetless/client", () => ({ connectMeetlessClient }));
vi.mock("react-native", () => ({
  Platform: { OS: "web" }, View: "View", Text: "Text", Pressable: "Pressable", SafeAreaView: "SafeAreaView",
  StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 1000 }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("@meetless/meeting-surface", () => ({ MeetingListSurface: (props: Record<string, unknown>) => React.createElement("MeetingListSurface", props), RecordingStrip: () => null }));
vi.mock("../packages/meetless-app/src/recording-provider", () => ({ RecordingProvider: ({ children }: { children: React.ReactNode }) => children, useRecording: () => ({ enabled: false }) }));
vi.mock("../packages/meetless-app/src/playback", () => ({}));
import { AppContent } from "../packages/meetless-app/src/App";

let renderer: ReactTestRenderer | null = null;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = null; vi.clearAllMocks(); });

test.each(["v1", "legacy"] as const)("%s Ask/retry confirms each operation, cancel sends nothing, managed controls never probe agents", async (route) => {
  const controls = await new ManagedMeetingChatAgentPort(vi.fn()).getControls(null);
  const meeting = { id: "m", title: "Meeting", createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z" };
  const oldThread = { meetingId: "m", status: "failed", messages: [{ role: "user", text: "Old question" }], selection: { provider: "codex", model: "old" }, failure: { message: "Old failure", retryable: true } };
  const ask = vi.fn(async () => oldThread);
  const retry = vi.fn(async () => oldThread);
  const getProviderAccess = vi.fn();
  const client = {
    listMeetings: async () => [meeting], getChatControls: async () => controls,
    discoverChatFeatures: async () => ({ version: 1, selection: managedAskSelection(), status: "ready", features: [], error: null }),
    getMeetingChat: async () => oldThread, getProviderAccess,
    getMeetingTranscript: async () => ({ meeting, recording: null, transcript: { status: "ready", segments: [] }, consent: { status: "granted" }, provider: { status: "configured" }, transcription: { outcome: "ready", retryEligible: false, failureCategory: null, message: null } }),
    ...(route === "v1" ? { askMeetingQuestionWithSelection: ask, retryMeetingQuestionWithSelection: retry } : { askMeetingQuestion: ask, retryMeetingQuestion: retry }),
  };
  connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
  await act(async () => { renderer = create(React.createElement(AppContent, { mode: "desktop" })); });
  const surface = () => renderer!.root.findByType("MeetingListSurface" as never).props;
  await act(async () => { await surface().onOpenTranscript("m"); });
  expect(surface().chatThread).toEqual(oldThread);
  expect(surface().chatSelection).toEqual(managedAskSelection());
  expect(surface().providerAccessNotice).toBeUndefined();
  expect(getProviderAccess).not.toHaveBeenCalled();
  for (const operation of ["ask", "retry"] as const) {
    const start = () => operation === "ask" ? surface().onAskQuestion("Question") : surface().onRetryQuestion();
    let pending!: Promise<unknown>;
    await act(async () => { pending = start().catch(() => undefined); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("30 days");
    expect(JSON.stringify(renderer!.toJSON())).toContain("24 hours");
    expect(operation === "ask" ? ask : retry).not.toHaveBeenCalled();
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: "Cancel Managed Ask" }).props.onPress(); await pending; });
    expect(operation === "ask" ? ask : retry).not.toHaveBeenCalled();
    await act(async () => { pending = start(); });
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: "Confirm and send to OpenAI" }).props.onPress(); await pending; });
    expect(operation === "ask" ? ask : retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ meetingId: "m", consent: true }));
  }
  expect(getProviderAccess).not.toHaveBeenCalled();
});
