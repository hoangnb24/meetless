import { describe, expect, test } from "vitest";
import {
  ChatPolicyError,
  completeChatAttempt,
  createMeetingChatThread,
  failChatAttempt,
  reconcileChatAfterRestart,
  recordChatRetrieval,
  retryChatAttempt,
  startChatQuestion,
  type MeetingChatThread,
} from "../src/index.js";

const startedAt = "2026-08-20T10:00:00.000Z";
const finishedAt = "2026-08-20T10:00:01.000Z";

function runningThread(): MeetingChatThread {
  const thread = createMeetingChatThread({ id: "thread-1", meetingId: "meeting-1", now: startedAt });
  return startChatQuestion(thread, {
    userMessageId: "message-user-1",
    attemptId: "attempt-1",
    question: "What decision did we make?",
    provider: "codex",
    model: "gpt-5",
    now: startedAt,
  });
}

describe("meeting chat policy", () => {
  test("completes a supported answer only with unique retrieved meeting citations", () => {
    const retrieved = recordChatRetrieval(runningThread(), {
      attemptId: "attempt-1",
      segmentIds: ["segment-1"],
      availableSegmentIds: ["segment-1", "segment-2"],
      now: startedAt,
    });
    const completed = completeChatAttempt(retrieved, {
      attemptId: "attempt-1",
      assistantMessageId: "message-assistant-1",
      outcome: "supported",
      text: "The team chose the local-first option.",
      citationSegmentIds: ["segment-1"],
      availableSegmentIds: ["segment-1", "segment-2"],
      now: finishedAt,
    });

    expect(completed).toMatchObject({ status: "ready", activeAttemptId: null });
    expect(completed.messages).toMatchObject([
      { id: "message-user-1", role: "user" },
      { id: "message-assistant-1", role: "assistant", outcome: "supported", citations: [{ segmentId: "segment-1" }] },
    ]);
    expect(completed.attempts).toMatchObject([{
      id: "attempt-1", provider: "codex", model: "gpt-5", status: "completed",
      retrievedSegmentIds: ["segment-1"],
    }]);
  });

  test.each([
    { name: "unknown citation", citations: ["unknown"], available: ["segment-1"], retrieved: ["unknown"], pattern: /unknown.*unresolved/i },
    { name: "cross-meeting citation", citations: ["other-meeting-segment"], available: ["segment-1"], retrieved: ["other-meeting-segment"], pattern: /cross-meeting/i },
    { name: "unretrieved citation", citations: ["segment-2"], available: ["segment-1", "segment-2"], retrieved: ["segment-1"], pattern: /not retrieved/i },
    { name: "duplicate citation", citations: ["segment-1", "segment-1"], available: ["segment-1"], retrieved: ["segment-1"], pattern: /duplicate/i },
  ])("rejects the whole supported completion for $name", ({ citations, available, retrieved, pattern }) => {
    const thread = recordChatRetrieval(runningThread(), {
      attemptId: "attempt-1", segmentIds: retrieved, availableSegmentIds: [...new Set([...available, ...retrieved])], now: startedAt,
    });
    expect(() => completeChatAttempt(thread, {
      attemptId: "attempt-1", assistantMessageId: "message-assistant-1", outcome: "supported",
      text: "Unsupported completion", citationSegmentIds: citations, availableSegmentIds: available, now: finishedAt,
    })).toThrow(pattern);
    expect(thread).toMatchObject({ status: "running", messages: [{ role: "user" }] });
  });

  test("records explicit insufficient evidence with no citation", () => {
    const completed = completeChatAttempt(runningThread(), {
      attemptId: "attempt-1",
      assistantMessageId: "message-assistant-1",
      outcome: "insufficient_evidence",
      citationSegmentIds: [],
      availableSegmentIds: ["segment-1"],
      now: finishedAt,
    });
    expect(completed.messages.at(-1)).toEqual({
      id: "message-assistant-1",
      role: "assistant",
      attemptId: "attempt-1",
      outcome: "insufficient_evidence",
      text: null,
      citations: [],
      createdAt: finishedAt,
    });
  });

  test("rejects answer text attached to insufficient evidence", () => {
    expect(() => completeChatAttempt(runningThread(), {
      attemptId: "attempt-1",
      assistantMessageId: "message-assistant-1",
      outcome: "insufficient_evidence",
      text: "The meeting says something factual.",
      citationSegmentIds: [],
      availableSegmentIds: ["segment-1"],
      now: finishedAt,
    } as unknown as Parameters<typeof completeChatAttempt>[1])).toThrow(/cannot contain answer text/i);
  });

  test("keeps operational failure distinct and retry reuses the user message", () => {
    const failed = failChatAttempt(runningThread(), {
      attemptId: "attempt-1", reason: "provider timeout", now: finishedAt,
    });
    expect(failed).toMatchObject({ status: "failed", activeAttemptId: null });
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]).toMatchObject({ role: "user", id: "message-user-1" });

    const retried = retryChatAttempt(failed, {
      attemptId: "attempt-2", provider: "claude", model: "sonnet", now: "2026-08-20T10:00:02.000Z",
    });
    expect(retried.messages).toHaveLength(1);
    expect(retried.attempts).toMatchObject([
      { id: "attempt-1", userMessageId: "message-user-1", status: "failed", failureReason: "provider timeout" },
      { id: "attempt-2", userMessageId: "message-user-1", status: "running", provider: "claude", model: "sonnet" },
    ]);
  });

  test("rejects malformed provider output instead of converting it to insufficient evidence", () => {
    expect(() => completeChatAttempt(runningThread(), {
      attemptId: "attempt-1", assistantMessageId: "message-assistant-1",
      outcome: "malformed", text: "bad output", citationSegmentIds: [],
      availableSegmentIds: ["segment-1"], now: finishedAt,
    } as unknown as Parameters<typeof completeChatAttempt>[1])).toThrow(/malformed.*operational failure/i);
  });

  test("a failed inactive turn permits a new question without changing old history", () => {
    const failed = failChatAttempt(runningThread(), {
      attemptId: "attempt-1", reason: "invalid_answer", now: finishedAt,
    });
    const before = structuredClone(failed);
    const next = startChatQuestion(failed, {
      userMessageId: "message-user-2", attemptId: "attempt-2", question: "Another question",
      provider: "codex", model: "gpt-5", now: finishedAt,
    });
    expect(next).toMatchObject({ status: "running", activeAttemptId: "attempt-2" });
    expect(next.messages.slice(0, -1)).toEqual(before.messages);
    expect(next.attempts.slice(0, -1)).toEqual(before.attempts);
    expect(failed).toEqual(before);
    const completed = completeChatAttempt(next, {
      attemptId: "attempt-2", assistantMessageId: "message-assistant-2",
      outcome: "insufficient_evidence", citationSegmentIds: [], availableSegmentIds: [], now: finishedAt,
    });
    expect(() => retryChatAttempt(completed, {
      attemptId: "attempt-3", provider: "codex", model: "gpt-5", now: finishedAt,
    })).toThrow(/Only a failed chat turn can be retried/);
  });

  test.each([
    { status: "running", activeAttemptId: "attempt-1" },
    { status: "running", activeAttemptId: null },
    { status: "ready", activeAttemptId: "attempt-1" },
    { status: "failed", activeAttemptId: "attempt-1" },
  ] as const)("rejects overlapping turns for $status/$activeAttemptId", (state) => {
    const thread = { ...runningThread(), ...state };
    const before = structuredClone(thread);
    const start = () => startChatQuestion(thread, {
      userMessageId: "message-user-2", attemptId: "attempt-2", question: "Another question",
      provider: "codex", model: "gpt-5", now: finishedAt,
    });
    expect(start).toThrow(ChatPolicyError);
    expect(start).toThrow("Chat thread thread-1 can run only one turn at a time (docs/product/desktop-managed-ai.md#accepted-ask-behavior). Complete or fail the active turn first.");
    expect(thread).toEqual(before);
  });

  test("restart marks a running attempt retryable without replay or duplicate user message", () => {
    const reconciled = reconcileChatAfterRestart(runningThread(), finishedAt);
    expect(reconciled).toMatchObject({ status: "failed", activeAttemptId: null });
    expect(reconciled.messages).toHaveLength(1);
    expect(reconciled.attempts).toMatchObject([{
      id: "attempt-1", status: "failed", failureReason: expect.stringMatching(/restart.*retry/i),
    }]);
  });

  test("snapshots the complete selection on the active attempt and on an explicit retry", () => {
    const selected = startChatQuestion(createMeetingChatThread({ id: "thread-1", meetingId: "meeting-1", now: startedAt }), {
      userMessageId: "message-user-1",
      attemptId: "attempt-1",
      question: "Question",
      selection: {
        provider: "codex",
        model: "gpt-5",
        modeId: "worker",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true, effort: "high" },
      },
      now: startedAt,
    });
    const failed = failChatAttempt(selected, { attemptId: "attempt-1", reason: "provider timeout", now: finishedAt });
    const retried = retryChatAttempt(failed, {
      attemptId: "attempt-2",
      selection: {
        provider: "claude",
        model: "sonnet",
        modeId: "build",
        thinkingOptionId: null,
        featureValues: { fast_mode: false },
      },
      now: "2026-08-20T10:00:02.000Z",
    });

    expect(retried.attempts[0]).toMatchObject({
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high",
      featureValues: { fast_mode: true, effort: "high" },
    });
    expect(retried.attempts[1]).toMatchObject({
      provider: "claude", model: "sonnet", modeId: "build", thinkingOptionId: null,
      featureValues: { fast_mode: false },
    });
  });
});
