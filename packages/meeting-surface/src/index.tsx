import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { MeetingWire } from "@meetless/meeting-contracts";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";

export function RecordingStrip(props: {
  status: RecordingStatusWire;
  elapsedMs: number;
  pending: boolean;
  error: string | null;
  onStart(title: string): Promise<void>;
  onPause(): Promise<void>;
  onResume(): Promise<void>;
  onStop(): Promise<void>;
  onRetry(): Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const active = props.status.status === "recording";
  const recoverable = props.status.status === "recoverable";
  const seconds = Math.floor(props.elapsedMs / 1000);
  return (
    <View style={styles.recordingStrip} testID="global-recording-strip">
      {props.status.status === "idle" || props.status.status === "saved" || props.status.status === "failed" ? (
        <>
          <TextInput accessibilityLabel="Recording title" placeholder="Meeting title" placeholderTextColor="#777b82" style={styles.recordingInput} value={title} onChangeText={setTitle} testID="recording-title-input" />
          <Pressable disabled={props.pending || !title.trim()} onPress={() => void props.onStart(title.trim()).then(() => setTitle(""))} style={styles.recordingAction} testID="recording-start"><Text style={styles.buttonText}>Start recording</Text></Pressable>
        </>
      ) : (
        <>
          <View style={styles.recordingIdentity}><Text style={styles.recordingTitle}>{props.status.title ?? "Meeting"}</Text><Text style={styles.recordingTime}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")} · {props.status.status}</Text></View>
          {active ? <Pressable disabled={props.pending} onPress={() => void (props.status.paused ? props.onResume() : props.onPause())} style={styles.recordingSecondary} testID="recording-pause-resume"><Text style={styles.recordingButtonText}>{props.status.paused ? "Resume" : "Pause"}</Text></Pressable> : null}
          {active ? <Pressable disabled={props.pending} onPress={() => void props.onStop()} style={styles.recordingAction} testID="recording-stop"><Text style={styles.buttonText}>Stop</Text></Pressable> : null}
          {recoverable ? <Pressable disabled={props.pending} onPress={() => void props.onRetry()} style={styles.recordingAction} testID="recording-retry"><Text style={styles.buttonText}>Retry MP3</Text></Pressable> : null}
        </>
      )}
      {props.error ? <Text style={styles.error} testID="recording-error">{props.error}</Text> : null}
    </View>
  );
}

export interface SurfaceLayoutModel {
  content: { padding: number; gap: number; maxWidth: number | "100%"; alignSelf: "center" | "stretch" };
  row: { direction: "row" | "column"; gap: number };
  titleSize: number;
}

export function surfaceLayout(compact: boolean): SurfaceLayoutModel {
  return compact
    ? {
        content: { padding: 16, gap: 16, maxWidth: "100%", alignSelf: "stretch" },
        row: { direction: "column", gap: 10 },
        titleSize: 26,
      }
    : {
        content: { padding: 32, gap: 20, maxWidth: 920, alignSelf: "center" },
        row: { direction: "row", gap: 12 },
        titleSize: 32,
      };
}

export interface MeetingListSurfaceProps {
  compact: boolean;
  hostLabel: string;
  meetings: MeetingWire[];
  canCreate: boolean;
  pending?: boolean;
  error?: string | null;
  connectionLabel: string;
  onCreate?(title: string): Promise<void>;
  onRefresh(): Promise<void>;
}

export function MeetingListSurface({
  compact,
  hostLabel,
  meetings,
  canCreate,
  pending = false,
  error = null,
  connectionLabel,
  onCreate,
  onRefresh,
}: MeetingListSurfaceProps) {
  const [title, setTitle] = useState("");
  const responsive = surfaceLayout(compact);
  const create = useCallback(async () => {
    const normalized = title.trim();
    if (!normalized || pending || !onCreate) return;
    await onCreate(normalized);
    setTitle("");
  }, [onCreate, pending, title]);

  return (
    <View style={styles.app} testID="meetless-product-root">
      <ScrollView contentContainerStyle={[styles.content, responsive.content]} testID="meeting-surface">
        <View style={styles.heading}>
          <Text style={styles.brand} testID="meetless-brand">MEETLESS</Text>
          <Text style={[styles.title, { fontSize: responsive.titleSize }]}>Your meetings</Text>
          <Text style={styles.subtitle}>Stored on {hostLabel}</Text>
          <Text style={styles.connection} testID="connection-status">{connectionLabel}</Text>
        </View>
        {canCreate ? (
          <View
            style={[styles.createRow, { flexDirection: responsive.row.direction, gap: responsive.row.gap }]}
            testID="desktop-create-controls"
          >
            <TextInput
              accessibilityLabel="Meeting title"
              onChangeText={setTitle}
              placeholder="Meeting title"
              placeholderTextColor="#777b82"
              style={styles.input}
              testID="meeting-title-input"
              value={title}
            />
            <Pressable
              accessibilityLabel="Create meeting"
              accessibilityRole="button"
              disabled={pending || !title.trim()}
              onPress={() => void create()}
              style={styles.button}
              testID="meeting-create-button"
            >
              <Text style={styles.buttonText}>{pending ? "Creating…" : "Create meeting"}</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.readOnly} testID="companion-read-only">
            Companion view · meetings are created on desktop
          </Text>
        )}
        <View style={styles.toolbar}>
          <Text style={styles.sectionTitle}>Recent</Text>
          <Pressable
            accessibilityLabel="Refresh meetings"
            accessibilityRole="button"
            onPress={() => void onRefresh()}
            style={styles.refreshButton}
            testID="meeting-refresh-button"
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.error} testID="meeting-error">{error}</Text> : null}
        <View style={styles.list} testID="meeting-list">
          {meetings.length === 0 ? (
            <Text style={styles.empty}>No meetings yet.</Text>
          ) : (
            meetings.map((meeting) => (
              <View key={meeting.id} style={styles.card} testID={`meeting-${meeting.id}`}>
                <Text style={styles.cardTitle}>{meeting.title}</Text>
                <Text style={styles.status}>{meeting.status}</Text>
                <Text style={styles.timestamp}>{new Date(meeting.createdAt).toLocaleString()}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#111316" },
  content: { width: "100%", minHeight: "100%", paddingBottom: 48 },
  heading: { gap: 5 },
  brand: { color: "#e66b3d", fontSize: 12, fontWeight: "800", letterSpacing: 2.4 },
  title: { color: "#f4f1e8", fontWeight: "700" },
  subtitle: { color: "#a9aaad", fontSize: 14 },
  connection: { color: "#78b995", fontSize: 12, marginTop: 3 },
  createRow: { width: "100%" },
  input: { backgroundColor: "#202226", borderColor: "#3a3d43", borderRadius: 10, borderWidth: 1, color: "#f4f1e8", flex: 1, minHeight: 46, paddingHorizontal: 14 },
  button: { alignItems: "center", backgroundColor: "#e66b3d", borderRadius: 10, justifyContent: "center", minHeight: 46, paddingHorizontal: 18 },
  buttonText: { color: "#17120f", fontWeight: "700" },
  readOnly: { backgroundColor: "#1b1e22", borderColor: "#30343a", borderRadius: 10, borderWidth: 1, color: "#b8bbc0", padding: 14 },
  toolbar: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  sectionTitle: { color: "#f4f1e8", fontSize: 18, fontWeight: "600" },
  refreshButton: { borderColor: "#3a3d43", borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  refreshText: { color: "#d5d2cb", fontWeight: "600" },
  error: { color: "#ff8d82" },
  list: { gap: 10 },
  empty: { color: "#a9aaad", paddingVertical: 20 },
  card: { backgroundColor: "#202226", borderColor: "#32353a", borderRadius: 12, borderWidth: 1, gap: 6, padding: 16 },
  cardTitle: { color: "#f4f1e8", fontSize: 17, fontWeight: "600" },
  status: { color: "#e99a74", fontSize: 12, textTransform: "uppercase" },
  timestamp: { color: "#85898f", fontSize: 12 },
  recordingStrip: { alignItems: "center", backgroundColor: "#191b1f", borderBottomColor: "#34373d", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: 64, paddingHorizontal: 16, paddingVertical: 9 },
  recordingInput: { backgroundColor: "#202226", borderColor: "#3a3d43", borderRadius: 8, borderWidth: 1, color: "#f4f1e8", flex: 1, minHeight: 40, paddingHorizontal: 12 },
  recordingIdentity: { flex: 1, gap: 2 },
  recordingTitle: { color: "#f4f1e8", fontWeight: "700" },
  recordingTime: { color: "#e99a74", fontVariant: ["tabular-nums"] },
  recordingAction: { backgroundColor: "#e66b3d", borderRadius: 8, minHeight: 40, justifyContent: "center", paddingHorizontal: 14 },
  recordingSecondary: { borderColor: "#565b64", borderRadius: 8, borderWidth: 1, minHeight: 40, justifyContent: "center", paddingHorizontal: 14 },
  recordingButtonText: { color: "#f4f1e8", fontWeight: "700" },
});
