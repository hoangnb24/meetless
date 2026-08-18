import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("macOS host script configuration", () => {
  test.each([
    "install-macos-host.mjs",
    "launch-macos-host.mjs",
    "stop-macos-host.mjs",
  ])("forwards the explicit isolated root and listener in %s", async (name) => {
    const source = await readFile(path.join(process.cwd(), "scripts", name), "utf8");
    expect(source).toContain("runtimeRoot: process.env.MEETLESS_RUNTIME_ROOT");
    expect(source).toContain("listen: process.env.MEETLESS_LISTEN");
  });
});
