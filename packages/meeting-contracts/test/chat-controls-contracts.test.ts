import { describe, expect, test } from "vitest";
import {
  ChatFeatureDiscoveryWireSchema,
  ChatProfileWireSchema,
  ChatSelectionWireSchema,
  MeetingChatControlsRpc,
  MeetingChatFeaturesRpc,
} from "../src/index.js";

const selection = {
  provider: "codex",
  model: "gpt-5",
  modeId: "worker",
  thinkingOptionId: "medium",
  featureValues: { fast_mode: true, effort: "high", inherited: null },
};

describe("chat controls wire contracts", () => {
  test("accepts a complete transport-neutral selection and versioned capability", () => {
    expect(ChatSelectionWireSchema.parse(selection)).toEqual(selection);
    expect(MeetingChatControlsRpc.input.parse({})).toEqual({});
    expect(MeetingChatFeaturesRpc.input.parse({ selection })).toEqual({ selection });
  });

  test("rejects non-primitive selection values and raw profile fields", () => {
    expect(() => ChatSelectionWireSchema.parse({ ...selection, featureValues: { fast_mode: { enabled: true } } })).toThrow();
    expect(() => ChatProfileWireSchema.parse({
      id: "profile-1",
      name: "Safe profile",
      icon: null,
      color: null,
      selection,
      notes: "daemon internal note",
    })).toThrow();
  });

  test("does not represent provider feature failures as an empty ready list", () => {
    expect(() => ChatFeatureDiscoveryWireSchema.parse({
      version: 1,
      selection,
      status: "ready",
      features: null,
      error: { kind: "unavailable", message: "Provider unavailable" },
    })).toThrow();
    expect(ChatFeatureDiscoveryWireSchema.parse({
      version: 1,
      selection,
      status: "unavailable",
      features: null,
      error: { kind: "unavailable", message: "Provider unavailable" },
    })).toMatchObject({ status: "unavailable", features: null });
  });
});
