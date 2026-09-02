import { describe, expect, test } from "vitest";
import {
  composeRuntimeEndpointComposition,
  DARWIN_UNIX_SOCKET_PATH_BYTES,
  MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
  MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
  parseRuntimeEndpointComposition,
  serializeRuntimeEndpointComposition,
  type RuntimeEndpointPolicy,
} from "../src/runtime-endpoints.js";

const policy: RuntimeEndpointPolicy = {
  schema: MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
  workingDirectory: MEETLESS_RUNTIME_ENDPOINT_WORKING_DIRECTORY,
  recordingEndpointName: "paseo-home/recording-control.sock",
  transcriptionEndpointName: "transcription.sock",
};

describe("versioned runtime endpoint composition", () => {
  test("composes one packaged descriptor with short bind arguments and canonical projections", () => {
    const composition = composeRuntimeEndpointComposition({
      runtimeRoot: "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless",
      packaged: true,
      policy,
    });

    expect(composition).toMatchObject({
      schema: MEETLESS_RUNTIME_ENDPOINTS_SCHEMA,
      mode: "packaged",
      workingDirectory: "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless",
      recording: {
        role: "recording",
        name: "paseo-home/recording-control.sock",
        bindArgument: "paseo-home/recording-control.sock",
        canonicalPath: "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless/paseo-home/recording-control.sock",
      },
      transcription: {
        role: "transcription",
        name: "transcription.sock",
        bindArgument: "transcription.sock",
        canonicalPath: "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless/transcription.sock",
      },
    });
    expect(parseRuntimeEndpointComposition(JSON.parse(serializeRuntimeEndpointComposition(composition)))).toEqual(composition);
  });

  test.each([
    ["wrong schema", { ...policy, schema: "MEETLESS_RUNTIME_ENDPOINTS v0" }],
    ["wrong working directory policy", { ...policy, workingDirectory: "repository-root" }],
    ["absolute recording name", { ...policy, recordingEndpointName: "/private/tmp/recording.sock" }],
    ["escaping recording name", { ...policy, recordingEndpointName: "../recording.sock" }],
    ["empty recording segment", { ...policy, recordingEndpointName: "paseo-home//recording.sock" }],
    ["current directory segment", { ...policy, recordingEndpointName: "./recording.sock" }],
    ["parent segment", { ...policy, recordingEndpointName: "paseo-home/../recording.sock" }],
    ["non-portable separator", { ...policy, recordingEndpointName: "paseo-home\\recording.sock" }],
    ["raw overlong ASCII name", { ...policy, recordingEndpointName: `${"a".repeat(DARWIN_UNIX_SOCKET_PATH_BYTES + 1)}.sock` }],
    ["raw overlong Unicode name", { ...policy, recordingEndpointName: `${"录".repeat(40)}.sock` }],
    ["duplicate role names", { ...policy, transcriptionEndpointName: policy.recordingEndpointName }],
  ] as const)("rejects %s before any listener can launch", (_label, invalidPolicy) => {
    expect(() => composeRuntimeEndpointComposition({
      runtimeRoot: "/private/runtime",
      packaged: true,
      policy: invalidPolicy,
    })).toThrow(/Runtime endpoint.*Authority:.*0005-mac-app-store-and-revenuecat.*Next action:/s);
  });

  test.each([
    ["wrong packaged bind argument", (value: ReturnType<typeof validComposition>) => ({ ...value, recording: { ...value.recording, bindArgument: value.recording.canonicalPath } })],
    ["canonical escape", (value: ReturnType<typeof validComposition>) => ({ ...value, transcription: { ...value.transcription, canonicalPath: "/private/outside/transcription.sock" } })],
    ["wrong descriptor role", (value: ReturnType<typeof validComposition>) => ({ ...value, recording: { ...value.recording, role: "transcription" } })],
    ["wrong composition mode", (value: ReturnType<typeof validComposition>) => ({ ...value, mode: "development" })],
    ["wrong working directory", (value: ReturnType<typeof validComposition>) => ({ ...value, workingDirectory: "/private/other" })],
  ] as const)("rejects %s when an adapter receives an inconsistent composition", (_label, mutate) => {
    expect(() => parseRuntimeEndpointComposition(mutate(validComposition()))).toThrow(
      /Runtime endpoint.*Authority:.*0005-mac-app-store-and-revenuecat.*Next action:/s,
    );
  });

  test("keeps effective packaged bind arguments identical across long ASCII and Unicode roots", () => {
    const roots = [
      `/Users/${"long-ascii-home-segment-".repeat(12)}/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless`,
      `/Users/${"用户家目录-".repeat(18)}/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless`,
    ];
    const compositions = roots.map((runtimeRoot) => composeRuntimeEndpointComposition({ runtimeRoot, packaged: true, policy }));
    for (const composition of compositions) {
      expect(composition.recording.bindArgument).toBe("paseo-home/recording-control.sock");
      expect(composition.transcription.bindArgument).toBe("transcription.sock");
      expect(Buffer.byteLength(composition.recording.bindArgument)).toBeLessThanOrEqual(DARWIN_UNIX_SOCKET_PATH_BYTES);
      expect(Buffer.byteLength(composition.transcription.bindArgument)).toBeLessThanOrEqual(DARWIN_UNIX_SOCKET_PATH_BYTES);
      expect(composition.recording.canonicalPath).toBe(`${composition.workingDirectory}/${policy.recordingEndpointName}`);
      expect(composition.transcription.canonicalPath).toBe(`${composition.workingDirectory}/${policy.transcriptionEndpointName}`);
      expect(composition.recording.canonicalPath.startsWith(`${composition.workingDirectory}/`)).toBe(true);
      expect(composition.transcription.canonicalPath.startsWith(`${composition.workingDirectory}/`)).toBe(true);
    }
    expect(compositions[0]?.recording.bindArgument).toBe(compositions[1]?.recording.bindArgument);
    expect(compositions[0]?.transcription.bindArgument).toBe(compositions[1]?.transcription.bindArgument);
  });
});

function validComposition() {
  return composeRuntimeEndpointComposition({ runtimeRoot: "/private/runtime", packaged: true, policy });
}
