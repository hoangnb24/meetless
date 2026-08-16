import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { MeetingWire } from "@meetless/meeting-contracts";

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
});
