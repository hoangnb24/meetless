import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIXTURE_FILES = ["english.mp3", "vietnamese.mp3", "mixed-en-vi.mp3"];
const FORBIDDEN_NAME = /OPENAI[^\s=]{0,32}(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)|(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)[^\s=]{0,32}OPENAI/giu;
const KEY_SHAPE = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gu;
const MAXIMUM_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAXIMUM_CITATION_BYTES = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_MARKER_SCHEMA = "MEETLESS_M3_DEFAULT_RUNTIME_PRESERVATION v1";

export async function parkDefaultRuntime(input, dependencies) {
  const repositoryRoot = path.resolve(dependencies.repositoryRoot);
  const defaultRuntimeRoot = path.join(repositoryRoot, ".meetless-runtime");
  const preservedRuntimeRoot = assertPreservedRuntimePath(input.preservedRuntimeRoot, repositoryRoot);
  const markerPath = `${preservedRuntimeRoot}.json`;
  assert(!existsSync(preservedRuntimeRoot) && !existsSync(markerPath), "M3 preserved runtime and marker targets must not already exist");
  const defaultStats = await lstat(defaultRuntimeRoot);
  assert(defaultStats.isDirectory() && !defaultStats.isSymbolicLink(), "Default Meetless runtime must be a real directory before preservation");
  const originalStateIdentity = await fileIdentity(path.join(defaultRuntimeRoot, "meeting-store/meetings.json"));
  const marker = {
    schema: DEFAULT_RUNTIME_MARKER_SCHEMA,
    parkedAt: new Date().toISOString(),
    defaultRuntimeRoot,
    preservedRuntimeRoot,
    originalStateIdentity,
  };
  assertNoSecretObject(marker, "default runtime preservation marker");
  await rename(defaultRuntimeRoot, preservedRuntimeRoot);
  try {
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    syncDirectory(repositoryRoot);
  } catch (error) {
    await rename(preservedRuntimeRoot, defaultRuntimeRoot).catch(() => undefined);
    throw error;
  }
  return { status: "parked", markerPath, ...marker };
}

export async function restoreDefaultRuntime(input, dependencies) {
  const repositoryRoot = path.resolve(dependencies.repositoryRoot);
  const context = await readContext(input.contextPath);
  const defaultRuntimeRoot = path.join(repositoryRoot, ".meetless-runtime");
  assert(context.runtimeRoot === defaultRuntimeRoot && context.preservation?.defaultRuntimeStaged === true,
    "Restore requires a context prepared at the staged default runtime");
  const preservedRuntimeRoot = assertPreservedRuntimePath(context.preservation.preservedRuntimeRoot, repositoryRoot);
  const markerPath = `${preservedRuntimeRoot}.json`;
  const marker = await readPreservationMarker(markerPath, repositoryRoot, preservedRuntimeRoot);
  const preservedIdentity = await fileIdentity(path.join(preservedRuntimeRoot, "meeting-store/meetings.json"));
  assert(sameIdentity(preservedIdentity, marker.originalStateIdentity), "Preserved production meeting state changed; refusing automatic restore");
  const liveState = JSON.parse(await readFile(path.join(defaultRuntimeRoot, "meeting-store/meetings.json"), "utf8"));
  const liveMeetingIds = (liveState.meetings ?? []).map((item) => item.id).sort();
  const expectedMeetingIds = context.meetings.map((item) => item.meetingId).sort();
  assert(JSON.stringify(liveMeetingIds) === JSON.stringify(expectedMeetingIds),
    "Active default runtime is not the exact three-fixture M3 runtime; refusing automatic restore");
  const archiveRuntimeRoot = assertArchiveRuntimePath(input.archiveRuntimeRoot);
  assert(!existsSync(archiveRuntimeRoot), "M3 completed runtime archive target must not already exist");
  await rename(defaultRuntimeRoot, archiveRuntimeRoot);
  try {
    await rename(preservedRuntimeRoot, defaultRuntimeRoot);
    await unlink(markerPath);
    syncDirectory(repositoryRoot);
  } catch (error) {
    await rename(archiveRuntimeRoot, defaultRuntimeRoot).catch(() => undefined);
    throw error;
  }
  const restoredIdentity = await fileIdentity(path.join(defaultRuntimeRoot, "meeting-store/meetings.json"));
  assert(sameIdentity(restoredIdentity, marker.originalStateIdentity), "Restored production meeting state identity changed");
  return { status: "restored", defaultRuntimeRoot, archiveRuntimeRoot, originalStateIdentity: marker.originalStateIdentity };
}

export async function prepareM3Live(input, dependencies) {
  const repositoryRoot = path.resolve(dependencies.repositoryRoot);
  const defaultRuntimeRoot = path.join(repositoryRoot, ".meetless-runtime");
  const stagedDefault = path.resolve(input.runtimeRoot) === defaultRuntimeRoot;
  let preservation = null;
  if (stagedDefault) {
    const preservedRuntimeRoot = assertPreservedRuntimePath(input.preservedRuntimeRoot, repositoryRoot);
    preservation = await readPreservationMarker(`${preservedRuntimeRoot}.json`, repositoryRoot, preservedRuntimeRoot);
    const preservedIdentity = await fileIdentity(path.join(preservedRuntimeRoot, "meeting-store/meetings.json"));
    assert(sameIdentity(preservedIdentity, preservation.originalStateIdentity), "Preserved production meeting state changed before M3 preparation");
  }
  const runtimeRoot = assertFreshRuntimeRoot(input.runtimeRoot, repositoryRoot, stagedDefault);
  const listen = assertListen(input.listen, stagedDefault);
  const fixtureRoot = path.join(repositoryRoot, "test/fixtures/m3");
  const manifest = JSON.parse((await boundedRegularFile(path.join(fixtureRoot, "manifest.json"), 64 * 1024, "M3 fixture manifest")).toString("utf8"));
  assertFixtureManifest(manifest);
  for (const file of ["manifest.json", ...FIXTURE_FILES]) {
    await dependencies.assertCommittedFixture(path.join("test/fixtures/m3", file));
  }
  await mkdir(runtimeRoot, { mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  const storeRoot = path.join(runtimeRoot, "meeting-store");
  const fixtureDestination = path.join(storeRoot, "meetings");
  await mkdir(fixtureDestination, { recursive: true, mode: 0o700 });
  const store = new dependencies.MeetingStore({ root: storeRoot });
  const fixtures = [];
  try {
    for (const fixture of manifest.fixtures) {
      const slug = fixture.file.replace(/\.mp3$/u, "");
      const meetingId = `m3-live-${slug}-meeting`;
      const recordingId = `m3-live-${slug}-recording`;
      const source = path.join(fixtureRoot, fixture.file);
      const destination = path.join(fixtureDestination, fixture.file);
      assertMp3Bytes(await boundedRegularFile(source, 5 * 1024 * 1024, `Committed fixture ${fixture.file}`));
      await copyFile(source, destination, COPYFILE_EXCL_VALUE);
      await chmod(destination, 0o600);
      const outputIdentity = await fileIdentity(destination);
      const meeting = await store.create({ id: meetingId, title: `M3 live ${slug}` });
      await store.startRecording({ id: recordingId, meetingId: meeting.id });
      const inventory = await seedTruthfulInventory(store, storeRoot, recordingId);
      await store.beginFinalization(recordingId, {
        openChunksDurablyClosed: true,
        chunkSetDigest: inventory.digest,
        destination,
        expectedIdentity: outputIdentity,
      });
      await store.markRecordingSaved(recordingId, { destination, identity: outputIdentity, readable: true });
      fixtures.push({
        file: fixture.file,
        languages: fixture.languages,
        expectedExactPhrase: fixture.expectedExactPhrase,
        meetingId,
        recordingId,
        destination,
        outputIdentity,
        inventory,
      });
    }
    assert((await store.transcriptionConsent()).status === "unknown", "Prepare must leave cloud consent unknown");
    assert((await store.list()).length === 3, "Prepare must seed exactly three meetings");
    assert((await store.listRecordings()).length === 3, "Prepare must seed exactly three saved recordings");
    const candidate = dependencies.candidateSnapshot();
    const context = {
      schema: "MEETLESS_M3_LIVE_CONTEXT v1",
      createdAt: new Date().toISOString(),
      candidateSnapshot: { algorithm: candidate.algorithm, head: candidate.head, digest: candidate.digest },
      runtimeRoot,
      storeRoot,
      listen,
      daemonUrl: `ws://${listen}/ws`,
      fixtureAuthority: "test/fixtures/m3/manifest.json",
      meetings: fixtures,
      consent: "unknown",
      leadSteps: {
        configureIsolatedHost: stagedDefault ? "Use the already-installed Keychain-trusted Meetless.app without replacement" : `MEETLESS_RUNTIME_ROOT=${shellQuote(runtimeRoot)} MEETLESS_LISTEN=${shellQuote(listen)} npm run host:install`,
        launchIsolatedHost: stagedDefault ? "npm run runtime:host" : `MEETLESS_RUNTIME_ROOT=${shellQuote(runtimeRoot)} MEETLESS_LISTEN=${shellQuote(listen)} npm run runtime:host`,
        stopIsolatedHost: stagedDefault ? "npm run runtime:host:stop" : `MEETLESS_RUNTIME_ROOT=${shellQuote(runtimeRoot)} MEETLESS_LISTEN=${shellQuote(listen)} npm run runtime:host:stop`,
        restoreDefaultHostConfiguration: stagedDefault ? "npm run proof:m3:restore-default -- --context <context> --archive-runtime-root <archive>" : "env -u MEETLESS_RUNTIME_ROOT -u MEETLESS_LISTEN npm run host:install",
        cleanupOwnedRootAfterEvidence: stagedDefault ? "Restore first; the command archives only the three-fixture runtime and must never delete the restored default root" : `rm -rf -- ${shellQuote(runtimeRoot)}`,
      },
      preservation: {
        defaultRuntimeUntouched: !stagedDefault,
        defaultRuntimeStaged: stagedDefault,
        preservedRuntimeRoot: preservation?.preservedRuntimeRoot,
        originalStateIdentity: preservation?.originalStateIdentity,
        keychainUntouched: true,
        installedAppUntouched: true,
        cleanupOwner: stagedDefault ? null : runtimeRoot,
      },
    };
    assertNoSecretObject(context, "prepared context");
    const contextPath = path.join(runtimeRoot, "m3-live-context.json");
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { contextPath, context };
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectM3Live(input, dependencies) {
  const context = await readContext(input.contextPath);
  const timeoutMs = positiveInteger(input.timeoutMs ?? 180_000, "inspection timeout");
  const pollMs = positiveInteger(input.pollMs ?? 1_000, "inspection poll interval");
  const connected = await dependencies.connectClient({
    url: context.daemonUrl,
    clientId: `meetless-m3-live-proof-${Date.now()}`,
    clientType: "cli",
  });
  let observations;
  try {
    observations = await waitForTranscripts(connected.client, context, timeoutMs, pollMs, dependencies.delay);
  } finally {
    await connected.close();
  }
  const store = new dependencies.MeetingStore({ root: context.storeRoot });
  const beforeRestart = await readFile(store.filePath);
  const durable = await validateDurableState(store, context, observations, dependencies.planTranscriptRanges);
  const restarted = new dependencies.MeetingStore({ root: context.storeRoot });
  const reconciled = await restarted.reconcileTranscriptPublications();
  const afterRestart = await readFile(restarted.filePath);
  assert(beforeRestart.equals(afterRestart), "Restart reconciliation changed an already-ready immutable M3 state");
  assert(reconciled.length === 3 && reconciled.every((item) => item.status === "ready"), "Restart must retain exactly three ready transcripts");
  const privacyScan = await dependencies.scanArtifacts({ runtimeRoot: context.runtimeRoot, listen: context.listen });
  assert(scanHitTotal(privacyScan) === 0, "Forbidden OpenAI credential material was detected; inspect category counts without printing matching content");
  const report = {
    schema: "MEETLESS_M3_LIVE_INSPECTION v1",
    status: "passed",
    inspectedAt: new Date().toISOString(),
    candidateSnapshot: context.candidateSnapshot,
    runtimeRoot: context.runtimeRoot,
    listen: context.listen,
    providerStatus: observations.providerStatus,
    meetings: durable,
    restart: { readyTranscriptCount: reconciled.length, stateBytesUnchanged: true, noProviderCall: true },
    privacyScan,
  };
  assertNoSecretObject(report, "inspection report");
  const reportPath = path.join(context.runtimeRoot, "m3-live-inspection.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { reportPath, report };
}

export async function publishM3Evidence(input, dependencies) {
  const context = await readContext(input.contextPath);
  const inspection = JSON.parse(await readFile(input.inspectionPath, "utf8"));
  assert(inspection.schema === "MEETLESS_M3_LIVE_INSPECTION v1" && inspection.status === "passed", "M3 evidence requires a passed inspection report");
  assert(path.resolve(input.inspectionPath).startsWith(context.runtimeRoot + path.sep), "Inspection report must come from the prepared isolated runtime root");
  assert(inspection.runtimeRoot === context.runtimeRoot && inspection.listen === context.listen, "Inspection runtime identity does not match prepared context");
  assert(inspection.candidateSnapshot?.digest === context.candidateSnapshot.digest, "Inspection candidate digest does not match prepared context");
  const currentCandidate = dependencies.candidateSnapshot();
  assert(currentCandidate.digest === context.candidateSnapshot.digest, "Candidate changed after M3 prepare; rerun prepare and live inspection");
  assert(scanHitTotal(inspection.privacyScan) === 0, "M3 evidence cannot publish with privacy scan hits");
  const runId = assertRunId(input.runId);
  const screenshot = await boundedRegularFile(input.uiScreenshotPath, MAXIMUM_SCREENSHOT_BYTES, "UI screenshot");
  const citedAudio = await boundedRegularFile(input.citedAudioPath, MAXIMUM_CITATION_BYTES, "cited audio");
  assertImageBytes(screenshot);
  assertMp3Bytes(citedAudio);
  const playback = await readBoundedJson(input.playbackMetadataPath, "playback metadata");
  const tools = await readBoundedJson(input.toolIdentitiesPath, "tool identities");
  const apps = await readBoundedJson(input.appIdentitiesPath, "app identities");
  for (const [label, value] of [["playback metadata", playback], ["tool identities", tools], ["app identities", apps]]) {
    assertNoSecretObject(value, label);
  }
  validatePlayback(playback, inspection, citedAudio);
  await validateIdentities(tools, "tools");
  await validateIdentities(apps, "apps");
  const destination = path.join(dependencies.repositoryRoot, "test/evidence/m3", runId);
  assert(!existsSync(destination), `Evidence destination already exists: ${destination}`);
  const screenshotName = "ui-screenshot" + path.extname(input.uiScreenshotPath).toLowerCase();
  const citedAudioName = "cited-audio" + path.extname(input.citedAudioPath).toLowerCase();
  const manifest = {
    schema: "MEETLESS_M3_LIVE_EVIDENCE v1",
    status: "passed",
    runId,
    observedAt: new Date().toISOString(),
    candidateSnapshot: context.candidateSnapshot,
    authority: "docs/plans/active/v1-paseo-foundation.md#milestone-3-transcription-and-audio-grounded-citations",
    runtime: { isolated: true, listen: context.listen, rootOwnedByRun: context.preservation?.defaultRuntimeStaged !== true },
    providerStatus: inspection.providerStatus,
    meetings: inspection.meetings,
    restart: inspection.restart,
    privacyScan: inspection.privacyScan,
    playback,
    identities: { tools, apps },
    artifacts: {
      uiScreenshot: fileDescriptor(screenshotName, "ui-screenshot", screenshot),
      citedAudio: fileDescriptor(citedAudioName, "cited-audio", citedAudio),
      inspection: fileDescriptor("inspection.json", "inspection", await readFile(input.inspectionPath)),
    },
    preservation: {
      defaultRuntimeDeleted: false,
      existingRecordingsDeleted: false,
      keychainChanged: false,
      installedAppChangedByHarness: false,
      restoreDefaultHostConfiguration: context.leadSteps.restoreDefaultHostConfiguration,
    },
  };
  assertNoSecretObject(manifest, "M3 evidence manifest");
  atomicPublish(destination, runId, manifest, [
    { source: input.uiScreenshotPath, name: screenshotName },
    { source: input.citedAudioPath, name: citedAudioName },
    { source: input.inspectionPath, name: "inspection.json" },
  ]);
  return { destination, manifest };
}

async function waitForTranscripts(client, context, timeoutMs, pollMs, delay) {
  const deadline = Date.now() + timeoutMs;
  let providerStatus = "invalid";
  for (;;) {
    const results = await Promise.all(context.meetings.map((fixture) => client.getMeetingTranscript(fixture.meetingId)));
    const statuses = new Set(results.map((result) => result.provider.status));
    assert([...statuses].every((status) => ["configured", "missing", "invalid"].includes(status)), "Provider status escaped its normalized boundary");
    providerStatus = results[0]?.provider.status ?? "invalid";
    assert(statuses.size === 1, "Provider status differed across the three fixture observations");
    if (providerStatus !== "configured") {
      throw new Error(`M3 live inspection requires configured provider status; observed ${providerStatus}`);
    }
    const failed = results.find((result) => result.transcript?.status === "failed");
    if (failed) throw new Error(`Fixture transcript failed for ${failed.meeting.id}; inspect normalized application status`);
    if (results.every((result) => result.transcript?.status === "ready")) {
      assert(results.length === 3, "Live inspection requires exactly three fixture transcripts");
      const citations = [];
      for (const result of results) {
        const segment = result.transcript.segments[0];
        citations.push(await client.resolveCitation({ meetingId: result.meeting.id, segmentId: segment.range.segmentId }));
      }
      return { providerStatus, results, citations };
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for exactly three ready M3 transcripts`);
    await delay(pollMs);
  }
}

async function validateDurableState(store, context, observations, planTranscriptRanges) {
  const meetings = await store.list();
  const recordings = await store.listRecordings();
  const transcripts = await store.listTranscripts();
  assert(meetings.length === 3 && recordings.length === 3 && transcripts.length === 3, "Durable store must contain exactly three M3 fixture identities");
  const output = [];
  for (const fixture of context.meetings) {
    const rpc = observations.results.find((result) => result.meeting.id === fixture.meetingId);
    const citation = observations.citations.find((item) => item.meetingId === fixture.meetingId);
    const meeting = meetings.find((item) => item.id === fixture.meetingId);
    const recording = recordings.find((item) => item.id === fixture.recordingId);
    const transcript = transcripts.find((item) => item.meetingId === fixture.meetingId);
    assert(rpc && citation && meeting && recording && transcript, `Missing durable fixture identity for ${fixture.meetingId}`);
    assert(meeting.status === "ready" && rpc.meeting.status === "ready", `Meeting ${fixture.meetingId} did not become ready`);
    const actualIdentity = await fileIdentity(fixture.destination);
    assert(sameIdentity(actualIdentity, fixture.outputIdentity), `Saved fixture identity changed for ${fixture.file}`);
    assert(sameIdentity(recording.savedOutput, fixture.outputIdentity), `Persisted saved identity changed for ${fixture.file}`);
    const inventoryPath = resolveInside(context.storeRoot, recording.inventory.pointer.storageKey);
    const inventoryBytes = await readFile(inventoryPath);
    assert(sha256(inventoryBytes) === recording.inventory.pointer.digest, `Inventory sidecar digest changed for ${fixture.file}`);
    const planned = planTranscriptRanges({
      recordingId: fixture.recordingId,
      audioSha256: fixture.outputIdentity.sha256,
      durationMs: transcript.audio.durationMs,
      rangeMs: transcript.rangeMs,
    });
    assert(JSON.stringify(planned) === JSON.stringify(transcript.ranges), `Stable range IDs changed for ${fixture.file}`);
    assert(transcript.ranges.length === 1 && transcript.checkpoints.length === 1, `Fixture ${fixture.file} must produce one stable segment`);
    assert(transcript.status === "ready" && rpc.transcript.status === "ready", `Fixture ${fixture.file} transcript is not ready`);
    assert(rpc.transcript.ranges.length === 1 && rpc.transcript.segments.length === 1, `Fixture ${fixture.file} RPC must expose one stable segment`);
    assert(rpc.transcript.ranges[0].segmentId === transcript.ranges[0].segmentId && rpc.transcript.segments[0].range.segmentId === transcript.ranges[0].segmentId, `Fixture ${fixture.file} RPC segment identity changed`);
    assert(transcript.requestCount === Object.values(transcript.attemptsByOrdinal).reduce((sum, value) => sum + value, 0), `Request accounting mismatch for ${fixture.file}`);
    assert(transcript.requestCount >= 1 && transcript.requestCount <= transcript.maxAttempts, `Request count escaped retry bounds for ${fixture.file}`);
    assertUsage(transcript.usage, fixture.file);
    const textCheck = assertExpectedText(transcript.checkpoints[0].text, fixture.expectedExactPhrase, fixture.languages);
    const publicationPath = resolveInside(context.storeRoot, transcript.publication.storageKey);
    const publicationBytes = await readFile(publicationPath);
    assert(publicationBytes.byteLength === transcript.publication.byteLength && sha256(publicationBytes) === transcript.publication.sha256, `Transcript sidecar identity changed for ${fixture.file}`);
    assert(citation.meetingId === fixture.meetingId && citation.segmentId === transcript.ranges[0].segmentId, `Citation identity mismatch for ${fixture.file}`);
    assert(citation.startMs === 0 && citation.endMs > citation.startMs && citation.endMs <= transcript.audio.durationMs, `Citation bounds are invalid for ${fixture.file}`);
    assert(citation.audio.mimeType === "audio/mpeg" && citation.audio.base64.length > 0, `Citation payload type is invalid for ${fixture.file}`);
    const citationBytes = Buffer.from(citation.audio.base64, "base64");
    assert(citationBytes.byteLength > 0 && citationBytes.byteLength <= MAXIMUM_CITATION_BYTES, `Citation payload size is invalid for ${fixture.file}`);
    output.push({
      file: fixture.file,
      meetingId: fixture.meetingId,
      recordingId: fixture.recordingId,
      outputIdentity: fixture.outputIdentity,
      inventory: { storageKey: recording.inventory.pointer.storageKey, digest: recording.inventory.pointer.digest },
      transcript: {
        id: transcript.id,
        status: transcript.status,
        segmentId: transcript.ranges[0].segmentId,
        range: { startMs: transcript.ranges[0].startMs, endMs: transcript.ranges[0].endMs },
        requestCount: transcript.requestCount,
        usage: transcript.usage,
        publication: transcript.publication,
        textCheck,
      },
      citation: { mimeType: citation.audio.mimeType, byteLength: citationBytes.byteLength, sha256: sha256(citationBytes), bounded: true },
    });
  }
  return output;
}

export function assertExpectedText(actual, expected, languages) {
  const actualTokens = tokens(actual);
  const expectedTokens = tokens(expected);
  const matched = expectedTokens.filter((token) => actualTokens.includes(token));
  const coverage = matched.length / expectedTokens.length;
  assert(coverage >= 0.75, "Fixture transcript did not retain enough expected spoken words without translation");
  if (languages.includes("en")) assert(["meetless", "records", "meeting", "english"].some((token) => actualTokens.includes(token)), "English fixture lost its spoken-language anchors");
  if (languages.includes("vi")) assert(["ghi", "âm", "tiếng", "việt", "và", "lưu", "bản"].filter((token) => actualTokens.includes(token)).length >= 2, "Vietnamese fixture lost its spoken-language anchors");
  if (languages.length === 2) {
    assert(actualTokens.includes("records") && ["và", "lưu", "bản"].some((token) => actualTokens.includes(token)), "Mixed fixture was translated instead of retaining English and Vietnamese");
  }
  return { expectedTokenCount: expectedTokens.length, matchedTokenCount: matched.length, coverage, languagesRetained: [...languages] };
}

export async function scanForbiddenArtifacts(input) {
  const result = {
    processArgv: emptyScanCategory(),
    processEnvironment: emptyScanCategory(),
    runtimeFiles: { log: emptyScanCategory(), manifest: emptyScanCategory(), renderer: emptyScanCategory(), other: emptyScanCategory() },
  };
  const processes = input.processRows ?? await runtimeProcessRows(input.runtimeRoot, input.listen);
  for (const process of processes) {
    addScan(result.processArgv, process.argv ?? "");
    addScan(result.processEnvironment, process.environment ?? "");
  }
  for (const file of await walkRegularFiles(input.runtimeRoot)) {
    const category = runtimeFileCategory(input.runtimeRoot, file.path);
    result.runtimeFiles[category].scanned += 1;
    addScan(result.runtimeFiles[category], file.path);
    if (file.size <= MAXIMUM_SCAN_FILE_BYTES && !/\.(?:mp3|wav|png|jpe?g)$/iu.test(file.path)) {
      addScan(result.runtimeFiles[category], await readFile(file.path, "utf8"));
    }
  }
  return result;
}

export function defaultCommittedFixtureAssertion(repositoryRoot) {
  return (relativePath) => {
    const committed = execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: repositoryRoot, encoding: null });
    const working = readFileSync(path.join(repositoryRoot, relativePath));
    assert(committed.equals(working), `Fixture ${relativePath} differs from committed HEAD; commit the accepted fixture before live proof`);
  };
}

export function candidateSnapshot(repositoryRoot) {
  const completed = execFileSync(process.execPath, ["scripts/candidate-snapshot.mjs"], { cwd: repositoryRoot, encoding: "utf8" });
  return JSON.parse(completed);
}

async function seedTruthfulInventory(store, storeRoot, recordingId) {
  const sessionDirectory = path.join(storeRoot, "sessions", recordingId);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const chunkPath = path.join(sessionDirectory, "m3-proof-source.wav");
  const chunkBytes = oneFrameWav();
  await writeFile(chunkPath, chunkBytes, { flag: "wx", mode: 0o600 });
  const chunkStats = await stat(chunkPath);
  const chunk = {
    id: "m3-proof-source",
    source: "microphone",
    storageKey: path.relative(storeRoot, chunkPath),
    byteLength: chunkBytes.byteLength,
    sha256: sha256(chunkBytes),
    committedAt: chunkStats.mtime.toISOString(),
    logicalStartMs: 0,
    durationMs: 1,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
  await store.commitChunk(recordingId, chunk);
  await store.prepareInventoryRecovery(recordingId, "M3 isolated live proof seed completed capture");
  await store.markInventoryScanning(recordingId);
  const sidecarPath = path.join(sessionDirectory, "inventory.ndjson");
  const sidecarBytes = Buffer.from(`${JSON.stringify(chunk)}\n`);
  await writeFile(sidecarPath, sidecarBytes, { flag: "wx", mode: 0o600 });
  const pointer = {
    storageKey: path.relative(storeRoot, sidecarPath),
    digest: sha256(sidecarBytes),
    chunkCount: 1,
    microphoneCount: 1,
    systemCount: 0,
    publishedAt: new Date().toISOString(),
  };
  await store.publishInventory(recordingId, pointer);
  return pointer;
}

function oneFrameWav() {
  const data = Buffer.alloc(46);
  data.write("RIFF", 0); data.writeUInt32LE(38, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(2, 40); data.writeInt16LE(0, 44);
  return data;
}

function atomicPublish(destination, runId, manifest, files) {
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = path.join(parent, `.publish-${runId}-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o755 });
    for (const file of files) copyFileSync(file.source, path.join(staging, file.name));
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    syncDirectory(staging);
    renameSync(staging, destination);
    syncDirectory(parent);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readContext(contextPath) {
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  assert(context.schema === "MEETLESS_M3_LIVE_CONTEXT v1", "Invalid M3 live context schema");
  assert(path.isAbsolute(context.runtimeRoot) && path.resolve(contextPath).startsWith(context.runtimeRoot + path.sep), "Context must remain inside its explicit runtime root");
  assertNoSecretObject(context, "M3 live context");
  return context;
}

function assertFreshRuntimeRoot(runtimeRootInput, repositoryRoot, allowStagedDefault = false) {
  assert(typeof runtimeRootInput === "string" && path.isAbsolute(runtimeRootInput), "--runtime-root must be an explicit absolute path");
  const runtimeRoot = path.resolve(runtimeRootInput);
  const defaultRuntimeRoot = path.join(repositoryRoot, ".meetless-runtime");
  if (allowStagedDefault && runtimeRoot === defaultRuntimeRoot) {
    assert(!existsSync(runtimeRoot), "Staged default runtime root must be absent after production preservation");
    return runtimeRoot;
  }
  const allowedParents = new Set([path.resolve("/private/tmp"), path.resolve(tmpdir())]);
  assert(allowedParents.has(path.dirname(runtimeRoot)), "M3 runtime root must be a direct child of /private/tmp or the system temporary directory");
  assert(/^meetless-m3-live-[A-Za-z0-9._-]+$/u.test(path.basename(runtimeRoot)), "M3 runtime root basename must start with meetless-m3-live-");
  assert(runtimeRoot !== path.join(repositoryRoot, ".meetless-runtime"), "M3 proof must never use the default runtime root");
  assert(!existsSync(runtimeRoot), "M3 runtime root must not already exist");
  return runtimeRoot;
}

function assertListen(value, allowDefault = false) {
  assert(typeof value === "string" && /^127\.0\.0\.1:(?:[1-9][0-9]{3,4})$/u.test(value), "--listen must be an explicit 127.0.0.1 high port");
  const port = Number(value.split(":")[1]);
  assert(port > 1024 && port < 65536 && port !== 6767 && (allowDefault || port !== 6777), "M3 live proof listen port must be isolated from default Paseo and Meetless ports");
  if (allowDefault) assert(port === 6777, "Staged default runtime must use the installed host's fixed 127.0.0.1:6777 listener");
  return value;
}

function assertPreservedRuntimePath(value, repositoryRoot) {
  assert(typeof value === "string" && path.isAbsolute(value), "--preserved-runtime-root must be an explicit absolute path");
  const resolved = path.resolve(value);
  assert(path.dirname(resolved) === repositoryRoot, "Preserved runtime must be a sibling of the default runtime");
  assert(/^\.meetless-runtime\.m3-preserved-[A-Za-z0-9._-]+$/u.test(path.basename(resolved)),
    "Preserved runtime basename must start with .meetless-runtime.m3-preserved-");
  return resolved;
}

function assertArchiveRuntimePath(value) {
  assert(typeof value === "string" && path.isAbsolute(value), "--archive-runtime-root must be an explicit absolute path");
  const resolved = path.resolve(value);
  const allowedParents = new Set([path.resolve("/private/tmp"), path.resolve(tmpdir())]);
  assert(allowedParents.has(path.dirname(resolved)), "Completed M3 runtime archive must be a direct child of /private/tmp or the system temporary directory");
  assert(/^meetless-m3-live-[A-Za-z0-9._-]+-completed$/u.test(path.basename(resolved)),
    "Completed M3 runtime archive basename must start with meetless-m3-live- and end with -completed");
  return resolved;
}

async function readPreservationMarker(markerPath, repositoryRoot, preservedRuntimeRoot) {
  const marker = await readBoundedJson(markerPath, "default runtime preservation marker");
  assert(marker.schema === DEFAULT_RUNTIME_MARKER_SCHEMA, "Invalid default runtime preservation marker schema");
  assert(marker.defaultRuntimeRoot === path.join(repositoryRoot, ".meetless-runtime") && marker.preservedRuntimeRoot === preservedRuntimeRoot,
    "Default runtime preservation marker does not match the requested roots");
  assert(marker.originalStateIdentity?.byteLength > 0 && /^[0-9a-f]{64}$/u.test(marker.originalStateIdentity.sha256),
    "Default runtime preservation marker has an invalid state identity");
  assertNoSecretObject(marker, "default runtime preservation marker");
  const stats = await lstat(preservedRuntimeRoot);
  assert(stats.isDirectory() && !stats.isSymbolicLink(), "Preserved production runtime must remain a real directory");
  return marker;
}

function assertFixtureManifest(manifest) {
  assert(manifest?.version === 1 && Array.isArray(manifest.fixtures), "Invalid committed M3 fixture manifest");
  assert(JSON.stringify(manifest.fixtures.map((fixture) => fixture.file)) === JSON.stringify(FIXTURE_FILES), "M3 fixture manifest must name exactly English, Vietnamese, and mixed MP3s");
}

function assertUsage(usage, fixture) {
  assert(usage && typeof usage === "object", `Provider usage is missing for ${fixture}`);
  const values = Object.values(usage);
  assert(values.length > 0 && values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0), `Provider usage is invalid for ${fixture}`);
}

function validatePlayback(value, inspection, citedAudio) {
  assert(value && typeof value === "object" && value.started === true && value.audible === true, "Playback metadata must record started and audible observations");
  assert(Number.isFinite(value.observedDurationMs) && value.observedDurationMs > 0, "Playback metadata requires positive observedDurationMs");
  const meeting = inspection.meetings.find((item) => item.meetingId === value.meetingId);
  assert(meeting?.transcript.segmentId === value.segmentId, "Playback metadata must reference one inspected stable citation identity");
  assert(value.observedDurationMs <= meeting.transcript.range.endMs - meeting.transcript.range.startMs + 1_000, "Playback observation exceeds its bounded citation range");
  assert(meeting.citation.sha256 === sha256(citedAudio), "Captured cited audio does not match the inspected citation RPC payload");
}

async function validateIdentities(value, label) {
  const entries = value?.[label];
  assert(Array.isArray(entries) && entries.length > 0 && entries.length <= 20, `${label} identities must contain 1-20 entries`);
  for (const entry of entries) {
    assert(typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 100, `${label} identity name is invalid`);
    assert(typeof entry.path === "string" && path.isAbsolute(entry.path), `${label} identity path must be absolute`);
    assert(/^[0-9a-f]{64}$/u.test(entry.sha256), `${label} identity SHA-256 is invalid`);
    assert(await hashRegularFile(entry.path) === entry.sha256, `${label} identity SHA-256 does not match ${entry.name}`);
  }
}

async function boundedRegularFile(filePath, maximum, label) {
  const stats = await lstat(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= maximum, `${label} must be a bounded regular non-symlink file`);
  return readFile(filePath);
}

async function readBoundedJson(filePath, label) {
  const bytes = await boundedRegularFile(filePath, 64 * 1024, label);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} must contain valid bounded JSON`); }
}

async function fileIdentity(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    assert(stats.isFile() && stats.size > 0, `Expected regular non-empty file at ${filePath}`);
    const bytes = await handle.readFile();
    assert(bytes.byteLength === stats.size, `File changed while hashing: ${filePath}`);
    return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
  } finally { await handle.close(); }
}

async function hashRegularFile(filePath) {
  const stats = await lstat(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= 512 * 1024 * 1024, "Identity target must be a bounded regular non-symlink file");
  const handle = await open(filePath, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    assert(total === stats.size, "Identity target changed while hashing");
    return digest.digest("hex");
  } finally { await handle.close(); }
}

async function runtimeProcessRows(runtimeRoot, listen) {
  const lock = JSON.parse(await readFile(path.join(runtimeRoot, "paseo-home/paseo.pid"), "utf8"));
  const registry = JSON.parse(await readFile(path.join(runtimeRoot, "owned-process-groups.json"), "utf8"));
  const roots = new Set([lock.pid, registry.hostPid, registry.desktopPid].filter((pid) => Number.isInteger(pid) && pid > 1));
  const groups = new Set((registry.groups ?? []).map((group) => group.pgid).filter((pgid) => Number.isInteger(pgid) && pgid > 1));
  assert(roots.size >= 2, "Cannot identify the isolated M3 host/runtime process roots for privacy scanning");
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), argv: match[4] }] : [];
  });
  const selected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && (selected.has(row.ppid) || groups.has(row.pgid))) {
        selected.add(row.pid); changed = true;
      }
    }
  }
  const matches = rows.filter((row) => selected.has(row.pid));
  assert(matches.length >= roots.size, `Isolated M3 process scan could not resolve every owned root at ${listen}`);
  return Promise.all(matches.map(async (item) => {
    const inspected = await execFileAsync("ps", ["eww", "-p", String(item.pid), "-o", "command="], { maxBuffer: 2 * 1024 * 1024 });
    return { ...item, environment: inspected.stdout };
  }));
}

async function walkRegularFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) output.push({ path: candidate, size: (await stat(candidate)).size });
    }
  }
  await visit(root);
  return output;
}

function runtimeFileCategory(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith(`electron-user-data${path.sep}`)) return "renderer";
  if (/\.log$/iu.test(relative)) return "log";
  if (/manifest|\.json$/iu.test(relative)) return "manifest";
  return "other";
}

function emptyScanCategory() { return { scanned: 0, credentialNameHits: 0, keyShapeHits: 0 }; }
function addScan(category, value) {
  category.scanned += 1;
  category.credentialNameHits += matchCount(String(value), FORBIDDEN_NAME);
  category.keyShapeHits += matchCount(String(value), KEY_SHAPE);
}
function matchCount(value, expression) { expression.lastIndex = 0; return [...value.matchAll(expression)].length; }
function scanHitTotal(scan) {
  const categories = [scan.processArgv, scan.processEnvironment, ...Object.values(scan.runtimeFiles)];
  return categories.reduce((sum, item) => sum + item.credentialNameHits + item.keyShapeHits, 0);
}

function assertNoSecretObject(value, label) {
  const serialized = JSON.stringify(value);
  const counts = { names: matchCount(serialized, FORBIDDEN_NAME), keys: matchCount(serialized, KEY_SHAPE) };
  assert(counts.names + counts.keys === 0, `${label} contains forbidden credential material; matching content was not printed`);
}

function resolveInside(root, storageKey) {
  const resolved = path.resolve(root, storageKey);
  assert(resolved.startsWith(path.resolve(root) + path.sep), `Storage key escaped isolated root: ${storageKey}`);
  return resolved;
}

function fileDescriptor(name, kind, bytes) { return { name, kind, byteLength: bytes.byteLength, sha256: sha256(bytes) }; }
function assertImageBytes(bytes) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  assert(png || jpeg, "UI screenshot must contain PNG or JPEG bytes");
}
function assertMp3Bytes(bytes) {
  const id3 = bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3";
  const frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  assert(id3 || frame, "Cited audio must contain MP3 bytes");
}
function sameIdentity(left, right) { return left?.byteLength === right.byteLength && left?.sha256 === right.sha256; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function tokens(value) { return String(value).normalize("NFC").toLocaleLowerCase("vi-VN").match(/[\p{L}\p{N}]+/gu) ?? []; }
function positiveInteger(value, label) { assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`); return value; }
function assertRunId(value) { assert(typeof value === "string" && /^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}$/u.test(value), "--run-id must use YYYYMMDDTHHMMSSZ-label"); return value; }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function syncDirectory(directory) { const descriptor = openSync(directory, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }

const COPYFILE_EXCL_VALUE = 1;
