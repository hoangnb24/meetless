import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const localUrl = "http://127.0.0.1:3210";
const localConfigPath = path.join(repositoryRoot, ".convex", "local", "default", "config.json");
const envPath = path.join(repositoryRoot, ".env.local");
const gitignorePath = path.join(repositoryRoot, ".gitignore");
const maxPartSamples = 9_600_000;
const maxPartBytes = 44 + maxPartSamples * 2;
const sampleRate = 16_000;
const periodDay = 24 * 60 * 60 * 1_000;
const runId = `${Date.now()}-${process.pid}`;
const accountId = `local-proof:${runId}`;
const primaryToken = `local-proof:${runId}:primary`;
const siblingToken = `local-proof:${runId}:sibling`;
const thirdToken = `local-proof:${runId}:third`;
const anonymousToken = `local-proof:${runId}:anonymous`;
let convexProcess = null;
let adminKey = null;
let initialEnv = null;
let initialGitignore = null;
let initiallyHadConvex = false;
const ownedAccountIds = new Set([accountId]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function canonicalPart(sampleCount, marker = 0) {
  const bytes = canonicalWavHeader(sampleCount);
  const pcm = Buffer.alloc(sampleCount * 2);
  if (marker !== 0) pcm.writeInt16LE(marker, 0);
  return Buffer.concat([bytes, pcm]);
}

function partsDigestPayload(manifest) {
  return JSON.stringify({
    version: 1,
    recordingId: manifest.recordingId,
    audioId: manifest.audioId,
    sampleCount: manifest.sampleCount,
    parts: manifest.parts.map(({ partNumber, sampleOffset, sampleCount, byteLength, sha256: digest }) => ({
      partNumber,
      sampleOffset,
      sampleCount,
      byteLength,
      sha256: digest,
    })),
  });
}

function onePartManifest(recordingId, sampleCount = sampleRate, marker = 1) {
  const bytes = canonicalPart(sampleCount, marker);
  const audioId = `recording:${recordingId}`;
  const part = {
    partNumber: 1,
    sampleOffset: 0,
    sampleCount,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
  const manifest = {
    recordingId,
    audioId,
    manifestSha256: sha256(`manifest:${runId}:${recordingId}`),
    contentSha256: sha256(bytes),
    byteLength: bytes.byteLength,
    durationMs: Math.max(1, Math.ceil(sampleCount / sampleRate * 1_000)),
    sampleCount,
    partsManifestSha256: "",
    parts: [part],
  };
  manifest.partsManifestSha256 = sha256(partsDigestPayload(manifest));
  return { manifest, bytes };
}

function noCapManifest() {
  const recordingId = `recording-no-cap-${runId}`;
  const audioId = `recording:${recordingId}`;
  const parts = Array.from({ length: 7 }, (_, index) => ({
    partNumber: index + 1,
    sampleOffset: index * maxPartSamples,
    sampleCount: maxPartSamples,
    byteLength: maxPartBytes,
    sha256: sha256(`synthetic-part:${runId}:${index}`),
  }));
  const sampleCount = parts.reduce((total, part) => total + part.sampleCount, 0);
  const manifest = {
    recordingId,
    audioId,
    manifestSha256: sha256(`manifest:${runId}:no-cap`),
    contentSha256: sha256(`content:${runId}:no-cap`),
    byteLength: 44 + sampleCount * 2,
    durationMs: Math.ceil(sampleCount / sampleRate * 1_000),
    sampleCount,
    partsManifestSha256: "",
    parts,
  };
  manifest.partsManifestSha256 = sha256(partsDigestPayload(manifest));
  return manifest;
}

function oversizedManifest() {
  const recordingId = `recording-oversized-${runId}`;
  const audioId = `recording:${recordingId}`;
  const part = {
    partNumber: 1,
    sampleOffset: 0,
    sampleCount: maxPartSamples,
    byteLength: maxPartBytes,
    sha256: sha256(`oversized-declared-part:${runId}`),
  };
  const manifest = {
    recordingId,
    audioId,
    manifestSha256: sha256(`manifest:${runId}:oversized`),
    contentSha256: sha256(`content:${runId}:oversized`),
    byteLength: maxPartBytes,
    durationMs: 600_000,
    sampleCount: maxPartSamples,
    partsManifestSha256: "",
    parts: [part],
  };
  manifest.partsManifestSha256 = sha256(partsDigestPayload(manifest));
  return { manifest, bytes: Buffer.alloc(maxPartBytes + 1) };
}

async function fileSnapshot(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for anonymous local Convex deployment");
}

async function localDeploymentIsReachable() {
  try {
    await fetch(localUrl, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function startConvex() {
  const output = [];
  convexProcess = spawn("npx", ["convex", "dev", "--typecheck", "enable", "--codegen", "enable"], {
    cwd: repositoryRoot,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  convexProcess.stdout.on("data", (chunk) => output.push(String(chunk)));
  convexProcess.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exit = new Promise((resolve) => {
    convexProcess.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  try {
    await waitFor(async () => {
      if (convexProcess.exitCode !== null) return false;
      const logs = output.join("");
      const ready = logs.includes("Convex functions ready!") && logs.includes("[Local]") && logs.includes("No Convex account");
      if (!ready || !(await fileExists(localConfigPath))) return false;
      try {
        await fetch(localUrl);
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    const detail = output.join("").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").slice(-1_500);
    convexProcess.kill("SIGTERM");
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    convexProcess = null;
    throw new Error(`${error.message}; local Convex output: ${detail}`);
  }
  adminKey = JSON.parse(await readFile(localConfigPath, "utf8")).adminKey;
  if (typeof adminKey !== "string" || adminKey.length === 0) throw new Error("Anonymous local Convex config did not contain an admin key");
}

async function stopConvex() {
  const processToStop = convexProcess;
  if (!processToStop) return;
  const exit = new Promise((resolve) => processToStop.once("exit", resolve));
  if (processToStop.exitCode === null) processToStop.kill("SIGINT");
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (processToStop.exitCode === null) processToStop.kill("SIGTERM");
  await waitFor(async () => !(await localDeploymentIsReachable()), 10_000);
  convexProcess = null;
}

function clientFor(tokenIdentifier = null) {
  const client = new ConvexHttpClient(localUrl, { logger: false });
  if (tokenIdentifier) {
    client.setAdminAuth(adminKey, {
      tokenIdentifier,
      subject: tokenIdentifier,
      issuer: "meetless-local-canary",
    });
  } else {
    client.setAdminAuth(adminKey);
  }
  return client;
}

async function invoke(kind, name, args, tokenIdentifier = null) {
  const client = clientFor(tokenIdentifier);
  const reference = makeFunctionReference(name);
  if (kind === "query") return client.query(reference, args);
  if (kind === "mutation") return client.mutation(reference, args);
  if (kind === "action") return client.action(reference, args);
  throw new Error(`Unknown Convex invocation kind: ${kind}`);
}

async function expectReject(operation, text) {
  try {
    await operation();
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes(text.toLowerCase())) {
      throw new Error(`Expected Convex rejection containing '${text}', got '${message.slice(0, 500)}'`);
    }
    return message;
  }
  throw new Error(`Expected Convex rejection containing '${text}'`);
}

async function postPart(tokenIdentifier, sessionId, bytes) {
  const uploadUrl = await invoke("mutation", "managedTranscription:generateUploadUrl", { sessionId }, tokenIdentifier);
  const response = await fetch(uploadUrl, { method: "POST", body: bytes });
  if (!response.ok) throw new Error(`Generated local Convex upload URL rejected the part (${response.status})`);
  const body = await response.json();
  if (typeof body?.storageId !== "string") throw new Error("Generated local Convex upload did not return a storage ID");
  return body.storageId;
}

async function uploadAndRegister(tokenIdentifier, manifest, bytes) {
  const session = await invoke("mutation", "managedTranscription:beginUpload", { manifest }, tokenIdentifier);
  const storageId = await postPart(tokenIdentifier, session.sessionId, bytes);
  const part = manifest.parts[0];
  await invoke("mutation", "managedTranscription:registerPart", {
    sessionId: session.sessionId,
    partNumber: part.partNumber,
    sampleOffset: part.sampleOffset,
    sampleCount: part.sampleCount,
    byteLength: part.byteLength,
    sha256: part.sha256,
    storageId,
  }, tokenIdentifier);
  return { session, storageId };
}

async function main() {
  initialEnv = await fileSnapshot(envPath);
  initialGitignore = await fileSnapshot(gitignorePath);
  initiallyHadConvex = await fileExists(path.join(repositoryRoot, ".convex"));
  await startConvex();

  await invoke("mutation", "managedTranscription:seedLocalCanary", {
    tokenIdentifier: primaryToken,
    accountId,
    deviceId: "device-a",
  });
  await invoke("mutation", "managedTranscription:seedLocalCanary", {
    tokenIdentifier: siblingToken,
    accountId,
    deviceId: "device-b",
  });
  await invoke("mutation", "managedTranscription:seedLocalCanary", {
    tokenIdentifier: thirdToken,
    accountId,
    deviceId: "device-c",
  });
  await expectReject(() => invoke("mutation", "managedTranscription:seedLocalCanary", {
    tokenIdentifier: anonymousToken,
    accountId,
    deviceId: "device-d",
  }), "three-device");

  const identityManifest = onePartManifest(`recording-identity-${runId}`);
  await expectReject(() => invoke("mutation", "managedTranscription:beginUpload", { manifest: identityManifest.manifest }, anonymousToken), "verified");

  const mainRecording = `recording-main-${runId}`;
  const main = onePartManifest(mainRecording, sampleRate * 31, 7);
  const [firstBegin, secondBegin] = await Promise.all([
    invoke("mutation", "managedTranscription:beginUpload", { manifest: main.manifest }, primaryToken),
    invoke("mutation", "managedTranscription:beginUpload", { manifest: main.manifest }, primaryToken),
  ]);
  if (firstBegin.sessionId !== secondBegin.sessionId) throw new Error("Concurrent Convex begin calls did not converge on one upload session");
  const storageId = await postPart(primaryToken, firstBegin.sessionId, main.bytes);
  const descriptor = main.manifest.parts[0];
  const registerArgs = {
    sessionId: firstBegin.sessionId,
    partNumber: descriptor.partNumber,
    sampleOffset: descriptor.sampleOffset,
    sampleCount: descriptor.sampleCount,
    byteLength: descriptor.byteLength,
    sha256: descriptor.sha256,
    storageId,
  };
  const registrations = await Promise.all([
    invoke("mutation", "managedTranscription:registerPart", registerArgs, primaryToken),
    invoke("mutation", "managedTranscription:registerPart", registerArgs, primaryToken),
  ]);
  if (new Set(registrations.map((result) => result.outcome)).size !== 2) throw new Error("Concurrent Convex part registration did not return stored and duplicate outcomes");
  const statusAfterRegister = await invoke("query", "managedTranscription:status", { sessionId: firstBegin.sessionId }, primaryToken);
  if (JSON.stringify(statusAfterRegister.receivedPartNumbers) !== JSON.stringify([1])) throw new Error("Concurrent Convex part registration created a duplicate durable part");

  const mainJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: firstBegin.sessionId }, primaryToken);
  if (mainJob.status !== "reserved" || mainJob.durationMs !== 31_000) throw new Error("Thirty-one-second canonical timeline was not admitted as one logical job");
  await invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId, naturalExpiryAt: Date.now() - 1 });
  const providerResults = await Promise.all([
    invoke("action", "managedTranscriptionActions:runProvider", { jobId: mainJob._id }, primaryToken),
    invoke("action", "managedTranscriptionActions:runProvider", { jobId: mainJob._id }, primaryToken),
  ]);
  const afterProvider = await invoke("query", "managedTranscription:jobStatus", { jobId: mainJob._id }, primaryToken);
  if (afterProvider.status !== "succeeded" || afterProvider.providerInvocationCount !== 1 || afterProvider.providerResult?.ranges?.length !== 1) {
    throw new Error("Concurrent provider actions did not produce one winner, one invocation, and one atomic settlement");
  }
  if (!providerResults.some((result) => result.status === "succeeded")) throw new Error("Provider winner did not return the settled job");

  await stopConvex();
  await startConvex();
  const afterRestart = await invoke("query", "managedTranscription:jobStatus", { jobId: mainJob._id }, primaryToken);
  if (afterRestart.status !== "succeeded" || afterRestart.providerInvocationCount !== 1) throw new Error("Local Convex restart lost the settled job or duplicated provider execution");
  const settledAgain = await invoke("mutation", "managedTranscription:settleJob", { jobId: mainJob._id }, primaryToken);
  const settledThird = await invoke("mutation", "managedTranscription:settleJob", { jobId: mainJob._id }, primaryToken);
  if (settledAgain.status !== "succeeded" || settledThird.status !== "succeeded") throw new Error("Duplicate settlement did not remain idempotent after restart");
  const siblingJob = await invoke("query", "managedTranscription:jobStatusByRecording", { recordingId: mainRecording }, siblingToken);
  if (siblingJob?.status !== "succeeded") throw new Error("Sibling enrolled device could not recover an account-owned completed result");
  await invoke("action", "managedTranscriptionActions:acknowledge", { jobId: mainJob._id }, siblingToken);
  await invoke("action", "managedTranscriptionActions:acknowledge", { jobId: mainJob._id }, siblingToken);

  await invoke("mutation", "managedTranscription:setNaturalExpiry", { accountId, naturalExpiryAt: null });
  const identicalA = onePartManifest(`recording-identical-a-${runId}`, sampleRate, 4);
  const identicalB = onePartManifest(`recording-identical-b-${runId}`, sampleRate, 4);
  await invoke("mutation", "managedTranscription:beginUpload", { manifest: identicalA.manifest }, primaryToken);
  await invoke("mutation", "managedTranscription:beginUpload", { manifest: identicalB.manifest }, primaryToken);
  const rebound = onePartManifest(`recording-rebound-${runId}`, sampleRate, 5);
  await invoke("mutation", "managedTranscription:beginUpload", { manifest: rebound.manifest }, primaryToken);
  await expectReject(() => invoke("mutation", "managedTranscription:beginUpload", {
    manifest: { ...rebound.manifest, contentSha256: sha256("different-immutable-bytes") },
  }, primaryToken), "different bytes");

  const noCap = noCapManifest();
  const noCapSession = await invoke("mutation", "managedTranscription:beginUpload", { manifest: noCap }, primaryToken);
  if (!noCapSession?.sessionId || noCap.sampleCount <= sampleRate * 60 * 60) throw new Error("A synthetic logical timeline over sixty minutes was not policy-valid without a cap");
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: noCapSession.sessionId }, primaryToken);

  const cancelled = onePartManifest(`recording-cancelled-${runId}`);
  const cancelledUpload = await uploadAndRegister(primaryToken, cancelled.manifest, cancelled.bytes);
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: cancelledUpload.session.sessionId }, primaryToken);
  await expectReject(() => invoke("mutation", "managedTranscription:admitSealedUpload", {
    sessionId: cancelledUpload.session.sessionId,
    tokenIdentifier: primaryToken,
    contentSha256: cancelled.manifest.contentSha256,
    sampleCount: cancelled.manifest.sampleCount,
    byteLength: cancelled.manifest.byteLength,
    durationMs: cancelled.manifest.durationMs,
    partsManifestSha256: cancelled.manifest.partsManifestSha256,
    cancelGeneration: 0,
  }), "stale after upload cancellation");

  const lease = onePartManifest(`recording-lease-${runId}`);
  const leaseUpload = await uploadAndRegister(primaryToken, lease.manifest, lease.bytes);
  const leaseJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: leaseUpload.session.sessionId }, primaryToken);
  await invoke("action", "managedTranscriptionActions:reconcileManagedState", { accountId, now: leaseJob.leaseExpiresAt + 1, limit: 50 });
  const expiredLease = await invoke("query", "managedTranscription:jobStatus", { jobId: leaseJob._id }, primaryToken);
  if (expiredLease.status !== "expired") throw new Error("Lease reconciliation did not release an uncompleted job");
  const freshAdmission = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: leaseUpload.session.sessionId }, primaryToken);
  if (freshAdmission.status !== "reserved" || freshAdmission.admissionNumber !== 2 || freshAdmission.leaseExpiresAt <= Date.now()) throw new Error("Expired same-identity work did not receive a fresh active admission and lease");
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: leaseUpload.session.sessionId }, primaryToken);

  await invoke("mutation", "managedTranscription:setNextPeriodLimit", { accountId, limitSeconds: 2 });
  await invoke("mutation", "managedTranscription:prepareNextCanaryPeriod", { accountId, durationMs: periodDay });
  const rollover = onePartManifest(`recording-rollover-${runId}`);
  const rolloverUpload = await uploadAndRegister(primaryToken, rollover.manifest, rollover.bytes);
  const rolloverJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: rolloverUpload.session.sessionId }, primaryToken);
  const quota = await invoke("query", "managedTranscription:readLocalCanaryQuota", { accountId });
  if (quota.limitSeconds !== 2 || quota.reservedSeconds !== 1) throw new Error("Next-period configurable allowance was not snapshotted at rollover");
  await invoke("mutation", "managedTranscription:cancelUpload", { sessionId: rolloverUpload.session.sessionId }, primaryToken);

  const ttl = onePartManifest(`recording-ttl-${runId}`);
  const ttlUpload = await uploadAndRegister(primaryToken, ttl.manifest, ttl.bytes);
  const ttlJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: ttlUpload.session.sessionId }, primaryToken);
  await invoke("action", "managedTranscriptionActions:reconcileManagedState", { accountId, now: ttlJob.expiresAt + 1, limit: 50 });
  const expiredTtl = await invoke("query", "managedTranscription:jobStatus", { jobId: ttlJob._id }, primaryToken);
  if (expiredTtl.status !== "expired" || expiredTtl.providerResult !== null) throw new Error("Post-TTL reconciliation did not delete an uncompleted result and prevent settlement");
  await expectReject(() => invoke("mutation", "managedTranscription:settleJob", { jobId: ttlJob._id }, primaryToken), "expired");

  const inFlight = onePartManifest(`recording-revoke-flight-${runId}`);
  const inFlightUpload = await uploadAndRegister(primaryToken, inFlight.manifest, inFlight.bytes);
  const inFlightJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: inFlightUpload.session.sessionId }, primaryToken);
  const terminal = onePartManifest(`recording-revoke-terminal-${runId}`);
  const terminalUpload = await uploadAndRegister(primaryToken, terminal.manifest, terminal.bytes);
  const terminalJob = await invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: terminalUpload.session.sessionId }, primaryToken);
  await invoke("action", "managedTranscriptionActions:runProvider", { jobId: terminalJob._id }, primaryToken);
  await invoke("mutation", "managedTranscription:revokeDevice", { accountId, deviceId: "device-a" });
  await expectReject(() => invoke("query", "managedTranscription:jobStatus", { jobId: inFlightJob._id }, primaryToken), "verified");
  const siblingStopped = await invoke("query", "managedTranscription:jobStatus", { jobId: inFlightJob._id }, siblingToken);
  if (siblingStopped.status !== "stopped") throw new Error("Device revoke did not stop in-flight work");
  const siblingTerminal = await invoke("query", "managedTranscription:jobStatusByRecording", { recordingId: terminal.manifest.recordingId }, siblingToken);
  if (siblingTerminal?.status !== "succeeded") throw new Error("Sibling device could not recover completed account-owned work after revoke");
  await invoke("action", "managedTranscriptionActions:acknowledge", { jobId: terminalJob._id }, siblingToken);

  const oversized = oversizedManifest();
  // The oversized object is deliberately stored through the generated URL;
  // the seal action must reject on Blob.size before arrayBuffer materialization.
  // The primary account is revoked above, so use a fresh internal canary only
  // for this storage-bound negative boundary.
  const oversizedToken = `local-proof:${runId}:oversized`;
  const oversizedAccount = `local-proof:${runId}:oversized-account`;
  ownedAccountIds.add(oversizedAccount);
  await invoke("mutation", "managedTranscription:seedLocalCanary", { tokenIdentifier: oversizedToken, accountId: oversizedAccount, deviceId: "device-o" });
  const oversizedUpload = await invoke("mutation", "managedTranscription:beginUpload", { manifest: oversized.manifest }, oversizedToken);
  const oversizedStorageId = await postPart(oversizedToken, oversizedUpload.sessionId, oversized.bytes);
  await invoke("mutation", "managedTranscription:registerPart", {
    sessionId: oversizedUpload.sessionId,
    ...oversized.manifest.parts[0],
    storageId: oversizedStorageId,
  }, oversizedToken);
  await expectReject(() => invoke("action", "managedTranscriptionActions:sealUpload", { sessionId: oversizedUpload.sessionId }, oversizedToken), "Blob exceeds");
  await invoke("mutation", "managedTranscription:clearLocalCanary", { accountId: oversizedAccount });

  await invoke("mutation", "managedTranscription:clearLocalCanary", { accountId });
  console.log(JSON.stringify({
    frontier: "MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION",
    result: "passed",
    anonymousLocalConvex: true,
    concurrentBeginAndPartOCC: true,
    providerInvocations: afterRestart.providerInvocationCount,
    logicalTimelineSeconds: main.manifest.durationMs / 1_000,
    noCapLogicalTimelineSeconds: noCap.durationMs / 1_000,
    restartRecovered: true,
    cleanup: "account state cleared",
  }));
}

async function restoreFile(filePath, contents) {
  if (contents === null) {
    if (await fileExists(filePath)) await rm(filePath, { force: true });
    return;
  }
  const current = await fileSnapshot(filePath);
  if (!current || !current.equals(contents)) await writeFile(filePath, contents);
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ frontier: "MANAGED-TRANSCRIPTION-CONVEX-LOCAL-FIRST-R3-CORRECTION", result: "failed", error: String(error?.message ?? error).slice(0, 1_000) }));
  process.exitCode = 1;
} finally {
  if (adminKey && convexProcess) {
    for (const ownedAccountId of ownedAccountIds) {
      await invoke("mutation", "managedTranscription:clearLocalCanary", { accountId: ownedAccountId }).catch(() => undefined);
    }
  }
  await stopConvex().catch(() => undefined);
  await restoreFile(envPath, initialEnv).catch(() => undefined);
  await restoreFile(gitignorePath, initialGitignore).catch(() => undefined);
  if (!initiallyHadConvex) await rm(path.join(repositoryRoot, ".convex"), { recursive: true, force: true }).catch(() => undefined);
}
