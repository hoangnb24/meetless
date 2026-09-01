import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { MeetingStore } from "@meetless/meeting-store";
import {
  ConvexManagedTranscriptionService,
  ManagedTimelineArtifactStore,
} from "../packages/meetless-plugin/dist/src/managed-transcription.js";
import { ConvexManagedCredentialSource } from "../packages/meetless-plugin/dist/src/managed-auth.js";
import {
  ConvexHttpManagedFunctionClient,
  ConvexManagedUploadPort,
  FileManagedConvexUploadJournal,
  buildManagedLogicalTimelineManifest,
} from "../packages/meetless-plugin/dist/src/managed-upload.js";
import { MeetingLifecycleCoordinator } from "../packages/meetless-plugin/dist/src/meeting-lifecycle-coordinator.js";
import {
  HOSTED_DEV_TARGET,
  assertHostedCliArguments,
  assertHostedDevTarget,
  assertHostedUrl,
  formatHostedDiagnostic,
  parseHostedEnvironmentNames,
  parseHostedFunctionSpec,
  validateHostedEnvironmentNames,
} from "./prove-managed-convex-hosted-dev-target.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_NODE_EXECUTABLE = "/Users/tubakhuym/.hermes/node/bin/node";
const NODE_EXECUTABLE = process.execPath;
const CONVEX_CLI_PATH = path.join(REPO_ROOT, "node_modules/convex/bin/main.js");
const PHASE1_SCRIPT_PATH = path.join(REPO_ROOT, "scripts/prove-managed-convex-phase1.mjs");
const JWKS_PATH = "/managed-auth/jwks.json";
const WEBHOOK_PATH = "/webhooks/revenuecat";
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const PHASE1_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 20_000;
const STDERR_RING_BYTES = 8 * 1024;
const FIXTURE_SAMPLE_COUNT = 9_600_000 + 16_000;
const LOCAL_OUTPUT_SAMPLE_COUNT = 24_000;
const FORBIDDEN_INHERITED_ENVIRONMENT = Object.freeze([
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
  "CONVEX_PROVISION_HOST",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_URL",
  "CONVEX_SITE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SENTRY_DSN",
]);

export async function runHostedDevelopmentProof() {
  assertHostedDevTarget();
  assertExecutableInputs();
  assertSafeParentEnvironment();
  const targetFetch = createTargetFetch();
  const root = await mkdtemp(path.join(os.tmpdir(), "meetless-hosted-dev-"));
  await chmod(root, 0o700);
  let environmentSet = false;
  let canaryAccountCreated = false;
  let canaryCleaned = false;
  const mutationJournal = [];
  const secretValues = [];
  try {
    const initialNames = await readHostedEnvironmentNames();
    const runId = randomUUID();
    const material = await makeCanaryMaterial(runId);
    const namesToSet = Object.keys(material.runtimeEnvironment).sort();
    if (initialNames.length !== 0 && !sameStringArray(initialNames, namesToSet)) {
      throw new Error("target deployment environment is neither empty nor the exact approved allowlist; no hosted mutation was attempted");
    }
    secretValues.push(material.privateKeyPkcs8, material.webhookAuthorization);
    const runtimeEnvPath = path.join(root, "managed-runtime.env");
    const selectionEnvPath = path.join(root, "convex-selection.env");
    await writeEnvFile(runtimeEnvPath, material.runtimeEnvironment);
    await writeFile(selectionEnvPath, `CONVEX_DEPLOYMENT=dev:${HOSTED_DEV_TARGET.deployment}\n`, { mode: 0o600 });

    await runPhase1();

    for (const name of namesToSet) mutationJournal.push({ name, status: "pending" });
    try {
      await runConvexCommand(
        "env-set",
        ["env", "set", "--deployment", HOSTED_DEV_TARGET.deployment, "--from-file", runtimeEnvPath, ...(initialNames.length === 0 ? [] : ["--force"])],
        baseCliEnvironment(),
        { envFilePath: runtimeEnvPath, secretValues },
      );
      environmentSet = true;
      for (const entry of mutationJournal) entry.status = "success";
    } catch (error) {
      for (const entry of mutationJournal) entry.status = "unknown";
      throw error;
    }

    const afterSetNames = await readHostedEnvironmentNames(namesToSet);

    await runConvexCommand(
      "dev",
      ["dev", "--once", "--typecheck", "enable", "--codegen", "enable", "--tail-logs", "disable", "--env-file", selectionEnvPath],
      { ...baseCliEnvironment(), ...material.runtimeEnvironment },
      { envFilePath: selectionEnvPath, secretValues },
    );

    const functionSpec = await readHostedFunctionSpec();
    const jwks = await readJwks(targetFetch, material.publicJwk);
    const local = await createLocalMeetingFixture(root, runId);
    const manifest = await buildManagedLogicalTimelineManifest({
      recordingId: local.recordingId,
      manifestSha256: local.manifestSha256,
      sourcePath: local.timelinePath,
    });
    if (manifest.parts.length !== 2 || manifest.parts.some((part) => part.sampleCount > 9_600_000)) {
      throw new Error("hosted canary manifest did not produce ordered physical parts within the ten-minute bound");
    }

    const client = new ConvexHttpManagedFunctionClient(HOSTED_DEV_TARGET.cloudUrl, { fetch: targetFetch });
    const signer = await makeEphemeralDeviceSigner(runId);
    const credentialSource = new ConvexManagedCredentialSource(client, signer);
    const credential = await credentialSource.enroll(material.apple);
    canaryAccountCreated = true;
    secretValues.push(credential.authToken);
    assertJwtBoundary(credential.authToken, material, signer.identityValue);

    const preWebhookStatus = await client.query("managedAuth:revenueCatEventStatus", { eventId: `${runId}-revenuecat` });
    if (preWebhookStatus !== null) throw new Error("authenticated current-device status unexpectedly exposed an unknown webhook event");

    const webhookEventId = `${runId}-revenuecat`;
    const webhookBody = Buffer.from(JSON.stringify({
      api_version: "1.0",
      event: {
        id: webhookEventId,
        app_id: "appe0ef526253",
        product_id: "com.meetless.app.premium.monthly",
        environment: "SANDBOX",
        original_transaction_id: material.apple.originalTransactionId,
        type: "CANCELLATION",
        event_timestamp_ms: Date.now(),
      },
    }));
    const rejected = await targetFetch(`${HOSTED_DEV_TARGET.siteUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: webhookBody,
    });
    if (rejected.status !== 401) throw new Error("unauthenticated RevenueCat webhook was not rejected");
    const accepted = await targetFetch(`${HOSTED_DEV_TARGET.siteUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: material.webhookAuthorization },
      body: webhookBody,
    });
    const acceptedBody = await readJson(accepted);
    if (accepted.status !== 200 || acceptedBody?.accepted !== true || acceptedBody?.outcome !== "received") {
      throw new Error("authenticated RevenueCat webhook was not durably received");
    }
    const duplicate = await targetFetch(`${HOSTED_DEV_TARGET.siteUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: material.webhookAuthorization },
      body: webhookBody,
    });
    const duplicateBody = await readJson(duplicate);
    if (duplicate.status !== 200 || duplicateBody?.accepted !== true || duplicateBody?.outcome !== "duplicate") {
      throw new Error("duplicate RevenueCat webhook was not idempotently acknowledged");
    }
    await waitForEventProcessed(client, webhookEventId);

    const firstClient = new ConvexHttpManagedFunctionClient(HOSTED_DEV_TARGET.cloudUrl, { fetch: targetFetch });
    const firstPort = new ConvexManagedUploadPort(firstClient, {
      journal: new FileManagedConvexUploadJournal(path.join(root, "upload-journal-before-restart")),
      fetch: targetFetch,
    });
    const firstSession = await firstPort.begin({ credential, manifest });
    if (firstSession.receivedPartNumbers.length !== 0 || firstSession.state !== "uploading") {
      throw new Error("hosted canary upload did not begin in the empty uploading state");
    }
    await uploadAndRegisterFirstPart(firstClient, targetFetch, credential, firstSession.sessionId, manifest.parts[0], local.timelinePath);

    const resumedClient = new ConvexHttpManagedFunctionClient(HOSTED_DEV_TARGET.cloudUrl, { fetch: targetFetch });
    const resumedPort = new ConvexManagedUploadPort(resumedClient, {
      journal: new FileManagedConvexUploadJournal(path.join(root, "upload-journal-after-restart")),
      fetch: targetFetch,
    });
    const service = new ConvexManagedTranscriptionService(local.store, {
      lifecycle: new MeetingLifecycleCoordinator(),
      timelineArtifacts: local.artifacts,
      managedUpload: resumedPort,
    });
    const result = await service.transcribe({ recordingId: local.recordingId, credential });
    await assertPublishedMeetingStoreResult(result, local);
    const postAckSession = await resumedPort.status({ credential, sessionId: firstSession.sessionId });
    if (postAckSession.state !== "cleaned" || postAckSession.receivedPartNumbers.length !== 0) {
      throw new Error("hosted canary acknowledgement did not clean the temporary upload state");
    }
    if (await resumedPort.acknowledge({ credential, jobId: result.job._id }) !== true) {
      throw new Error("hosted canary acknowledgement was not idempotent");
    }

    const cleanup = await client.mutation("managedAuth:cleanupFixtureAccount", { lineageKey: material.lineageKey });
    assertCleanupResult(cleanup);
    canaryCleaned = true;
    console.log(JSON.stringify({
      result: "passed",
      deployment: HOSTED_DEV_TARGET.deployment,
      reference: HOSTED_DEV_TARGET.reference,
      cloudUrl: HOSTED_DEV_TARGET.cloudUrl,
      siteUrl: HOSTED_DEV_TARGET.siteUrl,
      functionSpec,
      jwks: jwks,
      environment: mutationJournal,
      canary: {
        physicalParts: manifest.parts.length,
        largestPartSamples: Math.max(...manifest.parts.map((part) => part.sampleCount)),
        logicalDurationMs: manifest.durationMs,
        meetingStorePublished: true,
        restartRecovered: true,
        webhookProcessed: true,
        cleanup,
      },
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
    if (environmentSet && !canaryCleaned) {
      console.error(JSON.stringify({
        result: "attention_required",
        deployment: HOSTED_DEV_TARGET.deployment,
        environment: mutationJournal,
        canaryResidue: canaryAccountCreated ? "cleanup failed or was not reached" : "not established",
        cloudCleanup: "not attempted",
      }));
    }
  }
}

export function assertHostedCanaryInvocation(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--run") {
    throw new Error("hosted canary is opt-in; invoke it with exactly --run");
  }
}

async function main() {
  assertHostedCanaryInvocation();
  await runHostedDevelopmentProof();
}

function assertExecutableInputs() {
  if (NODE_EXECUTABLE !== EXPECTED_NODE_EXECUTABLE) throw new Error("hosted canary requires the exact installed absolute Node executable");
  if (!path.isAbsolute(CONVEX_CLI_PATH) || !CONVEX_CLI_PATH.endsWith("/node_modules/convex/bin/main.js")) throw new Error("hosted canary Convex CLI path is not the exact installed script");
}

function assertSafeParentEnvironment() {
  for (const name of FORBIDDEN_INHERITED_ENVIRONMENT) {
    if (Object.hasOwn(process.env, name)) throw new Error(`hosted canary refuses inherited control or network environment ${name}`);
  }
}

function baseCliEnvironment() {
  const home = process.env.HOME || os.homedir();
  if (!path.isAbsolute(home)) throw new Error("hosted canary requires an absolute authenticated CLI home");
  return {
    CI: "1",
    DISABLE_BEACON: "1",
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

async function runPhase1() {
  await runOwnedNode("phase1", PHASE1_SCRIPT_PATH, [], { CI: "1", DISABLE_BEACON: "1" }, PHASE1_TIMEOUT_MS);
}

async function readHostedEnvironmentNames(expectedNames = null) {
  const output = await runConvexCommand(
    "env-list",
    ["env", "list", "--deployment", HOSTED_DEV_TARGET.deployment, "--names-only"],
    baseCliEnvironment(),
    {},
  );
  return expectedNames === null
    ? parseHostedEnvironmentNames(output.stdout)
    : validateHostedEnvironmentNames(output.stdout, expectedNames);
}

async function readHostedFunctionSpec() {
  const output = await runConvexCommand(
    "function-spec",
    ["function-spec", "--deployment", HOSTED_DEV_TARGET.deployment],
    baseCliEnvironment(),
    {},
  );
  return parseHostedFunctionSpec(output.stdout);
}

async function runConvexCommand(kind, args, environment, { envFilePath = null, secretValues = [] } = {}) {
  assertHostedCliArguments(kind, args, envFilePath);
  if (args.includes("--prod") || args.includes("--deployment prod") || args.includes("--cloud") || args.includes("--local")) {
    throw new Error("hosted canary CLI arguments contain a forbidden production or alternate target");
  }
  return runOwnedNode(kind, CONVEX_CLI_PATH, args, environment, COMMAND_TIMEOUT_MS, { secretValues });
}

function runOwnedNode(stage, scriptPath, args, environment, timeoutMs, { secretValues = [] } = {}) {
  if (!path.isAbsolute(scriptPath) || scriptPath.includes("..")) return Promise.reject(new Error(`${stage} script path is not an exact absolute path`));
  if (!environment || environment.CI !== "1" || environment.DISABLE_BEACON !== "1") return Promise.reject(new Error(`${stage} child environment must require CI=1 and DISABLE_BEACON=1`));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(`${stage} child deadline is invalid`));
  stageLog(stage, "start");
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let timer = null;
    let ring = "";
    const finish = (error, stdout = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stageLog(stage, "end");
      if (error) {
        const diagnostic = formatHostedDiagnostic(`${safeProcessError(error)}\n${ring}`, secretValues, STDERR_RING_BYTES);
        const safe = new Error(`${stage} failed (${diagnostic.classification})`);
        safe.stage = stage;
        safe.diagnostic = diagnostic;
        reject(safe);
      } else {
        resolve({ stdout, stderr: formatHostedDiagnostic(ring, secretValues, STDERR_RING_BYTES).stderr });
      }
    };
    const append = (value) => {
      ring += typeof value === "string" ? value : String(value ?? "");
      const bytes = Buffer.from(ring, "utf8");
      if (bytes.byteLength > STDERR_RING_BYTES) ring = bytes.subarray(-STDERR_RING_BYTES).toString("utf8");
    };
    try {
      child = execFile(NODE_EXECUTABLE, [scriptPath, ...args], {
        cwd: REPO_ROOT,
        env: { ...environment },
        shell: false,
        detached: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        append(stderr);
        finish(error, stdout ?? "");
      });
      if (child.stderr?.on) child.stderr.on("data", append);
      child.once("error", (error) => finish(error));
      timer = setTimeout(async () => {
        if (settled) return;
        try {
          const termination = await terminateOwnedProcess(child);
          finish(termination.terminated ? new Error("deadline exceeded") : new Error("owned process did not terminate after deadline"));
        } catch (error) {
          finish(error);
        }
      }, timeoutMs);
      if (settled) clearTimeout(timer);
    } catch (error) {
      finish(error);
    }
  });
}

async function terminateOwnedProcess(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("owned hosted canary child PID is invalid");
  if (child.exitCode !== null || child.signalCode !== null) return { terminated: true, forced: false };
  signalOwnedProcess(child, "SIGTERM");
  if (await waitForChildExit(child, 5_000)) return { terminated: true, forced: false };
  signalOwnedProcess(child, "SIGKILL");
  return { terminated: await waitForChildExit(child, 2_000), forced: true };
}

function signalOwnedProcess(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "ERR_INVALID_HANDLE") throw error;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once("exit", () => finish(true));
    child.once("close", () => finish(true));
  });
}

function createTargetFetch() {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return async (rawUrl, init = {}) => {
    const parsed = new URL(rawUrl);
    const kind = parsed.origin === HOSTED_DEV_TARGET.cloudUrl ? "cloud" : parsed.origin === HOSTED_DEV_TARGET.siteUrl ? "site" : null;
    if (!kind) throw new Error("hosted canary request URL is outside the exact cloud/site target");
    assertHostedUrl(rawUrl, kind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("hosted canary request deadline exceeded")), FETCH_TIMEOUT_MS);
    try {
      const response = await nativeFetch(rawUrl, { ...init, redirect: "error", signal: controller.signal });
      if (!response || typeof response.url !== "string") throw new Error("hosted canary response URL is unavailable");
      const responseParsed = new URL(response.url);
      if (response.redirected || responseParsed.origin !== parsed.origin) throw new Error("hosted canary redirect or target change was observed");
      assertHostedUrl(response.url, kind);
      return response;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readJwks(targetFetch, expectedJwk) {
  const response = await targetFetch(`${HOSTED_DEV_TARGET.siteUrl}${JWKS_PATH}`);
  assertHostedUrl(response.url, "site", { path: JWKS_PATH, allowQuery: false });
  if (response.status !== 200) throw new Error("hosted JWKS route did not return success");
  const body = await readJson(response);
  if (!body || !Array.isArray(body.keys) || body.keys.length !== 1) throw new Error("hosted JWKS response shape is invalid");
  const key = body.keys[0];
  if (key.d !== undefined || key.kid !== expectedJwk.kid || key.alg !== "ES256" || key.use !== "sig" || key.crv !== "P-256") {
    throw new Error("hosted JWKS did not expose the configured public ES256 key only");
  }
  if (key.x !== expectedJwk.x || key.y !== expectedJwk.y) throw new Error("hosted JWKS public key does not match the generated dev issuer key");
  return { keyId: key.kid, publicOnly: true };
}

async function readJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new Error("hosted canary JSON response is invalid");
  }
}

async function makeCanaryMaterial(runId) {
  const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateDer = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const keyId = `hosted-dev-${runId}`;
  const checkedPublicJwk = { ...publicJwk, kid: keyId, alg: "ES256", use: "sig" };
  const webhookAuthorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  const originalTransactionId = `hosted-canary-${runId}`;
  const apple = {
    adapter: "fixture",
    bundleId: "com.meetless.app",
    environment: "SANDBOX",
    productId: "com.meetless.app.premium.monthly",
    originalTransactionId,
    periodType: "normal",
    startedAtMs: Date.now() - 60_000,
    expiresAtMs: Date.now() + 86_400_000,
    currentState: "active",
  };
  apple.fixtureProof = sha256Text(JSON.stringify({ version: 1, ...apple }));
  return {
    privateKeyPkcs8: pem("PRIVATE KEY", privateDer),
    publicJwk: checkedPublicJwk,
    webhookAuthorization,
    apple,
    lineageKey: `apple-lineage:${sha256Text(originalTransactionId)}`,
    runtimeEnvironment: {
      MEETLESS_DEPLOYMENT_MODE: "hosted-development",
      MEETLESS_MANAGED_ALLOWANCE_SECONDS: "18000",
      MEETLESS_MANAGED_ALLOWANCE_SOURCE: "hosted-development-test",
      MEETLESS_MANAGED_PROVIDER_MODE: "fake",
      MEETLESS_APPLE_VERIFIER_MODE: "fixture",
      MEETLESS_AUTH_ISSUER: `${HOSTED_DEV_TARGET.siteUrl}${JWKS_PATH}`,
      MEETLESS_AUTH_AUDIENCE: "meetless-managed-hosted-development",
      MEETLESS_AUTH_KEY_ID: keyId,
      MEETLESS_AUTH_PRIVATE_KEY_PKCS8: pem("PRIVATE KEY", privateDer),
      MEETLESS_AUTH_PUBLIC_JWK: JSON.stringify(checkedPublicJwk),
      MEETLESS_REVENUECAT_AUTH_MODE: "authorization",
      MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER: webhookAuthorization,
      MEETLESS_REVENUECAT_ENVIRONMENT: "SANDBOX",
    },
    keyPair,
    publicKey: encodeBase64Url(rawPublicKey),
  };
}

async function makeEphemeralDeviceSigner(runId) {
  const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const identityValue = {
    deviceId: `hosted-canary-device-${runId}`,
    keyId: `hosted-canary-key-${runId}`,
    publicKey: encodeBase64Url(raw),
  };
  return {
    identityValue,
    identity: async () => identityValue,
    signChallenge: async (payload) => ({
      ...identityValue,
      signature: encodeBase64Url(new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, payload))),
    }),
  };
}

function assertJwtBoundary(token, material, identity) {
  const header = decodeProtectedHeader(token);
  const claims = decodeJwt(token);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (header.alg !== "ES256" || header.kid !== material.runtimeEnvironment.MEETLESS_AUTH_KEY_ID || claims.iss !== material.runtimeEnvironment.MEETLESS_AUTH_ISSUER || !audience.includes(material.runtimeEnvironment.MEETLESS_AUTH_AUDIENCE) || claims.sub !== `managed-device:${identity.deviceId}` || claims.deviceId !== identity.deviceId || claims.keyId !== identity.keyId || typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1_000)) {
    throw new Error("hosted device JWT claims are not exact, short-lived, or device-scoped");
  }
}

async function waitForEventProcessed(client, eventId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await client.query("managedAuth:revenueCatEventStatus", { eventId });
    if (status?.processed === true && status.eventType === "CANCELLATION" && status.environment === "SANDBOX") return;
    await delay(500);
  }
  throw new Error("hosted RevenueCat event was not processed within the bounded canary wait");
}

async function uploadAndRegisterFirstPart(client, targetFetch, credential, sessionId, part, timelinePath) {
  client.setAuth(credential.authToken);
  const url = await client.mutation("managedTranscription:generateUploadUrl", { sessionId });
  if (typeof url !== "string") throw new Error("hosted Convex upload URL response is invalid");
  assertHostedUrl(url, "cloud");
  const source = await readFile(timelinePath);
  const partBytes = source.subarray(0, part.byteLength);
  const response = await targetFetch(url, { method: "POST", body: partBytes });
  if (!response.ok) throw new Error("hosted Convex storage upload rejected the first physical part");
  const payload = await readJson(response);
  if (!payload || typeof payload.storageId !== "string") throw new Error("hosted Convex storage response did not contain a storage identity");
  const registered = await client.mutation("managedTranscription:registerPart", {
    sessionId,
    partNumber: part.partNumber,
    sampleOffset: part.sampleOffset,
    sampleCount: part.sampleCount,
    byteLength: part.byteLength,
    sha256: part.sha256,
    storageId: payload.storageId,
  });
  if (registered?.outcome !== "stored") throw new Error("hosted Convex first physical part was not registered");
}

async function assertPublishedMeetingStoreResult(result, local) {
  const expectedText = `Managed local provider transcript for ${local.recordingId}`;
  if (result.job.status !== "succeeded" || result.job.sampleCount !== FIXTURE_SAMPLE_COUNT || result.job.durationMs !== 601_000 || result.job.billableSeconds !== 601 || !result.job.providerResult || result.job.providerResult.ranges.length !== 1 || result.job.providerResult.ranges[0].startMs !== 0 || result.job.providerResult.ranges[0].endMs !== 601_000 || result.job.providerResult.text !== expectedText) {
    throw new Error("hosted fake provider did not produce one settled full-timeline job");
  }
  if (result.transcript.status !== "ready" || result.transcript.recordingId !== local.recordingId || result.transcript.ranges.length !== 1 || result.transcript.ranges[0].text !== expectedText) {
    throw new Error("hosted Convex result was not published through MeetingStore");
  }
  const citation = await local.store.resolveCitation(local.meetingId, result.transcript.ranges[0].segmentId);
  if (!citation || citation.text !== expectedText || citation.audioPath !== local.outputPath || citation.startMs !== 0 || citation.endMs !== 601_000) {
    throw new Error("MeetingStore citation publication does not match the hosted logical timeline");
  }
}

function assertCleanupResult(value) {
  if (!value || value.cleaned !== true || value.accounts !== 1 || value.lineages !== 1 || value.devices !== 1 || value.principals !== 1 || value.jobs !== 1 || value.uploads !== 1 || value.periods !== 1 || value.events !== 1 || value.challenges < 1) {
    throw new Error("hosted canary cleanup did not remove exactly its unique account projection");
  }
}

async function createLocalMeetingFixture(root, runId) {
  const meetingId = `hosted-canary-meeting-${runId}`;
  const recordingId = `hosted-canary-recording-${runId}`;
  const storeRoot = path.join(root, "meeting-store");
  const outputPath = path.join(root, "saved-output.mp3");
  const timelinePath = path.join(root, "canonical-timeline.wav");
  const now = new Date().toISOString();
  const chunkId = `chunk--microphone--000000--000000000000--${String(LOCAL_OUTPUT_SAMPLE_COUNT).padStart(12, "0")}--16000--1`;
  const sessionDirectory = path.join(storeRoot, "sessions", recordingId);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const chunkPath = path.join(sessionDirectory, `${chunkId}.wav`);
  const chunkBytes = makePcmWav(LOCAL_OUTPUT_SAMPLE_COUNT, 3);
  await writeFile(chunkPath, chunkBytes, { mode: 0o600 });
  const outputBytes = Buffer.from("hosted-canary-mp3-output");
  await writeFile(outputPath, outputBytes, { mode: 0o600 });
  const chunkIdentity = identityOf(chunkBytes);
  const outputIdentity = identityOf(outputBytes);
  const store = new MeetingStore({ root: storeRoot, now: () => now });
  await store.create({ id: meetingId, title: "Hosted Convex canary" });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: chunkId,
    source: "microphone",
    storageKey: path.relative(storeRoot, chunkPath),
    byteLength: chunkIdentity.byteLength,
    sha256: chunkIdentity.sha256,
    committedAt: now,
    logicalStartMs: 0,
    durationMs: 1_500,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  });
  await store.prepareInventoryRecovery(recordingId, "hosted canary capture closed");
  await store.markInventoryScanning(recordingId);
  const inventoryLine = {
    sortKey: `microphone:${String(0).padStart(16, "0")}:${chunkId}`,
    id: chunkId,
    source: "microphone",
    storageKey: path.relative(storeRoot, chunkPath),
    byteLength: chunkIdentity.byteLength,
    sha256: chunkIdentity.sha256,
    committedAt: now,
    logicalStartMs: 0,
    durationMs: 1_500,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryLine)}\n`);
  const inventoryPath = path.join(sessionDirectory, "inventory.ndjson");
  await writeFile(inventoryPath, inventoryBytes, { mode: 0o600 });
  await store.publishInventory(recordingId, {
    storageKey: path.relative(storeRoot, inventoryPath),
    digest: sha256Bytes(inventoryBytes),
    chunkCount: 1,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: now,
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true,
    chunkSetDigest: sha256Bytes(inventoryBytes),
    destination: outputPath,
    expectedIdentity: outputIdentity,
  });
  await store.markRecordingSaved(recordingId, { destination: outputPath, identity: outputIdentity, readable: true });

  const artifacts = new ManagedTimelineArtifactStore(path.join(root, "managed-artifacts"));
  const timelineBytes = makePcmWav(FIXTURE_SAMPLE_COUNT, 7);
  await writeFile(timelinePath, timelineBytes, { mode: 0o600 });
  const timelineIdentity = identityOf(timelineBytes);
  const manifestSha256 = sha256Text(`hosted-canary-manifest:${recordingId}`);
  await artifacts.accept({
    path: timelinePath,
    recordingId,
    manifestSha256,
    identity: timelineIdentity,
    startMs: 0,
    endMs: 601_000,
    cleanup: async () => rm(timelinePath, { force: true }),
  }, { meetingId });
  return { store, artifacts, meetingId, recordingId, outputPath, timelinePath: path.join(root, "managed-artifacts", sha256Text(recordingId), "timeline.wav"), manifestSha256 };
}

function makePcmWav(sampleCount, marker) {
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(sampleCount * 2, 40);
  bytes.writeInt16LE(marker, 44);
  return bytes;
}

function identityOf(bytes) {
  return { byteLength: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function writeEnvFile(filePath, values) {
  const contents = `${Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`;
  await writeFile(filePath, contents, { mode: 0o600 });
}

function assertJwtAudience(audience, expected) {
  return (Array.isArray(audience) ? audience : [audience]).includes(expected);
}

function pem(label, bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function safeProcessError(error) {
  if (error?.code === "ETIMEDOUT") return "deadline exceeded";
  if (error?.signal === "SIGTERM") return "terminated by deadline";
  if (error?.signal === "SIGKILL") return "terminated after deadline";
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "child output exceeded bounded buffer";
  if (error?.message === "deadline exceeded" || error?.message === "owned process did not terminate after deadline") return error.message;
  return "child process exited unsuccessfully";
}

function stageLog(stage, state) {
  process.stderr.write(`[managed-convex-hosted] ${stage}:${state}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const stage = error?.stage ? ` stage=${error.stage}` : "";
    const diagnostic = error?.diagnostic ?? formatHostedDiagnostic("hosted canary wrapper failure", [], STDERR_RING_BYTES);
    console.error(JSON.stringify({ result: "attention_required", stage: error?.stage ?? "wrapper", diagnostic }));
    console.error(`[managed-convex-hosted] result:attention_required${stage}; no cloud cleanup was attempted`);
    process.exitCode = 1;
  });
}
