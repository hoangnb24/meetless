import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";

const controls = vi.hoisted(() => ({
  clearCompanionProfile: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  deleteMeeting: vi.fn(),
  emit: null as null | ((state: { status: string }) => void),
  rehydrate: null as null | ((client: Record<string, unknown>, context: { reconnect: boolean; epoch: number; isCurrent(): boolean }) => Promise<void>),
  getMeetingTranscript: vi.fn(async () => ({
    meeting: { id: "m-1", title: "m-1", status: "ready", createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" },
    transcript: null,
    consent: { status: "granted", grantedAt: "2026-08-18T10:00:00.000Z" },
    provider: { status: "configured" },
  })),
  listMeetings: vi.fn(async () => [] as Array<{ id: string }>),
  resolveCitation: vi.fn(),
  loadCompanionProfile: vi.fn(async () => ({
    version: 1, id: "direct:192.168.1.4:6777", label: "Host", type: "direct",
    endpoint: "192.168.1.4:6777", useTls: false, password: "private-password",
  })),
}));

vi.mock("@meetless/client", () => ({
  connectMeetlessClient: vi.fn(),
  MeetlessConnectionSession: class {
    private listener: ((state: { status: string }) => void) | null = null;
    constructor(
      _profile: unknown,
      private readonly rehydrate: (client: unknown, context: { reconnect: boolean; epoch: number; isCurrent(): boolean }) => Promise<void>,
    ) { controls.rehydrate = rehydrate as typeof controls.rehydrate; }
    subscribe(listener: (state: { status: string }) => void) {
      this.listener = listener;
      controls.emit = listener;
      listener({ status: "unpaired" });
      return () => { this.listener = null; };
    }
    async start() {
      this.listener?.({ status: "revalidating" });
      await this.rehydrate({
        listMeetings: controls.listMeetings,
        getMeetingTranscript: controls.getMeetingTranscript,
        resolveCitation: controls.resolveCitation,
        deleteMeeting: controls.deleteMeeting,
      }, { reconnect: false, epoch: 1, isCurrent: () => true });
      this.listener?.({ status: "online" });
    }
    async close() { await controls.close(); this.listener?.({ status: "disposed" }); }
  },
}));
vi.mock("../src/companion-storage.js", () => ({
  clearCompanionProfile: controls.clearCompanionProfile,
  loadCompanionProfile: controls.loadCompanionProfile,
  saveCompanionProfile: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" }, SafeAreaView: "SafeAreaView",
  StyleSheet: { create: <T,>(styles: T) => styles }, useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("../src/playback.js", () => ({ playCitationAudio: vi.fn(async () => ({ stop: vi.fn() })) }));
vi.mock("@meetless/meeting-surface", () => ({
  MeetingListSurface: (props: Record<string, unknown>) => React.createElement("MeetingListSurface", props),
  RecordingStrip: () => null,
}));
vi.mock("../src/CompanionPairing.js", () => ({
  CompanionPairing: (props: Record<string, unknown>) => React.createElement("CompanionPairing", props),
}));
vi.mock("../src/recording-provider.js", () => ({
  RecordingProvider: ({ children }: { children: React.ReactNode }) => children,
  useRecording: () => ({ enabled: false }),
}));

import { AppContent } from "../src/App.js";

describe("companion host replacement", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    vi.clearAllMocks();
    controls.listMeetings.mockResolvedValue([]);
    controls.getMeetingTranscript.mockClear();
    controls.resolveCitation.mockReset();
    controls.emit = null;
    controls.rehydrate = null;
    controls.deleteMeeting.mockReset();
  });

  test("the visible change-host operation closes the session and removes only the connection profile", async () => {
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
    await vi.waitFor(() => expect(renderer!.root.findAllByType("MeetingListSurface")).toHaveLength(1));
    const surface = renderer!.root.findByType("MeetingListSurface");
    expect(surface.props.onChangeHost).toEqual(expect.any(Function));

    await act(async () => { await surface.props.onChangeHost(); });

    expect(controls.clearCompanionProfile).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalled();
    expect(renderer!.root.findByType("CompanionPairing")).toBeTruthy();
  });

  test("a list RPC from an invalidated connection epoch cannot commit stale UI state", async () => {
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
    await vi.waitFor(() => expect(renderer!.root.findAllByType("MeetingListSurface")).toHaveLength(1));
    const pending = deferred<Array<{ id: string }>>();
    controls.listMeetings.mockImplementationOnce(() => pending.promise);
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    let refresh!: Promise<void>;
    await act(async () => { refresh = surface().props.onRefresh(); });
    await act(async () => { controls.emit?.({ status: "offline" }); });
    await act(async () => { pending.resolve([{ id: "stale-meeting" }]); await refresh; });

    expect(surface().props.hostConnectionStatus).toBe("offline");
    expect(surface().props.meetings).toEqual([]);
  });

  test("connection replacement resets delete state and ignores the stale delete response", async () => {
    const oldMeeting = {
      id: "m-1", title: "Old", status: "ready", createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z",
    };
    const newMeeting = { ...oldMeeting, id: "m-new", title: "New" };
    controls.listMeetings.mockResolvedValue([oldMeeting]);
    controls.deleteMeeting.mockRejectedValueOnce(new Error("old connection failed"));
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
    await vi.waitFor(() => expect(renderer!.root.findAllByType("MeetingListSurface")).toHaveLength(1));
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { surface().props.onRequestDeleteMeeting("m-1"); });
    await act(async () => { await surface().props.onConfirmDeleteMeeting(); });
    expect(surface().props.deleteError).toBe("We could not delete this meeting. It is still in your library.");

    const staleDeletion = deferred<{ meetingId: string; outcome: "deleted"; reason: null }>();
    const staleClient = {
      listMeetings: async () => [oldMeeting], getMeetingTranscript: controls.getMeetingTranscript,
      resolveCitation: controls.resolveCitation, deleteMeeting: vi.fn(() => staleDeletion.promise),
    };
    await act(async () => {
      await controls.rehydrate?.(staleClient, { reconnect: true, epoch: 2, isCurrent: () => true });
    });
    expect(surface().props.deleteError).toBeNull();
    await act(async () => { surface().props.onRequestDeleteMeeting("m-1"); });
    let staleRequest!: Promise<void>;
    await act(async () => { staleRequest = surface().props.onConfirmDeleteMeeting(); });
    expect(surface().props.deletePending).toBe(true);
    expect(surface().props.deleteConfirmationMeetingId).toBe("m-1");

    const currentClient = {
      listMeetings: vi.fn(async () => [newMeeting]), getMeetingTranscript: controls.getMeetingTranscript,
      resolveCitation: controls.resolveCitation, deleteMeeting: vi.fn(),
    };
    await act(async () => {
      await controls.rehydrate?.(currentClient, { reconnect: true, epoch: 3, isCurrent: () => true });
    });
    expect(surface().props.deletePending).toBe(false);
    expect(surface().props.deleteConfirmationMeetingId).toBeNull();
    expect(surface().props.deleteError).toBeNull();
    expect(surface().props.meetings.map((meeting: { id: string }) => meeting.id)).toEqual(["m-new"]);

    await act(async () => {
      staleDeletion.resolve({ meetingId: "m-1", outcome: "deleted", reason: null });
      await staleRequest;
    });
    expect(surface().props.meetings.map((meeting: { id: string }) => meeting.id)).toEqual(["m-new"]);
    expect(currentClient.listMeetings).toHaveBeenCalledOnce();
  });

  test("connection loss settles visible citation evidence and ignores a late citation result", async () => {
    const pendingCitation = deferred<{
      meetingId: string;
      recordingId: string;
      segmentId: string;
      startMs: number;
      endMs: number;
      text: string;
      audio: { mimeType: "audio/mpeg"; base64: string };
    }>();
    controls.resolveCitation.mockImplementation(() => pendingCitation.promise);
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
    await vi.waitFor(() => expect(renderer!.root.findAllByType("MeetingListSurface")).toHaveLength(1));
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    let citationRequest!: Promise<void>;
    await act(async () => {
      citationRequest = surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-1" });
      await Promise.resolve();
    });
    expect(surface().props.citationEvidence).toMatchObject({ status: "resolving" });

    await act(async () => { controls.emit?.({ status: "offline" }); });
    expect(surface().props.citationEvidence).toMatchObject({
      status: "failed",
      error: "Host connection lost. Try again.",
    });
    pendingCitation.resolve({
      meetingId: "m-1", recordingId: "r-1", segmentId: "segment-1", startMs: 0, endMs: 1_000,
      text: "stale", audio: { mimeType: "audio/mpeg", base64: "AQID" },
    });
    await act(async () => { await citationRequest; });
    expect(surface().props.citationEvidence).toMatchObject({ status: "failed" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
