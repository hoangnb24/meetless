import { readFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptWire } from "@meetless/meeting-contracts";
import {
  clearsElectronTitlebarHitTest,
  ELECTRON_TITLEBAR_HIT_TEST_HEIGHT,
  MeetingListSurface,
  RecordingStrip,
  recordingStripPointerGeometry,
} from "../src/index.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("global recording strip", () => {
  test("clears desktop recording controls below the Electron titlebar hit-test region", async () => {
    const oldStripStyle = { minHeight: 64, paddingVertical: 9 };
    const controlHeight = 40;
    const oldControlTopY = oldStripStyle.paddingVertical;
    const oldControlCenterY = oldControlTopY + controlHeight / 2;
    expect(oldStripStyle).toEqual({ minHeight: 64, paddingVertical: 9 });
    expect(oldControlTopY).toBe(9);
    expect(oldControlCenterY).toBe(29);
    expect(clearsElectronTitlebarHitTest(oldControlCenterY)).toBe(false);

    expect(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT).toBe(29);
    const corrected = recordingStripPointerGeometry(ELECTRON_TITLEBAR_HIT_TEST_HEIGHT);
    expect(corrected).toEqual({ controlTopY: 38, controlCenterY: 58, stripMinHeight: 87 });
    expect(clearsElectronTitlebarHitTest(corrected.controlCenterY)).toBe(true);

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RecordingStrip
        elapsedMs={0} error="No valid committed media survived inventory reconciliation"
        onPause={async () => undefined} onResume={async () => undefined}
        onRetry={async () => undefined} onStart={async () => undefined} onStop={async () => undefined}
        pending={false} status={{ status: "failed", recordingId: "r-1", meetingId: "m-1", title: "Failed",
          elapsedMs: 0, paused: false, chunks: [], inventoryState: "pending", chunkCount: 0,
          microphoneCount: 0, systemCount: 0, inventoryDigest: null, retryEligible: false,
          outputPath: null, error: "No valid committed media survived inventory reconciliation" }} />);
    });
    expect(renderer!.root.findByProps({ testID: "global-recording-strip" }).props.style).toMatchObject({
      minHeight: 87,
      paddingTop: 38,
    });
    expect(renderer!.root.findByProps({ testID: "recording-error" }).props.children)
      .toBe("No valid committed media survived inventory reconciliation");
    renderer!.unmount();
  });

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

  test("renders durable chat, canonical insufficient evidence, and retry state", async () => {
    const onRetry = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false} compact connectionLabel="Connected" hostLabel="isolated host"
          meetings={[meeting("m-1")]} onRefresh={async () => undefined}
          selectedMeetingId="m-1" transcript={transcript("ready")} consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex" chatModel="gpt-5"
          chatThread={{
            meetingId: "m-1", status: "failed",
            messages: [
              { role: "user", text: "Unknown?", createdAt: "2026-08-21T00:00:00.000Z" },
              { role: "assistant", outcome: "insufficient_evidence", text: null, citations: [], createdAt: "2026-08-21T00:00:01.000Z" },
            ],
            selection: { provider: "codex", model: "gpt-5" },
            failure: { message: "provider timeout", retryable: true },
          }}
          onRetryQuestion={onRetry}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: "meeting-chat" })).toBeTruthy();
    expect(renderer!.root.findAllByType("Text").some((node) =>
      node.props.children === "The meeting does not contain enough evidence.")).toBe(true);
    await act(async () => { renderer!.root.findByProps({ testID: "chat-retry" }).props.onPress(); });
    expect(onRetry).toHaveBeenCalledOnce();
    renderer!.unmount();
  });

  test("submits a selected-model question and forwards only the chat citation identity", async () => {
    const onAsk = vi.fn(async () => undefined);
    const onCitation = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false} compact connectionLabel="Connected" hostLabel="isolated host"
          meetings={[meeting("m-1")]} onRefresh={async () => undefined}
          selectedMeetingId="m-1" transcript={transcript("ready")} consentStatus="granted"
          chatProviders={[{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }]}
          chatProvider="codex" chatModel="gpt-5" onAskQuestion={onAsk} onCitation={onCitation}
          chatThread={{
            meetingId: "m-1", status: "ready",
            messages: [{ role: "assistant", outcome: "supported", text: "Decision", citations: [{ meetingId: "m-1", segmentId: "segment-1" }], createdAt: "2026-08-21T00:00:01.000Z" }],
            selection: { provider: "codex", model: "gpt-5" }, failure: null,
          }}
        />,
      );
    });
    await act(async () => { renderer!.root.findByProps({ testID: "chat-question-input" }).props.onChangeText(" Next step? "); });
    await act(async () => { renderer!.root.findByProps({ testID: "chat-ask" }).props.onPress(); });
    expect(onAsk).toHaveBeenCalledWith("Next step?");
    await act(async () => { renderer!.root.findByProps({ testID: "chat-citation-segment-1" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-1" });
    renderer!.unmount();
  });
});

describe("responsive meeting sidebar and transcript detail", () => {
  test("proof scripts use the whole meeting row and ready transcript state", () => {
    const m1Proof = readFileSync(new URL("../../../scripts/prove-m1.mjs", import.meta.url), "utf8");
    expect(m1Proof).toContain('locator("xpath=ancestor::*[@data-testid and @role=\'button\']")');
    expect(m1Proof).toContain("meeting-row ancestor is absent");
    expect(m1Proof).toContain("meeting-row ancestor is ambiguous");
    expect(m1Proof).not.toContain('electronMeetingTitle.locator("..")');
    expect(m1Proof).not.toContain('webMeetingTitle.locator("..")');

    const postM3Proof = readFileSync(new URL("../../../scripts/prove-post-m3.mjs", import.meta.url), "utf8");
    expect(postM3Proof).toContain('const meetingRow = page.locator(`[data-testid="meeting-${storeSnapshot.meeting.id}"]`);');
    expect(postM3Proof).toContain('[data-testid="transcript-ready"]');
    expect(postM3Proof).not.toContain("meeting-transcript-${storeSnapshot.meeting.id}");
    expect(postM3Proof).not.toContain('[data-testid="transcript-panel"]');
  });

  test("uses the full meeting row for selection and marks the selected row", async () => {
    const onOpenTranscript = vi.fn(async () => undefined);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onOpenTranscript={onOpenTranscript}
          onRefresh={async () => undefined}
        />,
      );
    });

    const row = renderer!.root.findByProps({ testID: "meeting-m-1" });
    expect(row.props.accessibilityState).toEqual({ selected: false });
    expect(row.props["aria-selected"]).toBe(false);
    await act(async () => { row.props.onPress(); });
    expect(onOpenTranscript).toHaveBeenCalledWith("m-1");
    renderer!.unmount();

    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact={false}
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1"), meeting("m-2")]}
          onOpenTranscript={onOpenTranscript}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcript={transcript("ready")}
          consentStatus="granted"
        />,
      );
    });
    const selectedRow = renderer!.root.findByProps({ testID: "meeting-m-1" });
    const unselectedRow = renderer!.root.findByProps({ testID: "meeting-m-2" });
    expect(selectedRow.props.accessibilityState).toEqual({ selected: true });
    expect(selectedRow.props["aria-selected"]).toBe(true);
    expect(unselectedRow.props.accessibilityState).toEqual({ selected: false });
    expect(unselectedRow.props["aria-selected"]).toBe(false);
    expect(renderer!.root.findByProps({ testID: "meeting-sidebar-pane" }).props.style).toMatchObject({ width: 320 });
    expect(renderer!.root.findByProps({ testID: "meeting-detail-pane" }).props.style).toMatchObject({ flex: 1, minWidth: 400 });
    renderer!.unmount();
  });

  test("shows a Back control for compact detail", async () => {
    const onBack = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onBack={onBack}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcriptLoading
        />,
      );
    });

    const back = renderer!.root.findByProps({ testID: "meeting-detail-back" });
    await act(async () => { back.props.onPress(); });
    expect(onBack).toHaveBeenCalledOnce();
    expect(renderer!.root.findByProps({ testID: "transcript-loading" })).toBeTruthy();
    renderer!.unmount();
  });

  test.each([
    { name: "loading", props: { transcriptLoading: true }, state: "transcript-loading" },
    { name: "empty", props: {}, state: "transcript-empty" },
    { name: "processing", props: { transcript: transcript("transcribing") }, state: "transcript-processing" },
    { name: "failed", props: { transcript: transcript("failed") }, state: "transcript-failed" },
    { name: "fetch failure", props: { transcriptError: "transcript request failed" }, state: "transcript-failed" },
    { name: "invalid provider", props: { providerStatus: "invalid" as const }, state: "transcript-failed" },
  ])("renders an explicit $name transcript state without segments", async ({ props, state }) => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          consentStatus="granted"
          {...props}
        />,
      );
    });
    expect(renderer!.root.findByProps({ testID: state })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "transcript-segments" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-1" })).toHaveLength(0);
    renderer!.unmount();
  });

  test("renders every ready segment once and timestamp presses carry only stable identity", async () => {
    const onCitation = vi.fn(async () => undefined);
    const ready = transcript("ready");
    ready.segments.push({
      range: { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" },
      text: "second segment",
      completedAt: "2026-08-18T10:00:01.000Z",
      detectedLanguages: ["en"],
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MeetingListSurface
          canCreate={false}
          compact
          connectionLabel="Connected"
          hostLabel="isolated host"
          meetings={[meeting("m-1")]}
          onCitation={onCitation}
          onRefresh={async () => undefined}
          selectedMeetingId="m-1"
          transcript={ready}
          consentStatus="granted"
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-1" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ testID: "transcript-segment-segment-2" })).toHaveLength(1);
    await act(async () => { renderer!.root.findByProps({ testID: "citation-segment-2" }).props.onPress(); });
    expect(onCitation).toHaveBeenCalledWith({ meetingId: "m-1", segmentId: "segment-2" });
    expect(Object.keys(onCitation.mock.calls[0]![0] as object).sort()).toEqual(["meetingId", "segmentId"]);
    renderer!.unmount();
  });
});

function meeting(id: string) {
  return { id, title: id, status: "ready" as const, createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z" };
}

function transcript(status: TranscriptWire["status"]): TranscriptWire {
  const range = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" };
  return {
    id: "t-1",
    meetingId: "m-1",
    recordingId: "r-1",
    status,
    plannerVersion: "m3-range-v1",
    audioDurationMs: 2_000,
    ranges: [range, { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" }],
    segments: [{ range, text: "first segment", completedAt: "2026-08-18T10:00:00.000Z", detectedLanguages: ["en"] }],
    requestCount: 1,
    usage: null,
    detectedLanguages: ["en"],
    failureReason: status === "failed" ? "provider failed" : null,
  };
}
