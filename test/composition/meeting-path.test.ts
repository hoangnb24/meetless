import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MeetingWire } from "@meetless/meeting-contracts";
import { MeetingListSurface } from "../../packages/meeting-surface/src/index.js";
import { RecordingService } from "../../packages/meetless-plugin/src/recording-service.js";

let recordingService: RecordingService | null = null;
let runtimeRoot: string | null = null;

afterEach(async () => {
  if (recordingService) {
    await recordingService.shutdown();
    recordingService = null;
  }
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("recording-owned meeting composition", () => {
  test("Record setup starts the recording-owned meeting and renders its persisted identity", async () => {
    runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-composition-"));
    const config = {
      storeRoot: path.join(runtimeRoot, "store"),
      helperPath: path.resolve("native/macos-capture/.build/release/meetless-capture"),
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      ffprobe: "/opt/homebrew/bin/ffprobe",
      exportRoot: path.join(runtimeRoot, "Documents", "meetings"),
      fixture: true,
      exportNow: () => new Date("2026-08-17T12:00:00+07:00"),
    };
    recordingService = new RecordingService(config);
    await recordingService.initialize();

    let started!: Awaited<ReturnType<RecordingService["execute"]>>;
    let meetings: MeetingWire[] = [];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        React.createElement(MeetingListSurface, {
          layoutTier: "desktop",
          canRecord: true,
          connectionLabel: "Host online",
          hostConnectionStatus: "online",
          hostLabel: "this host",
          meetings,
          onRefresh: async () => undefined,
          recordingSetup: {
            available: true,
            pending: false,
            error: null,
            onStart: async (title: string) => {
              started = await recordingService!.execute({
                version: 1,
                requestId: "record-button-start",
                command: "start",
                title,
              });
              meetings = await recordingService!.store.list();
            },
          },
        }),
      );
    });

    await act(async () => { renderer.root.findByProps({ testID: "record-meeting-entry" }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ testID: "recording-setup-title" }).props.onChangeText("  Composition proof  "); });
    await act(async () => { await renderer.root.findByProps({ testID: "recording-start" }).props.onPress(); });
    await vi.waitFor(() => expect(started).toBeDefined(), { timeout: 20_000 });

    expect(started).toMatchObject({ status: "recording", title: "Composition proof" });
    const created = meetings.find((meeting) => meeting.id === started.meetingId);
    expect(created).toMatchObject({ id: started.meetingId, title: "Composition proof" });
    await act(async () => {
      renderer.update(
        React.createElement(MeetingListSurface, {
          layoutTier: "desktop",
          canRecord: true,
          connectionLabel: "Host online",
          hostConnectionStatus: "online",
          hostLabel: "this host",
          meetings,
          onRefresh: async () => undefined,
          recordingSetup: { available: false, pending: false, error: null, onStart: async () => undefined },
        }),
      );
    });
    expect(renderer.root.findByProps({ testID: `meeting-${started.meetingId}` })).toBeTruthy();
    expect(renderer.root.findAllByType("Text").some((node) => node.props.children === "Composition proof")).toBe(true);

    const persisted = JSON.parse(
      await readFile(path.join(config.storeRoot, "meetings.json"), "utf8"),
    ) as { meetings: Array<{ id: string; title: string }> };
    expect(persisted.meetings).toContainEqual(expect.objectContaining({ id: started.meetingId, title: "Composition proof" }));

    await recordingService.execute({ version: 1, requestId: "record-button-stop", command: "stop" });
    renderer.unmount();
  }, 30_000);
});
