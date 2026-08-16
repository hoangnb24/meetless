import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import { access } from "node:fs/promises";
import { RecordingService } from "./recording-service.js";
import { RecordingControlServer } from "./control-server.js";

let store: MeetingStore | null = null;
let recordingService: RecordingService | null = null;
let controlServer: RecordingControlServer | null = null;
let recordingStart: Promise<void> | null = null;

export function getMeetingStore(): MeetingStore {
  if (store) return store;
  const configuredRoot = process.env.MEETLESS_STORE_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      "MEETLESS_STORE_ROOT must be an absolute isolated path fixed by the Meetless launcher",
    );
  }
  store = new MeetingStore({ root: configuredRoot });
  return store;
}

export async function startRecordingRuntime(): Promise<void> {
  if (recordingService || controlServer) return;
  if (recordingStart) return recordingStart;
  recordingStart = startRecordingRuntimeOnce();
  try { await recordingStart; } finally { recordingStart = null; }
}

async function startRecordingRuntimeOnce(): Promise<void> {
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const helperPath = requiredAbsolute("MEETLESS_CAPTURE_HELPER");
  const ffmpeg = requiredAbsolute("MEETLESS_FFMPEG");
  const ffprobe = requiredAbsolute("MEETLESS_FFPROBE");
  const exportRoot = requiredAbsolute("MEETLESS_EXPORT_ROOT");
  const socketPath = requiredAbsolute("MEETLESS_RECORDING_SOCKET");
  await Promise.all([access(helperPath), access(ffmpeg), access(ffprobe)]);
  const fixedStamp = process.env.MEETLESS_FIXTURE_EXPORT_STAMP?.trim();
  const service = new RecordingService({
    storeRoot, helperPath, ffmpeg, ffprobe, exportRoot,
    fixture: process.env.MEETLESS_CAPTURE_MODE === "fixture",
    exportNow: fixedStamp ? () => new Date(fixedStamp) : undefined,
    failFinalizationOnce: process.env.MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE === "1",
  }, getMeetingStore());
  const server = new RecordingControlServer(socketPath, service);
  await service.initialize();
  await server.start();
  recordingService = service;
  controlServer = server;
}

export async function stopRecordingRuntime(): Promise<void> {
  const server = controlServer; const service = recordingService;
  controlServer = null; recordingService = null;
  await server?.close();
  await service?.shutdown();
}

export function recordingRuntimeForTest(): RecordingService | null { return recordingService; }

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path fixed by the Meetless launcher`);
  return path.resolve(value);
}
