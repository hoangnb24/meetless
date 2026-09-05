import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRuntimeConfig, snapshotPackagedMediaClosure } from "../src/config.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("packaged media closure snapshot", () => {
  test("copies bin/lib bytes, modes, symlinks, and reuses the exact owned snapshot", async () => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    const second = await snapshotPackagedMediaClosure(fixture);

    expect(second).toEqual(first);
    expect(await readFile(first.ffmpeg, "utf8")).toBe("packaged ffmpeg\n");
    expect(await readFile(path.join(first.root, "lib", "libavdevice.62.dylib"), "utf8"))
      .toBe("packaged dylib\n");
    expect(await readlink(path.join(first.root, "lib", "libavdevice.dylib")))
      .toBe("libavdevice.62.dylib");
    expect((await lstat(first.ffmpeg)).mode & 0o7777).toBe(0o755);
    expect((await lstat(path.join(first.root, "lib", "libavdevice.62.dylib"))).mode & 0o7777).toBe(0o644);
    expect((await lstat(path.join(first.root, "lib", "libavdevice.dylib"))).isSymbolicLink()).toBe(true);
  });

  test.each([
    ["missing sibling library", async (fixture: MediaFixture) => {
      await rm(path.join(fixture.runtimeRoot, "media-tools", "lib"), { recursive: true });
    }],
    ["tampered sibling library", async (fixture: MediaFixture) => {
      await writeFile(path.join(fixture.runtimeRoot, "media-tools", "lib", "libavdevice.62.dylib"), "tampered\n");
    }],
  ])("fails closed for an existing %s snapshot", async (_label, mutate) => {
    const fixture = await mediaFixture();
    await snapshotPackagedMediaClosure(fixture);
    await mutate(fixture);
    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/missing, tampered, or partial/);
  });

  test("rejects a source symlink that escapes the packaged media root", async () => {
    const fixture = await mediaFixture();
    const outside = path.join(fixture.root, "outside.dylib");
    await writeFile(outside, "outside\n", { mode: 0o644 });
    await symlink(
      path.relative(path.join(fixture.sourceRoot, "lib"), outside),
      path.join(fixture.sourceRoot, "lib", "escape.dylib"),
    );

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/symlink .* escapes/);
  });

  test("adopts a complete changed packaged closure and removes the prior snapshot", async () => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "bin", "ffmpeg"), "updated packaged ffmpeg\n");
    await writeFile(path.join(fixture.sourceRoot, "lib", "libavdevice.62.dylib"), "updated packaged dylib\n");

    const second = await snapshotPackagedMediaClosure(fixture);
    expect(second.root).toBe(first.root);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await readFile(second.ffmpeg, "utf8")).toBe("updated packaged ffmpeg\n");
    expect(await readFile(path.join(second.root, "lib", "libavdevice.62.dylib"), "utf8"))
      .toBe("updated packaged dylib\n");
    expect(await readdir(fixture.runtimeRoot)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.(?:staging|previous)-/u),
    ]));
  });

  test("keeps the prior snapshot on a pre-publication replacement failure", async () => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "bin", "ffprobe"), "updated packaged ffprobe\n");

    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "before-replacement" }))
      .rejects.toThrow(/injected crash before media closure publication/);
    expect(await readFile(first.ffprobe, "utf8")).toBe("packaged ffprobe\n");
    expect(await readdir(fixture.runtimeRoot)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.staging-/u),
    ]));

    const recovered = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(recovered.ffprobe, "utf8")).toBe("updated packaged ffprobe\n");
    expect(await readdir(fixture.runtimeRoot)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.(?:staging|previous)-/u),
    ]));
  });

  test("restores the prior snapshot after a crash while replacing it", async () => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "bin", "ffmpeg"), "recovered packaged ffmpeg\n");

    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "after-old-rename" }))
      .rejects.toThrow(/old media closure was quarantined/);
    expect(await readdir(fixture.runtimeRoot)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.staging-/u),
      expect.stringMatching(/^media-tools\.previous-/u),
    ]));
    await expect(readFile(first.ffmpeg, "utf8")).rejects.toThrow();

    const recovered = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(recovered.ffmpeg, "utf8")).toBe("recovered packaged ffmpeg\n");
    expect(await readdir(fixture.runtimeRoot)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.(?:staging|previous)-/u),
    ]));
  });

  test("converges after publication with the new snapshot already visible", async () => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "bin", "ffmpeg"), "published packaged ffmpeg\n");

    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "after-rename" }))
      .rejects.toThrow(/injected crash after media closure publication/);
    expect(await readFile(first.ffmpeg, "utf8")).toBe("published packaged ffmpeg\n");
    expect(await readdir(fixture.runtimeRoot)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.previous-/u),
    ]));
    const previousName = (await readdir(fixture.runtimeRoot)).find((name) => /^media-tools\.previous-/u.test(name));
    expect(previousName).toBeDefined();
    await rm(path.join(fixture.runtimeRoot, previousName!, ".meetless-media-closure-owner.json"));
    await rm(path.join(fixture.runtimeRoot, previousName!, "lib"), { recursive: true });

    const recovered = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(recovered.ffmpeg, "utf8")).toBe("published packaged ffmpeg\n");
    expect(await readdir(fixture.runtimeRoot)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^media-tools\.(?:staging|previous)-/u),
    ]));
  });

  test("fails closed when a visible new closure has no durable previous-cleanup authorization", async () => {
    const fixture = await mediaFixture();
    await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "bin", "ffmpeg"), "published without authorization\n");

    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "after-rename" }))
      .rejects.toThrow(/injected crash after media closure publication/);
    const previousName = (await readdir(fixture.runtimeRoot)).find((name) => /^media-tools\.previous-/u.test(name));
    expect(previousName).toBeDefined();
    await rm(path.join(fixture.runtimeRoot, "media-tools.transaction.json"));

    await expect(snapshotPackagedMediaClosure(fixture))
      .rejects.toThrow(/no durable cleanup authorization/);
    expect(await readFile(path.join(fixture.runtimeRoot, previousName!, "bin", "ffmpeg"), "utf8"))
      .toBe("packaged ffmpeg\n");
  });

  test.each([
    ["incomplete", async (fixture: MediaFixture) => {
      await rm(path.join(fixture.sourceRoot, "lib"), { recursive: true });
    }, /packaged media closure must contain sibling bin and lib directories/],
    ["escaping", async (fixture: MediaFixture) => {
      const outside = path.join(fixture.root, "outside-updated.dylib");
      await writeFile(outside, "outside\n", { mode: 0o644 });
      await symlink(
        path.relative(path.join(fixture.sourceRoot, "lib"), outside),
        path.join(fixture.sourceRoot, "lib", "updated-escape.dylib"),
      );
    }, /symlink .* escapes/],
  ])("keeps the prior snapshot when the new closure is %s", async (_label, mutate, expected) => {
    const fixture = await mediaFixture();
    const first = await snapshotPackagedMediaClosure(fixture);
    await mutate(fixture);

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(expected);
    expect(await readFile(first.ffmpeg, "utf8")).toBe("packaged ffmpeg\n");
  });

  test("rejects a media source outside the verified package root", async () => {
    const fixture = await mediaFixture();
    const wrongPackageRoot = path.join(fixture.root, "other-package");
    await mkdir(wrongPackageRoot, { mode: 0o755 });
    await writeFile(path.join(wrongPackageRoot, "meetless-package.json"), "fixture package marker\n", { mode: 0o644 });
    await writeFile(path.join(wrongPackageRoot, "installation-contract.json"), "fixture installation contract\n", { mode: 0o644 });

    await expect(snapshotPackagedMediaClosure({ ...fixture, packageRoot: wrongPackageRoot }))
      .rejects.toThrow(/arbitrary source paths are rejected/);
  });

  test("rejects non-packaged paths and never falls back to host tools", async () => {
    const fixture = await mediaFixture();
    await expect(snapshotPackagedMediaClosure({
      ...fixture,
      ffmpeg: "/usr/bin/ffmpeg",
      ffprobe: "/usr/bin/ffprobe",
    })).rejects.toThrow(/packaged media root must be the package media directory/);
  });

  test("rejects an unowned partial runtime directory without deleting its contents", async () => {
    const fixture = await mediaFixture();
    const targetRoot = path.join(fixture.runtimeRoot, "media-tools");
    await mkdir(targetRoot, { mode: 0o700 });
    const sentinel = path.join(targetRoot, "sentinel");
    await writeFile(sentinel, "unowned\n", { mode: 0o600 });

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/owner marker is unavailable/);
    expect(await readFile(sentinel, "utf8")).toBe("unowned\n");
  });

  test("migrates only the exact legacy development tool cache", async () => {
    const fixture = await mediaFixture();
    const targetRoot = path.join(fixture.runtimeRoot, "media-tools");
    await mkdir(targetRoot, { mode: 0o700 });
    await writeFile(path.join(targetRoot, "ffmpeg"), "legacy ffmpeg\n", { mode: 0o700 });
    await writeFile(path.join(targetRoot, "ffprobe"), "legacy ffprobe\n", { mode: 0o700 });

    const snapshot = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(snapshot.ffmpeg, "utf8")).toBe("packaged ffmpeg\n");
    expect(await readFile(path.join(targetRoot, ".meetless-media-closure-owner.json"), "utf8"))
      .toMatch(/MEETLESS_PACKAGED_MEDIA_CLOSURE_OWNER v1/);
    expect((await readdir(fixture.runtimeRoot)).some((name) => name.startsWith("media-tools.legacy-"))).toBe(false);
  });

  test("does not migrate a legacy-like cache with any extra entry", async () => {
    const fixture = await mediaFixture();
    const targetRoot = path.join(fixture.runtimeRoot, "media-tools");
    await mkdir(targetRoot, { mode: 0o700 });
    await writeFile(path.join(targetRoot, "ffmpeg"), "legacy ffmpeg\n", { mode: 0o700 });
    await writeFile(path.join(targetRoot, "ffprobe"), "legacy ffprobe\n", { mode: 0o700 });
    await writeFile(path.join(targetRoot, "sentinel"), "keep\n", { mode: 0o600 });

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/owner marker is unavailable/);
    expect(await readFile(path.join(targetRoot, "sentinel"), "utf8")).toBe("keep\n");
  });

  test("recovers an owned staging directory after a crash before publication", async () => {
    const fixture = await mediaFixture();
    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "before-rename" })).rejects.toThrow(/injected crash before/);
    expect((await readdir(fixture.runtimeRoot)).some((name) => name.startsWith("media-tools.staging-"))).toBe(true);

    const recovered = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(recovered.ffmpeg, "utf8")).toBe("packaged ffmpeg\n");
    expect((await readdir(fixture.runtimeRoot)).some((name) => name.startsWith("media-tools.staging-"))).toBe(false);
  });

  test("reuses the complete directory unit after a crash after publication", async () => {
    const fixture = await mediaFixture();
    await expect(snapshotPackagedMediaClosure({ ...fixture, faultAt: "after-rename" })).rejects.toThrow(/injected crash after/);
    const recovered = await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(recovered.ffprobe, "utf8")).toBe("packaged ffprobe\n");
    expect(await readFile(path.join(recovered.root, "media-tools.snapshot.json"), "utf8")).toMatch(/MEETLESS_PACKAGED_MEDIA_CLOSURE v1/);
  });

  test("does not remove an unowned staging directory during recovery", async () => {
    const fixture = await mediaFixture();
    const unowned = path.join(fixture.runtimeRoot, "media-tools.staging-unowned");
    await mkdir(unowned, { mode: 0o700 });
    await writeFile(path.join(unowned, "sentinel"), "unowned\n", { mode: 0o600 });

    await snapshotPackagedMediaClosure(fixture);
    expect(await readFile(path.join(unowned, "sentinel"), "utf8")).toBe("unowned\n");
  });

  test("keeps resolved snapshot tools usable after the canonical source is moved", async () => {
    const fixture = await mediaFixture();
    const snapshot = await snapshotPackagedMediaClosure(fixture);
    const movedSource = path.join(fixture.root, "moved-media");
    await rename(fixture.sourceRoot, movedSource);

    const reused = await snapshotPackagedMediaClosure(fixture);
    expect(reused).toEqual(snapshot);
    expect(await readFile(reused.ffmpeg, "utf8")).toBe("packaged ffmpeg\n");
    expect(await readFile(path.join(reused.root, "lib", "libavdevice.62.dylib"), "utf8"))
      .toBe("packaged dylib\n");
  });

  test("requires an owned private runtime root", async () => {
    const fixture = await mediaFixture();
    await chmod(fixture.runtimeRoot, 0o755);

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/owned secure directory/);
  });

  test("packaged resource resolution rejects an escaping symlink", async () => {
    const fixture = await packagedResourceFixture();
    const outside = path.join(fixture.root, "outside-ffmpeg");
    await writeFile(outside, "outside\n", { mode: 0o755 });
    await rm(path.join(fixture.packageRoot, "runtime", "media", "bin", "ffmpeg"));
    await symlink(path.relative(path.join(fixture.packageRoot, "runtime", "media", "bin"), outside), path.join(fixture.packageRoot, "runtime", "media", "bin", "redirect"));
    await symlink("redirect", path.join(fixture.packageRoot, "runtime", "media", "bin", "ffmpeg"));

    expect(() => resolveRuntimeConfig({ repositoryRoot: fixture.packageRoot })).toThrow(/ffmpeg resource resolves outside the package root/);
  });
});

type MediaFixture = {
  root: string;
  runtimeRoot: string;
  packageRoot: string;
  sourceRoot: string;
  ffmpeg: string;
  ffprobe: string;
};

async function mediaFixture(): Promise<MediaFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-media-closure-"));
  roots.add(root);
  const runtimeRoot = path.join(root, "runtime");
  const packageRoot = path.join(root, "package");
  const sourceRoot = path.join(packageRoot, "runtime", "media");
  const bin = path.join(sourceRoot, "bin");
  const lib = path.join(sourceRoot, "lib");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o755 });
  await mkdir(lib, { recursive: true, mode: 0o755 });
  await writeFile(path.join(packageRoot, "meetless-package.json"), "fixture package marker\n", { mode: 0o644 });
  await writeFile(path.join(packageRoot, "installation-contract.json"), "fixture installation contract\n", { mode: 0o644 });
  await chmod(sourceRoot, 0o755);
  await writeFile(path.join(bin, "ffmpeg"), "packaged ffmpeg\n", { mode: 0o755 });
  await writeFile(path.join(bin, "ffprobe"), "packaged ffprobe\n", { mode: 0o755 });
  await writeFile(path.join(lib, "libavdevice.62.dylib"), "packaged dylib\n", { mode: 0o644 });
  await symlink("libavdevice.62.dylib", path.join(lib, "libavdevice.dylib"));
  return {
    root,
    runtimeRoot,
    packageRoot,
    sourceRoot,
    ffmpeg: path.join(bin, "ffmpeg"),
    ffprobe: path.join(bin, "ffprobe"),
  };
}

async function packagedResourceFixture(): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-packaged-resource-"));
  roots.add(root);
  const packageRoot = path.join(root, "package");
  const mediaBin = path.join(packageRoot, "runtime", "media", "bin");
  await mkdir(path.join(packageRoot, "renderer"), { recursive: true, mode: 0o755 });
  await mkdir(mediaBin, { recursive: true, mode: 0o755 });
  await mkdir(path.join(packageRoot, "runtime"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(packageRoot, "native"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(mediaBin, "ffmpeg"), "ffmpeg\n", { mode: 0o755 });
  await writeFile(path.join(mediaBin, "ffprobe"), "ffprobe\n", { mode: 0o755 });
  await writeFile(path.join(packageRoot, "runtime", "electron"), "electron\n", { mode: 0o755 });
  await writeFile(path.join(packageRoot, "runtime", "node"), "node\n", { mode: 0o755 });
  await writeFile(path.join(packageRoot, "native", "capture"), "capture\n", { mode: 0o755 });
  await writeFile(path.join(packageRoot, "installation-contract.json"), `${JSON.stringify({
    schema: "MEETLESS_INSTALLATION_CONTRACT v1",
    bundleIdentifier: "com.meetless.app",
    installPath: "/Applications/Meetless.app",
    userSupportRelativePath: "Library/Application Support/Meetless",
    recordingExportsRelativePath: "Documents/meetings",
    identityRelativePath: "host-identity.json",
    runtime: {
      paseoHomeRelativePath: "paseo-home",
      electronUserDataRelativePath: "electron-user-data",
      meetingStoreRelativePath: "meeting-store",
      logsRelativePath: "logs",
      daemonLogRelativePath: "logs/daemon.log",
      manifestRelativePath: "runtime.json",
      recordingSocketRelativePath: "paseo-home/recording-control.sock",
      transcriptionSocketRelativePath: "transcription.sock",
      transcriptionStagingRelativePath: "meeting-store/transcription-ranges",
      endpointPolicy: {
        schema: "MEETLESS_RUNTIME_ENDPOINTS v1",
        workingDirectory: "runtime-root",
        recordingEndpointName: "paseo-home/recording-control.sock",
        transcriptionEndpointName: "transcription.sock",
      },
    },
    listen: "127.0.0.1:16777",
    rendererOrigin: "http://127.0.0.1:18082",
    package: {
      rootRelativeToBundle: "Contents/Resources/meetless",
      markerFilename: "meetless-package.json",
      contractFilename: "installation-contract.json",
      hostConfigRelativeToBundle: "Contents/Resources/host-config.json",
      resources: {
        rendererRoot: "renderer",
        electronBinary: "runtime/electron",
        nodeBinary: "runtime/node",
        captureHelper: "native/capture",
        ffmpeg: "runtime/media/bin/ffmpeg",
        ffprobe: "runtime/media/bin/ffprobe",
      },
    },
    host: { executableRelativeToBundle: "Contents/MacOS/MeetlessHost", configFilename: "host-config.json" },
    dmg: { volumeName: "Meetless", appName: "Meetless.app", applicationsLinkName: "Applications", applicationsLinkTarget: "/Applications" },
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(packageRoot, "meetless-package.json"), `${JSON.stringify({
    schema: "MEETLESS_MACOS_PACKAGE v2",
    target: "macos-arm64",
    bundleIdentifier: "com.meetless.app",
    paseoCommit: "a2c8ff349ffdf6f500eb09270c7f44af4c018bfc",
    listen: "127.0.0.1:16777",
    rendererOrigin: "http://127.0.0.1:18082",
    installationContract: "installation-contract.json",
    installationContractSha256: "__CONTRACT_DIGEST__",
    hostBundlePath: "/Applications/Meetless.app",
    resources: {
      rendererRoot: "renderer",
      electronBinary: "runtime/electron",
      nodeBinary: "runtime/node",
      captureHelper: "native/capture",
      ffmpeg: "runtime/media/bin/ffmpeg",
      ffprobe: "runtime/media/bin/ffprobe",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const contract = await readFile(path.join(packageRoot, "installation-contract.json"));
  const markerPath = path.join(packageRoot, "meetless-package.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.installationContractSha256 = createHash("sha256").update(contract).digest("hex");
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return { root, packageRoot };
}
