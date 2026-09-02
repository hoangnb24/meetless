import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  RecordingControlRequestSchema,
  RecordingControlResponseSchema,
  RecordingStatusEventSchema,
} from "@meetless/meeting-contracts";
import type { RecordingService } from "./recording-service.js";
import type { RuntimeEndpoint } from "./runtime-endpoints.js";
import {
  RecordingRuntimeReadinessRequestSchema,
  RecordingRuntimeReadinessResponseSchema,
  type CollisionEvidence,
  type RecordingRuntimeReadinessRequest,
} from "./readiness-protocol.js";

const RECORDING_ENDPOINT_OWNER_SCHEMA = "MEETLESS_RECORDING_ENDPOINT_OWNER v1";

export type RecordingSocketEndpoint = Pick<RuntimeEndpoint, "role" | "mode" | "workingDirectory" | "name" | "bindArgument" | "canonicalPath">;

interface RecordingEndpointOwner {
  schema: typeof RECORDING_ENDPOINT_OWNER_SCHEMA;
  role: "recording";
  endpointName: string;
  canonicalPath: string;
  pid: number;
  token: string;
}

export class RecordingControlServer {
  private readonly http = createServer();
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | null = null;
  private owner: RecordingEndpointOwner | null = null;
  private ownsEndpoint = false;

  constructor(
    endpoint: string | RecordingSocketEndpoint,
    private readonly service: RecordingService,
    private readonly identity = { instanceId: randomUUID(), startedAt: new Date().toISOString() },
  ) {
    this.endpoint = normalizeEndpoint(endpoint);
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

  private readonly endpoint: RecordingSocketEndpoint;

  async start(): Promise<void> {
    const maximumSocketPathBytes = process.platform === "darwin" ? 103 : 107;
    if (Buffer.byteLength(this.endpoint.bindArgument) > maximumSocketPathBytes) {
      throw new Error(
        `Recording control socket path is too long for ${process.platform}: ${this.endpoint.bindArgument}. ` +
          `Endpoint recording policy ${this.endpoint.name} must use a bind argument of at most ${maximumSocketPathBytes} bytes; ` +
          "Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md and PLAN_RECONCILIATION v47. " +
          "Next action: use the accepted relative endpoint name and canonical runtime-root working directory.",
      );
    }
    if (this.endpoint.mode === "packaged" && path.resolve(process.cwd()) !== this.endpoint.workingDirectory) {
      throw endpointFailure(
        `process CWD ${process.cwd()} differs from the authoritative runtime-root working directory ${this.endpoint.workingDirectory}`,
      );
    }
    const endpointDirectory = path.dirname(this.endpoint.canonicalPath);
    await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
    if (await realpath(endpointDirectory) !== path.resolve(endpointDirectory)) {
      throw endpointFailure(`recording endpoint directory ${endpointDirectory} resolves through a symlink; it was not used`);
    }
    await chmod(endpointDirectory, 0o700);
    await reconcileEndpoint(this.endpoint);
    const owner: RecordingEndpointOwner = {
      schema: RECORDING_ENDPOINT_OWNER_SCHEMA,
      role: "recording",
      endpointName: this.endpoint.name,
      canonicalPath: this.endpoint.canonicalPath,
      pid: process.pid,
      token: randomUUID(),
    };
    await writeOwnerMarker(owner, ownerMarkerPath(this.endpoint.canonicalPath));
    this.owner = owner;
    try {
      await new Promise<void>((resolve, reject) => {
        this.http.once("error", reject);
        this.http.listen(this.endpoint.bindArgument, () => { this.http.off("error", reject); resolve(); });
      });
      await chmod(this.endpoint.canonicalPath, 0o600);
      this.ownsEndpoint = true;
    } catch (error) {
      const wasListening = this.http.listening;
      await closeHttpServer(this.http);
      if (wasListening) {
        await removeOwnedEndpoint(owner, this.endpoint.canonicalPath).catch(() => undefined);
      } else {
        await removeOwnerMarker(owner, ownerMarkerPath(this.endpoint.canonicalPath));
      }
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
    await closeHttpServer(this.http);
    if (this.ownsEndpoint && this.owner) {
      await removeOwnedEndpoint(this.owner, this.endpoint.canonicalPath);
      this.ownsEndpoint = false;
    }
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
      stat(this.endpoint.canonicalPath),
      stat(this.service.config.helperPath),
      readFile(this.service.config.helperPath),
      realpath(this.service.config.helperPath),
    ]);
    const helper = this.service.helperRuntime();
    return {
      ...this.identity,
      pluginPid: process.pid,
      socketPath: this.endpoint.canonicalPath,
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

function normalizeEndpoint(endpoint: string | RecordingSocketEndpoint): RecordingSocketEndpoint {
  if (typeof endpoint === "string") {
    if (!path.isAbsolute(endpoint)) {
      throw endpointFailure(`development recording socket ${endpoint} must remain an absolute path`);
    }
    const canonicalPath = path.resolve(endpoint);
    return {
      role: "recording",
      mode: "development",
      workingDirectory: process.cwd(),
      name: canonicalPath,
      bindArgument: canonicalPath,
      canonicalPath,
    };
  }
  if (endpoint.role !== "recording" ||
      !path.isAbsolute(endpoint.workingDirectory) || path.resolve(endpoint.workingDirectory) !== endpoint.workingDirectory ||
      !path.isAbsolute(endpoint.canonicalPath) || path.resolve(endpoint.canonicalPath) !== endpoint.canonicalPath ||
      !endpoint.bindArgument || !endpoint.name) {
    throw endpointFailure("recording endpoint descriptor is incomplete");
  }
  if (endpoint.mode !== "packaged" && endpoint.mode !== "development") {
    throw endpointFailure(`recording endpoint mode ${JSON.stringify(endpoint.mode)} is unsupported`);
  }
  if (endpoint.mode === "packaged" || !path.isAbsolute(endpoint.name)) {
    validateRelativeEndpointName(endpoint.name);
    const projected = path.resolve(endpoint.workingDirectory, endpoint.name);
    const relative = path.relative(endpoint.workingDirectory, projected);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || projected !== endpoint.canonicalPath) {
      throw endpointFailure(`recording endpoint name ${JSON.stringify(endpoint.name)} does not project inside ${endpoint.workingDirectory}`);
    }
    if (endpoint.mode === "packaged" && endpoint.bindArgument !== endpoint.name) {
      throw endpointFailure(`packaged recording bind argument ${JSON.stringify(endpoint.bindArgument)} is not the authoritative relative endpoint name`);
    }
  } else if (path.resolve(endpoint.name) !== endpoint.canonicalPath) {
    throw endpointFailure(`development recording endpoint name ${JSON.stringify(endpoint.name)} differs from its canonical path`);
  }
  const expectedBindArgument = endpoint.mode === "packaged" ? endpoint.name : endpoint.canonicalPath;
  if (endpoint.bindArgument !== expectedBindArgument) {
    throw endpointFailure(`recording bind argument ${JSON.stringify(endpoint.bindArgument)} differs from ${JSON.stringify(expectedBindArgument)}`);
  }
  return { ...endpoint, canonicalPath: endpoint.canonicalPath };
}

function validateRelativeEndpointName(name: string): void {
  if (name.length === 0 || name !== name.trim() || name.includes("\\") || name.includes("\u0000") ||
      path.isAbsolute(name) || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw endpointFailure(`recording endpoint name ${JSON.stringify(name)} must be a safe relative name`);
  }
  if (Buffer.byteLength(name, "utf8") > 103) {
    throw endpointFailure(`recording endpoint name ${JSON.stringify(name)} exceeds the 103-byte Darwin limit`);
  }
}

async function reconcileEndpoint(endpoint: RecordingSocketEndpoint): Promise<void> {
  const markerPath = ownerMarkerPath(endpoint.canonicalPath);
  const endpointState = await lstat(endpoint.canonicalPath).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    throw endpointFailure(`cannot inspect recording endpoint ${endpoint.canonicalPath}: ${describe(error)}`);
  });
  const marker = await readOwnerMarker(markerPath, endpoint);
  if (!endpointState) {
    if (marker && !(await ownerProcessIsRunning(marker.pid))) {
      await removeOwnerMarker(marker, markerPath);
    } else if (marker) {
      throw endpointFailure(`recording endpoint owner PID ${marker.pid} is still running while its socket is absent`);
    }
    return;
  }
  if (endpointState.isSymbolicLink() || !endpointState.isSocket()) {
    throw endpointFailure(
      `recording endpoint ${endpoint.canonicalPath} is occupied by a foreign ${endpointState.isSymbolicLink() ? "symlink" : "non-socket entry"}; it was not removed`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && endpointState.uid !== uid) {
    throw endpointFailure(`recording endpoint ${endpoint.canonicalPath} is owned by a foreign user; it was not removed`);
  }
  if (!marker) {
    throw endpointFailure(
      `recording endpoint ${endpoint.canonicalPath} is an unknown socket without an owned marker; it was not removed`,
    );
  }
  if (await ownerProcessIsRunning(marker.pid) || await socketIsReachable(endpoint.canonicalPath)) {
    throw endpointFailure(`recording endpoint ${endpoint.canonicalPath} is concurrently occupied; it was not removed`);
  }
  const current = await lstat(endpoint.canonicalPath).catch(() => null);
  if (current?.isSocket() && current.dev === endpointState.dev && current.ino === endpointState.ino) {
    await unlink(endpoint.canonicalPath);
  } else {
    throw endpointFailure(`recording endpoint ${endpoint.canonicalPath} changed during stale cleanup; it was not removed`);
  }
  await removeOwnerMarker(marker, markerPath);
}

async function writeOwnerMarker(owner: RecordingEndpointOwner, markerPath: string): Promise<void> {
  try {
    await writeFile(markerPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw endpointFailure(`recording endpoint owner marker ${markerPath} is foreign, occupied, or unavailable: ${describe(error)}`);
  }
}

async function removeOwnerMarker(owner: RecordingEndpointOwner, markerPath: string): Promise<void> {
  const state = await lstat(markerPath).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    return undefined;
  });
  if (!state || state.isSymbolicLink() || !state.isFile()) return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && state.uid !== uid) || (state.mode & 0o077) !== 0) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return;
  }
  if (isRecord(decoded) &&
      decoded.schema === RECORDING_ENDPOINT_OWNER_SCHEMA &&
      decoded.role === "recording" &&
      decoded.endpointName === owner.endpointName &&
      decoded.canonicalPath === owner.canonicalPath &&
      decoded.pid === owner.pid &&
      decoded.token === owner.token) {
    await unlink(markerPath).catch(() => undefined);
  }
}

async function readOwnerMarker(markerPath: string, endpoint: RecordingSocketEndpoint): Promise<RecordingEndpointOwner | null> {
  const state = await lstat(markerPath).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    throw endpointFailure(`cannot inspect recording endpoint owner marker ${markerPath}: ${describe(error)}`);
  });
  if (!state) return null;
  if (state.isSymbolicLink() || !state.isFile()) {
    throw endpointFailure(`recording endpoint owner marker ${markerPath} is not an owned regular file; it was not removed`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw endpointFailure(`recording endpoint owner marker ${markerPath} is invalid: ${describe(error)}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!isRecord(decoded) ||
      (uid !== undefined && state.uid !== uid) ||
      (state.mode & 0o077) !== 0 ||
      Object.keys(decoded).sort().join("\u0000") !== "canonicalPath\u0000endpointName\u0000pid\u0000role\u0000schema\u0000token" ||
      decoded.schema !== RECORDING_ENDPOINT_OWNER_SCHEMA ||
      decoded.role !== "recording" ||
      decoded.endpointName !== endpoint.name ||
      decoded.canonicalPath !== endpoint.canonicalPath ||
      !Number.isInteger(decoded.pid) || (decoded.pid as number) <= 1 ||
      typeof decoded.token !== "string" || decoded.token.length === 0) {
    throw endpointFailure(`recording endpoint owner marker ${markerPath} does not match the accepted recording policy`);
  }
  return decoded as unknown as RecordingEndpointOwner;
}

async function removeOwnedEndpoint(owner: RecordingEndpointOwner, canonicalPath: string): Promise<void> {
  const markerPath = ownerMarkerPath(canonicalPath);
  const marker = await readOwnerMarker(markerPath, {
    mode: "development",
    workingDirectory: path.dirname(canonicalPath),
    role: "recording",
    name: owner.endpointName,
    bindArgument: canonicalPath,
    canonicalPath,
  });
  if (marker && marker.token !== owner.token) {
    throw endpointFailure(`recording endpoint ${canonicalPath} was replaced by another owner; it was not removed`);
  }
  const state = await lstat(canonicalPath).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    throw endpointFailure(`cannot inspect recording endpoint during shutdown: ${describe(error)}`);
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (state && (!state.isSocket() || state.isSymbolicLink() || uid !== undefined && state.uid !== uid)) {
    throw endpointFailure(`recording endpoint ${canonicalPath} changed to a foreign entry; it was not removed`);
  }
  if (state && marker?.token === owner.token) await unlink(canonicalPath);
  if (marker?.token === owner.token) await unlink(markerPath);
}

async function socketIsReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ECONNREFUSED" || code === "ENOENT" ? false : true);
    });
    socket.setTimeout(250, () => finish(true));
  });
}

async function ownerProcessIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw endpointFailure(`cannot inspect recording endpoint owner PID ${pid}: ${describe(error)}`);
  }
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function ownerMarkerPath(canonicalPath: string): string {
  return `${canonicalPath}.owner.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function endpointFailure(reason: string): Error {
  return new Error(
    `Runtime endpoint recording violates policy: ${reason}. Authority: docs/decisions/0005-mac-app-store-and-revenuecat.md, ` +
      "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md, docs/decisions/0004-recording-host-and-capture-permission-boundary.md, and PLAN_RECONCILIATION v47. " +
      "Next action: stop before launch, preserve foreign entries, and retry with the accepted runtime-root endpoint composition.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
