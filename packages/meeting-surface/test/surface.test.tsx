import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { MeetingListSurface, RecordingStrip } from "../src/index.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("global recording strip", () => {
  test("renders authoritative recoverable retry state independently of meeting-list content", async () => {
    const retry = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={12_000}
        error="encoder interrupted"
        onPause={async () => undefined}
        onResume={async () => undefined}
        onRetry={retry}
        onStart={async () => undefined}
        onStop={async () => undefined}
        pending={false}
        status={{ status: "recoverable", recordingId: "r-1", meetingId: "m-1", title: "Sync", elapsedMs: 12_000, paused: false, chunks: [],
          inventoryState: "complete", chunkCount: 2, microphoneCount: 1, systemCount: 1,
          inventoryDigest: "digest", retryEligible: true, outputPath: null, error: "encoder interrupted" }}
      />);
    });
    const button = renderer!.root.findByProps({ testID: "recording-retry" });
    await act(async () => { button.props.onPress(); });
    expect(retry).toHaveBeenCalledOnce();
    renderer!.unmount();
  });

  test("hides Retry while inventory reconciliation is incomplete", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={12_000} error={null} onPause={async () => undefined} onResume={async () => undefined}
        onRetry={async () => undefined} onStart={async () => undefined} onStop={async () => undefined}
        pending={false} status={{ status: "recoverable", recordingId: "r-1", meetingId: "m-1", title: "Sync",
          elapsedMs: 12_000, paused: false, chunks: [], inventoryState: "scanning", chunkCount: 20_136,
          microphoneCount: 12_926, systemCount: 7_210, inventoryDigest: null, retryEligible: false,
          outputPath: null, error: null }} />);
    });
    expect(renderer!.root.findAllByProps({ testID: "recording-retry" })).toHaveLength(0);
    renderer!.unmount();
  });
});

describe("companion meeting surface", () => {
  test("has no create controls and cannot invoke meeting creation", async () => {
    const onCreate = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[]}
          onCreate={onCreate}
          onRefresh={async () => undefined}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: "desktop-create-controls" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "meeting-create-button" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ testID: "companion-read-only" })).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    renderer!.unmount();
  });

  test("passes only the stable segment citation identity to the playback path", async () => {
    const onCitation = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[{ id: "m-1", title: "Sync", status: "ready", createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" }]}
          onRefresh={async () => undefined}
          onCitation={onCitation}
          selectedMeetingId="m-1"
          consentStatus="granted"
          providerStatus="configured"
          transcript={{
            id: "t-1", meetingId: "m-1", recordingId: "r-1", status: "ready", plannerVersion: "m3-range-v1",
            audioDurationMs: 1_000,
            ranges: [{ ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" }],
            segments: [{ range: { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" }, text: "hello", completedAt: "2026-08-18T10:00:00.000Z", detectedLanguages: ["en"] }],
            requestCount: 1, usage: null, detectedLanguages: ["en"], failureReason: null,
          }}
        />,
      );
    });
    await act(async () => { renderer!.root.findByProps({ testID: "citation-segment-1" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-1" });
    renderer!.unmount();
  });
});
