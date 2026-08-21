import { describe, expect, test } from "vitest";

import { localDaemonWebSocketUrl } from "../src/desktop.js";

describe("desktop local daemon destination", () => {
  test("uses loopback for a wildcard listener without changing the daemon port", () => {
    expect(localDaemonWebSocketUrl("0.0.0.0:6777")).toBe("ws://127.0.0.1:6777/ws");
  });

  test.each([
    ["127.0.0.1:6777", "ws://127.0.0.1:6777/ws"],
    ["localhost:6777", "ws://localhost:6777/ws"],
    ["192.168.1.20:6777", "ws://192.168.1.20:6777/ws"],
  ])("preserves an explicit listener destination: %s", (listen, expected) => {
    expect(localDaemonWebSocketUrl(listen)).toBe(expected);
  });
});
