import { describe, expect, test } from "vitest";
import {
  createMeeting,
  InvalidMeetingTransitionError,
  transitionMeeting,
} from "../src/index.js";

describe("meeting lifecycle", () => {
  test("creates a plain draft and follows the accepted lifecycle", () => {
    const draft = createMeeting({ id: "m-1", title: "Design sync", now: "2026-08-16T10:00:00.000Z" });
    const recording = transitionMeeting(draft, "recording", "2026-08-16T10:01:00.000Z");
    const processing = transitionMeeting(recording, "processing", "2026-08-16T11:00:00.000Z");
    const ready = transitionMeeting(processing, "ready", "2026-08-16T11:05:00.000Z");
    const archived = transitionMeeting(ready, "archived", "2026-08-17T08:00:00.000Z");

    expect(draft.status).toBe("draft");
    expect(archived.status).toBe("archived");
    expect(archived.createdAt).toBe(draft.createdAt);
  });

  test("rejects a transition that skips policy state", () => {
    const draft = createMeeting({ id: "m-1", title: "Design sync", now: "2026-08-16T10:00:00.000Z" });
    expect(() => transitionMeeting(draft, "ready", "2026-08-16T10:01:00.000Z")).toThrow(
      InvalidMeetingTransitionError,
    );
    expect(draft.status).toBe("draft");
  });
});
