import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeChatAttempt,
  createMeetingChatThread,
  failChatAttempt,
  recordChatRetrieval,
  retryChatAttempt,
  startChatQuestion,
  type ChatSelection,
  type MeetingChatThread,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import {
  MeetingChatService,
  PaseoMeetingChatAgentPort,
  type AgentAnswer,
  type ChatExecutionInput,
  type MeetingChatAgentPort,
  startTranscriptMcp,
} from "../src/chat-service.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("meeting chat service", () => {
  test("persists a supported answer only after same-run retrieval and leaks no Paseo identity", async () => {
    const store = fakeStore();
    const agent = fakeAgent(async (input) => {
      await input.recordRetrieved(["segment-1"]);
      return { outcome: "supported", text: "The team chose local-first.", citationSegmentIds: ["segment-1"] };
    });
    const service = new MeetingChatService(store.port, agent);

    const running = await service.ask({
      meetingId: "meeting-1", question: "What did we choose?", provider: "codex", model: "gpt-5",
    });
    expect(running.status).toBe("running");
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));
    const completed = await service.get("meeting-1");
    expect(completed?.messages.at(-1)).toMatchObject({
      outcome: "supported", citations: [{ meetingId: "meeting-1", segmentId: "segment-1" }],
    });
    expect(JSON.stringify(completed)).not.toMatch(/agentId|workspaceId|sessionId|timeline/u);
  });

  test("stores explicit insufficient evidence without answer text or citations", async () => {
    const service = new MeetingChatService(fakeStore().port, fakeAgent(async () => ({
      outcome: "insufficient_evidence", text: null, citationSegmentIds: [],
    })));
    await service.ask({ meetingId: "meeting-1", question: "Unknown?", provider: "codex", model: "gpt-5" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));
    expect((await service.get("meeting-1"))?.messages.at(-1)).toMatchObject({
      outcome: "insufficient_evidence", text: null, citations: [],
    });
  });

  test.each([
    ["unretrieved citation", async () => ({ outcome: "supported", text: "bad", citationSegmentIds: ["segment-1"] } as AgentAnswer)],
    ["provider failure", async () => { throw new Error("provider does not support MCP servers"); }],
  ])("turns %s into a retryable operational failure", async (_name, execute) => {
    const service = new MeetingChatService(fakeStore().port, fakeAgent(execute));
    await service.ask({ meetingId: "meeting-1", question: "Question", provider: "pi", model: "model" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("failed"));
    expect((await service.get("meeting-1"))?.failure).toMatchObject({ retryable: true });
  });

  test("does not persist or return raw provider failure details", async () => {
    const store = fakeStore();
    const service = new MeetingChatService(store.port, fakeAgent(async () => {
      throw new Error("agentId=paseo-agent-secret workspaceId=paseo-workspace-secret sessionId=paseo-session-secret");
    }));
    await service.ask({ meetingId: "meeting-1", question: "Question", provider: "codex", model: "gpt-5" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("failed"));
    expect(JSON.stringify(await service.get("meeting-1"))).not.toMatch(/paseo-agent-secret|paseo-workspace-secret|paseo-session-secret/u);
    expect(JSON.stringify(store.thread)).not.toMatch(/paseo-agent-secret|paseo-workspace-secret|paseo-session-secret/u);
    expect((await service.get("meeting-1"))?.failure).toEqual({
      message: "Meeting chat could not complete. Retry is available.", retryable: true,
    });
  });

  test("initialization reconciles restart once and retry does not duplicate the user message", async () => {
    const store = fakeStore();
    store.thread = startChatQuestion(store.thread!, {
      userMessageId: "user-old", attemptId: "attempt-old", question: "Question",
      provider: "codex", model: "gpt-5", now: "2026-08-21T00:00:00.000Z",
    });
    const service = new MeetingChatService(store.port, fakeAgent(async () => ({
      outcome: "insufficient_evidence", text: null, citationSegmentIds: [],
    })));
    expect((await service.get("meeting-1"))?.status).toBe("failed");
    await service.retry({ meetingId: "meeting-1", provider: "codex", model: "gpt-5" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));
    expect((await service.get("meeting-1"))?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(store.reconcile).toHaveBeenCalledOnce();
  });

  test("new-path ask and retry use atomic store selection mutations", async () => {
    const store = fakeStore();
    let executions = 0;
    const agent: MeetingChatAgentPort = {
      ...fakeAgent(async () => {
        executions += 1;
        if (executions === 1) throw new Error("provider failed");
        return { outcome: "insufficient_evidence", text: null, citationSegmentIds: [] };
      }),
      validateSelection: vi.fn(async (selection) => selection),
    };
    const startWithSelection = vi.spyOn(store.port, "startChatQuestionWithSelection");
    const retryWithSelection = vi.spyOn(store.port, "retryChatTurnWithSelection");
    const setSelection = vi.spyOn(store.port, "setChatSelection");
    const service = new MeetingChatService(store.port, agent);
    const firstSelection: ChatSelection = {
      provider: "codex", model: "gpt-5", modeId: "worker", thinkingOptionId: "high", featureValues: { fast_mode: true },
    };
    await service.askWithSelection({ meetingId: "meeting-1", question: "Question", selection: firstSelection });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("failed"));

    const retrySelection: ChatSelection = {
      provider: "codex", model: "gpt-5-mini", modeId: "reviewer", thinkingOptionId: "low", featureValues: { fast_mode: false },
    };
    await service.retryWithSelection({ meetingId: "meeting-1", selection: retrySelection });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));

    expect(startWithSelection).toHaveBeenCalledWith({ meetingId: "meeting-1", question: "Question", selection: firstSelection });
    expect(retryWithSelection).toHaveBeenCalledWith("meeting-1", { attemptId: undefined, selection: retrySelection });
    expect(setSelection).not.toHaveBeenCalled();
    expect(agent.validateSelection).toHaveBeenCalledTimes(2);
  });
});

describe("Paseo execution adapter", () => {
  test("serves bounded tools through the official stateless MCP client", async () => {
    const recordRetrieved = vi.fn(async () => undefined);
    const resource = await startTranscriptMcp({
      provider: "codex", model: "gpt-5", messages: [], transcript: transcript(), recordRetrieved,
    });
    const client = new Client({ name: "meetless-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(resource.url)));
      await expect(client.listTools()).resolves.toMatchObject({ tools: [
        { name: "search_meeting_transcript" }, { name: "get_meeting_segments" },
      ] });
      const result = await client.callTool({
        name: "search_meeting_transcript",
        arguments: { query: "local-first" },
        _meta: { progressToken: "m5-test" },
      });
      expect(result.structuredContent).toMatchObject({ segments: [{ segmentId: "segment-1" }] });
      expect(recordRetrieved).toHaveBeenCalledWith(["segment-1"]);
    } finally {
      await client.close().catch(() => undefined);
      await resource.close();
    }
  });

  test("uses a neutral disposable agent, bounded MCP config, low-side-effect Codex options, and archives", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-neutral-chat-"));
    roots.push(executionRoot);
    const archive = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const archiveWorkspace = vi.fn(async () => ({
      requestId: "archive-workspace", workspaceId: "paseo-workspace-secret",
      archivedAt: new Date().toISOString(), error: null,
    }));
    const create = vi.fn(async () => ({
      id: "paseo-agent-secret", workspaceId: "paseo-workspace-secret", cwd: executionRoot,
      waitForFinish: async () => ({
        status: "idle" as const, final: null, error: null,
        lastMessage: JSON.stringify({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }),
      }),
      archive,
    }));
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex",
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
      },
      workspaces: { open: vi.fn(async () => ({ archive: archiveWorkspace, agents: { create } })) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await expect(port.listProviders()).resolves.toMatchObject([{ id: "codex", models: [{ id: "gpt-5" }] }]);
    await port.execute({
      provider: "codex", model: "gpt-5", messages: [{ role: "user", text: "Question" }],
      transcript: transcript(), recordRetrieved: async () => undefined,
    });

    expect(paseo.workspaces.open).toHaveBeenCalledWith(executionRoot);
    const options = create.mock.calls[0]![0] as Record<string, any>;
    expect(options).toMatchObject({
      title: "Meetless meeting question", autoArchive: true,
      config: { provider: "codex/gpt-5", options: { approval_policy: "never", sandbox_mode: "read-only", web_search: "disabled" } },
    });
    expect(JSON.stringify(options)).not.toContain("meeting-1");
    expect(options.config.mcpServers.meeting.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/capability\/[0-9a-f-]+$/u);
    expect(options.prompt).toContain('{"outcome":"insufficient_evidence","text":null,"citationSegmentIds":[]}');
    expect(options.prompt).toContain("Do not use Markdown or code fences");
    expect(archive).toHaveBeenCalledOnce();
    await port.close();
    expect(archiveWorkspace).toHaveBeenCalledOnce();
    await port.close();
    expect(archiveWorkspace).toHaveBeenCalledOnce();
  });

  test("keeps workspace ownership when archive reports an error and retries close", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-neutral-chat-retry-"));
    roots.push(executionRoot);
    const archiveWorkspace = vi.fn()
      .mockResolvedValueOnce({
        requestId: "archive-failed", workspaceId: "workspace-private",
        archivedAt: null, error: "archive failed with workspaceId=workspace-private",
      })
      .mockResolvedValueOnce({
        requestId: "archive-retry", workspaceId: "workspace-private",
        archivedAt: new Date().toISOString(), error: null,
      });
    const paseo = {
      workspaces: { open: async () => ({
        archive: archiveWorkspace,
        agents: { create: async () => ({
          waitForFinish: async () => ({
            status: "idle", final: null, error: null,
            lastMessage: JSON.stringify({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }),
          }),
          archive: async () => ({ archivedAt: new Date().toISOString() }),
        }) },
      }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await port.execute({
      provider: "codex", model: "gpt-5", messages: [{ role: "user", text: "Question" }],
      transcript: transcript(), recordRetrieved: async () => undefined,
    });

    await expect(port.close()).rejects.toThrow("Meeting chat workspace cleanup failed");
    await expect(port.close()).resolves.toBeUndefined();
    expect(archiveWorkspace).toHaveBeenCalledTimes(2);
  });

  test("projects full profiles, validates dynamic controls, preserves mode IDs, and fixes the evidence envelope", async () => {
    const store = fakeStore();
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-"));
    roots.push(executionRoot);
    const create = vi.fn(async () => ({
      waitForFinish: async () => ({
        status: "idle" as const, final: null, error: null,
        lastMessage: JSON.stringify({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }),
      }),
      archive: async () => ({ archivedAt: new Date().toISOString() }),
    }));
    const listFeatures = vi.fn(async () => ({ features: [
      { type: "toggle", id: "fast_mode", label: "Fast mode", value: false },
      { type: "select", id: "effort", label: "Effort", value: "high", options: [{ id: "high", label: "High" }] },
    ] }));
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", defaultModeId: "danger-mode",
          modes: [{ id: "danger-mode", label: "Danger mode" }],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" }],
        }] }),
        listFeatures,
      },
      config: { get: async () => ({ requestId: "profiles-request", config: { agentProfiles: [{
        id: "profile-1", name: "Danger profile", icon: "✦", color: "red",
        provider: "codex", model: "gpt-5", modeId: "danger-mode", thinkingOptionId: "high",
        featureValues: { fast_mode: true, effort: "high" }, notes: "must not cross the adapter",
        providerOptions: { approval_policy: "always" }, toolPolicy: { preapproved: [] },
      }] } }) },
      workspaces: { open: vi.fn(async () => ({ archive: async () => ({ archivedAt: new Date().toISOString(), error: null }), agents: { create } })) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    const controls = await port.getControls(null);
    expect(controls.profiles).toEqual([{ id: "profile-1", name: "Danger profile", icon: "✦", color: "red", selection: {
      provider: "codex", model: "gpt-5", modeId: "danger-mode", thinkingOptionId: "high", featureValues: { fast_mode: true, effort: "high" },
    } }]);
    expect(JSON.stringify(controls)).not.toContain("approval_policy");

    const selection = controls.profiles[0]!.selection;
    const service = new MeetingChatService(store.port, port);
    await expect(service.select(selection)).resolves.toEqual({ version: 1, selection });
    await expect(store.port.getChatSelection()).resolves.toEqual(selection);
    await port.execute({ provider: "codex", model: "gpt-5", selection, messages: [{ role: "user", text: "Question" }], transcript: transcript(), recordRetrieved: async () => undefined });
    expect(paseo.providers.listFeatures).toHaveBeenCalledWith({
      provider: "codex/gpt-5", cwd: executionRoot, modeId: "danger-mode", thinkingOptionId: "high",
      featureValues: { fast_mode: true, effort: "high" },
    }, expect.objectContaining({ requestId: expect.stringMatching(/^meetless-features-/u) }));
    const options = create.mock.calls[0]![0] as Record<string, any>;
    expect(options.config).toMatchObject({
      provider: "codex/gpt-5", modeId: "danger-mode", thinkingOptionId: "high",
      featureValues: { fast_mode: true, effort: "high" },
      options: { approval_policy: "never", sandbox_mode: "read-only", web_search: "disabled" },
    });
    expect(options.config.systemPrompt).toContain("only evidence authority");
    expect(options.config.toolPolicy).toEqual({ preapproved: [
      { kind: "mcp", server: "meeting", tool: "search_meeting_transcript" },
      { kind: "mcp", server: "meeting", tool: "get_meeting_segments" },
    ] });
    expect(JSON.stringify(options)).not.toContain("approval_policy\\\":\\\"always");

    await expect(port.validateSelection({ ...selection, modeId: "removed-mode" })).rejects.toThrow(/no longer available|selection/i);
  });

  test("omits stale profile bundles without failing the current controls catalog", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-stale-profiles-"));
    roots.push(executionRoot);
    const listFeatures = vi.fn(async () => ({ features: [
      { type: "toggle", id: "fast_mode", label: "Fast mode", value: false },
    ] }));
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", defaultModeId: "safe-mode",
          modes: [{ id: "safe-mode", label: "Safe mode" }],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" }],
        }] }),
        listFeatures,
      },
      config: { get: async () => ({ requestId: "profiles-request", config: { agentProfiles: [
        { id: "valid", name: "Valid", provider: "codex", model: "gpt-5", modeId: "safe-mode", thinkingOptionId: "high", featureValues: { fast_mode: true } },
        { id: "stale-provider", name: "Stale provider", provider: "removed", model: "gpt-5", modeId: "safe-mode", thinkingOptionId: "high", featureValues: {} },
        { id: "stale-model", name: "Stale model", provider: "codex", model: "removed", modeId: "safe-mode", thinkingOptionId: "high", featureValues: {} },
        { id: "stale-mode", name: "Stale mode", provider: "codex", model: "gpt-5", modeId: "removed-mode", thinkingOptionId: "high", featureValues: {} },
        { id: "stale-thinking", name: "Stale thinking", provider: "codex", model: "gpt-5", modeId: "safe-mode", thinkingOptionId: "removed-thinking", featureValues: {} },
        { id: "stale-feature", name: "Stale feature", provider: "codex", model: "gpt-5", modeId: "safe-mode", thinkingOptionId: "high", featureValues: { removed_feature: true } },
      ] } }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    const controls = await port.getControls(null);

    expect(controls.catalogError).toBeNull();
    expect(controls.catalog.providers).toHaveLength(1);
    expect(controls.profiles).toEqual([{ id: "valid", name: "Valid", icon: null, color: null, selection: {
      provider: "codex", model: "gpt-5", modeId: "safe-mode", thinkingOptionId: "high", featureValues: { fast_mode: true },
    } }]);
    expect(listFeatures).toHaveBeenCalledTimes(2);
  });

  test("returns an explicit unavailable feature result when the provider reports an error", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-error-"));
    roots.push(executionRoot);
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", modes: [],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
        listFeatures: async () => ({ error: "secret provider failure" }),
      },
      config: { get: async () => ({ agentProfiles: [] }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    const result = await port.discoverFeatures({ provider: "codex", model: "gpt-5", modeId: null, thinkingOptionId: null, featureValues: {} });
    expect(result).toMatchObject({ status: "unavailable", features: null, error: { kind: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("secret provider failure");
  });

  test("preserves an explicit empty feature response as ready", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-empty-features-"));
    roots.push(executionRoot);
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", modes: [],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
        listFeatures: async () => ({ features: [] }),
      },
      config: { get: async () => ({ agentProfiles: [] }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await expect(port.discoverFeatures({ provider: "codex", model: "gpt-5", modeId: null, thinkingOptionId: null, featureValues: {} })).resolves.toMatchObject({
      status: "ready", features: [], error: null,
    });
  });

  test.each([
    ["missing features", {}],
    ["null features", { features: null }],
    ["non-array features", { features: { id: "not-an-array" } }],
    ["malformed feature entry", { features: [null] }],
  ] as const)("fails closed for a successful feature response with %s", async (_name, response) => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-malformed-features-"));
    roots.push(executionRoot);
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", modes: [],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
        listFeatures: async () => response,
      },
      config: { get: async () => ({ agentProfiles: [] }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await expect(port.discoverFeatures({ provider: "codex", model: "gpt-5", modeId: null, thinkingOptionId: null, featureValues: {} })).resolves.toMatchObject({
      status: "update_required", features: null, error: { kind: "update_required" },
    });
  });

  test("rejects a stale feature value instead of silently dropping it", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-stale-feature-"));
    roots.push(executionRoot);
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", modes: [],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
        listFeatures: async () => ({ features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }] }),
      },
      config: { get: async () => ({ agentProfiles: [] }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await expect(port.validateSelection({
      provider: "codex", model: "gpt-5", modeId: null, thinkingOptionId: null,
      featureValues: { removed_feature: true },
    })).rejects.toThrow(/selection|available/i);
  });

  test("requires feature discovery for the complete-selection execution path", async () => {
    const executionRoot = await mkdtemp(path.join(tmpdir(), "meetless-controls-missing-features-"));
    roots.push(executionRoot);
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{
          provider: "codex", enabled: true, status: "ready", label: "Codex", modes: [],
          models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
        }] }),
      },
      config: { get: async () => ({ requestId: "profiles-request", config: { agentProfiles: [] } }) },
    };
    const port = new PaseoMeetingChatAgentPort(paseo as never, executionRoot);
    await expect(port.validateSelection({
      provider: "codex", model: "gpt-5", modeId: null, thinkingOptionId: null, featureValues: {},
    })).rejects.toThrow(/update|required|feature/i);
  });
});

function fakeAgent(execute: (input: ChatExecutionInput) => Promise<AgentAnswer>): MeetingChatAgentPort {
  return {
    listProviders: async () => [{ id: "codex", label: "Codex", models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }] }],
    execute,
    close: async () => undefined,
  };
}

function fakeStore() {
  const state: {
    thread: MeetingChatThread | null;
    selection: ChatSelection | null;
    sequence: number;
    reconcile: ReturnType<typeof vi.fn>;
    port: MeetingStore;
  } = { thread: createMeetingChatThread({ id: "thread-1", meetingId: "meeting-1", now: "2026-08-21T00:00:00.000Z" }), selection: null, sequence: 0, reconcile: vi.fn(), port: null as never };
  state.reconcile = vi.fn(async () => {
    if (state.thread?.status === "running") {
      state.thread = failChatAttempt(state.thread, {
        attemptId: state.thread.activeAttemptId!, reason: "Chat execution was interrupted by restart; retry is available",
        now: "2026-08-21T00:01:00.000Z",
      });
    }
    return state.thread ? [state.thread] : [];
  });
  state.port = {
    listChatThreads: async () => state.thread ? [state.thread] : [],
    reconcileChatAfterRestart: state.reconcile,
    getChatThread: async () => state.thread,
    getTranscriptForMeeting: async () => transcript(),
    getChatSelection: async () => state.selection,
    setChatSelection: async (selection: ChatSelection) => {
      state.selection = selection;
      return selection;
    },
    startChatQuestion: async (input: any) => {
      state.thread = startChatQuestion(state.thread!, {
        ...input, userMessageId: `user-${++state.sequence}`, attemptId: `attempt-${state.sequence}`,
        now: "2026-08-21T00:02:00.000Z",
      });
      return state.thread;
    },
    startChatQuestionWithSelection: async (input: any) => {
      state.selection = input.selection;
      state.thread = startChatQuestion(state.thread!, {
        ...input, userMessageId: `user-${++state.sequence}`, attemptId: `attempt-${state.sequence}`,
        now: "2026-08-21T00:02:00.000Z",
      });
      return state.thread;
    },
    recordChatRetrieval: async (_meetingId: string, attemptId: string, segmentIds: string[]) => {
      state.thread = recordChatRetrieval(state.thread!, {
        attemptId, segmentIds, availableSegmentIds: ["segment-1"], now: "2026-08-21T00:03:00.000Z",
      });
      return state.thread;
    },
    completeChatTurn: async (_meetingId: string, input: any) => {
      state.thread = completeChatAttempt(state.thread!, {
        ...input, assistantMessageId: `assistant-${state.sequence}`,
        availableSegmentIds: ["segment-1"], now: "2026-08-21T00:04:00.000Z",
      });
      return state.thread;
    },
    failChatTurn: async (_meetingId: string, attemptId: string, reason: string) => {
      state.thread = failChatAttempt(state.thread!, { attemptId, reason, now: "2026-08-21T00:04:00.000Z" });
      return state.thread;
    },
    retryChatTurn: async (_meetingId: string, input: any) => {
      state.thread = retryChatAttempt(state.thread!, {
        ...input, attemptId: `attempt-${++state.sequence}`, now: "2026-08-21T00:05:00.000Z",
      });
      return state.thread;
    },
    retryChatTurnWithSelection: async (_meetingId: string, input: any) => {
      state.selection = input.selection;
      state.thread = retryChatAttempt(state.thread!, {
        ...input, attemptId: `attempt-${++state.sequence}`, now: "2026-08-21T00:05:00.000Z",
      });
      return state.thread;
    },
  } as unknown as MeetingStore;
  return state;
}

function transcript(): TranscriptState {
  const range = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" };
  return {
    id: "transcript-1", meetingId: "meeting-1", recordingId: "recording-1", status: "ready",
    plannerVersion: "m3-range-v1", audio: { destination: "meetings/audio.mp3", byteLength: 100, sha256: "sha", durationMs: 1_000 },
    ranges: [range], checkpoints: [{ range, attempts: 1, text: "The team chose local-first.", usage: null, detectedLanguages: ["en"], completedAt: "2026-08-21T00:00:00.000Z" }],
    requestCount: 1, activeRequest: null, usage: null, detectedLanguages: ["en"], failureReason: null,
    publication: { storageKey: "transcripts/transcript-1.json", digest: "digest", publishedAt: "2026-08-21T00:00:00.000Z" },
    createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
