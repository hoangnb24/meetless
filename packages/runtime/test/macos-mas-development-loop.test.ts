import { cp, mkdtemp, mkdir, readFile, writeFile, lstat, realpath, chmod, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertExactMasDevelopmentInstallPath,
  probeMasDevelopmentPlugin,
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
    assertParent: async () => {},
    acquireLock: async () => { throw new Error("held by host"); },
    validateInstalled: async () => {},
    assertStopped: async () => { throw new Error("must not inspect after refused lock"); },
    copyTree: async () => { throw new Error("must not copy"); },
  })).rejects.toThrow("could not acquire the stable host lock");
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


test("fresh readiness child avoids real Node pre-build module cache", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-readiness-cache-")));
  roots.push(root);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { pathToFileURL } = await import("node:url");
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../scripts/lib/macos-mas-development-loop.mjs")).href;
  const program = `
    import { writeFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const root = process.argv[1];
    const contracts = path.join(root, "contracts.mjs");
    const client = path.join(root, "client.mjs");
    await writeFile(contracts, "export const original = true;");
    await import(pathToFileURL(contracts).href);
    await writeFile(contracts, "export const original = true; export const addedAfterBuild = 2;");
    await writeFile(client, [
      "import { addedAfterBuild } from './contracts.mjs';",
      "export async function connectMeetlessClient(options) {",
      "  if (options.url !== 'ws://127.0.0.1:16777/ws' || options.clientType !== 'cli') throw new Error('wrong endpoint');",
      "  return { client: { listMeetings: async () => Array(addedAfterBuild).fill({}) }, close: async () => {} };",
      "}",
    ].join("\\n"));
    let staleCacheFailed = false;
    try { await import(pathToFileURL(client).href); }
    catch (error) { staleCacheFailed = error.message.includes("does not provide an export named 'addedAfterBuild'"); }
    if (!staleCacheFailed) throw new Error("same-process regression was not reproduced");
    const { probeMasDevelopmentPlugin } = await import(process.argv[2]);
    const result = await probeMasDevelopmentPlugin(pathToFileURL(client).href);
    if (result.meetingCount !== 2) throw new Error("fresh child did not read rebuilt contracts");
    process.stdout.write("old-cache-reproduced;fresh-child-passed");
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program, root, moduleUrl]);
  expect(result.stdout).toBe("old-cache-reproduced;fresh-child-passed");
});


test("readiness child failure reports a category without module or client details", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-readiness-error-")));
  roots.push(root);
  const { pathToFileURL } = await import("node:url");
  const client = path.join(root, "client.mjs");
  await writeFile(client, "throw new Error('private-client-detail');");
  await expect(probeMasDevelopmentPlugin(pathToFileURL(client).href)).rejects.toThrow(/^Meetless plugin readiness probe failed$/);
});


describe.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)("whole-app preserving swap", () => {
  test.each(["success", "stage-signature", "second-move", "installed-signature", "collision", "ambiguous"])("retains protected receipt and runtime for %s", async (scenario) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-receipt-swap-")));
    roots.push(root);
    const packageParent = path.join(root, "Applications");
    const runtimeParent = path.join(root, "data");
    await mkdir(packageParent, { mode: 0o700 });
    await mkdir(runtimeParent, { mode: 0o700 });
    const paths = { ...resolveMasDevelopmentLoopPaths(root, root), runtimeParent, runtimeRoot: path.join(runtimeParent, "runtime") };
    const mapped = (value: string) => value.startsWith("/Applications/") ? path.join(packageParent, path.basename(value)) : value;
    const installed = mapped(paths.installPath);
    const receiptDirectory = path.join(installed, "Contents/_MASReceipt");
    await mkdir(receiptDirectory, { recursive: true });
    await writeFile(path.join(receiptDirectory, "receipt"), "OS-owned receipt fixture");
    await writeFile(path.join(installed, "app"), "old");
    await chmod(receiptDirectory, 0o500);
    const original = await lstat(installed);
    const receipt = await lstat(path.join(receiptDirectory, "receipt"));
    await mkdir(paths.bundlePath, { recursive: true });
    await writeFile(path.join(paths.bundlePath, "app"), "new");
    await mkdir(paths.runtimeRoot);
    await writeFile(path.join(paths.runtimeRoot, "recording"), "keep me");
    const runtimeIdentity = await lstat(paths.runtimeRoot);
    let moves = 0;
    let released = false;
    const validated: string[] = [];
    let reported = false;
    const lock = await acquireMasGateLock({ parentPath: runtimeParent, packageParentPath: packageParent });
    const lockIdentity = await lstat(lock.lockPath);
    try {
      const operation = updateMasDevelopmentInstall(paths, {
        assertParent: async (parent: string) => { expect(parent).toBe("/Applications"); },
        acquireLock: async () => ({
          assertHeld: () => lock.assertHeld(),
          release: async () => { await lock.release(); released = true; },
          renameNoReplace: async (from: string, to: string, options: { pathClass: string; authorizedParentPath: string }) => {
            expect(options).toEqual({ pathClass: "package-sibling", authorizedParentPath: "/Applications" });
            moves += 1;
            if (moves === 1) {
              expect(validated).toEqual([expect.stringContaining(".Meetless-update-")]);
              expect(reported).toBe(true);
            }
            if (scenario === "collision" && moves === 1) {
              await mkdir(mapped(to));
              await writeFile(path.join(mapped(to), "collision"), "do not overwrite");
            }
            if ((scenario === "second-move" || scenario === "ambiguous") && moves === 2) {
              if (scenario === "ambiguous") {
                await mkdir(mapped(to));
                await writeFile(path.join(mapped(to), "foreign"), "do not move");
              }
              throw new Error("injected second-move failure");
            }
            await lock.renameNoReplace(mapped(from), mapped(to), { pathClass: "package-sibling", authorizedParentPath: packageParent });
          },
        }),
        assertStopped: async () => { await lock.assertHeld(); },
        inspect: (target: string) => lstat(mapped(target)),
        makeDirectory: (target: string, options: { mode: number }) => mkdir(mapped(target), options),
        copyTree: (from: string, to: string) => cp(mapped(from), mapped(to), { recursive: true }),
        reportPrepared: async () => { reported = true; },
        validateInstalled: async (target: string) => {
          validated.push(target);
          expect(await readFile(path.join(mapped(target), "app"), "utf8")).toBe("new");
          if (scenario === "stage-signature" || (scenario === "installed-signature" && target === paths.installPath)) throw new Error("injected signature failure");
        },
      });
      if (scenario === "success") {
        const result = await operation;
        expect(await readFile(path.join(mapped(result.retainedAppPath), "app"), "utf8")).toBe("old");
      } else {
        await expect(operation).rejects.toThrow(scenario === "stage-signature" ? "before replacement" :
          ["collision", "ambiguous"].includes(scenario) ? "preserve ambiguous state" : "previous whole app restored");
      }
      expect(released).toBe(true);
      const entries = await readdir(packageParent);
      const oldRoot = scenario === "success" || scenario === "ambiguous"
        ? path.join(packageParent, entries.find((entry) => entry.startsWith(".Meetless-previous-"))!) : installed;
      expect((await lstat(oldRoot)).ino).toBe(original.ino);
      expect((await lstat(path.join(oldRoot, "Contents/_MASReceipt/receipt"))).ino).toBe(receipt.ino);
      expect((await lstat(path.join(oldRoot, "Contents/_MASReceipt"))).mode & 0o777).toBe(0o500);
      expect(await readFile(path.join(oldRoot, "Contents/_MASReceipt/receipt"), "utf8")).toBe("OS-owned receipt fixture");
      expect(await readFile(path.join(paths.runtimeRoot, "recording"), "utf8")).toBe("keep me");
      expect((await lstat(paths.runtimeRoot)).ino).toBe(runtimeIdentity.ino);
      expect((await lstat(lock.lockPath)).ino).toBe(lockIdentity.ino);
      if (scenario === "installed-signature") expect(entries.some((entry) => entry.startsWith(".Meetless-failed-"))).toBe(true);
      if (scenario === "collision") expect(await readFile(path.join(packageParent, entries.find((entry) => entry.startsWith(".Meetless-previous-"))!, "collision"), "utf8")).toBe("do not overwrite");
      if (scenario === "ambiguous") expect(await readFile(path.join(installed, "foreign"), "utf8")).toBe("do not move");
      const backups = path.join(path.dirname(paths.proofRoot), "update-backups");
      const [backup] = await readdir(backups);
      expect(await readFile(path.join(backups, backup!, "runtime/recording"), "utf8")).toBe("keep me");
    } finally {
      await lock.release();
      // Restore permissions only inside this owned fixture, never real app state.
      const allowCleanup = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) await allowCleanup(path.join(directory, entry.name));
        }
      };
      await allowCleanup(root);
    }
  });

  test("old recursive removal fails on a protected nested receipt directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-old-removal-"));
    roots.push(root);
    const app = path.join(root, "Meetless.app");
    const protectedDirectory = path.join(app, "Contents/_MASReceipt");
    await mkdir(protectedDirectory, { recursive: true });
    await writeFile(path.join(protectedDirectory, "receipt"), "retain");
    await chmod(protectedDirectory, 0o500);
    try {
      await expect(rm(app, { recursive: true, force: false })).rejects.toMatchObject({ code: "EACCES" });
      expect(await readFile(path.join(protectedDirectory, "receipt"), "utf8")).toBe("retain");
    } finally {
      await chmod(protectedDirectory, 0o700);
    }
  });
});


test.each(["owner", "symlink"])("update rejects unsafe %s before copying or moving", async (failure) => {
  const paths = resolveMasDevelopmentLoopPaths("/repo", "/Users/owner");
  let released = false;
  await expect(updateMasDevelopmentInstall(paths, {
    assertParent: async () => {},
    acquireLock: async () => ({ assertHeld: async () => {}, release: async () => { released = true; } }),
    assertStopped: async () => {},
    inspect: async () => ({ uid: failure === "owner" ? -1 : process.getuid!(), isDirectory: () => true, isSymbolicLink: () => failure === "symlink" }),
    copyTree: async () => { throw new Error("must not copy unsafe source"); },
    validateInstalled: async () => {},
  })).rejects.toThrow("current-user-owned non-symlink directory");
  expect(released).toBe(true);
});
