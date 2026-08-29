import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { PluginHandlerContext } from "@paseo/plugin";
import type { MeetingChatThreadWire } from "@meetless/meeting-contracts";
import type { MeetingChatThread, TranscriptState } from "@meetless/meeting-domain";
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

export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

export interface ChatProviderOption {
  id: string;
  label: string;
  models: Array<{ id: string; label: string; isDefault: boolean }>;
}

export interface ChatExecutionInput {
  provider: string;
  model: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  transcript: TranscriptState;
  recordRetrieved(segmentIds: readonly string[]): Promise<void>;
}

export interface MeetingChatAgentPort {
  listProviders(): Promise<ChatProviderOption[]>;
  execute(input: ChatExecutionInput): Promise<AgentAnswer>;
  close(): Promise<void>;
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
      this.startExecution(input.meetingId, thread, lease);
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
      this.startExecution(input.meetingId, thread, lease);
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

  private startExecution(meetingId: string, thread: MeetingChatThread, lease: MeetingLifecycleLease): void {
    const attempt = thread.attempts.find((candidate) => candidate.id === thread.activeAttemptId);
    if (!attempt) throw new Error("Running chat thread has no active attempt");
    this.activeMeetings.add(meetingId);
    const work = this.execute(meetingId, thread, attempt.id).finally(() => {
      this.active.delete(work);
      this.activeMeetings.delete(meetingId);
      lease.release();
    });
    this.active.add(work);
  }

  private async execute(meetingId: string, thread: MeetingChatThread, attemptId: string): Promise<void> {
    try {
      const transcript = await this.store.getTranscriptForMeeting(meetingId);
      if (!transcript || transcript.status !== "ready" || !transcript.publication) {
        throw new Error("Chat execution requires the immutable ready transcript");
      }
      const answer = await this.agent.execute({
        provider: thread.attempts.find((attempt) => attempt.id === attemptId)!.provider,
        model: thread.attempts.find((attempt) => attempt.id === attemptId)!.model,
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
    await mkdir(this.executionRoot, { recursive: true, mode: 0o700 });
    this.workspace ??= await this.paseo.workspaces.open(this.executionRoot);
    const resource = await startTranscriptMcp(input);
    this.resources.add(resource);
    let agent: Awaited<ReturnType<typeof this.workspace.agents.create>> | null = null;
    try {
      const provider = input.model.startsWith(`${input.provider}/`)
        ? input.model
        : `${input.provider}/${input.model}`;
      agent = await this.workspace.agents.create({
        config: {
          provider,
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { meeting: { type: "http", url: resource.url } },
          toolPolicy: {
            preapproved: [
              { kind: "mcp", server: "meeting", tool: "search_meeting_transcript" },
              { kind: "mcp", server: "meeting", tool: "get_meeting_segments" },
            ],
          },
          ...(input.provider === "codex" ? {
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
