import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginContext } from "@paseo/plugin";
import { MeetingTranscriptionConsentRpc } from "@meetless/meeting-contracts";
import { MeetingStore } from "@meetless/meeting-store";
import contribute, { createTestContribution, type MeetlessContributionOptions } from "../index.js";
import { ManagedTimelineArtifactStore } from "../src/managed-transcription.js";
import { NativePremiumAccessPort } from "../src/premium-service.js";
import { RecordingService } from "../src/recording-service.js";
import {
  deleteMeetingBeforeRecordingBootstrap,
  deleteMeetingSafely,
  getMeetingStore,
} from "../src/server.js";
import { UnixSocketManagedAuthTransport } from "../src/managed-auth.js";
import type { ManagedConvexJob, ManagedConvexUploadSession } from "../src/managed-upload.js";
import type { ManagedLogicalTimelineManifest } from "@meetless/managed-transcription-foundation";

describe("Meetless plugin contribution", () => {
  test("publishes meeting and non-mutating readiness bootstrap without exposing recording control RPC", async () => {
    const handle = vi.fn();
    const addSurface = vi.fn();
    const addSidebarItem = vi.fn();
    const cleanup = contribute({ handle, addSurface, addSidebarItem } as unknown as PluginContext);

    expect(handle.mock.calls.map(([rpc]) => rpc.name)).toEqual([
      "meeting.provider.access.status",
      "meeting.provider.access.request",
      "meeting.create",
      "meeting.list",
      "meeting.delete",
      "meeting.transcript",
      "meeting.transcription.consent",
      "meeting.citation.resolve",
      "meeting.premium.operation",
      "meeting.premium.status",
      "meeting.premium.purchase",
      "meeting.premium.restore",
      "meeting.premium.devices",
      "meeting.premium.devices.revoke",
      "meeting.chat.providers",
      "meeting.chat.controls.v1",
      "meeting.chat.features.v1",
      "meeting.chat.selection.v1",
      "meeting.chat.get",
      "meeting.chat.ask",
      "meeting.chat.retry",
      "meeting.chat.ask.v1",
      "meeting.chat.retry.v1",
      "runtime.readiness.bootstrap",
    ]);
    expect(addSurface).not.toHaveBeenCalled();
    expect(addSidebarItem).not.toHaveBeenCalled();
    await expect(cleanup()).resolves.toBeUndefined();
    expect(handle.mock.calls.map(([rpc]) => rpc.name)).not.toContain("recording.start");
    const readiness = handle.mock.calls.find(([rpc]) => rpc.name === "runtime.readiness.bootstrap")![0];
    expect(() => readiness.input.parse({ nonce: randomUUID() })).toThrow();
    expect(readiness.input.parse({ nonce: randomUUID(), deadlineEpochMs: Date.now() + 1_000 }))
      .toHaveProperty("deadlineEpochMs");
  });

  test("test-only contribution factory injects the server loader without changing RPC registration", async () => {
    const loadServer = vi.fn(async () => ({
      grantTranscriptionConsent: async () => ({
        consent: { status: "granted", grantedAt: "2026-09-09T00:00:00.000Z" },
        route: "managed",
        outcome: "started",
        retryEligible: false,
        failureCategory: null,
        transcript: null,
        message: null,
      }),
    })) as unknown as NonNullable<MeetlessContributionOptions["loadServer"]>;
    const handle = vi.fn();
    const cleanup = createTestContribution({ loadServer })({ handle } as unknown as PluginContext);
    const consentHandler = handle.mock.calls.find(([rpc]) => rpc.name === "meeting.transcription.consent")?.[1] as
      ((input: { accepted: true; meetingId: string }) => Promise<unknown>) | undefined;

    await expect(consentHandler!({ accepted: true, meetingId: "test-meeting" })).resolves.toEqual({
      consent: { status: "granted", grantedAt: "2026-09-09T00:00:00.000Z" },
      route: "managed",
      outcome: "started",
      retryEligible: false,
      failureCategory: null,
      transcript: null,
      message: null,
    });
    expect(loadServer).toHaveBeenCalledTimes(1);
    await expect(cleanup()).resolves.toBeUndefined();
  });

  test("default contributed consent RPC reaches getTranscriptionRoute and the real Convex managed service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-default-managed-route-"));
    const convexCalls: Array<{ kind: string; name: string; body: string }> = [];
    const postedPartLengths: number[] = [];
    let manifest: ManagedLogicalTimelineManifest | null = null;
    let providerInvocations = 0;
    let session: ManagedConvexUploadSession = {
      sessionId: "default-managed-upload",
      accountId: "default-managed-account",
      deviceId: "default-managed-device",
      state: "uploading",
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      receivedPartNumbers: [],
      completedAt: null,
      jobId: null,
    };
    let job: ManagedConvexJob = {
      _id: "default-managed-job",
      uploadId: session.sessionId,
      recordingId: "",
      audioId: "",
      admissionId: "default-managed-admission",
      admissionNumber: 1,
      status: "reserved",
      durationMs: 0,
      sampleCount: 0,
      billableSeconds: 0,
      providerResult: null,
    };
    const recordingService = new RecordingService({
      storeRoot: path.join(root, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(root, "Documents", "meetings"),
      fixture: true,
      exportNow: () => new Date("2026-09-09T00:00:00.000Z"),
      managedTimelineConsumer: new ManagedTimelineArtifactStore(path.join(root, "store", "managed-artifacts")),
    });
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/storage/")) {
        const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
        postedPartLengths.push(bytes.byteLength);
        return new Response(JSON.stringify({ storageId: `default-managed-storage-${postedPartLengths.length}` }), { status: 200 });
      }
      const body = typeof init?.body === "string"
        ? init.body
        : await new Response(init?.body as BodyInit).text();
      const request = JSON.parse(body) as { path: string; args: [Record<string, any>] };
      const args = request.args[0] ?? {};
      convexCalls.push({ kind: url.endsWith("/query") ? "query" : url.endsWith("/action") ? "action" : "mutation", name: request.path, body });
      if (request.path === "managedAuth:createDeviceChallenge") {
        return convexResponse({
          challengeId: "default-managed-challenge",
          purpose: args.purpose,
          deviceId: args.deviceId,
          keyId: args.keyId,
          expiresAt: Date.now() + 60_000,
          signingPayload: Buffer.from("default-managed-challenge").toString("base64url"),
          issuer: "https://default-managed.test",
          audience: "default-managed",
        });
      }
      if (request.path === "managedAuthActions:refreshDevice") {
        return convexResponse({ authToken: "default-managed-auth-token", expiresAt: Date.now() + 60 * 60 * 1_000, deviceId: args.deviceId, keyId: args.keyId, state: "active", naturalExpiryAt: null, version: 1 });
      }
      if (request.path === "managedTranscription:beginUpload") {
        manifest = args.manifest as ManagedLogicalTimelineManifest;
        job = { ...job, recordingId: manifest.recordingId, audioId: manifest.audioId, durationMs: manifest.durationMs, sampleCount: manifest.sampleCount, billableSeconds: Math.ceil(manifest.sampleCount / 16_000) };
        return convexResponse(session);
      }
      if (request.path === "managedTranscription:generateUploadUrl") {
        return convexResponse(`https://small-mouse-123.convex.cloud/storage/${postedPartLengths.length + 1}`);
      }
      if (request.path === "managedTranscription:registerPart") {
        const partNumber = args.partNumber as number;
        session = { ...session, receivedPartNumbers: [...new Set([...session.receivedPartNumbers, partNumber])].sort((left, right) => left - right) };
        return convexResponse({ outcome: "stored", partNumber, storageId: `default-managed-storage-${postedPartLengths.length}` });
      }
      if (request.path === "managedTranscriptionActions:sealUpload") {
        session = { ...session, state: "sealed", jobId: job._id };
        return convexResponse(job);
      }
      if (request.path === "managedTranscriptionActions:runProvider") {
        providerInvocations += 1;
        if (!manifest || providerInvocations < manifest.parts.length) {
          return convexResponse({ ...job, status: "reserved", providerResult: null });
        }
        const text = "default composition managed transcript";
        job = { ...job, status: "provider_completed", providerResult: { text, ranges: [{ startMs: 0, endMs: job.durationMs, text }], detectedLanguages: ["en"] } };
        return convexResponse(job);
      }
      if (request.path === "managedTranscription:settleJob") {
        job = { ...job, status: "succeeded" };
        return convexResponse(job);
      }
      if (request.path === "managedTranscriptionActions:acknowledge") {
        session = { ...session, state: "cleaned" };
        return convexResponse(true);
      }
      if (request.path === "managedTranscription:status") return convexResponse(session);
      if (request.path === "managedTranscription:jobStatusByRecording") return convexResponse(job);
      throw new Error(`unexpected default composition Convex function ${request.path}`);
    };

    try {
      await recordingService.initialize();
      await recordingService.execute({ version: 1, requestId: "start", command: "start", title: "Default managed route" });
      await waitFor(async () => (await recordingService.status()).chunks.length >= 2);
      const recordingId = (await recordingService.status()).recordingId!;
      const recording = (await recordingService.store.listRecordings()).find((candidate) => candidate.id === recordingId)!;
      await recordingService.execute({ version: 1, requestId: "stop", command: "stop" });

      const nativeSocketPath = path.join(root, "transcription.sock");
      const premiumAccess = { entitlement: "premium", status: "active", packages: [], reason: null } as const;
      const premiumRecover = vi.spyOn(NativePremiumAccessPort.prototype, "recover").mockResolvedValue(null);
      const premiumStatus = vi.spyOn(NativePremiumAccessPort.prototype, "status").mockResolvedValue(premiumAccess);
      const premiumTransaction = vi.spyOn(NativePremiumAccessPort.prototype, "readSignedTransaction").mockResolvedValue("opaque-apple-proof");
      const identity = vi.spyOn(UnixSocketManagedAuthTransport.prototype, "identity").mockResolvedValue({
        deviceId: "default-managed-device",
        keyId: "default-managed-key",
        publicKey: "default-managed-public-key",
      });
      const signChallenge = vi.spyOn(UnixSocketManagedAuthTransport.prototype, "signChallenge").mockResolvedValue({
        deviceId: "default-managed-device",
        keyId: "default-managed-key",
        publicKey: "default-managed-public-key",
        signature: "default-managed-signature",
      });
      vi.stubEnv("MEETLESS_STORE_ROOT", path.join(root, "store"));
      vi.stubEnv("MEETLESS_EXPORT_ROOT", path.join(root, "Documents", "meetings"));
      vi.stubEnv("MEETLESS_CONVEX_URL", "https://small-mouse-123.convex.cloud");
      vi.stubEnv("MEETLESS_TRANSCRIPTION_SOCKET", nativeSocketPath);
      vi.stubGlobal("fetch", fakeFetch);

      const handle = vi.fn();
      const cleanup = contribute({ handle } as unknown as PluginContext);
      const consentHandler = handle.mock.calls.find(([rpc]) => rpc.name === "meeting.transcription.consent")?.[1] as
        ((input: { accepted: true; meetingId: string }) => Promise<unknown>) | undefined;
      expect(consentHandler).toBeTypeOf("function");
      const output = MeetingTranscriptionConsentRpc.output.parse(await consentHandler!({ accepted: true, meetingId: recording.meetingId }));
      expect(output).toMatchObject({ consent: { status: "granted" }, route: "managed", outcome: "started", transcript: { recordingId, status: "pending" }, message: null });

      const serverStore = getMeetingStore();
      await waitFor(async () => (await serverStore.getTranscriptForMeeting(recording.meetingId))?.status === "ready");
      const transcript = await serverStore.getTranscriptForMeeting(recording.meetingId);
      expect(transcript).toMatchObject({ recordingId, status: "ready" });
      expect(transcript?.ranges).toHaveLength(1);
      expect(transcript?.ranges[0]).toMatchObject({ startMs: 0, endMs: transcript.audio.durationMs });
      expect(transcript?.checkpoints[0]?.text).toBe("default composition managed transcript");
      expect(providerInvocations).toBe(manifest!.parts.length);
      expect(manifest).not.toBeNull();
      expect(postedPartLengths).toEqual(manifest!.parts.map((part) => part.byteLength));
      expect(session.state).toBe("cleaned");
      expect(convexCalls.map((call) => call.name)).toEqual(expect.arrayContaining([
        "managedAuth:createDeviceChallenge",
        "managedAuthActions:refreshDevice",
        "managedTranscription:beginUpload",
        "managedTranscriptionActions:sealUpload",
        "managedTranscriptionActions:runProvider",
        "managedTranscription:settleJob",
        "managedTranscriptionActions:acknowledge",
      ]));
      expect(convexCalls.every((call) => !call.body.includes("OPENAI_API_KEY"))).toBe(true);
      expect(premiumRecover).toHaveBeenCalled();
      expect(premiumStatus).toHaveBeenCalled();
      expect(premiumTransaction).toHaveBeenCalled();
      expect(identity).toHaveBeenCalled();
      expect(signChallenge).toHaveBeenCalled();
      await cleanup();
    } finally {
      await recordingService.shutdown();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("server safety gate refuses active work and late work cannot recreate a deleted meeting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-delete-plugin-"));
    try {
      const store = new MeetingStore({ root });
      await store.create({ id: "m-active", title: "Active" });
      await store.startRecording({ id: "r-active", meetingId: "m-active" });
      await expect(deleteMeetingSafely(store, "m-active")).resolves.toEqual({
        meetingId: "m-active", outcome: "refused", reason: "active_capture",
      });

      await store.create({ id: "m-delete", title: "Delete" });
      await expect(deleteMeetingSafely(store, "m-delete")).resolves.toMatchObject({ outcome: "deleted" });
      await expect(store.transition("m-delete", "archived")).rejects.toThrow("Meeting not found: m-delete");
      expect((await store.list()).map((meeting) => meeting.id)).toEqual(["m-active"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pre-bootstrap deletion removes exact owned stages and preserves unrelated stage-like files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-delete-pre-bootstrap-"));
    const exportRoot = path.join(root, "exports");
    try {
      await mkdir(exportRoot, { recursive: true });
      const store = new MeetingStore({ root, approvedExportRoots: [exportRoot] });
      await store.create({ id: "m-delete", title: "Delete" });
      await store.startRecording({ id: "r-delete", meetingId: "m-delete" });
      await mkdir(path.join(root, "sessions", "r-delete"), { recursive: true });
      await store.interruptRecording("r-delete", "capture ended");
      await store.assessInterruption("r-delete", { recoverable: false });
      const ownedStage = path.join(exportRoot, ".meetless-r-delete-00000000-0000-4000-8000-000000000000.mp3.stage");
      const unrelatedStage = path.join(exportRoot, ".meetless-r-other-00000000-0000-4000-8000-000000000000.mp3.stage");
      const deceptiveStage = path.join(exportRoot, ".meetless-r-delete-not-a-uuid.mp3.stage");
      await Promise.all([
        writeFile(ownedStage, "owned"),
        writeFile(unrelatedStage, "unrelated"),
        writeFile(deceptiveStage, "deceptive"),
      ]);

      await expect(deleteMeetingBeforeRecordingBootstrap(store, "m-delete", exportRoot, root)).resolves.toEqual({
        meetingId: "m-delete", outcome: "deleted", reason: null,
      });

      await expect(readFile(ownedStage)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(unrelatedStage, "utf8")).resolves.toBe("unrelated");
      await expect(readFile(deceptiveStage, "utf8")).resolves.toBe("deceptive");
      await expect(store.list()).resolves.toEqual([]);
      await expect(store.listRecordings()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deletes a failed recording with no session directory without scanning exports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-delete-failed-no-session-"));
    const unavailableExportRoot = path.join(root, "exports-not-a-directory");
    try {
      await writeFile(unavailableExportRoot, "must not be read as a directory");
      const store = new MeetingStore({ root, approvedExportRoots: [root] });
      await store.create({ id: "m-failed", title: "Failed" });
      await store.startRecording({ id: "r-failed", meetingId: "m-failed" });
      await store.interruptRecording("r-failed", "capture failed before media commit");
      await store.assessInterruption("r-failed", { recoverable: false });

      await expect(deleteMeetingBeforeRecordingBootstrap(store, "m-failed", unavailableExportRoot, root))
        .resolves.toEqual({ meetingId: "m-failed", outcome: "deleted", reason: null });
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function convexResponse(value: unknown): Response {
  return new Response(JSON.stringify({ status: "success", value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for managed composition state");
}
