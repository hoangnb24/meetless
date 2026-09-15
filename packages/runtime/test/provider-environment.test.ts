import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolveConfigFromPersisted } from "../../../vendor/paseo/packages/server/src/server/config.js";
import { loadPersistedConfig, PersistedConfigSchema } from "../../../vendor/paseo/packages/server/src/server/persisted-config.js";
import { approvedProviderEnvironment, copyEnvironmentWithoutCodexExecutable, prepareRuntime, resolveRuntimeConfig } from "../src/config.js";

test("native provider environment allows only the approved Codex override", () => {
  const selectedExecutable = "/Applications/Codex Desktop.app/Contents/MacOS/codex";
  expect(approvedProviderEnvironment(undefined)).toEqual({});
  expect(approvedProviderEnvironment("{}")).toEqual({});
  expect(approvedProviderEnvironment('{"codex":{"CODEX_HOME":"/approved/codex"}}')).toEqual({ codex: { CODEX_HOME: "/approved/codex" } });
  expect(approvedProviderEnvironment(JSON.stringify({ codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: selectedExecutable } }))).toEqual({
    codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: selectedExecutable },
  });
  for (const value of [
    null,
    [],
    { codex: { CODEX_EXECUTABLE: selectedExecutable } },
    { codex: { CODEX_HOME: "relative" } },
    { codex: { CODEX_HOME: "/approved\0/codex" } },
    { codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: "" } },
    { codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: "relative/codex" } },
    { codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: "/approved\0/codex" } },
    { codex: { CODEX_HOME: "/approved/codex", command: { mode: "replace", argv: [selectedExecutable] } } },
    { codex: { HOME: "/other" } },
    { codex: { CODEX_HOME: "/approved", NODE_OPTIONS: "--require=evil" } },
    { claude: { HOME: "/other" } },
  ]) {
    expect(() => approvedProviderEnvironment(JSON.stringify(value))).toThrow(/Invalid native provider environment/);
  }
  expect(() => approvedProviderEnvironment("invalid-json")).toThrow(/Invalid native provider environment/);
  expect(copyEnvironmentWithoutCodexExecutable({ CODEX_EXECUTABLE: selectedExecutable, PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
});

test("approved configuration reaches both Paseo provider env and metadata helpers without moving Meetless state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-provider-env-"));
  const selectedExecutable = "/Applications/Codex Desktop.app/Contents/MacOS/codex";
  try {
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd(), environment: {
      ...process.env,
      HOME: "/unchanged/home",
      CODEX_EXECUTABLE: "/ambient/codex-must-not-leak",
      MEETLESS_PROVIDER_ENV: JSON.stringify({ codex: { CODEX_HOME: "/approved/codex", CODEX_EXECUTABLE: selectedExecutable } }),
    } });
    await prepareRuntime(config);
    const persisted = JSON.parse(await readFile(config.paths.config, "utf8"));
    const consumed = loadPersistedConfig(config.paths.paseoHome);
    expect(persisted.agents.providers.codex).toEqual({
      env: { CODEX_HOME: "/approved/codex" },
      command: [selectedExecutable],
    });
    expect(consumed.agents?.providers?.codex?.env).toEqual({ CODEX_HOME: "/approved/codex" });
    expect(consumed.agents?.providers?.codex?.command).toEqual([selectedExecutable]);
    expect(consumed.agents?.providers?.codex?.env).not.toHaveProperty("CODEX_EXECUTABLE");
    const launchConfig = resolveConfigFromPersisted(config.paths.paseoHome, consumed, { env: config.environment });
    expect(launchConfig.agentProviderSettings?.codex?.env).toEqual({ CODEX_HOME: "/approved/codex" });
    expect(launchConfig.agentProviderSettings?.codex?.command).toEqual({ mode: "replace", argv: [selectedExecutable] });
    expect(launchConfig.agentProviderSettings?.codex?.command.argv).toHaveLength(1);
    expect(launchConfig.agentProviderSettings?.codex?.command.argv[0]).toBe(selectedExecutable);
    const rejected = PersistedConfigSchema.safeParse({
      ...persisted,
      agents: undefined,
      providers: { codex: { env: { CODEX_HOME: "/approved/codex" } } },
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unrecognized_keys", path: ["providers"], keys: ["codex"] }),
      ]));
    }
    const rejectedInvalidRuntimeCommandShape = PersistedConfigSchema.safeParse({
      ...persisted,
      agents: {
        ...persisted.agents,
        providers: {
          ...persisted.agents.providers,
          codex: { env: { CODEX_HOME: "/approved/codex" }, command: { mode: "replace", argv: [] } },
        },
      },
    });
    expect(rejectedInvalidRuntimeCommandShape.success).toBe(false);
    expect(config.environment.CODEX_HOME).toBe("/approved/codex");
    expect(config.environment.CODEX_EXECUTABLE).toBeUndefined();
    expect(config.environment.HOME).toBe("/unchanged/home");
    expect(config.environment.PASEO_HOME).toBe(path.join(root, "paseo-home"));
    expect(config.environment.MEETLESS_STORE_ROOT).toBe(path.join(root, "meeting-store"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
