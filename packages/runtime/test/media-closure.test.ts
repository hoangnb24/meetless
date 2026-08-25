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
import { homedir, tmpdir } from "node:os";
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

  test("rejects a changed or wrong source instead of replacing the owned snapshot", async () => {
    const fixture = await mediaFixture();
    await snapshotPackagedMediaClosure(fixture);
    await writeFile(path.join(fixture.sourceRoot, "lib", "libavdevice.62.dylib"), "wrong source\n");

    await expect(snapshotPackagedMediaClosure(fixture)).rejects.toThrow(/wrong-source snapshot/);
    expect(await readFile(path.join(fixture.runtimeRoot, "media-tools", "lib", "libavdevice.62.dylib"), "utf8"))
      .toBe("packaged dylib\n");
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
  sourceRoot: string;
  ffmpeg: string;
  ffprobe: string;
};

async function mediaFixture(): Promise<MediaFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-media-closure-"));
  roots.add(root);
  const runtimeRoot = path.join(root, "runtime");
  const sourceRoot = path.join(root, "package", "runtime", "media");
  const bin = path.join(sourceRoot, "bin");
  const lib = path.join(sourceRoot, "lib");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o755 });
  await mkdir(lib, { recursive: true, mode: 0o755 });
  await chmod(sourceRoot, 0o755);
  await writeFile(path.join(bin, "ffmpeg"), "packaged ffmpeg\n", { mode: 0o755 });
  await writeFile(path.join(bin, "ffprobe"), "packaged ffprobe\n", { mode: 0o755 });
  await writeFile(path.join(lib, "libavdevice.62.dylib"), "packaged dylib\n", { mode: 0o644 });
  await symlink("libavdevice.62.dylib", path.join(lib, "libavdevice.dylib"));
  return {
    root,
    runtimeRoot,
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
  await writeFile(path.join(packageRoot, "meetless-package.json"), `${JSON.stringify({
    schema: "MEETLESS_MACOS_PACKAGE v1",
    target: "macos-arm64",
    bundleIdentifier: "com.meetless.app",
    paseoCommit: "c81cb84735043c281a5a2d23d456d3708ce5d94e",
    rendererOrigin: "http://127.0.0.1:18082",
    runtimeRoot: "/private/tmp/meetless-package-runtime",
    recordingExports: "/private/tmp/meetless-package-runtime/exports",
    identityPath: "/private/tmp/meetless-package-host-identity.json",
    hostBundlePath: path.join(homedir(), "Applications", "Meetless.app"),
    resources: {
      rendererRoot: "renderer",
      electronBinary: "runtime/electron",
      nodeBinary: "runtime/node",
      captureHelper: "native/capture",
      ffmpeg: "runtime/media/bin/ffmpeg",
      ffprobe: "runtime/media/bin/ffprobe",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, packageRoot };
}
