import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newPackageTransactionId,
  packageTransactionPaths,
  recoverPackageTransaction,
  replacePackageBundle,
  serializeSortedJson,
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

  it("uses native-style recursive sorted identity bytes and rejects outside identity mutation", async () => {
    const root = await setup();
    const inspected = {
      z: "outer",
      configuration: {
        z: "nested-last",
        a: "nested-first",
      },
    };
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => inspected,
    });

    expect(transaction.nextIdentityBytes.toString()).toBe(
      '{\n  "configuration": {\n    "a": "nested-first",\n    "z": "nested-last"\n  },\n  "z": "outer"\n}\n',
    );
    expect(transaction.nextIdentityBytes).toEqual(serializeSortedJson(inspected));

    await writeFile(root.identityPath, serializeSortedJson(inspected));
    await restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    });
    await expect(readFile(root.identityPath, "utf8")).resolves.toBe("prior identity\n");

    const second = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => inspected,
    });
    await writeFile(root.identityPath, serializeSortedJson({ ...inspected, z: "outside mutation" }));
    await expect(restorePackageTransaction(second, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/identity changed outside package transaction/);
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
