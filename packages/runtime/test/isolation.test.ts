import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_MEETLESS_LISTEN,
  IsolationViolationError,
  copyEnvironmentWithoutDirectPasswordSecrets,
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
      daemon: { listen: DEFAULT_MEETLESS_LISTEN, relay: { enabled: true } },
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

  test("rejects the production Paseo home, exact private binds, and public listeners", () => {
    expect(() =>
      resolveRuntimeConfig({ runtimeRoot: "/Users/example/.paseo", userHome: "/Users/example" }),
    ).toThrow(IsolationViolationError);
    expect(() =>
      resolveRuntimeConfig({ runtimeRoot: "/tmp/meetless-safe", listen: "8.8.8.8:6777" }),
    ).toThrow(/loopback or the password-protected 0\.0\.0\.0 wildcard/);
    for (const listen of ["10.0.0.20:6777", "172.16.0.20:6777", "192.168.1.20:6777"]) {
      expect(() => resolveRuntimeConfig({
        runtimeRoot: "/tmp/meetless-safe",
        listen,
        environment: { MEETLESS_DIRECT_PASSWORD: "direct-test-secret" },
      })).toThrow(/loopback or the password-protected 0\.0\.0\.0 wildcard.*Authority:.*Next action:/s);
    }
  });

  test("allows loopback and authenticated wildcard listeners while preserving isolated ownership", () => {
    for (const listen of ["127.0.0.1:6777", "localhost:6777", "[::1]:6777", "0.0.0.0:6777"]) {
      const config = resolveRuntimeConfig({
        runtimeRoot: "/tmp/meetless-safe",
        listen,
        environment: { ...process.env, MEETLESS_DIRECT_PASSWORD: "  direct-test-secret  " },
      });
      expect(config.listen).toBe(listen);
      expect(config.environment.PASEO_PASSWORD).toBe("direct-test-secret");
      expect(config.environment.MEETLESS_DIRECT_PASSWORD).toBeUndefined();
      expect(config.environment.PASEO_RELAY_ENABLED).toBe("true");
      expect(config.companion).toEqual({ relayEnabled: true, directPasswordConfigured: true });
    }
  });

  test("rejects blank direct secrets and strips both password keys from UI child environments", async () => {
    expect(() => resolveRuntimeConfig({
      runtimeRoot: "/tmp/meetless-safe",
      environment: { MEETLESS_DIRECT_PASSWORD: " \t " },
    })).toThrow(/direct password is blank.*Authority:.*Next action:/s);

    expect(copyEnvironmentWithoutDirectPasswordSecrets({
      SAFE_VALUE: "visible",
      MEETLESS_DIRECT_PASSWORD: "private-one",
      PASEO_PASSWORD: "private-two",
    })).toEqual({ SAFE_VALUE: "visible" });

    const desktopSource = await readFile("packages/runtime/src/desktop.ts", "utf8");
    expect(desktopSource).toContain("const nonSecretChildEnvironment = copyEnvironmentWithoutDirectPasswordSecrets(config.environment)");
    expect(desktopSource.match(/\.\.\.nonSecretChildEnvironment/g)).toHaveLength(2);
    expect(desktopSource).not.toMatch(/renderer = spawn\([\s\S]*?\.\.\.config\.environment[\s\S]*?electron = spawn/u);
  });

  test("rejects LAN exposure without Paseo direct password authentication", () => {
    expect(() => resolveRuntimeConfig({
      runtimeRoot: "/tmp/meetless-safe",
      listen: "0.0.0.0:6777",
      environment: {},
    })).toThrow(/has no direct password.*Authority:.*Next action:/s);
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
