import type { PluginContext } from "@paseo/plugin";
import {
  MeetingChatAskRpc,
  MeetingChatAskV1Rpc,
  MeetingChatControlsRpc,
  MeetingChatFeaturesRpc,
  MeetingChatGetRpc,
  MeetingChatProvidersRpc,
  MeetingChatRetryRpc,
  MeetingChatRetryV1Rpc,
  MeetingChatSelectionRpc,
  MeetingCitationResolveRpc,
  MeetingCreateRpc,
  MeetingDeleteRpc,
  MeetingListRpc,
  MeetingPremiumPurchaseRpc,
  MeetingPremiumRestoreRpc,
  MeetingPremiumStatusRpc,
  MeetingManagedDeviceRevokeRpc,
  MeetingManagedDevicesRpc,
  MeetingTranscriptRpc,
  MeetingTranscriptionConsentRpc,
} from "@meetless/meeting-contracts";
import { RecordingRuntimeBootstrapRpc } from "./src/readiness-protocol.js";

export default function contribute(plugin: PluginContext) {
  let cleanup: (() => Promise<void>) | null = null;
  let chatCleanup: (() => Promise<void>) | null = null;
  plugin.handle(MeetingCreateRpc, async ({ title }) => {
    const server = await import("./src/server.js");
    return server.getMeetingStore().create({ title });
  });
  plugin.handle(MeetingListRpc, async () => {
    const server = await import("./src/server.js");
    return { meetings: await server.getMeetingStore().list() };
  });
  plugin.handle(MeetingDeleteRpc, async ({ meetingId }) => {
    const server = await import("./src/server.js");
    return server.deleteMeeting(meetingId);
  });
  plugin.handle(MeetingTranscriptRpc, async ({ meetingId }) => {
    const server = await import("./src/server.js");
    const meeting = (await server.getMeetingStore().list()).find((candidate) => candidate.id === meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    const transcript = await server.getMeetingStore().getTranscriptForMeeting(meetingId);
    const consent = await server.getMeetingStore().transcriptionConsent();
    return {
      meeting,
      transcript: transcript ? toTranscriptWire(transcript) : null,
      consent,
      provider: { status: await server.transcriptionProviderStatus() },
    };
  });
  plugin.handle(MeetingTranscriptionConsentRpc, async () => {
    const server = await import("./src/server.js");
    const consent = await server.grantTranscriptionConsent();
    return { consent, provider: { status: await server.transcriptionProviderStatus() } };
  });
  plugin.handle(MeetingCitationResolveRpc, async ({ meetingId, segmentId }) => {
    const server = await import("./src/server.js");
    return server.getCitationPlaybackService().resolve({ meetingId, segmentId });
  });
  plugin.handle(MeetingPremiumStatusRpc, async () => {
    const server = await import("./src/server.js");
    return server.getPremiumService().status();
  });
  plugin.handle(MeetingPremiumPurchaseRpc, async ({ packageId }) => {
    const server = await import("./src/server.js");
    return server.getPremiumService().purchase(packageId);
  });
  plugin.handle(MeetingPremiumRestoreRpc, async () => {
    const server = await import("./src/server.js");
    return server.getPremiumService().restore();
  });
  plugin.handle(MeetingManagedDevicesRpc, async () => {
    const server = await import("./src/server.js");
    return { devices: await server.listManagedDevices() };
  });
  plugin.handle(MeetingManagedDeviceRevokeRpc, async ({ deviceId }) => {
    const server = await import("./src/server.js");
    return server.revokeManagedDevice(deviceId);
  });
  plugin.handle(MeetingChatProvidersRpc, async (_input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return {
      providers: await (await server.getMeetingChatService(paseo)).providers(),
      compatibilityCheck: "on_question_start" as const,
    };
  });
  plugin.handle(MeetingChatControlsRpc, async (_input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).controls();
  });
  plugin.handle(MeetingChatFeaturesRpc, async ({ selection }, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).features(selection);
  });
  plugin.handle(MeetingChatSelectionRpc, async ({ selection }, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).select(selection);
  });
  plugin.handle(MeetingChatGetRpc, async ({ meetingId }, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return { thread: await (await server.getMeetingChatService(paseo)).get(meetingId) };
  });
  plugin.handle(MeetingChatAskRpc, async (input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).ask(input);
  });
  plugin.handle(MeetingChatRetryRpc, async (input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).retry(input);
  });
  plugin.handle(MeetingChatAskV1Rpc, async (input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).askWithSelection(input);
  });
  plugin.handle(MeetingChatRetryV1Rpc, async (input, { paseo }) => {
    const server = await import("./src/server.js");
    chatCleanup = server.stopMeetingChatService;
    return (await server.getMeetingChatService(paseo)).retryWithSelection(input);
  });
  plugin.handle(RecordingRuntimeBootstrapRpc, async ({ nonce, deadlineEpochMs }) => {
    const server = await import("./src/server.js");
    await server.startRecordingRuntime(deadlineEpochMs);
    cleanup = server.stopRecordingRuntime;
    const identity = server.recordingRuntimeIdentity();
    return { nonce, runtimeInstanceId: identity.instanceId, pluginPid: process.pid };
  });
  return async () => {
    await chatCleanup?.();
    await cleanup?.();
  };
}

function toTranscriptWire(transcript: import("@meetless/meeting-domain").TranscriptState) {
  return {
    id: transcript.id,
    meetingId: transcript.meetingId,
    recordingId: transcript.recordingId,
    status: transcript.status,
    plannerVersion: transcript.plannerVersion,
    audioDurationMs: transcript.audio.durationMs,
    ranges: transcript.ranges,
    segments: transcript.checkpoints.map((checkpoint) => ({
      range: checkpoint.range,
      text: checkpoint.text,
      completedAt: checkpoint.completedAt,
      detectedLanguages: checkpoint.detectedLanguages,
    })),
    requestCount: transcript.requestCount,
    usage: transcript.usage,
    detectedLanguages: transcript.detectedLanguages,
    failureReason: transcript.failureReason,
  };
}
