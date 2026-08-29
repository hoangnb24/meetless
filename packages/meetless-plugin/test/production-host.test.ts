import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertCapturePermissionResponse, assertProductionHostProvenance } from "../src/production-host.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("production recording host provenance", () => {
  test("accepts only typed authorized microphone and System Audio states", () => {
    const allowed = { requestId: "permission", type: "capture.permissions", ok: true, microphone: "authorized", systemAudio: "authorized" };
    expect(() => assertCapturePermissionResponse(allowed, "permission")).not.toThrow();
    expect(() => assertCapturePermissionResponse({ ...allowed, microphone: "notDetermined" }, "permission")).toThrow(/microphone\/notDetermined.*not ready/);
    expect(() => assertCapturePermissionResponse({ ...allowed, microphone: "denied" }, "permission")).toThrow(/microphone\/denied.*not ready/);
    expect(() => assertCapturePermissionResponse({ ...allowed, systemAudio: "denied" }, "permission")).toThrow(/systemAudio\/denied.*not ready/);
  });
  test("accepts the exact live MeetlessHost identity and keeps fixture mode exempt", async () => {
    const fixture = await hostFixture();
    await expect(assertProductionHostProvenance(fixture.environment, 400, fixture.dependencies)).resolves.toBeUndefined();
    await expect(assertProductionHostProvenance({ MEETLESS_CAPTURE_MODE: "fixture" }, 400, {
      parentPid: () => { throw new Error("fixture must not inspect production ancestry"); },
      executable: () => { throw new Error("fixture must not inspect production executable"); },
      readIdentity: async () => { throw new Error("fixture must not read production identity"); },
      inspectCode: () => { throw new Error("fixture must not inspect production signature"); },
    })).resolves.toBeUndefined();
  });

  test("rejects direct plugin ancestry and a live binary identity mismatch", async () => {
    const fixture = await hostFixture();
    await expect(assertProductionHostProvenance(fixture.environment, 400, {
      ...fixture.dependencies,
      parentPid: () => 1,
    })).rejects.toThrow(/rejected before helper spawn.*not an ancestor.*Authority.*runtime:host/s);

    await expect(assertProductionHostProvenance(fixture.environment, 400, {
      ...fixture.dependencies,
      executable: () => ({ ...fixture.executable, inode: fixture.executable.inode + 1 }),
    })).rejects.toThrow(/rejected before helper spawn.*device\/inode\/size differs.*Authority/s);
  });
});

async function hostFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-production-host-"));
  roots.add(root);
  const bundle = path.join(root, "Meetless.app");
  const executablePath = path.join(bundle, "Contents", "MacOS", "MeetlessHost");
  await mkdir(path.dirname(executablePath), { recursive: true });
  const binary = Buffer.from("frozen MeetlessHost test binary");
  await writeFile(executablePath, binary, { mode: 0o755 });
  const info = await stat(executablePath);
  const canonicalBundle = await realpath(bundle);
  const canonicalExecutable = await realpath(executablePath);
  const identity = {
    version: 1 as const,
    bundleIdentifier: "com.meetless.app" as const,
    bundlePath: bundle,
    bundleRealPath: canonicalBundle,
    executablePath: canonicalExecutable,
    designatedRequirement: 'cdhash H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    cdHash: "a".repeat(40),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    binaryDevice: info.dev,
    binaryInode: info.ino,
    binarySize: info.size,
  };
  const executable = { path: canonicalExecutable, device: info.dev, inode: info.ino, size: info.size };
  return {
    executable,
    environment: {
      MEETLESS_HOST_PID: "100",
      MEETLESS_HOST_BUNDLE_PATH: bundle,
      MEETLESS_HOST_IDENTITY_PATH: path.join(root, "host-identity.json"),
    },
    dependencies: {
      parentPid: (pid: number) => new Map([[400, 300], [300, 200], [200, 100], [100, 1]]).get(pid) ?? 1,
      executable: () => executable,
      readIdentity: async () => identity,
      inspectCode: () => ({ cdHash: identity.cdHash, designatedRequirement: identity.designatedRequirement }),
    },
  };
}
