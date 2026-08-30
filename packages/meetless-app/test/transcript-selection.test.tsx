import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MeetlessClient } from "@meetless/client";

const { connectMeetlessClient, playCitationAudio, recordingState } = vi.hoisted(() => ({
  connectMeetlessClient: vi.fn(),
  playCitationAudio: vi.fn(),
  recordingState: { current: { enabled: false } as Record<string, unknown> },
}));

vi.mock("@meetless/client", () => ({ connectMeetlessClient }));
vi.mock("react-native", () => ({
  Platform: { OS: "web" }, SafeAreaView: "SafeAreaView",
  StyleSheet: { create: <T,>(styles: T) => styles }, useWindowDimensions: () => ({ width: 1_000 }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("../src/playback.js", () => ({ playCitationAudio }));
vi.mock("@meetless/meeting-surface", () => ({
  MeetingListSurface: (props: Record<string, unknown>) => React.createElement("MeetingListSurface", props),
  RecordingStrip: () => null,
}));
vi.mock("../src/recording-provider.js", () => ({
  RecordingProvider: ({ children }: { children: React.ReactNode }) => children,
  useRecording: () => recordingState.current,
}));

import { AppContent, loadCompanionRestoration } from "../src/App.js";

describe("transcript meeting selection ordering", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    recordingState.current = { enabled: false };
    vi.clearAllMocks();
  });

  test("late success and error from an old meeting cannot replace the current transcript or citation", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const first = deferred<ReturnType<typeof transcriptResponse>>();
    const second = deferred<ReturnType<typeof transcriptResponse>>();
    const getMeetingTranscript = vi.fn((meetingId: string) => meetingId === "m-1" ? first.promise : second.promise);
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [meeting("m-1"), meeting("m-2")],
        getMeetingTranscript,
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    await act(async () => {
      firstRequest = surface().props.onOpenTranscript("m-1");
      secondRequest = surface().props.onOpenTranscript("m-2");
    });
    expect(surface().props.selectedMeetingId).toBe("m-2");
    expect(surface().props.transcript).toBeNull();
    expect(surface().props.transcriptLoading).toBe(true);

    await act(async () => { second.resolve(transcriptResponse("m-2", "segment-m-2", "current citation")); await secondRequest; });
    expect(surface().props.transcript).toMatchObject({ meetingId: "m-2" });
    expect(surface().props.transcriptLoading).toBe(false);
    expect(surface().props.transcript.segments[0]).toMatchObject({
      range: { segmentId: "segment-m-2" }, text: "current citation",
    });

    await act(async () => { first.resolve(transcriptResponse("m-1", "segment-m-1", "stale citation")); await firstRequest; });
    expect(surface().props.transcript).toMatchObject({ meetingId: "m-2" });
    expect(surface().props.transcript.segments[0].range.segmentId).toBe("segment-m-2");

    const staleError = deferred<ReturnType<typeof transcriptResponse>>();
    getMeetingTranscript.mockImplementationOnce(() => staleError.promise);
    await act(async () => { void surface().props.onOpenTranscript("m-1"); });
    await act(async () => { void surface().props.onOpenTranscript("m-2"); });
    await act(async () => { staleError.reject(new Error("old meeting failed")); });
    expect(surface().props.selectedMeetingId).toBe("m-2");
    expect(surface().props.transcriptError).toBeNull();
  });

  test("Back invalidates an in-flight selection and clears its detail state", async () => {
    const pending = deferred<ReturnType<typeof transcriptResponse>>();
    const getMeetingTranscript = vi.fn(() => pending.promise);
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [meeting("m-1")],
        getMeetingTranscript,
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    let request!: Promise<void>;
    await act(async () => { request = surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.selectedMeetingId).toBe("m-1");
    expect(surface().props.transcriptLoading).toBe(true);
    await act(async () => { surface().props.onBack(); });
    expect(surface().props.selectedMeetingId).toBeNull();
    expect(surface().props.transcript).toBeNull();
    expect(surface().props.transcriptLoading).toBe(false);

    await act(async () => { pending.resolve(transcriptResponse("m-1", "stale", "stale")); await request; });
    expect(surface().props.selectedMeetingId).toBeNull();
    expect(surface().props.transcript).toBeNull();
  });

  test("confirmed deletion stays pending, then refreshes the list and clears only the deleted detail", async () => {
    const deletion = deferred<{ meetingId: string; outcome: "deleted"; reason: null }>();
    const listMeetings = vi.fn()
      .mockResolvedValueOnce([meeting("m-1"), meeting("m-2")])
      .mockResolvedValueOnce([meeting("m-2")]);
    const client = {
      listMeetings,
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current"),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => null,
      deleteMeeting: vi.fn(() => deletion.promise),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    const staleOpen = surface().props.onOpenTranscript;
    await act(async () => { surface().props.onRequestDeleteMeeting("m-1"); });
    expect(surface().props.deleteConfirmationMeetingId).toBe("m-1");

    let request!: Promise<void>;
    await act(async () => { request = surface().props.onConfirmDeleteMeeting(); });
    expect(surface().props.deletePending).toBe(true);
    expect(surface().props.selectedMeetingId).toBe("m-1");
    expect(surface().props.meetings.map((candidate: { id: string }) => candidate.id)).toEqual(["m-1", "m-2"]);
    await act(async () => { await staleOpen("m-2"); });
    expect(surface().props.selectedMeetingId).toBe("m-1");

    await act(async () => { deletion.resolve({ meetingId: "m-1", outcome: "deleted", reason: null }); await request; });
    expect(client.deleteMeeting).toHaveBeenCalledWith("m-1");
    expect(surface().props.meetings.map((candidate: { id: string }) => candidate.id)).toEqual(["m-2"]);
    expect(surface().props.selectedMeetingId).toBeNull();
    expect(surface().props.transcript).toBeNull();
    expect(surface().props.deletePending).toBe(false);
  });

  test.each([
    ["runtime is idle", { enabled: true, status: { meetingId: null, status: "idle" }, displayElapsedMs: 0 }],
    ["runtime belongs to another meeting", { enabled: true, status: { meetingId: "m-other", status: "recording" }, displayElapsedMs: 1_000 }],
  ])("deletes a persisted Recording meeting when %s", async (_scenario, runtimeState) => {
    const stale = { ...meeting("m-stale"), status: "recording" as const };
    let deleted = false;
    recordingState.current = runtimeState;
    const listMeetings = vi.fn(async () => deleted ? [] : [stale]);
    const client = {
      listMeetings,
      getMeetingTranscript: async () => ({
        meeting: stale, transcript: null, consent: { status: "unknown" as const }, provider: { status: "missing" as const },
      }),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => null,
      deleteMeeting: vi.fn(async () => {
        deleted = true;
        return { meetingId: "m-stale", outcome: "deleted" as const, reason: null };
      }),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-stale"); });
    expect(surface().props.deleteDisabled).toBe(false);
    await act(async () => { surface().props.onRequestDeleteMeeting("m-stale"); });
    expect(surface().props.deleteConfirmationMeetingId).toBe("m-stale");
    await act(async () => { await surface().props.onConfirmDeleteMeeting(); });
    expect(client.deleteMeeting).toHaveBeenCalledWith("m-stale");
    expect(surface().props.meetings).toEqual([]);
    expect(surface().props.selectedMeetingId).toBeNull();
  });

  test("keeps delete disabled for a genuinely active recording", async () => {
    const active = { ...meeting("m-active"), status: "recording" as const };
    const deleteMeeting = vi.fn();
    recordingState.current = {
      enabled: true,
      status: { meetingId: "m-active", status: "recording" },
      displayElapsedMs: 1_000,
    };
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [active],
        getMeetingTranscript: async () => ({
          meeting: active, transcript: null, consent: { status: "unknown" as const }, provider: { status: "missing" as const },
        }),
        deleteMeeting,
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-active"); });
    expect(surface().props.deleteDisabled).toBe(true);
    expect(surface().props.deleteConfirmationMeetingId).toBeNull();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  test("delete failure preserves the list and selected detail with safe error copy", async () => {
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current"),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => null,
      deleteMeeting: vi.fn(async () => { throw new Error("private filesystem path"); }),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { surface().props.onRequestDeleteMeeting("m-1"); });
    await act(async () => { await surface().props.onConfirmDeleteMeeting(); });

    expect(surface().props.selectedMeetingId).toBe("m-1");
    expect(surface().props.transcript).toMatchObject({ meetingId: "m-1" });
    expect(surface().props.meetings).toHaveLength(1);
    expect(surface().props.deleteError).toBe("We could not delete this meeting. It is still in your library.");
    expect(surface().props.deleteError).not.toContain("filesystem");
  });

  test("Retry transcription reuses the idempotent consent operation and refreshes the selected transcript", async () => {
    let transcriptCalls = 0;
    const grantTranscriptionConsent = vi.fn(async () => ({
      consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
      provider: { status: "configured" as const },
    }));
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: vi.fn(async () => {
        transcriptCalls += 1;
        const result = transcriptResponse("m-1", "segment-m-1", "retried transcript");
        return transcriptCalls === 1
          ? { ...result, transcript: { ...result.transcript, status: "failed" as const, failureReason: "provider failed" } }
          : result;
      }),
      grantTranscriptionConsent,
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => null,
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.transcript).toMatchObject({ status: "failed" });
    expect(surface().props.onRetryTranscription).toEqual(expect.any(Function));

    await act(async () => { await surface().props.onRetryTranscription(); });
    expect(grantTranscriptionConsent).toHaveBeenCalledOnce();
    expect(client.getMeetingTranscript).toHaveBeenCalledTimes(2);
    expect(surface().props.transcript).toMatchObject({ status: "ready", meetingId: "m-1" });
  });

  test.each([
    ["stale provider", { provider: "removed-provider", model: "gpt-5" }, "codex", "gpt-5"],
    ["stale model", { provider: "anthropic", model: "removed-model" }, "codex", "gpt-5"],
    ["valid saved choice", { provider: "anthropic", model: "claude-sonnet" }, "anthropic", "claude-sonnet"],
  ] as const)("openTranscript resolves a %s against the current provider inventory", async (_name, savedSelection, expectedProvider, expectedModel) => {
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      listChatProviders: async () => ({ providers: providerInventory() }),
      getMeetingChat: async () => chatResponse(savedSelection),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });

    expect(surface().props.chatProvider).toBe(expectedProvider);
    expect(surface().props.chatModel).toBe(expectedModel);
    expect(surface().props.chatProviders).toEqual(providerInventory());
  });

  test("rehydrates one host-global complete selection across meetings and snapshots it for ask", async () => {
    const selection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    };
    const controls = {
      version: 1 as const,
      catalog: { providers: [] }, profiles: [], catalogError: null,
      lastSelection: selection, lastSelectionState: "available" as const, lastSelectionError: null,
    };
    const getMeetingChat = vi.fn(async (meetingId: string) => ({ ...chatResponse(), meetingId }));
    const askMeetingQuestionWithSelection = vi.fn(async ({ meetingId, selection: asked }: { meetingId: string; selection: typeof selection }) => ({
      ...chatResponse(), meetingId, status: "running" as const, selection: { provider: asked.provider, model: asked.model },
    }));
    const client = {
      listMeetings: async () => [meeting("m-1"), meeting("m-2")],
      getChatControls: vi.fn(async () => controls),
      getMeetingTranscript: async (meetingId: string) => transcriptResponse(meetingId, `segment-${meetingId}`, "current citation"),
      getMeetingChat,
      discoverChatFeatures: async (asked: typeof selection) => ({ version: 1 as const, selection: asked, status: "ready" as const, features: [], error: null }),
      askMeetingQuestionWithSelection,
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.chatSelection).toEqual(selection));
    await vi.waitFor(() => expect(surface().props.chatFeatures?.selection).toEqual(selection));

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.chatSelection).toEqual(selection);
    expect(surface().props.chatFeatures?.selection).toEqual(selection);
    await act(async () => { await surface().props.onAskQuestion("What did we decide?"); });
    expect(askMeetingQuestionWithSelection).toHaveBeenCalledWith({
      meetingId: "m-1", question: "What did we decide?", selection,
    });

    await act(async () => { await surface().props.onOpenTranscript("m-2"); });
    expect(surface().props.chatSelection).toEqual(selection);
    await act(async () => { await surface().props.onAskQuestion("What did we decide next?"); });
    expect(askMeetingQuestionWithSelection).toHaveBeenLastCalledWith({
      meetingId: "m-2", question: "What did we decide next?", selection,
    });
  });

  test("does not let a delayed initial controls response overwrite a newer local selection", async () => {
    const initialSelection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: { fast_mode: false },
    };
    const localSelection = {
      provider: "codex", model: "gpt-5-mini", modeId: "reviewer", thinkingOptionId: "low", featureValues: { fast_mode: true },
    };
    const controls = deferred<{
      version: 1;
      catalog: { providers: [] };
      profiles: [];
      catalogError: null;
      lastSelection: typeof initialSelection;
      lastSelectionState: "available";
      lastSelectionError: null;
    }>();
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getChatControls: vi.fn(() => controls.promise),
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      getMeetingChat: async () => chatResponse(),
      discoverChatFeatures: vi.fn(async (selection: typeof localSelection) => featureResponse(selection)),
      applyChatSelection: vi.fn(async (selection: typeof localSelection) => selection),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(client.getChatControls).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onChatSelectionBundle(localSelection); });
    expect(surface().props.chatSelection).toEqual(localSelection);

    await act(async () => {
      controls.resolve({
        version: 1, catalog: { providers: [] }, profiles: [], catalogError: null,
        lastSelection: initialSelection, lastSelectionState: "available", lastSelectionError: null,
      });
      await Promise.resolve();
    });
    expect(surface().props.chatSelection).toEqual(localSelection);
  });

  test("does not let delayed meeting controls overwrite a selection made before switching meetings", async () => {
    const initialSelection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: { fast_mode: false },
    };
    const localSelection = {
      provider: "codex", model: "gpt-5-mini", modeId: "reviewer", thinkingOptionId: "low", featureValues: { fast_mode: true },
    };
    const controls = {
      version: 1 as const,
      catalog: { providers: [] }, profiles: [], catalogError: null,
      lastSelection: initialSelection, lastSelectionState: "available" as const, lastSelectionError: null,
    };
    const delayedControls = deferred<typeof controls>();
    const getChatControls = vi.fn()
      .mockResolvedValueOnce(controls)
      .mockResolvedValueOnce(controls)
      .mockImplementationOnce(() => delayedControls.promise);
    const client = {
      listMeetings: async () => [meeting("m-1"), meeting("m-2")],
      getChatControls,
      getMeetingTranscript: async (meetingId: string) => transcriptResponse(meetingId, `segment-${meetingId}`, "current citation"),
      getMeetingChat: async (meetingId: string) => ({ ...chatResponse(), meetingId }),
      discoverChatFeatures: vi.fn(async (selection: typeof localSelection) => featureResponse(selection)),
      applyChatSelection: vi.fn(async (selection: typeof localSelection) => selection),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(getChatControls).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    let opening!: Promise<void>;
    await act(async () => {
      opening = surface().props.onOpenTranscript("m-2");
      await vi.waitFor(() => expect(getChatControls).toHaveBeenCalledTimes(3));
    });
    await act(async () => { await surface().props.onChatSelectionBundle(localSelection); });
    expect(surface().props.chatSelection).toEqual(localSelection);
    await act(async () => {
      delayedControls.resolve(controls);
      await opening;
    });
    expect(surface().props.chatSelection).toEqual(localSelection);
  });

  test("discards late feature discovery after a complete selection changes", async () => {
    const firstSelection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: {},
    };
    const secondSelection = { ...firstSelection, model: "gpt-5-mini" };
    const controls = {
      version: 1 as const,
      catalog: { providers: [] }, profiles: [], catalogError: null,
      lastSelection: firstSelection, lastSelectionState: "available" as const, lastSelectionError: null,
    };
    const first = deferred<ReturnType<typeof featureResponse>>();
    const second = deferred<ReturnType<typeof featureResponse>>();
    const discoverChatFeatures = vi.fn((selection: typeof firstSelection) =>
      selection.model === firstSelection.model ? first.promise : second.promise);
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getChatControls: async () => controls,
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      getMeetingChat: async () => chatResponse(),
      discoverChatFeatures,
      applyChatSelection: vi.fn(async (selection: typeof firstSelection) => selection),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(discoverChatFeatures).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onChatSelectionBundle(secondSelection); });
    await vi.waitFor(() => expect(discoverChatFeatures).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(featureResponse(secondSelection));
      await Promise.resolve();
    });
    expect(surface().props.chatFeatures.selection).toEqual(secondSelection);
    await act(async () => {
      first.resolve(featureResponse(firstSelection));
      await Promise.resolve();
    });
    expect(surface().props.chatFeatures.selection).toEqual(secondSelection);
  });

  test("late same-meeting citation success stops its stale handle and cannot replace the latest playback", async () => {
    const firstPlayback = deferred<{ stop(): void }>();
    const secondPlayback = deferred<{ stop(): void }>();
    const firstHandle = { stop: vi.fn() };
    const secondHandle = { stop: vi.fn() };
    playCitationAudio.mockImplementation((citation: { segmentId: string }) =>
      citation.segmentId === "segment-first" ? firstPlayback.promise : secondPlayback.promise);
    const resolveCitation = vi.fn(async ({ meetingId, segmentId }: { meetingId: string; segmentId: string }) =>
      citationResponse(meetingId, segmentId));
    await renderConnected(resolveCitation);
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    await act(async () => {
      firstRequest = surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-first" });
      await Promise.resolve();
      secondRequest = surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-second" });
    });
    await act(async () => { secondPlayback.resolve(secondHandle); await secondRequest; });
    await act(async () => { firstPlayback.resolve(firstHandle); await firstRequest; });

    expect(firstHandle.stop).toHaveBeenCalledOnce();
    expect(secondHandle.stop).not.toHaveBeenCalled();
    expect(surface().props.transcriptError).toBeNull();
  });

  test("late same-meeting citation error is ignored after a newer request succeeds", async () => {
    const staleResolution = deferred<ReturnType<typeof citationResponse>>();
    const latestHandle = { stop: vi.fn() };
    const resolveCitation = vi.fn(({ meetingId, segmentId }: { meetingId: string; segmentId: string }) =>
      segmentId === "segment-stale" ? staleResolution.promise : Promise.resolve(citationResponse(meetingId, segmentId)));
    playCitationAudio.mockResolvedValue(latestHandle);
    await renderConnected(resolveCitation);
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });

    let staleRequest!: Promise<void>;
    await act(async () => {
      staleRequest = surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-stale" });
      await surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-current" });
    });
    await act(async () => { staleResolution.reject(new Error("stale citation failed")); await staleRequest; });

    expect(surface().props.transcriptError).toBeNull();
    expect(latestHandle.stop).not.toHaveBeenCalled();
  });

  async function renderConnected(resolveCitation: (input: { meetingId: string; segmentId: string }) => Promise<ReturnType<typeof citationResponse>>) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [meeting("m-1")],
        getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
        resolveCitation,
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
  }
});

describe("companion transactional restoration", () => {
  test("returns list, selected transcript, providers, and durable chat only after the whole transaction succeeds", async () => {
    const chat = deferred<ReturnType<typeof chatResponse>>();
    const client = {
      listMeetings: vi.fn(async () => [meeting("m-1")]),
      getMeetingTranscript: vi.fn(async () => transcriptResponse("m-1", "segment-m-1", "current citation")),
      listChatProviders: vi.fn(async () => ({
        providers: [{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }],
      })),
      getMeetingChat: vi.fn(() => chat.promise),
    } as unknown as MeetlessClient;
    let settled = false;
    const restoration = loadCompanionRestoration(client, "m-1").finally(() => { settled = true; });
    await vi.waitFor(() => expect(client.getMeetingChat).toHaveBeenCalledWith("m-1"));
    expect(settled).toBe(false);
    chat.resolve(chatResponse());

    await expect(restoration).resolves.toMatchObject({
      meetings: [{ id: "m-1" }],
      detail: { transcript: { meetingId: "m-1" } },
      chatThread: { meetingId: "m-1", status: "ready" },
      chatProvider: "codex",
      chatModel: "gpt-5",
    });
  });

  test("rejects the complete restoration when durable chat fails", async () => {
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => { throw new Error("durable chat unavailable"); },
    } as unknown as MeetlessClient;
    await expect(loadCompanionRestoration(client, "m-1")).rejects.toThrow("durable chat unavailable");
  });

  test.each([
    ["stale provider", { provider: "removed-provider", model: "gpt-5" }, "codex", "gpt-5"],
    ["stale model", { provider: "anthropic", model: "removed-model" }, "codex", "gpt-5"],
    ["valid saved choice", { provider: "anthropic", model: "claude-sonnet" }, "anthropic", "claude-sonnet"],
  ] as const)("resolves a %s before companion restoration exposes chat state", async (_name, savedSelection, expectedProvider, expectedModel) => {
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      listChatProviders: async () => ({ providers: providerInventory() }),
      getMeetingChat: async () => chatResponse(savedSelection),
    } as unknown as MeetlessClient;

    await expect(loadCompanionRestoration(client, "m-1")).resolves.toMatchObject({
      chatProvider: expectedProvider,
      chatModel: expectedModel,
      chatProviders: providerInventory(),
    });
  });
});

function meeting(id: string) {
  return { id, title: id, status: "ready" as const, createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" };
}

function transcriptResponse(meetingId: string, segmentId: string, text: string) {
  const range = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId };
  return {
    meeting: meeting(meetingId),
    transcript: {
      id: `transcript-${meetingId}`, meetingId, recordingId: `recording-${meetingId}`, status: "ready" as const,
      plannerVersion: "m3-range-v1" as const, audioDurationMs: 1_000, ranges: [range],
      segments: [{ range, text, completedAt: "2026-08-18T10:00:00.000Z", detectedLanguages: ["en"] }],
      requestCount: 1, usage: null, detectedLanguages: ["en"], failureReason: null,
    },
    consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
    provider: { status: "configured" as const },
  };
}

function citationResponse(meetingId: string, segmentId: string) {
  return {
    meetingId, recordingId: `recording-${meetingId}`, segmentId,
    startMs: 0, endMs: 1_000, text: segmentId,
    audio: { mimeType: "audio/mpeg" as const, base64: "AQID" },
  };
}

function providerInventory() {
  return [
    { id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] },
    { id: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet", label: "Claude Sonnet", isDefault: true }] },
  ];
}

function chatResponse(selection: { provider: string; model: string } = { provider: "codex", model: "gpt-5" }) {
  return {
    meetingId: "m-1",
    status: "ready" as const,
    messages: [],
    selection,
    failure: null,
  };
}

function featureResponse(selection: {
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, boolean | string | null>;
}) {
  return { version: 1 as const, selection, status: "ready" as const, features: [], error: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
