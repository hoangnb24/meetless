import { describe, expect, test } from "vitest";
import { runtimeEndpoint } from "../src/runtime-endpoints.js";

const composition = {
  schema: "MEETLESS_RUNTIME_ENDPOINTS v1" as const,
  mode: "packaged" as const,
  workingDirectory: process.cwd(),
  recording: {
    role: "recording" as const,
    name: "paseo-home/recording-control.sock",
    bindArgument: "paseo-home/recording-control.sock",
    canonicalPath: `${process.cwd()}/paseo-home/recording-control.sock`,
  },
  transcription: {
    role: "transcription" as const,
    name: "transcription.sock",
    bindArgument: "transcription.sock",
    canonicalPath: `${process.cwd()}/transcription.sock`,
  },
};

describe("plugin runtime endpoint adapter", () => {
  test("uses the host composition bind argument while retaining the absolute canonical socket", () => {
    const environment = {
      MEETLESS_RUNTIME_PACKAGED: "1",
      MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify(composition),
      MEETLESS_RECORDING_SOCKET: composition.recording.canonicalPath,
      MEETLESS_TRANSCRIPTION_SOCKET: composition.transcription.canonicalPath,
    };
    expect(runtimeEndpoint(environment, "recording")).toMatchObject({
      mode: "packaged",
      bindArgument: "paseo-home/recording-control.sock",
      canonicalPath: composition.recording.canonicalPath,
    });
    expect(runtimeEndpoint(environment, "transcription")).toMatchObject({
      mode: "packaged",
      bindArgument: "transcription.sock",
      canonicalPath: composition.transcription.canonicalPath,
    });
  });

  test.each([
    ["missing packaged composition", { MEETLESS_RUNTIME_PACKAGED: "1", MEETLESS_RECORDING_SOCKET: composition.recording.canonicalPath }],
    ["wrong policy version", { ...packagedEnvironment(), MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify({ ...composition, schema: "MEETLESS_RUNTIME_ENDPOINTS v0" }) }],
    ["wrong packaged bind argument", { ...packagedEnvironment(), MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify({ ...composition, recording: { ...composition.recording, bindArgument: composition.recording.canonicalPath } }) }],
    ["escaping canonical path", { ...packagedEnvironment(), MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify({ ...composition, recording: { ...composition.recording, canonicalPath: "/private/outside.sock" } }) }],
    ["wrong CWD", { ...packagedEnvironment(), MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify({ ...composition, workingDirectory: "/private/other" }) }],
    ["legacy canonical mismatch", { ...packagedEnvironment(), MEETLESS_RECORDING_SOCKET: "/private/other.sock" }],
  ] as const)("fails closed for %s", (_label, environment) => {
    expect(() => runtimeEndpoint(environment, "recording")).toThrow(
      /Runtime endpoint recording violates policy.*Authority:.*0005-mac-app-store-and-revenuecat.*Next action:/s,
    );
  });

  test("retains the explicit absolute development behavior when the versioned composition is absent", () => {
    const socket = "/private/tmp/meetless-development-recording.sock";
    expect(runtimeEndpoint({ MEETLESS_RECORDING_SOCKET: socket }, "recording")).toMatchObject({
      mode: "development",
      bindArgument: socket,
      canonicalPath: socket,
    });
  });

  test("allows a development composition to retain its absolute bind path without a packaged CWD contract", () => {
    const development = {
      ...composition,
      mode: "development" as const,
      recording: {
        ...composition.recording,
        bindArgument: composition.recording.canonicalPath,
      },
      transcription: {
        ...composition.transcription,
        bindArgument: composition.transcription.canonicalPath,
      },
    };
    expect(runtimeEndpoint({
      MEETLESS_RUNTIME_PACKAGED: "0",
      MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify(development),
      MEETLESS_RECORDING_SOCKET: development.recording.canonicalPath,
      MEETLESS_TRANSCRIPTION_SOCKET: development.transcription.canonicalPath,
    }, "recording")).toMatchObject({
      mode: "development",
      bindArgument: development.recording.canonicalPath,
    });
  });
});

function packagedEnvironment() {
  return {
    MEETLESS_RUNTIME_PACKAGED: "1",
    MEETLESS_RUNTIME_ENDPOINTS: JSON.stringify(composition),
    MEETLESS_RECORDING_SOCKET: composition.recording.canonicalPath,
    MEETLESS_TRANSCRIPTION_SOCKET: composition.transcription.canonicalPath,
  };
}
