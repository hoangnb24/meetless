import { Platform } from "react-native";

declare global {
  interface Window {
    paseoDesktop?: {
      platform?: unknown;
      invoke?: unknown;
    };
  }
}

export type MeetlessAppMode = "desktop" | "companion";

export function resolveAppMode(): MeetlessAppMode {
  if (Platform.OS !== "web" || typeof window === "undefined") return "companion";
  const bridge = window.paseoDesktop;
  const hasPinnedElectronBridge =
    bridge !== null &&
    typeof bridge === "object" &&
    ["darwin", "linux", "win32"].includes(String(bridge.platform)) &&
    typeof bridge.invoke === "function";
  return hasPinnedElectronBridge ? "desktop" : "companion";
}

export function resolveDaemonUrl(input: {
  platform?: string;
  search?: string;
  environmentUrl?: string;
} = {}): string {
  const platform = input.platform ?? Platform.OS;
  if (platform === "web") {
    const search = input.search ?? browserSearch();
    const queryValue = new URLSearchParams(search).get("daemon")?.trim();
    if (queryValue) return normalizeWebSocketUrl(queryValue);
  }
  const environmentUrl =
    input.environmentUrl ?? process.env.EXPO_PUBLIC_MEETLESS_DAEMON_URL ?? "ws://127.0.0.1:6777/ws";
  return normalizeWebSocketUrl(environmentUrl);
}

function browserSearch(): string {
  if (typeof window === "undefined" || !window.location) return "";
  return window.location.search;
}

function normalizeWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Meetless daemon URL must use ws:// or wss://, received ${url.protocol}`);
  }
  if (url.pathname === "/") url.pathname = "/ws";
  return url.toString().replace(/\/$/u, "");
}
