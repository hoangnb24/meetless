import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const forbiddenSandboxInspector = /spawnSync\(\s*(?:["'](?:ps|lsof|codesign)["']|inspector)|meetless-process-argv/u;

describe("packaged host-attestation composition", () => {
  test("keeps packaged startup on the native capability path with no tool fallback", async () => {
    const [host, desktop, readiness, cli, plugin, capture] = await Promise.all([
      readFile("packages/runtime/src/host.ts", "utf8"),
      readFile("packages/runtime/src/desktop.ts", "utf8"),
      readFile("packages/runtime/src/readiness.ts", "utf8"),
      readFile("packages/runtime/src/cli.ts", "utf8"),
      readFile("packages/meetless-plugin/src/production-host.ts", "utf8"),
      readFile("native/macos-capture/Sources/MeetlessCapture/main.swift", "utf8"),
    ]);

    const desktopAttestation = sourceBetween(
      host,
      "export async function assertDesktopLaunchedByHost",
      "  const identity = await assertInstalledHostIdentity",
    );
    expect(desktopAttestation).toContain("attestPackagedDesktop");
    expect(desktopAttestation).not.toMatch(forbiddenSandboxInspector);

    const pluginAttestation = sourceBetween(
      plugin,
      "  const packaged = environment.MEETLESS_RUNTIME_PACKAGED === \"1\"",
      "  const hostPid",
    );
    expect(pluginAttestation).toContain("assertPackagedPluginProvenance");
    expect(pluginAttestation).not.toMatch(forbiddenSandboxInspector);

    const packagedReadiness = sourceBetween(
      readiness,
      "async function inspectOwnedRuntime(",
      "  const live = inspectLiveProcess",
    );
    expect(packagedReadiness).toContain("inspectPackagedOwnedRuntime");
    expect(packagedReadiness).not.toMatch(forbiddenSandboxInspector);

    const packagedDaemonGate = sourceBetween(
      cli,
      "export async function assertPackagedDaemonOwnedByHost",
      "  if (config.packaged)",
    );
    expect(packagedDaemonGate).toContain('attestPackagedProcess(config, "daemon", currentPid)');
    expect(packagedDaemonGate).not.toMatch(forbiddenSandboxInspector);

    const packagedShutdown = sourceBetween(
      desktop,
      "const packagedShutdownInspection",
      "interface PackagedRegistration",
    );
    expect(packagedShutdown).toContain("probeTcpListener");
    expect(packagedShutdown).not.toMatch(forbiddenSandboxInspector);

    expect(capture).toContain("do { try attestPackagedCaptureHelper() }");
    expect(capture.indexOf("do { try attestPackagedCaptureHelper() }")).toBeLessThan(capture.indexOf("while let line"));
    expect(capture).not.toMatch(/\b(?:ps|lsof|codesign|meetless-process-argv)\b/u);

    expect(capture).toContain("hostProcessProtocolRequest(bindArgument: endpointName");
    expect(capture).not.toContain("appendingPathComponent(endpointName)");
    const retryLoop = sourceBetween(capture, "var lastFailure: Error?", "  throw lastFailure");
    expect(retryLoop.indexOf("for attempt")).toBeGreaterThanOrEqual(0);
    expect(retryLoop.indexOf("let requestId = UUID().uuidString")).toBeGreaterThan(retryLoop.indexOf("for attempt"));
    expect(capture).toContain("validCaptureHelperEndpointName(bindArgument)");
  });

  test("registers a packaged helper before sending its start command and exits on attestation failure", async () => {
    const [helper, capture] = await Promise.all([
      readFile("packages/meetless-plugin/src/capture-helper.ts", "utf8"),
      readFile("native/macos-capture/Sources/MeetlessCapture/main.swift", "utf8"),
    ]);
    expect(helper.indexOf("await this.options.registerProcess")).toBeGreaterThanOrEqual(0);
    const startCommand = `await this.commandAndWait(\n      "started"`;
    expect(helper.indexOf("await this.options.registerProcess")).toBeLessThan(helper.indexOf(startCommand));
    expect(helper).toContain('"MEETLESS_HOST_PROCESS_ENDPOINT"');
    expect(capture.indexOf("diagnostic(\"packaged native capture helper could not attest through MeetlessHost\")")).toBeGreaterThanOrEqual(0);
    expect(capture.indexOf("diagnostic(\"packaged native capture helper could not attest through MeetlessHost\")")).toBeLessThan(capture.indexOf("while let line"));
  });
});

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing source marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing source marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}
