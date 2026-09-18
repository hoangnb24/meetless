import { afterEach, describe, expect, test, vi } from "vitest";
import type { PluginContext } from "@paseo/plugin";
import type { MeetingStore } from "@meetless/meeting-store";
import type { MeetingChatThread, TranscriptState } from "@meetless/meeting-domain";
import { ChatControlsWireSchema, ChatFeatureDiscoveryWireSchema } from "@meetless/meeting-contracts";
import { parseManagedAskRequest, parseManagedAskAnswer, type ManagedAskRequest } from "../packages/meeting-contracts/src/managed-ask";
import contribute from "../packages/meetless-plugin/index";
import { MeetingChatService } from "../packages/meetless-plugin/src/chat-service";
import { ManagedMeetingChatAgentPort, dispatchManagedAsk, managedAskSelection, MANAGED_ASK_HOST_TIMEOUT_MS } from "../packages/meetless-plugin/src/managed-ask";
import { ManagedBackendRouter } from "../packages/meetless-plugin/src/managed-backend";
import { assertManagedAskAdmission } from "../convex/managedAskAdmission";
import { executeOpenAIAsk, extractAskUsage, managedAskProviderBody, MANAGED_ASK_TIMEOUT_MS } from "../convex/openAIAsk";
import { ask } from "../convex/managedAsk";

const request: ManagedAskRequest = {
  attemptId: "5ea26081-d765-4537-9731-c5674bd6e9c5", consent: true,
  segments: [{ segmentId: "s1", text: "We chose local ownership." }],
  messages: [{ role: "user", text: "What did we choose?" }],
};
const answer = { outcome: "supported" as const, text: "Local ownership.", citationSegmentIds: ["s1"] };
const response = (output: unknown = answer, usage?: unknown) => new Response(JSON.stringify({
  status: "completed", usage,
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("bounded managed Ask contracts and dispatch", () => {
  test("strict minimal transport and citation validation", () => {
    expect(parseManagedAskRequest(request)).toEqual(request);
    for (const data of [{ ...request, path: "/private/audio" }, { ...request, consent: undefined }, { ...request, segments: [{ ...request.segments[0], startMs: 0 }] }]) {
      expect(() => parseManagedAskRequest(data)).toThrow();
    }
    expect(parseManagedAskAnswer(answer, request.segments)).toEqual(answer);
    expect(() => parseManagedAskAnswer({ ...answer, citationSegmentIds: ["invented"] }, request.segments)).toThrow();
    expect(parseManagedAskAnswer({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }, request.segments)).toMatchObject({ outcome: "insufficient_evidence" });
  });

  test.each(["meeting.chat.ask", "meeting.chat.retry", "meeting.chat.ask.v1", "meeting.chat.retry.v1"])("public %s rejects absent/false consent before loading a host", async (name) => {
    const handle = vi.fn();
    const cleanup = contribute({ handle } as unknown as PluginContext);
    const [rpc, handler] = handle.mock.calls.find(([rpc]) => rpc.name === name)!;
    const input = name.endsWith(".v1") ? { meetingId: "m", question: "q", selection: managedAskSelection() } : { meetingId: "m", question: "q", provider: "openai", model: "gpt-5.6-luna" };
    if (name.includes("retry")) delete (input as { question?: string }).question;
    for (const consent of [undefined, false]) {
      await expect(handler(rpc.input.parse({ ...input, consent }), { paseo: {} })).rejects.toThrow("Confirm sending");
    }
    await cleanup();
  });

  test.each(["ask", "retry", "askWithSelection", "retryWithSelection"] as const)("service %s fails closed before any local turn mutation", async (method) => {
    const start = vi.fn();
    const store = { startChatQuestion: start, retryChatTurn: start, startChatQuestionWithSelection: start, retryChatTurnWithSelection: start } as unknown as MeetingStore;
    const service = new MeetingChatService(store, new ManagedMeetingChatAgentPort(vi.fn()));
    await expect(service[method]({ meetingId: "m", question: "q", ...managedAskSelection(), selection: managedAskSelection() })).rejects.toThrow("Confirm sending");
    expect(start).not.toHaveBeenCalled();
  });

  test.each(["ask", "retry"] as const)("legacy %s validates managed selection before creating a turn", async (method) => {
    const start = vi.fn();
    const store = { listChatThreads: async () => [], reconcileChatAfterRestart: async () => [], startChatQuestion: start, retryChatTurn: start } as unknown as MeetingStore;
    const service = new MeetingChatService(store, new ManagedMeetingChatAgentPort(vi.fn()));
    await expect(service[method]({ meetingId: "m", question: "q", provider: "codex", model: "old", consent: true })).rejects.toThrow("Managed Ask selection");
    expect(start).not.toHaveBeenCalled();
  });

  test("fixed controls replace only the new-request selection; host validates sent IDs", async () => {
    const dispatch = vi.fn(async () => answer);
    const port = new ManagedMeetingChatAgentPort(dispatch);
    const old = { ...managedAskSelection(), provider: "codex", model: "old" };
    const controls = ChatControlsWireSchema.parse(await port.getControls(old));
    expect(controls.lastSelection).toEqual(managedAskSelection());
    expect(old.model).toBe("old");
    expect(ChatFeatureDiscoveryWireSchema.parse(await port.discoverFeatures(managedAskSelection())).features).toEqual([]);
    const recordRetrieved = vi.fn(async () => undefined);
    const input = { ...managedAskSelection(), attemptId: request.attemptId, consent: true, messages: request.messages,
      transcript: { checkpoints: [{ range: { segmentId: "s1" }, text: request.segments[0]!.text }], audio: { destination: "private/audio" } } as TranscriptState, recordRetrieved };
    await expect(port.execute(input)).resolves.toEqual(answer);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    expect(recordRetrieved).toHaveBeenCalledExactlyOnceWith(["s1"]);
    dispatch.mockResolvedValueOnce({ ...answer, citationSegmentIds: ["bad"] });
    await expect(port.execute(input)).rejects.toThrow("invalid");
    expect(recordRetrieved).toHaveBeenCalledTimes(1);
    await expect(port.execute({ ...input, consent: undefined })).rejects.toThrow("Confirm sending");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test("async execution receives this attempt identity and consent before local completion", async () => {
    const sequence: string[] = [];
    const thread = { meetingId: "m", status: "running", activeAttemptId: request.attemptId,
      messages: [{ role: "user", text: "Question", createdAt: "2026-09-18T00:00:00.000Z" }],
      attempts: [{ id: request.attemptId, ...managedAskSelection() }] } as unknown as MeetingChatThread;
    const store = {
      listChatThreads: async () => [], reconcileChatAfterRestart: async () => [],
      startChatQuestionWithSelection: async () => thread,
      getTranscriptForMeeting: async () => ({ status: "ready", publication: {}, checkpoints: [{ range: { segmentId: "s1" }, text: "Evidence" }] }),
      recordChatRetrieval: async (_meeting: string, attemptId: string, ids: string[]) => { expect(attemptId).toBe(request.attemptId); expect(ids).toEqual(["s1"]); sequence.push("retrieved"); },
      completeChatTurn: vi.fn(async () => { sequence.push("complete"); }),
    };
    const dispatch = vi.fn(async (sent: ManagedAskRequest) => { expect(sent.attemptId).toBe(request.attemptId); expect(sent.consent).toBe(true); sequence.push("dispatch"); return answer; });
    const service = new MeetingChatService(store as unknown as MeetingStore, new ManagedMeetingChatAgentPort(dispatch));
    await service.askWithSelection({ meetingId: "m", question: "Question", selection: managedAskSelection(), consent: true });
    await vi.waitFor(() => expect(store.completeChatTurn).toHaveBeenCalledTimes(1));
    await service.close();
    expect(sequence).toEqual(["dispatch", "retrieved", "complete"]);
  });

  test.each(["unrouted", "PRODUCTION", "SANDBOX"] as const)("router %s captures a single operation and denies before authorization where required", async (environment) => {
    const refresh = vi.fn(async () => ({ authToken: "test-token", expiresAt: Date.now() + 100_000 }));
    const readProof = vi.fn(async () => ({ environment: environment === "unrouted" ? "SANDBOX" as const : environment, signedTransaction: "test-jws" }));
    const router = new ManagedBackendRouter(environment === "unrouted" ? { development: "https://dev.convex.cloud" } : { SANDBOX: "https://sandbox.convex.cloud", PRODUCTION: "https://prod.convex.cloud" }, () => ({ refresh }) as never, readProof);
    const action = vi.fn(async () => answer);
    const client = vi.fn((_endpoint: string, _token: string) => ({ action }) as never);
    const signal = new AbortController().signal;
    if (environment === "SANDBOX") {
      await expect(dispatchManagedAsk(router, request, signal, client)).resolves.toEqual(answer);
      expect(readProof).toHaveBeenCalledTimes(1);
      expect(client).toHaveBeenCalledExactlyOnceWith("https://sandbox.convex.cloud", "test-token", signal);
      expect(action).toHaveBeenCalledExactlyOnceWith("managedAsk:ask", { request });
    } else {
      await expect(dispatchManagedAsk(router, request, signal, client)).rejects.toThrow(/Sandbox|Production/);
      expect(refresh).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
    }
  });
});

test("pure admission: real active/grace Sandbox only, expiry finite and current", () => {
  const allowed = {
    config: { mode: "hosted-development", revenueCatEnvironment: "SANDBOX", providerMode: "real", appleVerifierMode: "app-store-server-api" },
    principal: { accountId: "a", lineageVerified: true, revokedAt: null as number | null, entitlement: "active", naturalExpiryAt: 2000 },
    lineages: [{ accountId: "a", adapter: "app-store-server-api", environment: "SANDBOX", currentState: "active", expiresAt: 2000, gracePeriodExpiresAt: 3000 }], now: 1000,
  };
  expect(() => assertManagedAskAdmission(allowed)).not.toThrow();
  expect(() => assertManagedAskAdmission({ ...allowed, principal: { ...allowed.principal, entitlement: "grace" }, lineages: [{ ...allowed.lineages[0]!, currentState: "grace", expiresAt: 500 }] })).not.toThrow();
  const denied = [
    { ...allowed, config: { ...allowed.config, revenueCatEnvironment: "PRODUCTION" } },
    { ...allowed, config: { ...allowed.config, mode: "test" } },
    ...["expired", "revoked", "refunded"].map((entitlement) => ({ ...allowed, principal: { ...allowed.principal, entitlement } })),
    ...[NaN, Infinity, 1000, undefined].map((naturalExpiryAt) => ({ ...allowed, principal: { ...allowed.principal, naturalExpiryAt } })),
    ...[{ adapter: "fixture" }, { environment: "PRODUCTION" }, { currentState: "revoked" }, { expiresAt: 1000 }, { currentState: "grace", gracePeriodExpiresAt: undefined }].map((patch) => ({ ...allowed, lineages: [{ ...allowed.lineages[0]!, ...patch }] })),
  ];
  for (const input of denied) expect(() => assertManagedAskAdmission(input)).toThrow("verified active Sandbox");
});

test("official foreground request shape, exact model, no storage/tools/token cap", async () => {
  const body = managedAskProviderBody(request);
  expect(body).toMatchObject({ model: "gpt-5.6-luna", store: false, background: false, text: { format: { type: "json_schema", strict: true } } });
  for (const key of ["tools", "conversation", "previous_response_id", "max_output_tokens", "files"]) expect(body).not.toHaveProperty(key);
  const fetcher = vi.fn(async () => response(answer, { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 6 }, output_tokens_details: { reasoning_tokens: 2 } }));
  const observe = vi.fn(async () => undefined);
  await expect(executeOpenAIAsk(request, "test-only-key", observe, fetcher as typeof fetch)).resolves.toEqual(answer);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: "supported", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cachedInputTokens: 5, cacheWriteInputTokens: 6, reasoningTokens: 2 } }));
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/test-only-key|Local ownership|What did/);
});

test("provider completion records usage even for invalid citations; absent counts remain null", async () => {
  const observe = vi.fn(async () => undefined);
  const fetcher = vi.fn(async () => response({ ...answer, citationSegmentIds: ["bad"] }, { input_tokens: 12 }));
  await expect(executeOpenAIAsk(request, "key", observe, fetcher as typeof fetch)).rejects.toThrow("No automatic retry");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: "invalid_answer", usage: { ...extractAskUsage(null), inputTokens: 12 } }));
});

test("timeout never retries or invents zero usage", async () => {
  vi.useFakeTimers();
  const observe = vi.fn(async () => undefined);
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("sensitive transport error"))); }));
  const result = expect(executeOpenAIAsk(request, "key", observe, fetcher as typeof fetch)).rejects.toThrow("No automatic retry");
  await vi.advanceTimersByTimeAsync(MANAGED_ASK_TIMEOUT_MS);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown", usage: extractAskUsage(null) }));
});

test("action denies before provider and sanitizes the action boundary", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const runQuery = vi.fn(async () => { throw new Error("private internal error"); });
  const runMutation = vi.fn();
  await expect(ask._handler({ runQuery, runMutation } as never, { request })).rejects.toThrow("Managed Ask could not complete");
  expect(fetcher).not.toHaveBeenCalled(); expect(runMutation).not.toHaveBeenCalled();
});

test("action persists only metadata after completed but invalid output", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-key");
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...answer, citationSegmentIds: ["unknown"] }, { input_tokens: 12 })));
  const runQuery = vi.fn(async () => ({ accountId: "test-account", deviceId: "test-device" }));
  const runMutation = vi.fn(async () => undefined);
  await expect(ask._handler({ runQuery, runMutation } as never, { request })).rejects.toThrow("No automatic retry");
  expect(runMutation).toHaveBeenCalledTimes(1);
  expect(runMutation.mock.calls[0]?.[1]).toEqual({ accountId: "test-account", deviceId: "test-device", attemptId: request.attemptId,
    model: "gpt-5.6-luna", status: "invalid_answer", latencyMs: expect.any(Number), usage: { ...extractAskUsage(null), inputTokens: 12 } });
});

test.each(["timeout", "shutdown"] as const)("host %s bounds stalled auth and prevents late provider dispatch", async (stop) => {
  vi.useFakeTimers();
  let authorize!: (value: { authToken: string }) => void;
  const refresh = vi.fn(() => new Promise<{ authToken: string }>((resolve) => { authorize = resolve; }));
  const router = new ManagedBackendRouter({ SANDBOX: "https://sandbox.convex.cloud", PRODUCTION: "https://prod.convex.cloud" }, () => ({ refresh }) as never,
    async () => ({ environment: "SANDBOX", signedTransaction: "test-jws" }));
  const action = vi.fn();
  const client = vi.fn(() => ({ action }) as never);
  const port = new ManagedMeetingChatAgentPort((request, signal) => dispatchManagedAsk(router, request, signal, client));
  const execution = port.execute({ ...managedAskSelection(), attemptId: request.attemptId, consent: true, messages: request.messages,
    transcript: { checkpoints: [{ range: { segmentId: "s1" }, text: "Evidence" }] } as TranscriptState, recordRetrieved: vi.fn() });
  const failed = expect(execution).rejects.toThrow("Provider outcome and usage may be unknown");
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  if (stop === "shutdown") await port.close();
  else await vi.advanceTimersByTimeAsync(MANAGED_ASK_HOST_TIMEOUT_MS);
  await failed;
  authorize({ authToken: "late-test-token" });
  await vi.advanceTimersByTimeAsync(0);
  expect(action).not.toHaveBeenCalled(); expect(client).not.toHaveBeenCalled();
});

test("host shutdown settles an uncooperative network wait without retry", async () => {
  const dispatch = vi.fn(() => new Promise<never>(() => {}));
  const port = new ManagedMeetingChatAgentPort(dispatch);
  const result = expect(port.execute({ ...managedAskSelection(), attemptId: request.attemptId, consent: true, messages: request.messages,
    transcript: { checkpoints: [{ range: { segmentId: "s1" }, text: "Evidence" }] } as TranscriptState, recordRetrieved: vi.fn() })).rejects.toThrow("cancellation is not confirmed");
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  await port.close();
  await result;
  expect(dispatch).toHaveBeenCalledTimes(1);
});
