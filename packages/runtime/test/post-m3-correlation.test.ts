import { describe, expect, test } from "vitest";
import {
  PostM3CorrelationError,
  validatePostM3Correlation,
  type PostM3CorrelationAuthority,
  type PostM3CorrelationObservation,
} from "../src/post-m3-correlation.js";

describe("post-M3 correlation validator", () => {
  test("accepts the complete authoritative chain", () => {
    expect(() => validatePostM3Correlation(observation(), authority())).not.toThrow();
  });

  test("rejects generic Electron identity with an actionable edge", () => {
    const candidate = observation();
    candidate.identity.logicalDesktopId = "com.github.Electron";
    expect(() => validatePostM3Correlation(candidate, authority())).toThrowError(
      /POST-M3 correlation failed at identity \(identity→renderer\).*com\.meetless\.desktop.*Next action/,
    );
  });

  test("rejects a wrong installed-host authority even when the marker looks valid", () => {
    const candidate = observation();
    const expected = authority();
    expected.hostCdHash = "b".repeat(40);
    expect(() => validatePostM3Correlation(candidate, expected)).toThrowError(
      /observed host identity differs from the installed assertInstalledHostIdentity authority/,
    );
  });

  test("rejects a URL-marked spoofed page without the trusted Meetless bridge", () => {
    const candidate = observation();
    candidate.renderer.bridge.desktopManaged = false;
    expect(() => validatePostM3Correlation(candidate, authority())).toThrowError(
      /trusted Meetless bridge\/runtime identity/,
    );
  });

  test("rejects socket identity copied from a spoofed marker", () => {
    const candidate = observation();
    candidate.socket.uiTest.runId = "spoofed-run";
    expect(() => validatePostM3Correlation(candidate, authority())).toThrowError(
      /runtime\.uiTest identity does not independently match/,
    );
  });

  test.each([
    ["renderer", (candidate: PostM3CorrelationObservation) => { candidate.renderer.runId = "wrong-run"; }, "renderer"],
    ["socket", (candidate: PostM3CorrelationObservation) => { candidate.socket.runId = "wrong-run"; }, "socket"],
    ["store", (candidate: PostM3CorrelationObservation) => { candidate.store.meetingId = "wrong-meeting"; }, "store"],
    ["helper", (candidate: PostM3CorrelationObservation) => { candidate.helper.recordingId = "wrong-recording"; }, "helper"],
    ["chunks", (candidate: PostM3CorrelationObservation) => { candidate.chunks.count = 0; }, "chunks"],
    ["mp3", (candidate: PostM3CorrelationObservation) => { candidate.mp3.sha256 = "b".repeat(64); }, "mp3"],
    ["transcription", (candidate: PostM3CorrelationObservation) => { candidate.transcription.status = "failed"; }, "transcription"],
  ] as const)("reports the missing %s edge at its exact stage", (_label, mutate, stage) => {
    const candidate = observation();
    mutate(candidate);
    expect(() => validatePostM3Correlation(candidate, authority())).toThrowError(
      new RegExp(`POST-M3 correlation failed at ${stage} .*Next action:`),
    );
  });

  test("exposes structured stage and edge fields for runbook diagnostics", () => {
    const candidate = observation();
    candidate.chunks.identities = [];
    try {
      validatePostM3Correlation(candidate, authority());
      throw new Error("expected validator failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PostM3CorrelationError);
      expect(error).toMatchObject({ stage: "chunks", edge: "helper→chunks" });
    }
  });
});

function authority(): PostM3CorrelationAuthority {
  return {
    hostBundleIdentifier: "com.meetless.app",
    hostBundlePath: "/Users/example/Applications/Meetless.app",
    hostCdHash: "a".repeat(40),
    runtimeRoot: "/tmp/runtime",
    listen: "127.0.0.1:6777",
    electronExecutable: "/Users/example/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  };
}

function observation(): PostM3CorrelationObservation {
  const expected = authority();
  const identity = {
    logicalDesktopId: "com.meetless.desktop",
    runId: "post-m3-run-1234",
    hostBundleIdentifier: "com.meetless.app",
    hostBundlePath: expected.hostBundlePath,
    hostCdHash: expected.hostCdHash,
    hostPid: 100,
    desktopPid: 101,
    electronPid: 102,
    electronExecutable: expected.electronExecutable,
    ancestry: [100, 101, 102],
    cdpAddress: "127.0.0.1",
    cdpPort: 45_321,
  };
  const savedOutput = { destination: "/tmp/meetings/r-1.mp3", byteLength: 321, sha256: "c".repeat(64) };
  return {
    identity,
    renderer: {
      runId: identity.runId,
      logicalDesktopId: identity.logicalDesktopId,
      url: "http://127.0.0.1:8082/?daemon=ws://127.0.0.1:6777/ws&uiTestRunId=post-m3-run-1234&uiTestDesktopId=com.meetless.desktop",
      title: "Meetless",
      titleEntered: true,
      startControlVisible: true,
      stopControlVisible: true,
      finalState: "saved",
      screenshotPath: "/tmp/post-m3.png",
      tracePath: "/tmp/post-m3.zip",
      bridge: {
        platform: "darwin",
        status: "running",
        home: "/tmp/runtime/paseo-home",
        listen: "127.0.0.1:6777",
        desktopManaged: true,
        pid: 150,
        serverId: "srv_test",
      },
    },
    socket: {
      runId: identity.runId,
      runtimeInstanceId: "runtime-1",
      pluginPid: 200,
      recordingId: "r-1",
      meetingId: "m-1",
      captureMode: "fixture",
      uiTest: {
        version: 1,
        logicalDesktopId: "com.meetless.desktop",
        hostBundleIdentifier: expected.hostBundleIdentifier,
        hostBundlePath: expected.hostBundlePath,
        hostCdHash: expected.hostCdHash,
        hostPid: 100,
        hostStartInstance: "host-start",
        desktopPid: 101,
        desktopStartInstance: "desktop-start",
        runId: identity.runId,
        cdpAddress: "127.0.0.1",
        cdpPort: 45_321,
        captureMode: "fixture",
        transcriptionMode: "fake",
        accessibility: "labels-only-controlled-runtime",
      },
      postStopStatus: "idle",
      statuses: [
        { status: "recording", recordingId: "r-1", meetingId: "m-1" },
        { status: "saved", recordingId: "r-1", meetingId: "m-1" },
        { status: "idle", recordingId: null, meetingId: null },
      ],
    },
    store: {
      meetingId: "m-1",
      recordingId: "r-1",
      title: "Post M3",
      recordingStatus: "saved",
      savedOutput,
      transcript: {
        meetingId: "m-1", recordingId: "r-1", status: "ready", audio: savedOutput,
        segments: [{ text: "hello", segmentId: "segment-1" }],
      },
    },
    helper: { pid: 300, pluginPid: 200, parentPid: 200, recordingId: "r-1", executable: "/tmp/helper", arguments: ["--fixture"] },
    chunks: {
      recordingId: "r-1", count: 2, microphoneCount: 1, systemCount: 1,
      identities: [
        { storageKey: "sessions/r-1/mic.wav", byteLength: 100, sha256: "d".repeat(64), source: "microphone" },
        { storageKey: "sessions/r-1/system.wav", byteLength: 100, sha256: "e".repeat(64), source: "system" },
      ],
    },
    mp3: { recordingId: "r-1", ...savedOutput },
    transcription: {
      mode: "fake", meetingId: "m-1", recordingId: "r-1", status: "ready", audio: savedOutput,
      segments: [{ text: "hello", segmentId: "segment-1" }],
    },
  };
}
