import { createTranscript, type Meeting, type RecordingSession, type TranscriptState } from "@meetless/meeting-domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MANAGED_PREMIUM_RECOVERY_MESSAGE,
  MANAGED_PREMIUM_REQUIRED_MESSAGE,
  TranscriptionRouteCoordinator,
  transcriptionFailure,
  type TranscriptionRouteStore,
} from "../src/transcription-route.js";

const roots: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of roots.splice(0)) cleanup();
});

describe("trusted managed transcription route", () => {
  test("shows only validated quota amounts and a verified reset timestamp", () => {
    const quotaFailure = { version: 1, kind: "managed_quota_insufficient", requiredSeconds: 23, remainingSeconds: 12, checkedAt: 1_000, resetAt: 2_000 };
    expect(transcriptionFailure({ quotaFailure })).toEqual({ category: "quota", message: expect.stringContaining("23 sec. 12 sec remained") });
    expect(transcriptionFailure({ quotaFailure }).message).toContain(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(2_000));
    expect(transcriptionFailure({ quotaFailure: { ...quotaFailure, resetAt: null } }).message).not.toContain("reset time");
    expect(transcriptionFailure({ quotaFailure: { ...quotaFailure, remainingSeconds: -1 } }).category).not.toBe("quota");
    expect(transcriptionFailure({ quotaFailure: { ...quotaFailure, requiredSeconds: 3910, remainingSeconds: 310 } }).message).toContain("1 hr 5 min 10 sec. 5 min 10 sec remained");
    expect(transcriptionFailure({ quotaFailure }).message).toContain("At that check, the reported reset time was");
  });

  test("selects only the requested saved recording, exposes the durable start, and coalesces duplicate starts", async () => {
    const selected = savedRecording("m-selected", "r-selected");
    const unrelated = savedRecording("m-other", "r-other");
    const pending = transcript("m-selected", "r-selected", "pending");
    const ready = { ...pending, status: "ready" as const };
    let current: TranscriptState | null = null;
    const completion = deferred<void>();
    const managed = vi.fn(async ({ recordingId, onDurableStart }: {
      recordingId: string;
      onDurableStart(transcript: TranscriptState): void;
    }) => {
      expect(recordingId).toBe(selected.id);
      current = pending;
      onDurableStart(pending);
      await completion.promise;
      current = ready;
      return { transcript: ready };
    });
    const premiumStatus = vi.fn(async () => ({ status: "active" as const }));
    const store = routeStore([selected, unrelated], (meetingId) => meetingId === "m-selected" ? current : null);
    const route = new TranscriptionRouteCoordinator(store, { status: premiumStatus }, { transcribe: managed });

    const firstRequest = route.start("m-selected");
    const duplicateRequest = route.start("m-selected");
    const first = await firstRequest;
    const duplicate = await duplicateRequest;

    expect(first).toMatchObject({ route: "managed", outcome: "started", transcript: { status: "pending", recordingId: "r-selected" } });
    expect(duplicate).toBe(first);
    expect(await route.start("m-selected")).toMatchObject({ outcome: "already_running" });
    expect(managed).toHaveBeenCalledOnce();
    expect(managed).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "r-selected" }));
    expect(premiumStatus).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ recordingId: "r-selected", status: "pending" });

    completion.resolve();
    await vi.waitFor(async () => {
      const completed = await route.start("m-selected");
      expect(completed).toMatchObject({ route: "managed", outcome: "completed", transcript: { status: "ready", recordingId: "r-selected" } });
    });
    expect(managed).toHaveBeenCalledOnce();
    expect((await store.getTranscriptForMeeting("m-other"))).toBeNull();
  });

  test("reading saved audio never starts work and relaunch pending state is interrupted", async () => {
    const recording = savedRecording("m-selected", "r-selected");
    let current: TranscriptState | null = null;
    const managed = vi.fn();
    const resumeExisting = vi.fn(async () => current);
    const premium = vi.fn(async () => ({ status: "active" as const }));
    const route = new TranscriptionRouteCoordinator(routeStore([recording], () => current), { status: premium }, { transcribe: managed, resumeExisting });
    expect((await route.status("m-selected")).transcription.outcome).toBe("not_started");
    expect(resumeExisting).not.toHaveBeenCalled();
    current = transcript("m-selected", "r-selected", "pending");
    expect((await route.status("m-selected")).transcription).toMatchObject({ outcome: "interrupted", retryEligible: true });
    expect(managed).not.toHaveBeenCalled();
    expect(premium).not.toHaveBeenCalled();
  });

  test("keeps a ready local transcript readable while acknowledgement recovery is unavailable", async () => {
    const recording = savedRecording("m-selected", "r-selected");
    const ready = transcript("m-selected", "r-selected", "ready");
    const managed = vi.fn();
    const recovery = deferred<TranscriptState | null>();
    const resumeExisting = vi.fn(() => recovery.promise);
    const route = new TranscriptionRouteCoordinator(routeStore([recording], () => ready), { status: async () => ({ status: "inactive" }) }, { transcribe: managed, resumeExisting });
    expect(await route.status("m-selected")).toMatchObject({ transcript: { status: "ready" }, transcription: { outcome: "completed" } });
    expect(managed).not.toHaveBeenCalled();
    expect(resumeExisting).toHaveBeenCalledOnce();
    recovery.resolve(null);
  });

  test("recovers an admitted result before Premium gating after entitlement expires", async () => {
    const recording = savedRecording("m-selected", "r-selected");
    const current = transcript("m-selected", "r-selected", "pending");
    const premium = vi.fn(async () => ({ status: "inactive" as const }));
    const managed = vi.fn();
    const route = new TranscriptionRouteCoordinator(routeStore([recording], () => current), { status: premium }, { transcribe: managed, resumeExisting: async () => ({ ...current, status: "ready" }) });
    expect(await route.start("m-selected")).toMatchObject({ outcome: "completed" });
    expect(premium).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled();
  });

  test.each([
    ["inactive", "purchase_required", MANAGED_PREMIUM_REQUIRED_MESSAGE],
    ["unavailable", "recovery_required", MANAGED_PREMIUM_RECOVERY_MESSAGE],
  ] as const)("preserves local audio and makes no managed calls when Premium is %s", async (status, outcome, message) => {
    const recording = savedRecording("m-selected", "r-selected");
    const managed = vi.fn();
    const store = routeStore([recording], () => null);
    const route = new TranscriptionRouteCoordinator(
      store,
      { status: async () => ({ status }) },
      { transcribe: managed },
    );

    const result = await route.start("m-selected");

    expect(result).toMatchObject({ route: "managed", outcome, transcript: null, message });
    expect(managed).not.toHaveBeenCalled();
    expect(await store.listRecordings()).toEqual([recording]);
    expect(result.message).not.toContain("docs/");
  });

  test("rejects before consent when the selected meeting has no saved recording", async () => {
    const managed = vi.fn();
    const store = routeStore([], () => null);
    const consent = vi.spyOn(store, "grantTranscriptionConsent");
    const route = new TranscriptionRouteCoordinator(
      { ...store, list: async () => [meeting("m-selected")] },
      { status: async () => ({ status: "active" as const }) },
      { transcribe: managed },
    );

    await expect(route.start("m-selected")).rejects.toThrow("Save the recording");
    expect(consent).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled();
  });

  test("retries a durable managed failure for the selected recording without touching another meeting", async () => {
    const selected = savedRecording("m-selected", "r-selected");
    const unrelated = savedRecording("m-other", "r-other");
    const pending = transcript("m-selected", "r-selected", "pending");
    const failed = { ...pending, status: "failed" as const, failureReason: "Managed transcription provider failed" };
    const ready = { ...pending, status: "ready" as const };
    let current: TranscriptState | null = null;
    let attempts = 0;
    const managed = vi.fn(async ({ recordingId, onDurableStart }: {
      recordingId: string;
      onDurableStart(transcript: TranscriptState): void;
    }) => {
      expect(recordingId).toBe(selected.id);
      attempts += 1;
      if (attempts === 1) {
        current = failed;
        throw new Error("provider failed with secret");
      }
      current = pending;
      onDurableStart(pending);
      current = ready;
      return { transcript: ready };
    });
    const store = routeStore([selected, unrelated], (meetingId) => meetingId === "m-selected" ? current : null);
    const route = new TranscriptionRouteCoordinator(
      store,
      { status: async () => ({ status: "active" as const }) },
      { transcribe: managed },
    );

    const first = await route.start("m-selected");
    let retry!: Awaited<ReturnType<typeof route.start>>;
    await vi.waitFor(async () => {
      retry = await route.start("m-selected");
      expect(retry.outcome).toBe("completed");
    });

    expect(first).toMatchObject({ route: "managed", outcome: "failed", transcript: { status: "failed" } });
    expect(retry).toMatchObject({ route: "managed", outcome: "completed", transcript: { status: "ready", recordingId: selected.id } });
    expect(managed).toHaveBeenCalledTimes(2);
    expect((await store.getTranscriptForMeeting("m-other"))).toBeNull();
  });
});

function routeStore(recordings: RecordingSession[], readTranscript: (meetingId: string) => TranscriptState | null): TranscriptionRouteStore {
  return {
    list: async () => recordings.map((recording) => meeting(recording.meetingId)),
    listRecordings: async () => recordings,
    getTranscriptForMeeting: async (meetingId) => readTranscript(meetingId),
    grantTranscriptionConsent: async () => ({ status: "granted", grantedAt: "2026-09-09T00:00:00.000Z" }),
  };
}

function meeting(id: string): Meeting {
  return {
    id,
    title: id,
    status: "ready",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

function savedRecording(meetingId: string, id: string): RecordingSession {
  return {
    id,
    meetingId,
    status: "saved",
    savedOutput: { destination: `/tmp/${id}.mp3`, byteLength: 10, sha256: "a".repeat(64) },
  } as unknown as RecordingSession;
}

function transcript(meetingId: string, recordingId: string, status: TranscriptState["status"]): TranscriptState {
  const created = createTranscript({
    meetingId,
    recordingId,
    audio: { destination: `/tmp/${recordingId}.mp3`, byteLength: 10, sha256: "a".repeat(64), durationMs: 1_000 },
    now: "2026-09-09T00:00:00.000Z",
  });
  return status === "pending" ? created : { ...created, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
