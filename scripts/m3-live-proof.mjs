import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateSnapshot,
  defaultCommittedFixtureAssertion,
  inspectM3Live,
  parkDefaultRuntime,
  prepareM3Live,
  publishM3Evidence,
  restoreDefaultRuntime,
  scanForbiddenArtifacts,
} from "./m3-live-proof-lib.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  if (command === "prepare") {
    const { MeetingStore } = await import("../packages/meeting-store/dist/index.js");
    const result = await prepareM3Live(
      {
        runtimeRoot: required("runtime-root"),
        listen: required("listen"),
        preservedRuntimeRoot: optional("preserved-runtime-root"),
      },
      {
        repositoryRoot,
        MeetingStore,
        assertCommittedFixture: defaultCommittedFixtureAssertion(repositoryRoot),
        candidateSnapshot: () => candidateSnapshot(repositoryRoot),
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "park-default") {
    const result = await parkDefaultRuntime(
      { preservedRuntimeRoot: required("preserved-runtime-root") },
      { repositoryRoot },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "restore-default") {
    const result = await restoreDefaultRuntime(
      { contextPath: required("context"), archiveRuntimeRoot: required("archive-runtime-root") },
      { repositoryRoot },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "inspect") {
    const [{ MeetingStore }, { planTranscriptRanges }, { connectMeetlessClient }] = await Promise.all([
      import("../packages/meeting-store/dist/index.js"),
      import("../packages/meeting-domain/dist/index.js"),
      import("../packages/meetless-client/dist/index.js"),
    ]);
    const result = await inspectM3Live(
      {
        contextPath: required("context"),
        timeoutMs: optionalInteger("timeout-ms"),
        pollMs: optionalInteger("poll-ms"),
      },
      {
        MeetingStore,
        planTranscriptRanges,
        connectClient: connectMeetlessClient,
        delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        scanArtifacts: scanForbiddenArtifacts,
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "publish") {
    const result = await publishM3Evidence(
      {
        contextPath: required("context"),
        inspectionPath: required("inspection"),
        runId: required("run-id"),
        uiScreenshotPath: required("ui-screenshot"),
        citedAudioPath: required("cited-audio"),
        playbackMetadataPath: required("playback-metadata"),
        toolIdentitiesPath: required("tool-identities"),
        appIdentitiesPath: required("app-identities"),
      },
      { repositoryRoot, candidateSnapshot: () => candidateSnapshot(repositoryRoot) },
    );
    process.stdout.write(`${JSON.stringify({ status: "passed", evidenceDirectory: path.relative(repositoryRoot, result.destination) }, null, 2)}\n`);
  } else {
    throw new Error("Usage: m3-live-proof.mjs park-default|prepare|inspect|publish|restore-default with explicit phase options");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseOptions(arguments_) {
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --name value options, received ${JSON.stringify(name)}`);
    }
    if (parsed.has(name.slice(2))) throw new Error(`Duplicate option ${name}`);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function optionalInteger(name) {
  const value = options.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function optional(name) {
  return options.get(name);
}
