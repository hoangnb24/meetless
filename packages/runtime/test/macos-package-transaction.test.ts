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

const identityGoldenVector = {
  version: 1,
  bundleIdentifier: "com.meetless.app",
  bundlePath: "/Applications/Meetless.app",
  bundleRealPath: "/Applications/Meetless.app",
  executablePath: "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
  designatedRequirement: "identifier \"com.meetless.app\": path \"https://example.test/a/b\" literal marker",
  cdHash: "a".repeat(40),
  binarySha256: "b".repeat(64),
  binaryDevice: 42,
  binaryInode: 987654321,
  binarySize: 123456,
  configuration: {
    repositoryRoot: "/Users/example/Meetless / source",
    runtimeRoot: "/Users/example/Library/Application Support/Meetless",
    listen: "127.0.0.1:16777",
    rendererOrigin: "http://127.0.0.1:18082/path/a/b",
    transcriptionSocket: "/Users/example/Library/Application Support/Meetless/transcription.sock",
    transcriptionStaging: "/Users/example/Library/Application Support/Meetless/meeting-store/transcription-ranges",
    nodePath: "/Users/example/Meetless / source/runtime/node",
    runtimeCliPath: "/Users/example/Meetless / source/packages/runtime/dist/cli.js",
    identityPath: "/Users/example/Library/Application Support/Meetless/paseo-home/server-id",
    captureHelperPath: undefined,
    endpointPolicy: undefined,
    endpointWorkingDirectory: undefined,
    recordingEndpointName: undefined,
    transcriptionEndpointName: undefined,
  },
};

const recursiveGoldenVector = {
  array: ["a/b", "quote\": / and \\\\backslash", 17],
  emptyArray: [],
  emptyObject: {},
  escaped: "<\/script> \"quoted\": value \\\\ newline\n separator ",
  nested: { z: "last", a: "first" },
  nullValue: null,
  optionalOmitted: undefined,
};

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
      '{\n  "configuration" : {\n    "a" : "nested-first",\n    "z" : "nested-last"\n  },\n  "z" : "outer"\n}\n',
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

  it("matches Foundation JSONEncoder bytes for complete identity and recursive values", () => {
    expect(serializeSortedJson(identityGoldenVector)).toEqual(Buffer.from(
      "ewogICJiaW5hcnlEZXZpY2UiIDogNDIsCiAgImJpbmFyeUlub2RlIiA6IDk4NzY1NDMyMSwKICAiYmluYXJ5U2hhMjU2IiA6ICJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwKICAiYmluYXJ5U2l6ZSIgOiAxMjM0NTYsCiAgImJ1bmRsZUlkZW50aWZpZXIiIDogImNvbS5tZWV0bGVzcy5hcHAiLAogICJidW5kbGVQYXRoIiA6ICJcL0FwcGxpY2F0aW9uc1wvTWVldGxlc3MuYXBwIiwKICAiYnVuZGxlUmVhbFBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHAiLAogICJjZEhhc2giIDogImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLAogICJjb25maWd1cmF0aW9uIiA6IHsKICAgICJpZGVudGl0eVBhdGgiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC9wYXNlby1ob21lXC9zZXJ2ZXItaWQiLAogICAgImxpc3RlbiIgOiAiMTI3LjAuMC4xOjE2Nzc3IiwKICAgICJub2RlUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9ydW50aW1lXC9ub2RlIiwKICAgICJyZW5kZXJlck9yaWdpbiIgOiAiaHR0cDpcL1wvMTI3LjAuMC4xOjE4MDgyXC9wYXRoXC9hXC9iIiwKICAgICJyZXBvc2l0b3J5Um9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlIiwKICAgICJydW50aW1lQ2xpUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9wYWNrYWdlc1wvcnVudGltZVwvZGlzdFwvY2xpLmpzIiwKICAgICJydW50aW1lUm9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTGlicmFyeVwvQXBwbGljYXRpb24gU3VwcG9ydFwvTWVldGxlc3MiLAogICAgInRyYW5zY3JpcHRpb25Tb2NrZXQiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC90cmFuc2NyaXB0aW9uLnNvY2siLAogICAgInRyYW5zY3JpcHRpb25TdGFnaW5nIiA6ICJcL1VzZXJzXC9leGFtcGxlXC9MaWJyYXJ5XC9BcHBsaWNhdGlvbiBTdXBwb3J0XC9NZWV0bGVzc1wvbWVldGluZy1zdG9yZVwvdHJhbnNjcmlwdGlvbi1yYW5nZXMiCiAgfSwKICAiZGVzaWduYXRlZFJlcXVpcmVtZW50IiA6ICJpZGVudGlmaWVyIFwiY29tLm1lZXRsZXNzLmFwcFwiOiBwYXRoIFwiaHR0cHM6XC9cL2V4YW1wbGUudGVzdFwvYVwvYlwiIGxpdGVyYWwgbWFya2VyIiwKICAiZXhlY3V0YWJsZVBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHBcL0NvbnRlbnRzXC9NYWNPU1wvTWVldGxlc3NIb3N0IiwKICAidmVyc2lvbiIgOiAxCn0K",
      "base64",
    ));
    expect(serializeSortedJson(recursiveGoldenVector)).toEqual(Buffer.from(
      "ewogICJhcnJheSIgOiBbCiAgICAiYVwvYiIsCiAgICAicXVvdGVcIjogXC8gYW5kIFxcXFxiYWNrc2xhc2giLAogICAgMTcKICBdLAogICJlbXB0eUFycmF5IiA6IFsKCiAgXSwKICAiZW1wdHlPYmplY3QiIDogewoKICB9LAogICJlc2NhcGVkIiA6ICI8XC9zY3JpcHQ+IFwicXVvdGVkXCI6IHZhbHVlIFxcXFwgbmV3bGluZVxuIHNlcGFyYXRvcuKAqCIsCiAgIm5lc3RlZCIgOiB7CiAgICAiYSIgOiAiZmlyc3QiLAogICAgInoiIDogImxhc3QiCiAgfSwKICAibnVsbFZhbHVlIiA6IG51bGwKfQo=",
      "base64",
    ));
  });

  it("rejects scalar and formatting mutations outside exact identity-byte ownership", async () => {
    const root = await setup();
    const transaction = await replacePackageBundle({
      source: root.source,
      target: root.target,
      identityPath: root.identityPath,
      ownerToken: "M7-test-owner",
      runId: newPackageTransactionId(),
      inspect: async () => identityGoldenVector,
    });

    await writeFile(root.identityPath, serializeSortedJson({ ...identityGoldenVector, binarySize: 123457 }));
    await expect(restorePackageTransaction(transaction, {
      ownerToken: "M7-test-owner",
      target: root.target,
      identityPath: root.identityPath,
    })).rejects.toThrow(/identity changed outside package transaction/);
    await expect(readFile(root.identityPath)).resolves.toEqual(
      serializeSortedJson({ ...identityGoldenVector, binarySize: 123457 }),
    );

    await writeFile(root.identityPath, Buffer.from(
      serializeSortedJson(identityGoldenVector).toString().replace(/"version" : 1/u, '"version": 1'),
    ));
    await expect(restorePackageTransaction(transaction, {
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
