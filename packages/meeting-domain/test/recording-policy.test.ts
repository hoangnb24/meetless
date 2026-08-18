import { describe, expect, test } from "vitest";
import {
  adoptOrphanChunk,
  assertCleanupEligible,
  assessInterruptedRecording,
  beginFinalization,
  commitRecordingChunk,
  interruptRecording,
  markRecordingSaved,
  markRecordingInventoryScanning,
  pauseRecording,
  prepareRecordingInventoryRecovery,
  publishRecordingInventory,
  reconcilePublishIntent,
  recordingElapsedMs,
  resumeRecording,
  retryFinalization,
  startRecording,
  type CommittedRecordingChunk,
  type RecordingSession,
} from "../src/index.js";

const chunk = (id: string, source: "microphone" | "system" = "microphone"): CommittedRecordingChunk => ({
  id,
  source,
  storageKey: `sessions/r-1/${id}.chunk`,
  byteLength: 128,
  sha256: `sha-${id}`,
  committedAt: "2026-08-17T10:00:05.000Z",
  logicalStartMs: id.includes("system") ? 10_000 : 0,
  durationMs: 5_000,
  sampleRate: 16_000,
  channels: 1,
  format: "wav",
});

function completeInventory(recording: RecordingSession, digest = "set-sha"): RecordingSession {
  const recovered = prepareRecordingInventoryRecovery(recording, {
    now: "2026-08-17T10:00:09.000Z", reason: "capture closed",
  });
  const scanning = markRecordingInventoryScanning(recovered, "2026-08-17T10:00:09.100Z");
  return publishRecordingInventory(scanning, { now: "2026-08-17T10:00:09.200Z", pointer: {
    storageKey: `sessions/${recording.id}/inventory-${digest}.ndjson`, digest,
    chunkCount: recording.chunks.length,
    microphoneCount: recording.chunks.filter((candidate) => candidate.source === "microphone").length,
    systemCount: recording.chunks.filter((candidate) => candidate.source === "system").length,
    publishedAt: "2026-08-17T10:00:09.150Z",
  } });
}

describe("recording policy", () => {
  test("counts only unpaused time and preserves source-labelled committed chunks", () => {
    let recording = startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" });
    recording = commitRecordingChunk(recording, chunk("mic-1"));
    recording = pauseRecording(recording, {
      now: "2026-08-17T10:00:10.000Z",
      openChunksDurablyClosed: true,
    });
    expect(recordingElapsedMs(recording, "2026-08-17T10:01:10.000Z")).toBe(10_000);
    expect(() => commitRecordingChunk(recording, chunk("paused"))).toThrow(/Resume the recording/);

    recording = resumeRecording(recording, "2026-08-17T10:01:10.000Z");
    recording = commitRecordingChunk(
      recording,
      { ...chunk("system-1", "system"), committedAt: "2026-08-17T10:01:15.000Z" },
    );
    recording = pauseRecording(recording, {
      now: "2026-08-17T10:01:20.000Z",
      openChunksDurablyClosed: true,
    });

    expect(recording.elapsedMs).toBe(20_000);
    expect(recording.chunks.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: "mic-1", source: "microphone" },
      { id: "system-1", source: "system" },
    ]);
  });

  test("adopts only fully committed readable orphan chunks with valid identity", () => {
    const recording = startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" });

    expect(() =>
      adoptOrphanChunk(recording, {
        chunk: chunk("partial"),
        fullyCommitted: false,
        readable: true,
        identityValid: true,
      }),
    ).toThrow(/Partial or invalid orphan chunks.*docs\/product\/recording\.md.*Quarantine the partial/);

    expect(
      adoptOrphanChunk(recording, {
        chunk: chunk("complete"),
        fullyCommitted: true,
        readable: true,
        identityValid: true,
      }).chunks,
    ).toHaveLength(1);
  });

  test("routes interruption to recoverable with valid chunks and failed for proven media loss", () => {
    const started = startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" });
    const interrupted = interruptRecording(commitRecordingChunk(started, chunk("mic-1")), {
      now: "2026-08-17T10:00:10.000Z",
      reason: "helper EOF",
    });
    expect(assessInterruptedRecording(interrupted, {
      recoverable: true,
      now: "2026-08-17T10:00:11.000Z",
    }).status).toBe("recoverable");

    const emptyInterrupted = interruptRecording(
      startRecording({ id: "r-2", meetingId: "m-2", now: "2026-08-17T10:00:00.000Z" }),
      { now: "2026-08-17T10:00:01.000Z", reason: "media corruption" },
    );
    const failed = assessInterruptedRecording(emptyInterrupted, {
      recoverable: false,
      reason: "No readable chunks",
      now: "2026-08-17T10:00:02.000Z",
    });
    expect(failed).toMatchObject({ status: "failed", failureReason: "No readable chunks" });
  });

  test("keeps the finalization digest and chunks immutable across interruption and retry", () => {
    const started = commitRecordingChunk(
      startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" }),
      chunk("mic-1"),
    );
    const finalizing = beginFinalization(completeInventory(started), {
      now: "2026-08-17T10:00:10.000Z",
      openChunksDurablyClosed: true,
      chunkSetDigest: "set-sha",
      destination: "meetings/10-17-08-26.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    });
    const interrupted = interruptRecording(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      reason: "encoder exited",
    });
    const recoverable = assessInterruptedRecording(interrupted, {
      recoverable: true,
      now: "2026-08-17T10:00:12.000Z",
    });
    const retried = retryFinalization(recoverable, { now: "2026-08-17T10:00:13.000Z" });

    expect(retried.finalization).toEqual(finalizing.finalization);
    expect(retried.inventory).toEqual(finalizing.inventory);
    expect(() =>
      beginFinalization(recoverable, {
        now: "2026-08-17T10:00:13.000Z",
        openChunksDurablyClosed: true,
        chunkSetDigest: "different",
        destination: "meetings/different.mp3",
        expectedIdentity: { byteLength: 999, sha256: "different" },
      }),
    ).toThrow(/immutable.*original committed chunks/);
  });

  test("treats mismatching existing output as a collision and chooses a new path", () => {
    const started = commitRecordingChunk(
      startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" }),
      chunk("mic-1"),
    );
    const finalizing = beginFinalization(completeInventory(started), {
      now: "2026-08-17T10:00:10.000Z",
      openChunksDurablyClosed: true,
      chunkSetDigest: "set-sha",
      destination: "meetings/10-17-08-26.mp3",
      expectedIdentity: { byteLength: 512, sha256: "new-mp3" },
    });

    expect(() => reconcilePublishIntent(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      existingOutput: { byteLength: 400, sha256: "existing-mp3" },
      existingOutputReadable: true,
    })).toThrow(
      /exports are never overwritten.*docs\/product\/recording\.md.*Choose a new collision-safe destination/,
    );
    expect(() => reconcilePublishIntent(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      existingOutput: { byteLength: 400, sha256: "existing-mp3" },
      existingOutputReadable: true,
      nextDestination: "meetings/10-17-08-26.mp3",
    })).toThrow(/Choose a new collision-safe destination/);

    const collision = reconcilePublishIntent(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      existingOutput: { byteLength: 400, sha256: "existing-mp3" },
      existingOutputReadable: true,
      nextDestination: "meetings/10-17-08-26-2.mp3",
    });
    expect(collision.action).toBe("collision");
    expect(collision.session.finalization?.publishIntent.destination).toBe("meetings/10-17-08-26-2.mp3");
  });

  test("rejects cleanup until the exact readable MP3 identity is saved", () => {
    const started = commitRecordingChunk(
      startRecording({ id: "r-1", meetingId: "m-1", now: "2026-08-17T10:00:00.000Z" }),
      chunk("mic-1"),
    );
    const finalizing = beginFinalization(completeInventory(started), {
      now: "2026-08-17T10:00:10.000Z",
      openChunksDurablyClosed: true,
      chunkSetDigest: "set-sha",
      destination: "meetings/output.mp3",
      expectedIdentity: { byteLength: 512, sha256: "mp3-sha" },
    });

    const verification = {
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "mp3-sha" },
      readable: true,
    };
    expect(() => assertCleanupEligible(finalizing, verification)).toThrow(
      /exact MP3 is readable and verified and saved state is durable.*docs\/product\/recording\.md.*durably mark the recording saved/,
    );
    expect(() => markRecordingSaved(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "wrong" },
      readable: true,
    })).toThrow(/Verify the intended MP3 path and identity/);

    const saved = markRecordingSaved(finalizing, {
      now: "2026-08-17T10:00:11.000Z",
      destination: "meetings/output.mp3",
      identity: { byteLength: 512, sha256: "mp3-sha" },
      readable: true,
    });
    expect(() => assertCleanupEligible(saved, { ...verification, readable: false })).toThrow(
      /Cleanup verification.*docs\/product\/recording\.md.*verify the exact saved MP3/,
    );
    expect(() => assertCleanupEligible(saved, verification)).not.toThrow();
  });
});
