import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface ProofFinalChecks {
  authorizedIsolatedStopChecked: boolean;
  browserClientsClosed: boolean;
  ownedProcessGroupsGone: boolean;
  isolatedListenersGone: boolean;
  runtimeRootAbsent: boolean;
  disposableSimulatorAbsent: boolean;
  simulatorTerminateChecked: boolean;
  simulatorUninstallChecked: boolean;
  simulatorShutdownChecked: boolean;
  simulatorDeleteChecked: boolean;
  productionPreserved: boolean;
}

export interface ProofEvidenceFile {
  sourcePath: string;
  name: string;
  kind: "screenshot" | "log";
}

export interface ProofPublicationInput {
  destinationDirectory: string;
  runId: string;
  preEvidenceSourceDigest: string;
  startedAt: string;
  endedAt: string;
  result: Record<string, unknown>;
  finalChecks: ProofFinalChecks;
  evidenceFiles: ProofEvidenceFile[];
}

export interface PublishedProofEvidence {
  directory: string;
  manifest: Record<string, unknown>;
  result: Record<string, unknown>;
}

export function assertProofFinalChecks(checks: ProofFinalChecks): void {
  const failed = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(
      `Refusing passed proof publication: final checks failed: ${failed.join(", ")}. ` +
        "No passed evidence was published.",
    );
  }
}

export function publishProofEvidenceAtomically(
  input: ProofPublicationInput,
): PublishedProofEvidence {
  assertProofFinalChecks(input.finalChecks);
  const parent = path.dirname(input.destinationDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = path.join(parent, `.publish-${input.runId}-${process.pid}-${randomUUID()}`);
  const passedResult = {
    ...input.result,
    status: "passed",
    runId: input.runId,
    preEvidenceSourceDigest: input.preEvidenceSourceDigest,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    finalChecks: input.finalChecks,
  };

  try {
    mkdirSync(staging, { mode: 0o755 });
    const names = new Set<string>();
    const publishedFiles: Array<{ name: string; kind: string; sha256: string; size: number }> = [];
    for (const evidence of input.evidenceFiles) {
      assertSafeUniqueName(evidence.name, names);
      const destination = path.join(staging, evidence.name);
      copyFileSync(evidence.sourcePath, destination);
      publishedFiles.push(hashPublishedFile(destination, evidence.name, evidence.kind));
    }

    const resultPath = path.join(staging, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(passedResult, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    publishedFiles.push(hashPublishedFile(resultPath, "result.json", "result"));

    const manifest = {
      schema: "MEETLESS_M1_EVIDENCE v1",
      status: "passed",
      runId: input.runId,
      preEvidenceSourceDigest: input.preEvidenceSourceDigest,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      meetingId: input.result.meetingId,
      endpoint: input.result.endpoint,
      rendererOrigin: input.result.rendererOrigin,
      surfaces: input.result.surfaces,
      production: input.result.production,
      cleanup: input.finalChecks,
      files: publishedFiles.sort((left, right) => left.name.localeCompare(right.name)),
    };
    const manifestPath = path.join(staging, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    syncDirectory(staging);
    renameSync(staging, input.destinationDirectory);
    syncDirectory(parent);
    return { directory: input.destinationDirectory, manifest, result: passedResult };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function assertSafeUniqueName(name: string, names: Set<string>): void {
  if (!name || path.basename(name) !== name || name === "result.json" || name === "manifest.json") {
    throw new Error(`Invalid proof evidence filename ${JSON.stringify(name)}`);
  }
  if (names.has(name)) throw new Error(`Duplicate proof evidence filename ${name}`);
  names.add(name);
}

function hashPublishedFile(filePath: string, name: string, kind: string) {
  const body = readFileSync(filePath);
  return {
    name,
    kind,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
  };
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
