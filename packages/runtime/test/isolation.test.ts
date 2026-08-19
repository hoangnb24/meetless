import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_MEETLESS_LISTEN,
  IsolationViolationError,
  prepareRuntime,
  resolveRuntimeConfig,
} from "../src/config.js";

const roots = new Set<string>();
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-runtime-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("daemon isolation invariant", () => {
  test("fixes every runtime-owned path and the plugin catalog before Paseo loads", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    const ffmpegSource = await readFile(config.environment.MEETLESS_FFMPEG!);
    const ffprobeSource = await readFile(config.environment.MEETLESS_FFPROBE!);
    await prepareRuntime(config);
    const persisted = JSON.parse(await readFile(config.paths.config, "utf8"));

    expect(config.listen).toBe(DEFAULT_MEETLESS_LISTEN);
    expect(config.environment).toMatchObject({
      PASEO_HOME: path.join(root, "paseo-home"),
      PASEO_ELECTRON_USER_DATA_DIR: path.join(root, "electron-user-data"),
      MEETLESS_STORE_ROOT: path.join(root, "meeting-store"),
      MEETLESS_FFMPEG: path.join(root, "media-tools", "ffmpeg"),
      MEETLESS_FFPROBE: path.join(root, "media-tools", "ffprobe"),
    });
    expect(await readFile(config.environment.MEETLESS_FFMPEG!)).toEqual(ffmpegSource);
    expect(await readFile(config.environment.MEETLESS_FFPROBE!)).toEqual(ffprobeSource);
    expect(persisted).toMatchObject({
      daemon: { listen: DEFAULT_MEETLESS_LISTEN, relay: { enabled: false } },
      pluginsEnabled: true,
      plugins: { meetless: { enabled: true, source: "directory" } },
    });
    expect(Buffer.byteLength(config.paths.recordingSocket)).toBeLessThanOrEqual(103);
  });

  test("rejects production port 6767 with an actionable authority pointer", () => {
    expect(() =>
      resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-safe", listen: "127.0.0.1:6767" }),
    ).toThrowError(/Refusing production Paseo port 6767.*docs\/plans\/active\/v1-paseo-foundation\.md/s);
  });

  test("rejects the production Paseo home and non-loopback listeners", () => {
    expect(() =>
      resolveRuntimeConfig({ runtimeRoot: "/Users/example/.paseo", userHome: "/Users/example" }),
    ).toThrow(IsolationViolationError);
    expect(() =>
      resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-safe", listen: "0.0.0.0:6777" }),
    ).toThrow(/explicit loopback/);
  });

  test("does not silently replace a corrupt isolated config", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    await prepareRuntime(config);
    await writeFile(config.paths.config, "{ corrupt\n", "utf8");

    await expect(prepareRuntime(config)).rejects.toThrow(/was not replaced/);
    expect(await readFile(config.paths.config, "utf8")).toBe("{ corrupt\n");
  });
});
