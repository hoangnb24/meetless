import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { approvedProviderEnvironment, prepareRuntime, resolveRuntimeConfig } from "../src/config.js";

test("native provider environment allows only the approved Codex override", () => {
  expect(approvedProviderEnvironment(undefined)).toEqual({});
  expect(approvedProviderEnvironment("{}")).toEqual({});
  expect(approvedProviderEnvironment('{"codex":{"CODEX_HOME":"/approved/codex"}}')).toEqual({ codex: { CODEX_HOME: "/approved/codex" } });
  for (const value of [null, [], { codex: { CODEX_HOME: "relative" } }, { codex: { CODEX_HOME: "/approved\0/codex" } }, { codex: { HOME: "/other" } }, { codex: { CODEX_HOME: "/approved", NODE_OPTIONS: "--require=evil" } }, { claude: { HOME: "/other" } }]) {
    expect(() => approvedProviderEnvironment(JSON.stringify(value))).toThrow(/Invalid native provider environment/);
  }
  expect(() => approvedProviderEnvironment("invalid-json")).toThrow(/Invalid native provider environment/);
});

test("approved configuration reaches both Paseo provider env and metadata helpers without moving Meetless state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-provider-env-"));
  try {
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd(), environment: {
      ...process.env, HOME: "/unchanged/home", MEETLESS_PROVIDER_ENV: '{"codex":{"CODEX_HOME":"/approved/codex"}}',
    } });
    await prepareRuntime(config);
    const persisted = JSON.parse(await readFile(config.paths.config, "utf8"));
    expect(persisted.providers).toEqual({ codex: { env: { CODEX_HOME: "/approved/codex" } } });
    expect(config.environment.CODEX_HOME).toBe("/approved/codex");
    expect(config.environment.HOME).toBe("/unchanged/home");
    expect(config.environment.PASEO_HOME).toBe(path.join(root, "paseo-home"));
    expect(config.environment.MEETLESS_STORE_ROOT).toBe(path.join(root, "meeting-store"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
