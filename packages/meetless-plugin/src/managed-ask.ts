import {
  MANAGED_ASK_MODEL, MANAGED_ASK_PROVIDER, parseManagedAskAnswer, parseManagedAskRequest,
  requireManagedAskConsent, type ManagedAskRequest,
} from "@meetless/meeting-contracts/managed-ask";
import type { ChatSelection } from "@meetless/meeting-domain";
import type { ChatControlsWire, ChatFeatureDiscoveryWire } from "@meetless/meeting-contracts";
import type { AgentAnswer, ChatExecutionInput, MeetingChatAgentPort } from "./chat-service.js";
import type { ManagedBackendRouter } from "./managed-backend.js";
import { ConvexHttpManagedFunctionClient } from "./managed-upload.js";

export const MANAGED_ASK_HOST_TIMEOUT_MS = 150_000;
export const MANAGED_ASK_HOST_FAILURE = "Managed Ask did not complete. Provider outcome and usage may be unknown; cancellation is not confirmed. No automatic retry was made. Check subscription access or connection before retrying.";

export function managedAskSelection(): ChatSelection {
  return { provider: MANAGED_ASK_PROVIDER, model: MANAGED_ASK_MODEL, modeId: null, thinkingOptionId: null, featureValues: {} };
}

/** Captures one router operation and rejects unsupported environments before authorization. */
export async function dispatchManagedAsk(
  router: ManagedBackendRouter,
  request: ManagedAskRequest,
  signal: AbortSignal,
  createClient = (endpoint: string, authToken: string, signal: AbortSignal) => new ConvexHttpManagedFunctionClient(endpoint, {
    authToken,
    fetch: (input, init) => fetch(input, { ...init, signal }),
  }),
): Promise<unknown> {
  signal.throwIfAborted();
  if (!router.routed) throw new Error("Managed Ask is available only on the enrolled Sandbox route.");
  const operation = await router.select();
  signal.throwIfAborted();
  if (operation.context.environment !== "SANDBOX") throw new Error("Managed Ask is not enabled for Production.");
  const credential = await router.authorize(operation);
  signal.throwIfAborted();
  return createClient(operation.context.endpoint, credential.authToken, signal).action("managedAsk:ask", { request });
}

export class ManagedMeetingChatAgentPort implements MeetingChatAgentPort {
  readonly requiresExplicitConsent = true;
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(private readonly dispatch: (request: ManagedAskRequest, signal: AbortSignal) => Promise<unknown>) {}

  async listProviders() {
    return [{ id: MANAGED_ASK_PROVIDER, label: "Meetless Managed Ask", models: [{ id: MANAGED_ASK_MODEL, label: "Managed Ask", isDefault: true }] }];
  }
  async getControls(_lastSelection: ChatSelection | null): Promise<ChatControlsWire> {
    return {
      version: 1,
      catalog: { providers: [{
        id: MANAGED_ASK_PROVIDER, label: "Meetless Managed Ask", status: "ready", error: null,
        modes: [], defaultModeId: null,
        models: [{ id: MANAGED_ASK_MODEL, label: "Managed Ask", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null }],
      }] },
      profiles: [], catalogError: null,
      // Old attempts remain untouched; only the controls for a new request use this selection.
      lastSelection: managedAskSelection(), lastSelectionState: "available", lastSelectionError: null,
    };
  }
  async validateSelection(selection: ChatSelection): Promise<ChatSelection> {
    if (selection.provider !== MANAGED_ASK_PROVIDER || selection.model !== MANAGED_ASK_MODEL ||
        selection.modeId !== null || selection.thinkingOptionId !== null || Object.keys(selection.featureValues).length) {
      throw new Error("Use the Meetless Managed Ask selection for new questions and retries.");
    }
    return managedAskSelection();
  }
  async discoverFeatures(selection: ChatSelection): Promise<ChatFeatureDiscoveryWire> {
    return { version: 1, selection: await this.validateSelection(selection), status: "ready", features: [], error: null };
  }
  async execute(input: ChatExecutionInput): Promise<AgentAnswer> {
    if (this.closed) throw new Error(MANAGED_ASK_HOST_FAILURE);
    requireManagedAskConsent(input.consent);
    await this.validateSelection(input.selection ?? { provider: input.provider, model: input.model, modeId: null, thinkingOptionId: null, featureValues: {} });
    const request = parseManagedAskRequest({
      attemptId: input.attemptId, consent: input.consent,
      segments: input.transcript.checkpoints.map((checkpoint) => ({ segmentId: checkpoint.range.segmentId, text: checkpoint.text })),
      messages: input.messages.map((message) => ({ role: message.role, text: message.text })),
    });
    if (this.closed) throw new Error(MANAGED_ASK_HOST_FAILURE);
    let result: unknown;
    const controller = new AbortController();
    this.active.add(controller);
    let rejectWait!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectWait = () => reject(new Error(MANAGED_ASK_HOST_FAILURE));
      controller.signal.addEventListener("abort", rejectWait, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(), MANAGED_ASK_HOST_TIMEOUT_MS);
    try {
      // Bounds auth and transport even if an underlying wait does not implement cancellation.
      // The dispatch checks the signal after auth, so a late credential cannot start inference.
      result = await Promise.race([this.dispatch(request, controller.signal), cancelled]);
    } catch { throw new Error(MANAGED_ASK_HOST_FAILURE); }
    finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", rejectWait);
      this.active.delete(controller);
    }
    const answer = parseManagedAskAnswer(result, request.segments);
    await input.recordRetrieved(request.segments.map((segment) => segment.segmentId));
    return answer;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
  }
}
