import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MeetingStore, MeetingStoreCorruptError } from "../src/index.js";

const roots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-chat-store-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function readyMeeting(store: MeetingStore, meetingId: string, recordingId: string): Promise<string[]> {
  const now = "2026-08-20T10:00:00.000Z";
  await store.create({ id: meetingId, title: meetingId });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: `${recordingId}-chunk`, source: "microphone", storageKey: `sessions/${recordingId}/chunk.wav`,
    byteLength: 128, sha256: `${recordingId}-chunk-sha`, committedAt: now,
    logicalStartMs: 0, durationMs: 2_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery(recordingId, "capture closed");
  await store.markInventoryScanning(recordingId);
  await store.publishInventory(recordingId, {
    storageKey: `sessions/${recordingId}/inventory.ndjson`, digest: `${recordingId}-inventory-sha`,
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: recovered.inventory.microphoneCount,
    systemCount: recovered.inventory.systemCount,
    publishedAt: now,
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true, chunkSetDigest: `${recordingId}-inventory-sha`,
    destination: `meetings/${recordingId}.mp3`, expectedIdentity: { byteLength: 256, sha256: `${recordingId}-audio-sha` },
  });
  await store.markRecordingSaved(recordingId, {
    destination: `meetings/${recordingId}.mp3`, identity: { byteLength: 256, sha256: `${recordingId}-audio-sha` }, readable: true,
  });
  const transcript = await store.ensureTranscript({
    meetingId, recordingId, rangeMs: 1_000,
    audio: { destination: `meetings/${recordingId}.mp3`, byteLength: 256, sha256: `${recordingId}-audio-sha`, durationMs: 2_000 },
  });
  for (const [index, range] of transcript.ranges.entries()) {
    const request = await store.beginTranscriptRequest(transcript.id);
    await store.checkpointTranscriptRange(transcript.id, {
      range, attempts: request!.attempt, text: `Meeting ${meetingId} segment ${index + 1}`,
      usage: null, detectedLanguages: ["en"],
    });
  }
  const ready = await store.publishTranscript(transcript.id);
  return ready.ranges.map((range) => range.segmentId);
}

describe("durable meeting chat store", () => {
  test("atomically creates one thread, appends the question, and starts one attempt", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");

    const results = await Promise.allSettled([
      store.startChatQuestion({
        meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
        question: "What did we decide?", provider: "codex", model: "gpt-5",
      }),
      store.startChatQuestion({
        meetingId: "meeting-1", threadId: "thread-2", userMessageId: "user-2", attemptId: "attempt-2",
        question: "What happens next?", provider: "claude", model: "sonnet",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as { version: number; chatThreads: unknown[] };
    expect(persisted.version).toBe(4);
    expect(persisted.chatThreads).toHaveLength(1);
    await expect(new MeetingStore({ root }).listChatThreads()).resolves.toMatchObject([{
      meetingId: "meeting-1", status: "running", activeAttemptId: "attempt-1",
      messages: [{ id: "user-1", role: "user", text: "What did we decide?" }],
      attempts: [{ id: "attempt-1", provider: "codex", model: "gpt-5", status: "running" }],
    }]);
  });

  test("persists a cited completion only after exact retrieval and transcript checks", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    const [segment1] = await readyMeeting(store, "meeting-1", "recording-1");
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "What did we decide?", provider: "codex", model: "gpt-5",
    });
    await store.recordChatRetrieval("meeting-1", "attempt-1", [segment1!]);
    const completed = await store.completeChatTurn("meeting-1", {
      attemptId: "attempt-1", assistantMessageId: "assistant-1", outcome: "supported",
      text: "The meeting contains a decision.", citationSegmentIds: [segment1!],
    });

    expect(completed).toMatchObject({ status: "ready", messages: [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant", citations: [{ segmentId: segment1 }] },
    ] });
    await expect(new MeetingStore({ root }).getChatThread("meeting-1")).resolves.toEqual(completed);
  });

  test("persists insufficient evidence without answer text or citations", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "What did we decide?", provider: "codex", model: "gpt-5",
    });

    const completed = await store.completeChatTurn("meeting-1", {
      attemptId: "attempt-1", assistantMessageId: "assistant-1",
      outcome: "insufficient_evidence", citationSegmentIds: [],
    });

    expect(completed.messages.at(-1)).toMatchObject({
      id: "assistant-1", outcome: "insufficient_evidence", text: null, citations: [],
    });
    await expect(new MeetingStore({ root }).getChatThread("meeting-1")).resolves.toEqual(completed);
  });

  test.each([
    { name: "unknown", citation: "unknown", retrieve: [] as string[], pattern: /unknown.*unresolved/i },
    { name: "cross meeting", citation: "cross", retrieve: [] as string[], pattern: /cross-meeting/i },
    { name: "unretrieved", citation: "own-2", retrieve: ["own-1"], pattern: /not retrieved/i },
    { name: "duplicate", citation: "own-1", retrieve: ["own-1"], duplicate: true, pattern: /duplicate/i },
  ])("rejects the whole $name citation completion without changing disk", async ({ citation, retrieve, duplicate, pattern }) => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    const own = await readyMeeting(store, "meeting-1", "recording-1");
    const cross = (await readyMeeting(store, "meeting-2", "recording-2"))[0]!;
    const aliases = new Map([["own-1", own[0]!], ["own-2", own[1]!], ["cross", cross]]);
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", provider: "codex", model: "gpt-5",
    });
    const retrieved = retrieve.map((id) => aliases.get(id) ?? id);
    if (retrieved.length > 0) await store.recordChatRetrieval("meeting-1", "attempt-1", retrieved);
    const before = await readFile(store.filePath, "utf8");
    const segmentId = aliases.get(citation) ?? citation;

    await expect(store.completeChatTurn("meeting-1", {
      attemptId: "attempt-1", assistantMessageId: "assistant-1", outcome: "supported", text: "Answer",
      citationSegmentIds: duplicate ? [segmentId, segmentId] : [segmentId],
    })).rejects.toThrow(pattern);
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  test("keeps provider failure retryable and never duplicates the user question", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", provider: "codex", model: "gpt-5",
    });
    await store.failChatTurn("meeting-1", "attempt-1", "provider timeout");
    const retried = await store.retryChatTurn("meeting-1", {
      attemptId: "attempt-2", provider: "codex", model: "gpt-5-mini",
    });

    expect(retried.messages).toMatchObject([{ id: "user-1", role: "user" }]);
    expect(retried.attempts).toMatchObject([
      { id: "attempt-1", userMessageId: "user-1", status: "failed", failureReason: "provider timeout" },
      { id: "attempt-2", userMessageId: "user-1", status: "running", model: "gpt-5-mini" },
    ]);
  });

  test("restart reconciliation fails running work without replay", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", provider: "codex", model: "gpt-5",
    });

    const restarted = new MeetingStore({ root, now: () => "2026-08-20T10:01:00.000Z" });
    await restarted.reconcileChatAfterRestart();
    const thread = await restarted.getChatThread("meeting-1");
    expect(thread).toMatchObject({ status: "failed", activeAttemptId: null, messages: [{ id: "user-1" }] });
    expect(thread?.attempts).toMatchObject([{ status: "failed", failureReason: expect.stringMatching(/restart.*retry/i) }]);
  });

  test("migrates a real v3 shape and byte-preserves meeting, recording, and transcript values", async () => {
    const root = await temporaryRoot();
    const seed = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(seed, "meeting-1", "recording-1");
    const v4 = JSON.parse(await readFile(seed.filePath, "utf8")) as Record<string, unknown>;
    v4.version = 3;
    delete v4.chatThreads;
    await writeFile(seed.filePath, `${JSON.stringify(v4, null, 2)}\n`, "utf8");
    const before = JSON.parse(await readFile(seed.filePath, "utf8")) as Record<string, unknown>;
    const preserved = JSON.stringify({ meetings: before.meetings, recordings: before.recordings, transcripts: before.transcripts });

    const migrated = new MeetingStore({ root, now: () => "2026-08-20T10:01:00.000Z" });
    await migrated.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", provider: "codex", model: "gpt-5",
    });
    const after = JSON.parse(await readFile(migrated.filePath, "utf8")) as Record<string, unknown>;
    expect(after.version).toBe(4);
    expect(JSON.stringify({ meetings: after.meetings, recordings: after.recordings, transcripts: after.transcripts })).toBe(preserved);
  });

  test("migrates a valid v2 recording without losing its existing values", async () => {
    const root = await temporaryRoot();
    const stateV2 = {
      version: 2,
      meetings: [{
        id: "meeting-1", title: "V2 meeting", status: "recording",
        createdAt: "2026-08-17T10:00:00.000Z", updatedAt: "2026-08-17T10:00:01.000Z",
      }],
      recordings: [{
        id: "recording-1", meetingId: "meeting-1", status: "failed",
        startedAt: "2026-08-17T10:00:00.000Z", updatedAt: "2026-08-17T10:00:01.000Z",
        elapsedMs: 1_000, activeSince: null, chunks: [], interruption: null,
        failureReason: "capture failed", finalization: null, savedOutput: null,
      }],
    };
    const filePath = path.join(root, "meetings.json");
    await writeFile(filePath, `${JSON.stringify(stateV2, null, 2)}\n`, "utf8");
    const store = new MeetingStore({ root });
    await store.migrateSchemaV1();
    const migrated = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number; meetings: unknown[]; recordings: Array<Record<string, unknown>>;
    };

    expect(migrated.version).toBe(4);
    expect(migrated.meetings).toEqual(stateV2.meetings);
    expect(migrated.recordings[0]).toMatchObject(stateV2.recordings[0]!);
    expect(migrated.recordings[0]).toMatchObject({
      inventory: { state: "pending", knownChunkCount: 0, microphoneCount: 0, systemCount: 0 },
    });
  });

  test("persists no Paseo identity field and fails closed if one is injected", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");
    await store.startChatQuestion({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", provider: "codex", model: "gpt-5",
    });
    const original = await readFile(store.filePath, "utf8");
    expect(original).not.toMatch(/"(?:agent|workspace|session|timeline)Id"/);
    const injected = JSON.parse(original) as { chatThreads: Array<{ attempts: Array<Record<string, unknown>> }> };
    injected.chatThreads[0]!.attempts[0]!.agentId = "paseo-agent-1";
    await writeFile(store.filePath, `${JSON.stringify(injected, null, 2)}\n`, "utf8");

    await expect(new MeetingStore({ root }).listChatThreads()).rejects.toBeInstanceOf(MeetingStoreCorruptError);
  });

  test("restarts with the host-global selection and complete attempt snapshots", async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore({ root, now: () => "2026-08-20T10:00:00.000Z" });
    await readyMeeting(store, "meeting-1", "recording-1");
    const selection = {
      provider: "codex",
      model: "gpt-5",
      modeId: "worker",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true, effort: "high" },
    } as const;
    await store.startChatQuestionWithSelection({
      meetingId: "meeting-1", threadId: "thread-1", userMessageId: "user-1", attemptId: "attempt-1",
      question: "Question", selection,
    });

    const restarted = new MeetingStore({ root });
    await expect(restarted.getChatSelection()).resolves.toEqual(selection);
    await expect(restarted.getChatThread("meeting-1")).resolves.toMatchObject({
      attempts: [{ provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: selection.featureValues }],
    });

    await restarted.failChatTurn("meeting-1", "attempt-1", "provider timeout");
    const retrySelection = {
      provider: "codex",
      model: "gpt-5-mini",
      modeId: "reviewer",
      thinkingOptionId: "low",
      featureValues: { fast_mode: false, effort: "low" },
    } as const;
    await restarted.retryChatTurnWithSelection("meeting-1", { attemptId: "attempt-2", selection: retrySelection });

    const restartedAgain = new MeetingStore({ root });
    await expect(restartedAgain.getChatSelection()).resolves.toEqual(retrySelection);
    await expect(restartedAgain.getChatThread("meeting-1")).resolves.toMatchObject({
      attempts: [
        { id: "attempt-1", status: "failed", provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high" },
        { id: "attempt-2", status: "running", provider: "codex", model: "gpt-5-mini", modeId: "reviewer", thinkingOptionId: "low", featureValues: retrySelection.featureValues },
      ],
    });
  });
});
