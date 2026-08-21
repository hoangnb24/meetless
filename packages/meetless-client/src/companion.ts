import {
  DaemonClient,
  type ConnectionState as PaseoConnectionState,
  type DaemonClientConfig,
} from "@getpaseo/client/internal/daemon-client";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  normalizeHostPort,
} from "@getpaseo/protocol/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { MeetlessClient, type MeetlessDaemonPort } from "./index.js";

export const COMPANION_AUTHORITY =
  "docs/plans/active/v1-paseo-foundation.md, M6 foundation gate and LEAD_RULING v1 — M6-FOUNDATION-DISCOVERY";

export interface DirectCompanionProfile {
  version: 1;
  id: string;
  label: string;
  type: "direct";
  endpoint: string;
  useTls: boolean;
  password: string;
}

export interface RelayCompanionProfile {
  version: 1;
  id: string;
  label: string;
  type: "relay";
  serverId: string;
  relayEndpoint: string;
  useTls: boolean;
  daemonPublicKeyB64: string;
}

export type CompanionProfile = DirectCompanionProfile | RelayCompanionProfile;

export type CompanionConnectionState =
  | { status: "unpaired" }
  | { status: "connecting" }
  | { status: "reconnecting" }
  | { status: "offline" }
  | { status: "revalidating" }
  | { status: "online" }
  | { status: "disposed" };

export function createDirectCompanionProfile(input: {
  endpoint: string;
  password: string;
  useTls?: boolean;
  label?: string;
  id?: string;
}): DirectCompanionProfile {
  let endpoint: string;
  try {
    endpoint = normalizeHostPort(input.endpoint);
  } catch {
    throw companionRuleError("The direct host address is invalid", "enter a private LAN host and port such as 192.168.1.20:6777");
  }
  assertDirectLanEndpoint(endpoint);
  const password = input.password.trim();
  if (!password) {
    throw companionRuleError("Direct LAN pairing requires a password", "enter the password configured on the Meetless host");
  }
  return {
    version: 1,
    id: input.id?.trim() || `direct:${endpoint}`,
    label: input.label?.trim() || endpoint,
    type: "direct",
    endpoint,
    useTls: input.useTls ?? false,
    password,
  };
}

export function createRelayCompanionProfile(pairingLink: string): RelayCompanionProfile {
  let offer: ReturnType<typeof parseConnectionOfferFromUrl>;
  try {
    offer = parseConnectionOfferFromUrl(pairingLink);
  } catch {
    throw companionRuleError("The Paseo relay offer is invalid", "request a fresh pairing link from the Meetless host");
  }
  if (!offer) {
    throw companionRuleError("The Paseo relay offer is missing", "paste the complete link that contains #offer=");
  }
  let relayEndpoint: string;
  try {
    relayEndpoint = normalizeHostPort(offer.relay.endpoint);
  } catch {
    throw companionRuleError("The Paseo relay endpoint is invalid", "request a fresh pairing link from the Meetless host");
  }
  assertDaemonPublicKey(offer.daemonPublicKeyB64);
  return {
    version: 1,
    id: `relay:${offer.serverId}`,
    label: "Meetless relay host",
    type: "relay",
    serverId: offer.serverId,
    relayEndpoint,
    useTls: offer.relay.useTls ?? relayEndpoint.endsWith(":443"),
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
  };
}

export function validateCompanionProfile(value: unknown): CompanionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStoredProfile();
  const profile = value as Record<string, unknown>;
  const allowed = profile.type === "direct"
    ? ["version", "id", "label", "type", "endpoint", "useTls", "password"]
    : profile.type === "relay"
      ? ["version", "id", "label", "type", "serverId", "relayEndpoint", "useTls", "daemonPublicKeyB64"]
      : [];
  if (allowed.length === 0 || Object.keys(profile).some((key) => !allowed.includes(key))) throw invalidStoredProfile();
  if (profile.version !== 1 || typeof profile.id !== "string" || !profile.id.trim() ||
      typeof profile.label !== "string" || !profile.label.trim() || typeof profile.useTls !== "boolean") {
    throw invalidStoredProfile();
  }
  if (profile.type === "direct") {
    if (typeof profile.endpoint !== "string" || typeof profile.password !== "string") throw invalidStoredProfile();
    return createDirectCompanionProfile({
      endpoint: profile.endpoint,
      password: profile.password,
      useTls: profile.useTls,
      label: profile.label,
      id: profile.id,
    });
  }
  if (typeof profile.serverId !== "string" || !profile.serverId.trim() ||
      typeof profile.relayEndpoint !== "string" || typeof profile.daemonPublicKeyB64 !== "string") {
    throw invalidStoredProfile();
  }
  const relayEndpoint = normalizeHostPort(profile.relayEndpoint);
  assertDaemonPublicKey(profile.daemonPublicKeyB64);
  return {
    version: 1,
    id: profile.id,
    label: profile.label,
    type: "relay",
    serverId: profile.serverId,
    relayEndpoint,
    useTls: profile.useTls,
    daemonPublicKeyB64: profile.daemonPublicKeyB64,
  };
}

export function buildCompanionClientConfig(profile: CompanionProfile, input: {
  clientId: string;
  clientType?: "mobile" | "browser";
}): DaemonClientConfig {
  const base = {
    clientId: input.clientId,
    clientType: input.clientType ?? "browser" as const,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 5_000 },
    suppressSendErrors: true,
    logger: privateTransportLogger,
  };
  if (profile.type === "direct") {
    assertDirectLanEndpoint(profile.endpoint);
    const password = profile.password.trim();
    if (!password) {
      throw companionRuleError("Direct LAN pairing requires a password", "repair the saved host profile before connecting");
    }
    return {
      ...base,
      url: buildDaemonWebSocketUrl(profile.endpoint, { useTls: profile.useTls }),
      password,
    };
  }
  assertDaemonPublicKey(profile.daemonPublicKeyB64);
  return {
    ...base,
    url: buildRelayWebSocketUrl({
      endpoint: profile.relayEndpoint,
      useTls: profile.useTls,
      serverId: profile.serverId,
      role: "client",
    }),
    e2ee: { enabled: true, daemonPublicKeyB64: profile.daemonPublicKeyB64 },
  };
}

interface CompanionDaemon extends MeetlessDaemonPort {
  connect(): Promise<void>;
  close(): Promise<void>;
  getConnectionState(): PaseoConnectionState;
  subscribeConnectionStatus(listener: (state: PaseoConnectionState) => void): () => void;
}

export interface CompanionSessionDependencies {
  createDaemon(config: DaemonClientConfig): CompanionDaemon;
  delay?(milliseconds: number): Promise<void>;
}

const defaultDependencies: CompanionSessionDependencies = {
  createDaemon: (config) => new DaemonClient(config),
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export interface CompanionRehydrateContext {
  reconnect: boolean;
  epoch: number;
  isCurrent(): boolean;
}

export class MeetlessConnectionSession {
  private state: CompanionConnectionState = { status: "unpaired" };
  private readonly listeners = new Set<(state: CompanionConnectionState) => void>();
  private daemon: CompanionDaemon | null = null;
  private client: MeetlessClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private everOnline = false;
  private disposed = false;

  constructor(
    private readonly profile: CompanionProfile,
    private readonly rehydrate: (client: MeetlessClient, context: CompanionRehydrateContext) => Promise<void>,
    private readonly dependencies: CompanionSessionDependencies = defaultDependencies,
  ) {}

  subscribe(listener: (state: CompanionConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async start(input: { clientId: string; clientType?: "mobile" | "browser" }): Promise<void> {
    if (this.disposed) throw new Error("Meetless companion session is disposed");
    if (this.daemon) return;
    const daemon = this.dependencies.createDaemon(buildCompanionClientConfig(this.profile, input));
    this.daemon = daemon;
    this.unsubscribe = daemon.subscribeConnectionStatus((state) => this.observePaseoState(state));
    try {
      await daemon.connect();
    } catch {
      if (!this.disposed) this.publish({ status: "offline" });
    }
  }

  getState(): CompanionConnectionState {
    return this.state;
  }

  getClient(): MeetlessClient {
    if (this.state.status !== "online" || !this.client) {
      throw new Error("Meetless host is offline; wait for capability and meeting-state revalidation");
    }
    return this.client;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const daemon = this.daemon;
    this.daemon = null;
    this.client = null;
    if (daemon) await daemon.close().catch(() => undefined);
    this.publish({ status: "disposed" });
  }

  private observePaseoState(state: PaseoConnectionState): void {
    if (this.disposed) return;
    if (state.status === "connected") {
      const epoch = ++this.generation;
      const reconnect = this.everOnline;
      const client = new MeetlessClient(this.daemon!);
      void this.revalidateUntilCurrent(client, epoch, reconnect);
      return;
    }
    if (state.status === "connecting") {
      this.publish({ status: this.everOnline ? "reconnecting" : "connecting" });
      return;
    }
    if (state.status === "disconnected") {
      this.generation += 1;
      this.client = null;
      this.publish({ status: "offline" });
      return;
    }
    if (state.status === "disposed") {
      this.generation += 1;
      this.client = null;
      this.publish({ status: "disposed" });
    }
  }

  private async revalidateUntilCurrent(client: MeetlessClient, epoch: number, reconnect: boolean): Promise<void> {
    let attempt = 0;
    while (!this.disposed && epoch === this.generation) {
      this.publish({ status: "revalidating" });
      try {
        await client.initialize();
        await this.rehydrate(client, {
          reconnect,
          epoch,
          isCurrent: () => !this.disposed && epoch === this.generation,
        });
        if (this.disposed || epoch !== this.generation) return;
        this.client = client;
        this.everOnline = true;
        this.publish({ status: "online" });
        return;
      } catch {
        if (this.disposed || epoch !== this.generation) return;
        this.client = null;
        this.publish({ status: "reconnecting" });
        attempt += 1;
        await (this.dependencies.delay ?? defaultDependencies.delay!)(Math.min(250 * (2 ** (attempt - 1)), 5_000));
      }
    }
  }

  private publish(state: CompanionConnectionState): void {
    if (this.state.status === state.status) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function assertDaemonPublicKey(value: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw companionRuleError("The relay trust key is invalid", "request a fresh Paseo pairing offer from the Meetless host");
  }
  try {
    if (globalThis.atob(value).length !== 32) throw new Error("invalid key length");
  } catch {
    throw companionRuleError("The relay trust key is invalid", "request a fresh Paseo pairing offer from the Meetless host");
  }
}

function assertDirectLanEndpoint(endpoint: string): void {
  const bracketedIpv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(endpoint);
  if (bracketedIpv6) {
    if (bracketedIpv6[1] === "::1") return;
    throw companionRuleError("The direct host must be on the private LAN", "enter a loopback or private IPv4 host address");
  }
  const separator = endpoint.lastIndexOf(":");
  const host = separator >= 0 ? endpoint.slice(0, separator).toLowerCase() : "";
  if (host === "localhost" || host === "127.0.0.1") return;
  const sourceOctets = host.split(".");
  const lexicalIpv4 = sourceOctets.length === 4 && sourceOctets.every((octet) => /^[0-9]+$/u.test(octet));
  const octets = lexicalIpv4 ? sourceOctets.map(Number) : [];
  const validIpv4 = lexicalIpv4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  const privateIpv4 = validIpv4 && (
    octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
  );
  if (!privateIpv4) {
    throw companionRuleError("The direct host must be on the private LAN", "enter a loopback or private IPv4 host address");
  }
}

function companionRuleError(message: string, nextAction: string): Error {
  return new Error(`${message}. Authority: ${COMPANION_AUTHORITY}. Next action: ${nextAction}.`);
}

function invalidStoredProfile(): Error {
  return companionRuleError(
    "The saved companion profile is invalid or contains meeting product data",
    "remove it and pair the companion again",
  );
}

const privateTransportLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
