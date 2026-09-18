import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import type { ManagedAskRequest } from "@meetless/meeting-contracts/managed-ask";
import { MeetingChatService, toThreadWire } from "../src/chat-service.js";
import { ManagedMeetingChatAgentPort, managedAskSelection, MANAGED_ASK_HOST_FAILURE } from "../src/managed-ask.js";

// Same producer sequence as chat-store.test.ts's readyMeeting; one synthetic segment,
// no media/playback claim. The regression is anchored to build 7's success then failures.
async function readyMeeting(store: MeetingStore): Promise<void> {
  const now = "2026-09-18T10:00:00.000Z";
  await store.create({ id: "meeting-1", title: "Recovery regression" });
  await store.startRecording({ id: "recording-1", meetingId: "meeting-1" });
  await store.commitChunk("recording-1", {
    id: "chunk-1", source: "microphone", storageKey: "sessions/recording-1/chunk.wav",
    byteLength: 128, sha256: "chunk-sha", committedAt: now,
    logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery("recording-1", "capture closed");
  await store.markInventoryScanning("recording-1");
  await store.publishInventory("recording-1", {
    storageKey: "sessions/recording-1/inventory.ndjson", digest: "inventory-sha",
    chunkCount: recovered.inventory.knownChunkCount, microphoneCount: recovered.inventory.microphoneCount,
    systemCount: recovered.inventory.systemCount, publishedAt: now,
  });
  const destination = "meetings/recording-1.mp3";
  const identity = { byteLength: 256, sha256: "audio-sha" };
  await store.beginFinalization("recording-1", {
    openChunksDurablyClosed: true, chunkSetDigest: "inventory-sha", destination, expectedIdentity: identity,
  });
  await store.markRecordingSaved("recording-1", { destination, identity, readable: true });
  const transcript = await store.ensureTranscript({
    meetingId: "meeting-1", recordingId: "recording-1", rangeMs: 1_000,
    audio: { destination, ...identity, durationMs: 1_000 },
  });
  const request = await store.beginTranscriptRequest(transcript.id);
  await store.checkpointTranscriptRange(transcript.id, {
    range: transcript.ranges[0]!, attempts: request!.attempt,
    text: "The team chose local-first.", usage: null, detectedLanguages: ["en"],
  });
  await store.publishTranscript(transcript.id);
}

test("managed Ask recovers with an explicit new question after failure/retry, preserving history across reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-managed-chat-recovery-"));
  const services: MeetingChatService[] = [];
  const dispatch = vi.fn(async (request: ManagedAskRequest) => {
    // Inject only the dispatch fault; use the real adapter parsing and store throughout.
    if (dispatch.mock.calls.length === 2 || dispatch.mock.calls.length === 3) {
      throw new Error("invalid_answer");
    }
    return { outcome: "supported", text: "The team chose local-first.", citationSegmentIds: [request.segments[0]!.segmentId] };
  });
  const open = () => {
    const store = new MeetingStore({ root });
    const service = new MeetingChatService(store, new ManagedMeetingChatAgentPort(dispatch));
    services.push(service);
    return { store, service };
  };
  const input = { meetingId: "meeting-1", selection: managedAskSelection(), consent: true };
  const settled = async (service: MeetingChatService) => {
    await vi.waitFor(() => expect(service.isMeetingRunning("meeting-1")).toBe(false));
    return (await new MeetingStore({ root }).getChatThread("meeting-1"))!;
  };
  try {
    const { store, service } = open();
    await readyMeeting(store);
    await service.askWithSelection({ ...input, question: "What did the team choose?" });
    const first = await settled(service);
    expect(first.status).toBe("ready");
    expect(first.messages.at(-1)).toMatchObject({
      role: "assistant", outcome: "supported", citations: [{ segmentId: dispatch.mock.calls[0]![0].segments[0]!.segmentId }],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    await service.askWithSelection({ ...input, question: "What happens next?" });
    const failed = await settled(service);
    expect(failed).toMatchObject({ status: "failed", activeAttemptId: null });
    expect(failed.attempts.at(-1)).toMatchObject({ status: "failed", failureReason: MANAGED_ASK_HOST_FAILURE });
    expect(dispatch).toHaveBeenCalledTimes(2);
    await service.retryWithSelection(input);
    const retried = await settled(service);
    expect(retried.status).toBe("failed");
    expect(retried.messages).toEqual(failed.messages);
    expect(retried.attempts.slice(0, 2)).toEqual(failed.attempts);
    expect(retried.attempts.at(-1)).toMatchObject({
      status: "failed", userMessageId: failed.attempts.at(-1)!.userMessageId,
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    await service.close();

    const reopened = open();
    await expect(reopened.service.get("meeting-1")).resolves.toEqual(toThreadWire(retried));
    expect(dispatch).toHaveBeenCalledTimes(3);
    await reopened.service.askWithSelection({ ...input, question: "Remind me what the team chose?" });
    const completed = await settled(reopened.service);
    expect(completed).toMatchObject({ status: "ready", activeAttemptId: null });
    expect(completed.messages.slice(0, retried.messages.length)).toEqual(retried.messages);
    expect(completed.attempts.slice(0, retried.attempts.length)).toEqual(retried.attempts);
    expect(completed.attempts.map((attempt) => attempt.status)).toEqual(["completed", "failed", "failed", "completed"]);
    expect(completed.messages.filter((message) => message.role === "user")).toHaveLength(3);
    expect(completed.messages.at(-1)).toMatchObject({ role: "assistant", outcome: "supported" });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch.mock.calls[3]![0].messages).toEqual([
      { role: "user", text: "What did the team choose?" },
      { role: "assistant", text: "The team chose local-first." },
      { role: "user", text: "What happens next?" },
      { role: "user", text: "Remind me what the team chose?" },
    ]);
    const persisted = await readFile(store.filePath, "utf8");
    await expect(reopened.service.retryWithSelection(input)).rejects.toThrow(/Only a failed chat turn can be retried/);
    expect(await readFile(store.filePath, "utf8")).toBe(persisted);
    await reopened.service.close();
    const final = open();
    await expect(final.service.get("meeting-1")).resolves.toEqual(toThreadWire(completed));
    await expect(final.store.getChatThread("meeting-1")).resolves.toEqual(await reopened.store.getChatThread("meeting-1"));
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(await readFile(store.filePath, "utf8")).toBe(persisted);
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await rm(root, { recursive: true, force: true });
  }
});
