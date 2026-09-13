import net from "node:net";
import { randomUUID } from "node:crypto";
import { NativeProviderAccessRequestSchema, NativeProviderAccessResponseSchema, type ProviderAccessId, type ProviderAccessResult } from "@meetless/meeting-contracts";

/** Native host owns the chooser, bookmarks and access lifetime. No paths cross this boundary. */
export function providerAccess(socketPath: string, provider?: ProviderAccessId): Promise<ProviderAccessResult> {
  const requestId = randomUUID();
  const request = NativeProviderAccessRequestSchema.parse({ version: 1, requestId,
    ...(provider ? { operation: "providerAccessRequest", provider } : { operation: "providerAccessStatus" }) });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result?: ProviderAccessResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result) resolve(result); else reject(new Error("Provider folder access is unavailable. Try again."));
    };
    socket.setEncoding("utf8");
    // Folder selection is user-driven; an RPC deadline must not abandon a later grant.
    socket.setTimeout(provider ? 0 : 5_000, () => finish());
    socket.once("error", () => finish());
    socket.once("end", () => finish());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) return finish();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = NativeProviderAccessResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.requestId !== requestId) return finish();
        finish({ providers: response.providers, outcome: response.outcome });
      } catch { finish(); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  });
}


/** Keeps user-driven native work outside Paseo's 60-second request lifetime. */
export class ProviderAccessService {
  private result: ProviderAccessResult = {
    providers: [{ id: "codex", status: "unavailable" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }],
    outcome: "status",
  };
  private inFlight: Promise<void> | null = null;
  private revision = 0;
  private terminalUnread = false;

  constructor(private readonly transport: (provider?: ProviderAccessId) => Promise<ProviderAccessResult>) {}

  request(provider: ProviderAccessId): ProviderAccessResult {
    if (this.inFlight) return this.result;
    this.revision += 1;
    this.terminalUnread = false;
    this.result = { ...this.result, outcome: "pending" };
    this.inFlight = Promise.resolve().then(() => this.transport(provider)).then(
      (result) => { this.result = result; },
      () => { this.result = { ...this.result, outcome: "failed" }; },
    ).finally(() => { this.inFlight = null; this.terminalUnread = true; });
    return this.result;
  }

  async status(): Promise<ProviderAccessResult> {
    if (this.inFlight) return this.result;
    if (this.terminalUnread) {
      this.terminalUnread = false;
      return this.result;
    }
    const revision = this.revision;
    const current = await this.transport();
    // A status read begun before a new chooser cannot erase its pending/final state.
    if (revision !== this.revision) return this.result;
    this.result = { providers: current.providers, outcome: this.result.outcome };
    return this.result;
  }
}
