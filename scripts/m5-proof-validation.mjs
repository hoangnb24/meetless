import {
  validateM4Observation,
  validateM4PublishedManifest,
  M4_EXPECTED_RANGES,
} from "./m4-proof-validation.mjs";

const AUTHORITY = "docs/plans/active/v1-paseo-foundation.md#milestone-5-chat-with-one-meeting";

export class M5ProofValidationError extends Error {
  constructor(stage, message, nextAction) {
    super(`M5 proof failed at ${stage}: ${message} (authority: ${AUTHORITY}). Next action: ${nextAction}`);
    this.name = "M5ProofValidationError";
    this.stage = stage;
  }
}

export function validateM5Observation(input) {
  requireValue(input?.schema === "MEETLESS_M5_COMPOSITION_OBSERVATION v1", "schema", "observation schema is missing", "emit the M5 v1 observation");
  validateM4Observation({ ...input, schema: "MEETLESS_M4_COMPOSITION_OBSERVATION v1" });
  const chat = input.chat ?? {};
  requireValue(chat.realCodex === true, "provider", "the chat turn did not use real Codex", "run the disposable question agent with the discovered Codex provider/model");
  requireValue(chat.provider === "codex" && typeof chat.model === "string" && chat.model.length > 0, "selection", "Codex provider/model selection is absent", "select the discovered Codex model through the real UI");
  requireValue(chat.supported?.outcome === "supported" && typeof chat.supported?.text === "string" && chat.supported.text.length > 0, "supported-answer", "the fixture question did not return a supported answer", "ask the exact third-interval question and validate structured output");
  requireValue(Array.isArray(chat.supported?.citationSegmentIds) && chat.supported.citationSegmentIds.includes(input.authoritativeTranscript?.segments?.[2]?.segmentId), "supported-citation", "the supported answer did not cite the expected third segment", "cite the retrieved 880 Hz transcript segment");
  requireValue(chat.citationPlayback?.boundedStopObserved === true && chat.citationPlayback?.markerHz === 880, "citation-playback", "the chat citation did not play the expected bounded 880 Hz interval", "click the rendered chat citation through the accepted playback callback");
  requireValue(chat.restart?.exactInstalledHost === true && chat.restart?.historyRestored === true, "restart", "full host restart did not restore durable chat", "stop and relaunch the exact installed host, then reopen the meeting");
  requireValue(chat.restart?.workspaceAbsentAfterRestart === true, "workspace-cleanup", "the neutral chat execution workspace remained active after host restart", "archive the runtime-owned workspace during chat shutdown and verify the active registry after restart");
  requireValue(chat.unsupported?.outcome === "insufficient_evidence" && chat.unsupported?.text === null && Array.isArray(chat.unsupported?.citationSegmentIds) && chat.unsupported.citationSegmentIds.length === 0, "insufficient-evidence", "unsupported follow-up was not the exact tagged no-answer result", "return insufficient_evidence with null text and no citations");
  requireValue(chat.unsupported?.canonicalRendered === true, "insufficient-rendering", "canonical insufficient-evidence wording was not rendered", "render the tagged outcome in the meeting chat panel");
  requireValue(chat.noPaseoIdentityPersisted === true, "persistence-privacy", "durable state contains a Paseo identity or timeline field", "persist only Meetless chat values and validated citations");
  requireValue(chat.transcriptRangeCount === M4_EXPECTED_RANGES.length, "meeting-scope", "chat was not scoped to the exact fixture transcript", "bind retrieval to the open target meeting transcript");
  return input;
}

export function validateM5PublishedManifest(input) {
  requireValue(input?.schema === "MEETLESS_M5_COMPOSITION_PROOF v1", "manifest-schema", "published schema is missing", "publish the M5 v1 manifest");
  validateM5Observation(input.observation);
  validateM4PublishedManifest({
    ...input,
    schema: "MEETLESS_M4_COMPOSITION_PROOF v1",
    frontierId: "M5-PROOF",
    observation: { ...input.observation, schema: "MEETLESS_M4_COMPOSITION_OBSERVATION v1" },
  });
  return input;
}

function requireValue(condition, stage, message, nextAction) {
  if (!condition) throw new M5ProofValidationError(stage, message, nextAction);
}
