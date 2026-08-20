import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, SafeAreaView, StyleSheet, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import { connectMeetlessClient, type ConnectedMeetlessClient } from "@meetless/client";
import type { MeetingWire } from "@meetless/meeting-contracts";
import type { CitationWire, TranscriptWire, TranscriptionProviderStatusWire } from "@meetless/meeting-contracts";
import { MeetingListSurface, RecordingStrip } from "@meetless/meeting-surface";
import { resolveAppMode, resolveDaemonUrl, supportsDesktopRecording } from "./runtime";
import { RecordingProvider, useRecording } from "./recording-provider";
import { playCitationAudio, type CitationPlaybackHandle } from "./playback";

export function App() {
  const mode = useMemo(() => resolveAppMode(), []);
  const recordingEnabled = useMemo(() => supportsDesktopRecording(), []);
  return <RecordingProvider enabled={recordingEnabled}><AppContent mode={mode} /></RecordingProvider>;
}

export function AppContent({ mode }: { mode: "desktop" | "companion" }) {
  const dimensions = useWindowDimensions();
  const recording = useRecording();
  const daemonUrl = useMemo(() => resolveDaemonUrl(), []);
  const connection = useRef<ConnectedMeetlessClient | null>(null);
  const [meetings, setMeetings] = useState<MeetingWire[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Connecting to Meetless host…");
  const [error, setError] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptWire | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [consentStatus, setConsentStatus] = useState<"unknown" | "granted">("unknown");
  const [providerStatus, setProviderStatus] = useState<TranscriptionProviderStatusWire["status"] | undefined>();
  const playback = useRef<CitationPlaybackHandle | null>(null);
  const selectionVersion = useRef(0);
  const citationSequence = useRef(0);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const compact = Platform.OS !== "web" || dimensions.width < 720;

  const refresh = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const nextMeetings = await active.client.listMeetings();
    setMeetings(nextMeetings);
    console.info(
      `[meetless-surface] ${JSON.stringify({
        meetingIds: nextMeetings.map((meeting) => meeting.id),
        mode,
        platform: Platform.OS,
      })}`,
    );
    setStatus("Connected · daemon-owned meetings");
    setError(null);
  }, [mode]);

  const openTranscript = useCallback(async (meetingId: string) => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const version = selectionVersion.current + 1;
    selectionVersion.current = version;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    selectedMeetingIdRef.current = meetingId;
    setSelectedMeetingId(meetingId);
    setTranscriptLoading(true);
    setTranscript(null);
    setTranscriptError(null);
    setConsentStatus("unknown");
    setProviderStatus(undefined);
    try {
      const result = await active.client.getMeetingTranscript(meetingId);
      if (selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setMeetings((current) => current.map((meeting) => meeting.id === meetingId ? result.meeting : meeting));
      setTranscript(result.transcript);
      setTranscriptLoading(false);
      setConsentStatus(result.consent.status);
      setProviderStatus(result.provider.status);
    } catch (reason) {
      if (selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptLoading(false);
      setTranscriptError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const closeTranscript = useCallback(() => {
    selectionVersion.current += 1;
    citationSequence.current += 1;
    playback.current?.stop();
    playback.current = null;
    selectedMeetingIdRef.current = null;
    setSelectedMeetingId(null);
    setTranscriptLoading(false);
    setTranscript(null);
    setTranscriptError(null);
    setConsentStatus("unknown");
    setProviderStatus(undefined);
  }, []);

  const grantConsent = useCallback(async () => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const meetingId = selectedMeetingIdRef.current;
    const version = selectionVersion.current;
    if (!meetingId) return;
    setTranscriptError(null);
    try {
      const result = await active.client.grantTranscriptionConsent();
      if (selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setConsentStatus(result.consent.status);
      setProviderStatus(result.provider.status);
      await openTranscript(meetingId);
    } catch (reason) {
      if (selectionVersion.current !== version || selectedMeetingIdRef.current !== meetingId) return;
      setTranscriptError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [openTranscript]);

  const playCitation = useCallback(async (visibleCitation: Pick<CitationWire, "meetingId" | "segmentId">) => {
    const active = connection.current;
    if (!active) throw new Error("Meetless host is not connected yet");
    const selection = selectionVersion.current;
    const sequence = citationSequence.current + 1;
    citationSequence.current = sequence;
    if (selectedMeetingIdRef.current !== visibleCitation.meetingId) return;
    playback.current?.stop();
    playback.current = null;
    try {
      const citation = await active.client.resolveCitation({
        meetingId: visibleCitation.meetingId,
        segmentId: visibleCitation.segmentId,
      });
      if (
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== citation.meetingId
      ) return;
      const handle = await playCitationAudio(citation);
      if (
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== citation.meetingId
      ) {
        handle.stop();
        return;
      }
      playback.current = handle;
      setTranscriptError(null);
    } catch (reason) {
      if (
        citationSequence.current !== sequence ||
        selectionVersion.current !== selection ||
        selectedMeetingIdRef.current !== visibleCitation.meetingId
      ) return;
      setTranscriptError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => () => {
    citationSequence.current += 1;
    playback.current?.stop();
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") document.title = "Meetless";
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
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
        connection.current = connected;
        await refresh();
        if (mode === "companion") {
          timer = setInterval(() => void refresh().catch(() => undefined), 1_500);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus("Host unavailable");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      const active = connection.current;
      connection.current = null;
      if (active) void active.close();
    };
  }, [daemonUrl, mode, refresh]);

  const create = useCallback(
    async (title: string) => {
      const active = connection.current;
      if (!active) throw new Error("Meetless host is not connected yet");
      setPending(true);
      setError(null);
      try {
        await active.client.createMeeting({ title });
        await refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(false);
      }
    },
    [refresh],
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      {recording.enabled ? <RecordingStrip
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
        canCreate={mode === "desktop"}
        compact={compact}
        connectionLabel={status}
        error={error}
        hostLabel="your isolated Meetless daemon"
        meetings={meetings}
        onCreate={mode === "desktop" ? create : undefined}
        onRefresh={refresh}
        pending={pending}
        onOpenTranscript={openTranscript}
        onBack={closeTranscript}
        selectedMeetingId={selectedMeetingId}
        transcript={transcript}
        transcriptLoading={transcriptLoading}
        transcriptError={transcriptError}
        consentStatus={consentStatus}
        providerStatus={providerStatus}
        onGrantTranscriptionConsent={grantConsent}
        onCitation={playCitation}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { backgroundColor: "#111316", flex: 1 } });
