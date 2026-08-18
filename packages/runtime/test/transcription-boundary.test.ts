import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  copyEnvironmentWithoutOpenAiSecrets,
  isOpenAiSecretEnvironmentEntry,
  resolveRuntimeConfig,
} from "../src/config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("signed native transcription boundary", () => {
  test("copies allowed child configuration without mutating the caller environment", () => {
    const callerEnvironment = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "anthropic-fixture-value",
      OPENAI_API_KEY: "fixture-openai-value",
      CUSTOM_VALUE: "preserved",
      MEETLESS_FFMPEG: "/usr/bin/true",
      MEETLESS_FFPROBE: "/usr/bin/true",
    } satisfies NodeJS.ProcessEnv;
    const original = { ...callerEnvironment };

    const config = resolveRuntimeConfig({
      runtimeRoot: "/private/tmp/meetless-transcription-boundary-runtime",
      environment: callerEnvironment,
    });

    expect(callerEnvironment).toEqual(original);
    expect(config.environment).toMatchObject({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "anthropic-fixture-value",
      CUSTOM_VALUE: "preserved",
    });
    expect(config.environment.OPENAI_API_KEY).toBeUndefined();
  });

  test("removes OpenAI-secret names and key-shaped values but preserves unrelated providers", () => {
    const copied = copyEnvironmentWithoutOpenAiSecrets({
      OPEN_AI_SECRET: "named-secret",
      AZURE_OPENAI_ACCESS_TOKEN: "named-token",
      INNOCENT_ALIAS: "sk-proj-abcdefghijklmnop",
      OPENAI_BASE_URL: "https://example.invalid",
      GOOGLE_API_KEY: "google-fixture-value",
    });

    expect(copied).toEqual({
      OPENAI_BASE_URL: "https://example.invalid",
      GOOGLE_API_KEY: "google-fixture-value",
    });
    expect(isOpenAiSecretEnvironmentEntry("innocent", "ordinary-value")).toBe(false);
    expect(isOpenAiSecretEnvironmentEntry("innocent", "sk-abcdefghijklmnop")).toBe(true);
  });

  test("wires the host-known socket and private meeting-store staging directory", () => {
    const config = resolveRuntimeConfig({
      runtimeRoot: "/private/tmp/meetless-transcription-boundary-runtime",
      environment: { MEETLESS_FFMPEG: "/usr/bin/true", MEETLESS_FFPROBE: "/usr/bin/true" },
    });

    expect(config.paths.transcriptionStaging).toBe(
      "/private/tmp/meetless-transcription-boundary-runtime/meeting-store/transcription-ranges",
    );
    expect(config.environment.MEETLESS_TRANSCRIPTION_SOCKET).toBe(config.paths.transcriptionSocket);
    expect(config.environment.MEETLESS_TRANSCRIPTION_STAGING).toBe(config.paths.transcriptionStaging);
  });

  test("keeps the credential out of native IPC and any Paseo fallback", async () => {
    const capability = await readFile(
      path.join(repositoryRoot, "native/macos-host/TranscriptionCapability.swift"),
      "utf8",
    );
    expect(capability).not.toContain("PASEO");
    expect(capability).not.toContain("ProcessInfo.processInfo.environment");
    expect(capability).not.toContain("OPENAI_API_KEY");
  });
});
