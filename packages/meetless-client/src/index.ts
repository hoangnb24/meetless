import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { callPluginRpc } from "@paseo/plugin/host";
import {
  MeetingChatAskRpc,
  MeetingChatGetRpc,
  MeetingChatProvidersRpc,
  MeetingChatRetryRpc,
  MeetingCreateRpc,
  MeetingCitationResolveRpc,
  MeetingListRpc,
  MeetingTranscriptRpc,
  MeetingTranscriptionConsentRpc,
  type MeetingWire,
  type TranscriptWire,
  type CitationWire,
  type ChatProviderWire,
  type MeetingChatThreadWire,
  type TranscriptionProviderStatusWire,
  RecordingControlResponseSchema,
  RecordingStatusEventSchema,
  type RecordingControlRequest,
  type RecordingStatusWire,
} from "@meetless/meeting-contracts";

export const MEETLESS_PLUGIN_ID = "meetless";

export interface MeetlessDaemonPort {
  getLastServerInfoMessage(): { features?: { plugins?: boolean } } | null;
  getPluginCatalog(): Promise<Array<{ id: string; clientBundle: string }>>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

interface DesktopBridge {
  platform?: unknown;
  invoke?(command: string, args?: Record<string, unknown>): Promise<unknown>;
  events?: { on(event: string, handler: (payload: unknown) => void): Promise<() => void> };
}

export class DesktopRecordingClient {
  private sessionId: string | null = null;
  private unlisten: (() => void) | null = null;
  private socketPath: string | null = null;
  private connectPromise: Promise<RecordingStatusWire> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectEnabled = false;
  private sequence = 0;
  private readonly pending = new Map<string, { resolve(status: RecordingStatusWire): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(status: RecordingStatusWire) => void>();

  constructor(private readonly bridge: DesktopBridge) {
    if (bridge.platform !== "darwin" || typeof bridge.invoke !== "function" || typeof bridge.events?.on !== "function") {
      throw new MeetlessFeatureUnavailableError(
        "Desktop recording requires the pinned macOS Electron bridge; web, mobile, and URL parameters cannot grant it.",
      );
    }
  }

  async connect(): Promise<RecordingStatusWire> {
    this.reconnectEnabled = true;
    if (this.sessionId) return this.request("status");
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectOnce(): Promise<RecordingStatusWire> {
    if (!this.unlisten) {
      this.unlisten = await this.bridge.events!.on("local-daemon-transport-event", (payload) => this.handleTransportEvent(payload));
    }
    if (!this.socketPath) {
      const daemonStatus = await this.bridge.invoke!("desktop_daemon_status") as { home?: unknown };
      if (typeof daemonStatus?.home !== "string" || !daemonStatus.home.startsWith("/")) {
        throw new Error("Desktop daemon did not expose an absolute isolated home");
      }
      this.socketPath = await resolveRecordingSocket(daemonStatus.home.replace(/\/$/u, ""));
    }
    let session: unknown;
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        session = await this.bridge.invoke!("open_local_daemon_transport", { transportType: "socket", transportPath: this.socketPath });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 29) await delay(100);
      }
    }
    if (session === undefined && lastError) {
      throw lastError;
    }
    if (typeof session !== "string" || !session) throw new Error("Desktop recording transport did not return a session ID");
    this.sessionId = session;
    return this.request("status");
  }

  subscribe(listener: (status: RecordingStatusWire) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  start(title: string): Promise<RecordingStatusWire> { return this.request("start", title); }
  status(): Promise<RecordingStatusWire> { return this.request("status"); }
  pause(): Promise<RecordingStatusWire> { return this.request("pause"); }
  resume(): Promise<RecordingStatusWire> { return this.request("resume"); }
  stop(): Promise<RecordingStatusWire> { return this.request("stop"); }
  retryFinalization(): Promise<RecordingStatusWire> { return this.request("retryFinalization"); }

  async close(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const sessionId = this.sessionId; this.sessionId = null;
    if (sessionId) await this.bridge.invoke!("close_local_daemon_transport", { sessionId }).catch(() => undefined);
    this.unlisten?.(); this.unlisten = null;
    this.rejectPending(new Error("Desktop recording transport closed"));
  }

  private async request(command: RecordingControlRequest["command"], title?: string): Promise<RecordingStatusWire> {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("Desktop recording transport is not connected");
    const requestId = `recording-${Date.now()}-${++this.sequence}`;
    const response = new Promise<RecordingStatusWire>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    try {
      await this.bridge.invoke!("send_local_daemon_transport_message", {
        sessionId,
        text: JSON.stringify({ version: 1, requestId, command, ...(title === undefined ? {} : { title }) }),
      });
    } catch (error) {
      this.disconnect(sessionId, error instanceof Error ? error : new Error(String(error)));
      return response;
    }
    return response;
  }

  private handleTransportEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const event = payload as { sessionId?: unknown; kind?: unknown; text?: unknown; binaryBase64?: unknown; error?: unknown };
    if (event.sessionId !== this.sessionId) return;
    if (event.kind === "close" || event.kind === "error") {
      this.disconnect(String(event.sessionId), new Error(
        typeof event.error === "string" ? event.error : "Desktop recording transport disconnected",
      ));
      return;
    }
    if (event.kind !== "message") return;
    const text = typeof event.text === "string"
      ? event.text
      : typeof event.binaryBase64 === "string"
        ? decodeUtf8Base64(event.binaryBase64)
        : null;
    if (text === null) return;
    const decoded: unknown = JSON.parse(text);
    const statusEvent = RecordingStatusEventSchema.safeParse(decoded);
    if (statusEvent.success) {
      for (const listener of this.listeners) listener(statusEvent.data.status);
      return;
    }
    const response = RecordingControlResponseSchema.parse(decoded);
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.status);
    else {
      for (const listener of this.listeners) listener(response.status);
      pending.reject(new Error(response.error ?? "Recording command failed"));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private disconnect(sessionId: string, error: Error): void {
    if (sessionId !== this.sessionId) return;
    this.sessionId = null;
    this.rejectPending(error);
    void this.bridge.invoke!("close_local_daemon_transport", { sessionId }).catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.reconnectEnabled || this.sessionId) return;
      void this.connect().then((status) => {
        for (const listener of this.listeners) listener(status);
      }).catch(() => undefined);
    }, 100);
  }
}

function decodeUtf8Base64(value: string): string {
  const bytes = Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveRecordingSocket(paseoHome: string): Promise<string> {
  const inHome = `${paseoHome}/recording-control.sock`;
  if (new TextEncoder().encode(inHome).byteLength <= 103) return inHome;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(paseoHome));
  const identity = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  return `/private/tmp/meetless-recording-${identity}.sock`;
}

export function createDesktopRecordingClient(): DesktopRecordingClient {
  const bridge = typeof window === "undefined" ? undefined : (window as unknown as { paseoDesktop?: DesktopBridge }).paseoDesktop;
  if (!bridge) throw new MeetlessFeatureUnavailableError("Electron recording bridge is unavailable");
  return new DesktopRecordingClient(bridge);
}

export class MeetlessFeatureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetlessFeatureUnavailableError";
  }
}

export class MeetlessClient {
  private ready = false;

  constructor(private readonly daemon: MeetlessDaemonPort) {}

  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.daemon.getLastServerInfoMessage()?.features?.plugins !== true) {
      throw new MeetlessFeatureUnavailableError(
        "This host does not support Paseo plugins. Update the host; Meetless has no compatibility fallback.",
      );
    }
    const catalog = await this.daemon.getPluginCatalog();
    if (!catalog.some((plugin) => plugin.id === MEETLESS_PLUGIN_ID)) {
      throw new MeetlessFeatureUnavailableError(
        'The connected host does not publish the required "meetless" plugin. Start the isolated Meetless daemon and retry.',
      );
    }
    this.ready = true;
  }

  async createMeeting(input: { title: string }): Promise<MeetingWire> {
    this.requireReady();
    return callPluginRpc(
      MeetingCreateRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      input,
    );
  }

  async listMeetings(): Promise<MeetingWire[]> {
    this.requireReady();
    const output = await callPluginRpc(
      MeetingListRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      {},
    );
    return output.meetings;
  }

  async getMeetingTranscript(meetingId: string): Promise<{
    meeting: MeetingWire;
    transcript: TranscriptWire | null;
    consent: { status: "unknown" | "granted"; grantedAt?: string };
    provider: TranscriptionProviderStatusWire;
  }> {
    this.requireReady();
    return callPluginRpc(
      MeetingTranscriptRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      { meetingId },
    );
  }

  async grantTranscriptionConsent(): Promise<{
    consent: { status: "unknown" | "granted"; grantedAt?: string };
    provider: TranscriptionProviderStatusWire;
  }> {
    this.requireReady();
    return callPluginRpc(
      MeetingTranscriptionConsentRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      { accepted: true },
    );
  }

  async resolveCitation(input: { meetingId: string; segmentId: string }): Promise<CitationWire> {
    this.requireReady();
    return callPluginRpc(
      MeetingCitationResolveRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      input,
    );
  }

  async listChatProviders(): Promise<{
    providers: ChatProviderWire[];
    compatibilityCheck: "on_question_start";
  }> {
    this.requireReady();
    return callPluginRpc(
      MeetingChatProvidersRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      {},
    );
  }

  async getMeetingChat(meetingId: string): Promise<MeetingChatThreadWire | null> {
    this.requireReady();
    const output = await callPluginRpc(
      MeetingChatGetRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      { meetingId },
    );
    return output.thread;
  }

  async askMeetingQuestion(input: {
    meetingId: string;
    question: string;
    provider: string;
    model: string;
  }): Promise<MeetingChatThreadWire> {
    this.requireReady();
    return callPluginRpc(
      MeetingChatAskRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      input,
    );
  }

  async retryMeetingQuestion(input: {
    meetingId: string;
    provider: string;
    model: string;
  }): Promise<MeetingChatThreadWire> {
    this.requireReady();
    return callPluginRpc(
      MeetingChatRetryRpc,
      (method, payload) => this.daemon.invokePluginRpc(MEETLESS_PLUGIN_ID, method, payload),
      input,
    );
  }

  private requireReady(): void {
    if (!this.ready) {
      throw new MeetlessFeatureUnavailableError(
        "Meetless client is not initialized; connect and validate host capabilities first.",
      );
    }
  }
}

export interface ConnectedMeetlessClient {
  client: MeetlessClient;
  close(): Promise<void>;
  serverInfo: ReturnType<DaemonClient["getLastServerInfoMessage"]>;
}

export async function connectMeetlessClient(input: {
  url: string;
  clientId: string;
  clientType?: "mobile" | "browser" | "cli";
}): Promise<ConnectedMeetlessClient> {
  const daemon = new DaemonClient({
    url: input.url,
    clientId: input.clientId,
    clientType: input.clientType ?? "browser",
    reconnect: { enabled: false },
    connectTimeoutMs: 10_000,
  });
  try {
    await daemon.connect();
    const client = new MeetlessClient(daemon);
    await client.initialize();
    return {
      client,
      serverInfo: daemon.getLastServerInfoMessage(),
      close: () => daemon.close(),
    };
  } catch (error) {
    await daemon.close().catch(() => undefined);
    throw error;
  }
}

export * from "./companion.js";
