import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, constants, cp, mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sampleRate = 16_000;
const dayMs = 24 * 60 * 60 * 1_000;

type InvocationKind = "query" | "mutation" | "action";
type FunctionArgs = Record<string, unknown>;

export interface ManagedConvexPartDescriptor {
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ManagedConvexManifest {
  readonly recordingId: string;
  readonly audioId: string;
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly partsManifestSha256: string;
  readonly parts: readonly ManagedConvexPartDescriptor[];
}

export interface ManagedConvexManifestFixture {
  readonly manifest: ManagedConvexManifest;
  readonly bytes: readonly Uint8Array[];
}

export interface ManagedConvexDevice {
  readonly deviceId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly token: string;
  readonly tokenIdentifier: string;
  readonly accountId: string;
}

export interface ManagedConvexCheckpoint {
  readonly partNumber: number;
  readonly sampleOffset: number;
  readonly sampleCount: number;
  readonly byteLength: number;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly executionToken: string | null;
  readonly leaseExpiresAt: number;
  readonly attempt: number;
  readonly requestId: string;
  readonly providerText: string | null;
  readonly detectedLanguages: readonly string[];
  readonly completedAt: number | null;
  readonly failureReason: string | null;
}

export interface ManagedConvexHarness {
  readonly device: ManagedConvexDevice;
  invoke<T = any>(kind: InvocationKind, name: string, args: FunctionArgs, token?: string): Promise<T>;
  uploadAndRegister(fixture: ManagedConvexManifestFixture): Promise<{ sessionId: string }>;
  checkpoints(jobId: string): Promise<ManagedConvexCheckpoint[]>;
  quota(): Promise<{ limitSeconds: number; usedSeconds: number; reservedSeconds: number }>;
  cleanup(): Promise<void>;
}

interface HarnessRuntime extends ManagedConvexHarness {
  stop(): Promise<void>;
}

/**
 * Starts the repository's local Convex backend, pushes a copy of the current
 * `convex/` source, and exposes only the calls needed by the transition proof.
 * The production functions are invoked over Convex HTTP; no handler is
 * reimplemented in this support module.
 */
export async function startManagedConvexHarness(): Promise<HarnessRuntime> {
  // The local Node executor uses a Unix-domain socket under TMPDIR. Keep this
  // root short enough for macOS's sockaddr_un path limit; the state remains
  // isolated because every test-owned directory is still below this root.
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = await realpath(await mkdtemp(path.join(tempRoot, "meetless-managed-convex-state-")));
  const paths = {
    home: path.join(root, "home"),
    xdgConfigHome: path.join(root, "xdg-config"),
    xdgCacheHome: path.join(root, "xdg-cache"),
    xdgDataHome: path.join(root, "xdg-data"),
    xdgStateHome: path.join(root, "xdg-state"),
    tmpDir: path.join(root, "tmp"),
    convexTmpDir: path.join(root, "convex-tmp"),
    storage: path.join(root, "storage"),
    sqlite: path.join(root, "sqlite"),
    project: path.join(root, "project"),
    envDir: path.join(root, "env"),
  };
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
  await cp(path.join(repositoryRoot, "convex"), path.join(paths.project, "convex"), { recursive: true, dereference: true });
  const quotaContract = path.join("packages", "meeting-domain", "src", "managed-quota.ts");
  await mkdir(path.dirname(path.join(paths.project, quotaContract)), { recursive: true });
  await cp(path.join(repositoryRoot, quotaContract), path.join(paths.project, quotaContract), { dereference: true });
  await cp(path.join(repositoryRoot, "package.json"), path.join(paths.project, "package.json"), { dereference: true });
  await mkdir(path.join(paths.project, "node_modules"), { recursive: true });
  await copyPackageClosure(paths.project, ["convex", "jose", "@apple/app-store-server-library", "typescript"]);
  await mkdir(path.join(paths.project, "node_modules", ".bin"), { recursive: true });
  await symlink("../typescript/bin/tsc", path.join(paths.project, "node_modules", ".bin", "tsc"));

  const backendPath = await installedBackendPath();
  const convexCliPath = path.join(repositoryRoot, "node_modules", "convex", "bin", "main.js");
  const nodePath = path.resolve(process.execPath);
  const [backendPort, sitePort] = await Promise.all([freePort(), freePort()]);
  const endpoint = `http://127.0.0.1:${backendPort}`;
  const siteEndpoint = `http://127.0.0.1:${sitePort}`;
  const instanceName = `meetless-managed-state-${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const instanceSecret = randomBytes(32).toString("hex");
  const childEnvironment = isolatedEnvironment(paths);
  let backend: ChildProcess | null = null;
  let adminKey = "";
  let stopped = false;
  let diagnostic = "";

  const run = (filePath: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) =>
    runCommand(filePath, args, { cwd, env: environment });

  try {
    adminKey = (await run(backendPath, [
      "keygen", "admin-key", "--instance-name", instanceName, "--instance-secret", instanceSecret,
    ], root, childEnvironment)).trim();
    if (!adminKey) throw new Error("local Convex state proof did not receive an admin key");

    backend = spawn(backendPath, [
      "--port", String(backendPort),
      "--site-proxy-port", String(sitePort),
      "--convex-origin", endpoint,
      "--convex-site", siteEndpoint,
      "--instance-name", instanceName,
      "--instance-secret", instanceSecret,
      "--local-storage", paths.storage,
      "--disable-beacon",
      path.join(paths.sqlite, "convex.sqlite3"),
    ], {
      cwd: root,
      env: childEnvironment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stderr?.on("data", (chunk: Buffer | string) => { diagnostic = `${diagnostic}${chunk}`.slice(-8_192); });
    backend.stdout?.on("data", (chunk: Buffer | string) => { diagnostic = `${diagnostic}${chunk}`.slice(-8_192); });
    await waitForBackend(backend, endpoint, instanceName, diagnosticValue(() => diagnostic));

    const runtimeEnvironment = {
      MEETLESS_DEPLOYMENT_MODE: "hosted-development",
      MEETLESS_MANAGED_ALLOWANCE_SECONDS: "20",
      MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test",
      MEETLESS_MANAGED_PROVIDER_MODE: "fake",
      MEETLESS_APPLE_VERIFIER_MODE: "fixture",
      MEETLESS_AUTH_ISSUER: "https://meetless.invalid/managed-state-test",
      MEETLESS_AUTH_AUDIENCE: "meetless-managed",
      MEETLESS_AUTH_KEY_ID: "managed-state-test-key",
      MEETLESS_AUTH_PRIVATE_KEY_PKCS8: "",
      MEETLESS_AUTH_PUBLIC_JWK: "",
      MEETLESS_REVENUECAT_AUTH_MODE: "hmac",
      MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET: randomBytes(32).toString("hex"),
      MEETLESS_REVENUECAT_ENVIRONMENT: "SANDBOX",
    };
    const authKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    runtimeEnvironment.MEETLESS_AUTH_PRIVATE_KEY_PKCS8 = authKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    runtimeEnvironment.MEETLESS_AUTH_PUBLIC_JWK = JSON.stringify({
      ...authKeys.publicKey.export({ format: "jwk" }),
      kid: runtimeEnvironment.MEETLESS_AUTH_KEY_ID,
      alg: "ES256",
      use: "sig",
    });
    const update = await fetch(`${endpoint}/api/update_environment_variables`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Convex ${adminKey}` },
      body: JSON.stringify({ changes: Object.entries(runtimeEnvironment).map(([name, value]) => ({ name, value })) }),
    });
    if (!update.ok) throw new Error(`local Convex environment setup failed (${update.status})`);

    const envFile = path.join(paths.envDir, "convex.env");
    await writeFile(envFile, `CONVEX_SELF_HOSTED_URL=${endpoint}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
    const cliEnvironment = {
      ...childEnvironment,
      CONVEX_SELF_HOSTED_URL: endpoint,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    };
    await run(nodePath, [
      convexCliPath, "dev", "--once", "--typecheck", "enable", "--codegen", "enable", "--tail-logs", "disable", "--env-file", envFile,
    ], paths.project, cliEnvironment);

    const adminClient = new ConvexHttpClient(endpoint, { logger: false });
    (adminClient as ConvexHttpClient & { setAdminAuth(token: string): void }).setAdminAuth(adminKey);
    const invoke = async <T = any>(kind: InvocationKind, name: string, args: FunctionArgs, token?: string): Promise<T> => {
      const client = new ConvexHttpClient(endpoint, { logger: false });
      if (token) client.setAuth(token);
      else (client as ConvexHttpClient & { setAdminAuth(token: string): void }).setAdminAuth(adminKey);
      const reference = makeFunctionReference(name) as any;
      if (kind === "query") return await client.query(reference, args) as T;
      if (kind === "mutation") return await client.mutation(reference, args) as T;
      return await client.action(reference, args) as T;
    };

    const device = await enrollDevice(invoke, runtimeEnvironment.MEETLESS_AUTH_ISSUER);
    const harness: HarnessRuntime = {
      device,
      invoke,
      async uploadAndRegister(fixture) {
        const session = await invoke<{ sessionId: string }>("mutation", "managedTranscription:beginUpload", { manifest: fixture.manifest }, device.token);
        for (const [index, bytes] of fixture.bytes.entries()) {
          const part = fixture.manifest.parts[index];
          if (!part) throw new Error("manifest fixture part is missing");
          const uploadUrl = await invoke<string>("mutation", "managedTranscription:generateUploadUrl", { sessionId: session.sessionId }, device.token);
          const upload = await fetch(uploadUrl, { method: "POST", body: bytes as BodyInit });
          if (!upload.ok) throw new Error(`local Convex storage upload failed (${upload.status})`);
          const uploaded = await upload.json() as { storageId?: string };
          if (!uploaded.storageId) throw new Error("local Convex storage upload returned no storage ID");
          await invoke("mutation", "managedTranscription:registerPart", {
            sessionId: session.sessionId,
            partNumber: part.partNumber,
            sampleOffset: part.sampleOffset,
            sampleCount: part.sampleCount,
            byteLength: part.byteLength,
            sha256: part.sha256,
            storageId: uploaded.storageId,
          }, device.token);
        }
        return { sessionId: session.sessionId };
      },
      async checkpoints(jobId) {
        return await adminClient.query(makeFunctionReference("managedTranscription:readJobPartCheckpoints") as any, { jobId }) as ManagedConvexCheckpoint[];
      },
      async quota() {
        return await adminClient.query(makeFunctionReference("managedTranscription:readLocalCanaryQuota") as any, { accountId: device.accountId }) as { limitSeconds: number; usedSeconds: number; reservedSeconds: number };
      },
      async cleanup() {
        await invoke("mutation", "managedTranscription:clearLocalCanary", { accountId: device.accountId });
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await harness.cleanup().catch(() => undefined);
        await terminateProcess(backend);
        backend = null;
        await rm(root, { recursive: true, force: true });
      },
    };
    return harness;
  } catch (error) {
    await terminateProcess(backend);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    const detail = diagnostic.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `; backend: ${detail}` : ""}`);
  }
}

async function copyPackageClosure(projectPath: string, packageNames: readonly string[]): Promise<void> {
  const pending = [...packageNames];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const packageName = pending.pop()!;
    if (copied.has(packageName)) continue;
    const source = path.join(repositoryRoot, "node_modules", packageName);
    const destination = path.join(projectPath, "node_modules", packageName);
    await access(path.join(source, "package.json"));
    await cp(source, destination, { recursive: true, dereference: true });
    copied.add(packageName);

    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!copied.has(dependency)) pending.push(dependency);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (copied.has(dependency)) continue;
      try {
        await access(path.join(repositoryRoot, "node_modules", dependency, "package.json"));
        pending.push(dependency);
      } catch {
        // Platform-specific optional packages may not be installed locally.
      }
    }
  }
}

export function twoPartManifest(recordingId: string, counts: readonly [number, number] = [160, 320]): ManagedConvexManifestFixture {
  const bytes = counts.map((count, index) => canonicalPart(count, index + 1));
  let sampleOffset = 0;
  const parts = bytes.map((partBytes, index) => {
    const descriptor = {
      partNumber: index + 1,
      sampleOffset,
      sampleCount: counts[index]!,
      byteLength: partBytes.byteLength,
      sha256: sha256(partBytes),
    };
    sampleOffset += counts[index]!;
    return descriptor;
  });
  const sampleCount = sampleOffset;
  let partsManifestSha256 = "";
  const manifest: ManagedConvexManifest = {
    recordingId,
    audioId: `recording:${recordingId}`,
    manifestSha256: sha256(`manifest:${recordingId}`),
    contentSha256: sha256(Buffer.concat([Buffer.from(canonicalWavHeader(sampleCount)), ...bytes.map((part) => Buffer.from(part).subarray(44))])),
    byteLength: 44 + sampleCount * 2,
    durationMs: Math.max(1, Math.ceil(sampleCount / sampleRate * 1_000)),
    sampleCount,
    partsManifestSha256,
    parts,
  };
  partsManifestSha256 = sha256(JSON.stringify({
    version: 1,
    recordingId,
    audioId: manifest.audioId,
    sampleCount,
    parts: parts.map(({ partNumber, sampleOffset: offset, sampleCount: count, byteLength, sha256: digest }) => ({
      partNumber, sampleOffset: offset, sampleCount: count, byteLength, sha256: digest,
    })),
  }));
  return { manifest: { ...manifest, partsManifestSha256 }, bytes };
}

async function enrollDevice(
  invoke: <T = any>(kind: InvocationKind, name: string, args: FunctionArgs, token?: string) => Promise<T>,
  issuer: string,
): Promise<ManagedConvexDevice> {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = keyPair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const publicKey = rawPublicKey.toString("base64url");
  const deviceId = `managed-state-device-${randomBytes(6).toString("hex")}`;
  const keyId = `managed-state-key-${sha256(rawPublicKey).slice(0, 16)}`;
  const challenge = await invoke<{ challengeId: string; signingPayload: string; issuer: string }>("mutation", "managedAuth:createDeviceChallenge", {
    purpose: "enrollment", deviceId, keyId, publicKey,
  });
  const signature = sign("sha256", Buffer.from(challenge.signingPayload, "base64url"), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const originalTransactionId = `managed-state-lineage-${randomBytes(6).toString("hex")}`;
  const apple = {
    adapter: "fixture" as const,
    bundleId: "com.meetless.app",
    environment: "SANDBOX" as const,
    productId: "com.meetless.app.premium.monthly",
    originalTransactionId,
    periodType: "normal" as const,
    startedAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + dayMs,
    currentState: "active" as const,
  };
  const enrolled = await invoke<{ authToken: string }>("action", "managedAuthActions:enrollDevice", {
    challengeId: challenge.challengeId,
    deviceId,
    keyId,
    publicKey,
    signature,
    apple: { ...apple, fixtureProof: sha256(JSON.stringify({ version: 1, ...apple })) },
  });
  const tokenIdentifier = `${issuer}|managed-device:${deviceId}`;
  const account = await invoke<{ accountId: string }>("query", "managedTranscription:identityAccount", { tokenIdentifier });
  return {
    deviceId,
    keyId,
    publicKey,
    token: enrolled.authToken,
    tokenIdentifier,
    accountId: account.accountId,
  };
}

function canonicalPart(sampleCount: number, marker: number): Uint8Array {
  const pcm = Buffer.alloc(sampleCount * 2);
  pcm.writeInt16LE(marker, 0);
  return Buffer.concat([Buffer.from(canonicalWavHeader(sampleCount)), pcm]);
}

function canonicalWavHeader(sampleCount: number): Uint8Array {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + sampleCount * 2, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(sampleCount * 2, 40);
  return bytes;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isolatedEnvironment(paths: Record<string, string>): NodeJS.ProcessEnv {
  return {
    CI: "1",
    DISABLE_BEACON: "1",
    PATH: process.env.PATH,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_STATE_HOME: paths.xdgStateHome,
    TMPDIR: paths.tmpDir,
    TMP: paths.tmpDir,
    TEMP: paths.tmpDir,
    CONVEX_TMPDIR: paths.convexTmpDir,
  };
}

async function installedBackendPath(): Promise<string> {
  const binaryRoot = path.join(process.env.HOME ?? "", ".cache", "convex", "binaries");
  const binary = process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend";
  const entries = await (await import("node:fs/promises")).readdir(binaryRoot, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("precompiled-")) continue;
    const candidate = path.join(binaryRoot, entry.name, binary);
    try {
      await access(candidate, constants.X_OK);
      candidates.push(candidate);
    } catch {
      // Ignore incomplete cache entries.
    }
  }
  if (candidates.length !== 1) throw new Error("production-faithful Convex proof requires exactly one installed local backend");
  return candidates[0]!;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local proof could not allocate a loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function runCommand(filePath: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(filePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${path.basename(filePath)} failed: ${String(stderr || error.message).slice(-4_096)}`));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

async function waitForBackend(child: ChildProcess, endpoint: string, expectedName: string, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local Convex backend exited before readiness${diagnostic() ? `: ${diagnostic().slice(-2_048)}` : ""}`);
    try {
      const response = await fetch(`${endpoint}/instance_name`);
      if (response.ok && (await response.text()).trim() === expectedName) return;
    } catch {
      // The backend may still be binding its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local Convex backend did not become ready${diagnostic() ? `: ${diagnostic().slice(-2_048)}` : ""}`);
}

async function terminateProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function diagnosticValue(read: () => string): () => string {
  return read;
}
