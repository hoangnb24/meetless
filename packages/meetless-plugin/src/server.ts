import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import { RecordingService } from "./recording-service.js";
import { RecordingControlServer } from "./control-server.js";

let store: MeetingStore | null = null;
let recordingService: RecordingService | null = null;
let controlServer: RecordingControlServer | null = null;
let recordingStart: Promise<void> | null = null;
let runtimeIdentity: { instanceId: string; startedAt: string } | null = null;

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

export async function startRecordingRuntime(deadlineEpochMs = Number.POSITIVE_INFINITY): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  if (recordingService || controlServer) return;
  if (recordingStart) {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
    return;
  }
  recordingStart = startRecordingRuntimeOnce(deadlineEpochMs);
  try {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
  } catch (error) {
    if (Date.now() >= deadlineEpochMs) await stopRecordingRuntime();
    throw error;
  } finally {
    recordingStart = null;
  }
}

async function startRecordingRuntimeOnce(deadlineEpochMs: number): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const helperPath = requiredAbsolute("MEETLESS_CAPTURE_HELPER");
  const ffmpeg = requiredAbsolute("MEETLESS_FFMPEG");
  const ffprobe = requiredAbsolute("MEETLESS_FFPROBE");
  const exportRoot = requiredAbsolute("MEETLESS_EXPORT_ROOT");
  const socketPath = requiredAbsolute("MEETLESS_RECORDING_SOCKET");
  await Promise.all([access(helperPath), access(ffmpeg), access(ffprobe)]);
  const fixedStamp = process.env.MEETLESS_FIXTURE_EXPORT_STAMP?.trim();
  const fixture = process.env.MEETLESS_CAPTURE_MODE === "fixture";
  const fixtureExportNow = resolveFixtureExportNow(fixture, fixedStamp);
  const service = new RecordingService({
    storeRoot, helperPath, ffmpeg, ffprobe, exportRoot,
    fixture,
    exportNow: fixtureExportNow,
    fixtureStampApplied: fixtureExportNow !== undefined,
    failFinalizationOnce: process.env.MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE === "1",
  }, getMeetingStore());
  const identity = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const server = new RecordingControlServer(socketPath, service, identity);
  try {
    await service.initialize();
    assertBootstrapDeadline(deadlineEpochMs);
    await server.start();
    assertBootstrapDeadline(deadlineEpochMs);
    recordingService = service;
    controlServer = server;
    runtimeIdentity = identity;
  } catch (error) {
    await server.close().catch(() => undefined);
    await service.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function stopRecordingRuntime(): Promise<void> {
  const server = controlServer; const service = recordingService;
  controlServer = null; recordingService = null;
  runtimeIdentity = null;
  await server?.close();
  await service?.shutdown();
}

export function recordingRuntimeForTest(): RecordingService | null { return recordingService; }

export function recordingRuntimeIdentity(): { instanceId: string; startedAt: string } {
  if (!runtimeIdentity) throw new Error("Meetless recording runtime is not active");
  return runtimeIdentity;
}

export function resolveFixtureExportNow(fixture: boolean, fixedStamp: string | undefined): (() => Date) | undefined {
  return fixture && fixedStamp ? () => new Date(fixedStamp) : undefined;
}

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path fixed by the Meetless launcher`);
  return path.resolve(value);
}

function assertBootstrapDeadline(deadlineEpochMs: number): void {
  if (Date.now() >= deadlineEpochMs) {
    throw new Error("Meetless recording runtime bootstrap exceeded the launcher startup deadline");
  }
}
