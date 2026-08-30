import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, SafeAreaView, StyleSheet, useWindowDimensions } from "react-native";
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
  type ChatControlsWire,
  type ChatFeatureDiscoveryWire,
  type ChatProviderWire,
  type ChatSelectionWire,
  type MeetingChatThreadWire,
  type MeetingWire,
} from "@meetless/meeting-contracts";
import type { CitationWire, TranscriptWire, TranscriptionProviderStatusWire } from "@meetless/meeting-contracts";
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
  const [chatControls, setChatControls] = useState<ChatControlsWire | null>(null);
  const [chatSelection, setChatSelection] = useState<ChatSelectionWire | null>(null);
  const [chatFeatures, setChatFeatures] = useState<ChatFeatureDiscoveryWire | null>(null);
  const [chatFeaturesLoading, setChatFeaturesLoading] = useState(false);
  const [chatThread, setChatThread] = useState<MeetingChatThreadWire | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [citationEvidence, setCitationEvidence] = useState<CitationEvidenceState | null>(null);
  const [deleteConfirmationMeetingId, setDeleteConfirmationMeetingId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const playback = useRef<CitationPlaybackHandle | null>(null);
  const selectionVersion = useRef(0);
  const chatSelectionRequest = useRef(0);
  const citationSequence = useRef(0);
  const selectedMeetingIdRef = useRef<string | null>(null);
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
    return active;
  }, [resetDeleteState]);

  const invalidateConnection = useCallback(() => {
    resetDeleteState();
    connectionEpoch.current += 1;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    connection.current = null;
    setCitationEvidence((current) => current ? {
      ...current,
      status: "failed",
      error: "Host connection lost. Try again.",
    } : current);
  }, [resetDeleteState]);

  const isCurrentConnection = useCallback((active: ActiveConnection): boolean =>
    connection.current === active && connectionEpoch.current === active.epoch, []);

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
      if (result.transcript?.status === "ready") {
        setChatLoading(true);
        try {
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
        } catch (chatReason) {
          if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
            setChatError("Chat controls are unavailable. Update or repair the host.");
          }
        } finally {
          if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
            setChatLoading(false);
          }
        }
      }
    } catch (reason) {
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptLoading(false);
      setTranscriptError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [isCurrentConnection]);

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

  const grantConsent = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const meetingId = selectedMeetingIdRef.current;
    const version = selectionVersion.current;
    if (!meetingId) return;
    setTranscriptError(null);
    try {
      const result = await active.client.grantTranscriptionConsent();
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setConsentStatus(result.consent.status);
      setProviderStatus(result.provider.status);
      await openTranscript(meetingId);
    } catch (reason) {
      if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [isCurrentConnection, openTranscript]);

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
        await refresh();
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
  }, [daemonUrl, installConnection, invalidateConnection, isCurrentConnection, mode, refresh]);

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
  }, [installConnection, invalidateConnection, mode, profile]);

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
  const selectedMeetingStatus = meetings.find((meeting) => meeting.id === selectedMeetingId)?.status ?? null;
  const deleteDisabled = !interactive || deletePending || chatLoading || chatThread?.status === "running" ||
    transcriptLoading || transcript?.status === "pending" || transcript?.status === "transcribing" ||
    selectedMeetingStatus === "processing" ||
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
        chatError={chatError}
        onChatSelectionBundle={selectChatSelection}
        onAskQuestion={interactive ? askQuestion : undefined}
        onRetryQuestion={interactive ? retryQuestion : undefined}
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
