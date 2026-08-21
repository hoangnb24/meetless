import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";

const controls = vi.hoisted(() => ({
  clearCompanionProfile: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  emit: null as null | ((state: { status: string }) => void),
  listMeetings: vi.fn(async () => [] as Array<{ id: string }>),
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
    ) {}
    subscribe(listener: (state: { status: string }) => void) {
      this.listener = listener;
      controls.emit = listener;
      listener({ status: "unpaired" });
      return () => { this.listener = null; };
    }
    async start() {
      this.listener?.({ status: "revalidating" });
      await this.rehydrate({ listMeetings: controls.listMeetings }, { reconnect: false, epoch: 1, isCurrent: () => true });
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
    controls.emit = null;
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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
