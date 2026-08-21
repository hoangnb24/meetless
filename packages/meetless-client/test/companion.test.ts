import { describe, expect, test, vi } from "vitest";
import type { ConnectionState, DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import {
  buildCompanionClientConfig,
  createDirectCompanionProfile,
  createRelayCompanionProfile,
  MeetlessConnectionSession,
  validateCompanionProfile,
  type MeetlessDaemonPort,
} from "../src/index.js";

const daemonPublicKeyB64 = Buffer.alloc(32, 7).toString("base64");

function relayLink(overrides: Record<string, unknown> = {}): string {
  const offer = {
    v: 2,
    serverId: "host-stable-id",
    daemonPublicKeyB64,
    relay: { endpoint: "relay.example.test:443", useTls: true },
    ...overrides,
  };
  return `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
}

describe("companion transport profiles", () => {
  test("passes the direct password through Paseo authentication", () => {
    const profile = createDirectCompanionProfile({
      endpoint: "192.168.10.4:6777",
      password: "direct-test-secret",
    });
    const config = buildCompanionClientConfig(profile, { clientId: "client-1" });
    expect(config.url).toBe("ws://192.168.10.4:6777/ws");
    expect(config.password).toBe("direct-test-secret");
    expect(config.reconnect).toMatchObject({ enabled: true });
    expect(config.e2ee).toBeUndefined();
  });

  test("trims the direct password once before storage and daemon authentication", () => {
    const profile = createDirectCompanionProfile({
      endpoint: "10.0.0.8:6777",
      password: "  direct-test-secret  ",
    });
    expect(profile.password).toBe("direct-test-secret");
    expect(buildCompanionClientConfig(profile, { clientId: "client-1" }).password).toBe("direct-test-secret");
  });

  test("rejects direct LAN without password authentication", () => {
    expect(() => createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: " \t " }))
      .toThrow(/requires a password.*Authority:.*Next action:/s);
  });

  test.each([
    "8.8.8.8:6777",
    "203.0.113.20:6777",
    "example.com:6777",
    "0.0.0.0:6777",
  ])("rejects a public or non-destination direct host: %s", (endpoint) => {
    expect(() => createDirectCompanionProfile({ endpoint, password: "test-secret" }))
      .toThrow(/private LAN.*Authority:.*Next action:/s);
  });

  test.each([
    "10.0.0.:6777",
    "10..0.1:6777",
    "10.0..1:6777",
    ".10.0.1:6777",
  ])("rejects a direct IPv4 host with an empty source octet: %s", (endpoint) => {
    expect(() => createDirectCompanionProfile({ endpoint, password: "test-secret" }))
      .toThrow(/private LAN.*Authority:.*Next action:/s);
  });

  test.each([
    "127.0.0.1:6777",
    "localhost:6777",
    "10.20.30.40:6777",
    "172.16.0.1:6777",
    "172.31.255.254:6777",
    "192.168.1.20:6777",
  ])("accepts an existing loopback or private-LAN direct host: %s", (endpoint) => {
    expect(createDirectCompanionProfile({ endpoint, password: "test-secret" }).endpoint).toBe(endpoint);
  });

  test("builds relay only from a validated offer and pins E2EE trust", () => {
    const profile = createRelayCompanionProfile(relayLink());
    const config = buildCompanionClientConfig(profile, { clientId: "client-1", clientType: "mobile" });
    expect(config.url).toBe("wss://relay.example.test/ws?serverId=host-stable-id&role=client&v=2");
    expect(config.e2ee).toEqual({ enabled: true, daemonPublicKeyB64 });
    expect(config.password).toBeUndefined();
    expect(config.reconnect).toMatchObject({ enabled: true });
  });

  test.each([
    "https://app.paseo.sh/",
    relayLink({ daemonPublicKeyB64: "not-a-trust-key" }),
    relayLink({ relay: { endpoint: "bad endpoint", useTls: true } }),
  ])("rejects missing or invalid relay trust data", (link) => {
    expect(() => createRelayCompanionProfile(link)).toThrow(/Authority:.*Next action:/s);
  });

  test("forbids meeting data in a durable connection profile", () => {
    const profile = createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: "test-secret" });
    expect(() => validateCompanionProfile({ ...profile, transcript: { segments: [] } }))
      .toThrow(/contains meeting product data/);
  });
});

class FakeDaemon implements MeetlessDaemonPort {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(state: ConnectionState) => void>();
  catalogCalls = 0;
  invokePluginRpc = vi.fn(async (_pluginId: string, method: string) => {
    if (method === "meeting.list") return { meetings: [] };
    if (method === "meeting.transcript") return {
      meeting: { id: "m-1", title: "Sync", status: "ready", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" },
      transcript: null,
      consent: { status: "granted", grantedAt: "2026-08-21T00:00:00.000Z" },
      provider: { status: "configured" },
    };
    if (method === "meeting.chat.get") return { thread: null };
    throw new Error(`unexpected ${method}`);
  });

  getLastServerInfoMessage() { return { features: { plugins: true } }; }
  async getPluginCatalog() { this.catalogCalls += 1; return [{ id: "meetless", clientBundle: "bundle" }]; }
  async connect() { this.emit({ status: "connecting", attempt: 0 }); this.emit({ status: "connected" }); }
  async close() { this.emit({ status: "disposed" }); }
  getConnectionState() { return this.state; }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void) {
    this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener);
  }
  emit(state: ConnectionState) { this.state = state; for (const listener of this.listeners) listener(state); }
}

describe("companion reconnect lifecycle", () => {
  test("revalidates capabilities and refreshes selected detail and durable chat before online", async () => {
    const daemon = new FakeDaemon();
    const refreshed: string[] = [];
    const states: string[] = [];
    const session = new MeetlessConnectionSession(
      createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: "test-secret" }),
      async (client, context) => {
        refreshed.push(context.reconnect ? "reconnect" : "initial");
        await client.listMeetings();
        await client.getMeetingTranscript("m-1");
        await client.getMeetingChat("m-1");
      },
      { createDaemon: (_config: DaemonClientConfig) => daemon },
    );
    session.subscribe((state) => states.push(state.status));
    await session.start({ clientId: "client-1" });
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));

    daemon.emit({ status: "disconnected", reason: "host stopped" });
    expect(session.getState().status).toBe("offline");
    expect(() => session.getClient()).toThrow(/host is offline/);
    daemon.emit({ status: "connecting", attempt: 1 });
    daemon.emit({ status: "connected" });
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));

    expect(refreshed).toEqual(["initial", "reconnect"]);
    expect(daemon.catalogCalls).toBe(2);
    expect(states).toContain("reconnecting");
    expect(states.slice(states.lastIndexOf("revalidating"))).toEqual(["revalidating", "online"]);
    expect(daemon.invokePluginRpc.mock.calls.map((call) => call[1])).toEqual([
      "meeting.list", "meeting.transcript", "meeting.chat.get",
      "meeting.list", "meeting.transcript", "meeting.chat.get",
    ]);
  });

  test("does not replay a lost in-flight RPC after reconnect", async () => {
    const daemon = new FakeDaemon();
    let rejectLost: ((error: Error) => void) | null = null;
    daemon.invokePluginRpc.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLost = reject; }));
    const session = new MeetlessConnectionSession(
      createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: "test-secret" }),
      async () => undefined,
      { createDaemon: () => daemon },
    );
    await session.start({ clientId: "client-1" });
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));
    const request = session.getClient().listMeetings();
    await vi.waitFor(() => expect(rejectLost).not.toBeNull());
    daemon.emit({ status: "disconnected", reason: "connection lost" });
    rejectLost!(new Error("connection lost"));
    await expect(request).rejects.toThrow("connection lost");
    daemon.emit({ status: "connecting", attempt: 1 });
    daemon.emit({ status: "connected" });
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));
    expect(daemon.invokePluginRpc).toHaveBeenCalledTimes(1);
  });

  test("retries a failed restoration transaction and never publishes online between attempts", async () => {
    const daemon = new FakeDaemon();
    const states: string[] = [];
    let attempts = 0;
    const session = new MeetlessConnectionSession(
      createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: "test-secret" }),
      async (_client, context) => {
        attempts += 1;
        expect(context.isCurrent()).toBe(true);
        if (attempts === 1) throw new Error("chat restore failed");
      },
      { createDaemon: () => daemon, delay: async () => undefined },
    );
    session.subscribe((state) => states.push(state.status));
    await session.start({ clientId: "client-1" });
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));

    expect(attempts).toBe(2);
    expect(states).toEqual(expect.arrayContaining(["revalidating", "reconnecting", "online"]));
    expect(states.filter((state) => state === "online")).toHaveLength(1);
  });

  test("invalidates the old restoration epoch before a reconnect can publish state", async () => {
    const daemon = new FakeDaemon();
    const first = deferred<void>();
    const contexts: Array<{ epoch: number; isCurrent(): boolean }> = [];
    let calls = 0;
    const session = new MeetlessConnectionSession(
      createDirectCompanionProfile({ endpoint: "192.168.10.4:6777", password: "test-secret" }),
      async (_client, context) => {
        contexts.push(context);
        calls += 1;
        if (calls === 1) await first.promise;
      },
      { createDaemon: () => daemon, delay: async () => undefined },
    );
    await session.start({ clientId: "client-1" });
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    daemon.emit({ status: "disconnected", reason: "host stopped" });
    expect(contexts[0]!.isCurrent()).toBe(false);
    daemon.emit({ status: "connecting", attempt: 1 });
    daemon.emit({ status: "connected" });
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    first.resolve();
    await vi.waitFor(() => expect(session.getState().status).toBe("online"));

    expect(contexts[1]!.epoch).not.toBe(contexts[0]!.epoch);
    expect(contexts[1]!.isCurrent()).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
