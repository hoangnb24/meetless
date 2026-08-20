import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";

const { connectMeetlessClient, playCitationAudio } = vi.hoisted(() => ({
  connectMeetlessClient: vi.fn(),
  playCitationAudio: vi.fn(),
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
  useRecording: () => ({ enabled: false }),
}));

import { AppContent } from "../src/App.js";

describe("transcript meeting selection ordering", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
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
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
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
    await act(async () => { renderer = create(<AppContent mode="companion" />); });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
