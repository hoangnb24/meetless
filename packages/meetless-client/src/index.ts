import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { callPluginRpc } from "@paseo/plugin/host";
import {
  MeetingCreateRpc,
  MeetingListRpc,
  type MeetingWire,
} from "@meetless/meeting-contracts";

export const MEETLESS_PLUGIN_ID = "meetless";

export interface MeetlessDaemonPort {
  getLastServerInfoMessage(): { features?: { plugins?: boolean } } | null;
  getPluginCatalog(): Promise<Array<{ id: string; clientBundle: string }>>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
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
