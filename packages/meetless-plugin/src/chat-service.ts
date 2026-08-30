import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { PluginHandlerContext } from "@paseo/plugin";
import type {
  ChatCapabilityErrorWire,
  ChatControlModelWire,
  ChatControlProviderWire,
  ChatControlsCatalogWire,
  ChatControlsWire,
  ChatFeatureDiscoveryWire,
  ChatFeatureWire,
  ChatModeWire,
  ChatProfileWire,
  ChatSelectionWire,
  ChatThinkingOptionWire,
  MeetingChatThreadWire,
} from "@meetless/meeting-contracts";
import type { ChatSelection, MeetingChatThread, TranscriptState } from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import { z } from "zod";
import { MeetingLifecycleCoordinator, type MeetingLifecycleLease } from "./meeting-lifecycle-coordinator.js";

const AgentAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("supported"),
    text: z.string().trim().min(1),
    citationSegmentIds: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  z.object({
    outcome: z.literal("insufficient_evidence"),
    text: z.null(),
    citationSegmentIds: z.array(z.never()).length(0),
  }).strict(),
]);

const CHAT_OPERATIONAL_FAILURE_MESSAGE = "Meeting chat could not complete. Retry is available.";
const CHAT_CONTROLS_UNAVAILABLE = "Chat controls are unavailable. Update or repair the host provider before continuing.";
const CHAT_CONTROLS_UPDATE_REQUIRED = "Chat controls need a host update before this selection can run.";
const CHAT_CONTROLS_REPAIR_REQUIRED = "This chat selection is no longer available. Choose another model or profile.";

export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

class ChatControlsError extends Error {
  constructor(
    readonly kind: ChatCapabilityErrorWire["kind"],
    message: string,
  ) {
    super(message);
    this.name = "ChatControlsError";
  }
}

export interface ChatProviderOption {
  id: string;
  label: string;
  models: Array<{ id: string; label: string; isDefault: boolean }>;
}

export interface ChatExecutionInput {
  provider: string;
  model: string;
  selection?: ChatSelection;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  transcript: TranscriptState;
  recordRetrieved(segmentIds: readonly string[]): Promise<void>;
}

export interface MeetingChatAgentPort {
  listProviders(): Promise<ChatProviderOption[]>;
  execute(input: ChatExecutionInput): Promise<AgentAnswer>;
  close(): Promise<void>;
  getControls?(lastSelection: ChatSelection | null): Promise<ChatControlsWire>;
  discoverFeatures?(selection: ChatSelection): Promise<ChatFeatureDiscoveryWire>;
  validateSelection?(selection: ChatSelection): Promise<ChatSelection>;
}

export class MeetingChatService {
  private initialized: Promise<void> | null = null;
  private readonly active = new Set<Promise<void>>();
  private readonly activeMeetings = new Set<string>();

  constructor(
    private readonly store: MeetingStore,
    private readonly agent: MeetingChatAgentPort,
    private readonly lifecycle = new MeetingLifecycleCoordinator(),
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  private async initializeOnce(): Promise<void> {
    const running = (await this.store.listChatThreads()).filter((thread) => thread.status === "running");
    const acquired = running.map((thread) => ({
      meetingId: thread.meetingId,
      lease: this.lifecycle.tryAcquireWork(thread.meetingId, "ask"),
    })).filter((entry): entry is { meetingId: string; lease: MeetingLifecycleLease } => entry.lease !== null);
    try {
      await this.store.reconcileChatAfterRestart(acquired.map((entry) => entry.meetingId));
    } finally {
      for (const entry of acquired) entry.lease.release();
    }
  }

  async providers(): Promise<ChatProviderOption[]> {
    await this.initialize();
    return this.agent.listProviders();
  }

  async get(meetingId: string): Promise<MeetingChatThreadWire | null> {
    await this.initialize();
    const thread = await this.store.getChatThread(meetingId);
    return thread ? toThreadWire(thread) : null;
  }

  async controls(): Promise<ChatControlsWire> {
    await this.initialize();
    if (!this.agent.getControls) throw new Error("This host does not support Meetless chat controls; update the host.");
    return this.agent.getControls(await this.store.getChatSelection());
  }

  async features(selection: ChatSelection): Promise<ChatFeatureDiscoveryWire> {
    await this.initialize();
    if (!this.agent.discoverFeatures) throw new Error("This host does not support Meetless feature discovery; update the host.");
    return this.agent.discoverFeatures(selection);
  }

  async select(selection: ChatSelection): Promise<{ version: 1; selection: ChatSelection }> {
    await this.initialize();
    if (!this.agent.validateSelection) throw new Error("This host does not support Meetless chat selection; update the host.");
    const checked = await this.agent.validateSelection(selection);
    await this.store.setChatSelection(checked);
    return { version: 1, selection: checked };
  }

  async ask(input: {
    meetingId: string;
    question: string;
    provider: string;
    model: string;
  }): Promise<MeetingChatThreadWire> {
    const lease = this.lifecycle.tryAcquireWork(input.meetingId, "ask");
    if (!lease) throw new Error("Meeting deletion is in progress");
    try {
      await this.initialize();
      const thread = await this.store.startChatQuestion(input);
      this.startExecution(input.meetingId, thread, lease, false);
      return toThreadWire(thread);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async retry(input: {
    meetingId: string;
    provider: string;
    model: string;
  }): Promise<MeetingChatThreadWire> {
    const lease = this.lifecycle.tryAcquireWork(input.meetingId, "ask");
    if (!lease) throw new Error("Meeting deletion is in progress");
    try {
      await this.initialize();
      const thread = await this.store.retryChatTurn(input.meetingId, input);
      this.startExecution(input.meetingId, thread, lease, false);
      return toThreadWire(thread);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async askWithSelection(input: {
    meetingId: string;
    question: string;
    selection: ChatSelection;
  }): Promise<MeetingChatThreadWire> {
    const lease = this.lifecycle.tryAcquireWork(input.meetingId, "ask");
    if (!lease) throw new Error("Meeting deletion is in progress");
    try {
      await this.initialize();
      if (!this.agent.validateSelection) throw new Error("This host does not support Meetless chat selection; update the host.");
      const selection = await this.agent.validateSelection(input.selection);
      const thread = await this.store.startChatQuestionWithSelection({
        meetingId: input.meetingId,
        question: input.question,
        selection,
      });
      this.startExecution(input.meetingId, thread, lease, true);
      return toThreadWire(thread);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async retryWithSelection(input: {
    meetingId: string;
    attemptId?: string;
    selection: ChatSelection;
  }): Promise<MeetingChatThreadWire> {
    const lease = this.lifecycle.tryAcquireWork(input.meetingId, "ask");
    if (!lease) throw new Error("Meeting deletion is in progress");
    try {
      await this.initialize();
      if (!this.agent.validateSelection) throw new Error("This host does not support Meetless chat selection; update the host.");
      const selection = await this.agent.validateSelection(input.selection);
      const thread = await this.store.retryChatTurnWithSelection(input.meetingId, { attemptId: input.attemptId, selection });
      this.startExecution(input.meetingId, thread, lease, true);
      return toThreadWire(thread);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
    await Promise.allSettled([...this.active]);
  }

  isMeetingRunning(meetingId: string): boolean {
    return this.activeMeetings.has(meetingId);
  }

  private startExecution(
    meetingId: string,
    thread: MeetingChatThread,
    lease: MeetingLifecycleLease,
    completeSelection: boolean,
  ): void {
    const attempt = thread.attempts.find((candidate) => candidate.id === thread.activeAttemptId);
    if (!attempt) throw new Error("Running chat thread has no active attempt");
    this.activeMeetings.add(meetingId);
    const work = this.execute(meetingId, thread, attempt.id, completeSelection).finally(() => {
      this.active.delete(work);
      this.activeMeetings.delete(meetingId);
      lease.release();
    });
    this.active.add(work);
  }

  private async execute(
    meetingId: string,
    thread: MeetingChatThread,
    attemptId: string,
    completeSelection: boolean,
  ): Promise<void> {
    try {
      const transcript = await this.store.getTranscriptForMeeting(meetingId);
      if (!transcript || transcript.status !== "ready" || !transcript.publication) {
        throw new Error("Chat execution requires the immutable ready transcript");
      }
      const attempt = thread.attempts.find((candidate) => candidate.id === attemptId)!;
      const answer = await this.agent.execute({
        provider: attempt.provider,
        model: attempt.model,
        ...(completeSelection ? { selection: attempt } : {}),
        messages: thread.messages.map((message) => ({
          role: message.role,
          text: message.role === "user"
            ? message.text
            : message.outcome === "supported"
              ? message.text
              : "The meeting does not contain enough evidence.",
        })),
        transcript,
        recordRetrieved: (segmentIds) =>
          this.store.recordChatRetrieval(meetingId, attemptId, segmentIds).then(() => undefined),
      });
      if (answer.outcome === "supported") {
        await this.store.completeChatTurn(meetingId, {
          attemptId,
          outcome: "supported",
          text: answer.text,
          citationSegmentIds: answer.citationSegmentIds,
        });
      } else {
        await this.store.completeChatTurn(meetingId, {
          attemptId,
          outcome: "insufficient_evidence",
          citationSegmentIds: [],
        });
      }
    } catch (error) {
      const current = await this.store.getChatThread(meetingId).catch(() => null);
      if (current?.status === "running" && current.activeAttemptId === attemptId) {
        await this.store.failChatTurn(
          meetingId,
          attemptId,
          CHAT_OPERATIONAL_FAILURE_MESSAGE,
        );
      }
    }
  }
}

export class PaseoMeetingChatAgentPort implements MeetingChatAgentPort {
  private readonly resources = new Set<RunResource>();
  private readonly agents = new Set<{ archive(): Promise<unknown> }>();
  private workspace: Awaited<ReturnType<PluginHandlerContext["paseo"]["workspaces"]["open"]>> | null = null;

  constructor(
    private readonly paseo: PluginHandlerContext["paseo"],
    private readonly executionRoot: string,
  ) {}

  async getControls(lastSelection: ChatSelection | null): Promise<ChatControlsWire> {
    let catalog: ChatControlsCatalogWire;
    let catalogError: ChatCapabilityErrorWire | null = null;
    try {
      catalog = await this.controlsCatalog();
    } catch (error) {
      catalog = { providers: [] };
      catalogError = capabilityError(error, "unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }

    let profiles: ChatProfileWire[] = [];
    if (!catalogError) {
      try {
        profiles = await this.projectProfiles(catalog);
      } catch (error) {
        catalogError = capabilityError(error, "update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
      }
    }

    let lastSelectionState: ChatControlsWire["lastSelectionState"] = lastSelection ? "unavailable" : "available";
    let lastSelectionError: ChatCapabilityErrorWire | null = catalogError;
    if (lastSelection && !catalogError) {
      try {
        await this.validateAgainstCatalog(lastSelection, catalog);
        await this.discoverFeaturesRaw(lastSelection, catalog);
        lastSelectionState = "available";
        lastSelectionError = null;
      } catch (error) {
        lastSelectionState = error instanceof ChatControlsError && error.kind === "unavailable"
          ? "unavailable"
          : "repair_required";
        lastSelectionError = capabilityError(error, lastSelectionState === "unavailable" ? "unavailable" : "repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
      }
    }
    return {
      version: 1,
      catalog,
      profiles,
      catalogError,
      lastSelection: lastSelection ? cloneSelection(lastSelection) : null,
      lastSelectionState,
      lastSelectionError,
    };
  }

  async discoverFeatures(selection: ChatSelection): Promise<ChatFeatureDiscoveryWire> {
    const safeSelection = normalizeSelection(selection);
    try {
      const catalog = await this.controlsCatalog();
      await this.validateAgainstCatalog(safeSelection, catalog);
      const features = await this.discoverFeaturesRaw(safeSelection, catalog);
      return { version: 1, selection: safeSelection, status: "ready", features, error: null };
    } catch (error) {
      const kind = error instanceof ChatControlsError ? error.kind : "unavailable";
      return {
        version: 1,
        selection: safeSelection,
        status: kind,
        features: null,
        error: capabilityError(error, kind, kind === "repair_required" ? CHAT_CONTROLS_REPAIR_REQUIRED : kind === "update_required" ? CHAT_CONTROLS_UPDATE_REQUIRED : CHAT_CONTROLS_UNAVAILABLE),
      };
    }
  }

  async validateSelection(selection: ChatSelection): Promise<ChatSelection> {
    const safeSelection = normalizeSelection(selection);
    const catalog = await this.controlsCatalog();
    await this.validateAgainstCatalog(safeSelection, catalog);
    await this.discoverFeaturesRaw(safeSelection, catalog);
    return safeSelection;
  }

  private async controlsCatalog(): Promise<ChatControlsCatalogWire> {
    let snapshot: unknown;
    try {
      snapshot = await this.paseo.providers.waitForReady({ cwd: this.executionRoot });
    } catch (error) {
      throw new ChatControlsError("unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }
    const entries = records(recordOf(snapshot)?.entries);
    const providers: ChatControlProviderWire[] = [];
    for (const entry of entries) {
      const provider = stringField(entry, "provider");
      if (!provider) continue;
      const label = stringField(entry, "label") ?? provider;
      const enabled = entry.enabled !== false;
      const status = enumField(entry.status, ["ready", "loading", "error", "unavailable"] as const) ?? "unavailable";
      if (!enabled || status !== "ready") {
        providers.push({
          id: provider,
          label,
          status: enabled ? status : "unavailable",
          models: [],
          modes: [],
          defaultModeId: null,
          error: enabled ? redactedProviderError(status) : "Provider is disabled.",
        });
        continue;
      }
      try {
        const rawModels = records(entry.models);
        const models = rawModels.length > 0
          ? rawModels
          : await this.listModelsForControls(provider);
        const rawModes = records(entry.modes);
        const modes = rawModes.length > 0
          ? rawModes
          : await this.listModesForControls(provider);
        const projectedModels = models
          .filter((model) => model.isSelectable !== false)
          .map(projectModel);
        const projectedModes = modes.map(projectMode);
        if (projectedModels.length === 0) {
          providers.push({
            id: provider,
            label,
            status: "unavailable",
            models: [],
            modes: projectedModes,
            defaultModeId: null,
            error: "No selectable models are available.",
          });
          continue;
        }
        const configuredDefault = nullableStringField(entry.defaultModeId);
        const defaultModeId = configuredDefault === null || projectedModes.some((mode) => mode.id === configuredDefault)
          ? configuredDefault
          : (() => { throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED); })();
        providers.push({
          id: provider,
          label,
          status: "ready",
          models: projectedModels,
          modes: projectedModes,
          defaultModeId,
          error: null,
        });
      } catch (error) {
        providers.push({
          id: provider,
          label,
          status: error instanceof ChatControlsError && error.kind === "update_required" ? "error" : "unavailable",
          models: [],
          modes: [],
          defaultModeId: null,
          error: error instanceof ChatControlsError && error.kind === "update_required"
            ? CHAT_CONTROLS_UPDATE_REQUIRED
            : redactedProviderError("unavailable"),
        });
      }
    }
    return { providers };
  }

  private async listModelsForControls(provider: string): Promise<Record<string, unknown>[]> {
    try {
      const result: unknown = await this.paseo.providers.listModels(provider, { cwd: this.executionRoot });
      return records(recordOf(result)?.models);
    } catch (error) {
      throw new ChatControlsError("unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }
  }

  private async listModesForControls(provider: string): Promise<Record<string, unknown>[]> {
    const actions = this.paseo.providers as unknown as { listModes?: (provider: string, options?: { cwd?: string }) => Promise<unknown> };
    if (typeof actions.listModes !== "function") return [];
    try {
      const result = await actions.listModes(provider, { cwd: this.executionRoot });
      return records(recordOf(result)?.modes);
    } catch (error) {
      throw new ChatControlsError("unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }
  }

  private async projectProfiles(catalog: ChatControlsCatalogWire): Promise<ChatProfileWire[]> {
    const response: unknown = await this.paseo.config.get();
    const responseRecord = recordOf(response);
    const config = recordOf(responseRecord?.config) ?? responseRecord;
    const rawProfiles = records(config?.agentProfiles);
    const profiles: ChatProfileWire[] = [];
    const seen = new Set<string>();
    for (const raw of rawProfiles) {
      const id = stringField(raw, "id");
      const name = stringField(raw, "name");
      const provider = stringField(raw, "provider");
      const model = stringField(raw, "model");
      if (!id || !name || !provider || !model || seen.has(id)) continue;
      try {
        const providerEntry = catalog.providers.find((candidate) => candidate.id === provider);
        const modelEntry = providerEntry?.models.find((candidate) => candidate.id === model);
        const featureValues = safeFeatureValues(raw.featureValues);
        if (!featureValues) continue;
        const modeId = raw.modeId === undefined
          ? providerEntry?.defaultModeId ?? null
          : nullableStringField(raw.modeId);
        const thinkingOptionId = raw.thinkingOptionId === undefined
          ? modelEntry?.defaultThinkingOptionId ?? null
          : nullableStringField(raw.thinkingOptionId);
        const selection = { provider, model, modeId, thinkingOptionId, featureValues };
        await this.validateAgainstCatalog(selection, catalog);
        await this.discoverFeaturesRaw(selection, catalog);
        seen.add(id);
        profiles.push({
          id,
          name,
          icon: stringField(raw, "icon"),
          color: stringField(raw, "color"),
          selection,
        });
      } catch {
        // A stale or malformed profile is not an actionable control. Keep the
        // current catalog usable and omit only this profile.
      }
    }
    return profiles;
  }

  private async validateAgainstCatalog(selection: ChatSelection, catalog: ChatControlsCatalogWire): Promise<void> {
    const provider = catalog.providers.find((candidate) => candidate.id === selection.provider);
    if (!provider || provider.status !== "ready") {
      throw new ChatControlsError(provider?.status === "error" ? "update_required" : "unavailable", provider?.error ?? CHAT_CONTROLS_UNAVAILABLE);
    }
    const model = provider.models.find((candidate) => candidate.id === selection.model);
    if (!model) throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
    if (selection.modeId !== null && !provider.modes.some((mode) => mode.id === selection.modeId)) {
      throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
    }
    if (selection.thinkingOptionId !== null && !model.thinkingOptions.some((option) => option.id === selection.thinkingOptionId)) {
      throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
    }
  }

  private async discoverFeaturesRaw(selection: ChatSelection, catalog: ChatControlsCatalogWire): Promise<ChatFeatureWire[]> {
    await this.validateAgainstCatalog(selection, catalog);
    const actions = this.paseo.providers as unknown as {
      listFeatures?: (draft: Record<string, unknown>, options?: { requestId?: string }) => Promise<unknown>;
    };
    if (typeof actions.listFeatures !== "function") {
      throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
    }
    let result: unknown;
    try {
      result = await actions.listFeatures({
        provider: `${selection.provider}/${selection.model}`,
        ...(selection.modeId === null ? {} : { modeId: selection.modeId }),
        ...(selection.thinkingOptionId === null ? {} : { thinkingOptionId: selection.thinkingOptionId }),
        featureValues: selection.featureValues,
      }, { requestId: `meetless-features-${Date.now()}` });
    } catch (error) {
      throw new ChatControlsError("unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }
    const resultRecord = recordOf(result);
    if (!resultRecord) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
    if (resultRecord.error !== undefined && resultRecord.error !== null && typeof resultRecord.error !== "string") {
      throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
    }
    if (typeof resultRecord.error === "string" && resultRecord.error.trim()) {
      throw new ChatControlsError("unavailable", CHAT_CONTROLS_UNAVAILABLE);
    }
    if (!Array.isArray(resultRecord.features)) {
      throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
    }
    const rawFeatures: Record<string, unknown>[] = [];
    for (const feature of resultRecord.features) {
      const record = recordOf(feature);
      if (!record) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
      rawFeatures.push(record);
    }
    try {
      const featureIds = new Set(rawFeatures.map((feature) => stringField(feature, "id")).filter((id): id is string => id !== null));
      const unknownFeature = Object.keys(selection.featureValues).find((id) => !featureIds.has(id));
      if (unknownFeature) throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
      return rawFeatures.map((feature) => projectFeature(feature, selection.featureValues));
    } catch (error) {
      if (error instanceof ChatControlsError) throw error;
      throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
    }
  }

  async listProviders(): Promise<ChatProviderOption[]> {
    const snapshot = await this.paseo.providers.waitForReady({ cwd: this.executionRoot });
    const entries = snapshot.entries ?? [];
    const available = entries.filter((entry) => entry.enabled && entry.status === "ready");
    return Promise.all(available.map(async (entry) => {
      const result = entry.models?.length
        ? { models: entry.models }
        : await this.paseo.providers.listModels(entry.provider, { cwd: this.executionRoot });
      const models = (result.models ?? []).filter((model) => model.isSelectable !== false);
      return {
        id: entry.provider,
        label: entry.label ?? entry.provider,
        models: models.map((model) => ({
          id: model.id,
          label: model.label,
          isDefault: model.isDefault === true,
        })),
      };
    })).then((providers) => providers.filter((provider) => provider.models.length > 0));
  }

  async execute(input: ChatExecutionInput): Promise<AgentAnswer> {
    const selection = input.selection
      ? await this.validateSelection(input.selection)
      : {
          provider: input.provider,
          model: input.model,
          modeId: null,
          thinkingOptionId: null,
          featureValues: {},
        };
    await mkdir(this.executionRoot, { recursive: true, mode: 0o700 });
    this.workspace ??= await this.paseo.workspaces.open(this.executionRoot);
    const resource = await startTranscriptMcp(input);
    this.resources.add(resource);
    let agent: Awaited<ReturnType<typeof this.workspace.agents.create>> | null = null;
    try {
      const provider = selection.model.startsWith(`${selection.provider}/`)
        ? selection.model
        : `${selection.provider}/${selection.model}`;
      agent = await this.workspace.agents.create({
        config: {
          provider,
          ...(selection.modeId === null ? {} : { modeId: selection.modeId }),
          ...(selection.thinkingOptionId === null ? {} : { thinkingOptionId: selection.thinkingOptionId }),
          featureValues: { ...selection.featureValues },
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { meeting: { type: "http", url: resource.url } },
          toolPolicy: {
            preapproved: [
              { kind: "mcp", server: "meeting", tool: "search_meeting_transcript" },
              { kind: "mcp", server: "meeting", tool: "get_meeting_segments" },
            ],
          },
          ...(selection.provider === "codex" ? {
            options: {
              approval_policy: "never",
              sandbox_mode: "read-only",
              web_search: "disabled",
            },
          } : {}),
        },
        title: "Meetless meeting question",
        labels: { product: "meetless", purpose: "meeting-question" },
        autoArchive: true,
        outputSchema: AGENT_OUTPUT_SCHEMA,
        prompt: buildPrompt(input.messages),
      });
      this.agents.add(agent);
      const result = await agent.waitForFinish(180_000);
      if (result.status !== "idle" || !result.lastMessage) {
        throw new Error(result.error ?? `Meeting chat provider ended with ${result.status}`);
      }
      return AgentAnswerSchema.parse(JSON.parse(result.lastMessage));
    } catch (error) {
      throw new Error(`Meeting chat execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (agent) {
        await agent.archive().catch(() => undefined);
        this.agents.delete(agent);
      }
      await resource.close();
      this.resources.delete(resource);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.agents].map((agent) => agent.archive()));
    this.agents.clear();
    await Promise.allSettled([...this.resources].map((resource) => resource.close()));
    this.resources.clear();
    const workspace = this.workspace;
    if (workspace) {
      const result = await workspace.archive();
      if (result.error || !result.archivedAt) {
        throw new Error("Meeting chat workspace cleanup failed");
      }
      this.workspace = null;
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function nullableStringField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
  return value.trim();
}

function enumField<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : null;
}

function projectMode(mode: Record<string, unknown>): ChatModeWire {
  const id = stringField(mode, "id");
  const label = stringField(mode, "label");
  if (!id || !label) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
  return { id, label };
}

function projectThinkingOption(option: Record<string, unknown>): ChatThinkingOptionWire {
  const id = stringField(option, "id");
  const label = stringField(option, "label");
  if (!id || !label) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
  return { id, label };
}

function projectModel(model: Record<string, unknown>): ChatControlModelWire {
  const id = stringField(model, "id");
  const label = stringField(model, "label");
  if (!id || !label) throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED);
  const thinkingOptions = records(model.thinkingOptions).map(projectThinkingOption);
  const configuredDefault = nullableStringField(model.defaultThinkingOptionId);
  const defaultThinkingOptionId = configuredDefault === null || thinkingOptions.some((option) => option.id === configuredDefault)
    ? configuredDefault
    : (() => { throw new ChatControlsError("update_required", CHAT_CONTROLS_UPDATE_REQUIRED); })();
  return {
    id,
    label,
    isDefault: model.isDefault === true,
    thinkingOptions,
    defaultThinkingOptionId,
  };
}

function safeFeatureValues(value: unknown): Record<string, boolean | string | null> | null {
  const source = recordOf(value);
  if (!source && value !== undefined) return null;
  const result: Record<string, boolean | string | null> = {};
  for (const [key, featureValue] of Object.entries(source ?? {})) {
    const id = key.trim();
    if (!id || (typeof featureValue !== "boolean" && typeof featureValue !== "string" && featureValue !== null)) return null;
    result[id] = featureValue;
  }
  return result;
}

function projectFeature(
  feature: Record<string, unknown>,
  selectedValues: Record<string, boolean | string | null>,
): ChatFeatureWire {
  const id = stringField(feature, "id");
  const label = stringField(feature, "label");
  if (!id || !label) throw new Error("Malformed feature");
  const base = {
    id,
    label,
    ...(typeof feature.description === "string" ? { description: feature.description } : {}),
    ...(typeof feature.tooltip === "string" ? { tooltip: feature.tooltip } : {}),
    ...(typeof feature.icon === "string" && feature.icon.trim() ? { icon: feature.icon.trim() } : {}),
  };
  if (feature.type === "toggle" && typeof feature.value === "boolean") {
    if (Object.hasOwn(selectedValues, id) && typeof selectedValues[id] !== "boolean") {
      throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
    }
    return { ...base, type: "toggle", value: Object.hasOwn(selectedValues, id) ? selectedValues[id] as boolean : feature.value };
  }
  if (feature.type === "select" && (typeof feature.value === "string" || feature.value === null)) {
    const options = records(feature.options).map(projectThinkingOption);
    const selected = Object.hasOwn(selectedValues, id) ? selectedValues[id] : feature.value;
    if (selected !== null && typeof selected !== "string") throw new Error("Malformed select feature value");
    if (selected !== null && !options.some((option) => option.id === selected)) throw new Error("Unknown select feature value");
    return { ...base, type: "select", value: selected, options };
  }
  throw new Error("Malformed feature");
}

function normalizeSelection(selection: ChatSelection): ChatSelection {
  const provider = typeof selection.provider === "string" ? selection.provider.trim() : "";
  const model = typeof selection.model === "string" ? selection.model.trim() : "";
  const modeId = selection.modeId === null ? null : typeof selection.modeId === "string" ? selection.modeId.trim() : "";
  const thinkingOptionId = selection.thinkingOptionId === null
    ? null
    : typeof selection.thinkingOptionId === "string" ? selection.thinkingOptionId.trim() : "";
  const featureValues = safeFeatureValues(selection.featureValues);
  if (!provider || !model || modeId === "" || thinkingOptionId === "" || !featureValues) {
    throw new ChatControlsError("repair_required", CHAT_CONTROLS_REPAIR_REQUIRED);
  }
  return { provider, model, modeId, thinkingOptionId, featureValues };
}

function cloneSelection(selection: ChatSelection): ChatSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    modeId: selection.modeId,
    thinkingOptionId: selection.thinkingOptionId,
    featureValues: { ...selection.featureValues },
  };
}

function capabilityError(
  error: unknown,
  fallbackKind: ChatCapabilityErrorWire["kind"],
  fallbackMessage: string,
): ChatCapabilityErrorWire {
  if (error instanceof ChatControlsError) return { kind: error.kind, message: error.message };
  return { kind: fallbackKind, message: fallbackMessage };
}

function redactedProviderError(status: string): string {
  return status === "error"
    ? "Provider needs an update or repair before it can be used."
    : "Provider is unavailable on this host.";
}

export function toThreadWire(thread: MeetingChatThread): MeetingChatThreadWire {
  const latest = thread.attempts.at(-1) ?? null;
  return {
    meetingId: thread.meetingId,
    status: thread.status,
    messages: thread.messages.map((message) => message.role === "user"
      ? { role: "user", text: message.text, createdAt: message.createdAt }
      : message.outcome === "supported"
        ? {
            role: "assistant",
            outcome: "supported",
            text: message.text,
            citations: message.citations.map((citation) => ({
              meetingId: thread.meetingId,
              segmentId: citation.segmentId,
            })),
            createdAt: message.createdAt,
          }
        : {
            role: "assistant",
            outcome: "insufficient_evidence",
            text: null,
            citations: [],
            createdAt: message.createdAt,
          }),
    selection: latest ? { provider: latest.provider, model: latest.model } : null,
    failure: thread.status === "failed" && latest?.failureReason
      ? { message: latest.failureReason, retryable: true }
      : null,
  };
}

interface RunResource {
  url: string;
  close(): Promise<void>;
}

export async function startTranscriptMcp(input: ChatExecutionInput): Promise<RunResource> {
  const capability = randomUUID();
  const route = `/capability/${capability}`;
  const httpServer = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== route) {
      response.statusCode = 404;
      response.end();
      return;
    }
    void handleMcpRequest(request, response, input);
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") return reject(new Error("Meeting MCP did not bind"));
      resolve(address.port);
    });
  });
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}${route}`,
    close: () => new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      httpServer.close(() => resolve());
    }),
  };
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: ChatExecutionInput,
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const messages = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(messages.map((message) => handleMcpMessage(message, input))))
      .filter((message) => message !== null);
    if (replies.length === 0) {
      response.statusCode = 202;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  } catch (error) {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }
}

async function handleMcpMessage(message: unknown, input: ChatExecutionInput): Promise<Record<string, unknown> | null> {
  const envelope = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  }).passthrough().parse(message);
  if (envelope.id === undefined) return null;
  const success = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id: envelope.id, result });
  if (envelope.method === "initialize") {
    const params = z.object({ protocolVersion: z.string().optional() }).passthrough().parse(envelope.params ?? {});
    return success({
      protocolVersion: params.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "meetless-meeting-retrieval", version: "1.0.0" },
    });
  }
  if (envelope.method === "ping") return success({});
  if (envelope.method === "tools/list") return success({ tools: MCP_TOOLS });
  if (envelope.method === "tools/call") {
    const call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).passthrough()
      .parse(envelope.params);
    if (call.name === "search_meeting_transcript") {
      const { query } = z.object({ query: z.string().trim().min(1).max(500) }).strict().parse(call.arguments);
      const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const segments = input.transcript.checkpoints
        .map((checkpoint) => ({
          checkpoint,
          score: terms.reduce((score, term) => score + (checkpoint.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.checkpoint.range.ordinal - right.checkpoint.range.ordinal)
        .slice(0, 8)
        .map((entry) => segmentPayload(entry.checkpoint));
      await input.recordRetrieved(segments.map((segment) => segment.segmentId));
      return success(toolResult({ segments }));
    }
    if (call.name === "get_meeting_segments") {
      const { segmentIds } = z.object({
        segmentIds: z.array(z.string().trim().min(1)).min(1).max(8),
      }).strict().parse(call.arguments);
      const wanted = new Set(segmentIds);
      const segments = input.transcript.checkpoints
        .filter((checkpoint) => wanted.has(checkpoint.range.segmentId))
        .map(segmentPayload);
      await input.recordRetrieved(segments.map((segment) => segment.segmentId));
      return success(toolResult({ segments }));
    }
  }
  return {
    jsonrpc: "2.0",
    id: envelope.id,
    error: { code: -32601, message: `Unsupported meeting MCP method: ${envelope.method}` },
  };
}

function segmentPayload(checkpoint: TranscriptState["checkpoints"][number]) {
  return {
    segmentId: checkpoint.range.segmentId,
    startMs: checkpoint.range.startMs,
    endMs: checkpoint.range.endMs,
    text: checkpoint.text,
  };
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const MCP_TOOLS = [
  {
    name: "search_meeting_transcript",
    description: "Search only the open meeting transcript. Returns bounded exact segments and stable IDs.",
    inputSchema: {
      type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "get_meeting_segments",
    description: "Fetch up to eight known segment IDs from only the open meeting transcript.",
    inputSchema: {
      type: "object", properties: { segmentIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } } },
      required: ["segmentIds"], additionalProperties: false,
    },
  },
] as const;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_000_000) throw new Error("Meeting MCP request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildPrompt(messages: ChatExecutionInput["messages"]): string {
  return [
    "Answer the newest user question using only the meeting retrieval tools.",
    "Do not use filesystem, shell, web, workspace, or memory as evidence.",
    "Return exactly one JSON object matching the output schema. Do not use Markdown or code fences.",
    "Cite only segment IDs returned by tools in this turn.",
    'Supported form: {"outcome":"supported","text":"answer","citationSegmentIds":["retrieved-segment-id"]}.',
    'Insufficient form: {"outcome":"insufficient_evidence","text":null,"citationSegmentIds":[]}.',
    "For insufficient evidence, use the exact insufficient form. Do not add an explanation.",
    "Conversation:",
    ...messages.map((message) => `${message.role}: ${message.text}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the Meetless meeting assistant.",
  "The meeting MCP tools are the only evidence authority.",
  "Do not read files, run commands, browse the web, or use external knowledge.",
  "A supported answer needs at least one exact segment citation returned during this turn.",
].join(" ");

const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["supported", "insufficient_evidence"] },
    text: { type: ["string", "null"] },
    citationSegmentIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
  required: ["outcome", "text", "citationSegmentIds"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function resolveChatExecutionRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const runtimeRoot = environment.MEETLESS_RUNTIME_ROOT?.trim();
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new Error("MEETLESS_RUNTIME_ROOT must be an absolute path for neutral chat execution");
  }
  return path.join(runtimeRoot, "chat-execution");
}
