import { createServer } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  RecordingControlRequestSchema,
  RecordingControlResponseSchema,
  RecordingStatusEventSchema,
} from "@meetless/meeting-contracts";
import type { RecordingService } from "./recording-service.js";

export class RecordingControlServer {
  private readonly http = createServer();
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly socketPath: string, private readonly service: RecordingService) {
    this.http.on("upgrade", (request, socket, head) => {
      if (request.url !== "/ws") { socket.destroy(); return; }
      this.websocket.handleUpgrade(request, socket, head, (client) => this.websocket.emit("connection", client, request));
    });
    this.websocket.on("connection", (client: WebSocket) => {
      this.clients.add(client);
      client.on("close", () => this.clients.delete(client));
      client.on("message", (data, binary) => {
        if (binary) { client.close(1003, "JSON text required"); return; }
        void this.handle(client, data.toString());
      });
      void this.service.status().then((status) => this.send(client, RecordingStatusEventSchema.parse({ version: 1, type: "recording.status", status })));
    });
  }

  async start(): Promise<void> {
    const maximumSocketPathBytes = process.platform === "darwin" ? 103 : 107;
    if (Buffer.byteLength(this.socketPath) > maximumSocketPathBytes) {
      throw new Error(
        `Recording control socket path is too long for ${process.platform}: ${this.socketPath}`,
      );
    }
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.http.once("error", reject);
        this.http.listen(this.socketPath, () => { this.http.off("error", reject); resolve(); });
      });
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
      await rm(this.socketPath, { force: true });
      throw error;
    }
    this.unsubscribe = this.service.subscribe((status) => {
      const event = RecordingStatusEventSchema.parse({ version: 1, type: "recording.status", status });
      for (const client of this.clients) this.send(client, event);
    });
  }

  async close(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = null;
    for (const client of this.clients) client.close(1001, "Recording service stopping");
    this.clients.clear();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  private async handle(client: WebSocket, raw: string): Promise<void> {
    let requestId = "invalid";
    try {
      const decoded: unknown = JSON.parse(raw);
      if (decoded && typeof decoded === "object" && "requestId" in decoded && typeof decoded.requestId === "string") requestId = decoded.requestId;
      const request = RecordingControlRequestSchema.parse(decoded);
      const status = await this.service.execute(request);
      this.send(client, RecordingControlResponseSchema.parse({ version: 1, requestId: request.requestId, ok: true, status, error: null }));
    } catch (error) {
      const status = await this.service.status();
      this.send(client, RecordingControlResponseSchema.parse({
        version: 1, requestId, ok: false, status, error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private send(client: WebSocket, value: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
  }
}
