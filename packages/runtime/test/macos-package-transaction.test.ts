import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newPackageTransactionId,
  packageTransactionPaths,
  recoverPackageTransaction,
  replacePackageBundle,
  restorePackageTransaction,
} from "../../../scripts/lib/macos-package-transaction.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("macOS package replacement transaction", () => {
  it("recovers replacement interruption at every published state", async () => {
    const root = await setup();
    const { source, target, identityPath } = root;
    const ownerToken = "M7-test-owner";
    const inspect = async (bundlePath: string) => ({ bundleIdentifier: "com.meetless.app", bundleRealPath: bundlePath });

    for (const state of ["staged", "target-backed-up", "candidate-installed", "identity-published", "committed"]) {
      const runId = newPackageTransactionId();
      await expect(replacePackageBundle({ source, target, identityPath, ownerToken, runId, inspect, faultAt: state }))
        .rejects.toThrow(`injected package transaction interruption at ${state}`);
      await recoverPackageTransaction(packageTransactionPaths(target, runId).journal, {
        ownerToken,
        target,
        identityPath,
      });
      await expect(readFile(path.join(target, "Contents", "marker"), "utf8")).resolves.toBe("prior\n");
      await expect(readFile(identityPath, "utf8")).resolves.toBe("prior identity\n");
    }
  });

  it("refuses restoration after an outside target mutation", async () => {
    const root = await setup();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => ({ bundleIdentifier: "com.meetless.app" }),
    });
    await writeFile(path.join(root.target, "outside-change"), "do not remove\n");
    await expect(restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/changed outside the package transaction/);
    await expect(readFile(path.join(root.target, "outside-change"), "utf8")).resolves.toBe("do not remove\n");
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-m7-package-transaction-test-"));
  roots.push(root);
  const source = path.join(root, "source.app");
  const target = path.join(root, "Applications", "Meetless.app");
  const identityPath = path.join(root, "identity.json");
  await mkdir(path.join(source, "Contents"), { recursive: true });
  await writeFile(path.join(source, "Contents", "marker"), "candidate\n");
  await mkdir(path.join(target, "Contents"), { recursive: true });
  await writeFile(path.join(target, "Contents", "marker"), "prior\n");
  await writeFile(identityPath, "prior identity\n");
  return { source, target, identityPath };
}
