import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginContext } from "@paseo/plugin";
import { MeetingStore } from "@meetless/meeting-store";
import contribute from "../index.js";
import { deleteMeetingBeforeRecordingBootstrap, deleteMeetingSafely } from "../src/server.js";

describe("Meetless plugin contribution", () => {
  test("publishes meeting and non-mutating readiness bootstrap without exposing recording control RPC", async () => {
    const handle = vi.fn();
    const addSurface = vi.fn();
    const addSidebarItem = vi.fn();
    const cleanup = contribute({ handle, addSurface, addSidebarItem } as unknown as PluginContext);

    expect(handle.mock.calls.map(([rpc]) => rpc.name)).toEqual([
      "meeting.create",
      "meeting.list",
      "meeting.delete",
      "meeting.transcript",
      "meeting.transcription.consent",
      "meeting.citation.resolve",
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
