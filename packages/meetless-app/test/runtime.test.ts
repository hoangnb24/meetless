import { afterEach, describe, expect, test, vi } from "vitest";
import { Platform } from "react-native";
import { resolveAppMode, resolveDaemonUrl, supportsDesktopRecording } from "../src/runtime.js";

describe("Meetless app runtime", () => {
  afterEach(() => {
    Platform.OS = "web";
    vi.unstubAllGlobals();
  });

  test("a desktop query without the pinned Electron bridge remains companion", () => {
    vi.stubGlobal("window", { location: { search: "?mode=desktop" } });
    expect(resolveAppMode()).toBe("companion");
  });

  test("the normal pinned Electron bridge grants desktop mode", () => {
    vi.stubGlobal("window", {
      location: { search: "" },
      paseoDesktop: { platform: "darwin", invoke: vi.fn() },
    });
    expect(resolveAppMode()).toBe("desktop");
    expect(supportsDesktopRecording()).toBe(true);
  });

  test("query parameters and non-macOS Electron shells cannot grant recording", () => {
    vi.stubGlobal("window", { location: { search: "?recording=true" }, paseoDesktop: { platform: "linux", invoke: vi.fn() } });
    expect(supportsDesktopRecording()).toBe(false);
  });

  test("native remains companion even when a desktop-shaped global is present", () => {
    Platform.OS = "ios";
    vi.stubGlobal("window", {
      paseoDesktop: { platform: "darwin", invoke: vi.fn() },
    });
    expect(resolveAppMode()).toBe("companion");
  });

  test("uses the connected daemon query on web and environment on native", () => {
    expect(resolveDaemonUrl({ platform: "web", search: "?daemon=ws%3A%2F%2F127.0.0.1%3A7777" })).toBe(
      "ws://127.0.0.1:7777/ws",
    );
    expect(resolveDaemonUrl({ platform: "ios", environmentUrl: "ws://127.0.0.1:8888/ws" })).toBe(
      "ws://127.0.0.1:8888/ws",
    );
  });

  test("does not read window.location in a React Native runtime", () => {
    vi.stubGlobal("window", {});
    expect(resolveDaemonUrl({ platform: "ios", environmentUrl: "ws://127.0.0.1:8888/ws" })).toBe(
      "ws://127.0.0.1:8888/ws",
    );
  });
});
