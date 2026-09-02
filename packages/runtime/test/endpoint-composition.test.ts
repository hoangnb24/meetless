import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { runtimeEndpoint } from "../../meetless-plugin/src/runtime-endpoints.js";
import { buildRendererUrl } from "../src/desktop.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { parseRendererRuntimeEndpointComposition } from "../../meetless-client/src/runtime-endpoints.js";
import {
  composeRuntimeEndpointComposition,
  type RuntimeEndpointComposition,
  type RuntimeEndpointPolicy,
} from "../src/runtime-endpoints.js";

interface RuntimeEndpointGoldenVector {
  id: string;
  policy: RuntimeEndpointPolicy;
  composition: RuntimeEndpointComposition;
}

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

  test("keeps runtime, plugin, client, and renderer composition equal for golden roots", async () => {
    const vectors = JSON.parse(
      await readFile(new URL("./fixtures/runtime-endpoint-vectors.json", import.meta.url), "utf8"),
    ) as RuntimeEndpointGoldenVector[];
    expect(vectors.map((vector) => vector.id)).toEqual(["ordinary", "long-ascii", "long-unicode"]);

    const currentDirectory = vi.spyOn(process, "cwd");
    try {
      for (const vector of vectors) {
        const composed = composeRuntimeEndpointComposition({
          runtimeRoot: vector.composition.workingDirectory,
          packaged: true,
          policy: vector.policy,
        });
        expect(composed).toEqual(vector.composition);
        expect(composed.recording.bindArgument).toBe("paseo-home/recording-control.sock");
        expect(composed.transcription.bindArgument).toBe("transcription.sock");
        expect(Buffer.byteLength(composed.recording.bindArgument)).toBeLessThanOrEqual(103);
        expect(Buffer.byteLength(composed.transcription.bindArgument)).toBeLessThanOrEqual(103);
        if (vector.id !== "ordinary") {
          expect(Buffer.byteLength(composed.recording.canonicalPath)).toBeGreaterThan(103);
          expect(Buffer.byteLength(composed.transcription.canonicalPath)).toBeGreaterThan(103);
        }

        const environment = {
          MEETLESS_RUNTIME_PACKAGED: "1",
          MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify(vector.composition),
          MEETLESS_RECORDING_SOCKET: vector.composition.recording.canonicalPath,
          MEETLESS_TRANSCRIPTION_SOCKET: vector.composition.transcription.canonicalPath,
        };
        currentDirectory.mockReturnValue(vector.composition.workingDirectory);
        const rendererUrl = new URL("http://127.0.0.1/");
        rendererUrl.searchParams.set("meetlessEndpoints", JSON.stringify(vector.composition));
        expect(parseRendererRuntimeEndpointComposition(rendererUrl.toString())).toEqual(vector.composition);

        for (const role of ["recording", "transcription"] as const) {
          expect(runtimeEndpoint(environment, role)).toEqual({
            mode: "packaged",
            workingDirectory: vector.composition.workingDirectory,
            ...vector.composition[role],
          });
        }
      }
    } finally {
      currentDirectory.mockRestore();
    }
  });
});
