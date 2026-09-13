import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
vi.mock("@meetless/client", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "web" }, View: "View", Text: "Text", Pressable: "Pressable", SafeAreaView: "SafeAreaView", StyleSheet: { create: (x: unknown) => x }, useWindowDimensions: () => ({ width: 1200 }) }));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("@meetless/meeting-surface", () => ({}));
vi.mock("../src/recording-provider.js", () => ({}));
vi.mock("../src/CompanionPairing.js", () => ({}));
vi.mock("../src/playback.js", () => ({}));
import { ProviderFolderAccess } from "../src/App.js";
import type { ProviderAccessResult } from "@meetless/meeting-contracts";

test("cancelled chooser stays retryable and saved access requires a user restart", async () => {
  const onRequest = vi.fn(async () => undefined);
  const result: ProviderAccessResult = { outcome: "cancelled", providers: [{ id: "codex", status: "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ProviderFolderAccess result={result} provider={null} pending={false} error={null} onRequest={onRequest} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("cancelled");
  await act(async () => renderer.root.findByProps({ testID: "provider-access-codex" }).props.onPress());
  expect(onRequest).toHaveBeenCalledExactlyOnceWith("codex");
  await act(async () => renderer.update(<ProviderFolderAccess result={{ ...result, outcome: "granted", providers: result.providers.map((entry) => entry.id === "codex" ? { ...entry, status: "restart_required" } : entry) }} provider="codex" pending={false} error={null} onRequest={onRequest} />));
  expect(JSON.stringify(renderer.toJSON())).toContain("Quit Meetless and reopen it");
  expect(renderer.root.findAllByProps({ testID: "provider-access-codex" })).toHaveLength(0);
  expect(onRequest).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
