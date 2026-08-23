import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";

const pairing = vi.hoisted(() => ({
  createDirectCompanionProfile: vi.fn(() => ({ type: "direct", endpoint: "192.168.1.20:6777" })),
  createRelayCompanionProfile: vi.fn(() => ({ type: "relay", serverId: "server-1" })),
}));

vi.mock("@meetless/client", () => pairing);

import { CompanionPairing } from "../src/CompanionPairing.js";

describe("companion pairing presentation", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = null;
    vi.clearAllMocks();
  });

  test("starts with the encrypted relay path and validates its complete link", async () => {
    const onPair = vi.fn(async () => undefined);
    await act(async () => {
      renderer = create(<CompanionPairing error={null} onPair={onPair} />);
    });
    expect(renderer!.root.findByProps({ testID: "pair-relay-form" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "pair-direct-form" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ testID: "pair-direct-entry" }).props.accessibilityLabel).toBe("Set up Direct LAN");

    await act(async () => { renderer!.root.findByProps({ testID: "pair-relay-offer" }).props.onChangeText("https://host.test/#offer=complete"); });
    await act(async () => { renderer!.root.findByProps({ testID: "pair-host" }).props.onPress(); });
    expect(pairing.createRelayCompanionProfile).toHaveBeenCalledWith("https://host.test/#offer=complete");
    expect(onPair).toHaveBeenCalledWith({ type: "relay", serverId: "server-1" });
  });

  test("keeps Direct LAN as a secondary path and returns to relay pairing", async () => {
    const onPair = vi.fn(async () => undefined);
    await act(async () => {
      renderer = create(<CompanionPairing error={null} onPair={onPair} />);
    });
    await act(async () => { renderer!.root.findByProps({ testID: "pair-direct-entry" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "pair-direct-form" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: "pair-relay-form" })).toHaveLength(0);
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: "Meetless host and port" }).props.onChangeText("192.168.1.20:6777");
      renderer!.root.findByProps({ accessibilityLabel: "Meetless direct password" }).props.onChangeText("host-secret");
    });
    await act(async () => { renderer!.root.findByProps({ testID: "pair-host" }).props.onPress(); });
    expect(pairing.createDirectCompanionProfile).toHaveBeenCalledWith({ endpoint: "192.168.1.20:6777", password: "host-secret" });
    expect(onPair).toHaveBeenCalledWith({ type: "direct", endpoint: "192.168.1.20:6777" });
    await act(async () => { renderer!.root.findByProps({ testID: "pair-relay-back" }).props.onPress(); });
    expect(renderer!.root.findByProps({ testID: "pair-relay-form" })).toBeTruthy();
  });
});
