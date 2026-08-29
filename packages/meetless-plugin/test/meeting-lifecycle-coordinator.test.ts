import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import { describe, expect, test } from "vitest";
import {
  MeetingLifecycleCoordinator,
  type MeetingWorkKind,
} from "../src/meeting-lifecycle-coordinator.js";

describe("meeting lifecycle coordinator", () => {
  test.each([
    ["delayed recovery registration", "active_capture"],
    ["finalization", "finalization"],
    ["transcription startup", "transcription"],
    ["Ask startup", "ask"],
  ] as const)("serializes delete against %s so exactly one side wins", (_label, kind: MeetingWorkKind) => {
    const workFirst = new MeetingLifecycleCoordinator();
    const work = workFirst.tryAcquireWork("m-1", kind);
    expect(work).not.toBeNull();
    expect(workFirst.tryAcquireDeletion("m-1")).toEqual({ acquired: false, active: [kind] });
    work!.release();
    expect(workFirst.tryAcquireDeletion("m-1")).toMatchObject({ acquired: true });

    const deleteFirst = new MeetingLifecycleCoordinator();
    const deletion = deleteFirst.tryAcquireDeletion("m-1");
    expect(deletion).toMatchObject({ acquired: true });
    expect(deleteFirst.tryAcquireWork("m-1", kind)).toBeNull();
    if (deletion.acquired) deletion.lease.release();
    expect(deleteFirst.tryAcquireWork("m-1", kind)).not.toBeNull();
  });

  test("does not serialize unrelated meetings", () => {
    const coordinator = new MeetingLifecycleCoordinator();
    const deletion = coordinator.tryAcquireDeletion("m-delete");
    expect(deletion).toMatchObject({ acquired: true });
    expect(coordinator.tryAcquireWork("m-other", "ask")).not.toBeNull();
  });

  test.each([
    "active_capture", "finalization", "transcription", "ask",
  ] as const)("durable defense prevents late %s work from recreating a deletion winner", async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-lifecycle-race-"));
    try {
      const store = new MeetingStore({ root });
      await store.create({ id: "m-race", title: "Race" });
      const coordinator = new MeetingLifecycleCoordinator();
      const deletion = coordinator.tryAcquireDeletion("m-race");
      expect(deletion).toMatchObject({ acquired: true });
      await expect(store.deleteMeeting("m-race")).resolves.toMatchObject({ outcome: "deleted" });
      if (deletion.acquired) deletion.lease.release();

      const lateWork = coordinator.tryAcquireWork("m-race", kind);
      expect(lateWork).not.toBeNull();
      await expect(store.transition("m-race", "archived")).rejects.toThrow("Meeting not found");
      lateWork!.release();
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
