#!/usr/bin/env node

import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { access, constants, cp, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  PROOF_PORTS,
  LocalProofGuardError,
  assertAllowedExecutable,
  assertProofChildEnvironment,
  assertProofPathContainment,
  assertProofInputEnvironment,
  guardedFetch,
} from "./prove-managed-convex-guard.mjs";
import {
  DEFAULT_OWNED_COMMAND_TIMEOUT_MS,
  DEFAULT_OWNED_KILL_TIMEOUT_MS,
  DEFAULT_OWNED_STARTUP_TIMEOUT_MS,
  DEFAULT_OWNED_TERM_TIMEOUT_MS,
  cleanupOwnedProcesses,
  redactDiagnostic,
  runBoundedOwnedCommand,
  startBoundedOwnedProcess,
  terminateOwnedProcess,
  withDeadline,
} from "./prove-managed-convex-runtime.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const localBackendUrl = `http://127.0.0.1:${PROOF_PORTS.backend}`;
const localSiteUrl = `http://127.0.0.1:${PROOF_PORTS.site}`;
const convexCliPath = path.join(repositoryRoot, "node_modules", "convex", "bin", "main.js");
const typescriptCliPath = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const sampleRate = 16_000;
const maxPartSamples = sampleRate * 10 * 60;
const periodDay = 24 * 60 * 60 * 1_000;
const runId = `${Date.now()}-${process.pid}`;
const proofDeploymentName = `meetless-r4-local-proof-${runId}`;
const globalProofDeadlineMs = 120_000;
const diagnosticArguments = new Set(["--diagnostic-only", "--network-denied-sandbox"]);

let proofRoot = null;
let proofProjectRoot = null;
let proofPaths = null;
let proofCanonicalRoot = null;
let proofEnvPath = null;
let backendBinaryPath = null;
let adminKey = null;
let backendProcess = null;
let backendStarted = false;
const ownedProcesses = new Set();
let proofState = null;
let backendFailure = null;
let activeStage = "startup";

function markStage(stage, state) {
  activeStage = stage;
  process.stderr.write(`[managed-convex-local] ${stage}:${state}\n`);
}

function assertDiagnosticOptIn() {
  const provided = process.argv.slice(2);
  if (provided.length !== diagnosticArguments.size || provided.some((argument) => !diagnosticArguments.has(argument))) {
    throw new Error("diagnostic backend canary is disabled; prerequisite is an externally enforced network-denied sandbox with loopback allowed");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function initializeProofState() {
  const authKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const authKeyId = "hosted-development-fixture";
  const authIssuer = "https://meetless.invalid/hosted-development";
  const authAudience = "meetless-managed";
  const authPrivateKey = authKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const authPublicJwk = {
    ...authKeys.publicKey.export({ format: "jwk" }),
    kid: authKeyId,
    alg: "ES256",
    use: "sig",
  };
  const originalTransactionId = `hosted-development-apple-${runId}`;
  proofState = {
    authPrivateKey,
    authPublicJwk,
    authKeyId,
    authIssuer,
    authAudience,
    originalTransactionId,
    lineageKey: `apple-lineage:${sha256(originalTransactionId)}`,
    accountId: `apple-account:${sha256(originalTransactionId)}`,
    webhookSecret: randomBytes(32).toString("hex"),
  };
}

function canonicalWavHeader(sampleCount) {
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

function canonicalPart(sampleCount, marker) {
  const pcm = Buffer.alloc(sampleCount * 2);
  if (marker !== 0) pcm.writeInt16LE(marker, 0);
  return Buffer.concat([canonicalWavHeader(sampleCount), pcm]);
}

function partsDigestPayload(manifest) {
  return JSON.stringify({
    version: 1,
    recordingId: manifest.recordingId,
    audioId: manifest.audioId,
    sampleCount: manifest.sampleCount,
    parts: manifest.parts.map(({ partNumber, sampleOffset, sampleCount: count, byteLength, sha256: digest }) => ({
      partNumber, sampleOffset, sampleCount: count, byteLength, sha256: digest,
    })),
  });
}

function timelineManifest(recordingId, counts = [sampleRate], marker = 1) {
  const parts = [];
  let sampleOffset = 0;
  const pcm = [];
  for (const [index, count] of counts.entries()) {
    if (count > maxPartSamples) throw new Error("proof part accidentally exceeded the ten-minute bound");
    const bytes = canonicalPart(count, marker + index);
    parts.push({ partNumber: index + 1, sampleOffset, sampleCount: count, byteLength: bytes.byteLength, sha256: sha256(bytes) });
    pcm.push(bytes.subarray(44));
    sampleOffset += count;
  }
  const sampleCount = sampleOffset;
  const manifest = {
    recordingId,
    audioId: `recording:${recordingId}`,
    manifestSha256: sha256(`manifest:${runId}:${recordingId}`),
    contentSha256: sha256(Buffer.concat([canonicalWavHeader(sampleCount), ...pcm])),
    byteLength: 44 + sampleCount * 2,
    durationMs: Math.max(1, Math.ceil(sampleCount / sampleRate * 1_000)),
    sampleCount,
    partsManifestSha256: "",
    parts,
  };
  manifest.partsManifestSha256 = sha256(partsDigestPayload(manifest));
  return { manifest, bytes: counts.map((count, index) => canonicalPart(count, marker + index)) };
}

function fixtureApple(currentState = "active", expiresAtMs = Date.now() + periodDay) {
  const material = {
    adapter: "fixture",
    bundleId: "com.meetless.app",
    environment: "SANDBOX",
    productId: "com.meetless.app.premium.monthly",
    originalTransactionId: proofState.originalTransactionId,
    periodType: "normal",
    startedAtMs: Date.now() - 1_000,
    expiresAtMs,
    currentState,
  };
  material.fixtureProof = sha256(JSON.stringify({ version: 1, ...material }));
  return material;
}

function deviceKey(label) {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return {
    label,
    privateKey: pair.privateKey,
    deviceId: `hosted-device-${label}-${runId}`,
    publicKey: publicKey.toString("base64url"),
    keyId: `managed-p256-v1-${sha256(publicKey).slice(0, 16)}`,
  };
}

function signChallenge(key, payload) {
  return sign("sha256", Buffer.from(payload, "base64url"), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 30_000, stage = "wait") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const attemptTimeout = Math.max(1, Math.min(1_000, remaining));
    try {
      if (await withDeadline(predicate, { timeoutMs: attemptTimeout, label: `${stage} attempt` })) return;
    } catch (error) {
      if (!String(error?.message ?? error).includes("deadline exceeded")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${stage} timed out`);
}

function isConnectionRefused(error) {
  return error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED" || String(error).includes("ECONNREFUSED");
}

async function assertPortFree(url, port) {
  try {
    await guardedFetch(url, { method: "GET", signal: AbortSignal.timeout(500) }, { port });
  } catch (error) {
    if (error instanceof LocalProofGuardError) throw error;
    if (isConnectionRefused(error)) return;
    throw new Error("proof-owned loopback port could not be checked safely");
  }
  throw new Error(`proof-owned port ${port} is already occupied; no process was started`);
}

async function assertPortClosed(url, port) {
  try {
    await guardedFetch(url, { method: "GET", signal: AbortSignal.timeout(500) }, { port });
  } catch (error) {
    if (error instanceof LocalProofGuardError) throw error;
    if (isConnectionRefused(error)) return;
    throw new Error("proof-owned loopback port did not close cleanly");
  }
  throw new Error(`proof-owned port ${port} remained reachable after cleanup`);
}

async function resolveInstalledBackend() {
  const binaryRoot = path.join(homedir(), ".cache", "convex", "binaries");
  const binaryName = process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend";
  let entries;
  try {
    entries = await readdir(binaryRoot, { withFileTypes: true });
  } catch {
    throw new Error("installed local Convex backend cache is unavailable");
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("precompiled-")) continue;
    const candidate = path.resolve(binaryRoot, entry.name, binaryName);
    try {
      if (await realpath(candidate) !== candidate) continue;
      await access(candidate, constants.X_OK);
      candidates.push(candidate);
    } catch {}
  }
  if (candidates.length !== 1) throw new Error("local proof requires exactly one installed executable backend candidate");
  return candidates[0];
}

function minimalBackendEnvironment() {
  if (!proofRoot || !proofPaths) throw new Error("proof workspace is missing");
  const environment = {
    CI: "1",
    DISABLE_BEACON: "1",
    HOME: proofPaths.home,
    XDG_CONFIG_HOME: proofPaths.xdgConfigHome,
    XDG_CACHE_HOME: proofPaths.xdgCacheHome,
    XDG_DATA_HOME: proofPaths.xdgDataHome,
    XDG_STATE_HOME: proofPaths.xdgStateHome,
    TMPDIR: proofPaths.tmpDir,
    TMP: proofPaths.tmpDir,
    TEMP: proofPaths.tmpDir,
    CONVEX_TMPDIR: proofPaths.convexTmpDir,
  };
  assertProofChildEnvironment(environment, { paths: proofPaths });
  return environment;
}

function minimalCliEnvironment() {
  const environment = {
    ...minimalBackendEnvironment(),
    CONVEX_SELF_HOSTED_URL: localBackendUrl,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
  assertProofChildEnvironment(environment, { paths: proofPaths, requireSelfHosted: true });
  return environment;
}

function executableAllowlist() {
  const nodePath = path.resolve(process.execPath);
  assertAllowedExecutable(nodePath, [nodePath, backendBinaryPath]);
  assertAllowedExecutable(backendBinaryPath, [nodePath, backendBinaryPath]);
  if (!path.isAbsolute(convexCliPath) || !path.isAbsolute(typescriptCliPath)) throw new Error("local CLI and TypeScript paths must be absolute");
  return { nodePath, backendPath: backendBinaryPath };
}

function rememberProcess(child) {
  ownedProcesses.add(child);
  child.once("exit", () => ownedProcesses.delete(child));
  child.once("close", () => ownedProcesses.delete(child));
  return child;
}

function runOwnedCommand(filePath, args, environment, maxBuffer = 8 * 1024 * 1024, cwd = proofRoot, options = {}) {
  const paths = executableAllowlist();
  if (!path.isAbsolute(cwd) || (cwd !== proofRoot && cwd !== proofProjectRoot)) {
    throw new Error("proof-owned executable cwd is outside the local proof boundary");
  }
  return runBoundedOwnedCommand({
    filePath,
    args,
    environment,
    cwd,
    maxBuffer,
    allowedPaths: [paths.nodePath, paths.backendPath],
    proofPaths,
    exactConvexCli: options.exactConvexCli,
    execFileImpl: execFile,
    stage: options.stage ?? "owned-command",
    timeoutMs: options.timeoutMs ?? DEFAULT_OWNED_COMMAND_TIMEOUT_MS,
    reporter: (message) => process.stderr.write(`${message}\n`),
    secrets: [adminKey, proofState?.authPrivateKey, proofState?.webhookSecret, proofState?.instanceSecret],
    onChild: rememberProcess,
  });
}

async function startBackend() {
  const paths = executableAllowlist();
  const environment = minimalBackendEnvironment();
  backendFailure = null;
  backendProcess = await startBoundedOwnedProcess({
    filePath: paths.backendPath,
    args: [
      "--port", String(PROOF_PORTS.backend),
      "--site-proxy-port", String(PROOF_PORTS.site),
      "--convex-origin", localBackendUrl,
      "--convex-site", localSiteUrl,
      "--instance-name", proofDeploymentName,
      "--instance-secret", proofState.instanceSecret,
      "--local-storage", proofPaths.storage,
      "--disable-beacon",
      path.join(proofPaths.sqlite, "convex_local_backend.sqlite3"),
    ],
    cwd: proofRoot,
    maxBuffer: 8 * 1024 * 1024,
    allowedPaths: [paths.nodePath, paths.backendPath],
    childEnvironment: environment,
    proofPaths,
    execFileImpl: execFile,
    stage: "backend-startup",
    timeoutMs: DEFAULT_OWNED_STARTUP_TIMEOUT_MS,
    reporter: (message) => process.stderr.write(`${message}\n`),
    secrets: [adminKey, proofState?.authPrivateKey, proofState?.webhookSecret, proofState?.instanceSecret],
    onChild: rememberProcess,
    onRuntimeFailure: (error) => { backendFailure = error; },
  });
  backendStarted = true;
}

async function waitForBackend() {
  markStage("local-backend-readiness", "start");
  try {
    await waitFor(async () => {
      if (backendFailure) throw backendFailure;
      if (backendProcess.exitCode !== null) throw new Error("proof-owned local backend exited before readiness");
      try {
        const response = await guardedFetch(`${localBackendUrl}/instance_name`, { method: "GET" }, { port: PROOF_PORTS.backend, name: "local instance-name URL" });
        if (!response.ok) return false;
        const instanceName = (await response.text()).trim();
        if (instanceName !== proofDeploymentName) throw new Error("local Convex instance name did not match the proof-owned deployment name");
        return true;
      } catch (error) {
        if (error instanceof LocalProofGuardError) throw error;
        if (isConnectionRefused(error)) return false;
        throw error;
      }
    }, 30_000, "local backend readiness");
  } finally {
    markStage("local-backend-readiness", "end");
  }
}

function managedRuntimeChanges() {
  return [
    ["MEETLESS_DEPLOYMENT_MODE", "hosted-development"],
    ["MEETLESS_MANAGED_ALLOWANCE_SECONDS", "60"],
    ["MEETLESS_MANAGED_ALLOWANCE_SOURCE", "hosted-development-test"],
    ["MEETLESS_MANAGED_PROVIDER_MODE", "fake"],
    ["MEETLESS_APPLE_VERIFIER_MODE", "fixture"],
    ["MEETLESS_AUTH_ISSUER", proofState.authIssuer],
    ["MEETLESS_AUTH_AUDIENCE", proofState.authAudience],
    ["MEETLESS_AUTH_KEY_ID", proofState.authKeyId],
    ["MEETLESS_AUTH_PRIVATE_KEY_PKCS8", proofState.authPrivateKey],
    ["MEETLESS_AUTH_PUBLIC_JWK", JSON.stringify(proofState.authPublicJwk)],
    ["MEETLESS_REVENUECAT_AUTH_MODE", "hmac"],
    ["MEETLESS_REVENUECAT_WEBHOOK_SIGNING_SECRET", proofState.webhookSecret],
    ["MEETLESS_REVENUECAT_ENVIRONMENT", "SANDBOX"],
  ];
}

async function configureLocalEnvironment() {
  const response = await guardedFetch(`${localBackendUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ changes: managedRuntimeChanges().map(([name, value]) => ({ name, value })) }),
  }, { port: PROOF_PORTS.backend, name: "local environment update URL" });
  if (!response.ok) throw new Error("local runtime environment update failed");
}

async function prepareCliEnvironment() {
  const envDirectory = proofPaths.envDir;
  await mkdir(envDirectory, { recursive: true });
  proofEnvPath = path.join(envDirectory, "convex-cli.env");
  await writeFile(proofEnvPath, `CONVEX_SELF_HOSTED_URL=${localBackendUrl}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
}

async function prepareProofProject() {
  proofProjectRoot = proofPaths.project;
  await mkdir(proofProjectRoot, { recursive: true });
  await cp(path.join(repositoryRoot, "convex"), path.join(proofProjectRoot, "convex"), { recursive: true, dereference: true, errorOnExist: true });
  await cp(path.join(repositoryRoot, "package.json"), path.join(proofProjectRoot, "package.json"), { dereference: true, errorOnExist: true });
  await mkdir(path.join(proofProjectRoot, "node_modules"), { recursive: true });
  await cp(path.join(repositoryRoot, "node_modules", "convex"), path.join(proofProjectRoot, "node_modules", "convex"), { recursive: true, dereference: true, errorOnExist: true });
  await cp(path.join(repositoryRoot, "node_modules", "jose"), path.join(proofProjectRoot, "node_modules", "jose"), { recursive: true, dereference: true, errorOnExist: true });
}

async function runLocalCodegen() {
  const paths = executableAllowlist();
  const args = [
    convexCliPath,
    "dev",
    "--once",
    "--typecheck", "enable",
    "--codegen", "enable",
    "--tail-logs", "disable",
    "--env-file", proofEnvPath,
  ];
  await runOwnedCommand(paths.nodePath, [
    ...args,
  ], minimalCliEnvironment(), 8 * 1024 * 1024, proofProjectRoot, {
    stage: "local-codegen",
    exactConvexCli: { nodePath: paths.nodePath, convexCliPath, envFilePath: proofEnvPath, envFileRoot: proofPaths.envDir },
  });
}

async function runLocalTypecheck() {
  const paths = executableAllowlist();
  await runOwnedCommand(paths.nodePath, [
    typescriptCliPath,
    "--project", path.join(proofProjectRoot, "convex", "tsconfig.json"),
    "--noEmit",
  ], minimalBackendEnvironment(), 8 * 1024 * 1024, proofProjectRoot, { stage: "local-typecheck" });
}

function clientFor(token = null) {
  const client = new ConvexHttpClient(localBackendUrl, {
    logger: false,
    fetch: (url, init) => guardedFetch(url, init, { port: PROOF_PORTS.backend, name: "Convex function URL" }),
  });
  if (token) client.setAuth(token);
  else if (adminKey) client.setAdminAuth(adminKey);
  return client;
}

async function invoke(kind, name, args, token = null) {
  const client = clientFor(token);
  const reference = makeFunctionReference(name);
  if (kind === "query") return client.query(reference, args);
  if (kind === "mutation") return client.mutation(reference, args);
  if (kind === "action") return client.action(reference, args);
  throw new Error("unknown Convex invocation kind");
}

async function expectReject(operation, text) {
  try { await operation(); } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes(text.toLowerCase())) throw new Error("proof rejection did not match the expected policy");
    return message;
  }
  throw new Error("proof expected a rejection");
}

async function enroll(key, apple = fixtureApple()) {
  const challenge = await invoke("mutation", "managedAuth:createDeviceChallenge", {
    purpose: "enrollment", deviceId: key.deviceId, keyId: key.keyId, publicKey: key.publicKey,
  }, null);
  const token = await invoke("action", "managedAuthActions:enrollDevice", {
    challengeId: challenge.challengeId,
    deviceId: key.deviceId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: signChallenge(key, challenge.signingPayload),
    apple,
  }, null);
  return { token, challenge };
}

async function refresh(key) {
  const challenge = await invoke("mutation", "managedAuth:createDeviceChallenge", {
    purpose: "refresh", deviceId: key.deviceId, keyId: key.keyId, publicKey: key.publicKey,
  }, null);
  return invoke("action", "managedAuthActions:refreshDevice", {
    challengeId: challenge.challengeId,
    deviceId: key.deviceId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: signChallenge(key, challenge.signingPayload),
  }, null);
}

async function postPart(token, sessionId, bytes) {
  const uploadUrl = await invoke("mutation", "managedTranscription:generateUploadUrl", { sessionId }, token);
  const response = await guardedFetch(uploadUrl, { method: "POST", body: bytes }, { port: PROOF_PORTS.backend, name: "Convex storage upload URL" });
  if (!response.ok) throw new Error("generated local upload URL rejected the part");
  const body = await response.json();
  if (typeof body?.storageId !== "string") throw new Error("generated local upload did not return a storage ID");
  return body.storageId;
}

async function uploadAndRegister(token, value) {
  const session = await invoke("mutation", "managedTranscription:beginUpload", { manifest: value.manifest }, token);
  for (const [index, bytes] of value.bytes.entries()) {
    const part = value.manifest.parts[index];
    const storageId = await postPart(token, session.sessionId, bytes);
    await invoke("mutation", "managedTranscription:registerPart", {
      sessionId: session.sessionId,
      partNumber: part.partNumber,
      sampleOffset: part.sampleOffset,
      sampleCount: part.sampleCount,
      byteLength: part.byteLength,
      sha256: part.sha256,
      storageId,
    }, token);
  }
  return { session, storageIds: value.bytes.length };
}

async function postWebhook(eventId, eventType, eventTimestampMs = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    api_version: "1.0",
    event: {
      id: eventId,
      app_id: "appe0ef526253",
      product_id: "com.meetless.app.premium.monthly",
      environment: "SANDBOX",
      original_transaction_id: proofState.originalTransactionId,
      type: eventType,
      event_timestamp_ms: eventTimestampMs,
    },
  }));
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", proofState.webhookSecret).update(`${timestamp}.`).update(body).digest("hex");
  const response = await guardedFetch(`${localSiteUrl}/webhooks/revenuecat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-revenuecat-webhook-signature": `t=${timestamp},v1=${signature}` },
    body,
  }, { port: PROOF_PORTS.site, name: "local RevenueCat webhook URL" });
  if (!response.ok) throw new Error("local RevenueCat webhook was rejected");
  const payload = await response.json();
  await waitFor(async () => (await invoke("query", "managedAuth:readRevenueCatEvent", { eventId })).processedAt !== null, 30_000, "RevenueCat event processing");
  return payload;
}

async function main() {
  assertDiagnosticOptIn();
  assertProofInputEnvironment(process.env);
  markStage("proof", "start");
  initializeProofState();
  proofState.instanceSecret = randomBytes(32).toString("hex");
  proofRoot = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-managed-convex-r4-")));
  proofPaths = {
    root: proofRoot,
    home: path.join(proofRoot, "home"),
    xdgConfigHome: path.join(proofRoot, "xdg-config"),
    xdgCacheHome: path.join(proofRoot, "xdg-cache"),
    xdgDataHome: path.join(proofRoot, "xdg-data"),
    xdgStateHome: path.join(proofRoot, "xdg-state"),
    tmpDir: path.join(proofRoot, "tmp"),
    convexTmpDir: path.join(proofRoot, "convex-tmp"),
    storage: path.join(proofRoot, "storage"),
    sqlite: path.join(proofRoot, "sqlite"),
    project: path.join(proofRoot, "project"),
    envDir: path.join(proofRoot, "env"),
  };
  const userHome = homedir();
  const containment = await assertProofPathContainment({
    root: proofRoot,
    paths: proofPaths,
    forbiddenRoots: [
      userHome,
      path.join(userHome, ".config"),
      path.join(userHome, ".cache"),
      repositoryRoot,
      path.join(repositoryRoot, ".convex"),
      path.join(repositoryRoot, ".env.local"),
    ],
  });
  if (containment.root !== proofRoot || Object.values(containment.paths).some((value) => !value.startsWith(`${proofRoot}${path.sep}`))) {
    throw new Error("proof paths were not canonical descendants of the temporary root");
  }
  proofCanonicalRoot = containment.root;
  await Promise.all(Object.values(proofPaths).filter((value) => value !== proofRoot).map((directory) => mkdir(directory, { recursive: true })));
  await prepareProofProject();
  backendBinaryPath = await resolveInstalledBackend();
  const paths = executableAllowlist();
  await assertPortFree(localBackendUrl, PROOF_PORTS.backend);
  await assertPortFree(localSiteUrl, PROOF_PORTS.site);

  const keygenOutput = await runOwnedCommand(paths.backendPath, [
    "keygen", "admin-key",
    "--instance-name", proofDeploymentName,
    "--instance-secret", proofState.instanceSecret,
  ], minimalBackendEnvironment(), 8 * 1024 * 1024, proofRoot, { stage: "backend-keygen" });
  adminKey = String(keygenOutput).trim();
  if (!adminKey) throw new Error("proof-owned local admin material was not generated");

  await startBackend();
  await waitForBackend();
  await configureLocalEnvironment();
  await prepareCliEnvironment();
  await runLocalCodegen();
  await runLocalTypecheck();

  const primary = deviceKey("primary");
  const sibling = deviceKey("sibling");
  const third = deviceKey("third");
  const expired = deviceKey("expired");
  const overflow = deviceKey("overflow");
  const apple = fixtureApple();
  const primaryEnrollment = await enroll(primary, apple);
  const primaryClaims = decodeJwt(primaryEnrollment.token.authToken);
  const primaryHeader = decodeProtectedHeader(primaryEnrollment.token.authToken);
  if (primaryClaims.iss !== proofState.authIssuer || primaryClaims.aud !== proofState.authAudience || primaryClaims.sub !== `managed-device:${primary.deviceId}` || typeof primaryClaims.exp !== "number" || primaryClaims.exp <= Math.floor(Date.now() / 1_000) || primaryHeader.alg !== "ES256" || primaryHeader.kid !== proofState.authKeyId) throw new Error("device JWT did not carry exact local claims");
  const jwksResponse = await guardedFetch(`${localSiteUrl}/managed-auth/jwks.json`, {}, { port: PROOF_PORTS.site, name: "local JWKS URL" });
  const jwks = await jwksResponse.json();
  if (!jwksResponse.ok || jwks.keys?.length !== 1 || jwks.keys[0].kid !== proofState.authKeyId || Object.hasOwn(jwks.keys[0], "d")) throw new Error("local JWKS exposed an invalid key projection");

  await expectReject(() => invoke("action", "managedAuthActions:enrollDevice", {
    challengeId: primaryEnrollment.challenge.challengeId, deviceId: primary.deviceId, keyId: primary.keyId, publicKey: primary.publicKey,
    signature: signChallenge(primary, primaryEnrollment.challenge.signingPayload), apple,
  }, null), "already consumed");
  const siblingEnrollment = await enroll(sibling, apple);
  const thirdEnrollment = await enroll(third, apple);
  const expiredChallenge = await invoke("mutation", "managedAuth:createDeviceChallenge", {
    purpose: "enrollment", deviceId: expired.deviceId, keyId: expired.keyId, publicKey: expired.publicKey,
  }, null);
  await invoke("mutation", "managedAuth:expireLocalChallenge", { challengeId: expiredChallenge.challengeId });
  await expectReject(() => invoke("action", "managedAuthActions:enrollDevice", {
    challengeId: expiredChallenge.challengeId, deviceId: expired.deviceId, keyId: expired.keyId, publicKey: expired.publicKey,
    signature: signChallenge(expired, expiredChallenge.signingPayload), apple,
  }, null), "expired");
  await expectReject(() => enroll(overflow, apple), "three active-device");
  await refresh(primary);

  const cancellation = timelineManifest(`recording-cancellation-${runId}`, [sampleRate], 3);
  const cancellationUpload = await uploadAndRegister(primaryEnrollment.token.authToken, cancellation);
  const cancellationJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: cancellationUpload.session.sessionId }, primaryEnrollment.token.authToken);
  await postWebhook(`event-cancellation-${runId}`, "CANCELLATION", Date.now() + 10_000);
  const afterCancellation = await invoke("mutation", "managedTranscription:beginUpload", { manifest: timelineManifest(`recording-after-cancellation-${runId}`).manifest }, primaryEnrollment.token.authToken);
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: afterCancellation.sessionId }, primaryEnrollment.token.authToken);
  if (cancellationJob.status !== "reserved") throw new Error("cancellation changed entitlement unexpectedly");

  const multi = timelineManifest(`recording-multi-part-${runId}`, [sampleRate, sampleRate * 2], 7);
  const multiUpload = await uploadAndRegister(primaryEnrollment.token.authToken, multi);
  const [firstJob, secondJob] = await Promise.all([
    invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: multiUpload.session.sessionId }, primaryEnrollment.token.authToken),
    invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: multiUpload.session.sessionId }, primaryEnrollment.token.authToken),
  ]);
  if (firstJob._id !== secondJob._id || firstJob.durationMs !== 3_000 || firstJob.status !== "reserved") throw new Error("ordered physical parts did not converge on one logical job");
  const providerResults = await Promise.all([
    invoke("action", "managedTranscriptionActions:runProvider", { jobId: firstJob._id }, primaryEnrollment.token.authToken),
    invoke("action", "managedTranscriptionActions:runProvider", { jobId: firstJob._id }, primaryEnrollment.token.authToken),
  ]);
  const settled = await invoke("query", "managedTranscription:jobStatus", { jobId: firstJob._id }, primaryEnrollment.token.authToken);
  if (settled.status !== "succeeded" || settled.providerInvocationCount !== 1 || settled.providerResult?.ranges?.length !== 1 || settled.providerResult.ranges[0].endMs !== 3_000 || !providerResults.some((result) => result.status === "succeeded")) throw new Error("fake provider did not preserve exclusive execution");
  await invoke("action", "managedTranscriptionActions:acknowledge", { jobId: firstJob._id }, siblingEnrollment.token.authToken);
  await restartBackend();
  const afterRestart = await invoke("query", "managedTranscription:jobStatus", { jobId: firstJob._id }, primaryEnrollment.token.authToken);
  if (afterRestart.status !== "succeeded" || afterRestart.providerInvocationCount !== 1) throw new Error("local Convex restart lost or duplicated the settled job");

  const natural = timelineManifest(`recording-natural-expiry-${runId}`);
  const naturalUpload = await uploadAndRegister(primaryEnrollment.token.authToken, natural);
  const naturalJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: naturalUpload.session.sessionId }, primaryEnrollment.token.authToken);
  await invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId: proofState.accountId, naturalExpiryAt: Date.now() - 1 });
  await invoke("action", "managedTranscriptionActions:runProvider", { jobId: naturalJob._id }, primaryEnrollment.token.authToken);
  const naturalDone = await invoke("query", "managedTranscription:jobStatus", { jobId: naturalJob._id }, siblingEnrollment.token.authToken);
  if (naturalDone.status !== "succeeded") throw new Error("natural-expiry admitted work did not recover");
  await expectReject(() => invoke("mutation", "managedTranscription:beginUpload", { manifest: timelineManifest(`recording-natural-new-${runId}`).manifest }, primaryEnrollment.token.authToken), "naturally expired");
  await invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId: proofState.accountId, naturalExpiryAt: null });

  await invoke("mutation", "managedAuth:setFixtureAppleState", { lineageKey: proofState.lineageKey, currentState: "refunded", expiresAt: Date.now() + periodDay });
  const inFlight = timelineManifest(`recording-refund-flight-${runId}`);
  const inFlightUpload = await uploadAndRegister(siblingEnrollment.token.authToken, inFlight);
  const inFlightJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: inFlightUpload.session.sessionId }, siblingEnrollment.token.authToken);
  await postWebhook(`event-refund-${runId}`, "REFUND");
  const stopped = await invoke("query", "managedTranscription:jobStatus", { jobId: inFlightJob._id }, thirdEnrollment.token.authToken);
  if (stopped.status !== "stopped") throw new Error("refund reconciliation did not stop active managed work");
  await expectReject(() => invoke("mutation", "managedTranscription:beginUpload", { manifest: timelineManifest(`recording-refund-new-${runId}`).manifest }, thirdEnrollment.token.authToken), "refunded");

  await invoke("mutation", "managedAuth:setFixtureAppleState", { lineageKey: proofState.lineageKey, currentState: "active", expiresAt: Date.now() + periodDay });
  await postWebhook(`event-renewal-${runId}`, "RENEWAL", Date.now() - 30_000);
  await invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId: proofState.accountId, naturalExpiryAt: null });
  const revokeJobInput = timelineManifest(`recording-revoke-flight-${runId}`);
  const revokeUpload = await uploadAndRegister(siblingEnrollment.token.authToken, revokeJobInput);
  const revokeJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: revokeUpload.session.sessionId }, siblingEnrollment.token.authToken);
  await invoke("mutation", "managedTranscription:revokeDevice", { accountId: proofState.accountId, deviceId: third.deviceId });
  await expectReject(() => refresh(third), "refresh challenge");
  const revokeStatus = await invoke("query", "managedTranscription:jobStatus", { jobId: revokeJob._id }, primaryEnrollment.token.authToken);
  if (revokeStatus.status !== "reserved") throw new Error("revoking an unrelated device stopped another device's admitted job");

  const lease = timelineManifest(`recording-lease-${runId}`);
  const leaseUpload = await uploadAndRegister(primaryEnrollment.token.authToken, lease);
  const leaseJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: leaseUpload.session.sessionId }, primaryEnrollment.token.authToken);
  await invoke("action", "managedTranscriptionActions:reconcileManagedState", { accountId: proofState.accountId, now: leaseJob.leaseExpiresAt + 1, limit: 50 });
  const expiredLease = await invoke("query", "managedTranscription:jobStatus", { jobId: leaseJob._id }, primaryEnrollment.token.authToken);
  if (expiredLease.status !== "expired") throw new Error("lease reconciliation did not release the reserved job");
  const refreshedAdmission = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: leaseUpload.sessionId }, primaryEnrollment.token.authToken);
  if (refreshedAdmission.admissionNumber !== 2) throw new Error("expired logical job did not receive a fresh admission");
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: leaseUpload.sessionId }, primaryEnrollment.token.authToken);

  await invoke("mutation", "managedTranscription:setLocalCanaryNextPeriodAllowance", { accountId: proofState.accountId, limitSeconds: 2, allowanceSource: "hosted-development-test" });
  await invoke("mutation", "managedTranscription:prepareNextCanaryPeriod", { accountId: proofState.accountId, durationMs: periodDay });
  const rollover = await invoke("query", "managedTranscription:readLocalCanaryQuota", { accountId: proofState.accountId });
  if (rollover.limitSeconds !== 2 || rollover.nextPeriodLimitSeconds !== 2 || rollover.allowanceSource !== "hosted-development-test") throw new Error("period allowance was not snapshotted from explicit labeled configuration");

  const ttl = timelineManifest(`recording-ttl-${runId}`);
  const ttlUpload = await uploadAndRegister(primaryEnrollment.token.authToken, ttl);
  const ttlJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: ttlUpload.session.sessionId }, primaryEnrollment.token.authToken);
  await invoke("action", "managedTranscriptionActions:reconcileManagedState", { accountId: proofState.accountId, now: ttlJob.expiresAt + 1, limit: 50 });
  const expiredTtl = await invoke("query", "managedTranscription:jobStatus", { jobId: ttlJob._id }, primaryEnrollment.token.authToken);
  if (expiredTtl.status !== "expired" || expiredTtl.providerResult !== null) throw new Error("24-hour TTL cleanup did not remove uncompleted provider data");

  return {
    frontier: "CONVEX-HOSTED-DEV-AUTH-WEBHOOK-R4",
    result: "passed",
    jwtAndJwks: true,
    challengeReplayExpiryAndRevocation: true,
    fakeAppleLineage: true,
    webhookAuthenticationReplayAndOrder: true,
    labeledAllowance: true,
    orderedPhysicalParts: multi.manifest.parts.length,
    logicalDurationSeconds: multi.manifest.durationMs / 1_000,
    providerInvocations: settled.providerInvocationCount,
    restartRecovered: true,
    cleanup: "pending-finally",
    noExternalCalls: true,
  };
}

async function restartBackend() {
  if (!backendProcess) throw new Error("proof-owned backend is missing for restart proof");
  const previous = backendProcess;
  await terminateOwnedProcess(previous, {
    termTimeoutMs: DEFAULT_OWNED_TERM_TIMEOUT_MS,
    killTimeoutMs: DEFAULT_OWNED_KILL_TIMEOUT_MS,
  });
  ownedProcesses.delete(previous);
  backendProcess = null;
  await startBackend();
  await waitForBackend();
}

async function cleanup() {
  const errors = [];
  const children = [...ownedProcesses];
  const optionalCleanup = adminKey && backendStarted && proofState
    ? () => invoke("mutation", "managedTranscription:clearLocalCanary", { accountId: proofState.accountId })
    : undefined;
  errors.push(...await cleanupOwnedProcesses({
    children,
    optionalCleanup,
    terminate: (child) => terminateOwnedProcess(child, {
      termTimeoutMs: DEFAULT_OWNED_TERM_TIMEOUT_MS,
      killTimeoutMs: DEFAULT_OWNED_KILL_TIMEOUT_MS,
    }),
    cleanupTimeoutMs: 2_000,
  }));
  ownedProcesses.clear();
  backendProcess = null;
  if (backendStarted) {
    await assertPortClosed(localBackendUrl, PROOF_PORTS.backend).catch(() => errors.push("backend port did not close"));
    await assertPortClosed(localSiteUrl, PROOF_PORTS.site).catch(() => errors.push("site port did not close"));
  }
  if (adminKey && backendStarted && proofState) {
    await withDeadline(
      () => invoke("mutation", "managedTranscription:clearLocalCanary", { accountId: proofState.accountId }),
      { timeoutMs: 2_000, label: "optional local canary cleanup" },
    ).catch(() => undefined);
  }
  if (proofRoot) {
    await rm(proofRoot, { recursive: true, force: true }).catch(() => errors.push("proof workspace removal failed"));
    if (await fileExists(proofRoot).catch(() => true)) errors.push("proof workspace remains");
  }
  proofRoot = null;
  proofProjectRoot = null;
  proofPaths = null;
  proofCanonicalRoot = null;
  proofEnvPath = null;
  adminKey = null;
  proofState = null;
  backendStarted = false;
  return errors;
}

let proofResult = null;
let proofFailed = false;
let proofError = null;
try {
  proofResult = await withDeadline(main, { timeoutMs: globalProofDeadlineMs, label: "managed Convex diagnostic proof" });
} catch (error) {
  proofFailed = true;
  proofError = error;
} finally {
  markStage("proof", "end");
  const cleanupErrors = await cleanup();
  if (proofFailed || cleanupErrors.length > 0) {
    console.error(JSON.stringify({
      frontier: "CONVEX-HOSTED-DEV-AUTH-WEBHOOK-R4",
      result: "failed",
      localOnly: true,
      stage: proofError?.stage ?? activeStage,
      error: redactDiagnostic(proofError?.message ?? "diagnostic proof failed", [adminKey, proofState?.authPrivateKey, proofState?.webhookSecret, proofState?.instanceSecret]),
      cleanup: cleanupErrors.length === 0 ? "completed" : "failed",
    }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ...proofResult, cleanup: "completed", noExternalCalls: true }));
  }
}
