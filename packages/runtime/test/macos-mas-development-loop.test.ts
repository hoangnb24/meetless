import { cp, mkdtemp, mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertExactMasDevelopmentInstallPath,
  prepareMasUpdateDirectory,
  parseMasDevelopmentLoopArguments,
  prepareMasDevelopmentCandidate,
  assertMasUpdateStopped,
  updateMasDevelopmentInstall,
  assertNoLegacyMasEvidence,
  parseSimpleDotenv,
  publishCurrentMasDevelopmentArtifact,
  resolveMasDevelopmentLoopPaths,
} from "../../../scripts/lib/macos-mas-development-loop.mjs";

import { acquireMasGateLock } from "../../../scripts/lib/macos-mas-gate-lock.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
})));

describe("simple MAS development loop", () => {
  test("fixes the durable artifact, install, and disposable runtime paths", () => {
    const paths = resolveMasDevelopmentLoopPaths("/repo", "/Users/owner");
    expect(paths.bundlePath).toBe("/repo/.artifacts/macos-mas-development/current/release/macos/Meetless.app");
    expect(paths.installPath).toBe("/Applications/Meetless.app");
    expect(paths.runtimeRoot).toBe("/Users/owner/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless");
    expect(assertExactMasDevelopmentInstallPath(paths.installPath)).toBe(paths.installPath);
  });

  test("rejects alternate install targets and legacy transaction evidence", () => {
    expect(() => assertExactMasDevelopmentInstallPath("/Applications/Other.app")).toThrow("exactly /Applications/Meetless.app");
    expect(() => assertNoLegacyMasEvidence([".meetless-mas-gate-session.active"])).toThrow("blocks the simple development loop");
  });

  test("loads only simple named dotenv values", () => {
    expect(parseSimpleDotenv("CONVEX_URL=https://example.convex.cloud\nKEY='value' # comment\n")).toEqual({
      CONVEX_URL: "https://example.convex.cloud",
      KEY: "value",
    });
    expect(() => parseSimpleDotenv("export KEY=value\n")).toThrow("unsupported line");
  });

  test("publishes a validated current artifact and preserves the current one when validation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-simple-mas-test-"));
    roots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "durable", "current");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(source, "candidate.txt"), "new");
    await writeFile(path.join(destination, "candidate.txt"), "old");
    const copyTree = (from: string, to: string) => cp(from, to, { recursive: true });
    await publishCurrentMasDevelopmentArtifact({
      sourceProofRoot: source,
      destinationProofRoot: destination,
      copyTree,
      validate: async (candidate: string) => {
        expect(await readFile(path.join(candidate, "candidate.txt"), "utf8")).toBe("new");
      },
    });
    expect(await readFile(path.join(destination, "candidate.txt"), "utf8")).toBe("new");

    await writeFile(path.join(source, "candidate.txt"), "invalid");
    await expect(publishCurrentMasDevelopmentArtifact({
      sourceProofRoot: source,
      destinationProofRoot: destination,
      copyTree,
      validate: async (candidate: string) => {
        if (await readFile(path.join(candidate, "candidate.txt"), "utf8") !== "new") throw new Error("invalid candidate");
      },
    })).rejects.toThrow("invalid candidate");
    expect(await readFile(path.join(destination, "candidate.txt"), "utf8")).toBe("new");
  });
});


describe("data-preserving MAS update", () => {
  test("refuses legacy state, live hosts, handles and inspection errors", async () => {
    const paths = resolveMasDevelopmentLoopPaths("/repo", "/Users/owner");
    const quiet = async () => ({ stdout: "" });
    for (const name of [".meetless-mas-gate-session.active"]) {
      await expect(assertMasUpdateStopped(paths, { list: async () => [name], execute: quiet })).rejects.toThrow();
    }
    await expect(assertMasUpdateStopped(paths, { list: async () => [], execute: async () => ({ stdout: "/Applications/Meetless.app/Contents/MacOS/Meetless" }) })).rejects.toThrow("host to be stopped");
    await expect(assertMasUpdateStopped(paths, { list: async () => [], execute: async (file: string) => ({ stdout: file.endsWith("ps") ? "" : "open handle" }) })).rejects.toThrow("no open");
    await expect(assertMasUpdateStopped(paths, { list: async () => [], execute: async (file: string) => {
      if (file.endsWith("ps")) return { stdout: "" };
      throw Object.assign(new Error("denied"), { code: 1, stderr: "permission denied" });
    } })).rejects.toThrow("denied");
    await assertMasUpdateStopped(paths, { list: async () => [".meetless-mas-gate.lock"], execute: quiet });
  });

  test.each(["success", "signature", "partial-prepare"])("keeps runtime and a backup for %s", async (scenario) => {
    const fail = scenario !== "success";
    const root = await mkdtemp(path.join(tmpdir(), "meetless-update-test-"));
    roots.push(root);
    const paths = { ...resolveMasDevelopmentLoopPaths(root, root), runtimeRoot: path.join(root, "runtime") };
    const installed = path.join(root, "installed");
    await mkdir(installed);
    await mkdir(paths.bundlePath, { recursive: true });
    await mkdir(paths.runtimeRoot);
    await writeFile(path.join(installed, "app"), "old");
    await writeFile(path.join(paths.bundlePath, "app"), "new");
    await writeFile(path.join(paths.runtimeRoot, "recording"), "keep me");
    const mapped = (candidate: string) => candidate === paths.installPath ? installed : candidate;
    let stops = 0;
    let prepares = 0;
    let held = false;
    const operation = updateMasDevelopmentInstall(paths, {
      acquireLock: async () => {
        held = true;
        return { assertHeld: async () => { expect(held).toBe(true); }, release: async () => { held = false; } };
      },
      assertStopped: async (_paths: unknown, options?: { allowMissingApp: boolean }) => {
        expect(held).toBe(true);
        stops += 1;
        if (stops === 3) expect(options?.allowMissingApp).toBe(true);
      },
      inspect: async (target: string) => (await import("node:fs/promises")).lstat(mapped(target)),
      copyTree: async (from: string, to: string) => cp(mapped(from), mapped(to), { recursive: true }),
      prepareInstall: async () => {
        expect(held).toBe(true);
        prepares += 1;
        await (await import("node:fs/promises")).rm(installed, { recursive: true, force: true });
        if (scenario === "partial-prepare" && prepares === 1) throw new Error("mkdir failed after rm");
        await mkdir(installed);
      },
      validateInstalled: async () => { if (fail) throw new Error("bad signature"); },
    });
    if (fail) await expect(operation).rejects.toThrow("previous app restored, runtime untouched");
    else await operation;
    expect(stops).toBe(fail ? 3 : 2);
    expect(held).toBe(false);
    expect(await readFile(path.join(installed, "app"), "utf8")).toBe(fail ? "old" : "new");
    expect(await readFile(path.join(paths.runtimeRoot, "recording"), "utf8")).toBe("keep me");
    const { readdir } = await import("node:fs/promises");
    const backupParent = path.join(path.dirname(paths.proofRoot), "update-backups");
    const [backup] = await readdir(backupParent);
    expect(await readFile(path.join(backupParent, backup!, "runtime/recording"), "utf8")).toBe("keep me");
    expect(await readFile(path.join(backupParent, backup!, "Meetless.app/app"), "utf8")).toBe("old");
  });
});


test("rollback absence proof skips only an absent app and still checks host, runtime and listener", async () => {
  const paths = resolveMasDevelopmentLoopPaths("/repo", "/Users/owner");
  const probes: string[][] = [];
  const options = {
    list: async () => [],
    allowMissingApp: true,
    inspect: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    execute: async (_file: string, args: string[]) => { probes.push(args); return { stdout: "" }; },
  };
  await assertMasUpdateStopped(paths, options);
  expect(probes).toEqual([["-axo", "command="], ["+D", paths.runtimeRoot], ["-nP", "-iTCP:16777", "-sTCP:LISTEN"]]);
  await expect(assertMasUpdateStopped(paths, { ...options, execute: async (file: string) => ({ stdout: file.endsWith("ps") ? "" : "live" }) })).rejects.toThrow("no open");
});

test.skipIf(process.platform !== "darwin")("native stable lock rejects another holder and reuses the unlocked inode", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-update-lock-")));
  roots.push(root);
  const options = { parentPath: root, packageParentPath: root };
  const first = await acquireMasGateLock(options);
  const before = await lstat(first.lockPath);
  try {
    await expect(acquireMasGateLock(options)).rejects.toThrow();
    await first.assertHeld();
  } finally {
    await first.release();
  }
  const second = await acquireMasGateLock(options);
  try {
    expect((await lstat(second.lockPath)).ino).toBe(before.ino);
    await second.assertHeld();
  } finally {
    await second.release();
  }
});

test("update refuses a held lock before copying or replacing anything", async () => {
  const paths = resolveMasDevelopmentLoopPaths("/repo", "/Users/owner");
  await expect(updateMasDevelopmentInstall(paths, {
    acquireLock: async () => { throw new Error("held by host"); },
    validateInstalled: async () => {},
    assertStopped: async () => { throw new Error("must not inspect after refused lock"); },
    copyTree: async () => { throw new Error("must not copy"); },
  })).rejects.toThrow("could not acquire the stable host lock");
});


describe("current-user update preparation", () => {
  const target = "/Applications/Meetless.app";
  const owned = { uid: process.getuid!(), isDirectory: () => true, isSymbolicLink: () => false };
  test("uses only filesystem removal/creation with validated parent and final ownership", async () => {
    const calls: string[] = [];
    await prepareMasUpdateDirectory(target, {
      assertParent: async (parent: string) => { expect(parent).toBe("/Applications"); calls.push("parent"); },
      inspect: async () => { calls.push("inspect"); return owned; },
      remove: async () => { calls.push("remove"); },
      makeDirectory: async () => { calls.push("mkdir"); },
    });
    expect(calls).toEqual(["parent", "inspect", "remove", "mkdir", "inspect"]);
  });
  test.each(["path", "owner", "symlink", "uid", "parent", "permission", "missing", "final-owner"])("rejects %s without elevation", async (failure) => {
    let inspections = 0;
    let removed = false;
    const options = {
      uid: failure === "uid" ? process.getuid!() + 1 : process.getuid!(),
      assertParent: async () => { if (failure === "parent") throw new Error("parent rejected"); },
      inspect: async () => {
        inspections += 1;
        if (failure === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { ...owned, uid: failure === "owner" || (failure === "final-owner" && inspections === 2) ? -1 : owned.uid,
          isSymbolicLink: () => failure === "symlink" };
      },
      remove: async () => { removed = true; if (failure === "permission") throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
      makeDirectory: async () => {},
    };
    await expect(prepareMasUpdateDirectory(failure === "path" ? "/Applications/Other.app" : target, options)).rejects.toThrow();
    expect(removed).toBe(["permission", "final-owner"].includes(failure));
  });
  test("allows a missing exact app only for rollback", async () => {
    let inspections = 0;
    await prepareMasUpdateDirectory(target, {
      allowMissingApp: true,
      assertParent: async () => {},
      inspect: async () => {
        if (inspections++ === 0) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return owned;
      },
      remove: async (_target: string, options: { force: boolean }) => { expect(options.force).toBe(true); },
      makeDirectory: async () => {},
    });
  });
});

test("reuse-current bypasses only production and still rejects invalid current artifacts", async () => {
  expect(parseMasDevelopmentLoopArguments(["update", "--reuse-current"])).toEqual({ command: "update", reuseCurrent: true });
  expect(() => parseMasDevelopmentLoopArguments(["fresh", "--reuse-current"])).toThrow("Usage");
  for (const reuseCurrent of [true, false]) {
    let produced = false;
    const artifactBinding = { candidate: "frozen-signed-candidate" };
    const result = await prepareMasDevelopmentCandidate({ reuseCurrent, proofRoot: "/current", produce: async () => { produced = true; },
      validate: async (proofRoot: string) => { expect(proofRoot).toBe("/current"); return { artifactBinding }; } });
    expect(produced).toBe(!reuseCurrent);
    expect(result.artifactBinding).toBe(artifactBinding);
  }
  await expect(prepareMasDevelopmentCandidate({ reuseCurrent: true, proofRoot: "/current", produce: async () => { throw new Error("must not rebuild"); },
    validate: async () => { throw new Error("expected configuration mismatch"); } })).rejects.toThrow("expected configuration mismatch");
  const script = await readFile(new URL("../../../scripts/macos-mas-development-loop.mjs", import.meta.url), "utf8");
  expect(script).toContain("validate: validateProofRoot");
  expect(script).toContain("dependencies: expected");
  expect(script).toContain("artifactBinding: validation.artifactBinding");
});
