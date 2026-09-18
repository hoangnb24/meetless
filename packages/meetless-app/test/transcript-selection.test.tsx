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
  Platform: { OS: "web" }, SafeAreaView: "SafeAreaView", View: "View", Text: "Text", Pressable: "Pressable",
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

import { AppContent, loadCompanionRestoration, retainPremiumCatalog, selectionForChatControls } from "../src/App.js";

const TRANSCRIPTION_FAILURE_MESSAGE = "Transcription could not be completed. Your saved audio remains safe. Retry transcription when you are ready.";

async function confirmAsk(renderer: ReactTestRenderer, question: string): Promise<void> {
  let pending!: Promise<void>;
  await act(async () => { pending = renderer.root.findByType("MeetingListSurface").props.onAskQuestion(question); });
  await act(async () => {
    renderer.root.findByProps({ accessibilityLabel: "Confirm and send to OpenAI" }).props.onPress();
    await pending;
  });
}

test("does not expose a stale Ask selection after host controls report it unavailable", () => {
  const selection = {
    provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: {},
  } as const;
  const controls = {
    version: 1 as const,
    catalog: { providers: [] }, profiles: [], catalogError: null,
    lastSelection: selection, lastSelectionState: "unavailable" as const,
    lastSelectionError: { kind: "unavailable" as const, message: "Provider unavailable" },
  };
  expect(selectionForChatControls(controls)).toBeNull();
  expect(selectionForChatControls({ ...controls, lastSelectionState: "repair_required", lastSelectionError: { kind: "update_required", message: "Repair required" } })).toBeNull();
  expect(selectionForChatControls({ ...controls, lastSelectionState: "available", lastSelectionError: null })).toEqual(selection);
});

describe("transcript meeting selection ordering", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    recordingState.current = { enabled: false };
    vi.clearAllMocks();
  });

  test("provider chooser polls beyond 60 seconds and a reconnected view recovers without resubmission", async () => {
    vi.useFakeTimers();
    try {
      const initial = { outcome: "status", providers: [{ id: "codex", status: "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };
      let outcome = "status";
      const getProviderAccess = vi.fn(async () => ({ ...initial, outcome }));
      const requestProviderAccess = vi.fn(async () => { outcome = "pending"; return { ...initial, outcome }; });
      connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [], getProviderAccess, requestProviderAccess }, close: async () => undefined, serverInfo: null });
      await act(async () => { renderer = create(<AppContent mode="desktop" />); });
      const access = () => renderer!.root.findByType("MeetingListSurface").props.providerAccessNotice.props;
      await act(async () => access().onRequest("codex"));
      expect(access().pending).toBe(true);
      expect(access().result.outcome).toBe("pending");
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      expect(access().pending).toBe(true);
      expect(requestProviderAccess).toHaveBeenCalledTimes(1);
      await act(async () => renderer!.unmount());
      await act(async () => { renderer = create(<AppContent mode="desktop" />); });
      expect(access().pending).toBe(true);
      outcome = "cancelled";
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(access().pending).toBe(false);
      expect(access().result.outcome).toBe("cancelled");
      expect(requestProviderAccess).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  test.each([
    ["purchase_required", "inactive"],
    ["recovery_required", "unavailable"],
  ] as const)("replaces stale active Premium after an authoritative %s gate without losing context", async (outcome, expectedStatus) => {
    const access = { entitlement: "premium" as const, status: "active" as const, packages: [{ packageId: "monthly" as const, productId: "premium.monthly", localizedPrice: "$9.99", trialEligible: false }], reason: null };
    const detail = { ...transcriptResponse("m-1", "segment-m-1", "unused"), transcript: null, transcription: { outcome: "not_started", retryEligible: true, failureCategory: null, message: null } };
    const grantTranscriptionConsent = vi.fn(async () => ({ consent: detail.consent, route: "managed", outcome, retryEligible: false, failureCategory: "access", message: "Premium needs attention", transcript: null }));
    const purchasePremium = vi.fn();
    const restorePremium = vi.fn();
    const getPremiumAccess = vi.fn(async () => access);
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1")], getMeetingTranscript: async () => detail, getPremiumAccess, grantTranscriptionConsent, purchasePremium, restorePremium }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess.status).toBe("active"));
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onGrantTranscriptionConsent(); });
    expect(surface().props.premiumAccess).toEqual({ ...access, status: expectedStatus });
    expect(surface().props.selectedMeetingId).toBe("m-1");
    expect(surface().props.selectedRecording.status).toBe("saved");
    expect(surface().props.transcriptionRouteOutcome).toBe(outcome);
    expect(grantTranscriptionConsent).toHaveBeenCalledOnce();
    expect(getPremiumAccess).toHaveBeenCalledOnce();
    expect(purchasePremium).not.toHaveBeenCalled();
    expect(restorePremium).not.toHaveBeenCalled();
  });

  test.each(["before", "after"] as const)("preserves a newer Premium success when purchase starts %s the pending transcription gate", async (purchaseOrder) => {
    const access = { entitlement: "premium" as const, status: "active" as const, packages: [], reason: null };
    const detail = { ...transcriptResponse("m-1", "segment-m-1", "unused"), transcript: null, transcription: { outcome: "not_started", retryEligible: true, failureCategory: null, message: null } };
    const gate = deferred<{ consent: typeof detail.consent; route: "managed"; outcome: "purchase_required"; retryEligible: false; failureCategory: "access"; message: string; transcript: null }>();
    const purchase = deferred<{ outcome: "active"; access: typeof access }>();
    const grantTranscriptionConsent = vi.fn(() => gate.promise);
    const purchasePremium = vi.fn(() => purchase.promise);
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1")], getMeetingTranscript: async () => detail, getPremiumAccess: async () => access, grantTranscriptionConsent, purchasePremium }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess.status).toBe("active"));
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    let purchaseRequest!: Promise<void>;
    let gateRequest!: Promise<void>;
    if (purchaseOrder === "before") await act(async () => { purchaseRequest = surface().props.onPurchasePremium("monthly"); });
    await act(async () => { gateRequest = surface().props.onGrantTranscriptionConsent(); });
    if (purchaseOrder === "after") await act(async () => { purchaseRequest = surface().props.onPurchasePremium("monthly"); });
    await act(async () => { purchase.resolve({ outcome: "active", access }); await purchaseRequest; });
    await act(async () => { gate.resolve({ consent: detail.consent, route: "managed", outcome: "purchase_required", retryEligible: false, failureCategory: "access", message: "Premium needs attention", transcript: null }); await gateRequest; });
    expect(surface().props.premiumAccess).toEqual(access);
    expect(surface().props.selectedMeetingId).toBe("m-1");
    expect(purchasePremium).toHaveBeenCalledOnce();
    expect(grantTranscriptionConsent).toHaveBeenCalledOnce();
  });

  test("dispatches Premium purchase progress immediately and ignores repeated purchase or restore actions", async () => {
    const inactivePremium = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [{
        packageId: "monthly" as const,
        productId: "com.meetless.app.premium.monthly",
        localizedPrice: "$9.99",
        trialEligible: true,
      }],
      reason: null,
    };
    const purchaseCompletion = deferred<{ outcome: "cancelled"; access: typeof inactivePremium }>();
    const purchasePremium = vi.fn(() => purchaseCompletion.promise);
    const restorePremium = vi.fn(async () => ({ outcome: "active" as const, access: inactivePremium }));
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [],
        getPremiumAccess: async () => inactivePremium,
        purchasePremium,
        restorePremium,
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(inactivePremium));

    let firstPurchase!: Promise<void>;
    await act(async () => { firstPurchase = surface().props.onPurchasePremium("monthly"); });
    expect(surface().props.premiumPending).toBe(true);
    expect(surface().props.premiumPendingAction).toBe("purchase");

    await act(async () => {
      await surface().props.onPurchasePremium("annual");
      await surface().props.onRestorePremium();
    });
    expect(purchasePremium).toHaveBeenCalledOnce();
    expect(purchasePremium).toHaveBeenCalledWith("monthly", expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(restorePremium).not.toHaveBeenCalled();

    purchaseCompletion.resolve({ outcome: "cancelled", access: inactivePremium });
    await act(async () => { await firstPurchase; });
    expect(surface().props.premiumPending).toBe(false);
    expect(surface().props.premiumPendingAction).toBeNull();
  });

  test.each([
    { outcome: "active", route: "poll", action: "purchase" },
    { outcome: "cancelled", route: "poll", action: "purchase" },
    { outcome: "failed", route: "poll", action: "purchase" },
    { outcome: "active", route: "direct", action: "purchase" },
    { outcome: "active", route: "pending", action: "purchase" },
    { outcome: "active", route: "poll", action: "restore" },
    { outcome: "active", route: "unknown", action: "purchase" },
  ] as const)("keeps the UUID pending beyond 30s and automatically applies late $outcome via $route for $action", async ({ outcome, route, action }) => {
    const inactivePremium = { entitlement: "premium" as const, status: "inactive" as const, packages: [], reason: null };
    const terminalAccess = { ...inactivePremium, status: outcome === "active" ? "active" as const : "inactive" as const };
    const delayedResult = deferred<{ outcome: typeof outcome; access: typeof terminalAccess }>();
    const purchaseDeadline = deferred<{ outcome: typeof outcome; access: typeof terminalAccess }>();
    const blockedPoll = deferred<never>();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const getPremiumAccess = vi.fn(async () => inactivePremium);
      const mutation = () => route === "pending" ? Promise.resolve({ outcome: "pending", access: inactivePremium }) : route === "unknown" ? Promise.reject(new Error("transport interrupted")) : purchaseDeadline.promise;
      const purchasePremium = vi.fn(mutation);
      const restorePremium = vi.fn(mutation);
      const getPremiumOperation = vi.fn(() => route === "direct" ? blockedPoll.promise : delayedResult.promise);
      if (route === "unknown") getPremiumOperation.mockResolvedValueOnce(null as never);
      const transcribeMeeting = vi.fn();
      const grantTranscriptionConsent = vi.fn();
      connectMeetlessClient.mockResolvedValue({
        client: { listMeetings: async () => [], getPremiumAccess, purchasePremium, restorePremium, getPremiumOperation, transcribeMeeting, grantTranscriptionConsent },
        close: async () => undefined, serverInfo: null,
      });
      await act(async () => { renderer = create(<AppContent mode="desktop" />); });
      const surface = () => renderer!.root.findByType("MeetingListSurface");
      await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(inactivePremium));
      vi.useFakeTimers();
      let purchaseRequest!: Promise<void>;
      await act(async () => { purchaseRequest = action === "purchase" ? surface().props.onPurchasePremium("monthly") : surface().props.onRestorePremium(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(surface().props.premiumPending).toBe(true);
      expect(surface().props.premiumPendingAction).toBe(action);
      expect(surface().props.premiumError).toBeNull();
      await act(async () => { await surface().props.onPurchasePremium("monthly"); await surface().props.onRestorePremium(); });
      const dispatched = action === "purchase" ? purchasePremium : restorePremium;
      expect(dispatched).toHaveBeenCalledOnce();
      expect(action === "purchase" ? restorePremium : purchasePremium).not.toHaveBeenCalled();
      const operationId = dispatched.mock.calls[0]![action === "purchase" ? 1 : 0];
      expect(getPremiumOperation).toHaveBeenCalledWith(operationId);
      expect(info.mock.calls.map(([line]) => line).join(" ")).not.toContain('"stage":"ui_completion"');
      await act(async () => { (route === "direct" ? purchaseDeadline : delayedResult).resolve({ outcome, access: terminalAccess }); await purchaseRequest; });
      expect(surface().props.premiumPending).toBe(false);
      expect(surface().props.premiumAccess).toEqual(terminalAccess);
      expect(surface().props.premiumError).toBe(outcome === "failed" ? "Purchase could not complete. Try again." : null);
      expect(getPremiumAccess).toHaveBeenCalledOnce();
      expect(transcribeMeeting).not.toHaveBeenCalled();
      expect(grantTranscriptionConsent).not.toHaveBeenCalled();
      const completions = info.mock.calls.map(([line]) => line).filter((line) => line.includes('"stage":"ui_completion"'));
      expect(completions).toHaveLength(1);
      expect(JSON.parse(completions[0].replace("[meetless-premium] ", ""))).toMatchObject({ stage: "ui_completion", outcome, operationId });
    } finally { vi.useRealTimers(); info.mockRestore(); }
  });

  test("applies current inactive Premium access after an active mutation", async () => {
    const inactivePremium = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [],
      reason: null,
    };
    const activePremium = { ...inactivePremium, status: "active" as const };
    const getPremiumAccess = vi.fn()
      .mockResolvedValueOnce(inactivePremium)
      .mockResolvedValue(inactivePremium);
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [],
        getPremiumAccess,
        purchasePremium: vi.fn(async () => ({ outcome: "active" as const, access: activePremium })),
        restorePremium: vi.fn(async () => ({ outcome: "failed" as const, access: inactivePremium })),
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(inactivePremium));

    await act(async () => { await surface().props.onPurchasePremium("monthly"); });
    expect(surface().props.premiumAccess).toEqual(activePremium);
    expect(getPremiumAccess).toHaveBeenCalledOnce();

    await act(async () => { await surface().props.onRefreshPremium(); });
    expect(getPremiumAccess).toHaveBeenCalledTimes(2);
    expect(surface().props.premiumAccess).toEqual(inactivePremium);
    expect(surface().props.premiumError).toBeNull();
  });

  test("retains a prior catalog only for an unavailable empty response", () => {
    const catalog = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [
        { packageId: "monthly" as const, productId: "com.meetless.app.premium.monthly", localizedPrice: "$9.99", trialEligible: false },
        { packageId: "annual" as const, productId: "com.meetless.app.premium.annual", localizedPrice: "$89.99", trialEligible: false },
      ],
      reason: null,
    };
    const unavailable = { ...catalog, status: "unavailable" as const, packages: [], reason: "store_unavailable" as const };
    expect(retainPremiumCatalog(unavailable, catalog)).toEqual({ ...unavailable, packages: catalog.packages });
    expect(retainPremiumCatalog({ ...catalog, status: "active" as const, packages: [] }, catalog)).toEqual({ ...catalog, status: "active", packages: [] });
    const latestMonthly = { ...catalog.packages[0], localizedPrice: "$10.99" };
    expect(retainPremiumCatalog({ ...unavailable, packages: [latestMonthly] }, catalog)).toEqual({
      ...unavailable,
      packages: [latestMonthly, catalog.packages[1]],
    });
    const pendingMonthly = { ...catalog, status: "inactive" as const, packages: [latestMonthly] };
    expect(retainPremiumCatalog(pendingMonthly, catalog, { preserveDuringPending: true })).toEqual({
      ...pendingMonthly,
      packages: [latestMonthly, catalog.packages[1]],
    });
    expect(retainPremiumCatalog(pendingMonthly, catalog)).toBe(pendingMonthly);
    expect(retainPremiumCatalog({ ...unavailable, packages: [catalog.packages[0], catalog.packages[0]] }, catalog)).toEqual({
      ...unavailable,
      packages: catalog.packages,
    });
    expect(retainPremiumCatalog(
      { ...unavailable, packages: [latestMonthly] },
      { ...unavailable, packages: catalog.packages },
    )).toEqual({ ...unavailable, packages: [latestMonthly, catalog.packages[1]] });
    expect(retainPremiumCatalog(unavailable, { ...catalog, packages: [] })).toEqual(unavailable);
  });

  test.each(["pending", "failed"] as const)("retains both Premium plans after a %s partial purchase response", async (outcome) => {
    const catalog = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [
        { packageId: "monthly" as const, productId: "com.meetless.app.premium.monthly", localizedPrice: "$9.99", trialEligible: true },
        { packageId: "annual" as const, productId: "com.meetless.app.premium.annual", localizedPrice: "$89.99", trialEligible: false },
      ],
      reason: null,
    };
    const partial = { ...catalog, packages: [catalog.packages[0]] };
    const unavailable = { ...catalog, status: "unavailable" as const, packages: [], reason: "store_unavailable" as const };
    const getPremiumAccess = vi.fn()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValue(unavailable);
    const purchasePremium = vi.fn(async () => ({ outcome, access: partial }));
    connectMeetlessClient.mockResolvedValue({
      client: { listMeetings: async () => [], getPremiumAccess, purchasePremium, getPremiumOperation: vi.fn(async () => ({ outcome: "failed", access: partial })) },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(catalog));

    await act(async () => { await surface().props.onPurchasePremium("monthly"); });
    expect(purchasePremium).toHaveBeenCalledWith("monthly", expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(surface().props.premiumAccess.status).toBe("inactive");
    expect(surface().props.premiumAccess.packages.map((item: { packageId: string }) => item.packageId)).toEqual(["monthly", "annual"]);
    expect(surface().props.premiumAccess.status).not.toBe("active");
    expect(surface().props.onRefreshPremium).toBeTypeOf("function");
    expect(surface().props.onPurchasePremium).toBeTypeOf("function");
    expect(surface().props.premiumError).toBe("Purchase could not complete. Try again.");
  });

  test("preserves monthly and annual plans when refresh reports unavailable", async () => {
    const available = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [
        { packageId: "monthly" as const, productId: "com.meetless.app.premium.monthly", localizedPrice: "$9.99", trialEligible: true },
        { packageId: "annual" as const, productId: "com.meetless.app.premium.annual", localizedPrice: "$89.99", trialEligible: false },
      ],
      reason: null,
    };
    const unavailable = { ...available, status: "unavailable" as const, packages: [], reason: "store_unavailable" as const };
    const partialUnavailable = { ...unavailable, packages: [available.packages[0]] };
    const getPremiumAccess = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(partialUnavailable);
    connectMeetlessClient.mockResolvedValue({
      client: { listMeetings: async () => [], getPremiumAccess },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(available));

    await act(async () => { await surface().props.onRefreshPremium(); });
    expect(surface().props.premiumAccess).toEqual({ ...unavailable, packages: available.packages });
    expect(surface().props.premiumAccess.status).toBe("unavailable");
    expect(surface().props.premiumAccess.reason).toBe("store_unavailable");
    expect(surface().props.premiumError).toBe("Premium plans could not be loaded. Try again.");

    await act(async () => { await surface().props.onRefreshPremium(); });
    expect(surface().props.premiumAccess).toEqual({ ...partialUnavailable, packages: available.packages });
  });

  test("fails closed when explicit Premium refresh fails after active access", async () => {
    const inactivePremium = {
      entitlement: "premium" as const,
      status: "inactive" as const,
      packages: [
        { packageId: "monthly" as const, productId: "com.meetless.app.premium.monthly", localizedPrice: "$9.99", trialEligible: true },
        { packageId: "annual" as const, productId: "com.meetless.app.premium.annual", localizedPrice: "$89.99", trialEligible: false },
      ],
      reason: null,
    };
    const activePremium = { ...inactivePremium, status: "active" as const };
    const getPremiumAccess = vi.fn()
      .mockResolvedValueOnce(inactivePremium)
      .mockRejectedValue(new Error("backend unavailable"));
    connectMeetlessClient.mockResolvedValue({
      client: {
        listMeetings: async () => [],
        getPremiumAccess,
        purchasePremium: vi.fn(async () => ({ outcome: "active" as const, access: activePremium })),
        restorePremium: vi.fn(async () => ({ outcome: "failed" as const, access: inactivePremium })),
      },
      close: async () => undefined,
      serverInfo: null,
    });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(inactivePremium));

    await act(async () => { await surface().props.onPurchasePremium("monthly"); });
    expect(surface().props.premiumAccess).toEqual(activePremium);

    await act(async () => { await surface().props.onRefreshPremium(); });
    expect(surface().props.premiumAccess).toEqual({
      entitlement: "premium",
      status: "unavailable",
      packages: inactivePremium.packages,
      reason: "store_unavailable",
    });
    expect(surface().props.premiumError).toBe("Premium plans could not be loaded. Try again.");
    expect(surface().props.premiumPending).toBe(false);
    expect(surface().props.onRefreshPremium).toBeTypeOf("function");
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

  test.each(["untranscribed", "quota-failed"])("deletes an idle saved %s meeting through confirmation", async (state) => {
    const detail = transcriptResponse("m-1", "segment", "");
    const saved = { ...meeting("m-1"), status: "processing" as const };
    const transcript = state === "untranscribed" ? null : { ...detail.transcript, status: "failed", segments: [],
      quotaFailure: { version: 1, kind: "managed_quota_insufficient", requiredSeconds: 30, remainingSeconds: 0, checkedAt: 1, resetAt: null } };
    recordingState.current = { enabled: true, status: { meetingId: "m-1", status: "saved" }, displayElapsedMs: 1000 };
    let deleted = false;
    const deleteMeeting = vi.fn(async () => { deleted = true; return { meetingId: "m-1", outcome: "deleted", reason: null }; });
    connectMeetlessClient.mockResolvedValue({ client: {
      listMeetings: async () => deleted ? [] : [saved],
      getMeetingTranscript: async () => ({ ...detail, meeting: saved, transcript,
        transcription: { outcome: state === "untranscribed" ? "not_started" : "interrupted", retryEligible: true, failureCategory: null, message: null } }),
      deleteMeeting,
    }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.deleteDisabled).toBe(false);
    await act(async () => { surface().props.onRequestDeleteMeeting("m-1"); });
    expect(surface().props.deleteConfirmationMeetingId).toBe("m-1");
    expect(deleteMeeting).not.toHaveBeenCalled();
    await act(async () => { await surface().props.onConfirmDeleteMeeting(); });
    expect(deleteMeeting).toHaveBeenCalledExactlyOnceWith("m-1");
    expect(surface().props.selectedMeetingId).toBeNull();
    expect(surface().props.transcript).toBeNull();
    expect(surface().props.meetings).toEqual([]);
  });

  test.each(["finalizing", "pending", "transcribing", "ask"])("keeps Delete disabled during %s work even without the broad meeting status guard", async (work) => {
    const detail = transcriptResponse("m-1", "segment", "text");
    recordingState.current = { enabled: true, status: { meetingId: "m-1", status: work === "finalizing" ? "finalizing" : "saved" }, displayElapsedMs: 1000 };
    const deleteMeeting = vi.fn();
    connectMeetlessClient.mockResolvedValue({ client: {
      listMeetings: async () => [detail.meeting],
      getMeetingTranscript: async () => ({ ...detail, transcript: { ...detail.transcript, status: work === "pending" || work === "transcribing" ? work : "ready" } }),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => ({ ...chatResponse(), status: work === "ask" ? "running" : "ready" }),
      deleteMeeting,
    }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.deleteDisabled).toBe(true);
    expect(deleteMeeting).not.toHaveBeenCalled();
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

  test("Retry transcription reuses the idempotent managed route and applies its durable transcript", async () => {
    let transcriptCalls = 0;
    const ready = transcriptResponse("m-1", "segment-m-1", "retried transcript");
    const grantTranscriptionConsent = vi.fn(async (meetingId: string) => ({
      consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
      route: "managed" as const,
      outcome: "completed" as const,
      retryEligible: false, failureCategory: null,
      transcript: ready.transcript,
      message: null,
    }));
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: vi.fn(async () => {
        transcriptCalls += 1;
        const result = transcriptResponse("m-1", "segment-m-1", "retried transcript");
        return transcriptCalls === 1
          ? { ...result, transcription: { outcome: "failed", retryEligible: true, failureCategory: "provider", message: TRANSCRIPTION_FAILURE_MESSAGE }, transcript: { ...result.transcript, status: "failed" as const, failureReason: "provider failed" } }
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
    expect(surface().props.transcriptionRouteMessage).toBe(TRANSCRIPTION_FAILURE_MESSAGE);
    expect(surface().props.onRetryTranscription).toEqual(expect.any(Function));

    await act(async () => { await surface().props.onRetryTranscription(); });
    expect(grantTranscriptionConsent).toHaveBeenCalledOnce();
    expect(grantTranscriptionConsent).toHaveBeenCalledWith("m-1");
    expect(client.getMeetingTranscript).toHaveBeenCalledTimes(1);
    expect(surface().props.transcript).toMatchObject({ status: "ready", meetingId: "m-1" });
  });

  test("polls a started managed route until the durable transcript is ready without native provider status", async () => {
    const ready = transcriptResponse("m-1", "segment-m-1", "managed result");
    const pending = {
      ...ready,
      transcript: { ...ready.transcript, status: "pending" as const },
    };
    const initial = {
      ...ready,
      transcript: null,
      consent: { status: "unknown" as const },
      provider: { status: "missing" as const },
    };
    const getMeetingTranscript = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(ready);
    const nativeProviderStatus = vi.fn();
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getPremiumAccess: async () => ({ entitlement: "premium" as const, status: "active" as const, packages: [], reason: null }),
      getMeetingTranscript,
      grantTranscriptionConsent: vi.fn(async () => ({
        consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
        route: "managed" as const,
        outcome: "started" as const,
        retryEligible: false, failureCategory: null,
        transcript: pending.transcript,
        message: null,
      })),
      getMeetingChat: async () => null,
      listChatProviders: async () => ({ providers: [] }),
      transcriptionProviderStatus: nativeProviderStatus,
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onGrantTranscriptionConsent(); });
    await vi.waitFor(() => expect(surface().props.transcript).toMatchObject({ status: "ready", meetingId: "m-1" }));

    expect(client.grantTranscriptionConsent).toHaveBeenCalledWith("m-1");
    expect(getMeetingTranscript).toHaveBeenCalledTimes(2);
    expect(nativeProviderStatus).not.toHaveBeenCalled();
    expect(surface().props.transcriptionRouteOutcome).toBe("completed");
  });

  test("projects a terminal managed failure returned by polling with safe retry copy", async () => {
    const ready = transcriptResponse("m-1", "segment-m-1", "managed result");
    const pending = {
      ...ready,
      transcript: { ...ready.transcript, status: "pending" as const },
    };
    const failed = {
      ...ready,
      transcript: { ...ready.transcript, status: "failed" as const, failureReason: "provider failed" },
      transcription: { outcome: "failed", retryEligible: true, failureCategory: "provider", message: TRANSCRIPTION_FAILURE_MESSAGE },
    };
    const getMeetingTranscript = vi.fn()
      .mockResolvedValueOnce({
        ...ready,
        transcript: null,
        consent: { status: "unknown" as const },
        provider: { status: "missing" as const },
      })
      .mockResolvedValueOnce(failed);
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript,
      grantTranscriptionConsent: vi.fn(async () => ({
        consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
        route: "managed" as const,
        outcome: "started" as const,
        retryEligible: false, failureCategory: null,
        transcript: pending.transcript,
        message: null,
      })),
      getMeetingChat: async () => null,
      listChatProviders: async () => ({ providers: [] }),
      transcriptionProviderStatus: vi.fn(),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onGrantTranscriptionConsent(); });
    await vi.waitFor(() => expect(surface().props.transcriptionRouteOutcome).toBe("failed"));

    expect(surface().props.transcript).toMatchObject({ status: "failed" });
    expect(surface().props.transcriptionRouteMessage).toBe(TRANSCRIPTION_FAILURE_MESSAGE);
    expect(surface().props.onRetryTranscription).toEqual(expect.any(Function));
  });

  test("stops polling on a connection failure and Check status only reads the existing recording", async () => {
    const ready = transcriptResponse("m-1", "segment-m-1", "recovered result");
    const initial = { ...ready, transcript: null, transcription: { outcome: "not_started", retryEligible: true, failureCategory: null, message: null } };
    const getMeetingTranscript = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("private transport error")).mockResolvedValue(ready);
    const grantTranscriptionConsent = vi.fn(async () => ({ consent: ready.consent, route: "managed", outcome: "started", retryEligible: false, failureCategory: null, message: null, transcript: { ...ready.transcript, status: "pending" } }));
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1")], getMeetingTranscript, grantTranscriptionConsent, getMeetingChat: async () => null, listChatProviders: async () => ({ providers: [] }) }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onGrantTranscriptionConsent(); });
    await vi.waitFor(() => expect(surface().props.transcriptionRouteOutcome).toBe("interrupted"));
    expect(surface().props.transcriptionFailureCategory).toBe("connection");
    expect(surface().props.transcriptionRouteMessage).not.toContain("private");
    vi.useFakeTimers();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(getMeetingTranscript).toHaveBeenCalledTimes(2);
      await act(async () => { await surface().props.onCheckTranscriptionStatus(); });
      expect(surface().props.transcript.status).toBe("ready");
      expect(getMeetingTranscript).toHaveBeenCalledTimes(3);
      expect(grantTranscriptionConsent).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  test("old consent and a dormant pending transcript never dispatch or poll automatically", async () => {
    const ready = transcriptResponse("m-1", "segment-m-1", "existing");
    const getMeetingTranscript = vi.fn(async () => ({ ...ready, transcript: { ...ready.transcript, status: "pending" }, transcription: { outcome: "interrupted", retryEligible: true, failureCategory: null, message: "Choose Transcribe to continue existing work." } }));
    const grantTranscriptionConsent = vi.fn();
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1")], getMeetingTranscript, grantTranscriptionConsent }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    vi.useFakeTimers();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(surface().props.transcriptionRouteOutcome).toBe("interrupted");
      expect(getMeetingTranscript).toHaveBeenCalledOnce();
      expect(grantTranscriptionConsent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  test("refreshes the selected recording after Save without granting consent or submitting audio", async () => {
    const ready = transcriptResponse("m-1", "segment-m-1", "unused");
    const detail = (status: "recording" | "saved") => ({ ...ready, recording: { recordingId: "r-1", status }, transcript: null, transcription: { outcome: status === "saved" ? "not_started" : "not_saved", retryEligible: status === "saved", failureCategory: status === "saved" ? null : "not_saved", message: null } });
    const getMeetingTranscript = vi.fn().mockResolvedValueOnce(detail("recording")).mockResolvedValue(detail("saved"));
    const grantTranscriptionConsent = vi.fn();
    recordingState.current = { enabled: true, status: { recordingId: "r-1", meetingId: "m-1", status: "recording" }, pending: false };
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1")], getMeetingTranscript, grantTranscriptionConsent }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    expect(surface().props.selectedRecording.status).toBe("recording");
    recordingState.current = { ...recordingState.current, status: { recordingId: "r-1", meetingId: "m-1", status: "saved" } };
    await act(async () => { renderer!.update(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(surface().props.selectedRecording.status).toBe("saved"));
    expect(surface().props.transcriptionRouteOutcome).toBe("not_started");
    expect(getMeetingTranscript).toHaveBeenCalledTimes(2);
    expect(grantTranscriptionConsent).not.toHaveBeenCalled();
  });

  test("a stale selected-meeting action cannot dispatch after switching to another recording", async () => {
    const getMeetingTranscript = vi.fn(async (meetingId: string) => ({ ...transcriptResponse(meetingId, `segment-${meetingId}`, "existing"), transcript: null, transcription: { outcome: "not_started", retryEligible: true, failureCategory: null, message: null } }));
    const grantTranscriptionConsent = vi.fn();
    connectMeetlessClient.mockResolvedValue({ client: { listMeetings: async () => [meeting("m-1"), meeting("m-2")], getMeetingTranscript, grantTranscriptionConsent }, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    const staleAction = surface().props.onGrantTranscriptionConsent;
    await act(async () => { await surface().props.onOpenTranscript("m-2"); });
    await act(async () => { await staleAction(); });
    expect(grantTranscriptionConsent).not.toHaveBeenCalled();
    expect(surface().props.selectedMeetingId).toBe("m-2");
  });

  test("ignores a duplicate Allow click while the managed route request is pending", async () => {
    const routeCompletion = deferred<{
      consent: { status: "granted" };
      route: "managed";
      outcome: "completed";
      transcript: ReturnType<typeof transcriptResponse>["transcript"];
      message: null;
    }>();
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => ({
        ...transcriptResponse("m-1", "segment-m-1", "existing"),
        transcript: null,
        consent: { status: "unknown" as const },
        provider: { status: "missing" as const },
      }),
      grantTranscriptionConsent: vi.fn(() => routeCompletion.promise),
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });

    let first!: Promise<void>;
    await act(async () => {
      first = surface().props.onGrantTranscriptionConsent();
      await Promise.resolve();
      await surface().props.onGrantTranscriptionConsent();
    });
    expect(surface().props.transcriptionConsentPending).toBe(true);
    expect(client.grantTranscriptionConsent).toHaveBeenCalledOnce();
    routeCompletion.resolve({
      consent: { status: "granted" },
      route: "managed",
      outcome: "completed",
      transcript: transcriptResponse("m-1", "segment-m-1", "complete").transcript,
      message: null,
    });
    await act(async () => { await first; });
    expect(surface().props.transcriptionConsentPending).toBe(false);
    expect(surface().props.transcriptionRouteOutcome).toBe("completed");
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
    await confirmAsk(renderer!, "What did we decide?");
    expect(askMeetingQuestionWithSelection).toHaveBeenCalledWith({
      meetingId: "m-1", question: "What did we decide?", selection, consent: true,
    });

    await act(async () => { await surface().props.onOpenTranscript("m-2"); });
    expect(surface().props.chatSelection).toEqual(selection);
    await confirmAsk(renderer!, "What did we decide next?");
    expect(askMeetingQuestionWithSelection).toHaveBeenLastCalledWith({
      meetingId: "m-2", question: "What did we decide next?", selection, consent: true,
    });
  });

  test("retains a successfully applied ready-catalog model and forwards it to Ask", async () => {
    const selection = {
      provider: "codex", model: "gpt-5-mini", modeId: "worker", thinkingOptionId: "high",
      featureValues: {},
    };
    const controls = {
      version: 1 as const,
      catalog: {
        providers: [{
          id: "codex", label: "Codex", status: "ready" as const,
          models: [
            { id: "gpt-5", label: "GPT-5", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" },
            { id: "gpt-5-mini", label: "GPT-5 mini", isDefault: false, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" },
          ],
          modes: [{ id: "worker", label: "Worker" }], defaultModeId: "worker", error: null,
        }],
      },
      profiles: [], catalogError: null, lastSelection: null,
      lastSelectionState: "available" as const, lastSelectionError: null,
    };
    const applyChatSelection = vi.fn(async (asked: typeof selection) => asked);
    const askMeetingQuestionWithSelection = vi.fn(async ({ meetingId, question, selection: asked }: {
      meetingId: string;
      question: string;
      selection: typeof selection;
    }) => ({
      ...chatResponse(), meetingId, status: "running" as const,
      selection: { provider: asked.provider, model: asked.model },
      messages: [{ role: "user" as const, text: question, createdAt: "2026-08-21T00:00:00.000Z" }],
    }));
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getChatControls: vi.fn(async () => controls),
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      getMeetingChat: async () => chatResponse(),
      discoverChatFeatures: async (asked: typeof selection) => featureResponse(asked),
      applyChatSelection,
      askMeetingQuestionWithSelection,
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onChatSelectionBundle(selection); });
    expect(applyChatSelection).toHaveBeenCalledWith(selection);
    expect(surface().props.chatSelection).toEqual(selection);

    await confirmAsk(renderer!, "What changed?");
    expect(askMeetingQuestionWithSelection).toHaveBeenCalledWith({
      meetingId: "m-1", question: "What changed?", selection, consent: true,
    });
  });

  test("does not implicitly refresh Premium after an Ask entitlement error", async () => {
    const activePremium = {
      entitlement: "premium" as const,
      status: "active" as const,
      packages: [],
      reason: null,
    };
    const inactivePremium = { ...activePremium, status: "inactive" as const };
    const selection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: {},
    };
    const controls = {
      version: 1 as const,
      catalog: { providers: [] }, profiles: [], catalogError: null,
      lastSelection: selection, lastSelectionState: "available" as const, lastSelectionError: null,
    };
    const getPremiumAccess = vi.fn()
      .mockResolvedValueOnce(activePremium)
      .mockResolvedValue(inactivePremium);
    const askMeetingQuestionWithSelection = vi.fn(async () => {
      throw new Error("Premium access required");
    });
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getPremiumAccess,
      getChatControls: vi.fn(async () => controls),
      getMeetingTranscript: async () => transcriptResponse("m-1", "segment-m-1", "current citation"),
      getMeetingChat: async () => chatResponse(),
      discoverChatFeatures: async (asked: typeof selection) => featureResponse(asked),
      askMeetingQuestionWithSelection,
    };
    connectMeetlessClient.mockResolvedValue({ client, close: async () => undefined, serverInfo: null });
    await act(async () => { renderer = create(<AppContent mode="desktop" />); });
    await vi.waitFor(() => expect(connectMeetlessClient).toHaveBeenCalledOnce());
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await vi.waitFor(() => expect(surface().props.premiumAccess).toEqual(activePremium));
    expect(getPremiumAccess).toHaveBeenCalledOnce();

    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    let askError: unknown;
    try {
      await confirmAsk(renderer!, "Transcribe this meeting");
    } catch (reason) {
      askError = reason;
    }
    await act(async () => { await Promise.resolve(); });

    expect(askError).toEqual(new Error("Premium access required"));
    expect(askMeetingQuestionWithSelection).toHaveBeenCalledWith({
      meetingId: "m-1", question: "Transcribe this meeting", selection, consent: true,
    });
    expect(getPremiumAccess).toHaveBeenCalledOnce();
    expect(surface().props.premiumAccess).toEqual(activePremium);
    expect(surface().props.chatError).toBe("Premium access required");
    expect(surface().props.chatLoading).toBe(false);
    expect(surface().props.onRefreshPremium).toBeTypeOf("function");
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

  test("a clip completed during startup is not overwritten with Playing", async () => {
    const handle = { stop: vi.fn() };
    playCitationAudio.mockImplementation(async (_citation, _factory, _native, options) => {
      options.onComplete();
      return handle;
    });
    await renderConnected(async ({ meetingId, segmentId }: { meetingId: string; segmentId: string }) => citationResponse(meetingId, segmentId));
    const surface = () => renderer!.root.findByType("MeetingListSurface");
    await act(async () => { await surface().props.onOpenTranscript("m-1"); });
    await act(async () => { await surface().props.onCitation({ meetingId: "m-1", segmentId: "segment-short" }); });
    expect(surface().props.citationEvidence.status).toBe("completed");
    expect(handle.stop).toHaveBeenCalledOnce();
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

  test("preserves terminal transcription failure copy when restoring a selected meeting", async () => {
    const client = {
      listMeetings: async () => [meeting("m-1")],
      getMeetingTranscript: async () => ({
        meeting: meeting("m-1"),
        transcript: { status: "failed" as const },
        consent: { status: "granted" as const, grantedAt: "2026-08-18T10:00:00.000Z" },
        provider: { status: "configured" as const },
      }),
      listChatProviders: async () => ({ providers: [] }),
      getMeetingChat: async () => null,
    } as unknown as MeetlessClient;

    await expect(loadCompanionRestoration(client, "m-1")).resolves.toMatchObject({
      detail: { transcript: { status: "failed" } },
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
    recording: { recordingId: `recording-${meetingId}`, status: "saved" as const },
    transcription: { outcome: "completed" as const, retryEligible: false, failureCategory: null, message: null },
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
