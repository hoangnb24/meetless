import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  publishProofEvidenceAtomically,
  type ProofFinalChecks,
} from "../src/proof-publication.js";

const temporaryRoots: string[] = [];
const passedChecks: ProofFinalChecks = {
  authorizedIsolatedStopChecked: true,
  browserClientsClosed: true,
  ownedProcessGroupsGone: true,
  isolatedListenersGone: true,
  runtimeRootAbsent: true,
  disposableSimulatorAbsent: true,
  simulatorTerminateChecked: true,
  simulatorUninstallChecked: true,
  simulatorShutdownChecked: true,
  simulatorDeleteChecked: true,
  productionPreserved: true,
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "meetless-publication-test-"));
  temporaryRoots.push(root);
  const source = path.join(root, "surface.log");
  writeFileSync(source, "surface evidence\n");
  return {
    source,
    destination: path.join(root, "published", "run-1"),
  };
}

describe("proof evidence publication", () => {
  test("atomically publishes passed evidence only after every final check passes", () => {
    const { source, destination } = fixture();
    const published = publishProofEvidenceAtomically({
      destinationDirectory: destination,
      runId: "run-1",
      preEvidenceSourceDigest: "source-digest",
      startedAt: "2026-08-16T10:00:00.000Z",
      endedAt: "2026-08-16T10:01:00.000Z",
      result: {
        meetingId: "meeting-1",
        endpoint: "127.0.0.1:7001",
        rendererOrigin: "http://127.0.0.1:7002",
        surfaces: {},
        production: {},
      },
      finalChecks: passedChecks,
      evidenceFiles: [{ sourcePath: source, name: "surface.log", kind: "log" }],
    });

    expect(published.result.status).toBe("passed");
    expect(existsSync(path.join(destination, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(destination, "manifest.json"), "utf8"));
    const logHash = createHash("sha256").update(readFileSync(source)).digest("hex");
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ name: "surface.log", sha256: logHash }),
    );
    expect(manifest.files).toContainEqual(expect.objectContaining({ name: "result.json" }));
  });

  test("a simulated production-preservation failure cannot leave passed evidence", () => {
    const { source, destination } = fixture();
    expect(() =>
      publishProofEvidenceAtomically({
        destinationDirectory: destination,
        runId: "run-1",
        preEvidenceSourceDigest: "source-digest",
        startedAt: "2026-08-16T10:00:00.000Z",
        endedAt: "2026-08-16T10:01:00.000Z",
        result: {},
        finalChecks: { ...passedChecks, productionPreserved: false },
        evidenceFiles: [{ sourcePath: source, name: "surface.log", kind: "log" }],
      }),
    ).toThrow(/productionPreserved.*No passed evidence was published/);
    expect(existsSync(destination)).toBe(false);
  });

  test("a simulated cleanup failure cannot leave passed evidence", () => {
    const { source, destination } = fixture();
    expect(() =>
      publishProofEvidenceAtomically({
        destinationDirectory: destination,
        runId: "run-1",
        preEvidenceSourceDigest: "source-digest",
        startedAt: "2026-08-16T10:00:00.000Z",
        endedAt: "2026-08-16T10:01:00.000Z",
        result: {},
        finalChecks: { ...passedChecks, isolatedListenersGone: false },
        evidenceFiles: [{ sourcePath: source, name: "surface.log", kind: "log" }],
      }),
    ).toThrow(/isolatedListenersGone.*No passed evidence was published/);
    expect(existsSync(destination)).toBe(false);
  });
});
