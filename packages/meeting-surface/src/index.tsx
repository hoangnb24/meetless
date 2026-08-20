import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type {
  ChatProviderWire,
  MeetingChatThreadWire,
  MeetingWire,
} from "@meetless/meeting-contracts";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";
import type { CitationWire, TranscriptWire, TranscriptionProviderStatusWire } from "@meetless/meeting-contracts";

export const ELECTRON_TITLEBAR_HIT_TEST_HEIGHT = 29;
const RECORDING_CONTROL_HEIGHT = 40;
const RECORDING_STRIP_VERTICAL_PADDING = 9;

export interface RecordingStripPointerGeometry {
  controlTopY: number;
  controlCenterY: number;
  stripMinHeight: number;
}

export function recordingStripPointerGeometry(titlebarClearance: number): RecordingStripPointerGeometry {
  const controlTopY = titlebarClearance + RECORDING_STRIP_VERTICAL_PADDING;
  return {
    controlTopY,
    controlCenterY: controlTopY + RECORDING_CONTROL_HEIGHT / 2,
    stripMinHeight: controlTopY + RECORDING_CONTROL_HEIGHT + RECORDING_STRIP_VERTICAL_PADDING,
  };
}

export function clearsElectronTitlebarHitTest(pointY: number): boolean {
  return pointY > ELECTRON_TITLEBAR_HIT_TEST_HEIGHT;
}

const recordingStripGeometry = recordingStripPointerGeometry(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT);

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
  const recoverable = props.status.status === "recoverable" && props.status.retryEligible;
  const seconds = Math.floor(props.elapsedMs / 1000);
  return (
    <View style={styles.recordingStrip} testID="global-recording-strip">
      {props.status.status === "idle" || props.status.status === "saved" || props.status.status === "failed" ? (
        <>
          <TextInput accessibilityLabel="Recording title" accessibilityRole="text" placeholder="Meeting title" placeholderTextColor="#777b82" style={styles.recordingInput} value={title} onChangeText={setTitle} testID="recording-title-input" />
          <Pressable accessibilityLabel="Start recording" accessibilityRole="button" disabled={props.pending || !title.trim()} onPress={() => void props.onStart(title.trim()).then(() => setTitle(""))} style={styles.recordingAction} testID="recording-start"><Text style={styles.buttonText}>Start recording</Text></Pressable>
        </>
      ) : (
        <>
          <View style={styles.recordingIdentity}><Text style={styles.recordingTitle}>{props.status.title ?? "Meeting"}</Text><Text style={styles.recordingTime}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")} · {props.status.status}</Text></View>
          {active ? <Pressable disabled={props.pending} onPress={() => void (props.status.paused ? props.onResume() : props.onPause())} style={styles.recordingSecondary} testID="recording-pause-resume"><Text style={styles.recordingButtonText}>{props.status.paused ? "Resume" : "Pause"}</Text></Pressable> : null}
          {active ? <Pressable accessibilityLabel="Stop recording" accessibilityRole="button" disabled={props.pending} onPress={() => void props.onStop()} style={styles.recordingAction} testID="recording-stop"><Text style={styles.buttonText}>Stop</Text></Pressable> : null}
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
  selectedMeetingId?: string | null;
  transcript?: TranscriptWire | null;
  transcriptLoading?: boolean;
  transcriptError?: string | null;
  consentStatus?: "unknown" | "granted";
  providerStatus?: TranscriptionProviderStatusWire["status"];
  onOpenTranscript?(meetingId: string): Promise<void>;
  onBack?(): void;
  onGrantTranscriptionConsent?(): Promise<void>;
  onCitation?(citation: Pick<CitationWire, "meetingId" | "segmentId">): void | Promise<void>;
  chatProviders?: ChatProviderWire[];
  chatThread?: MeetingChatThreadWire | null;
  chatLoading?: boolean;
  chatError?: string | null;
  chatProvider?: string | null;
  chatModel?: string | null;
  onChatSelection?(provider: string, model: string): void;
  onAskQuestion?(question: string): Promise<void>;
  onRetryQuestion?(): Promise<void>;
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
  selectedMeetingId = null,
  transcript = null,
  transcriptLoading = false,
  transcriptError = null,
  consentStatus = "unknown",
  providerStatus,
  onOpenTranscript,
  onBack,
  onGrantTranscriptionConsent,
  onCitation,
  chatProviders = [],
  chatThread = null,
  chatLoading = false,
  chatError = null,
  chatProvider = null,
  chatModel = null,
  onChatSelection,
  onAskQuestion,
  onRetryQuestion,
}: MeetingListSurfaceProps) {
  const [title, setTitle] = useState("");
  const create = useCallback(async () => {
    const normalized = title.trim();
    if (!normalized || pending || !onCreate) return;
    await onCreate(normalized);
    setTitle("");
  }, [onCreate, pending, title]);
  const selectedMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );

  const sidebar = (
    <MeetingSidebar
      canCreate={canCreate}
      compact={compact}
      connectionLabel={connectionLabel}
      error={error}
      hostLabel={hostLabel}
      meetings={meetings}
      onCreate={onCreate ? create : undefined}
      onOpenTranscript={onOpenTranscript}
      onRefresh={onRefresh}
      pending={pending}
      selectedMeetingId={selectedMeetingId}
      setTitle={setTitle}
      title={title}
    />
  );

  const detail = (
    <MeetingDetail
      compact={compact}
      consentStatus={consentStatus}
      onBack={onBack}
      onCitation={onCitation}
      onGrantTranscriptionConsent={onGrantTranscriptionConsent}
      pending={pending}
      providerStatus={providerStatus}
      selectedMeeting={selectedMeeting}
      selectedMeetingId={selectedMeetingId}
      transcript={transcript}
      transcriptError={transcriptError}
      transcriptLoading={transcriptLoading}
      chatProviders={chatProviders}
      chatThread={chatThread}
      chatLoading={chatLoading}
      chatError={chatError}
      chatProvider={chatProvider}
      chatModel={chatModel}
      onChatSelection={onChatSelection}
      onAskQuestion={onAskQuestion}
      onRetryQuestion={onRetryQuestion}
    />
  );

  return (
    <View style={styles.app} testID="meetless-product-root">
      {compact ? (
        selectedMeetingId ? detail : <View style={styles.compactList} testID="meeting-layout-compact-list">{sidebar}</View>
      ) : (
        <View style={styles.desktopLayout} testID="meeting-layout-desktop">
          <View style={styles.sidebarPane} testID="meeting-sidebar-pane">{sidebar}</View>
          <View style={styles.detailPane} testID="meeting-detail-pane">{detail}</View>
        </View>
      )}
    </View>
  );
}

interface MeetingSidebarProps {
  canCreate: boolean;
  compact: boolean;
  connectionLabel: string;
  error: string | null;
  hostLabel: string;
  meetings: MeetingWire[];
  onCreate?: () => Promise<void>;
  onOpenTranscript?: (meetingId: string) => Promise<void>;
  onRefresh(): Promise<void>;
  pending: boolean;
  selectedMeetingId: string | null;
  setTitle(title: string): void;
  title: string;
}

function MeetingSidebar({
  canCreate,
  compact,
  connectionLabel,
  error,
  hostLabel,
  meetings,
  onCreate,
  onOpenTranscript,
  onRefresh,
  pending,
  selectedMeetingId,
  setTitle,
  title,
}: MeetingSidebarProps) {
  return (
    <View style={styles.sidebar} testID="meeting-sidebar">
      <ScrollView
        style={styles.sidebarScroll}
        contentContainerStyle={[styles.sidebarContent, compact && styles.compactSidebarContent]}
        testID="meeting-surface"
      >
        <View style={styles.heading}>
          <Text style={styles.brand} testID="meetless-brand">MEETLESS</Text>
          <Text style={styles.title}>Your meetings</Text>
          <Text style={styles.subtitle}>Stored on {hostLabel}</Text>
          <Text style={styles.connection} testID="connection-status">{connectionLabel}</Text>
        </View>
        {canCreate ? (
          <View style={styles.createColumn} testID="desktop-create-controls">
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
              onPress={() => void onCreate?.()}
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
            <View style={styles.emptyState} testID="meeting-empty">
              <Text style={styles.empty}>No meetings yet</Text>
            </View>
          ) : (
            meetings.map((meeting) => {
              const selected = selectedMeetingId === meeting.id;
              return (
                <Pressable
                  key={meeting.id}
                  accessibilityLabel={`Open meeting ${meeting.title}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  disabled={!onOpenTranscript}
                  onPress={onOpenTranscript ? () => void onOpenTranscript(meeting.id) : undefined}
                  style={[styles.meetingRow, selected && styles.meetingRowSelected]}
                  testID={`meeting-${meeting.id}`}
                >
                  <View style={styles.meetingRowMain}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{meeting.title}</Text>
                    <Text style={styles.status}>{meeting.status}</Text>
                    <Text style={styles.timestamp}>{new Date(meeting.createdAt).toLocaleString()}</Text>
                  </View>
                  <Text style={styles.chevron} accessibilityElementsHidden>›</Text>
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

interface MeetingDetailProps {
  compact: boolean;
  consentStatus: "unknown" | "granted";
  onBack?: () => void;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  onGrantTranscriptionConsent?: () => Promise<void>;
  pending: boolean;
  providerStatus?: TranscriptionProviderStatusWire["status"];
  selectedMeeting: MeetingWire | null;
  selectedMeetingId: string | null;
  transcript: TranscriptWire | null;
  transcriptError: string | null;
  transcriptLoading: boolean;
  chatProviders: ChatProviderWire[];
  chatThread: MeetingChatThreadWire | null;
  chatLoading: boolean;
  chatError: string | null;
  chatProvider: string | null;
  chatModel: string | null;
  onChatSelection?: (provider: string, model: string) => void;
  onAskQuestion?: (question: string) => Promise<void>;
  onRetryQuestion?: () => Promise<void>;
}

function MeetingDetail({
  compact,
  consentStatus,
  onBack,
  onCitation,
  onGrantTranscriptionConsent,
  pending,
  providerStatus,
  selectedMeeting,
  selectedMeetingId,
  transcript,
  transcriptError,
  transcriptLoading,
  chatProviders,
  chatThread,
  chatLoading,
  chatError,
  chatProvider,
  chatModel,
  onChatSelection,
  onAskQuestion,
  onRetryQuestion,
}: MeetingDetailProps) {
  if (!selectedMeetingId && !transcript) {
    return (
      <View style={styles.detailPlaceholder} testID="meeting-detail-empty">
        <Text style={styles.detailPlaceholderTitle}>Select a meeting</Text>
        <Text style={styles.detailPlaceholderText}>Choose a meeting from the sidebar to read its transcript</Text>
      </View>
    );
  }

  const title = selectedMeeting?.title ?? "Meeting";
  return (
    <View style={styles.detail} testID="meeting-detail">
      <View style={styles.detailHeader} testID="meeting-detail-header">
        {compact ? (
          <Pressable
            accessibilityLabel="Back to meetings"
            accessibilityRole="button"
            onPress={() => onBack?.()}
            style={styles.backButton}
            testID="meeting-detail-back"
          >
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
        ) : null}
        <View style={styles.detailHeading}>
          <Text style={styles.detailTitle} numberOfLines={1}>{title}</Text>
          {selectedMeeting ? <Text style={styles.detailSubtitle}>{selectedMeeting.status}</Text> : null}
        </View>
      </View>
      <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent} testID="transcript-detail-scroll">
        {!transcriptLoading && consentStatus !== "granted" && onGrantTranscriptionConsent ? (
          <View style={styles.disclosure} testID="transcription-disclosure">
            <Text style={styles.subtitle}>Meetless sends saved MP3 audio to OpenAI for transcription. English/Vietnamese code-switching is kept as spoken.</Text>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={() => void onGrantTranscriptionConsent()}
              style={styles.button}
              testID="transcription-consent"
            >
              <Text style={styles.buttonText}>Allow cloud transcription</Text>
            </Pressable>
          </View>
        ) : null}
        {providerStatus ? <Text style={styles.provider} testID="transcription-provider">Provider: {providerStatus}</Text> : null}
        <TranscriptState
          onCitation={onCitation}
          selectedMeeting={selectedMeeting}
          transcript={transcript}
          transcriptError={transcriptError}
          transcriptLoading={transcriptLoading}
          providerStatus={providerStatus}
        />
        {transcript?.status === "ready" ? (
          <MeetingChatPanel
            error={chatError}
            loading={chatLoading}
            model={chatModel}
            onAsk={onAskQuestion}
            onCitation={onCitation}
            onRetry={onRetryQuestion}
            onSelection={onChatSelection}
            provider={chatProvider}
            providers={chatProviders}
            thread={chatThread}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function MeetingChatPanel({
  error,
  loading,
  model,
  onAsk,
  onCitation,
  onRetry,
  onSelection,
  provider,
  providers,
  thread,
}: {
  error: string | null;
  loading: boolean;
  model: string | null;
  onAsk?: (question: string) => Promise<void>;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  onRetry?: () => Promise<void>;
  onSelection?: (provider: string, model: string) => void;
  provider: string | null;
  providers: ChatProviderWire[];
  thread: MeetingChatThreadWire | null;
}) {
  const [question, setQuestion] = useState("");
  const running = thread?.status === "running" || loading;
  return (
    <View style={styles.chat} testID="meeting-chat">
      <Text style={styles.chatTitle}>Ask this meeting</Text>
      <Text style={styles.chatHint}>Provider compatibility is checked when the question starts.</Text>
      <View style={styles.chatChoices} testID="chat-provider-options">
        {providers.map((option) => (
          <View key={option.id} style={styles.chatChoiceGroup}>
            <Text style={styles.chatChoiceLabel}>{option.label}</Text>
            <View style={styles.chatModelRow}>
              {option.models.map((candidate) => {
                const selected = provider === option.id && model === candidate.id;
                return (
                  <Pressable
                    key={candidate.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => onSelection?.(option.id, candidate.id)}
                    style={[styles.chatModel, selected && styles.chatModelSelected]}
                    testID={`chat-model-${option.id}-${candidate.id}`}
                  >
                    <Text style={styles.chatModelText}>{candidate.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </View>
      <View style={styles.chatMessages} testID="chat-messages">
        {(thread?.messages ?? []).map((message, index) => (
          <View key={`${message.createdAt}-${index}`} style={message.role === "user" ? styles.chatUser : styles.chatAssistant}>
            <Text style={styles.chatRole}>{message.role === "user" ? "You" : "Meetless"}</Text>
            <Text style={styles.chatText}>
              {message.role === "assistant" && message.outcome === "insufficient_evidence"
                ? "The meeting does not contain enough evidence."
                : message.text}
            </Text>
            {message.role === "assistant" && message.outcome === "supported" ? (
              <View style={styles.chatCitations}>
                {message.citations.map((citation) => (
                  <Pressable
                    key={citation.segmentId}
                    accessibilityRole="button"
                    onPress={() => void onCitation?.(citation)}
                    style={styles.chatCitation}
                    testID={`chat-citation-${citation.segmentId}`}
                  >
                    <Text style={styles.segmentRange}>Play citation</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </View>
      {thread?.failure ? (
        <View style={styles.chatFailure} testID="chat-failure">
          <Text style={styles.error}>{thread.failure.message}</Text>
          <Pressable disabled={running || !provider || !model} onPress={() => void onRetry?.()} style={styles.refreshButton} testID="chat-retry">
            <Text style={styles.refreshText}>Retry question</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.error} testID="chat-error">{error}</Text> : null}
      {running ? <Text style={styles.chatHint} testID="chat-running">Reading the meeting…</Text> : null}
      <View style={styles.chatComposer}>
        <TextInput
          accessibilityLabel="Ask this meeting"
          editable={!running}
          onChangeText={setQuestion}
          placeholder="Ask a question about this meeting"
          placeholderTextColor="#777b82"
          style={styles.chatInput}
          testID="chat-question-input"
          value={question}
        />
        <Pressable
          disabled={running || !question.trim() || !provider || !model || !onAsk}
          onPress={() => void onAsk?.(question.trim()).then(() => setQuestion(""))}
          style={styles.button}
          testID="chat-ask"
        >
          <Text style={styles.buttonText}>Ask</Text>
        </Pressable>
      </View>
    </View>
  );
}

function TranscriptState({
  onCitation,
  selectedMeeting,
  transcript,
  transcriptError,
  transcriptLoading,
  providerStatus,
}: {
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  selectedMeeting: MeetingWire | null;
  transcript: TranscriptWire | null;
  transcriptError: string | null;
  transcriptLoading: boolean;
  providerStatus?: TranscriptionProviderStatusWire["status"];
}) {
  if (transcriptLoading) {
    return <TranscriptStateMessage testID="transcript-loading" title="Loading transcript..." />;
  }

  if (transcript?.status === "failed") {
    return <TranscriptStateMessage detail={transcript.failureReason ?? "Transcription failed"} testID="transcript-failed" title="Transcription failed" />;
  }

  if (!transcript && transcriptError) {
    return <TranscriptStateMessage detail={transcriptError} testID="transcript-failed" title="Transcription failed" />;
  }

  if (!transcript && providerStatus === "invalid") {
    return <TranscriptStateMessage detail="The transcription provider is unavailable" testID="transcript-failed" title="Transcription failed" />;
  }

  if (!transcript) {
    if (selectedMeeting?.status === "processing") {
      return <TranscriptStateMessage testID="transcript-processing" title="Transcription in progress..." />;
    }
    return <TranscriptStateMessage testID="transcript-empty" title="No transcript available yet" />;
  }

  if (transcript.status === "pending" || transcript.status === "transcribing") {
    return (
      <TranscriptStateMessage
        detail={`${transcript.status} · ${transcript.requestCount} requests`}
        testID="transcript-processing"
        title="Transcription in progress..."
      />
    );
  }

  return (
    <View style={styles.readyState} testID="transcript-ready">
      <Text style={styles.status} testID="transcript-status">Transcript ready · {transcript.segments.length} segments</Text>
      {transcriptError ? <Text style={styles.error} testID="transcript-error">{transcriptError}</Text> : null}
      <View style={styles.segmentList} testID="transcript-segments">
        {transcript.segments.length === 0 ? (
          <Text style={styles.empty} testID="transcript-ready-empty">Transcript is ready but has no segments</Text>
        ) : (
          transcript.segments.map((segment) => (
            <View key={segment.range.segmentId} style={styles.segment} testID={`transcript-segment-${segment.range.segmentId}`}>
              <Pressable
                accessibilityLabel={`Play transcript segment ${formatRange(segment.range.startMs, segment.range.endMs)}`}
                accessibilityRole="button"
                disabled={!onCitation}
                onPress={onCitation ? () => void onCitation({ meetingId: transcript.meetingId, segmentId: segment.range.segmentId }) : undefined}
                style={styles.segmentTimestamp}
                testID={`citation-${segment.range.segmentId}`}
              >
                <Text style={styles.segmentRange}>{formatRange(segment.range.startMs, segment.range.endMs)}</Text>
              </Pressable>
              <Text style={styles.segmentText}>{segment.text.trim() || "No spoken text returned for this segment"}</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function TranscriptStateMessage({ detail, testID, title }: { detail?: string; testID: string; title: string }) {
  return (
    <View style={styles.transcriptState} testID={testID}>
      <Text style={styles.transcriptStateTitle}>{title}</Text>
      {detail ? <Text style={styles.transcriptStateDetail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#111316" },
  compactList: { flex: 1 },
  desktopLayout: { flex: 1, flexDirection: "row" },
  sidebarPane: { flexShrink: 0, width: 320 },
  detailPane: { flex: 1, minWidth: 400 },
  sidebar: { backgroundColor: "#191b1f", flex: 1 },
  sidebarScroll: { flex: 1 },
  sidebarContent: { gap: 20, paddingBottom: 48, paddingHorizontal: 16, paddingTop: 24 },
  compactSidebarContent: { paddingTop: 16 },
  heading: { gap: 5 },
  brand: { color: "#e66b3d", fontSize: 12, fontWeight: "800", letterSpacing: 2.4 },
  title: { color: "#f4f1e8", fontSize: 22, fontWeight: "700" },
  subtitle: { color: "#a9aaad", fontSize: 14 },
  connection: { color: "#78b995", fontSize: 12, marginTop: 3 },
  createColumn: { gap: 10, width: "100%" },
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
  emptyState: { alignItems: "center", paddingVertical: 24 },
  empty: { color: "#a9aaad", paddingVertical: 20 },
  meetingRow: { alignItems: "center", backgroundColor: "transparent", borderColor: "transparent", borderRadius: 10, borderWidth: 1, flexDirection: "row", gap: 10, minHeight: 76, paddingHorizontal: 12, paddingVertical: 10 },
  meetingRowSelected: { backgroundColor: "#2a2d33", borderColor: "#454a53" },
  meetingRowMain: { flex: 1, gap: 5, minWidth: 0 },
  cardTitle: { color: "#f4f1e8", fontSize: 17, fontWeight: "600" },
  status: { color: "#e99a74", fontSize: 12, textTransform: "uppercase" },
  timestamp: { color: "#85898f", fontSize: 12 },
  chevron: { color: "#85898f", fontSize: 24, lineHeight: 24 },
  recordingStrip: { alignItems: "center", backgroundColor: "#191b1f", borderBottomColor: "#34373d", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: recordingStripGeometry.stripMinHeight, paddingBottom: RECORDING_STRIP_VERTICAL_PADDING, paddingHorizontal: 16, paddingTop: recordingStripGeometry.controlTopY },
  recordingInput: { backgroundColor: "#202226", borderColor: "#3a3d43", borderRadius: 8, borderWidth: 1, color: "#f4f1e8", flex: 1, minHeight: 40, paddingHorizontal: 12 },
  recordingIdentity: { flex: 1, gap: 2 },
  recordingTitle: { color: "#f4f1e8", fontWeight: "700" },
  recordingTime: { color: "#e99a74", fontVariant: ["tabular-nums"] },
  recordingAction: { backgroundColor: "#e66b3d", borderRadius: 8, minHeight: 40, justifyContent: "center", paddingHorizontal: 14 },
  recordingSecondary: { borderColor: "#565b64", borderRadius: 8, borderWidth: 1, minHeight: 40, justifyContent: "center", paddingHorizontal: 14 },
  recordingButtonText: { color: "#f4f1e8", fontWeight: "700" },
  detail: { backgroundColor: "#111316", flex: 1 },
  detailHeader: { alignItems: "center", borderBottomColor: "#34373d", borderBottomWidth: 1, flexDirection: "row", gap: 12, minHeight: 64, paddingHorizontal: 24 },
  detailHeading: { flex: 1, gap: 3, minWidth: 0 },
  detailTitle: { color: "#f4f1e8", fontSize: 20, fontWeight: "600" },
  detailSubtitle: { color: "#a9aaad", fontSize: 12, textTransform: "uppercase" },
  backButton: { borderColor: "#565b64", borderRadius: 8, borderWidth: 1, minHeight: 40, justifyContent: "center", paddingHorizontal: 12 },
  backButtonText: { color: "#f4f1e8", fontWeight: "600" },
  detailScroll: { flex: 1 },
  detailContent: { gap: 16, maxWidth: 900, paddingBottom: 48, paddingHorizontal: 24, paddingTop: 24, width: "100%", alignSelf: "center" },
  detailPlaceholder: { alignItems: "center", backgroundColor: "#111316", flex: 1, justifyContent: "center", padding: 32 },
  detailPlaceholderTitle: { color: "#f4f1e8", fontSize: 20, fontWeight: "600" },
  detailPlaceholderText: { color: "#a9aaad", marginTop: 8, textAlign: "center" },
  disclosure: { backgroundColor: "#24272c", borderRadius: 8, gap: 10, padding: 12 },
  provider: { color: "#78b995", fontSize: 12, textTransform: "uppercase" },
  transcriptState: { backgroundColor: "#181a1e", borderColor: "#32353a", borderRadius: 10, borderWidth: 1, gap: 8, padding: 20 },
  transcriptStateTitle: { color: "#f4f1e8", fontSize: 17, fontWeight: "600" },
  transcriptStateDetail: { color: "#a9aaad", lineHeight: 20 },
  readyState: { gap: 12 },
  segmentList: { gap: 8 },
  segment: { backgroundColor: "#202226", borderColor: "#32353a", borderRadius: 8, borderWidth: 1, gap: 6, padding: 12 },
  segmentTimestamp: { alignSelf: "flex-start", borderRadius: 6, paddingHorizontal: 4, paddingVertical: 2 },
  segmentRange: { color: "#e99a74", fontSize: 12, fontVariant: ["tabular-nums"], textDecorationLine: "underline" },
  segmentText: { color: "#f4f1e8", lineHeight: 21 },
  chat: { borderTopColor: "#34373d", borderTopWidth: 1, gap: 12, marginTop: 12, paddingTop: 20 },
  chatTitle: { color: "#f4f1e8", fontSize: 18, fontWeight: "700" },
  chatHint: { color: "#a9aaad", fontSize: 12 },
  chatChoices: { gap: 10 },
  chatChoiceGroup: { gap: 6 },
  chatChoiceLabel: { color: "#d5d2cb", fontSize: 13, fontWeight: "600" },
  chatModelRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chatModel: { borderColor: "#454a53", borderRadius: 7, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  chatModelSelected: { backgroundColor: "#343840", borderColor: "#e66b3d" },
  chatModelText: { color: "#f4f1e8", fontSize: 12 },
  chatMessages: { gap: 8 },
  chatUser: { alignSelf: "flex-end", backgroundColor: "#3a2a24", borderRadius: 10, gap: 4, maxWidth: "85%", padding: 10 },
  chatAssistant: { alignSelf: "flex-start", backgroundColor: "#202226", borderRadius: 10, gap: 6, maxWidth: "92%", padding: 10 },
  chatRole: { color: "#e99a74", fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  chatText: { color: "#f4f1e8", lineHeight: 20 },
  chatCitations: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chatCitation: { borderColor: "#565b64", borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5 },
  chatFailure: { backgroundColor: "#2a2020", borderRadius: 8, gap: 8, padding: 10 },
  chatComposer: { alignItems: "stretch", flexDirection: "row", gap: 8 },
  chatInput: { backgroundColor: "#202226", borderColor: "#3a3d43", borderRadius: 10, borderWidth: 1, color: "#f4f1e8", flex: 1, minHeight: 46, paddingHorizontal: 14 },
});

function formatRange(startMs: number, endMs: number): string {
  return `${formatMilliseconds(startMs)}–${formatMilliseconds(endMs)}`;
}

function formatMilliseconds(value: number): string {
  const seconds = Math.floor(value / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
