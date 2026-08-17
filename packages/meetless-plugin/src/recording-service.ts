import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import { recordingElapsedMs, type CommittedRecordingChunk, type RecordingSession } from "@meetless/meeting-domain";
import type { RecordingControlRequest, RecordingStatusWire } from "@meetless/meeting-contracts";
import { CaptureHelper } from "./capture-helper.js";
import { fileIdentity, Mp3Finalizer } from "./finalizer.js";
import { validateCommittedWavChunk } from "./chunk-validator.js";
import type { CollisionEvidence } from "./readiness-protocol.js";

export interface RecordingServiceConfig {
  storeRoot: string;
  helperPath: string;
  ffmpeg: string;
  ffprobe: string;
  exportRoot: string;
  fixture: boolean;
  helperArguments?: string[];
  exportNow?: () => Date;
  fixtureStampApplied?: boolean;
  failFinalizationOnce?: boolean;
  authorizeProductionStart?: () => Promise<void>;
}

export class RecordingService {
  readonly store: MeetingStore;
  private readonly finalizer: Mp3Finalizer;
  private helper: CaptureHelper | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(status: RecordingStatusWire) => void>();
  private failFinalizationOnce: boolean;
  private shuttingDown = false;
  private preparedCollision: CollisionEvidence | null = null;

  constructor(readonly config: RecordingServiceConfig, store?: MeetingStore) {
    this.store = store ?? new MeetingStore({ root: config.storeRoot });
    this.finalizer = new Mp3Finalizer({
      ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, exportRoot: config.exportRoot, storeRoot: config.storeRoot,
    });
    this.failFinalizationOnce = config.failFinalizationOnce === true;
  }

  subscribe(listener: (status: RecordingStatusWire) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await mkdir(path.join(this.config.storeRoot, "sessions"), { recursive: true, mode: 0o700 });
    const recordings = await this.store.listRecordings();
    for (const recording of recordings) await this.recoverRecording(recording);
    await this.emitStatus();
  }

  execute(request: RecordingControlRequest): Promise<RecordingStatusWire> {
    return this.serialize(async () => {
      switch (request.command) {
        case "start": await this.start(request.title!); break;
        case "pause": await this.pause(); break;
        case "resume": await this.resume(); break;
        case "stop": await this.stop(); break;
        case "retryFinalization": await this.retryFinalization(); break;
        case "status": break;
      }
      const status = await this.status();
      this.notify(status);
      return status;
    });
  }

  async status(): Promise<RecordingStatusWire> {
    const [recordings, meetings] = await Promise.all([this.store.listRecordings(), this.store.list()]);
    const recording = selectCurrentRecording(recordings);
    if (!recording) return idleStatus();
    const meeting = meetings.find((candidate) => candidate.id === recording.meetingId);
    return {
      status: recording.status,
      recordingId: recording.id,
      meetingId: recording.meetingId,
      title: meeting?.title ?? "Recovered meeting",
      elapsedMs: recording.status === "recording" ? recordingElapsedMs(recording, new Date().toISOString()) : recording.elapsedMs,
      paused: recording.status === "recording" && recording.activeSince === null,
      chunks: recording.chunks,
      outputPath: recording.savedOutput?.destination ?? recording.finalization?.publishIntent.destination ?? null,
      error: recording.failureReason ?? recording.interruption?.reason ?? null,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.helper?.terminate();
    this.helper = null;
    await this.serialize(async () => {
      const current = await this.status();
      if (current.status === "recording" && current.recordingId) {
        await this.interruptAndAssess(current.recordingId, "Meetless runtime shutdown interrupted active capture");
        await this.emitStatus();
      }
    });
  }

  helperRuntime(): { pid: number | null; executable: string; arguments: string[] } {
    return {
      pid: this.helper?.pid ?? null,
      executable: this.helper?.executable ?? this.config.helperPath,
      arguments: [...(this.helper?.arguments ?? this.config.helperArguments ?? (this.config.fixture ? ["--fixture"] : []))],
    };
  }

  prepareCollisionEvidence(runtimeInstanceId: string, now = this.config.exportNow?.() ?? new Date()): Promise<CollisionEvidence> {
    return this.serialize(async () => {
      const recording = await this.requireCurrent("recording");
      if (!this.helper) throw new Error("Capture helper is unavailable");
      if (
        this.preparedCollision?.recordingId === recording.id &&
        this.preparedCollision.runtimeInstanceId === runtimeInstanceId
      ) {
        await this.validatePreparedCollision(recording.id, runtimeInstanceId);
        return this.preparedCollision;
      }
      this.preparedCollision = await this.finalizer.prepareCollisionEvidence({
        recordingId: recording.id,
        runtimeInstanceId,
        now,
      });
      return this.preparedCollision;
    });
  }

  validateCollisionEvidence(runtimeInstanceId: string): Promise<CollisionEvidence> {
    return this.serialize(async () => {
      const recording = await this.requireCurrent("recording");
      return this.validatePreparedCollision(recording.id, runtimeInstanceId);
    });
  }

  private async start(title: string): Promise<void> {
    if (this.helper) throw new Error("A capture helper is already supervised");
    const unresolved = unresolvedRecordings(await this.store.listRecordings());
    if (unresolved.length > 0) {
      throw new Error(
        `Resolve recording ${unresolved[0]!.id} (${unresolved[0]!.status}) before starting another (docs/product/recording.md)`,
      );
    }
    await this.authorizeProductionStart();
    const meeting = await this.store.create({ title });
    const recording = await this.store.startRecording({ meetingId: meeting.id });
    const sessionDirectory = path.join(this.config.storeRoot, "sessions", recording.id);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    try {
      await this.authorizeProductionStart();
      const helper = new CaptureHelper({
        executable: this.config.helperPath,
        sessionDirectory,
        storeRoot: this.config.storeRoot,
        fixture: this.config.fixture,
        arguments: this.config.helperArguments,
        onChunk: (chunk) => this.store.commitChunk(recording.id, chunk).then(() => this.emitStatus()),
        onFailure: (reason) => this.handleHelperFailure(recording.id, reason),
        onDiagnostic: (line) => process.stderr.write(`[meetless-capture] ${line}\n`),
      });
      this.helper = helper;
      await helper.start();
    }
    catch (error) {
      this.helper = null;
      await this.interruptAndAssess(recording.id, `capture start failed: ${describe(error)}`);
      throw error;
    }
  }

  private async authorizeProductionStart(): Promise<void> {
    if (this.config.fixture) return;
    if (!this.config.authorizeProductionStart) {
      throw new Error(
        "Production recording start rejected before helper spawn: MeetlessHost provenance is unavailable. " +
        "Authority: docs/plans/active/v1-paseo-foundation.md. Next action: launch with npm run runtime:host.",
      );
    }
    await this.config.authorizeProductionStart();
  }

  private async pause(): Promise<void> {
    const recording = await this.requireCurrent("recording");
    if (recording.activeSince === null) throw new Error("Recording is already paused");
    if (!this.helper) throw new Error("Capture helper is unavailable");
    await this.helper.pause();
    await this.store.pauseRecording(recording.id, true);
  }

  private async resume(): Promise<void> {
    const recording = await this.requireCurrent("recording");
    if (recording.activeSince !== null) throw new Error("Recording is not paused");
    if (!this.helper) throw new Error("Capture helper is unavailable");
    await this.helper.resume(recording.elapsedMs);
    await this.store.resumeRecording(recording.id);
  }

  private async stop(): Promise<void> {
    const recording = await this.requireCurrent("recording");
    if (!this.helper) throw new Error("Capture helper is unavailable");
    const prepared = this.preparedCollision
      ? await this.validatePreparedCollision(recording.id, this.preparedCollision.runtimeInstanceId)
      : null;
    await this.helper.stop();
    this.helper = null;
    const closed = await this.findRecording(recording.id);
    await this.stageBeginAndPublish(closed, prepared?.plannedPublishedPath);
  }

  private async retryFinalization(): Promise<void> {
    const recording = await this.requireCurrent("recoverable", "finalizing");
    if (!recording.finalization) {
      await this.stageBeginAndPublish(recording);
      return;
    }
    await this.store.retryFinalization(recording.id);
    const staged = await this.finalizer.stage(recording.id, recording.chunks);
    if (!sameIdentity(staged.identity, recording.finalization.publishIntent.expectedIdentity)) {
      await rm(staged.stagePath, { force: true });
      await this.interruptAndAssess(recording.id, "retry output identity changed");
      throw new Error("Retry output identity changed; original chunks were preserved");
    }
    await this.publishOutput(recording.id, staged.stagePath);
  }

  private async stageBeginAndPublish(recording: RecordingSession, preparedDestination?: string): Promise<void> {
    const staged = await this.finalizer.stage(recording.id, recording.chunks);
    const destination = preparedDestination ?? await this.finalizer.nextDestination(this.config.exportNow?.() ?? new Date());
    const digest = chunkSetDigest(recording.chunks);
    await this.store.beginFinalization(recording.id, {
      openChunksDurablyClosed: true,
      chunkSetDigest: digest,
      destination,
      expectedIdentity: staged.identity,
    });
    if (this.preparedCollision?.recordingId === recording.id) {
      this.preparedCollision = null;
    }
    if (this.failFinalizationOnce) {
      this.failFinalizationOnce = false;
      await rm(staged.stagePath, { force: true });
      await this.interruptAndAssess(recording.id, "injected finalization interruption");
      throw new Error("Injected finalization interruption; retry without re-recording");
    }
    await this.publishOutput(recording.id, staged.stagePath);
  }

  private async publishOutput(recordingId: string, stagePath: string): Promise<void> {
    for (let attempt = 1; attempt < 10_000; attempt += 1) {
      let recording = await this.findRecording(recordingId);
      const intent = recording.finalization?.publishIntent;
      if (!intent) throw new Error("Publication requires durable intent");
      try {
        await this.finalizer.publishNoReplace(stagePath, intent.destination);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const existingIdentity = await fileIdentity(intent.destination);
        const readable = await this.finalizer.verify(intent.destination).then(() => true, () => false);
        const next = await this.finalizer.nextDestination(this.config.exportNow?.() ?? new Date(), attempt + 1);
        const reconciliation = await this.store.reconcilePublish(recordingId, {
          existingOutput: existingIdentity, existingOutputReadable: readable, nextDestination: next,
        });
        if (reconciliation.action === "adopt") {
          await rm(stagePath, { force: true });
          await this.finishSaved(reconciliation.recording);
          return;
        }
        continue;
      }
      recording = await this.findRecording(recordingId);
      await this.finishSaved(recording);
      return;
    }
    throw new Error("Exhausted collision-safe recording destinations");
  }

  private async finishSaved(recording: RecordingSession): Promise<void> {
    const intent = recording.finalization!.publishIntent;
    const verified = await this.finalizer.verify(intent.destination);
    if (!sameIdentity(verified.identity, intent.expectedIdentity)) throw new Error("Published MP3 identity changed");
    await this.store.markRecordingSaved(recording.id, {
      destination: intent.destination, identity: verified.identity, readable: true,
    });
    const chunks = await this.store.cleanupEligibleChunks(recording.id, {
      destination: intent.destination, identity: verified.identity, readable: true,
    });
    const cleanup = await Promise.allSettled(
      chunks.map((chunk) => rm(path.resolve(this.config.storeRoot, chunk.storageKey), { force: true })),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") process.stderr.write(`[meetless-recording] saved chunk cleanup deferred: ${describe(result.reason)}\n`);
    }
  }

  private async recoverRecording(recording: RecordingSession): Promise<void> {
    if (["recording", "interrupted", "recoverable"].includes(recording.status)) {
      await this.adoptOrphans(recording);
    }
    let current = await this.findRecording(recording.id);
    if (current.status === "recording") {
      await this.interruptAndAssess(current.id, "daemon restarted while capture was active");
      return;
    }
    if (current.status === "interrupted") {
      await this.store.assessInterruption(current.id, {
        recoverable: current.chunks.length > 0,
        reason: current.chunks.length > 0 ? undefined : "No readable committed chunks survived",
      });
      return;
    }
    if (current.status === "finalizing" && current.finalization) {
      const destination = current.finalization.publishIntent.destination;
      try {
        const verified = await this.finalizer.verify(destination);
        const reconciliation = await this.store.reconcilePublish(current.id, {
          existingOutput: verified.identity, existingOutputReadable: true,
        });
        if (reconciliation.action === "adopt") await this.finishSaved(reconciliation.recording);
      } catch {
        await this.interruptAndAssess(current.id, "daemon restarted during finalization");
      }
    }
  }

  private async adoptOrphans(recording: RecordingSession): Promise<void> {
    const directory = path.join(this.config.storeRoot, "sessions", recording.id);
    const names = await readdir(directory).catch((error) => isErrno(error, "ENOENT") ? [] : Promise.reject(error));
    const known = new Set(recording.chunks.map((chunk) => chunk.id));
    for (const name of names.sort()) {
      if (name.endsWith(".partial") || name.startsWith(".")) continue;
      const filePath = path.join(directory, name);
      try {
        const chunk = await validateCommittedWavChunk({
          filePath, sessionDirectory: directory, storeRoot: this.config.storeRoot,
        });
        if (known.has(chunk.id)) continue;
        await this.store.adoptOrphanChunk(recording.id, {
          fullyCommitted: true, readable: true, identityValid: true, chunk,
        });
        known.add(chunk.id);
      } catch {
        continue;
      }
    }
  }

  private async handleHelperFailure(recordingId: string, reason: string): Promise<void> {
    if (this.shuttingDown) return;
    await this.serialize(async () => {
      const current = await this.findRecording(recordingId).catch(() => null);
      if (current?.status === "recording") await this.interruptAndAssess(recordingId, reason);
      this.helper = null;
      await this.emitStatus();
    });
  }

  private async interruptAndAssess(recordingId: string, reason: string): Promise<void> {
    const interrupted = await this.store.interruptRecording(recordingId, reason);
    await this.store.assessInterruption(recordingId, {
      recoverable: interrupted.chunks.length > 0,
      reason: interrupted.chunks.length > 0 ? undefined : "No readable committed chunks survived",
    });
  }

  private async validatePreparedCollision(recordingId: string, runtimeInstanceId: string): Promise<CollisionEvidence> {
    const prepared = this.preparedCollision;
    if (!prepared) throw new Error("Collision evidence has not been prepared by this recording runtime");
    if (prepared.recordingId !== recordingId || prepared.runtimeInstanceId !== runtimeInstanceId) {
      throw new Error("Collision evidence is bound to a different recording runtime or session");
    }
    if (path.resolve(prepared.exportRoot) !== path.resolve(this.config.exportRoot)) {
      throw new Error("Collision evidence export root no longer matches daemon configuration");
    }
    const identity = await fileIdentity(prepared.path);
    if (!sameIdentity(identity, prepared)) throw new Error("Collision sentinel identity changed");
    const next = await this.finalizer.nextDestination(new Date(prepared.exportStamp));
    if (next !== prepared.plannedPublishedPath) {
      throw new Error("Prepared publication target is no longer collision-safe; rerun npm run runtime:preowner");
    }
    return prepared;
  }

  private async requireCurrent(...statuses: RecordingSession["status"][]): Promise<RecordingSession> {
    const recording = selectCurrentRecording(await this.store.listRecordings());
    if (!recording || !statuses.includes(recording.status)) {
      throw new Error(`Recording command requires ${statuses.join(" or ")} state`);
    }
    return recording;
  }

  private async findRecording(id: string): Promise<RecordingSession> {
    const recording = (await this.store.listRecordings()).find((candidate) => candidate.id === id);
    if (!recording) throw new Error(`Recording not found: ${id}`);
    return recording;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(operation);
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async emitStatus(): Promise<void> { this.notify(await this.status()); }
  private notify(status: RecordingStatusWire): void { for (const listener of this.listeners) listener(status); }
}

function idleStatus(): RecordingStatusWire {
  return { status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [], outputPath: null, error: null };
}

const UNRESOLVED_STATUSES: ReadonlySet<RecordingSession["status"]> = new Set([
  "recording", "interrupted", "recoverable", "finalizing",
]);

function unresolvedRecordings(recordings: readonly RecordingSession[]): RecordingSession[] {
  return recordings
    .filter((recording) => UNRESOLVED_STATUSES.has(recording.status))
    .sort((left, right) => {
      const byStartedAt = Date.parse(left.startedAt) - Date.parse(right.startedAt);
      return byStartedAt === 0 ? left.id.localeCompare(right.id) : byStartedAt;
    });
}

function selectCurrentRecording(recordings: readonly RecordingSession[]): RecordingSession | undefined {
  const selected = unresolvedRecordings(recordings)[0];
  if (selected) return selected;
  return recordings.reduce<RecordingSession | undefined>((latest, recording) => {
    if (!latest) return recording;
    return Date.parse(recording.updatedAt) >= Date.parse(latest.updatedAt) ? recording : latest;
  }, undefined);
}

function chunkSetDigest(chunks: readonly CommittedRecordingChunk[]): string {
  return createHash("sha256").update(JSON.stringify(chunks.map((chunk) => ({
    id: chunk.id, source: chunk.source, sha256: chunk.sha256, logicalStartMs: chunk.logicalStartMs, durationMs: chunk.durationMs,
  })))).digest("hex");
}

function sameIdentity(left: { byteLength: number; sha256: string }, right: { byteLength: number; sha256: string }): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
