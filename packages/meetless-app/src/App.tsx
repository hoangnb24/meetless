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
import type { ChatProviderWire, MeetingChatThreadWire, MeetingWire } from "@meetless/meeting-contracts";
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
  const [chatProviders, setChatProviders] = useState<ChatProviderWire[]>([]);
  const [chatThread, setChatThread] = useState<MeetingChatThreadWire | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatProvider, setChatProvider] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [citationEvidence, setCitationEvidence] = useState<CitationEvidenceState | null>(null);
  const playback = useRef<CitationPlaybackHandle | null>(null);
  const selectionVersion = useRef(0);
  const citationSequence = useRef(0);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const layoutTier: LayoutTier = dimensions.width <= 639 ? "phone" : dimensions.width < 1120 ? "tablet" : "desktop";
  const recordingStatus = recording.status?.status;
  const recordingMeetingId = recording.status?.meetingId;

  const installConnection = useCallback((client: MeetlessClient, close?: () => Promise<void>): ActiveConnection => {
    const active = { client, epoch: connectionEpoch.current + 1, ...(close ? { close } : {}) };
    connectionEpoch.current = active.epoch;
    connection.current = active;
    return active;
  }, []);

  const invalidateConnection = useCallback(() => {
    connectionEpoch.current += 1;
    connection.current = null;
  }, []);

  const isCurrentConnection = useCallback((active: ActiveConnection): boolean =>
    connection.current === active && connectionEpoch.current === active.epoch, []);

  const refresh = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const nextMeetings = await active.client.listMeetings();
    if (!isCurrentConnection(active)) return;
    setMeetings(nextMeetings);
    setError(null);
  }, [isCurrentConnection]);

  const openTranscript = useCallback(async (meetingId: string) => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
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
    setChatProviders([]);
    setChatThread(null);
    setChatLoading(false);
    setChatError(null);
    setChatProvider(null);
    setChatModel(null);
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
          const [providerResult, thread] = await Promise.all([
            active.client.listChatProviders(),
            active.client.getMeetingChat(meetingId),
          ]);
          if (!isCurrentConnection(active) || selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
          setChatProviders(providerResult.providers);
          setChatThread(thread);
          const selectedProvider = thread?.selection?.provider ?? providerResult.providers[0]?.id ?? null;
          const provider = providerResult.providers.find((candidate) => candidate.id === selectedProvider);
          const selectedModel = thread?.selection?.model
            ?? provider?.models.find((candidate) => candidate.isDefault)?.id
            ?? provider?.models[0]?.id
            ?? null;
          setChatProvider(selectedProvider);
          setChatModel(selectedModel);
          setChatError(null);
        } catch (chatReason) {
          if (isCurrentConnection(active) && selectionVersion.current === version && selectedMeetingIdRef.current === meetingId) {
            setChatError(chatReason instanceof Error ? chatReason.message : String(chatReason));
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
    setChatProviders([]);
    setChatThread(null);
    setChatLoading(false);
    setChatError(null);
    setChatProvider(null);
    setChatModel(null);
  }, []);

  const selectChatModel = useCallback((provider: string, model: string) => {
    setChatProvider(provider);
    setChatModel(model);
    setChatError(null);
  }, []);

  const askQuestion = useCallback(async (question: string) => {
    const active = connection.current;
    const meetingId = selectedMeetingIdRef.current;
    if (!active || !meetingId || !chatProvider || !chatModel) {
      throw new Error("Select an available chat provider and model first");
    }
    setChatLoading(true);
    setChatError(null);
    try {
      const thread = await active.client.askMeetingQuestion({
        meetingId, question, provider: chatProvider, model: chatModel,
      });
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatThread(thread);
    } catch (reason) {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
        setChatError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatLoading(false);
    }
  }, [chatModel, chatProvider, isCurrentConnection]);

  const retryQuestion = useCallback(async () => {
    const active = connection.current;
    const meetingId = selectedMeetingIdRef.current;
    if (!active || !meetingId || !chatProvider || !chatModel) return;
    setChatLoading(true);
    setChatError(null);
    try {
      const thread = await active.client.retryMeetingQuestion({
        meetingId, provider: chatProvider, model: chatModel,
      });
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatThread(thread);
    } catch (reason) {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) {
        setChatError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (isCurrentConnection(active) && selectedMeetingIdRef.current === meetingId) setChatLoading(false);
    }
  }, [chatModel, chatProvider, isCurrentConnection]);

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
            setCitationEvidence((current) => current ? { ...current, status: "completed" } : current);
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
        await refresh();
        if (cancelled || !isCurrentConnection(active)) return;
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
      setError(null);
      if (restored.detail) {
        setTranscript(restored.detail.transcript);
        setTranscriptLoading(false);
        setTranscriptError(null);
        setConsentStatus(restored.detail.consent.status);
        setProviderStatus(restored.detail.provider.status);
        setChatProviders(restored.chatProviders);
        setChatThread(restored.chatThread);
        setChatProvider(restored.chatProvider);
        setChatModel(restored.chatModel);
        setChatLoading(false);
        setChatError(null);
      } else if (!selected) {
        setTranscript(null);
        setTranscriptLoading(false);
        setTranscriptError(null);
        setConsentStatus("unknown");
        setProviderStatus(undefined);
        setChatProviders([]);
        setChatThread(null);
        setChatProvider(null);
        setChatModel(null);
        setChatLoading(false);
        setChatError(null);
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
        pending={recording.pending}
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
          onStart: startRecording,
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
        onCitation={interactive ? playCitation : undefined}
        citationEvidence={citationEvidence}
        chatProviders={chatProviders}
        chatThread={chatThread}
        chatLoading={chatLoading}
        chatError={chatError}
        chatProvider={chatProvider}
        chatModel={chatModel}
        onChatSelection={selectChatModel}
        onAskQuestion={interactive ? askQuestion : undefined}
        onRetryQuestion={interactive ? retryQuestion : undefined}
        onChangeHost={mode === "companion" ? changeCompanionHost : undefined}
      />
    </SafeAreaView>
  );
}

export async function loadCompanionRestoration(client: MeetlessClient, selectedMeetingId: string | null) {
  const meetings = await client.listMeetings();
  if (!selectedMeetingId) {
    return {
      meetings,
      detail: null,
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
  const chatProvider = chatThread?.selection?.provider ?? providerResult.providers[0]?.id ?? null;
  const provider = providerResult.providers.find((candidate) => candidate.id === chatProvider);
  const chatModel = chatThread?.selection?.model
    ?? provider?.models.find((candidate) => candidate.isDefault)?.id
    ?? provider?.models[0]?.id
    ?? null;
  return {
    meetings,
    detail,
    chatProviders: providerResult.providers,
    chatThread,
    chatProvider,
    chatModel,
  };
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
