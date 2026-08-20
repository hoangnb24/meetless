import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { HostIdentity } from "../src/host.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  activateUiTestRun,
  newUiTestEnvelope,
  readConsumedUiTestMarkerSync,
  removeUiTestRunState,
  uiTestEnvelopePath,
  uiTestMarkerPath,
  writeUiTestEnvelope,
} from "../src/ui-test-envelope.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controlled UI-test envelope", () => {
  test("consumes one valid envelope and applies only run-scoped controls", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    const envelope = newUiTestEnvelope({ cdpPort: 45_321, transcriptionMode: "fake" });
    await writeUiTestEnvelope(root, envelope);

    const marker = await activateUiTestRun(config, hostIdentity());
    expect(marker?.runId).toBe(envelope.runId);
    expect(marker?.identity).toMatchObject({
      logicalDesktopId: "com.meetless.desktop",
      hostBundleIdentifier: "com.meetless.app",
      hostBundlePath: "/Users/example/Applications/Meetless.app",
      hostCdHash: "a".repeat(40),
      transcriptionMode: "fake",
      accessibility: "forced-controlled-runtime",
    });
    expect(config.paths.recordingExports).toBe(path.join(root, "ui-test-exports"));
    expect(config.environment).toMatchObject({
      MEETLESS_CAPTURE_MODE: "fixture",
      MEETLESS_TRANSCRIPTION_MODE: "fake",
      MEETLESS_UI_TEST_MODE: "1",
      MEETLESS_UI_TEST_RUN_ID: envelope.runId,
      PASEO_ELECTRON_FLAGS: "--remote-debugging-address=127.0.0.1 --remote-debugging-port=45321",
    });
    expect(readConsumedUiTestMarkerSync(root)?.runId).toBe(envelope.runId);
    await expect(readFile(uiTestEnvelopePath(root), "utf8")).rejects.toThrow();

    const second = await activateUiTestRun(config, hostIdentity());
    expect(second?.runId).toBe(envelope.runId);
    expect(readConsumedUiTestMarkerSync(root)?.identity.desktopPid).toBe(process.pid);
  });

  test.each([
    ["missing", undefined],
    ["invalid", "{not-json"],
    ["expired", JSON.stringify(newUiTestEnvelope({ cdpPort: 45_322, transcriptionMode: "fake", now: new Date(0), ttlMs: 1 }))],
  ])("keeps %s envelope in normal production mode", async (_label, contents) => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    if (contents !== undefined) await writeFile(uiTestEnvelopePath(root), contents, { mode: 0o600 });

    expect(await activateUiTestRun(config, hostIdentity())).toBeNull();
    expect(config.environment.MEETLESS_CAPTURE_MODE).toBeUndefined();
    expect(config.environment.PASEO_ELECTRON_FLAGS).toBeUndefined();
    expect(readConsumedUiTestMarkerSync(root)).toBeNull();
  });

  test("rejects a consumed marker attested to a different accepted host", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    await writeUiTestEnvelope(root, newUiTestEnvelope({ cdpPort: 45_323, transcriptionMode: "native" }));
    await activateUiTestRun(config, hostIdentity());

    await expect(activateUiTestRun(config, { ...hostIdentity(), cdHash: "b".repeat(40) })).rejects.toThrow(/host identity mismatch/);
    expect(readConsumedUiTestMarkerSync(root)?.identity.hostCdHash).toBe("a".repeat(40));
  });

  test("cleanup removes only the owned marker, envelope, and export tree", async () => {
    const root = await temporaryRoot();
    const config = resolveRuntimeConfig({ runtimeRoot: root, repositoryRoot: process.cwd() });
    await writeUiTestEnvelope(root, newUiTestEnvelope({ cdpPort: 45_324, transcriptionMode: "fake" }));
    await activateUiTestRun(config, hostIdentity());
    await removeUiTestRunState(root);
    await expect(readFile(uiTestMarkerPath(root), "utf8")).rejects.toThrow();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-ui-envelope-"));
  roots.push(root);
  return root;
}

function hostIdentity(): HostIdentity {
  return {
    version: 1,
    bundleIdentifier: "com.meetless.app",
    bundlePath: "/Users/example/Applications/Meetless.app",
    bundleRealPath: "/Users/example/Applications/Meetless.app",
    executablePath: "/Users/example/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
    designatedRequirement: "identifier \"com.meetless.app\"",
    cdHash: "a".repeat(40),
    binarySha256: "b".repeat(64),
    binaryDevice: 1,
    binaryInode: 2,
    binarySize: 3,
    configuration: {
      repositoryRoot: process.cwd(),
      runtimeRoot: "/tmp/meetless",
      listen: "127.0.0.1:6777",
      transcriptionSocket: "/tmp/transcription.sock",
      transcriptionStaging: "/tmp/transcription-ranges",
      nodePath: process.execPath,
      runtimeCliPath: "/tmp/packages/runtime/dist/cli.js",
      identityPath: "/tmp/host-identity.json",
    },
  };
}
