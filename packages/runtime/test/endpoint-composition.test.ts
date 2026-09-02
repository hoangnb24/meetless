import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { buildRendererUrl } from "../src/desktop.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { parseRendererRuntimeEndpointComposition } from "../../meetless-client/src/runtime-endpoints.js";

describe("runtime endpoint composition wiring", () => {
  test("publishes the same authoritative composition to the renderer that runtime adapters receive", () => {
    vi.stubEnv("MEETLESS_RENDERER_URL", "");
    const config = resolveRuntimeConfig({ runtimeRoot: "/private/meetless-endpoint-composition" });
    const rendererUrl = buildRendererUrl(config);

    expect(parseRendererRuntimeEndpointComposition(rendererUrl)).toEqual(config.endpoints);
    expect(new URL(rendererUrl).searchParams.get("daemon")).toBe("ws://127.0.0.1:6777/ws");
  });

  test("keeps packaged child CWD explicit and Electron module resolution independent of process.cwd", async () => {
    const desktopSource = await readFile("packages/runtime/src/desktop.ts", "utf8");
    const bootstrapSource = await readFile("scripts/electron-bootstrap.mjs", "utf8");

    expect(desktopSource).toContain("cwd: config.packaged ? config.paths.root : REPOSITORY_ROOT");
    expect(desktopSource).toContain("url.searchParams.set(\"meetlessEndpoints\"");
    expect(bootstrapSource).toContain("fileURLToPath(import.meta.url)");
    expect(bootstrapSource).toContain("../vendor/paseo/packages/desktop/dist/main.js");
    expect(bootstrapSource).not.toContain('path.resolve("vendor/paseo/packages/desktop/dist/main.js")');
  });
});
