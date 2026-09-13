import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, SafeAreaView, StyleSheet, useWindowDimensions, View, Text, Pressable } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  connectMeetlessClient,
  MeetlessConnectionSession,
  type CompanionConnectionState,
  type CompanionProfile,
  type MeetlessClient,
} from "@meetless/client";
import {
  chatSelectionIdentity,
  type ProviderAccessResult,
  type ProviderAccessId,
  type ChatControlsWire,
  type ChatFeatureDiscoveryWire,
  type ChatProviderWire,
  type ChatSelectionWire,
  type MeetingChatThreadWire,
  type MeetingWire,
  type ManagedDeviceWire,
  type PremiumAccessWire,
  type PremiumMutationResultWire,
} from "@meetless/meeting-contracts";
import type {
  CitationWire,
  TranscriptWire,
  TranscriptionProviderStatusWire,
  TranscriptionRouteOutcomeWire,
  SelectedRecordingWire,
  TranscriptionFailureCategoryWire,
} from "@meetless/meeting-contracts";
import { MeetingListSurface, RecordingStrip, type CitationEvidenceState, type LayoutTier } from "@meetless/meeting-surface";
import { resolveAppMode, resolveDaemonUrl, supportsDesktopRecording } from "./runtime";
import { RecordingProvider, useRecording } from "./recording-provider";
import { playCitationAudio, type CitationPlaybackHandle } from "./playback";
import { CompanionPairing } from "./CompanionPairing";
import { clearCompanionProfile, loadCompanionProfile, saveCompanionProfile } from "./companion-storage";

interface ActiveConnection {
  client: MeetlessClient;
  epoch: number;
  close?(): Promise<void>;
}

type PremiumPendingAction = "refresh" | "purchase" | "restore";
type PremiumDiagnosticStage = "ui_dispatch" | "ui_completion";
type PremiumDiagnosticOutcome = "started" | "active" | "cancelled" | "pending" | "failed";

function logPremiumDiagnostic(stage: PremiumDiagnosticStage, outcome: PremiumDiagnosticOutcome, operationId?: string): void {
  if (typeof console === "undefined") return;
  console.info(`[meetless-premium] ${JSON.stringify({ stage, outcome, ...(operationId ? { operationId } : {}), timestampMs: Date.now() })}`);
}

export const PREMIUM_UI_PENDING_TIMEOUT_MS = 30_000;
const PREMIUM_STATUS_POLL_INTERVAL_MS = 250;
const TRANSCRIPTION_STATUS_POLL_INTERVAL_MS = 500;

type PremiumRpcResult<T> = { timedOut: false; value: T } | { timedOut: true };

function premiumRpcWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<PremiumRpcResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

function waitForPremiumStatusPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PREMIUM_STATUS_POLL_INTERVAL_MS));
}

function pendingPremiumAccessForUi(
  access: PremiumAccessWire,
  catalog: PremiumAccessWire | null = null,
): PremiumAccessWire {
  let pending = access.status === "active" ? { ...access, status: "inactive" as const, reason: null } : access;
  if (catalog && catalog.status !== "unavailable") {
    if (pending.status === "unavailable") pending = { ...pending, status: "inactive", reason: null };
  }
  return retainPremiumCatalog(pending, catalog, { preserveDuringPending: true });
}

export function retainPremiumCatalog(
  next: PremiumAccessWire,
  previous: PremiumAccessWire | null,
  { preserveDuringPending = false }: { preserveDuringPending?: boolean } = {},
): PremiumAccessWire {
  if (
    next.status === "active" ||
    (next.status !== "unavailable" && !preserveDuringPending) ||
    !previous ||
    previous.packages.length === 0
  ) return next;

  const packagesById = new Map(previous.packages.map((item) => [item.packageId, item] as const));
  for (const item of next.packages) packagesById.set(item.packageId, item);
  const packages = (["monthly", "annual"] as const)
    .flatMap((packageId) => packagesById.has(packageId) ? [packagesById.get(packageId)!] : []);
  return packages.length > 0 ? { ...next, packages } : next;
}

export function App() {
  const mode = useMemo(() => resolveAppMode(), []);
  const recordingEnabled = useMemo(() => supportsDesktopRecording(), []);
  return <RecordingProvider enabled={recordingEnabled}><AppContent mode={mode} /></RecordingProvider>;
}

export function AppContent({ mode }: { mode: "desktop" | "companion" }) {
  const dimensions = useWindowDimensions();
  const recording = useRecording();
  const daemonUrl = useMemo(() => resolveDaemonUrl(), []);
  const connection = useRef<ActiveConnection | null>(null);
  const connectionEpoch = useRef(0);
  const companionSession = useRef<MeetlessConnectionSession | null>(null);
  const [profile, setProfile] = useState<CompanionProfile | null | undefined>(
    mode === "desktop" ? undefined : undefined,
  );
  const [meetings, setMeetings] = useState<MeetingWire[]>([]);
  const [status, setStatus] = useState("Connecting to host…");
  const [hostConnectionStatus, setHostConnectionStatus] = useState<
    "online" | "connecting" | "reconnecting" | "offline" | "revalidating"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptWire | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [consentStatus, setConsentStatus] = useState<"unknown" | "granted">("unknown");
  const [providerStatus, setProviderStatus] = useState<TranscriptionProviderStatusWire["status"] | undefined>();
  const [transcriptionRouteOutcome, setTranscriptionRouteOutcome] = useState<TranscriptionRouteOutcomeWire | undefined>();
  const [selectedRecording, setSelectedRecording] = useState<SelectedRecordingWire | null>(null);
  const [transcriptionRetryEligible, setTranscriptionRetryEligible] = useState(false);
  const [transcriptionFailureCategory, setTranscriptionFailureCategory] = useState<TranscriptionFailureCategoryWire | null>(null);
  const [transcriptionRouteMessage, setTranscriptionRouteMessage] = useState<string | null>(null);
  const [transcriptionConsentPending, setTranscriptionConsentPending] = useState(false);
  const [providerAccess, setProviderAccess] = useState<ProviderAccessResult | null>(null);
  const [providerAccessPending, setProviderAccessPending] = useState(false);
  const [providerAccessError, setProviderAccessError] = useState<string | null>(null);
  const [chatControls, setChatControls] = useState<ChatControlsWire | null>(null);
  const [chatSelection, setChatSelection] = useState<ChatSelectionWire | null>(null);
  const [chatFeatures, setChatFeatures] = useState<ChatFeatureDiscoveryWire | null>(null);
  const [chatFeaturesLoading, setChatFeaturesLoading] = useState(false);
  const [chatThread, setChatThread] = useState<MeetingChatThreadWire | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [premiumAccess, setPremiumAccess] = useState<PremiumAccessWire | null>(null);
  const [premiumPending, setPremiumPending] = useState(false);
  const [premiumPendingAction, setPremiumPendingAction] = useState<PremiumPendingAction | null>(null);
  const [premiumError, setPremiumError] = useState<string | null>(null);
  const [managedDevices, setManagedDevices] = useState<ManagedDeviceWire[] | null>(null);
  const [managedDevicesPending, setManagedDevicesPending] = useState(false);
  const [managedDevicesError, setManagedDevicesError] = useState<string | null>(null);
  const [citationEvidence, setCitationEvidence] = useState<CitationEvidenceState | null>(null);
  const [deleteConfirmationMeetingId, setDeleteConfirmationMeetingId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const playback = useRef<CitationPlaybackHandle | null>(null);
  const selectionVersion = useRef(0);
  const chatSelectionRequest = useRef(0);
  const citationSequence = useRef(0);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const transcriptionConsentOperation = useRef(0);
  const transcriptionConsentPendingRef = useRef(false);
  const premiumOperationSequence = useRef(0);
  const premiumOperation = useRef<{ token: number; action: PremiumPendingAction } | null>(null);
  const deletePendingRef = useRef(false);
  const deleteOperationEpoch = useRef(0);
  const layoutTier: LayoutTier = dimensions.width <= 639 ? "phone" : dimensions.width < 1120 ? "tablet" : "desktop";
  const recordingStatus = recording.status?.status;
  const recordingMeetingId = recording.status?.meetingId;

  const resetDeleteState = useCallback(() => {
    deleteOperationEpoch.current += 1;
    deletePendingRef.current = false;
    setDeletePending(false);
    setDeleteConfirmationMeetingId(null);
    setDeleteError(null);
  }, []);

  const installConnection = useCallback((client: MeetlessClient, close?: () => Promise<void>): ActiveConnection => {
    resetDeleteState();
    const active = { client, epoch: connectionEpoch.current + 1, ...(close ? { close } : {}) };
    connectionEpoch.current = active.epoch;
    connection.current = active;
    setProviderAccessPending(false);
    setProviderAccess(null);
    setProviderAccessError(null);
    return active;
  }, [resetDeleteState]);

  const invalidateConnection = useCallback(() => {
    resetDeleteState();
    connectionEpoch.current += 1;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    connection.current = null;
    setProviderAccessPending(false);
    setProviderAccess(null);
    setProviderAccessError(null);
    setPremiumAccess(null);
    premiumOperation.current = null;
    setPremiumPending(false);
    setPremiumPendingAction(null);
    setPremiumError(null);
    transcriptionConsentOperation.current += 1;
    transcriptionConsentPendingRef.current = false;
    setTranscriptionConsentPending(false);
    setSelectedRecording(null);
    setTranscriptionRetryEligible(false);
    setTranscriptionFailureCategory(null);
    setTranscriptLoading(false);
    setTranscriptionRouteOutcome(selectedMeetingIdRef.current ? "interrupted" : undefined);
    setTranscriptionRouteMessage(selectedMeetingIdRef.current ? "Reconnect to the host and check transcription status." : null);
    setManagedDevices(null);
    setManagedDevicesPending(false);
    setManagedDevicesError(null);
    setCitationEvidence((current) => current ? {
      ...current,
      status: "failed",
      error: "Host connection lost. Try again.",
    } : current);
  }, [resetDeleteState]);

  const isCurrentConnection = useCallback((active: ActiveConnection): boolean =>
    connection.current === active && connectionEpoch.current === active.epoch, []);

  const beginPremiumOperation = useCallback((action: PremiumPendingAction): number | null => {
    if (premiumOperation.current) return null;
    const token = ++premiumOperationSequence.current;
    premiumOperation.current = { token, action };
    setPremiumPending(true);
    setPremiumPendingAction(action);
    setPremiumError(null);
    return token;
  }, []);

  const endPremiumOperation = useCallback((token: number): void => {
    if (premiumOperation.current?.token !== token) return;
    premiumOperation.current = null;
    setPremiumPending(false);
    setPremiumPendingAction(null);
  }, []);

  const refresh = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const nextMeetings = await active.client.listMeetings();
    if (!isCurrentConnection(active)) return;
    setMeetings(nextMeetings);
    if (typeof console !== "undefined") {
      console.info(`[meetless-surface] ${JSON.stringify({
        meetingIds: nextMeetings.map((meeting) => meeting.id),
        mode,
        platform: Platform.OS,
      })}`);
    }
    setError(null);
  }, [isCurrentConnection, mode]);

  const refreshPremium = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const operation = beginPremiumOperation("refresh");
    if (operation === null) return;
    const deadline = Date.now() + PREMIUM_UI_PENDING_TIMEOUT_MS;
    try {
      const response = await premiumRpcWithin(active.client.getPremiumAccess(), Math.max(0, deadline - Date.now()));
      if (response.timedOut) {
        if (isCurrentConnection(active) && premiumOperation.current?.token === operation) {
          setPremiumError("Premium is still being checked. Try Refresh again.");
        }
        return;
      }
      const access = response.value;
      if (isCurrentConnection(active) && premiumOperation.current?.token === operation) {
        setPremiumAccess((current) => retainPremiumCatalog(access, current));
        if (access.status === "unavailable") {
          setPremiumError("Premium plans could not be loaded. Try again.");
        }
      }
    } catch {
      if (isCurrentConnection(active) && premiumOperation.current?.token === operation) {
        setPremiumAccess((current) => retainPremiumCatalog(
          { entitlement: "premium", status: "unavailable", packages: [], reason: "store_unavailable" },
          current,
        ));
        setPremiumError("Premium plans could not be loaded. Try again.");
      }
    } finally {
      endPremiumOperation(operation);
    }
  }, [beginPremiumOperation, endPremiumOperation, isCurrentConnection]);

  const mutatePremium = useCallback(async (action: "purchase" | "restore", packageId?: "monthly" | "annual") => {
    const active = connection.current;
    if (!active) return;
    const operation = beginPremiumOperation(action);
    if (operation === null) return;
    const operationId = crypto.randomUUID();
    const fallback = premiumAccess ?? { entitlement: "premium" as const, status: "inactive" as const, packages: [], reason: null };
    setPremiumAccess(pendingPremiumAccessForUi(fallback));
    logPremiumDiagnostic("ui_dispatch", "started", operationId);
    let terminal: PremiumMutationResultWire | null = null;
    let signalTerminal!: () => void;
    const terminalReady = new Promise<void>((resolve) => { signalTerminal = resolve; });
    const observe = (result: PremiumMutationResultWire | null) => {
      if (result && result.outcome !== "pending" && terminal === null) {
        terminal = result;
        signalTerminal();
      }
      return result;
    };
    try {
      // A request deadline loses only the response, never ownership of the
      // StoreKit operation. A late response and polling converge on one result.
      const request = action === "purchase"
        ? active.client.purchasePremium(packageId!, operationId)
        : active.client.restorePremium(operationId);
      await Promise.race([premiumRpcWithin(request.then(observe), PREMIUM_UI_PENDING_TIMEOUT_MS).catch(() => undefined), terminalReady]);
      while (isCurrentConnection(active) && premiumOperation.current?.token === operation && terminal === null) {
        await Promise.race([premiumRpcWithin(active.client.getPremiumOperation(operationId).then(observe), PREMIUM_UI_PENDING_TIMEOUT_MS).catch(() => undefined), terminalReady]);
        if (terminal === null) await waitForPremiumStatusPoll();
      }
      if (!isCurrentConnection(active) || premiumOperation.current?.token !== operation || terminal === null) return;
      const result = terminal as PremiumMutationResultWire;
      setPremiumAccess((current) => retainPremiumCatalog(result.access, current, { preserveDuringPending: result.outcome !== "active" }));
      setPremiumError(result.outcome === "failed"
        ? action === "purchase" ? "Purchase could not complete. Try again." : "No active Premium purchase was found."
        : null);
      logPremiumDiagnostic("ui_completion", result.outcome, operationId);
    } finally {
      endPremiumOperation(operation);
    }
  }, [beginPremiumOperation, endPremiumOperation, isCurrentConnection, premiumAccess]);

  const purchasePremium = useCallback((packageId: "monthly" | "annual") => mutatePremium("purchase", packageId), [mutatePremium]);
  const restorePremium = useCallback(() => mutatePremium("restore"), [mutatePremium]);

  const listManagedDevices = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    setManagedDevicesPending(true);
    setManagedDevicesError(null);
    try {
      const devices = await active.client.listPremiumDevices();
      if (isCurrentConnection(active)) setManagedDevices(devices);
    } catch {
      if (isCurrentConnection(active)) setManagedDevicesError("Mac access could not be loaded. Restore Premium and try again.");
    } finally {
      if (isCurrentConnection(active)) setManagedDevicesPending(false);
    }
  }, [isCurrentConnection]);

  const revokeManagedDevice = useCallback(async (deviceId: string) => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    setManagedDevicesPending(true);
    setManagedDevicesError(null);
    try {
      await active.client.revokePremiumDevice(deviceId);
      if (isCurrentConnection(active)) setManagedDevices(await active.client.listPremiumDevices());
    } catch {
      if (isCurrentConnection(active)) setManagedDevicesError("That Mac could not be revoked. Try again.");
    } finally {
      if (isCurrentConnection(active)) setManagedDevicesPending(false);
    }
  }, [isCurrentConnection]);

  const loadTranscriptChat = useCallback(async (
    active: ActiveConnection,
    meetingId: string,
    version: number,
    controlsSelectionRequest: number,
  ) => {
    setChatLoading(true);
    try {
      if (mode === "desktop" && typeof active.client.getProviderAccess === "function") {
        void active.client.getProviderAccess().then((result) => {
          if (isCurrentConnection(active)) { setProviderAccess(result); setProviderAccessError(null); }
        }).catch(() => { if (isCurrentConnection(active)) setProviderAccessError("Folder access could not be checked. Reopen the meeting to try again."); });
      }
      const threadPromise = active.client.getMeetingChat(meetingId);
      const controlsCapability = typeof active.client.getChatControls === "function";
      const controlsPromise = controlsCapability
        ? active.client.getChatControls()
        : active.client.listChatProviders().then((providerResult) => legacyChatControls(providerResult.providers, null));
      const [controls, thread] = await Promise.all([controlsPromise, threadPromise]);
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setChatControls(controls);
      if (chatSelectionRequest.current === controlsSelectionRequest) {
        setChatSelection(controlsCapability
          ? controls.lastSelection
          : resolveLegacySelection(legacyProvidersFromControls(controls.catalog), thread?.selection ?? null));
      }
      setChatThread(thread);
      setChatError(controlsCapability ? chatControlsErrorMessage(controls) : null);
    } catch {
      if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
        setChatError("Chat controls are unavailable. Update or repair the host.");
      }
    } finally {
      if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
        setChatLoading(false);
      }
    }
  }, [isCurrentConnection]);

  const openTranscript = useCallback(async (meetingId: string) => {
    if (deletePendingRef.current) return;
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const controlsSelectionRequest = chatSelectionRequest.current;
    const version = selectionVersion.current + 1;
    selectionVersion.current = version;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    setCitationEvidence(null);
    selectedMeetingIdRef.current = meetingId;
    setSelectedMeetingId(meetingId);
    setTranscriptLoading(true);
    setTranscript(null);
    setTranscriptError(null);
    setConsentStatus("unknown");
    setProviderStatus(undefined);
    setSelectedRecording(null);
    setTranscriptionRetryEligible(false);
    setTranscriptionFailureCategory(null);
    setTranscriptionRouteOutcome(undefined);
    setTranscriptionRouteMessage(null);
    transcriptionConsentPendingRef.current = false;
    setTranscriptionConsentPending(false);
    setChatControls(null);
    setChatThread(null);
    setChatLoading(false);
    setChatError(null);
    try {
      const result = await active.client.getMeetingTranscript(meetingId);
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setMeetings((current) => current.map((meeting) => meeting.id === meetingId ? result.meeting : meeting));
      setTranscript(result.transcript);
      setTranscriptLoading(false);
      setConsentStatus(result.consent.status);
      setProviderStatus(result.provider.status);
      setSelectedRecording(result.recording);
      setTranscriptionRouteOutcome(result.transcription.outcome);
      setTranscriptionRouteMessage(result.transcription.message);
      setTranscriptionRetryEligible(result.transcription.retryEligible);
      setTranscriptionFailureCategory(result.transcription.failureCategory);
      if (result.transcript?.status === "ready") {
        setTranscriptionRouteOutcome("completed");
        await loadTranscriptChat(active, meetingId, version, controlsSelectionRequest);
      }
    } catch (reason) {
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptLoading(false);
      setTranscriptError("Could not read transcription status. Reconnect to the host and check status.");
      setTranscriptionFailureCategory("connection");
      setTranscriptionRouteOutcome("interrupted");
    }
  }, [isCurrentConnection, loadTranscriptChat]);

  const closeTranscript = useCallback(() => {
    selectionVersion.current += 1;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    setCitationEvidence(null);
    selectedMeetingIdRef.current = null;
    setSelectedMeetingId(null);
    setTranscriptLoading(false);
    setTranscript(null);
    setTranscriptError(null);
    setConsentStatus("unknown");
    setProviderStatus(undefined);
    setSelectedRecording(null);
    setTranscriptionRetryEligible(false);
    setTranscriptionFailureCategory(null);
    setTranscriptionRouteOutcome(undefined);
    setTranscriptionRouteMessage(null);
    transcriptionConsentOperation.current += 1;
    transcriptionConsentPendingRef.current = false;
    setTranscriptionConsentPending(false);
    setChatControls(null);
    setChatThread(null);
    setChatLoading(false);
    setChatError(null);
  }, []);

  const requestDeleteMeeting = useCallback((meetingId: string) => {
    if (deletePending || selectedMeetingIdRef.current !== meetingId) return;
    setDeleteError(null);
    setDeleteConfirmationMeetingId(meetingId);
  }, [deletePending]);

  const cancelDeleteMeeting = useCallback(() => {
    if (!deletePending) setDeleteConfirmationMeetingId(null);
  }, [deletePending]);

  const confirmDeleteMeeting = useCallback(async () => {
    const active = connection.current;
    const meetingId = deleteConfirmationMeetingId;
    if (!active || !meetingId || deletePending || selectedMeetingIdRef.current !== meetingId) return;
    const operationEpoch = deleteOperationEpoch.current + 1;
    deleteOperationEpoch.current = operationEpoch;
    setDeletePending(true);
    deletePendingRef.current = true;
    setDeleteError(null);
    try {
      const result = await active.client.deleteMeeting(meetingId);
      if (!isCurrentConnection(active)) return;
      if (result.outcome === "refused") {
        setDeleteConfirmationMeetingId(null);
        if (selectedMeetingIdRef.current === meetingId) {
          setDeleteError("This meeting has active work. Wait for it to finish, then try again.");
        }
        return;
      }
      setMeetings((current) => current.filter((meeting) => meeting.id !== meetingId));
      setDeleteConfirmationMeetingId(null);
      if (selectedMeetingIdRef.current === meetingId) closeTranscript();
      const nextMeetings = await active.client.listMeetings();
      if (!isCurrentConnection(active)) return;
      setMeetings(nextMeetings);
    } catch {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
        setDeleteConfirmationMeetingId(null);
        setDeleteError("We could not delete this meeting. It is still in your library.");
      }
    } finally {
      if (deleteOperationEpoch.current === operationEpoch) {
        deletePendingRef.current = false;
        if (isCurrentConnection(active)) setDeletePending(false);
      }
    }
  }, [closeTranscript, deleteConfirmationMeetingId, deletePending, isCurrentConnection]);

  const selectChatSelection = useCallback(async (selection: ChatSelectionWire) => {
    const previous = chatSelection;
    const request = chatSelectionRequest.current + 1;
    chatSelectionRequest.current = request;
    setChatError(null);
    setChatSelection(selection);
    const active = connection.current;
    if (!active || typeof active.client.applyChatSelection !== "function") return;
    try {
      const applied = await active.client.applyChatSelection(selection);
      if (isCurrentConnection(active) && chatSelectionRequest.current === request) setChatSelection(applied);
    } catch (reason) {
      if (isCurrentConnection(active) && chatSelectionRequest.current === request) {
        setChatSelection(previous);
        setChatError("This chat selection is no longer available. Choose another model or profile.");
      }
    }
  }, [chatSelection, isCurrentConnection]);

  const requestProviderAccess = useCallback(async (provider: ProviderAccessId) => {
    const active = connection.current;
    if (!active || providerAccessPending) return;
    setProviderAccessPending(true);
    setProviderAccessError(null);
    try {
      const result = await active.client.requestProviderAccess(provider);
      if (isCurrentConnection(active)) { setProviderAccess(result); setProviderAccessError(null); }
    } catch {
      if (isCurrentConnection(active)) setProviderAccessError("Folder access could not be granted. Try again.");
    } finally {
      if (isCurrentConnection(active)) setProviderAccessPending(false);
    }
  }, [isCurrentConnection, providerAccessPending]);

  const askQuestion = useCallback(async (question: string) => {
    const active = connection.current;
    const meetingId = selectedMeetingIdRef.current;
    if (!active || !meetingId || !chatSelection) {
      throw new Error("Select an available chat model first");
    }
    setChatLoading(true);
    setChatError(null);
    try {
      const thread = typeof active.client.askMeetingQuestionWithSelection === "function"
        ? await active.client.askMeetingQuestionWithSelection({ meetingId, question, selection: chatSelection })
        : await active.client.askMeetingQuestion({
            meetingId, question, provider: chatSelection.provider, model: chatSelection.model,
          });
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatThread(thread);
    } catch (reason) {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
        setChatError(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    } finally {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatLoading(false);
    }
  }, [chatSelection, isCurrentConnection]);

  const retryQuestion = useCallback(async () => {
    const active = connection.current;
    const meetingId = selectedMeetingIdRef.current;
    if (!active || !meetingId || !chatSelection) return;
    setChatLoading(true);
    setChatError(null);
    try {
      const thread = typeof active.client.retryMeetingQuestionWithSelection === "function"
        ? await active.client.retryMeetingQuestionWithSelection({ meetingId, selection: chatSelection })
        : await active.client.retryMeetingQuestion({
            meetingId, provider: chatSelection.provider, model: chatSelection.model,
          });
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatThread(thread);
    } catch (reason) {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
        setChatError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatLoading(false);
    }
  }, [chatSelection, isCurrentConnection]);

  useEffect(() => {
    const active = connection.current;
    if (!active || !chatSelection || typeof active.client.discoverChatFeatures !== "function") {
      setChatFeatures(null);
      setChatFeaturesLoading(false);
      return;
    }
    const epoch = active.epoch;
    const identity = chatSelectionIdentity(chatSelection);
    let cancelled = false;
    setChatFeaturesLoading(true);
    void active.client.discoverChatFeatures(chatSelection).then((result) => {
      if (
        cancelled ||
        !isCurrentConnection(active) ||
        connectionEpoch.current !== epoch ||
        !connection.current ||
        !chatSelection ||
        chatSelectionIdentity(chatSelection) !== identity ||
        chatSelectionIdentity(result.selection) !== identity
      ) return;
      setChatFeatures(result);
      setChatFeaturesLoading(false);
      if (result.status !== "ready") setChatError(result.error?.message ?? "Chat features are unavailable. Update or repair the host.");
    }).catch(() => {
      if (cancelled || !isCurrentConnection(active) || connectionEpoch.current !== epoch) return;
      setChatFeatures(null);
      setChatFeaturesLoading(false);
      setChatError("Chat features are unavailable. Update or repair the host.");
    });
    return () => { cancelled = true; };
  }, [chatSelection, isCurrentConnection]);

  useEffect(() => {
    if (chatThread?.status !== "running" || !selectedMeetingId) return;
    const meetingId = selectedMeetingId;
    const timer = setInterval(() => {
      const active = connection.current;
      if (!active || selectedMeetingIdRef.current !== meetingId) return;
      void active.client.getMeetingChat(meetingId).then((thread) => {
        if (!isCurrentConnection(active) || selectedMeetingIdRef.current !== meetingId || !thread) return;
        setChatThread(thread);
        if (thread.status !== "running") setChatLoading(false);
      }).catch((reason) => {
        if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
          setChatError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    }, 500);
    return () => clearInterval(timer);
  }, [chatThread?.status, isCurrentConnection, selectedMeetingId]);

  useEffect(() => {
    const meetingId = selectedMeetingId;
    const routeIsRunning = transcriptionRouteOutcome === "started" || transcriptionRouteOutcome === "already_running";
    if (!meetingId || transcriptLoading || transcriptionConsentPending || !routeIsRunning) return;
    const active = connection.current;
    if (!active || !isCurrentConnection(active)) return;
    const version = selectionVersion.current;
    let cancelled = false;
    let requestInFlight = false;
    const poll = async () => {
      if (cancelled || requestInFlight || !isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      requestInFlight = true;
      try {
        const result = await active.client.getMeetingTranscript(meetingId);
        if (cancelled || !isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
        setMeetings((current) => current.map((meeting) => meeting.id === meetingId ? result.meeting : meeting));
        setConsentStatus(result.consent.status);
        // A granted consent response is already on the managed route. Keep the
        // native provider status out of this poll, just as the RPC boundary does.
        setProviderStatus(result.consent.status === "granted" ? "configured" : result.provider.status);
        setTranscript(result.transcript);
        setTranscriptLoading(false);
        setSelectedRecording(result.recording);
        setTranscriptionRouteOutcome(result.transcription.outcome);
        setTranscriptionRouteMessage(result.transcription.message);
        setTranscriptionRetryEligible(result.transcription.retryEligible);
        setTranscriptionFailureCategory(result.transcription.failureCategory);
        if (result.transcript?.status === "ready") {
          await loadTranscriptChat(active, meetingId, version, chatSelectionRequest.current);
        }
      } catch {
        if (!cancelled && isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
          setTranscriptionRouteOutcome("interrupted");
          setTranscriptionFailureCategory("connection");
          setTranscriptionRetryEligible(false);
          setTranscriptionRouteMessage("Could not check transcription progress. Reconnect to the host and check status.");
        }
      } finally {
        requestInFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, TRANSCRIPTION_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isCurrentConnection, loadTranscriptChat, selectedMeetingId, transcript?.status, transcriptLoading, transcriptionConsentPending, transcriptionRouteOutcome]);

  const grantConsent = useCallback(async () => {
    const active = connection.current;
    const meetingId = selectedMeetingIdRef.current;
    const version = selectionVersion.current;
    if (!active || !meetingId || selectedMeetingId !== meetingId || selectedRecording?.status !== "saved" || transcriptionConsentPendingRef.current) return;
    const premiumVersion = premiumOperation.current ? null : premiumOperationSequence.current;
    const operation = transcriptionConsentOperation.current + 1;
    transcriptionConsentOperation.current = operation;
    transcriptionConsentPendingRef.current = true;
    setTranscriptionConsentPending(true);
    setTranscriptLoading(true);
    setTranscriptError(null);
    setTranscriptionRetryEligible(false);
    setTranscriptionFailureCategory(null);
    setTranscriptionRouteOutcome(undefined);
    setTranscriptionRouteMessage(null);
    try {
      const result = await active.client.grantTranscriptionConsent(meetingId);
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId || transcriptionConsentOperation.current !== operation) return;
      if (result.outcome === "purchase_required" || result.outcome === "recovery_required") {
        setPremiumAccess((current) => {
          // A purchase/restore/refresh begun during this request owns its newer result.
          if (premiumVersion === null || premiumOperationSequence.current !== premiumVersion || premiumOperation.current) return current;
          return {
            entitlement: "premium",
            status: result.outcome === "purchase_required" ? "inactive" : "unavailable",
            packages: current?.packages ?? [],
            reason: null,
          };
        });
      }
      setConsentStatus(result.consent.status);
      // This result came from the managed route, so no native provider status
      // read is needed to render it.
      setProviderStatus("configured");
      setTranscriptionRouteOutcome(result.outcome);
      setTranscriptionRouteMessage(result.message);
      setTranscriptionRetryEligible(result.retryEligible);
      setTranscriptionFailureCategory(result.failureCategory);
      setTranscript(result.transcript);
      setTranscriptLoading(false);
      if (result.transcript?.status === "ready") {
        setTranscriptionRouteOutcome("completed");
        await loadTranscriptChat(active, meetingId, version, chatSelectionRequest.current);
      }
    } catch (reason) {
      if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId && transcriptionConsentOperation.current === operation) {
        setTranscriptLoading(false);
        setTranscriptionRouteOutcome("failed");
        setTranscriptionFailureCategory("connection");
        setTranscriptionRouteMessage("Could not confirm transcription started. Check status before retrying.");
        setTranscriptError(null);
      }
    } finally {
      if (transcriptionConsentOperation.current === operation) {
        transcriptionConsentPendingRef.current = false;
        setTranscriptionConsentPending(false);
      }
    }
  }, [isCurrentConnection, loadTranscriptChat, selectedMeetingId, selectedRecording]);

  const playCitation = useCallback(async (visibleCitation: Pick<CitationWire, "meetingId" | "segmentId">) => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const selection = selectionVersion.current;
    const sequence = citationSequence.current + 1;
    citationSequence.current = sequence;
    if (selectedMeetingIdRef.current !== visibleCitation.meetingId) return;
    playback.current?.stop();
    playback.current = null;
    setCitationEvidence({
      meetingId: visibleCitation.meetingId,
      segmentId: visibleCitation.segmentId,
      startMs: null,
      endMs: null,
      text: null,
      status: "resolving",
      error: null,
    });
    try {
      const citation = await active.client.resolveCitation({
        meetingId: visibleCitation.meetingId,
        segmentId: visibleCitation.segmentId,
      });
      if (
        !isCurrentConnection(active) ||
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== citation.meetingId
      ) return;
      setCitationEvidence({
        meetingId: citation.meetingId,
        segmentId: citation.segmentId,
        startMs: citation.startMs,
        endMs: citation.endMs,
        text: citation.text,
        status: "resolving",
        error: null,
      });
      const handle = await playCitationAudio(citation, undefined, undefined, {
        onComplete: () => {
          if (
            isCurrentConnection(active) &&
            citationSequence.current === sequence &&
            selectionVersion.current === selection &&
            selectedMeetingIdRef.current === citation.meetingId
          ) {
            playback.current = null;
            setCitationEvidence((current) => current ? { ...current, status: "completed" } : current);
          }
        },
        onError: () => {
          if (
            isCurrentConnection(active) &&
            citationSequence.current === sequence &&
            selectionVersion.current === selection &&
            selectedMeetingIdRef.current === citation.meetingId
          ) {
            playback.current = null;
            setCitationEvidence((current) => current ? {
              ...current,
              status: "failed",
              error: "Playback stopped unexpectedly. Try the citation again.",
            } : current);
          }
        },
      });
      if (
        !isCurrentConnection(active) ||
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== citation.meetingId
      ) {
        handle.stop();
        return;
      }
      playback.current = handle;
      setCitationEvidence((current) => current ? { ...current, status: "playing" } : current);
    } catch (reason) {
      if (
        !isCurrentConnection(active) ||
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== visibleCitation.meetingId
      ) return;
      setCitationEvidence((current) => current ? {
        ...current,
        status: "failed",
        error: "Playback could not start. Try again.",
      } : current);
    }
  }, [isCurrentConnection]);

  useEffect(() => () => {
    citationSequence.current += 1;
    playback.current?.stop();
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") document.title = "Meetless";
    if (mode !== "desktop") return;
    let cancelled = false;
    void connectMeetlessClient({
      url: daemonUrl,
      clientId: `meetless-${mode}-${Platform.OS}-${Date.now()}`,
      clientType: Platform.OS === "ios" ? "mobile" : "browser",
    })
      .then(async (connected) => {
        if (cancelled) {
          await connected.close();
          return;
        }
        const active = installConnection(connected.client, connected.close);
        const controlsSelectionEpoch = selectionVersion.current;
        const controlsSelectionRequest = chatSelectionRequest.current;
        await Promise.all([refresh(), refreshPremium()]);
        if (cancelled || !isCurrentConnection(active)) return;
        if (typeof active.client.getChatControls === "function") {
          try {
            const controls = await active.client.getChatControls();
            if (isCurrentConnection(active)) setChatControls(controls);
            if (
              isCurrentConnection(active)
              && selectionVersion.current === controlsSelectionEpoch
              && chatSelectionRequest.current === controlsSelectionRequest
            ) {
              setChatSelection(controls.lastSelection);
              setChatError(chatControlsErrorMessage(controls));
            }
          } catch {
            if (
              isCurrentConnection(active)
              && selectionVersion.current === controlsSelectionEpoch
              && chatSelectionRequest.current === controlsSelectionRequest
            ) {
              setChatError("Chat controls are unavailable. Update or repair the host.");
            }
          }
        }
        setStatus("Host online");
        setHostConnectionStatus("online");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus("Host offline");
          setHostConnectionStatus("offline");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
      const active = connection.current;
      invalidateConnection();
      if (active?.close) void active.close();
    };
  }, [daemonUrl, installConnection, invalidateConnection, isCurrentConnection, mode, refresh, refreshPremium]);

  useEffect(() => {
    if (mode !== "companion") return;
    let cancelled = false;
    void loadCompanionProfile()
      .then((stored) => { if (!cancelled) setProfile(stored); })
      .catch((reason) => {
        if (!cancelled) {
          setProfile(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    if (mode !== "companion" || !profile) return;
    const session = new MeetlessConnectionSession(profile, async (client, context) => {
      const selected = selectedMeetingIdRef.current;
      const restored = await loadCompanionRestoration(client, selected);
      if (!context.isCurrent() || companionSession.current !== session) {
        throw new Error("Companion restoration epoch changed");
      }
      installConnection(client);
      await refreshPremium();
      setMeetings(restored.meetings);
      if (typeof console !== "undefined") {
        console.info(`[meetless-surface] ${JSON.stringify({
          meetingIds: restored.meetings.map((meeting) => meeting.id),
          mode,
          platform: Platform.OS,
        })}`);
      }
      setError(null);
      setChatControls(restored.chatControls);
      setChatSelection(restored.chatSelection);
      const restoredChatError = chatControlsErrorMessage(restored.chatControls);
      if (restored.detail) {
        setTranscript(restored.detail.transcript);
        setTranscriptLoading(false);
        setTranscriptError(null);
        setConsentStatus(restored.detail.consent.status);
        setProviderStatus(restored.detail.provider.status);
        setSelectedRecording(restored.detail.recording);
        setTranscriptionRouteOutcome(restored.detail.transcription.outcome);
        setTranscriptionRouteMessage(restored.detail.transcription.message);
        setTranscriptionRetryEligible(restored.detail.transcription.retryEligible);
        setTranscriptionFailureCategory(restored.detail.transcription.failureCategory);
        setChatFeatures(null);
        setChatThread(restored.chatThread ?? null);
        setChatLoading(false);
        setChatError(restoredChatError);
      } else if (!selected) {
        setTranscript(null);
        setTranscriptLoading(false);
        setTranscriptError(null);
        setConsentStatus("unknown");
        setProviderStatus(undefined);
        setSelectedRecording(null);
        setTranscriptionRetryEligible(false);
        setTranscriptionFailureCategory(null);
        setTranscriptionRouteOutcome(undefined);
        setTranscriptionRouteMessage(null);
        setChatFeatures(null);
        setChatThread(null);
        setChatLoading(false);
        setChatError(restoredChatError);
      }
    });
    companionSession.current = session;
    const unsubscribe = session.subscribe((next: CompanionConnectionState) => {
      if (next.status === "unpaired") return;
      if (next.status === "disposed") {
        invalidateConnection();
        setStatus("Host offline");
        setHostConnectionStatus("offline");
        return;
      }
      const display = companionStateDisplay(next.status);
      setStatus(display.label);
      setHostConnectionStatus(display.surfaceStatus);
      if (next.status !== "online") invalidateConnection();
      if (next.status === "online") setError(null);
    });
    void session.start({
      clientId: `meetless-companion-${Platform.OS}-${Date.now()}`,
      clientType: Platform.OS === "web" ? "browser" : "mobile",
    });
    return () => {
      unsubscribe();
      if (companionSession.current === session) companionSession.current = null;
      invalidateConnection();
      void session.close();
    };
  }, [installConnection, invalidateConnection, mode, profile, refreshPremium]);

  const pairCompanion = useCallback(async (next: CompanionProfile) => {
    await saveCompanionProfile(next);
    setError(null);
    setProfile(next);
  }, []);

  const retryCompanionConnection = useCallback(() => {
    if (!profile) return;
    // Recreating the session keeps the validated profile and retained meeting
    // context while giving the existing session lifecycle a fresh connection.
    setProfile({ ...profile });
  }, [profile]);

  const changeCompanionHost = useCallback(async () => {
    await clearCompanionProfile();
    await companionSession.current?.close().catch(() => undefined);
    companionSession.current = null;
    invalidateConnection();
    closeTranscript();
    setMeetings([]);
    setError(null);
    setProfile(null);
  }, [closeTranscript, invalidateConnection]);

  const startRecording = useCallback(async (title: string) => {
    await recording.start(title);
    await refresh();
  }, [recording.start, refresh]);

  useEffect(() => {
    if (mode !== "desktop" || !recordingMeetingId || hostConnectionStatus !== "online") return;
    if (!["recording", "finalizing", "saved", "recoverable", "failed"].includes(recordingStatus ?? "")) return;
    void refresh().catch(() => undefined);
  }, [hostConnectionStatus, mode, recordingMeetingId, recordingStatus, refresh]);

  useEffect(() => {
    if (mode !== "desktop" || hostConnectionStatus !== "online" || recordingStatus !== "saved" ||
        !recordingMeetingId || recordingMeetingId !== selectedMeetingId || selectedRecording?.status === "saved" ||
        transcriptLoading || transcriptionConsentPending) return;
    const active = connection.current;
    if (!active || !isCurrentConnection(active)) return;
    const meetingId = recordingMeetingId;
    const version = selectionVersion.current;
    // Saving makes the selected detail eligible for a fresh read, never a cloud submission.
    void active.client.getMeetingTranscript(meetingId).then(async (result) => {
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setMeetings((current) => current.map((meeting) => meeting.id === meetingId ? result.meeting : meeting));
      setSelectedRecording(result.recording);
      setTranscript(result.transcript);
      setTranscriptError(null);
      setConsentStatus(result.consent.status);
      setProviderStatus(result.provider.status);
      setTranscriptionRouteOutcome(result.transcription.outcome);
      setTranscriptionRouteMessage(result.transcription.message);
      setTranscriptionRetryEligible(result.transcription.retryEligible);
      setTranscriptionFailureCategory(result.transcription.failureCategory);
      if (result.transcript?.status === "ready") await loadTranscriptChat(active, meetingId, version, chatSelectionRequest.current);
    }).catch(() => {
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptError("Could not read the saved recording status. Check status to continue.");
      setTranscriptionRouteOutcome("interrupted");
      setTranscriptionFailureCategory("connection");
      setTranscriptionRetryEligible(false);
    });
  }, [hostConnectionStatus, isCurrentConnection, loadTranscriptChat, mode, recordingMeetingId, recordingStatus, selectedMeetingId, selectedRecording?.status, transcriptLoading, transcriptionConsentPending]);

  if (mode === "companion" && profile === undefined) {
    return <SafeAreaView style={styles.safeArea}><StatusBar style="light" /></SafeAreaView>;
  }

  if (mode === "companion" && profile === null) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <CompanionPairing error={error} onPair={pairCompanion} />
      </SafeAreaView>
    );
  }

  const interactive = mode === "desktop" || hostConnectionStatus === "online";
  const recordingEntryAvailable = mode === "desktop" && hostConnectionStatus === "online" &&
    ["idle", "saved", "failed"].includes(recordingStatus ?? "");
  const deleteDisabled = !interactive || deletePending || chatLoading || chatThread?.status === "running" ||
    transcriptLoading || transcript?.status === "pending" || transcript?.status === "transcribing" ||
    (recordingMeetingId === selectedMeetingId &&
      ["recording", "interrupted", "recoverable", "finalizing"].includes(recordingStatus ?? ""));
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      {recording.enabled && recordingStatus !== "idle" ? <RecordingStrip
        elapsedMs={recording.displayElapsedMs}
        error={recording.error}
        onPause={recording.pause}
        onResume={recording.resume}
        onRetry={recording.retry}
        onStart={recording.start}
        onStop={recording.stop}
        pending={recording.pending || deletePending}
        pendingAction={recording.pendingAction}
        status={recording.status}
      /> : null}
      <MeetingListSurface
        layoutTier={layoutTier}
        canRecord={mode === "desktop"}
        connectionLabel={status}
        hostConnectionStatus={hostConnectionStatus}
        error={error}
        hostLabel="this host"
        meetings={meetings}
        currentRecording={recording.enabled ? recording.status : undefined}
        recordingSetup={mode === "desktop" ? {
          available: recordingEntryAvailable,
          pending: recording.pending,
          error: recording.error,
          permissions: recording.permissions,
          onStart: startRecording,
          onOpenPermissionSettings: recording.openPermissionSettings,
          onRecheckPermissions: recording.recheckPermissions,
        } : undefined}
        onRefresh={interactive ? refresh : async () => undefined}
        pending={recording.pending}
        onOpenTranscript={interactive ? openTranscript : undefined}
        onRetryConnection={mode === "companion" ? retryCompanionConnection : undefined}
        onBack={closeTranscript}
        selectedMeetingId={selectedMeetingId}
        transcript={transcript}
        transcriptLoading={transcriptLoading}
        transcriptError={transcriptError}
        consentStatus={consentStatus}
        providerStatus={providerStatus}
        selectedRecording={selectedRecording}
        transcriptionRetryEligible={transcriptionRetryEligible}
        transcriptionFailureCategory={transcriptionFailureCategory}
        onCheckTranscriptionStatus={selectedMeetingId ? () => openTranscript(selectedMeetingId) : undefined}
        transcriptionRouteOutcome={transcriptionRouteOutcome}
        transcriptionRouteMessage={transcriptionRouteMessage}
        transcriptionConsentPending={transcriptionConsentPending}
        onGrantTranscriptionConsent={interactive ? grantConsent : undefined}
        onRetryTranscription={interactive && consentStatus === "granted" ? grantConsent : undefined}
        onCitation={interactive ? playCitation : undefined}
        citationEvidence={citationEvidence}
        chatCatalog={chatControls?.catalog}
        chatCatalogError={chatControls?.catalogError ?? null}
        chatProfiles={chatControls?.profiles}
        chatSelection={chatSelection}
        chatFeatures={chatFeatures}
        chatFeaturesLoading={chatFeaturesLoading}
        chatProviders={legacyProvidersFromControls(chatControls?.catalog)}
        chatProvider={chatSelection?.provider ?? null}
        chatModel={chatSelection?.model ?? null}
        chatThread={chatThread}
        chatLoading={chatLoading}
        providerAccessNotice={mode === "desktop" ? <ProviderFolderAccess
          result={providerAccess} provider={chatSelection?.provider ?? null} pending={providerAccessPending}
          error={providerAccessError} onRequest={requestProviderAccess} /> : undefined}
        chatError={chatError}
        premiumAccess={premiumAccess}
        premiumPending={premiumPending}
        premiumPendingAction={premiumPendingAction}
        premiumError={premiumError}
        managedDevices={managedDevices}
        managedDevicesPending={managedDevicesPending}
        managedDevicesError={managedDevicesError}
        onChatSelectionBundle={selectChatSelection}
        onAskQuestion={interactive ? askQuestion : undefined}
        onRetryQuestion={interactive ? retryQuestion : undefined}
        onRefreshPremium={interactive ? refreshPremium : undefined}
        onPurchasePremium={interactive ? purchasePremium : undefined}
        onRestorePremium={interactive ? restorePremium : undefined}
        onListManagedDevices={interactive ? listManagedDevices : undefined}
        onRevokeManagedDevice={interactive ? revokeManagedDevice : undefined}
        onChangeHost={mode === "companion" ? changeCompanionHost : undefined}
        deleteConfirmationMeetingId={deleteConfirmationMeetingId}
        deletePending={deletePending}
        deleteError={deleteError}
        deleteDisabled={deleteDisabled}
        onRequestDeleteMeeting={interactive ? requestDeleteMeeting : undefined}
        onCancelDeleteMeeting={cancelDeleteMeeting}
        onConfirmDeleteMeeting={confirmDeleteMeeting}
      />
    </SafeAreaView>
  );
}

export async function loadCompanionRestoration(client: MeetlessClient, selectedMeetingId: string | null) {
  const meetings = await client.listMeetings();
  if (typeof client.getChatControls === "function") {
    const controls = await client.getChatControls();
    if (!selectedMeetingId) {
      return { meetings, detail: null, chatControls: controls, chatSelection: controls.lastSelection };
    }
    const detail = await client.getMeetingTranscript(selectedMeetingId);
    if (detail.transcript?.status !== "ready") {
      return { meetings, detail, chatControls: controls, chatSelection: controls.lastSelection };
    }
    const chatThread = await client.getMeetingChat(selectedMeetingId);
    return { meetings, detail, chatControls: controls, chatSelection: controls.lastSelection, chatThread };
  }
  if (!selectedMeetingId) {
    return {
      meetings,
      detail: null,
      chatControls: legacyChatControls([], null),
      chatSelection: null,
      chatProviders: [] as ChatProviderWire[],
      chatThread: null as MeetingChatThreadWire | null,
      chatProvider: null as string | null,
      chatModel: null as string | null,
    };
  }
  const detail = await client.getMeetingTranscript(selectedMeetingId);
  if (detail.transcript?.status !== "ready") {
    return {
      meetings,
      detail,
      chatControls: legacyChatControls([], null),
      chatSelection: null,
      chatProviders: [] as ChatProviderWire[],
      chatThread: null as MeetingChatThreadWire | null,
      chatProvider: null as string | null,
      chatModel: null as string | null,
    };
  }
  const [providerResult, chatThread] = await Promise.all([
    client.listChatProviders(),
    client.getMeetingChat(selectedMeetingId),
  ]);
  const selection = resolveLegacySelection(providerResult.providers, chatThread?.selection ?? null);
  return {
    meetings,
    detail,
    chatControls: legacyChatControls(providerResult.providers, chatThread?.selection ?? null),
    chatSelection: selection,
    chatProviders: providerResult.providers,
    chatThread,
    chatProvider: selection?.provider ?? null,
    chatModel: selection?.model ?? null,
  };
}

function legacySelection(selection: MeetingChatThreadWire["selection"]): ChatSelectionWire | null {
  return selection ? {
    provider: selection.provider,
    model: selection.model,
    modeId: null,
    thinkingOptionId: null,
    featureValues: {},
  } : null;
}

function resolveLegacySelection(providers: ChatProviderWire[], savedSelection: MeetingChatThreadWire["selection"]): ChatSelectionWire | null {
  const savedProvider = savedSelection ? providers.find((provider) => provider.id === savedSelection.provider) : undefined;
  const savedModel = savedProvider?.models.find((model) => model.id === savedSelection?.model);
  if (savedProvider && savedModel) return legacySelection({ provider: savedProvider.id, model: savedModel.id });
  const provider = providers[0];
  if (!provider) return null;
  const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  return model ? legacySelection({ provider: provider.id, model: model.id }) : null;
}

function legacyProvidersFromControls(catalog: ChatControlsWire["catalog"] | undefined): ChatProviderWire[] {
  return (catalog?.providers ?? [])
    .filter((provider) => provider.status === "ready" && provider.models.length > 0)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      models: provider.models.map((model) => ({ id: model.id, label: model.label, isDefault: model.isDefault })),
    }));
}

function legacyChatControls(providers: ChatProviderWire[], selection: MeetingChatThreadWire["selection"]): ChatControlsWire {
  return {
    version: 1,
    catalog: {
      providers: providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        status: "ready" as const,
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          isDefault: model.isDefault,
          thinkingOptions: [],
          defaultThinkingOptionId: null,
        })),
        modes: [],
        defaultModeId: null,
        error: null,
      })),
    },
    profiles: [],
    catalogError: null,
    lastSelection: legacySelection(selection),
    lastSelectionState: "available",
    lastSelectionError: null,
  };
}

function chatControlsErrorMessage(controls: ChatControlsWire): string | null {
  if (controls.catalogError) return controls.catalogError.message;
  if (controls.lastSelectionState !== "available") {
    return controls.lastSelectionError?.message ?? "This chat selection is no longer available. Choose another model or profile.";
  }
  return null;
}

const styles = StyleSheet.create({ safeArea: { backgroundColor: "#111316", flex: 1 } });

function companionStateDisplay(status: Exclude<CompanionConnectionState["status"], "disposed" | "unpaired">): {
  label: string;
  surfaceStatus: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
} {
  switch (status) {
    case "online": return { label: "Host online", surfaceStatus: "online" };
    case "connecting": return { label: "Connecting…", surfaceStatus: "connecting" };
    case "reconnecting": return { label: "Reconnecting…", surfaceStatus: "reconnecting" };
    case "revalidating": return { label: "Checking host…", surfaceStatus: "revalidating" };
    case "offline": return { label: "Host offline", surfaceStatus: "offline" };
  }
}


export function ProviderFolderAccess({ result, provider, pending, error, onRequest }: {
  result: ProviderAccessResult | null; provider: string | null; pending: boolean; error: string | null;
  onRequest(provider: ProviderAccessId): Promise<void>;
}) {
  const entries = result?.providers.filter((entry) => provider ? entry.id === provider : entry.status !== "unavailable") ?? [];
  return <View style={{ gap: 8 }} testID="provider-folder-access">
    {error ? <Text style={{ color: "#aeb6c2", fontSize: 13 }} accessibilityRole="alert">{error}</Text> : null}
    {result?.outcome === "cancelled" ? <Text style={{ color: "#aeb6c2", fontSize: 13 }}>Folder selection was cancelled. You can grant access when ready.</Text> : null}
    {result?.outcome === "invalid_selection" ? <Text style={{ color: "#aeb6c2", fontSize: 13 }}>Choose the selected agent’s existing configuration folder.</Text> : null}
    {result?.outcome === "failed" ? <Text style={{ color: "#aeb6c2", fontSize: 13 }}>Folder access could not be saved. Try again.</Text> : null}
    {entries.filter((entry) => entry.status !== "ready").map((entry) => <View key={entry.id}>
      <Text style={{ color: "#aeb6c2", fontSize: 13 }}>{entry.status === "restart_required"
        ? `Access to ${entry.id} is saved. Quit Meetless and reopen it, then send your question again.`
        : entry.status === "unavailable" ? `Folder access for ${entry.id} is not available in this build.`
        : `Allow Meetless to use your existing ${entry.id} configuration and sign-in. If access was removed, choose the folder again.`}</Text>
      {entry.status === "needs_access" ? <Pressable accessibilityRole="button"
        accessibilityLabel={`Grant ${entry.id} folder access`} accessibilityState={{ disabled: pending }} disabled={pending}
        style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: "#293849", marginTop: 8 }}
        onPress={() => void onRequest(entry.id)} testID={`provider-access-${entry.id}`}>
        <Text style={{ color: "#aeb6c2", fontSize: 13 }}>{pending ? "Choosing folder…" : `Grant ${entry.id} folder access`}</Text>
      </Pressable> : null}
    </View>)}
  </View>;
}
