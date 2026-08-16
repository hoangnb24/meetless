import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, SafeAreaView, StyleSheet, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import { connectMeetlessClient, type ConnectedMeetlessClient } from "@meetless/client";
import type { MeetingWire } from "@meetless/meeting-contracts";
import { MeetingListSurface, RecordingStrip } from "@meetless/meeting-surface";
import { resolveAppMode, resolveDaemonUrl, supportsDesktopRecording } from "./runtime";
import { RecordingProvider, useRecording } from "./recording-provider";

export function App() {
  const mode = useMemo(() => resolveAppMode(), []);
  const recordingEnabled = useMemo(() => supportsDesktopRecording(), []);
  return <RecordingProvider enabled={recordingEnabled}><AppContent mode={mode} /></RecordingProvider>;
}

function AppContent({ mode }: { mode: "desktop" | "companion" }) {
  const dimensions = useWindowDimensions();
  const recording = useRecording();
  const daemonUrl = useMemo(() => resolveDaemonUrl(), []);
  const connection = useRef<ConnectedMeetlessClient | null>(null);
  const [meetings, setMeetings] = useState<MeetingWire[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Connecting to Meetless host…");
  const [error, setError] = useState<string | null>(null);
  const compact = Platform.OS !== "web" || dimensions.width < 700;

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
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { backgroundColor: "#111316", flex: 1 } });
