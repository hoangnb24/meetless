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

test("cancelled folder chooser stays retryable and saved access requires a user restart", async () => {
  const onRequest = vi.fn(async () => undefined);
  const result: ProviderAccessResult = { outcome: "cancelled", providers: [{ id: "codex", status: "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ProviderFolderAccess result={result} provider={null} pending={false} error={null} onRequest={onRequest} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("Folder selection was cancelled");
  expect(renderer.root.findByProps({ testID: "provider-access-codex" }).props.accessibilityLabel).toBe("Grant codex folder access");
  await act(async () => renderer.root.findByProps({ testID: "provider-access-codex" }).props.onPress());
  expect(onRequest).toHaveBeenCalledExactlyOnceWith("codex");
  await act(async () => renderer.update(<ProviderFolderAccess result={{ ...result, outcome: "granted", providers: result.providers.map((entry) => entry.id === "codex" ? { ...entry, status: "restart_required" } : entry) }} provider="codex" pending={false} error={null} onRequest={onRequest} />));
  expect(JSON.stringify(renderer.toJSON())).toContain("Quit Meetless and reopen it");
  expect(renderer.root.findAllByProps({ testID: "provider-access-codex" })).toHaveLength(0);
  expect(onRequest).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});

test("keeps replacement for a saved Codex selection when the runtime is unavailable", async () => {
  const onRequest = vi.fn(async () => undefined);
  const result: ProviderAccessResult = { outcome: "status", providers: [{ id: "codex", status: "ready", executableSelection: "available" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ProviderFolderAccess
      result={result}
      provider="codex"
      pending={false}
      error={null}
      onRequest={onRequest}
      runtimeProviderUnavailable
    />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Codex is unavailable here");
  expect(renderer.root.findByProps({ testID: "provider-access-codex" }).props.accessibilityLabel).toBe("Choose Codex");
  await act(async () => { renderer.root.findByProps({ testID: "provider-access-codex" }).props.onPress(); });
  expect(onRequest).toHaveBeenCalledExactlyOnceWith("codex");
  await act(async () => renderer.unmount());
});

test("does not claim a replacement when Codex access has no executable capability", async () => {
  const onRequest = vi.fn(async () => undefined);
  const result: ProviderAccessResult = { outcome: "status", providers: [{ id: "codex", status: "ready" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" }] };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ProviderFolderAccess
      result={result}
      provider="codex"
      pending={false}
      error={null}
      onRequest={onRequest}
      runtimeProviderUnavailable
    />);
  });
  expect(renderer.root.findAllByProps({ testID: "provider-access-codex" })).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Choose the installed Codex program");
  expect(onRequest).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
