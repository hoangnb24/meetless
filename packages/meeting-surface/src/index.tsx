import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import type {
  ChatCapabilityErrorWire,
  ChatControlModelWire,
  ChatControlProviderWire,
  ChatControlsCatalogWire,
  ChatFeatureDiscoveryWire,
  ChatProfileWire,
  ChatProviderWire,
  ChatSelectionWire,
  CitationWire,
  MeetingChatThreadWire,
  MeetingWire,
  RecordingStatusWire,
  TranscriptWire,
  TranscriptionProviderStatusWire,
} from "@meetless/meeting-contracts";

export const ELECTRON_TITLEBAR_HIT_TEST_HEIGHT = 29;
const RECORDING_CONTROL_HEIGHT = 40;
const RECORDING_STRIP_VERTICAL_PADDING = 9;

const electronTitlebarDragRegionStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  left: 0,
  height: ELECTRON_TITLEBAR_HIT_TEST_HEIGHT,
  WebkitAppRegion: "drag",
} as unknown as ViewStyle;

const colors = {
  bg: "#08090a",
  surface: "#191a1b",
  foreground: "#f7f8f8",
  secondary: "#d0d6e0",
  muted: "#8a8f98",
  meta: "#62666d",
  border: "rgba(255,255,255,0.08)",
  borderSoft: "rgba(255,255,255,0.05)",
  accent: "#5e6ad2",
  accentHover: "#828fff",
  accentActive: "#4752c4",
  success: "#27a644",
  warning: "#eab308",
  danger: "#dc2626",
  dangerText: "#f2a2a0",
};

const sans = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

export type LayoutTier = "phone" | "tablet" | "desktop";
export type MeetingTask = "transcript" | "ask";

const CHAT_PICKER_VIEWPORT_MARGIN = 12;
const CHAT_PICKER_TRIGGER_GAP = 8;
const CHAT_PICKER_WIDTH = 300;
const CHAT_PICKER_MAX_HEIGHT = 420;

export interface ChatPickerAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChatPickerViewport {
  width: number;
  height: number;
}

export interface ChatPickerGeometry {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
}

export function chatPickerGeometry(
  trigger: ChatPickerAnchorRect,
  viewport: ChatPickerViewport,
  contentHeight: number,
): ChatPickerGeometry {
  const width = Math.max(0, Math.min(CHAT_PICKER_WIDTH, viewport.width - CHAT_PICKER_VIEWPORT_MARGIN * 2));
  const left = Math.min(
    Math.max(CHAT_PICKER_VIEWPORT_MARGIN, trigger.left),
    Math.max(CHAT_PICKER_VIEWPORT_MARGIN, viewport.width - CHAT_PICKER_VIEWPORT_MARGIN - width),
  );
  const availableAbove = Math.max(0, trigger.top - CHAT_PICKER_TRIGGER_GAP - CHAT_PICKER_VIEWPORT_MARGIN);
  const availableBelow = Math.max(0, viewport.height - trigger.bottom - CHAT_PICKER_TRIGGER_GAP - CHAT_PICKER_VIEWPORT_MARGIN);
  const desiredHeight = Math.min(CHAT_PICKER_MAX_HEIGHT, Math.max(0, contentHeight));
  let placement: ChatPickerGeometry["placement"];
  if (desiredHeight <= availableAbove) placement = "above";
  else if (desiredHeight <= availableBelow) placement = "below";
  else placement = availableAbove >= availableBelow ? "above" : "below";
  const maxHeight = Math.min(desiredHeight, placement === "above" ? availableAbove : availableBelow);
  const top = placement === "above"
    ? trigger.top - CHAT_PICKER_TRIGGER_GAP - maxHeight
    : trigger.bottom + CHAT_PICKER_TRIGGER_GAP;

  return { top, left, width, maxHeight, placement };
}

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

function ElectronTitlebarDragRegion({ regionID }: { regionID: string }) {
  if (Platform.OS !== "web") return null;
  return <View aria-hidden style={electronTitlebarDragRegionStyle} testID={regionID} />;
}

const recordingStripGeometry = recordingStripPointerGeometry(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT);

export interface CitationEvidenceState {
  meetingId: string;
  segmentId: string;
  startMs: number | null;
  endMs: number | null;
  text: string | null;
  status: "resolving" | "playing" | "completed" | "failed";
  error: string | null;
}

export interface RecordingSetupController {
  available: boolean;
  pending: boolean;
  error: string | null;
  onStart(title: string): Promise<void>;
  permissions?: {
    microphone: "authorized" | "notDetermined" | "denied" | "restricted" | null;
    systemAudio: "authorized" | "notDetermined" | "denied" | "restricted" | null;
    checking: boolean;
    error: string | null;
  };
  onOpenPermissionSettings?(source: "microphone" | "systemAudio"): Promise<void>;
  onRecheckPermissions?(): Promise<void>;
}

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
  if (props.status.status === "idle") return null;

  const active = props.status.status === "recording";
  const recoverable = props.status.status === "recoverable" && props.status.retryEligible;
  const state = recordingStateCopy(props.status);
  const seconds = Math.floor(props.elapsedMs / 1000);

  if (active) {
    return (
      <View style={styles.recordingStrip} testID="global-recording-strip">
        <ElectronTitlebarDragRegion regionID="recording-titlebar-drag-region" />
        <View style={styles.recordingLiveDot} accessibilityElementsHidden />
        <View style={styles.recordingIdentity}>
          <Text style={styles.recordingTitle} numberOfLines={1}>{props.status.title ?? "Meeting"}</Text>
          <Text
            accessibilityLiveRegion="polite"
            style={styles.recordingTime}
            testID="recording-state"
          >
            {props.status.paused ? "Paused" : "Recording"} · {formatClock(seconds)}
          </Text>
        </View>
        <FocusPressable
          accessibilityLabel={props.status.paused ? "Resume recording" : "Pause recording"}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.pending }}
          disabled={props.pending}
          onPress={() => void (props.status.paused ? props.onResume() : props.onPause())}
          style={styles.recordingSecondary}
          testID="recording-pause-resume"
        >
          <Text style={styles.recordingButtonText}>{props.status.paused ? "Resume" : "Pause"}</Text>
        </FocusPressable>
        <FocusPressable
          accessibilityLabel="Stop recording and save audio"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.pending }}
          disabled={props.pending}
          onPress={() => void props.onStop()}
          style={styles.recordingAction}
          testID="recording-stop"
        >
          <Text style={styles.buttonText}>Stop</Text>
        </FocusPressable>
      </View>
    );
  }

  return (
    <View style={styles.recordingStrip} testID="global-recording-strip">
      <ElectronTitlebarDragRegion regionID="recording-titlebar-drag-region" />
      <View style={[styles.recordingLiveDot, state.tone === "warning" && styles.recordingLiveDotWarning]} accessibilityElementsHidden />
      <View style={styles.recordingIdentity}>
        <Text accessibilityLiveRegion="polite" style={styles.recordingTitle} testID="recording-state">{state.title}</Text>
        <Text style={styles.recordingDetail}>{state.detail}</Text>
      </View>
      {recoverable ? (
        <FocusPressable
          accessibilityLabel="Retry saving the recording"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.pending }}
          disabled={props.pending}
          onPress={() => void props.onRetry()}
          style={styles.recordingAction}
          testID="recording-retry"
        >
          <Text style={styles.buttonText}>Retry save</Text>
        </FocusPressable>
      ) : null}
      {props.error || props.status.error ? <Text style={styles.recordingError} testID="recording-error">{recordingErrorCopy(props.status, props.error)}</Text> : null}
    </View>
  );
}

export interface SurfaceLayoutModel {
  content: { padding: number; gap: number; maxWidth: number | "100%"; alignSelf: "center" | "stretch" };
  row: { direction: "row" | "column"; gap: number };
  titleSize: number;
}

export function surfaceLayout(tier: LayoutTier | boolean): SurfaceLayoutModel {
  const resolved: LayoutTier = typeof tier === "boolean" ? (tier ? "phone" : "desktop") : tier;
  if (resolved === "phone") {
    return {
      content: { padding: 12, gap: 16, maxWidth: "100%", alignSelf: "stretch" },
      row: { direction: "column", gap: 10 },
      titleSize: 24,
    };
  }
  if (resolved === "tablet") {
    return {
      content: { padding: 16, gap: 16, maxWidth: "100%", alignSelf: "stretch" },
      row: { direction: "column", gap: 10 },
      titleSize: 24,
    };
  }
  return {
    content: { padding: 24, gap: 20, maxWidth: 1200, alignSelf: "center" },
    row: { direction: "row", gap: 12 },
    titleSize: 32,
  };
}

export interface MeetingListSurfaceProps {
  /** `layoutTier` is supplied by the width-driven app shell. */
  layoutTier?: LayoutTier;
  /** Kept for existing isolated callers; the app always supplies layoutTier. */
  compact?: boolean;
  hostLabel: string;
  meetings: MeetingWire[];
  canCreate?: boolean;
  canRecord?: boolean;
  recordingSetup?: RecordingSetupController;
  pending?: boolean;
  error?: string | null;
  connectionLabel: string;
  hostConnectionStatus?: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
  onCreate?(title: string): Promise<void>;
  onRefresh(): Promise<void>;
  onRetryConnection?(): Promise<void> | void;
  selectedMeetingId?: string | null;
  transcript?: TranscriptWire | null;
  transcriptLoading?: boolean;
  transcriptError?: string | null;
  consentStatus?: "unknown" | "granted";
  providerStatus?: TranscriptionProviderStatusWire["status"];
  onOpenTranscript?(meetingId: string): Promise<void>;
  onBack?(): void;
  onGrantTranscriptionConsent?(): Promise<void>;
  onRetryTranscription?(): Promise<void>;
  onCitation?(citation: Pick<CitationWire, "meetingId" | "segmentId">): void | Promise<void>;
  citationEvidence?: CitationEvidenceState | null;
  chatCatalog?: ChatControlsCatalogWire;
  chatCatalogError?: ChatCapabilityErrorWire | null;
  chatProfiles?: ChatProfileWire[];
  chatSelection?: ChatSelectionWire | null;
  chatFeatures?: ChatFeatureDiscoveryWire | null;
  chatFeaturesLoading?: boolean;
  onChatSelectionBundle?(selection: ChatSelectionWire): void | Promise<void>;
  chatProviders?: ChatProviderWire[];
  chatThread?: MeetingChatThreadWire | null;
  chatLoading?: boolean;
  chatError?: string | null;
  chatProvider?: string | null;
  chatModel?: string | null;
  onChatSelection?(provider: string, model: string): void;
  onAskQuestion?(question: string): Promise<void>;
  onRetryQuestion?(): Promise<void>;
  onChangeHost?(): void | Promise<void>;
  deleteConfirmationMeetingId?: string | null;
  deletePending?: boolean;
  deleteError?: string | null;
  deleteDisabled?: boolean;
  onRequestDeleteMeeting?(meetingId: string): void;
  onCancelDeleteMeeting?(): void;
  onConfirmDeleteMeeting?(): Promise<void>;
}

export function MeetingListSurface({
  layoutTier: requestedTier,
  compact,
  hostLabel,
  meetings,
  canCreate = false,
  canRecord = canCreate,
  recordingSetup,
  pending = false,
  error = null,
  hostConnectionStatus = "online",
  onRefresh,
  onRetryConnection,
  selectedMeetingId = null,
  transcript = null,
  transcriptLoading = false,
  transcriptError = null,
  consentStatus = "unknown",
  providerStatus,
  onOpenTranscript,
  onBack,
  onGrantTranscriptionConsent,
  onRetryTranscription,
  onCitation,
  citationEvidence = null,
  chatCatalog,
  chatCatalogError = null,
  chatProfiles = [],
  chatSelection = null,
  chatFeatures = null,
  chatFeaturesLoading = false,
  onChatSelectionBundle,
  chatProviders = [],
  chatThread = null,
  chatLoading = false,
  chatError = null,
  chatProvider = null,
  chatModel = null,
  onChatSelection,
  onAskQuestion,
  onRetryQuestion,
  onChangeHost,
  deleteConfirmationMeetingId = null,
  deletePending = false,
  deleteError = null,
  deleteDisabled = false,
  onRequestDeleteMeeting,
  onCancelDeleteMeeting,
  onConfirmDeleteMeeting,
}: MeetingListSurfaceProps) {
  const tier = requestedTier ?? (compact ? "phone" : "desktop");
  const [task, setTask] = useState<MeetingTask>("transcript");
  const [recordingSetupOpen, setRecordingSetupOpen] = useState(false);
  const [changeHostOpen, setChangeHostOpen] = useState(false);

  useEffect(() => {
    setTask("transcript");
  }, [selectedMeetingId]);

  useEffect(() => {
    if (!recordingSetup?.available) setRecordingSetupOpen(false);
  }, [recordingSetup?.available]);

  const selectedMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );
  const interactive = hostConnectionStatus === "online";
  const desktopMode = canRecord || canCreate;

  const openRecordingSetup = useCallback(() => {
    if (recordingSetup?.available) setRecordingSetupOpen(true);
  }, [recordingSetup?.available]);

  const requestChangeHost = useCallback(() => {
    if (onChangeHost) setChangeHostOpen(true);
  }, [onChangeHost]);

  const confirmChangeHost = useCallback(async () => {
    setChangeHostOpen(false);
    await onChangeHost?.();
  }, [onChangeHost]);

  const sidebar = (
    <MeetingSidebar
      canRecord={desktopMode}
      hostConnectionStatus={hostConnectionStatus}
      error={error}
      hostLabel={hostLabel}
      meetings={meetings}
      onOpenRecordingSetup={recordingSetup?.available ? openRecordingSetup : undefined}
      onOpenTranscript={interactive ? onOpenTranscript : undefined}
      onRefresh={onRefresh}
      onRetryConnection={onRetryConnection}
      pending={pending}
      selectedMeetingId={selectedMeetingId}
      onChangeHost={onChangeHost ? requestChangeHost : undefined}
    />
  );

  const detail = (
    <MeetingDetail
      layoutTier={tier}
      consentStatus={consentStatus}
      onBack={onBack}
      onCitation={interactive ? onCitation : undefined}
      citationEvidence={citationEvidence}
      chatCatalog={chatCatalog}
      chatCatalogError={chatCatalogError}
      chatProfiles={chatProfiles}
      chatSelection={chatSelection}
      chatFeatures={chatFeatures}
      chatFeaturesLoading={chatFeaturesLoading}
      onChatSelectionBundle={onChatSelectionBundle}
      onGrantTranscriptionConsent={onGrantTranscriptionConsent}
      onRetryTranscription={onRetryTranscription}
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
      onAskQuestion={interactive ? onAskQuestion : undefined}
      onRetryQuestion={interactive ? onRetryQuestion : undefined}
      hostConnectionStatus={hostConnectionStatus}
      interactive={interactive}
      onRetryConnection={onRetryConnection}
      onChangeHost={onChangeHost ? requestChangeHost : undefined}
      task={task}
      onTaskChange={setTask}
      deletePending={deletePending}
      deleteError={deleteError}
      deleteDisabled={deleteDisabled}
      onRequestDeleteMeeting={onRequestDeleteMeeting}
    />
  );

  return (
    <View style={styles.app} testID="meetless-product-root">
      <AppTopbar connectionStatus={hostConnectionStatus} />
      <View style={styles.main} testID={`meeting-layout-${tier}`}>
        {tier === "phone" ? (
          <>
            <View
              style={[styles.phoneList, selectedMeetingId && styles.hidden]}
              testID="phone-list-surface"
              aria-hidden={Boolean(selectedMeetingId)}
            >
              {sidebar}
            </View>
            <View
              style={[styles.phoneDetail, !selectedMeetingId && styles.hidden]}
              testID="phone-detail-surface"
              aria-hidden={!selectedMeetingId}
            >
              {detail}
            </View>
          </>
        ) : (
          <>
            <View style={[styles.sidebarPane, tier === "tablet" && styles.tabletSidebarPane]} testID="meeting-sidebar-pane">{sidebar}</View>
            <View style={styles.detailPane} testID="meeting-detail-pane">{detail}</View>
          </>
        )}
        {recordingSetupOpen && recordingSetup ? (
          <RecordingSetup
            controller={recordingSetup}
            onCancel={() => setRecordingSetupOpen(false)}
          />
        ) : null}
        {changeHostOpen && onChangeHost ? (
          <ChangeHostConfirmation
            onCancel={() => setChangeHostOpen(false)}
            onConfirm={confirmChangeHost}
          />
        ) : null}
        {deleteConfirmationMeetingId && onCancelDeleteMeeting && onConfirmDeleteMeeting ? (
          <DeleteMeetingConfirmation
            meeting={meetings.find((candidate) => candidate.id === deleteConfirmationMeetingId) ?? null}
            pending={deletePending}
            onCancel={onCancelDeleteMeeting}
            onConfirm={onConfirmDeleteMeeting}
          />
        ) : null}
      </View>
    </View>
  );
}

function AppTopbar({
  connectionStatus,
}: {
  connectionStatus: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
}) {
  const display = hostStatusCopy(connectionStatus);
  return (
    <View style={styles.topbar} testID="app-topbar">
      <ElectronTitlebarDragRegion regionID="app-titlebar-drag-region" />
      <View style={styles.brand}>
        <View style={styles.mark} accessibilityElementsHidden />
        <Text style={styles.brandText}>Meetless</Text>
      </View>
      <View style={[styles.hostChip, display.tone === "online" && styles.hostChipOnline, display.tone === "offline" && styles.hostChipOffline]}>
        <View style={styles.hostDot} accessibilityElementsHidden />
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel={display.label}
          style={styles.hostText}
          testID="connection-status"
        >
          {display.label}
        </Text>
      </View>
    </View>
  );
}

interface MeetingSidebarProps {
  canRecord: boolean;
  hostConnectionStatus: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
  error: string | null;
  hostLabel: string;
  meetings: MeetingWire[];
  onOpenRecordingSetup?: () => void;
  onOpenTranscript?: (meetingId: string) => Promise<void>;
  onRefresh(): Promise<void>;
  onRetryConnection?: () => Promise<void> | void;
  pending: boolean;
  selectedMeetingId: string | null;
  onChangeHost?: () => void | Promise<void>;
}

function MeetingSidebar({
  canRecord,
  hostConnectionStatus,
  error,
  hostLabel,
  meetings,
  onOpenRecordingSetup,
  onOpenTranscript,
  onRefresh,
  onRetryConnection,
  pending,
  selectedMeetingId,
  onChangeHost,
}: MeetingSidebarProps) {
  const interactive = hostConnectionStatus === "online";
  const groups = groupMeetings(meetings);
  return (
    <View style={styles.sidebar} testID="meeting-sidebar">
      <ScrollView
        scrollEnabled
        showsVerticalScrollIndicator={false}
        style={styles.sidebarScroll}
        contentContainerStyle={styles.sidebarContent}
        testID="meeting-surface"
      >
        <View style={styles.sidebarHead}>
          <Text style={styles.overline}>Meetings</Text>
          {canRecord && onOpenRecordingSetup ? (
            <FocusPressable
              accessibilityLabel="Record meeting"
              accessibilityRole="button"
              accessibilityState={{ disabled: pending }}
              disabled={pending}
              onPress={onOpenRecordingSetup}
              style={styles.primaryButtonSmall}
              testID="record-meeting-entry"
            >
              <Text style={styles.buttonText}>Record meeting</Text>
            </FocusPressable>
          ) : null}
        </View>
        <Text style={styles.libraryHint}>{canRecord ? "Local meeting library" : "Companion library · recording happens on desktop"}</Text>
        {hostConnectionStatus !== "online" ? (
          <ConnectionNotice
            status={hostConnectionStatus}
            onRetry={onRetryConnection}
            onChangeHost={onChangeHost}
            compact={false}
            testID={`host-${hostConnectionStatus}`}
          />
        ) : null}
        {error ? <Text style={styles.error} testID="meeting-error">We could not load the meeting library.</Text> : null}
        <View style={styles.list} testID="meeting-list">
          {groups.length === 0 && interactive ? (
            <View style={styles.emptyState} testID="meeting-empty">
              <Text style={styles.emptyTitle}>Your meetings live here</Text>
              <Text style={styles.emptyText}>Record a call to save local audio, read the transcript, and ask about the meeting.</Text>
              {canRecord && onOpenRecordingSetup ? (
                <FocusPressable accessibilityLabel="Record meeting" accessibilityRole="button" onPress={onOpenRecordingSetup} style={styles.secondaryButton} testID="empty-record-meeting">
                  <Text style={styles.secondaryButtonText}>Record meeting</Text>
                </FocusPressable>
              ) : null}
            </View>
          ) : groups.length === 0 ? (
            <View style={styles.emptyState} testID="meeting-state-unknown">
              <Text style={styles.emptyTitle}>Meetings unavailable while offline</Text>
              <Text style={styles.emptyText}>No validated meeting list is available yet.</Text>
            </View>
          ) : groups.map((group) => (
            <View key={group.label}>
              <Text style={styles.listGroup}>{group.label}</Text>
              {group.meetings.map((meeting) => {
                const selected = selectedMeetingId === meeting.id;
                const status = meetingStatusCopy(meeting.status);
                return (
                  <FocusPressable
                    key={meeting.id}
                    accessibilityLabel={`Open meeting ${meeting.title}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !onOpenTranscript, selected }}
                    aria-disabled={!onOpenTranscript}
                    aria-pressed={selected}
                    aria-selected={selected}
                    disabled={!onOpenTranscript}
                    onPress={onOpenTranscript ? () => void onOpenTranscript(meeting.id) : undefined}
                    style={[styles.meetingRow, selected && styles.meetingRowSelected, !onOpenTranscript && styles.meetingRowDisabled]}
                    testID={`meeting-${meeting.id}`}
                  >
                    <Text style={styles.cardTitle} numberOfLines={1}>{meeting.title}</Text>
                    <View style={styles.meetingMeta}>
                      <Text style={styles.metaText}>{formatMeetingDate(meeting.createdAt)}</Text>
                      <Text style={styles.meetingDot}>·</Text>
                      <View style={styles.statusInline}>
                        <View style={[styles.statusDot, status.tone === "ready" && styles.statusDotReady, status.tone === "working" && styles.statusDotWorking, status.tone === "attention" && styles.statusDotAttention]} />
                        <Text style={styles.statusText}>{status.label}</Text>
                      </View>
                    </View>
                  </FocusPressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.sidebarFoot}>
        <Text style={styles.sidebarFootText}>Stored on {hostLabel === "your isolated Meetless daemon" ? "this host" : hostLabel}</Text>
        {onChangeHost ? (
          <FocusPressable accessibilityLabel="Change host" accessibilityRole="button" onPress={() => void onChangeHost()} style={styles.ghostButton} testID="change-companion-host">
            <Text style={styles.ghostButtonText}>Change host</Text>
          </FocusPressable>
        ) : null}
        <FocusPressable accessibilityLabel={interactive ? "Refresh meetings" : "Try again"} accessibilityRole="button" disabled={pending || !interactive} onPress={() => void onRefresh()} style={styles.ghostButton} testID="meeting-refresh-button">
          <Text style={styles.ghostButtonText}>{interactive ? "Refresh" : "Try again"}</Text>
        </FocusPressable>
      </View>
    </View>
  );
}

function RecordingSetup({ controller, onCancel }: { controller: RecordingSetupController; onCancel(): void }) {
  const [title, setTitle] = useState("");
  const [permissionActionError, setPermissionActionError] = useState<string | null>(null);
  const runPermissionAction = async (operation: (() => Promise<void>) | undefined) => {
    setPermissionActionError(null);
    try {
      if (!operation) throw new Error("Permission recovery is unavailable");
      await operation();
    } catch {
      setPermissionActionError("Permission recovery failed. Try Recheck, or open Privacy & Security in System Settings manually.");
    }
  };
  const submit = async () => {
    const normalized = title.trim();
    if (!normalized || controller.pending) return;
    try {
      await controller.onStart(normalized);
      setTitle("");
      onCancel();
    } catch {
      // The recording provider owns the user-facing failure state.
    }
  };
  return (
    <View style={styles.setupBackdrop} testID="recording-setup" accessibilityViewIsModal>
      <View style={styles.setupPanel}>
        <Text accessibilityRole="header" style={styles.setupTitle}>Recording setup</Text>
        <Text style={styles.setupDescription}>One action starts capture. Microphone and system audio are selected for this meeting.</Text>
        <View style={styles.setupField}>
          <Text style={styles.fieldLabel}>Meeting title</Text>
          <FocusTextInput
            accessibilityLabel="Meeting title"
            autoFocus
            onChangeText={setTitle}
            placeholder="e.g. Design crit — weekly sync"
            placeholderTextColor={colors.muted}
            style={styles.input}
            testID="recording-setup-title"
            value={title}
          />
        </View>
        <Text style={styles.fieldLabel}>Audio sources</Text>
        <View style={styles.sourceList}>
          <SourceRow name="Microphone" description="Selected for your voice." status={controller.permissions?.microphone} />
          <SourceRow name="System audio" description="Selected for meeting audio." status={controller.permissions?.systemAudio} />
        </View>
        {controller.permissions && (controller.permissions.microphone === "denied" || controller.permissions.microphone === "restricted") ? (
          <PermissionGuidance
            source="microphone"
            label="Microphone"
            onOpen={() => runPermissionAction(() => controller.onOpenPermissionSettings?.("microphone") ?? Promise.reject(new Error("unavailable")))}
            onRecheck={() => runPermissionAction(controller.onRecheckPermissions)}
          />
        ) : null}
        {controller.permissions && (controller.permissions.systemAudio === "denied" || controller.permissions.systemAudio === "restricted") ? (
          <PermissionGuidance
            source="systemAudio"
            label="Screen & System Audio Recording"
            onOpen={() => runPermissionAction(() => controller.onOpenPermissionSettings?.("systemAudio") ?? Promise.reject(new Error("unavailable")))}
            onRecheck={() => runPermissionAction(controller.onRecheckPermissions)}
          />
        ) : null}
        {!controller.permissions ? <Text style={styles.proposedNotice}>Meetless checks both capture sources before recording starts.</Text> : null}
        {controller.permissions?.error || permissionActionError ? (
          <View testID="permission-guidance-unavailable">
            <Text style={styles.error} testID="permission-recovery-error">{permissionActionError ?? controller.permissions?.error}</Text>
            <FocusPressable
              accessibilityLabel="Recheck capture permissions"
              accessibilityRole="button"
              onPress={() => void runPermissionAction(controller.onRecheckPermissions)}
              style={styles.ghostButton}
              testID="permission-recheck-unavailable"
            >
              <Text style={styles.ghostButtonText}>Recheck access</Text>
            </FocusPressable>
          </View>
        ) : null}
        {controller.error ? <Text style={styles.error} testID="recording-setup-error">{recordingStartErrorCopy(controller.error)}</Text> : null}
        <View style={styles.setupActions}>
          <FocusPressable accessibilityLabel="Cancel recording setup" accessibilityRole="button" disabled={controller.pending} onPress={onCancel} style={styles.ghostButton} testID="recording-setup-cancel">
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </FocusPressable>
          <FocusPressable accessibilityLabel="Start recording" accessibilityRole="button" accessibilityState={{ disabled: controller.pending || controller.permissions?.checking || !title.trim() }} disabled={controller.pending || controller.permissions?.checking || !title.trim()} onPress={() => void submit()} style={styles.primaryButton} testID="recording-start">
            <Text style={styles.buttonText}>{controller.pending ? "Starting…" : "Start recording"}</Text>
          </FocusPressable>
        </View>
      </View>
    </View>
  );
}

function SourceRow({ name, description, status }: { name: string; description: string; status?: "authorized" | "notDetermined" | "denied" | "restricted" | null }) {
  return (
    <View style={styles.sourceRow} testID={`recording-source-${name.toLowerCase().replace(/\s+/gu, "-")}`}>
      <View style={styles.sourceCheck} accessibilityElementsHidden>•</View>
      <View style={styles.sourceCopy}>
        <Text style={styles.sourceName}>{name}</Text>
        <Text style={styles.sourceDescription}>{description}</Text>
      </View>
      <Text style={styles.proposedTag}>{status === "authorized" ? "Ready" : status === "denied" || status === "restricted" ? "Needs access" : status === "notDetermined" ? "Will ask" : "Proposed"}</Text>
    </View>
  );
}

function PermissionGuidance({ source, label, onOpen, onRecheck }: {
  source: "microphone" | "systemAudio";
  label: string;
  onOpen(): Promise<void>;
  onRecheck(): Promise<void>;
}) {
  return (
    <View testID={`permission-guidance-${source}`}>
      <Text style={styles.error}>{label} access is off. Open System Settings, allow Meetless, return here, then recheck.</Text>
      <View style={styles.setupActions}>
        <FocusPressable accessibilityLabel={`Open ${label} settings`} accessibilityRole="button" onPress={() => void onOpen()} style={styles.ghostButton} testID={`permission-settings-${source}`}>
          <Text style={styles.ghostButtonText}>Open System Settings</Text>
        </FocusPressable>
        <FocusPressable accessibilityLabel={`Recheck ${label} access`} accessibilityRole="button" onPress={() => void onRecheck()} style={styles.ghostButton} testID={`permission-recheck-${source}`}>
          <Text style={styles.ghostButtonText}>Recheck access</Text>
        </FocusPressable>
      </View>
    </View>
  );
}

interface MeetingDetailProps {
  layoutTier: LayoutTier;
  consentStatus: "unknown" | "granted";
  onBack?: () => void;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  citationEvidence: CitationEvidenceState | null;
  chatCatalog?: ChatControlsCatalogWire;
  chatCatalogError: ChatCapabilityErrorWire | null;
  chatProfiles: ChatProfileWire[];
  chatSelection: ChatSelectionWire | null;
  chatFeatures: ChatFeatureDiscoveryWire | null;
  chatFeaturesLoading: boolean;
  onChatSelectionBundle?: (selection: ChatSelectionWire) => void | Promise<void>;
  onGrantTranscriptionConsent?: () => Promise<void>;
  onRetryTranscription?: () => Promise<void>;
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
  hostConnectionStatus: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
  interactive: boolean;
  onRetryConnection?: () => Promise<void> | void;
  onChangeHost?: () => void | Promise<void>;
  task: MeetingTask;
  onTaskChange(task: MeetingTask): void;
  deletePending: boolean;
  deleteError: string | null;
  deleteDisabled: boolean;
  onRequestDeleteMeeting?: (meetingId: string) => void;
}

function MeetingDetail(props: MeetingDetailProps) {
  const {
    layoutTier,
    consentStatus,
    onBack,
    onCitation,
    citationEvidence,
    chatCatalog,
    chatCatalogError,
    chatProfiles,
    chatSelection,
    chatFeatures,
    chatFeaturesLoading,
    onChatSelectionBundle,
    onGrantTranscriptionConsent,
    onRetryTranscription,
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
    hostConnectionStatus,
    interactive,
    onRetryConnection,
    onChangeHost,
    task,
    onTaskChange,
    deletePending,
    deleteError,
    deleteDisabled,
    onRequestDeleteMeeting,
  } = props;

  if (!selectedMeetingId && !transcript) {
    return (
      <View style={styles.detailPlaceholder} testID="meeting-detail-empty">
        <Text accessibilityRole="header" style={styles.detailPlaceholderTitle}>Select a meeting</Text>
        <Text style={styles.detailPlaceholderText}>Choose a meeting to read its transcript or ask a question.</Text>
      </View>
    );
  }

  const title = selectedMeeting?.title ?? "Meeting";
  const detailStatus = selectedMeeting ? meetingStatusCopy(selectedMeeting.status).label : "Meeting";
  const duration = transcript ? formatDuration(transcript.audioDurationMs) : null;
  const showTranscript = layoutTier === "desktop" || task === "transcript";
  const showAsk = layoutTier === "desktop" || task === "ask";
  return (
    <View style={styles.detail} testID="meeting-detail">
      <View style={styles.detailHeader} testID="meeting-detail-header">
        {layoutTier === "phone" ? (
          <FocusPressable accessibilityLabel="Back to meetings" accessibilityRole="button" onPress={() => onBack?.()} style={styles.backButton} testID="meeting-detail-back">
            <Text style={styles.backButtonText}>‹ Back</Text>
          </FocusPressable>
        ) : null}
        <View style={styles.detailHeading}>
          <Text accessibilityRole="header" style={styles.detailTitle} numberOfLines={2}>{title}</Text>
          <View style={styles.detailMeta}>
            <Text style={styles.metaText}>{formatMeetingDate(selectedMeeting?.createdAt)}</Text>
            {duration ? <Text style={styles.metaText}>{duration}</Text> : null}
            <Text style={styles.statusText}>{detailStatus}</Text>
          </View>
        </View>
        {selectedMeeting && onRequestDeleteMeeting ? (
          <FocusPressable
            accessibilityLabel={`Delete ${selectedMeeting.title}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: deleteDisabled }}
            disabled={deleteDisabled}
            onPress={() => onRequestDeleteMeeting(selectedMeeting.id)}
            style={styles.ghostButton}
            testID="meeting-delete-action"
          >
            <Text style={styles.dangerButtonText}>{deletePending ? "Deleting…" : "Delete"}</Text>
          </FocusPressable>
        ) : null}
        {onChangeHost ? (
          <FocusPressable accessibilityLabel="Change host" accessibilityRole="button" onPress={() => void onChangeHost()} style={styles.ghostButton} testID="detail-change-companion-host">
            <Text style={styles.ghostButtonText}>Change host</Text>
          </FocusPressable>
        ) : null}
      </View>
      {!interactive ? (
        <ConnectionNotice
          status={hostConnectionStatus}
          onRetry={onRetryConnection}
          onChangeHost={onChangeHost}
          compact
          testID={`detail-host-${hostConnectionStatus}`}
        />
      ) : null}
      {deleteError ? <Text accessibilityRole="alert" style={styles.error} testID="meeting-delete-error">{deleteError}</Text> : null}
      {layoutTier !== "desktop" ? <TaskSwitcher task={task} onTaskChange={onTaskChange} /> : null}
      <View style={[styles.detailContent, layoutTier === "desktop" && styles.desktopDetailContent]}>
        {showTranscript ? (
          <TranscriptPane
            layoutTier={layoutTier}
            interactive={interactive}
            consentStatus={consentStatus}
            onGrantTranscriptionConsent={onGrantTranscriptionConsent}
            onRetryTranscription={onRetryTranscription}
            pending={pending}
            providerStatus={providerStatus}
            selectedMeeting={selectedMeeting}
            transcript={transcript}
            transcriptError={transcriptError}
            transcriptLoading={transcriptLoading}
            onCitation={onCitation}
            citationEvidence={layoutTier === "desktop" || task === "transcript" ? citationEvidence : null}
            testID="transcript-pane"
          />
        ) : null}
        {showAsk ? (
          <AskPane
            layoutTier={layoutTier}
            interactive={interactive}
            transcript={transcript}
            chatCatalog={chatCatalog}
            chatCatalogError={chatCatalogError}
            chatProfiles={chatProfiles}
            chatSelection={chatSelection}
            chatFeatures={chatFeatures}
            chatFeaturesLoading={chatFeaturesLoading}
            onChatSelectionBundle={onChatSelectionBundle}
            chatProviders={chatProviders}
            chatThread={chatThread}
            chatLoading={chatLoading}
            chatError={chatError}
            chatProvider={chatProvider}
            chatModel={chatModel}
            onChatSelection={onChatSelection}
            onAskQuestion={onAskQuestion}
            onRetryQuestion={onRetryQuestion}
            onCitation={onCitation}
            citationEvidence={layoutTier === "desktop" || task === "ask" ? citationEvidence : null}
            testID="ask-pane"
          />
        ) : null}
      </View>
    </View>
  );
}

function DeleteMeetingConfirmation({
  meeting,
  pending,
  onCancel,
  onConfirm,
}: {
  meeting: MeetingWire | null;
  pending: boolean;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  if (!meeting) return null;
  return (
    <View style={styles.setupBackdrop} testID="meeting-delete-confirmation" accessibilityViewIsModal>
      <View style={styles.setupPanel}>
        <Text accessibilityRole="header" style={styles.setupTitle}>Delete “{meeting.title}”?</Text>
        <Text style={styles.setupDescription}>This permanently deletes the meeting, its audio, transcript, and chat. You cannot undo this action.</Text>
        <View style={styles.setupActions}>
          <FocusPressable accessibilityLabel="Cancel deletion" accessibilityRole="button" disabled={pending} onPress={onCancel} style={styles.ghostButton} testID="meeting-delete-cancel">
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </FocusPressable>
          <FocusPressable accessibilityLabel={`Permanently delete ${meeting.title}`} accessibilityRole="button" accessibilityState={{ disabled: pending }} disabled={pending} onPress={() => void onConfirm()} style={styles.primaryButton} testID="meeting-delete-confirm">
            <Text style={styles.buttonText}>{pending ? "Deleting…" : "Delete"}</Text>
          </FocusPressable>
        </View>
      </View>
    </View>
  );
}

function ChangeHostConfirmation({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): Promise<void> }) {
  return (
    <View style={styles.setupBackdrop} testID="change-host-confirmation" accessibilityViewIsModal>
      <View style={styles.setupPanel}>
        <Text accessibilityRole="header" style={styles.setupTitle}>Change host?</Text>
        <Text style={styles.setupDescription}>
          This replaces the saved pairing information on this device. Your meetings remain on the desktop host.
        </Text>
        <View style={styles.setupActions}>
          <FocusPressable
            accessibilityLabel="Keep pairing"
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.ghostButton}
            testID="change-host-cancel"
          >
            <Text style={styles.ghostButtonText}>Keep pairing</Text>
          </FocusPressable>
          <FocusPressable
            accessibilityLabel="Change host"
            accessibilityRole="button"
            onPress={() => void onConfirm()}
            style={styles.primaryButton}
            testID="change-host-confirm"
          >
            <Text style={styles.buttonText}>Change host</Text>
          </FocusPressable>
        </View>
      </View>
    </View>
  );
}

function ConnectionNotice({
  status,
  onRetry,
  onChangeHost,
  compact,
  testID,
}: {
  status: "online" | "connecting" | "reconnecting" | "offline" | "revalidating";
  onRetry?: () => Promise<void> | void;
  onChangeHost?: () => void | Promise<void>;
  compact: boolean;
  testID: string;
}) {
  const offline = status === "offline";
  return (
    <View style={[styles.connectionNotice, compact && styles.connectionNoticeCompact]} accessibilityLiveRegion="polite" testID={testID}>
      <Text accessibilityRole="alert" style={styles.connectionNoticeTitle}>{offline ? "Host offline" : hostStatusCopy(status).label}</Text>
      <Text style={styles.connectionNoticeText}>
        {offline ? "Known meetings remain visible as stale context. Actions stay disabled until the host is revalidated." : hostStatusCopy(status).detail}
      </Text>
      <View style={styles.noticeActions}>
        {offline && onRetry ? <FocusPressable accessibilityLabel="Try again" accessibilityRole="button" onPress={() => void onRetry()} style={styles.secondaryButtonSmall} testID={`${testID}-try-again`}><Text style={styles.secondaryButtonText}>Try again</Text></FocusPressable> : null}
        {onChangeHost ? <FocusPressable accessibilityLabel="Change host" accessibilityRole="button" onPress={() => void onChangeHost()} style={styles.ghostButton} testID={`${testID}-change-host`}><Text style={styles.ghostButtonText}>Change host</Text></FocusPressable> : null}
      </View>
    </View>
  );
}

function TaskSwitcher({ task, onTaskChange }: { task: MeetingTask; onTaskChange(task: MeetingTask): void }) {
  return (
    <View style={styles.taskSwitcher} testID="task-switcher">
      {(["transcript", "ask"] as const).map((candidate) => {
        const selected = task === candidate;
        const label = candidate === "transcript" ? "Transcript" : "Ask";
        return (
          <FocusPressable
            key={candidate}
            accessibilityLabel={label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            aria-pressed={selected}
            aria-selected={selected}
            onPress={() => onTaskChange(candidate)}
            style={[styles.taskTab, selected && styles.taskTabSelected]}
            testID={`task-tab-${candidate}`}
          >
            <Text style={[styles.taskTabText, selected && styles.taskTabTextSelected]}>{label}</Text>
          </FocusPressable>
        );
      })}
    </View>
  );
}

function TranscriptPane({
  layoutTier,
  interactive,
  consentStatus,
  onGrantTranscriptionConsent,
  onRetryTranscription,
  pending,
  providerStatus,
  selectedMeeting,
  transcript,
  transcriptError,
  transcriptLoading,
  onCitation,
  citationEvidence,
  testID,
}: {
  layoutTier: LayoutTier;
  interactive: boolean;
  consentStatus: "unknown" | "granted";
  onGrantTranscriptionConsent?: () => Promise<void>;
  onRetryTranscription?: () => Promise<void>;
  pending: boolean;
  providerStatus?: TranscriptionProviderStatusWire["status"];
  selectedMeeting: MeetingWire | null;
  transcript: TranscriptWire | null;
  transcriptError: string | null;
  transcriptLoading: boolean;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  citationEvidence: CitationEvidenceState | null;
  testID: string;
}) {
  return (
    <View style={[styles.pane, layoutTier === "desktop" && styles.transcriptPane]} testID={testID}>
      <View style={styles.paneHead}><Text style={styles.paneTitle}>Transcript</Text></View>
      <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneScrollContent} testID={layoutTier === "desktop" ? "transcript-pane-scroll" : "transcript-detail-scroll"}>
        {consentStatus !== "granted" && onGrantTranscriptionConsent && !transcriptLoading ? (
          <View style={styles.disclosure} testID="transcription-disclosure">
            <Text style={styles.disclosureTitle}>Your recording is saved locally.</Text>
            <Text style={styles.disclosureText}>To create the transcript, the saved MP3 will be sent to OpenAI for one-time cloud transcription. Ask stays unavailable until the transcript is ready.</Text>
            <FocusPressable accessibilityLabel="Allow cloud transcription" accessibilityRole="button" accessibilityState={{ disabled: pending || !interactive }} disabled={pending || !interactive} onPress={() => void onGrantTranscriptionConsent()} style={styles.primaryButton} testID="transcription-consent"><Text style={styles.buttonText}>Allow cloud transcription</Text></FocusPressable>
          </View>
        ) : null}
        <TranscriptState
          interactive={interactive}
          onCitation={interactive ? onCitation : undefined}
          selectedMeeting={selectedMeeting}
          transcript={transcript}
          transcriptError={transcriptError}
          transcriptLoading={transcriptLoading}
          providerStatus={providerStatus}
          onRetryTranscription={onRetryTranscription}
          highlightedSegmentId={citationEvidence?.segmentId ?? null}
        />
      </ScrollView>
    </View>
  );
}

function AskPane({
  layoutTier,
  interactive,
  transcript,
  chatCatalog,
  chatCatalogError,
  chatProfiles,
  chatSelection,
  chatFeatures,
  chatFeaturesLoading,
  onChatSelectionBundle,
  chatProviders,
  chatThread,
  chatLoading,
  chatError,
  chatProvider,
  chatModel,
  onChatSelection,
  onAskQuestion,
  onRetryQuestion,
  onCitation,
  citationEvidence,
  testID,
}: {
  layoutTier: LayoutTier;
  interactive: boolean;
  transcript: TranscriptWire | null;
  chatCatalog?: ChatControlsCatalogWire;
  chatCatalogError: ChatCapabilityErrorWire | null;
  chatProfiles: ChatProfileWire[];
  chatSelection: ChatSelectionWire | null;
  chatFeatures: ChatFeatureDiscoveryWire | null;
  chatFeaturesLoading: boolean;
  onChatSelectionBundle?: (selection: ChatSelectionWire) => void | Promise<void>;
  chatProviders: ChatProviderWire[];
  chatThread: MeetingChatThreadWire | null;
  chatLoading: boolean;
  chatError: string | null;
  chatProvider: string | null;
  chatModel: string | null;
  onChatSelection?: (provider: string, model: string) => void;
  onAskQuestion?: (question: string) => Promise<void>;
  onRetryQuestion?: () => Promise<void>;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  citationEvidence: CitationEvidenceState | null;
  testID: string;
}) {
  return (
    <View style={[styles.pane, layoutTier === "desktop" && styles.askPane]} testID={testID}>
      <View style={styles.paneHead}>
        <View style={styles.askHeading}><Text style={styles.paneTitle}>Ask</Text><Text style={styles.askScope}>This meeting only</Text></View>
        {!chatCatalog ? <ProviderPicker
          interactive={interactive}
          model={chatModel}
          onSelection={onChatSelection}
          provider={chatProvider}
          providers={chatProviders}
        /> : null}
      </View>
      <MeetingChatPanel
        interactive={interactive}
        layoutTier={layoutTier}
        loading={chatLoading}
        model={chatModel}
        chatCatalog={chatCatalog}
        chatCatalogError={chatCatalogError}
        chatProfiles={chatProfiles}
        chatSelection={chatSelection}
        chatFeatures={chatFeatures}
        chatFeaturesLoading={chatFeaturesLoading}
        onChatSelection={onChatSelectionBundle}
        onAsk={onAskQuestion}
        onCitation={onCitation}
        onRetry={onRetryQuestion}
        provider={chatProvider}
        providers={chatProviders}
        thread={chatThread}
        transcript={transcript}
        error={chatError}
        citationEvidence={citationEvidence}
      />
    </View>
  );
}

function ProviderPicker({
  interactive,
  model,
  onSelection,
  provider,
  providers,
}: {
  interactive: boolean;
  model: string | null;
  onSelection?: (provider: string, model: string) => void;
  provider: string | null;
  providers: ChatProviderWire[];
}) {
  const [open, setOpen] = useState(false);
  const [invalidSelectionDismissed, setInvalidSelectionDismissed] = useState(false);
  const pickerRef = useRef<View | null>(null);
  const selectedProvider = providers.find((candidate) => candidate.id === provider) ?? null;
  const selectedModel = selectedProvider?.models.find((candidate) => candidate.id === model) ?? null;
  const selectionValid = selectedProvider !== null && selectedModel !== null;
  const optionsVisible = providers.length > 0 && (open || (!selectionValid && !invalidSelectionDismissed));
  const label = selectedProvider && selectedModel ? `${selectedProvider.label} · ${selectedModel.label}` : "Choose provider/model";

  const closePicker = useCallback(() => {
    setOpen(false);
    setInvalidSelectionDismissed(true);
  }, []);

  useEffect(() => {
    setInvalidSelectionDismissed(false);
  }, [model, provider, providers]);

  useEffect(() => {
    if (!optionsVisible || typeof document === "undefined") return;

    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const pickerNode = pickerRef.current as unknown as {
        contains?: (target: EventTarget | null) => boolean;
      } | null;
      if (pickerNode?.contains?.(event.target)) return;
      closePicker();
    };

    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointer, true);
  }, [closePicker, optionsVisible]);

  return (
    <View ref={pickerRef} style={styles.providerPicker} testID="chat-provider-picker">
      <FocusPressable
        accessibilityLabel={`Provider and model: ${label}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: !interactive || !providers.length, expanded: optionsVisible }}
        aria-expanded={optionsVisible}
        disabled={!interactive || !providers.length}
        onPress={() => {
          if (optionsVisible) {
            closePicker();
            return;
          }
          setInvalidSelectionDismissed(false);
          setOpen(true);
        }}
        style={styles.providerChip}
        testID="chat-provider-trigger"
      >
        <Text style={styles.providerChipText} numberOfLines={1}>{label}</Text>
        <Text style={styles.providerChevron} accessibilityElementsHidden>⌄</Text>
      </FocusPressable>
      <View style={[styles.pickerOptions, !optionsVisible && styles.hidden]} testID="chat-provider-options" aria-hidden={!optionsVisible}>
        {providers.map((option) => option.models.map((candidate) => {
          const selected = provider === option.id && model === candidate.id;
          return (
            <FocusPressable
              key={`${option.id}-${candidate.id}`}
              accessibilityLabel={`${option.label}, ${candidate.label}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !interactive || !onSelection || !optionsVisible, selected }}
              aria-pressed={selected}
              aria-selected={selected}
              disabled={!interactive || !onSelection || !optionsVisible}
              onPress={() => {
                onSelection?.(option.id, candidate.id);
                closePicker();
              }}
              style={[styles.providerOption, selected && styles.providerOptionSelected]}
              testID={`chat-model-${option.id}-${candidate.id}`}
            >
              <Text style={styles.providerOptionText}>{option.label} · {candidate.label}</Text>
            </FocusPressable>
          );
        }))}
      </View>
    </View>
  );
}

function ChatControls({
  catalog,
  catalogError,
  features,
  featuresLoading,
  interactive,
  layoutTier,
  onSelection,
  profiles,
  selection,
}: {
  catalog: ChatControlsCatalogWire;
  catalogError: ChatCapabilityErrorWire | null;
  features: ChatFeatureDiscoveryWire | null;
  featuresLoading: boolean;
  interactive: boolean;
  layoutTier: LayoutTier;
  onSelection?: (selection: ChatSelectionWire) => void | Promise<void>;
  profiles: ChatProfileWire[];
  selection: ChatSelectionWire | null;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "provider">("root");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [featureId, setFeatureId] = useState<string | null>(null);
  const [pickerGeometry, setPickerGeometry] = useState<ChatPickerGeometry | null>(null);
  const pickerRef = useRef<View | null>(null);
  const pickerPopupRef = useRef<View | null>(null);
  const selectedProvider = selection ? catalog.providers.find((candidate) => candidate.id === selection.provider) ?? null : null;
  const selectedModel = selectedProvider?.models.find((candidate) => candidate.id === selection?.model) ?? null;
  const currentThinking = selectedModel?.thinkingOptions.find((candidate) => candidate.id === selection?.thinkingOptionId) ?? null;
  const fastFeature = features?.status === "ready"
    ? features.features?.find((feature) => /fast/u.test(`${feature.id} ${feature.label}`)) ?? null
    : null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProfiles = profiles.filter((profile) => {
    if (!normalizedQuery) return true;
    return `${profile.name} ${profile.id} ${profile.selection.provider} ${profile.selection.model}`.toLocaleLowerCase().includes(normalizedQuery);
  });
  const visibleProviders = catalog.providers.filter((provider) => {
    if (!normalizedQuery) return true;
    return `${provider.label} ${provider.id} ${provider.models.map((model) => `${model.label} ${model.id}`).join(" ")}`.toLocaleLowerCase().includes(normalizedQuery);
  });

  const focusTrigger = useCallback(() => {
    const node = pickerRef.current as unknown as { querySelector?: (selector: string) => { focus?: () => void } | null } | null;
    node?.querySelector?.("button")?.focus?.();
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setView("root");
    setProviderId(null);
    setQuery("");
    setThinkingOpen(false);
    setFeatureId(null);
    focusTrigger();
  }, [focusTrigger]);

  const positionPicker = useCallback(() => {
    if (layoutTier === "phone" || Platform.OS !== "web" || typeof window === "undefined") return;
    const node = pickerRef.current as unknown as {
      querySelector?: (selector: string) => { getBoundingClientRect?: () => ChatPickerAnchorRect } | null;
    } | null;
    const popupNode = pickerPopupRef.current as unknown as {
      getBoundingClientRect?: () => { height: number };
      style?: { maxHeight: string };
    } | null;
    const triggerRect = node?.querySelector?.("button")?.getBoundingClientRect?.();
    if (!triggerRect || !popupNode?.getBoundingClientRect) return;
    const previousMaxHeight = popupNode.style?.maxHeight;
    if (popupNode.style) popupNode.style.maxHeight = `${CHAT_PICKER_MAX_HEIGHT}px`;
    const contentHeight = popupNode.getBoundingClientRect().height;
    if (popupNode.style) popupNode.style.maxHeight = previousMaxHeight ?? "";
    const next = chatPickerGeometry(
      triggerRect,
      { width: window.innerWidth, height: window.innerHeight },
      contentHeight,
    );
    setPickerGeometry((current) => current
      && current.top === next.top
      && current.left === next.left
      && current.width === next.width
      && current.maxHeight === next.maxHeight
      && current.placement === next.placement
      ? current
      : next);
  }, [layoutTier]);

  useLayoutEffect(() => {
    if (!open || layoutTier === "phone" || Platform.OS !== "web" || typeof window === "undefined") return;
    positionPicker();
  }, [catalog.providers, catalogError, layoutTier, open, positionPicker, profiles, providerId, query, view]);

  useEffect(() => {
    if (!open || layoutTier === "phone" || Platform.OS !== "web" || typeof window === "undefined") return;
    window.addEventListener("resize", positionPicker);
    window.addEventListener("scroll", positionPicker, true);
    return () => {
      window.removeEventListener("resize", positionPicker);
      window.removeEventListener("scroll", positionPicker, true);
    };
  }, [layoutTier, open, positionPicker]);

  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const node = pickerRef.current as unknown as { contains?: (target: EventTarget | null) => boolean } | null;
      if (!node?.contains?.(event.target)) close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    if (view === "provider" && !catalog.providers.some((provider) => provider.id === providerId)) {
      setView("root");
      setProviderId(null);
    }
  }, [catalog.providers, open, providerId, view]);

  const apply = useCallback(async (next: ChatSelectionWire) => {
    await onSelection?.(next);
    close();
  }, [close, onSelection]);

  const applyModel = useCallback((provider: ChatControlProviderWire, model: ChatControlModelWire) => {
    const next: ChatSelectionWire = {
      provider: provider.id,
      model: model.id,
      modeId: provider.defaultModeId,
      thinkingOptionId: model.defaultThinkingOptionId,
      featureValues: {},
    };
    void apply(next);
  }, [apply]);

  const applyThinking = useCallback((thinkingOptionId: string | null) => {
    if (!selection) return;
    void apply({ ...cloneSurfaceSelection(selection), thinkingOptionId });
  }, [apply, selection]);

  const toggleFeature = useCallback((feature: NonNullable<ChatFeatureDiscoveryWire["features"]>[number]) => {
    if (!selection || feature.type !== "toggle") return;
    void apply({
      ...cloneSurfaceSelection(selection),
      featureValues: { ...selection.featureValues, [feature.id]: !feature.value },
    });
  }, [apply, selection]);

  const chooseFeature = useCallback((feature: NonNullable<ChatFeatureDiscoveryWire["features"]>[number], value: string | null) => {
    if (!selection || feature.type !== "select") return;
    void apply({
      ...cloneSurfaceSelection(selection),
      featureValues: { ...selection.featureValues, [feature.id]: value },
    });
  }, [apply, selection]);

  const pickerProvider = providerId ? catalog.providers.find((provider) => provider.id === providerId) ?? null : null;
  const modelLabel = selectedProvider && selectedModel
    ? selectedModel.label
    : selection
      ? "Model unavailable"
      : "Choose model";
  const modelTriggerDisabled = !interactive || Boolean(catalogError);
  const availableFeatures = features?.status === "ready" ? features.features ?? [] : [];
  return (
    <View style={styles.chatControls} testID="chat-controls">
      <View style={styles.chatControlsRow}>
        <View ref={pickerRef} style={styles.chatModelControl}>
          <FocusPressable
            accessibilityLabel={`Model: ${modelLabel}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: modelTriggerDisabled, expanded: open }}
            aria-expanded={open}
            disabled={modelTriggerDisabled}
            onPress={() => { setOpen((current) => !current); setThinkingOpen(false); setFeatureId(null); }}
            style={[styles.chatModelPill, layoutTier === "phone" && styles.chatPhoneTarget, !selectedModel && styles.chatModelPillUnavailable]}
            testID="chat-model-trigger"
          >
            <Text style={styles.chatModelPillText} numberOfLines={1}>{modelLabel}</Text>
            <Text style={styles.providerChevron} accessibilityElementsHidden>⌄</Text>
          </FocusPressable>
          {open ? (
            <>
              {layoutTier === "phone" ? (
                <FocusPressable
                  accessibilityLabel="Close model picker"
                  accessibilityRole="button"
                  onPress={close}
                  style={styles.chatPickerBackdrop}
                  testID="chat-picker-dismiss"
                />
              ) : null}
              <View
                ref={pickerPopupRef}
                style={[
                  styles.chatPicker,
                  layoutTier === "phone"
                    ? styles.chatPickerPhone
                    : Platform.OS === "web"
                      ? [styles.chatPickerViewport, pickerGeometry ? {
                          top: pickerGeometry.top,
                          left: pickerGeometry.left,
                          width: pickerGeometry.width,
                          maxHeight: pickerGeometry.maxHeight,
                        } : styles.chatPickerViewportPending]
                      : styles.chatPickerNative,
                ]}
                testID="chat-model-picker"
                accessibilityViewIsModal
              >
              <View style={styles.chatPickerHeader}>
                {view === "provider" ? (
                  <FocusPressable accessibilityLabel="Back to model providers" accessibilityRole="button" onPress={() => { setView("root"); setProviderId(null); }} style={[styles.chatPickerBack, layoutTier === "phone" && styles.chatPhoneTargetSquare]} testID="chat-picker-back">
                    <Text style={styles.chatPickerBackText}>‹</Text>
                  </FocusPressable>
                ) : null}
                <FocusTextInput
                  accessibilityLabel="Search all models"
                  autoFocus
                  autoCorrect={false}
                  onChangeText={setQuery}
                  placeholder="Search all models"
                  placeholderTextColor={colors.muted}
                  style={[styles.chatPickerSearch, layoutTier === "phone" && styles.chatPhoneTarget]}
                  testID="chat-model-search"
                  value={query}
                />
              </View>
              {view === "root" ? (
                <ScrollView style={styles.chatPickerScroll} keyboardShouldPersistTaps="handled">
                  {visibleProfiles.length > 0 ? <Text style={styles.chatPickerSection}>Profiles</Text> : null}
                  {visibleProfiles.map((profile) => {
                    const selected = Boolean(selection && sameSurfaceSelection(selection, profile.selection));
                    return (
                      <FocusPressable
                        key={profile.id}
                        accessibilityLabel={`Profile ${profile.name}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        aria-selected={selected}
                        onPress={() => void apply(profile.selection)}
                        style={[styles.chatPickerOption, selected && styles.chatPickerOptionSelected]}
                        testID={`chat-profile-${profile.id}`}
                      >
                        <View style={styles.chatPickerOptionCopy}>
                          <Text style={styles.chatPickerOptionTitle}>{profile.icon ? `${profile.icon} ` : ""}{profile.name}</Text>
                          <Text style={styles.chatPickerOptionMeta}>{profile.selection.model}</Text>
                        </View>
                        {selected ? <Text style={styles.chatPickerCheck}>✓</Text> : null}
                      </FocusPressable>
                    );
                  })}
                  <Text style={styles.chatPickerSection}>Providers</Text>
                  {visibleProviders.map((provider) => (
                    <FocusPressable
                      key={provider.id}
                      accessibilityLabel={`Browse ${provider.label} models`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: provider.status !== "ready", expanded: providerId === provider.id }}
                      disabled={provider.status !== "ready"}
                      onPress={() => { setProviderId(provider.id); setView("provider"); setQuery(""); }}
                      style={styles.chatPickerOption}
                      testID={`chat-provider-${provider.id}`}
                    >
                      <View style={styles.chatPickerOptionCopy}>
                        <Text style={styles.chatPickerOptionTitle}>{provider.label}</Text>
                        <Text style={styles.chatPickerOptionMeta}>{provider.status === "ready" ? `${provider.models.length} models` : provider.error ?? "Unavailable"}</Text>
                      </View>
                      <Text style={styles.providerChevron} accessibilityElementsHidden>›</Text>
                    </FocusPressable>
                  ))}
                  {!visibleProfiles.length && !visibleProviders.length ? <Text style={styles.chatPickerEmpty}>No matching models.</Text> : null}
                  {catalogError ? <Text style={styles.chatPickerError}>{catalogError.message}</Text> : null}
                </ScrollView>
              ) : (
                <ScrollView style={styles.chatPickerScroll} keyboardShouldPersistTaps="handled">
                  <Text style={styles.chatPickerSection}>{pickerProvider?.label ?? "Provider"}</Text>
                  {pickerProvider?.models.filter((model) => !normalizedQuery || `${model.label} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery)).map((model) => {
                    const selected = selection?.provider === pickerProvider.id && selection.model === model.id;
                    return (
                      <FocusPressable
                        key={model.id}
                        accessibilityLabel={`${pickerProvider.label}, ${model.label}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        aria-selected={selected}
                        onPress={() => applyModel(pickerProvider, model)}
                        style={[styles.chatPickerOption, selected && styles.chatPickerOptionSelected]}
                        testID={`chat-model-${pickerProvider.id}-${model.id}`}
                      >
                        <View style={styles.chatPickerOptionCopy}>
                          <Text style={styles.chatPickerOptionTitle}>{model.label}</Text>
                          <Text style={styles.chatPickerOptionMeta}>{model.id}</Text>
                        </View>
                        {selected ? <Text style={styles.chatPickerCheck}>✓</Text> : null}
                      </FocusPressable>
                    );
                  })}
                </ScrollView>
              )}
              </View>
            </>
          ) : null}
        </View>
        {selectedModel && selectedModel.thinkingOptions.length > 0 ? (
          <View style={styles.chatThinkingControl}>
            <FocusPressable
              accessibilityLabel={`Thinking: ${currentThinking?.label ?? "Choose"}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !interactive || !selection, expanded: thinkingOpen }}
              aria-expanded={thinkingOpen}
              disabled={!interactive || !selection}
              onPress={() => { setThinkingOpen((current) => !current); setOpen(false); setFeatureId(null); }}
              style={[styles.chatSecondaryPill, layoutTier === "phone" && styles.chatPhoneTarget]}
              testID="chat-thinking-trigger"
            >
              <Text style={styles.chatSecondaryPillText} numberOfLines={1}>{currentThinking?.label ?? "Thinking"}</Text>
              <Text style={styles.providerChevron} accessibilityElementsHidden>⌄</Text>
            </FocusPressable>
            {thinkingOpen ? <View style={styles.chatMiniMenu} testID="chat-thinking-menu">
              {selectedModel.thinkingOptions.map((option) => (
                <FocusPressable
                  key={option.id}
                  accessibilityLabel={`Thinking ${option.label}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selection?.thinkingOptionId === option.id }}
                  onPress={() => applyThinking(option.id)}
                  style={styles.chatMiniOption}
                  testID={`chat-thinking-${option.id}`}
                >
                  <Text style={styles.chatPickerOptionText}>{option.label}</Text>
                </FocusPressable>
              ))}
            </View> : null}
          </View>
        ) : null}
        {fastFeature?.type === "toggle" ? (
          <FocusPressable
            accessibilityLabel={`Fast ${fastFeature.value ? "on" : "off"}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !interactive || !selection, selected: fastFeature.value }}
            aria-pressed={fastFeature.value}
            disabled={!interactive || !selection}
            onPress={() => toggleFeature(fastFeature)}
            style={[styles.chatSecondaryPill, layoutTier === "phone" && styles.chatPhoneTarget, fastFeature.value && styles.chatSecondaryPillSelected]}
            testID="chat-fast-toggle"
          >
            <Text style={styles.chatSecondaryPillText}>Fast</Text>
          </FocusPressable>
        ) : null}
        {availableFeatures.filter((feature) => feature !== fastFeature).map((feature) => feature.type === "toggle" ? (
          <FocusPressable
            key={feature.id}
            accessibilityLabel={`${feature.label} ${feature.value ? "on" : "off"}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !interactive || !selection, selected: feature.value }}
            disabled={!interactive || !selection}
            onPress={() => toggleFeature(feature)}
            style={[styles.chatSecondaryPill, layoutTier === "phone" && styles.chatPhoneTarget, feature.value && styles.chatSecondaryPillSelected]}
            testID={`chat-feature-toggle-${feature.id}`}
          >
            <Text style={styles.chatSecondaryPillText}>{feature.label}</Text>
          </FocusPressable>
        ) : (
          <View key={feature.id} style={styles.chatFeatureSelectControl}>
            <FocusPressable
              accessibilityLabel={`${feature.label}: ${feature.value ?? "Choose"}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !interactive || !selection, expanded: featureId === feature.id }}
              disabled={!interactive || !selection}
              onPress={() => { setFeatureId((current) => current === feature.id ? null : feature.id); setOpen(false); setThinkingOpen(false); }}
              style={[styles.chatSecondaryPill, layoutTier === "phone" && styles.chatPhoneTarget]}
              testID={`chat-feature-select-${feature.id}`}
            >
              <Text style={styles.chatSecondaryPillText}>{feature.label}</Text>
            </FocusPressable>
            {featureId === feature.id ? <View style={styles.chatMiniMenu}>
              {feature.options.map((option) => (
                <FocusPressable key={option.id} accessibilityLabel={`${feature.label} ${option.label}`} accessibilityRole="button" onPress={() => chooseFeature(feature, option.id)} style={styles.chatMiniOption} testID={`chat-feature-${feature.id}-${option.id}`}>
                  <Text style={styles.chatPickerOptionText}>{option.label}</Text>
                </FocusPressable>
              ))}
            </View> : null}
          </View>
        ))}
        {featuresLoading ? <Text style={styles.chatFeatureLoading}>Checking features…</Text> : null}
      </View>
      {features?.status !== "ready" && features?.error ? <Text style={styles.chatFeatureError} testID="chat-feature-error">{features.error.message}</Text> : null}
    </View>
  );
}

function cloneSurfaceSelection(selection: ChatSelectionWire): ChatSelectionWire {
  return { ...selection, featureValues: { ...selection.featureValues } };
}

function sameSurfaceSelection(left: ChatSelectionWire, right: ChatSelectionWire): boolean {
  return left.provider === right.provider && left.model === right.model && left.modeId === right.modeId &&
    left.thinkingOptionId === right.thinkingOptionId &&
    JSON.stringify(Object.entries(left.featureValues).sort()) === JSON.stringify(Object.entries(right.featureValues).sort());
}

function MeetingChatPanel({
  error,
  loading,
  model,
  layoutTier,
  chatCatalog,
  chatCatalogError,
  chatProfiles,
  chatSelection,
  chatFeatures,
  chatFeaturesLoading,
  onChatSelection: onChatSelectionBundle,
  onAsk,
  onCitation,
  onRetry,
  provider,
  providers,
  thread,
  transcript,
  interactive,
  citationEvidence,
}: {
  error: string | null;
  loading: boolean;
  model: string | null;
  layoutTier: LayoutTier;
  chatCatalog?: ChatControlsCatalogWire;
  chatCatalogError: ChatCapabilityErrorWire | null;
  chatProfiles: ChatProfileWire[];
  chatSelection: ChatSelectionWire | null;
  chatFeatures: ChatFeatureDiscoveryWire | null;
  chatFeaturesLoading: boolean;
  onChatSelection?: (selection: ChatSelectionWire) => void | Promise<void>;
  onAsk?: (question: string) => Promise<void>;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  onRetry?: () => Promise<void>;
  provider: string | null;
  providers: ChatProviderWire[];
  thread: MeetingChatThreadWire | null;
  transcript: TranscriptWire | null;
  interactive: boolean;
  citationEvidence: CitationEvidenceState | null;
}) {
  const [question, setQuestion] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const running = thread?.status === "running" || loading;
  const hasTranscript = transcript?.status === "ready";
  const hasPendingMessage = pendingQuestion !== null && (thread?.messages.some((message) => message.role === "user" && message.text === pendingQuestion) ?? false);
  useEffect(() => {
    if (hasPendingMessage) setPendingQuestion(null);
  }, [hasPendingMessage]);
  const submit = async () => {
    const normalized = question.trim();
    if (!normalized || !onAsk) return;
    setPendingQuestion(normalized);
    setQuestion("");
    await onAsk(normalized);
  };
  return (
    <View style={styles.chat} testID="meeting-chat">
      <ScrollView style={styles.chatScroll} contentContainerStyle={styles.chatContent} testID="ask-pane-scroll">
        <Text style={styles.chatHint}>Answers use the open meeting transcript only.</Text>
        <View style={styles.chatMessages} testID="chat-messages">
          {(thread?.messages ?? []).map((message, index) => (
            <ChatMessage key={`${message.createdAt}-${index}`} message={message} interactive={interactive} onCitation={onCitation} transcript={transcript} />
          ))}
          {pendingQuestion && !hasPendingMessage ? <View style={styles.chatUser}><Text style={styles.chatRole}>You</Text><Text style={styles.chatText}>{pendingQuestion}</Text></View> : null}
        </View>
        {loading && !thread ? <Text style={styles.chatProgress} accessibilityLiveRegion="polite" testID="chat-preparing">Preparing Ask…</Text> : null}
        {running ? <Text style={styles.chatProgress} accessibilityLiveRegion="polite" testID="chat-progress">Searching transcript… Checking evidence…</Text> : null}
        {thread?.failure ? (
          <View style={styles.chatFailure} testID="chat-failure" accessibilityLiveRegion="polite">
            <Text style={styles.failureText}>Ask could not complete. Your question is kept.</Text>
            <FocusPressable accessibilityLabel="Retry question" accessibilityRole="button" accessibilityState={{ disabled: !interactive || running || (!chatCatalog ? !provider || !model : !chatSelection) || !onRetry }} disabled={!interactive || running || (!chatCatalog ? !provider || !model : !chatSelection) || !onRetry} onPress={() => void onRetry?.()} style={styles.secondaryButtonSmall} testID="chat-retry"><Text style={styles.secondaryButtonText}>Retry question</Text></FocusPressable>
          </View>
        ) : null}
        {error ? <Text style={styles.failureText} accessibilityLiveRegion="polite" testID="chat-error">Ask could not complete. Retry is available.</Text> : null}
        {citationEvidence ? <CitationEvidenceCard evidence={citationEvidence} interactive={interactive} onPlay={onCitation} /> : null}
        {!thread?.messages.length && !running && hasTranscript ? <Text style={styles.askEmpty}>Ask a question about this meeting.</Text> : null}
        {!hasTranscript ? <Text style={styles.askEmpty}>Ask opens when the transcript is ready.</Text> : null}
      </ScrollView>
      <View style={styles.chatComposer}>
        {chatCatalog ? <ChatControls
          catalog={chatCatalog}
          catalogError={chatCatalogError}
          features={chatFeatures}
          featuresLoading={chatFeaturesLoading}
          interactive={interactive}
          layoutTier={layoutTier}
          onSelection={onChatSelectionBundle}
          profiles={chatProfiles}
          selection={chatSelection}
        /> : null}
        <View style={styles.chatComposerRow}>
          <FocusTextInput
            accessibilityLabel="Ask this meeting"
            editable={interactive && !running && Boolean(onAsk) && hasTranscript && (chatCatalog ? Boolean(chatSelection) : Boolean(provider) && Boolean(model))}
            onChangeText={setQuestion}
            placeholder="Ask about this meeting…"
            placeholderTextColor={colors.muted}
            style={styles.chatInput}
            testID="chat-question-input"
            value={question}
          />
          <FocusPressable
            accessibilityLabel="Ask this meeting"
            accessibilityRole="button"
            accessibilityState={{ disabled: !interactive || running || !question.trim() || (!chatCatalog ? !provider || !model : !chatSelection) || !onAsk || !hasTranscript }}
            disabled={!interactive || running || !question.trim() || (!chatCatalog ? !provider || !model : !chatSelection) || !onAsk || !hasTranscript}
            onPress={() => void submit()}
            style={[styles.primaryButton, layoutTier === "phone" && styles.chatPhonePrimaryButton]}
            testID="chat-ask"
          >
            <Text style={styles.buttonText}>Ask</Text>
          </FocusPressable>
        </View>
      </View>
    </View>
  );
}

function ChatMessage({
  message,
  interactive,
  onCitation,
  transcript,
}: {
  message: MeetingChatThreadWire["messages"][number];
  interactive: boolean;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  transcript: TranscriptWire | null;
}) {
  if (message.role === "user") {
    return <View style={styles.chatUser}><Text style={styles.chatRole}>You</Text><Text style={styles.chatText}>{message.text}</Text></View>;
  }
  if (message.outcome === "insufficient_evidence") {
    return <View style={styles.chatInsufficient} testID="chat-insufficient"><Text style={styles.chatText}>The meeting does not contain enough evidence.</Text></View>;
  }
  return (
    <View style={styles.chatAssistant}>
      <Text style={styles.chatRole}>Meetless</Text>
      <Text style={styles.chatText}>{message.text}</Text>
      <View style={styles.chatCitations}>
        {message.citations.map((citation) => {
          const segment = transcript?.segments.find((candidate) => candidate.range.segmentId === citation.segmentId);
          const range = segment ? formatRange(segment.range.startMs, segment.range.endMs) : "Evidence";
          return (
            <FocusPressable
              key={citation.segmentId}
              accessibilityLabel={`Open evidence ${range}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !interactive || !onCitation }}
              disabled={!interactive || !onCitation}
              onPress={() => void onCitation?.(citation)}
              style={styles.chatCitation}
              testID={`chat-citation-${citation.segmentId}`}
            >
              <Text style={styles.chatCitationText}>{range}</Text>
            </FocusPressable>
          );
        })}
      </View>
    </View>
  );
}

function TranscriptState({
  interactive,
  onCitation,
  onRetryTranscription,
  selectedMeeting,
  transcript,
  transcriptError,
  transcriptLoading,
  providerStatus,
  highlightedSegmentId,
}: {
  interactive: boolean;
  onCitation?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
  onRetryTranscription?: () => Promise<void>;
  selectedMeeting: MeetingWire | null;
  transcript: TranscriptWire | null;
  transcriptError: string | null;
  transcriptLoading: boolean;
  providerStatus?: TranscriptionProviderStatusWire["status"];
  highlightedSegmentId: string | null;
}) {
  if (transcriptLoading) return <TranscriptStateMessage testID="transcript-loading" title="Preparing transcript…" detail="Your saved recording is safe." />;
  if (transcript?.status === "failed") return <TranscriptStateMessage detail="Your saved audio is safe. Retry transcription when you are ready." onRetry={interactive ? onRetryTranscription : undefined} testID="transcript-failed" title="Transcription needs attention" />;
  if (!transcript && transcriptError) return <TranscriptStateMessage detail="Your saved audio is safe. Retry transcription when you are ready." onRetry={interactive ? onRetryTranscription : undefined} testID="transcript-failed" title="Transcription needs attention" />;
  if (!transcript && providerStatus === "invalid") return <TranscriptStateMessage detail="Transcription is not available until its setup is repaired." testID="transcript-failed" title="Transcription needs attention" />;
  if (!transcript && providerStatus === "missing") return <TranscriptStateMessage detail="Transcription is not configured yet. Your saved audio remains local." testID="transcript-empty" title="Transcript waiting" />;
  if (!transcript) {
    if (selectedMeeting?.status === "processing") return <TranscriptStateMessage testID="transcript-processing" title="Transcribing" detail="Your saved audio is safe while the transcript is prepared." />;
    return <TranscriptStateMessage testID="transcript-empty" title="Transcript not available yet" detail="The saved recording remains safe." />;
  }
  if (transcript.status === "pending" || transcript.status === "transcribing") {
    return <TranscriptStateMessage detail="Your saved audio is safe while the transcript is prepared." testID="transcript-processing" title="Transcribing" />;
  }
  return (
    <View style={styles.readyState} testID="transcript-ready">
      <Text style={styles.readyLabel} testID="transcript-status">Ready to read</Text>
      {transcriptError ? <Text style={styles.failureText} testID="transcript-error">Playback could not start. Try the citation again.</Text> : null}
      <View style={styles.segmentList} testID="transcript-segments">
        {transcript.segments.length === 0 ? (
          <Text style={styles.emptyText} testID="transcript-ready-empty">No spoken words were captured. The audio is saved.</Text>
        ) : transcript.segments.map((segment) => {
          const highlighted = highlightedSegmentId === segment.range.segmentId;
          return (
            <View key={segment.range.segmentId} style={[styles.segment, highlighted && styles.segmentHighlighted]} testID={`transcript-segment-${segment.range.segmentId}`}>
              <FocusPressable
                accessibilityLabel={`Play transcript segment ${formatRange(segment.range.startMs, segment.range.endMs)}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: !onCitation, selected: highlighted }}
                disabled={!onCitation || !interactive}
                onPress={onCitation ? () => void onCitation({ meetingId: transcript.meetingId, segmentId: segment.range.segmentId }) : undefined}
                style={styles.segmentButton}
                testID={`citation-${segment.range.segmentId}`}
              >
                <Text style={styles.segmentRange}>{formatRange(segment.range.startMs, segment.range.endMs)}</Text>
              </FocusPressable>
              <Text style={styles.segmentText}>{segment.text.trim() || "No spoken text returned for this segment"}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TranscriptStateMessage({ detail, onRetry, testID, title }: { detail?: string; onRetry?: () => Promise<void>; testID: string; title: string }) {
  return (
    <View style={styles.transcriptState} testID={testID}>
      <Text style={styles.transcriptStateTitle}>{title}</Text>
      {detail ? <Text style={styles.transcriptStateDetail}>{detail}</Text> : null}
      {onRetry ? (
        <FocusPressable
          accessibilityLabel="Retry transcription"
          accessibilityRole="button"
          onPress={() => void onRetry()}
          style={styles.secondaryButtonSmall}
          testID="transcription-retry"
        >
          <Text style={styles.secondaryButtonText}>Retry transcription</Text>
        </FocusPressable>
      ) : null}
    </View>
  );
}

function CitationEvidenceCard({
  evidence,
  interactive,
  onPlay,
}: {
  evidence: CitationEvidenceState;
  interactive: boolean;
  onPlay?: (citation: Pick<CitationWire, "meetingId" | "segmentId">) => void | Promise<void>;
}) {
  const range = evidence.startMs !== null && evidence.endMs !== null ? formatRange(evidence.startMs, evidence.endMs) : "Resolving range";
  const status = evidence.status === "resolving"
    ? "Resolving evidence…"
    : evidence.status === "playing"
      ? `Playing evidence · ${range}`
      : evidence.status === "completed"
        ? `Evidence played · ${range}`
        : "Playback failed";
  return (
    <View style={styles.evidence} testID="citation-evidence">
      <Text style={styles.evidenceHeading} accessibilityLiveRegion="polite" testID="citation-evidence-status">Evidence · validated transcript segment</Text>
      <Text style={styles.evidenceRange}>{status}</Text>
      {evidence.text ? <Text style={styles.evidenceText}>{evidence.text}</Text> : null}
      {evidence.error ? <Text style={styles.failureText}>{evidence.error}</Text> : null}
      <FocusPressable
        accessibilityLabel={evidence.status === "failed" ? "Try evidence playback again" : "Play from here"}
        accessibilityRole="button"
        accessibilityState={{ disabled: !interactive || evidence.status === "resolving" || !onPlay }}
        disabled={!interactive || evidence.status === "resolving" || !onPlay}
        onPress={() => void onPlay?.({ meetingId: evidence.meetingId, segmentId: evidence.segmentId })}
        style={styles.primaryButtonSmall}
        testID="citation-play-from-here"
      >
        <Text style={styles.buttonText}>{evidence.status === "failed" ? "Try again" : "Play from here"}</Text>
      </FocusPressable>
    </View>
  );
}

function FocusPressable({
  children,
  style,
  onFocus,
  onBlur,
  ...props
}: PressableProps & { children?: ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...props}
      focusable
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={focused ? [style as never, styles.focusRing] : style}
    >
      {children}
    </Pressable>
  );
}

function FocusTextInput({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return <TextInput {...props} onFocus={(event) => { setFocused(true); onFocus?.(event); }} onBlur={(event) => { setFocused(false); onBlur?.(event); }} style={focused ? [style as never, styles.focusRing] : style} />;
}

function recordingStateCopy(status: RecordingStatusWire): { title: string; detail: string; tone: "accent" | "warning" | "neutral" } {
  switch (status.status) {
    case "interrupted": return { title: "Recording interrupted", detail: "Meetless is checking whether completed audio can be saved.", tone: "warning" };
    case "recoverable": return { title: "Needs attention", detail: "Your completed audio is safe. Retry saving the MP3 without recording again.", tone: "warning" };
    case "finalizing": return { title: "Saving local audio", detail: "Your recording is safe while the MP3 is finalized.", tone: "accent" };
    case "saved": return { title: "Audio saved locally", detail: "The transcript will continue as a separate step.", tone: "accent" };
    case "failed": return { title: "Recording needs attention", detail: recordingFailureDetail(status.error), tone: "warning" };
    case "recording": return { title: "Recording", detail: "", tone: "accent" };
    case "idle": return { title: "", detail: "", tone: "neutral" };
  }
}

function recordingErrorCopy(status: RecordingStatusWire, error?: string | null): string {
  if (status.status === "recoverable") return "Completed audio is safe. Retry save is available.";
  const operationDetail = recordingStartErrorCopy(error);
  if (operationDetail !== "Recording needs attention. Try again.") return operationDetail;
  if (status.status === "failed") return recordingFailureDetail(status.error ?? error);
  return "Recording needs attention. Try again.";
}

function recordingFailureDetail(error: string | null | undefined): string {
  const normalized = error?.toLowerCase() ?? "";
  const startDetail = recordingStartErrorCopy(error);
  if (startDetail !== "Recording needs attention. Try again.") return startDetail;
  if (/no valid|no usable|inventory|capture start failed/u.test(normalized)) return "No usable recording was preserved.";
  return startDetail;
}

function recordingStartErrorCopy(error: string | null | undefined): string {
  const normalized = error?.toLowerCase() ?? "";
  const captureFailure = /capture|permission|access|denied|unavailable|failed/u.test(normalized);
  if (captureFailure && /microphone|mic/u.test(normalized)) {
    return "Microphone access needs attention. Check microphone access, then try again.";
  }
  if (captureFailure && /systemaudio|system audio|system capture|screen capture/u.test(normalized)) {
    return "System audio access needs attention. Check system audio access, then try again.";
  }
  return "Recording needs attention. Try again.";
}

function meetingStatusCopy(status: MeetingWire["status"]): { label: string; tone: "ready" | "working" | "attention" | "neutral" } {
  switch (status) {
    case "ready": return { label: "Ready", tone: "ready" };
    case "recording": return { label: "Recording", tone: "working" };
    case "processing": return { label: "Processing audio", tone: "working" };
    case "draft": return { label: "Needs attention", tone: "attention" };
    case "archived": return { label: "Archived", tone: "neutral" };
  }
}

function hostStatusCopy(status: "online" | "connecting" | "reconnecting" | "offline" | "revalidating"): { label: string; detail: string; tone: "online" | "offline" | "neutral" } {
  switch (status) {
    case "online": return { label: "Host online", detail: "The host is available.", tone: "online" };
    case "offline": return { label: "Host offline", detail: "Meetless will reconnect and revalidate access.", tone: "offline" };
    case "reconnecting": return { label: "Reconnecting…", detail: "Meetless is reconnecting to the host.", tone: "neutral" };
    case "revalidating": return { label: "Checking host…", detail: "Meetless is checking meetings and access.", tone: "neutral" };
    case "connecting": return { label: "Connecting…", detail: "Meetless is connecting to the host.", tone: "neutral" };
  }
}

function groupMeetings(meetings: MeetingWire[]): Array<{ label: string; meetings: MeetingWire[] }> {
  const groups = new Map<string, MeetingWire[]>();
  for (const meeting of meetings) {
    const day = meeting.createdAt.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), meeting]);
  }
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([label, group]) => ({ label, meetings: group }));
}

function formatMeetingDate(value?: string): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} · ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes > 0 ? `${minutes} min` : "Less than 1 min";
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatMilliseconds(startMs)}–${formatMilliseconds(endMs)}`;
}

function formatMilliseconds(value: number): string {
  const seconds = Math.floor(value / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")} : ${String(seconds % 60).padStart(2, "0")}`.replace(" : ", ":");
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.bg, fontFamily: sans },
  main: { flex: 1, minHeight: 0, flexDirection: "row", position: "relative", backgroundColor: colors.bg },
  topbar: { height: 52, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, borderBottomColor: colors.borderSoft, borderBottomWidth: 1, backgroundColor: colors.bg },
  brand: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  brandText: { color: colors.foreground, fontFamily: sans, fontSize: 15, fontWeight: "600", letterSpacing: -0.15 },
  mark: { width: 18, height: 18, borderRadius: 5, backgroundColor: colors.accent },
  hostChip: { flexDirection: "row", alignItems: "center", gap: 8, borderColor: colors.borderSoft, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, maxWidth: "55%" },
  hostChipOnline: { backgroundColor: "rgba(39,166,68,0.08)" },
  hostChipOffline: { backgroundColor: "rgba(234,179,8,0.08)" },
  hostDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.meta },
  hostText: { color: colors.muted, fontFamily: mono, fontSize: 12, flexShrink: 1 },
  sidebarPane: { width: 272, flexShrink: 0, minHeight: 0 },
  tabletSidebarPane: { width: 248 },
  phoneList: { flex: 1, minWidth: 0 },
  phoneDetail: { flex: 1, minWidth: 0, minHeight: 0 },
  sidebar: { flex: 1, minHeight: 0, backgroundColor: "rgba(255,255,255,0.015)", borderRightColor: colors.borderSoft, borderRightWidth: 1 },
  sidebarScroll: { flex: 1 },
  sidebarContent: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 24, gap: 8 },
  sidebarHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 4, paddingVertical: 2 },
  overline: { color: colors.muted, fontFamily: mono, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase" },
  libraryHint: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginBottom: 8 },
  listGroup: { color: colors.muted, fontFamily: mono, fontSize: 11, letterSpacing: 0.7, paddingHorizontal: 6, paddingTop: 14, paddingBottom: 6 },
  list: { gap: 2 },
  meetingRow: { width: "100%", minWidth: 0, gap: 4, paddingHorizontal: 10, paddingVertical: 9, borderColor: "transparent", borderWidth: 1, borderRadius: 6, backgroundColor: "transparent" },
  meetingRowSelected: { backgroundColor: "rgba(94,106,210,0.13)", borderColor: "rgba(94,106,210,0.38)" },
  meetingRowDisabled: { opacity: 0.48 },
  cardTitle: { color: colors.foreground, fontFamily: sans, fontSize: 13.5, fontWeight: "500", flexShrink: 1 },
  meetingMeta: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  metaText: { color: colors.muted, fontFamily: mono, fontSize: 11 },
  meetingDot: { color: colors.meta, fontFamily: mono, fontSize: 11 },
  statusInline: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0, flexShrink: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.meta },
  statusDotReady: { backgroundColor: colors.success },
  statusDotWorking: { backgroundColor: colors.accent },
  statusDotAttention: { backgroundColor: colors.warning },
  statusText: { color: colors.secondary, fontFamily: mono, fontSize: 11, flexShrink: 1 },
  emptyState: { gap: 8, paddingHorizontal: 12, paddingVertical: 32 },
  emptyTitle: { color: colors.foreground, fontSize: 16, fontWeight: "500" },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 20, maxWidth: 360 },
  sidebarFoot: { flexShrink: 0, gap: 8, borderTopColor: colors.borderSoft, borderTopWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
  sidebarFootText: { color: colors.muted, fontFamily: mono, fontSize: 11 },
  detailPane: { flex: 1, minWidth: 0, minHeight: 0 },
  detail: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.bg },
  detailHeader: { minHeight: 78, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 12, borderBottomColor: colors.borderSoft, borderBottomWidth: 1, paddingHorizontal: 24, paddingVertical: 14 },
  detailHeading: { flex: 1, minWidth: 0, gap: 5 },
  detailTitle: { color: colors.foreground, fontFamily: sans, fontSize: 20, fontWeight: "600", letterSpacing: -0.2 },
  detailMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  detailContent: { flex: 1, minHeight: 0, minWidth: 0 },
  desktopDetailContent: { flexDirection: "row" },
  detailPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 32, backgroundColor: colors.bg },
  detailPlaceholderTitle: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  detailPlaceholderText: { color: colors.muted, fontSize: 13.5, textAlign: "center" },
  backButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 6 },
  backButtonText: { color: colors.secondary, fontSize: 13.5 },
  taskSwitcher: { flexDirection: "row", gap: 4, flexShrink: 0, borderBottomColor: colors.borderSoft, borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 8 },
  taskTab: { minHeight: 36, justifyContent: "center", paddingHorizontal: 14, borderColor: "transparent", borderWidth: 1, borderRadius: 6 },
  taskTabSelected: { backgroundColor: "rgba(255,255,255,0.06)", borderColor: colors.border },
  taskTabText: { color: colors.muted, fontSize: 13 },
  taskTabTextSelected: { color: colors.foreground },
  pane: { flex: 1, minWidth: 0, minHeight: 0 },
  transcriptPane: { flex: 1.28, borderRightColor: colors.borderSoft, borderRightWidth: 1 },
  askPane: { flex: 1, zIndex: 2, overflow: "visible" },
  paneHead: { position: "relative", minHeight: 48, flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 24, paddingTop: 14, zIndex: 20, overflow: "visible" },
  paneTitle: { color: colors.muted, fontFamily: mono, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase" },
  paneScroll: { flex: 1, minHeight: 0 },
  paneScrollContent: { gap: 16, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32 },
  disclosure: { gap: 8, padding: 14, borderColor: "rgba(234,179,8,0.35)", borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(234,179,8,0.08)" },
  disclosureTitle: { color: colors.foreground, fontSize: 13.5, fontWeight: "500" },
  disclosureText: { color: colors.secondary, fontSize: 13, lineHeight: 20 },
  transcriptState: { gap: 8, padding: 20, borderColor: colors.border, borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.025)" },
  transcriptStateTitle: { color: colors.foreground, fontSize: 17, fontWeight: "500" },
  transcriptStateDetail: { color: colors.muted, fontSize: 13.5, lineHeight: 20 },
  readyState: { gap: 12 },
  readyLabel: { color: colors.secondary, fontFamily: mono, fontSize: 11, letterSpacing: 0.7, textTransform: "uppercase" },
  segmentList: { gap: 2 },
  segment: { flexDirection: "row", alignItems: "flex-start", gap: 12, minWidth: 0, paddingHorizontal: 10, paddingVertical: 9, borderColor: "transparent", borderWidth: 1, borderRadius: 6 },
  segmentHighlighted: { borderColor: "rgba(94,106,210,0.45)", backgroundColor: "rgba(94,106,210,0.14)" },
  segmentButton: { width: 74, flexShrink: 0, paddingVertical: 2 },
  segmentRange: { color: colors.muted, fontFamily: mono, fontSize: 11.5 },
  segmentText: { color: colors.secondary, flex: 1, minWidth: 0, fontSize: 14, lineHeight: 22 },
  askHeading: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  askScope: { color: colors.muted, fontFamily: mono, fontSize: 10.5, borderColor: colors.borderSoft, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  providerPicker: { position: "relative", maxWidth: "62%", zIndex: 30 },
  providerChip: { minHeight: 30, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.04)" },
  providerChipText: { color: colors.secondary, fontSize: 12, flexShrink: 1 },
  providerChevron: { color: colors.muted, fontSize: 14 },
  pickerOptions: { position: "absolute", top: 36, right: 0, minWidth: 190, gap: 2, padding: 6, borderColor: colors.border, borderWidth: 1, borderRadius: 8, backgroundColor: colors.surface, zIndex: 40, elevation: 12 },
  providerOption: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 5 },
  providerOptionSelected: { backgroundColor: "rgba(94,106,210,0.16)" },
  providerOptionText: { color: colors.secondary, fontSize: 12 },
  chat: { flex: 1, minHeight: 0, zIndex: 0 },
  chatScroll: { flex: 1, minHeight: 0 },
  chatContent: { gap: 12, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 20 },
  chatHint: { color: colors.muted, fontSize: 12.5, lineHeight: 19 },
  chatMessages: { gap: 10 },
  chatUser: { alignSelf: "flex-end", maxWidth: "84%", gap: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, borderBottomRightRadius: 4, backgroundColor: colors.accent },
  chatAssistant: { alignSelf: "flex-start", maxWidth: "92%", gap: 8 },
  chatRole: { color: colors.muted, fontFamily: mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase" },
  chatText: { color: colors.secondary, fontSize: 13.5, lineHeight: 21 },
  chatInsufficient: { alignSelf: "flex-start", maxWidth: "92%", paddingHorizontal: 12, paddingVertical: 10, borderColor: "rgba(234,179,8,0.35)", borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(234,179,8,0.08)" },
  chatCitations: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chatCitation: { paddingHorizontal: 9, paddingVertical: 5, borderColor: "rgba(130,143,255,0.4)", borderWidth: 1, borderRadius: 999, backgroundColor: "rgba(94,106,210,0.12)" },
  chatCitationText: { color: colors.accentHover, fontFamily: mono, fontSize: 11 },
  chatProgress: { color: colors.foreground, fontSize: 13.5, paddingVertical: 6 },
  chatFailure: { gap: 8, padding: 12, borderColor: "rgba(220,38,38,0.35)", borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(220,38,38,0.08)" },
  askEmpty: { color: colors.muted, fontSize: 13.5, paddingVertical: 16 },
  chatComposer: { flexShrink: 0, gap: 8, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16, borderTopColor: colors.borderSoft, borderTopWidth: 1, zIndex: 20, overflow: "visible" },
  chatComposerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  chatInput: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.035)", color: colors.foreground, fontSize: 13.5 },
  chatControls: { position: "relative", zIndex: 40, gap: 5, overflow: "visible" },
  chatControlsRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, minHeight: 32 },
  chatModelControl: { position: "relative", zIndex: 50, maxWidth: "62%", overflow: "visible" },
  chatModelPill: { minHeight: 32, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.05)" },
  chatPhoneTarget: { minHeight: 44 },
  chatPhoneTargetSquare: { width: 44, height: 44 },
  chatModelPillUnavailable: { borderColor: "rgba(234,179,8,0.45)" },
  chatModelPillText: { color: colors.foreground, fontSize: 12.5, fontWeight: "500", flexShrink: 1 },
  chatThinkingControl: { position: "relative", zIndex: 70 },
  chatSecondaryPill: { minHeight: 32, maxWidth: 180, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, borderColor: colors.borderSoft, borderWidth: 1, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.025)" },
  chatSecondaryPillSelected: { borderColor: "rgba(130,143,255,0.5)", backgroundColor: "rgba(94,106,210,0.16)" },
  chatSecondaryPillText: { color: colors.secondary, fontSize: 11.5, flexShrink: 1 },
  chatPicker: { gap: 8, overflow: "hidden", padding: 8, borderColor: colors.border, borderWidth: 1, borderRadius: 10, backgroundColor: colors.surface, zIndex: 100, elevation: 20, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  chatPickerViewport: { position: "fixed" } as unknown as ViewStyle,
  chatPickerViewportPending: { top: CHAT_PICKER_VIEWPORT_MARGIN, left: CHAT_PICKER_VIEWPORT_MARGIN, width: CHAT_PICKER_WIDTH, maxHeight: CHAT_PICKER_MAX_HEIGHT, opacity: 0 },
  chatPickerNative: { position: "absolute", right: 0, bottom: 38, width: CHAT_PICKER_WIDTH, maxHeight: CHAT_PICKER_MAX_HEIGHT },
  chatPickerPhone: { position: "fixed", top: "auto", right: 8, bottom: 8, left: 8, width: "auto", maxHeight: "78vh", borderRadius: 14, padding: 12 } as unknown as ViewStyle,
  chatPickerBackdrop: { position: "fixed", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)", zIndex: 90 } as unknown as ViewStyle,
  chatPickerHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  chatPickerBack: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  chatPickerBackText: { color: colors.secondary, fontSize: 22 },
  chatPickerSearch: { flex: 1, minHeight: 40, paddingHorizontal: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.035)", color: colors.foreground, fontSize: 13 },
  chatPickerScroll: { flexGrow: 0, flexShrink: 1, maxHeight: 340 },
  chatPickerSection: { color: colors.muted, fontFamily: mono, fontSize: 10.5, letterSpacing: 0.8, textTransform: "uppercase", paddingHorizontal: 8, paddingTop: 8, paddingBottom: 5 },
  chatPickerOption: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 6 },
  chatPickerOptionSelected: { backgroundColor: "rgba(94,106,210,0.16)" },
  chatPickerOptionCopy: { flex: 1, minWidth: 0, gap: 2 },
  chatPickerOptionTitle: { color: colors.secondary, fontSize: 12.5, flexShrink: 1 },
  chatPickerOptionMeta: { color: colors.muted, fontFamily: mono, fontSize: 10.5, flexShrink: 1 },
  chatPickerOptionText: { color: colors.secondary, fontSize: 12.5 },
  chatPickerCheck: { color: colors.accentHover, fontSize: 14 },
  chatPickerEmpty: { color: colors.muted, fontSize: 12.5, padding: 12 },
  chatPickerError: { color: colors.dangerText, fontSize: 12, lineHeight: 17, padding: 8 },
  chatMiniMenu: { position: "absolute", top: 36, right: 0, minWidth: 150, gap: 2, padding: 5, borderColor: colors.border, borderWidth: 1, borderRadius: 8, backgroundColor: colors.surface, zIndex: 110, elevation: 18 },
  chatMiniOption: { minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderRadius: 5 },
  chatPhonePrimaryButton: { minHeight: 44 },
  chatFeatureSelectControl: { position: "relative", zIndex: 60 },
  chatFeatureLoading: { color: colors.muted, fontFamily: mono, fontSize: 10.5, paddingHorizontal: 4 },
  chatFeatureError: { color: colors.dangerText, fontSize: 11.5, lineHeight: 17 },
  evidence: { gap: 8, padding: 12, borderColor: "rgba(94,106,210,0.4)", borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(94,106,210,0.08)" },
  evidenceHeading: { color: colors.accentHover, fontFamily: mono, fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase" },
  evidenceRange: { color: colors.secondary, fontFamily: mono, fontSize: 11.5 },
  evidenceText: { color: colors.secondary, fontSize: 13.5, lineHeight: 21 },
  failureText: { color: colors.dangerText, fontSize: 13, lineHeight: 19 },
  primaryButton: { minHeight: 42, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, borderRadius: 6, backgroundColor: colors.accent },
  primaryButtonSmall: { minHeight: 30, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.accent },
  secondaryButton: { alignSelf: "flex-start", minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.04)" },
  secondaryButtonSmall: { minHeight: 30, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.04)" },
  secondaryButtonText: { color: colors.secondary, fontSize: 12.5 },
  ghostButton: { minHeight: 30, alignItems: "center", justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 },
  ghostButtonText: { color: colors.secondary, fontSize: 12.5 },
  dangerButtonText: { color: colors.dangerText, fontSize: 12.5 },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "500" },
  error: { color: colors.dangerText, fontSize: 13, lineHeight: 19 },
  connectionNotice: { flexShrink: 0, gap: 6, margin: 12, padding: 12, borderColor: "rgba(234,179,8,0.35)", borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(234,179,8,0.08)" },
  connectionNoticeCompact: { marginHorizontal: 16 },
  connectionNoticeTitle: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  connectionNoticeText: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  noticeActions: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  setupBackdrop: { position: "absolute", zIndex: 20, top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(8,9,10,0.92)" },
  setupPanel: { width: "100%", maxWidth: 520, gap: 10, padding: 24, borderColor: colors.border, borderWidth: 1, borderRadius: 12, backgroundColor: colors.surface },
  setupTitle: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  setupDescription: { color: colors.muted, fontSize: 13.5, lineHeight: 20, maxWidth: 440 },
  setupField: { gap: 6, marginTop: 8 },
  fieldLabel: { color: colors.muted, fontSize: 12.5 },
  input: { width: "100%", minHeight: 44, paddingHorizontal: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.035)", color: colors.foreground, fontSize: 14 },
  sourceList: { gap: 8 },
  sourceRow: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0, padding: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.025)" },
  sourceCheck: { width: 18, color: colors.accent, fontSize: 18, textAlign: "center" },
  sourceCopy: { flex: 1, minWidth: 0, gap: 2 },
  sourceName: { color: colors.foreground, fontSize: 13.5, fontWeight: "500" },
  sourceDescription: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  proposedTag: { color: colors.muted, fontFamily: mono, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", borderColor: colors.borderSoft, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  proposedNotice: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  setupActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 8 },
  recordingStrip: { minHeight: recordingStripGeometry.stripMinHeight, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: recordingStripGeometry.controlTopY, paddingBottom: RECORDING_STRIP_VERTICAL_PADDING, borderBottomColor: colors.borderSoft, borderBottomWidth: 1, backgroundColor: colors.surface },
  recordingLiveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  recordingLiveDotWarning: { backgroundColor: colors.warning },
  recordingIdentity: { flex: 1, minWidth: 0, gap: 2 },
  recordingTitle: { color: colors.foreground, fontSize: 13.5, fontWeight: "500", flexShrink: 1 },
  recordingTime: { color: colors.secondary, fontFamily: mono, fontSize: 12 },
  recordingDetail: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  recordingAction: { minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, borderRadius: 6, backgroundColor: colors.accent },
  recordingSecondary: { minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, borderColor: colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.04)" },
  recordingButtonText: { color: colors.secondary, fontSize: 13, fontWeight: "500" },
  recordingError: { color: colors.dangerText, fontSize: 12, lineHeight: 17, maxWidth: 240 },
  focusRing: { borderColor: colors.accentHover, borderWidth: 1, shadowColor: colors.accent, shadowOpacity: 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  hidden: { display: "none" },
});
