import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  RecordingControlRequestSchema,
  RecordingControlResponseSchema,
  RecordingStatusEventSchema,
} from "@meetless/meeting-contracts";
import type { RecordingService } from "./recording-service.js";
import {
  RecordingRuntimeReadinessRequestSchema,
  RecordingRuntimeReadinessResponseSchema,
  type CollisionEvidence,
  type RecordingRuntimeReadinessRequest,
} from "./readiness-protocol.js";

export class RecordingControlServer {
  private readonly http = createServer();
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly service: RecordingService,
    private readonly identity = { instanceId: randomUUID(), startedAt: new Date().toISOString() },
  ) {
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
      const readiness = RecordingRuntimeReadinessRequestSchema.safeParse(decoded);
      if (readiness.success) {
        await this.handleReadiness(client, readiness.data);
        return;
      }
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

  private async handleReadiness(client: WebSocket, request: RecordingRuntimeReadinessRequest): Promise<void> {
    let collision: CollisionEvidence | null = null;
    try {
      if (request.operation === "prepareCollision") {
        collision = await this.service.prepareCollisionEvidence(this.identity.instanceId);
      } else if (request.operation === "validateCollision") {
        collision = await this.service.validateCollisionEvidence(this.identity.instanceId);
      }
      this.send(client, RecordingRuntimeReadinessResponseSchema.parse({
        version: 1,
        type: "recording.runtime.readiness",
        requestId: request.requestId,
        ok: true,
        runtime: await this.runtimeIdentity(),
        status: await this.service.status(),
        collision,
        error: null,
      }));
    } catch (error) {
      this.send(client, RecordingRuntimeReadinessResponseSchema.parse({
        version: 1,
        type: "recording.runtime.readiness",
        requestId: request.requestId,
        ok: false,
        runtime: await this.runtimeIdentity(),
        status: await this.service.status(),
        collision: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async runtimeIdentity() {
    const [socketInfo, configuredInfo, helperBytes, helperRealPath] = await Promise.all([
      stat(this.socketPath),
      stat(this.service.config.helperPath),
      readFile(this.service.config.helperPath),
      realpath(this.service.config.helperPath),
    ]);
    const helper = this.service.helperRuntime();
    return {
      ...this.identity,
      pluginPid: process.pid,
      socketPath: this.socketPath,
      socketIdentity: { device: socketInfo.dev, inode: socketInfo.ino },
      capture: {
        mode: this.service.config.fixture ? "fixture" as const : "production" as const,
        executable: {
          configuredPath: this.service.config.helperPath,
          realPath: helperRealPath,
          device: configuredInfo.dev,
          inode: configuredInfo.ino,
          byteLength: configuredInfo.size,
          sha256: createHash("sha256").update(helperBytes).digest("hex"),
        },
        arguments: helper.arguments,
        helperPid: helper.pid,
      },
      export: {
        root: this.service.config.exportRoot,
        fixtureStampApplied: this.service.config.fixtureStampApplied === true,
      },
    };
  }

  private send(client: WebSocket, value: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
  }
}
