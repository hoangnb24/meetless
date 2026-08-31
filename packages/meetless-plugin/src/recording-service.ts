import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import { recordingElapsedMs, type RecordingSession } from "@meetless/meeting-domain";
import type { RecordingControlRequest, RecordingStatusWire } from "@meetless/meeting-contracts";
import { CaptureHelper } from "./capture-helper.js";
import {
  fileIdentity,
  Mp3Finalizer,
  type ManagedTimelineArtifact,
  type ManagedTimelineArtifactConsumer,
} from "./finalizer.js";
import { readInventory, RecordingInventoryReconciler, resolveStorePath, ZeroValidMediaError } from "./inventory.js";
import type { CollisionEvidence } from "./readiness-protocol.js";
import type { TranscriptionService } from "./transcription-service.js";
import { MeetingLifecycleCoordinator, type MeetingLifecycleLease } from "./meeting-lifecycle-coordinator.js";

export interface RecordingServiceConfig {
  storeRoot: string;
  helperPath: string;
  ffmpeg: string;
  ffprobe: string;
  exportRoot: string;
  fixture: boolean;
  helperArguments?: string[];
  helperStartTimeoutMs?: number;
  exportNow?: () => Date;
  fixtureStampApplied?: boolean;
  failFinalizationOnce?: boolean;
  authorizeProductionStart?: () => Promise<void>;
  transcription?: TranscriptionService;
  managedTimelineConsumer?: ManagedTimelineArtifactConsumer;
}

export class RecordingService {
  readonly store: MeetingStore;
  private readonly finalizer: Mp3Finalizer;
  private readonly inventory: RecordingInventoryReconciler;
  private helper: CaptureHelper | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(status: RecordingStatusWire) => void>();
  private failFinalizationOnce: boolean;
  private shuttingDown = false;
  private preparedCollision: CollisionEvidence | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scans = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private inventoryStartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly recordingLeases = new Map<string, MeetingLifecycleLease>();

  constructor(
    readonly config: RecordingServiceConfig,
    store?: MeetingStore,
    private readonly lifecycle = new MeetingLifecycleCoordinator(),
  ) {
    this.store = store ?? new MeetingStore({ root: config.storeRoot });
    this.finalizer = new Mp3Finalizer({
      ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, exportRoot: config.exportRoot, storeRoot: config.storeRoot,
    });
    this.inventory = new RecordingInventoryReconciler(config.storeRoot, this.store);
    this.failFinalizationOnce = config.failFinalizationOnce === true;
  }

  subscribe(listener: (status: RecordingStatusWire) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await mkdir(path.join(this.config.storeRoot, "sessions"), { recursive: true, mode: 0o700 });
    const recordings = await this.store.listRecordings();
    for (const recording of recordings) {
      if (["recording", "interrupted", "recoverable", "finalizing"].includes(recording.status)) {
        if (!this.registerRecordingWork(recording)) throw new Error("Meeting deletion is in progress");
      }
    }
    const startupStageOwners = recordings
      .filter((recording) => ["recording", "interrupted", "recoverable", "finalizing"].includes(recording.status))
      .map((recording) => recording.id);
    await this.finalizer.sweepOwnedStages(startupStageOwners);
    for (const recording of recordings) {
      if (recording.status === "recording" || recording.status === "interrupted") {
        await this.store.prepareInventoryRecovery(recording.id, "daemon restarted while capture was active");
      } else if (recording.status === "finalizing") {
        await this.recoverRecording(recording);
      }
    }
    await this.emitStatus();
    await this.config.transcription?.initialize();
    const startupRecoveryIds = (await this.store.listRecordings())
      .filter((recording) => recording.status === "recoverable" && recording.inventory.state !== "complete")
      .map((recording) => recording.id);
    this.inventoryStartTimer = setTimeout(() => {
      this.inventoryStartTimer = null;
      void this.startPendingInventoryScans(startupRecoveryIds);
    }, 100);
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
      chunks: recording.chunks.slice(-4),
      inventoryState: recording.inventory.state,
      chunkCount: recording.inventory.knownChunkCount,
      microphoneCount: recording.inventory.microphoneCount,
      systemCount: recording.inventory.systemCount,
      inventoryDigest: recording.inventory.pointer?.digest ?? null,
      retryEligible: recording.status === "recoverable" && recording.inventory.state === "complete",
      outputPath: recording.savedOutput?.destination ?? recording.finalization?.publishIntent.destination ?? null,
      error: recording.inventory.error ?? recording.failureReason ?? recording.interruption?.reason ?? null,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.helper?.terminate();
    this.helper = null;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    if (this.inventoryStartTimer) clearTimeout(this.inventoryStartTimer);
    this.inventoryStartTimer = null;
    for (const scan of this.scans.values()) scan.controller.abort();
    await Promise.allSettled([...this.scans.values()].map((scan) => scan.promise));
    await this.serialize(async () => {
      const current = await this.status();
      if (current.status === "recording" && current.recordingId) {
        const recovered = await this.store.prepareInventoryRecovery(current.recordingId, "Meetless runtime shutdown interrupted active capture");
        this.startInventoryScan(recovered);
        await this.emitStatus();
      }
    });
    for (const lease of this.recordingLeases.values()) lease.release();
    this.recordingLeases.clear();
  }

  helperRuntime(): { pid: number | null; executable: string; arguments: string[] } {
    return {
      pid: this.helper?.pid ?? null,
      executable: this.helper?.executable ?? this.config.helperPath,
      arguments: [...(this.helper?.arguments ?? this.config.helperArguments ?? (this.config.fixture ? ["--fixture"] : []))],
    };
  }

  async ownedStagePaths(meetingId: string): Promise<Array<{ recordingId: string; path: string }>> {
    const candidates = (await this.store.listRecordings()).filter((recording) => recording.meetingId === meetingId);
    const recordingIds = (await Promise.all(candidates.map(async (recording) => ({
      recording,
      ownsStage: await requiresFinalizerStageEnumeration(recording, this.config.storeRoot),
    })))).filter((entry) => entry.ownsStage).map((entry) => entry.recording.id);
    return this.finalizer.ownedStagePaths(recordingIds);
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
    const lease = this.lifecycle.tryAcquireWork(meeting.id, "active_capture");
    if (!lease) throw new Error("Meeting deletion is in progress");
    let recording: RecordingSession | null = null;
    let startupHelper: CaptureHelper | null = null;
    let sessionPrepared = false;
    try {
      recording = await this.store.startRecording({ meetingId: meeting.id });
      this.recordingLeases.set(recording.id, lease);
      const establishedRecording = recording;
      const sessionDirectory = path.join(this.config.storeRoot, "sessions", establishedRecording.id);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      sessionPrepared = true;
      await this.authorizeProductionStart();
      const helper = new CaptureHelper({
        executable: this.config.helperPath,
        sessionDirectory,
        storeRoot: this.config.storeRoot,
        fixture: this.config.fixture,
        arguments: this.config.helperArguments,
        startTimeoutMs: this.config.helperStartTimeoutMs,
        onChunk: async (chunk) => {
          await this.store.commitChunk(establishedRecording.id, chunk);
          this.scheduleStatus();
        },
        onFailure: (reason) => this.handleHelperFailure(establishedRecording.id, reason),
        onDiagnostic: (line) => process.stderr.write(`[meetless-capture] ${line}\n`),
      });
      startupHelper = helper;
      this.helper = helper;
      await helper.start();
    }
    catch (error) {
      let rollbackError: unknown = null;
      try {
        // Capture must be unable to publish another chunk before inventory can
        // prove that the session contains no recoverable media.
        await startupHelper?.terminate();
        if (this.helper === startupHelper) this.helper = null;
        recording ??= (await this.store.listRecordings())
          .find((candidate) => candidate.meetingId === meeting.id) ?? null;
        if (recording && !this.recordingLeases.has(recording.id)) {
          this.recordingLeases.set(recording.id, lease);
        }
        if (recording && (startupHelper || sessionPrepared)) {
          await this.interruptAndAssess(
            recording.id,
            `capture start failed: ${describe(error)}`,
            { retainTerminalWork: true },
          );
        } else if (recording) {
          const interrupted = await this.store.interruptRecording(
            recording.id,
            `capture setup failed before a session directory was available: ${describe(error)}`,
          );
          await this.store.assessInterruption(recording.id, {
            recoverable: interrupted.inventory.knownChunkCount > 0,
            reason: interrupted.inventory.knownChunkCount > 0
              ? undefined
              : "Capture never started and no committed media exists",
          });
        }
        const assessed = recording ? await this.findRecording(recording.id) : null;
        // If session preparation itself failed there is no directory a helper
        // could have published into. Avoid inventory, which depends on that same
        // path; preserve any already-committed media if store state says it exists.
        if (!assessed || (assessed.status === "failed" && assessed.inventory.knownChunkCount === 0)) {
          const deleted = await this.store.deleteMeeting(meeting.id);
          if (deleted.outcome !== "deleted") {
            throw new Error(
              `zero-media recording cleanup ${deleted.outcome}` +
              (deleted.reason ? ` (${deleted.reason})` : ""),
            );
          }
          if (recording) this.releaseRecordingWork(recording.id);
          else lease.release();
        }
      } catch (cleanupError) {
        rollbackError = cleanupError;
        process.stderr.write(
          `[meetless-recording] start rollback incomplete after ${describe(error)}: ${describe(cleanupError)}\n`,
        );
        // A failed rollback must not leave an invisible lifecycle lease. If the
        // helper itself did not quiesce, keep its handle and active-work lease so
        // destructive deletion remains refused.
        if (!startupHelper?.pid) {
          if (recording) this.releaseRecordingWork(recording.id);
          else lease.release();
        }
      }
      if (rollbackError) throw new RecordingStartRollbackError(error, rollbackError);
      throw error;
    }
  }

  private async authorizeProductionStart(): Promise<void> {
    if (this.config.fixture) return;
    if (!this.config.authorizeProductionStart) {
      throw new Error(
        "Production recording start rejected before helper spawn: MeetlessHost provenance is unavailable. " +
        "Authority: docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md. Next action: launch with npm run runtime:host.",
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
    const closed = await this.store.prepareInventoryRecovery(recording.id, "capture stopped with durably closed chunks");
    await this.reconcileInventory(closed);
    const completed = await this.findRecording(recording.id);
    await this.stageBeginAndPublish(completed, prepared?.plannedPublishedPath);
  }

  private async retryFinalization(): Promise<void> {
    const recording = await this.requireCurrent("recoverable", "finalizing");
    if (recording.inventory.state !== "complete" || !recording.inventory.pointer) {
      throw new Error("Retry MP3 is unavailable until inventory reconciliation is complete (docs/product/recording.md)");
    }
    if (!recording.finalization) {
      await this.stageBeginAndPublish(recording);
      return;
    }
    await this.store.retryFinalization(recording.id);
    const staged = await this.finalizer.stage(recording.id, recording.inventory.pointer);
    if (!sameIdentity(staged.identity, recording.finalization.publishIntent.expectedIdentity)) {
      await rm(staged.stagePath, { force: true });
      await staged.managedTimeline.cleanup();
      await this.interruptAndAssess(recording.id, "retry output identity changed");
      throw new Error("Retry output identity changed; original chunks were preserved");
    }
    await this.publishOutput(recording.id, staged.stagePath, staged.managedTimeline);
  }

  private async stageBeginAndPublish(recording: RecordingSession, preparedDestination?: string): Promise<void> {
    if (recording.inventory.state !== "complete" || !recording.inventory.pointer) {
      throw new Error("Finalization requires a complete durable inventory");
    }
    const staged = await this.finalizer.stage(recording.id, recording.inventory.pointer);
    const destination = preparedDestination ?? await this.finalizer.nextDestination(this.config.exportNow?.() ?? new Date());
    try {
      await this.store.beginFinalization(recording.id, {
        openChunksDurablyClosed: true,
        chunkSetDigest: recording.inventory.pointer.digest,
        destination,
        expectedIdentity: staged.identity,
      });
    } catch (error) {
      await rm(staged.stagePath, { force: true }).catch(() => undefined);
      await staged.managedTimeline.cleanup().catch(() => undefined);
      throw error;
    }
    if (this.preparedCollision?.recordingId === recording.id) {
      this.preparedCollision = null;
    }
    if (this.failFinalizationOnce) {
      this.failFinalizationOnce = false;
      await rm(staged.stagePath, { force: true });
      await staged.managedTimeline.cleanup();
      await this.interruptAndAssess(recording.id, "injected finalization interruption");
      throw new Error("Injected finalization interruption; retry without re-recording");
    }
    await this.publishOutput(recording.id, staged.stagePath, staged.managedTimeline);
  }

  private async publishOutput(
    recordingId: string,
    stagePath: string,
    managedTimeline: ManagedTimelineArtifact,
  ): Promise<void> {
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
          await this.finishSaved(reconciliation.recording, managedTimeline);
          return;
        }
        continue;
      }
      recording = await this.findRecording(recordingId);
      await this.finishSaved(recording, managedTimeline);
      return;
    }
    throw new Error("Exhausted collision-safe recording destinations");
  }

  private async finishSaved(recording: RecordingSession, managedTimeline?: ManagedTimelineArtifact): Promise<void> {
    const intent = recording.finalization!.publishIntent;
    const verified = await this.finalizer.verify(intent.destination);
    if (!sameIdentity(verified.identity, intent.expectedIdentity)) throw new Error("Published MP3 identity changed");
    const saved = await this.store.markRecordingSaved(recording.id, {
      destination: intent.destination, identity: verified.identity, readable: true,
    });
    let handedOff = false;
    try {
      if (managedTimeline && this.config.managedTimelineConsumer) {
        await this.config.managedTimelineConsumer.accept(managedTimeline);
        handedOff = true;
      }
      const cleanupInventory = await this.store.cleanupEligibleInventory(recording.id, {
        destination: intent.destination, identity: verified.identity, readable: true,
      });
      const chunks = cleanupInventory.pointer
        ? readInventory(this.config.storeRoot, cleanupInventory.pointer)
        : arrayChunks(cleanupInventory.legacyChunks);
      for await (const chunk of chunks) {
        await rm(resolveStorePath(this.config.storeRoot, chunk.storageKey), { force: true }).catch((error) => {
          process.stderr.write(`[meetless-recording] saved chunk cleanup deferred: ${describe(error)}\n`);
        });
      }
      this.config.transcription?.schedule(saved);
    } finally {
      if (!handedOff) await managedTimeline?.cleanup().catch(() => undefined);
      this.releaseRecordingWork(recording.id);
    }
  }

  private async recoverRecording(recording: RecordingSession): Promise<void> {
    let current = await this.findRecording(recording.id);
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

  private async handleHelperFailure(recordingId: string, reason: string): Promise<void> {
    if (this.shuttingDown) return;
    await this.serialize(async () => {
      const current = await this.findRecording(recordingId).catch(() => null);
      if (current?.status === "recording") {
        const recovered = await this.store.prepareInventoryRecovery(recordingId, reason);
        this.startInventoryScan(recovered);
      }
      this.helper = null;
      await this.emitStatus();
    });
  }

  private async interruptAndAssess(
    recordingId: string,
    reason: string,
    options: { retainTerminalWork?: boolean } = {},
  ): Promise<void> {
    const current = await this.findRecording(recordingId);
    if (current.status === "recording") {
      const recovered = await this.store.prepareInventoryRecovery(recordingId, reason);
      await this.startInventoryScan(recovered, options);
      return;
    }
    const interrupted = await this.store.interruptRecording(recordingId, reason);
    await this.store.assessInterruption(recordingId, {
      recoverable: interrupted.inventory.knownChunkCount > 0,
      reason: interrupted.inventory.knownChunkCount > 0 ? undefined : "No readable committed chunks survived",
    });
  }

  private startInventoryScan(
    recording: RecordingSession,
    options: { retainTerminalWork?: boolean } = {},
  ): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const existing = this.scans.get(recording.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.reconcileInventory(recording, controller.signal)
      .catch((error) => {
        if (!(error instanceof Error && error.name === "AbortError")) {
          const outcome = error instanceof ZeroValidMediaError ? "failed with zero valid media" : "blocked";
          process.stderr.write(`[meetless-recording] inventory reconciliation ${outcome}: ${describe(error)}\n`);
        }
      })
      .finally(async () => {
        this.scans.delete(recording.id);
        const current = (await this.store.listRecordings().catch(() => []))
          .find((candidate) => candidate.id === recording.id);
        if (
          !options.retainTerminalWork &&
          (!current || current.status === "failed" || current.status === "saved")
        ) this.releaseRecordingWork(recording.id);
        if (!this.shuttingDown) await this.emitStatus().catch(() => undefined);
      });
    this.scans.set(recording.id, { controller, promise });
    return promise;
  }

  private async startPendingInventoryScans(recordingIds: readonly string[]): Promise<void> {
    if (this.shuttingDown) return;
    for (const recording of await this.store.listRecordings()) {
      if (recordingIds.includes(recording.id) && recording.status === "recoverable" && recording.inventory.state !== "complete") {
        this.startInventoryScan(recording);
      }
    }
  }

  private async reconcileInventory(recording: RecordingSession, signal?: AbortSignal): Promise<void> {
    await this.inventory.reconcile(recording, { signal });
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

  private registerRecordingWork(recording: RecordingSession): boolean {
    if (this.recordingLeases.has(recording.id)) return true;
    const kind = recording.finalization ? "finalization" : "active_capture";
    const lease = this.lifecycle.tryAcquireWork(recording.meetingId, kind);
    if (!lease) return false;
    this.recordingLeases.set(recording.id, lease);
    return true;
  }

  private releaseRecordingWork(recordingId: string): void {
    this.recordingLeases.get(recordingId)?.release();
    this.recordingLeases.delete(recordingId);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(operation);
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async emitStatus(): Promise<void> { this.notify(await this.status()); }
  private scheduleStatus(): void {
    if (this.shuttingDown || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      void this.emitStatus().catch((error) => {
        process.stderr.write(`[meetless-recording] status notification deferred: ${describe(error)}\n`);
      });
    }, 100);
  }
  private notify(status: RecordingStatusWire): void { for (const listener of this.listeners) listener(status); }
}

async function requiresFinalizerStageEnumeration(recording: RecordingSession, storeRoot: string): Promise<boolean> {
  if (["recording", "interrupted", "recoverable", "finalizing"].includes(recording.status)) return true;
  if (recording.status !== "failed") return false;
  return lstat(path.join(storeRoot, "sessions", recording.id)).then(
    (state) => state.isDirectory() && !state.isSymbolicLink(),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error),
  );
}

function idleStatus(): RecordingStatusWire {
  return { status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [],
    inventoryState: null, chunkCount: 0, microphoneCount: 0, systemCount: 0, inventoryDigest: null,
    retryEligible: false, outputPath: null, error: null };
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

function sameIdentity(left: { byteLength: number; sha256: string }, right: { byteLength: number; sha256: string }): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class RecordingStartRollbackError extends Error {
  readonly rollbackError: unknown;

  constructor(startError: unknown, rollbackError: unknown) {
    super(describe(startError), { cause: startError });
    this.name = "RecordingStartRollbackError";
    this.rollbackError = rollbackError;
  }
}
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function* arrayChunks(chunks: readonly import("@meetless/meeting-domain").CommittedRecordingChunk[]) {
  for (const chunk of chunks) yield chunk;
}
