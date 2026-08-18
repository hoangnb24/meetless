import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MeetingStore } from "../packages/meeting-store/src/index.js";
import { planTranscriptRanges } from "../packages/meeting-domain/src/index.js";
import {
  assertExpectedText,
  inspectM3Live,
  prepareM3Live,
  publishM3Evidence,
  scanForbiddenArtifacts,
} from "../scripts/m3-live-proof-lib.mjs";

const roots: string[] = [];
const candidate = { algorithm: "sha256", head: "b".repeat(40), digest: "a".repeat(64) };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M3 isolated live proof harness", () => {
  test("prepare seeds exactly three saved fixtures through public lifecycle APIs and leaves consent unknown", async () => {
    const fixtureRepository = await fakeFixtureRepository();
    const runtimeRoot = freshRuntimePath();
    roots.push(runtimeRoot);
    const prepared = await prepareM3Live(
      { runtimeRoot, listen: "127.0.0.1:6793" },
      dependencies(fixtureRepository),
    );

    expect(prepared.context).toMatchObject({
      runtimeRoot,
      listen: "127.0.0.1:6793",
      consent: "unknown",
      candidateSnapshot: candidate,
      preservation: { defaultRuntimeUntouched: true, keychainUntouched: true },
    });
    expect(prepared.context.meetings).toHaveLength(3);
    const store = new MeetingStore({ root: prepared.context.storeRoot });
    expect(await store.transcriptionConsent()).toEqual({ status: "unknown" });
    expect(await store.list()).toHaveLength(3);
    expect(await store.listRecordings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "saved", inventory: expect.objectContaining({ state: "complete", knownChunkCount: 1 }) }),
    ]));
    for (const fixture of prepared.context.meetings) {
      const inventory = await readFile(path.join(prepared.context.storeRoot, fixture.inventory.storageKey), "utf8");
      expect(JSON.parse(inventory)).toMatchObject({ id: "m3-proof-source", format: "wav", byteLength: 46 });
    }
    expect(JSON.stringify(prepared.context)).not.toMatch(/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/u);
  });

  test("prepare rejects default, reused, and broad runtime targets without deleting them", async () => {
    const fixtureRepository = await fakeFixtureRepository();
    const existing = await mkdtemp(path.join(tmpdir(), "meetless-m3-live-existing-"));
    roots.push(existing);
    await expect(prepareM3Live({ runtimeRoot: existing, listen: "127.0.0.1:6793" }, dependencies(fixtureRepository)))
      .rejects.toThrow(/must not already exist/);
    await expect(prepareM3Live({ runtimeRoot: path.join(fixtureRepository, ".meetless-runtime"), listen: "127.0.0.1:6793" }, dependencies(fixtureRepository)))
      .rejects.toThrow(/direct child/);
    expect(await readFile(path.join(fixtureRepository, "test/fixtures/m3/manifest.json"), "utf8")).toContain("english.mp3");
  });

  test("inspect validates fake non-network RPC, stable checkpoints, citation bounds, restart, and count-only privacy scan", async () => {
    const fixtureRepository = await fakeFixtureRepository();
    const runtimeRoot = freshRuntimePath();
    roots.push(runtimeRoot);
    const prepared = await prepareM3Live({ runtimeRoot, listen: "127.0.0.1:6794" }, dependencies(fixtureRepository));
    const store = new MeetingStore({ root: prepared.context.storeRoot });
    await store.grantTranscriptionConsent();
    for (const fixture of prepared.context.meetings) await publishFakeTranscript(store, fixture);
    const safeScan = {
      processArgv: scanCategory(), processEnvironment: scanCategory(),
      runtimeFiles: { log: scanCategory(), manifest: scanCategory(), renderer: scanCategory(), other: scanCategory() },
    };
    const connected = fakeConnectedClient(store);

    const inspected = await inspectM3Live(
      { contextPath: prepared.contextPath, timeoutMs: 100, pollMs: 1 },
      {
        MeetingStore, planTranscriptRanges,
        connectClient: async () => connected,
        delay: async () => undefined,
        scanArtifacts: async () => safeScan,
      },
    );

    expect(inspected.report).toMatchObject({
      status: "passed", providerStatus: "configured",
      restart: { readyTranscriptCount: 3, stateBytesUnchanged: true, noProviderCall: true },
    });
    expect(inspected.report.meetings).toHaveLength(3);
    expect(inspected.report.meetings.every((item: { transcript: { textCheck: { coverage: number } } }) => item.transcript.textCheck.coverage >= 0.75)).toBe(true);
  });

  test("text checks retain bilingual anchors and reject translated-away Vietnamese", () => {
    expect(assertExpectedText(
      "Meetless records the meeting, và lưu bản ghi an toàn!",
      "Meetless records the meeting. Và lưu bản ghi an toàn.",
      ["en", "vi"],
    )).toMatchObject({ coverage: 1, languagesRetained: ["en", "vi"] });
    expect(() => assertExpectedText(
      "Meetless records the meeting and stores the recording safely.",
      "Meetless records the meeting. Và lưu bản ghi an toàn.",
      ["en", "vi"],
    )).toThrow(/without translation|Vietnamese|translated/u);
  });

  test("privacy scanner reports only category counts and detects injected name/value violations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-m3-scan-"));
    roots.push(root);
    await mkdir(path.join(root, "logs"));
    await writeFile(path.join(root, "logs", "safe.log"), "provider configured\n");
    let result = await scanForbiddenArtifacts({ runtimeRoot: root, listen: "127.0.0.1:6795", processRows: [] });
    expect(totalHits(result)).toBe(0);

    await writeFile(path.join(root, "logs", "bad.log"), "OPENAI_API_KEY is forbidden\n");
    result = await scanForbiddenArtifacts({
      runtimeRoot: root,
      listen: "127.0.0.1:6795",
      processRows: [{ argv: "node safe", environment: "ALIAS=sk-proj-abcdefghijklmnop" }],
    });
    expect(totalHits(result)).toBe(2);
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("sk-proj-");
  });

  test("publish atomically binds candidate and supplied identities only after every check passes", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "meetless-m3-publish-repo-"));
    roots.push(repositoryRoot);
    const runtimeRoot = path.join(tmpdir(), `meetless-m3-live-publish-${randomUUID()}`);
    roots.push(runtimeRoot);
    await mkdir(runtimeRoot);
    const contextPath = path.join(runtimeRoot, "context.json");
    const inspectionPath = path.join(runtimeRoot, "inspection.json");
    const screenshot = path.join(runtimeRoot, "surface.png");
    const audio = path.join(runtimeRoot, "citation.mp3");
    const playback = path.join(runtimeRoot, "playback.json");
    const tools = path.join(runtimeRoot, "tools.json");
    const apps = path.join(runtimeRoot, "apps.json");
    const toolBinary = path.join(runtimeRoot, "ffmpeg-bin");
    const appBinary = path.join(runtimeRoot, "MeetlessHost");
    const context = publicationContext(runtimeRoot);
    const inspection = publicationInspection(runtimeRoot);
    await Promise.all([
      writeFile(contextPath, JSON.stringify(context)), writeFile(inspectionPath, JSON.stringify(inspection)),
      writeFile(screenshot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])),
      writeFile(audio, Buffer.from("ID3fixture-audio")),
      writeFile(playback, JSON.stringify({ meetingId: "m-1", segmentId: "segment-1", started: true, audible: true, observedDurationMs: 500 })),
      writeFile(toolBinary, "ffmpeg"), writeFile(appBinary, "meetless-host"),
    ]);
    await writeFile(tools, JSON.stringify({ tools: [{ name: "ffmpeg", path: toolBinary, sha256: hash("ffmpeg") }] }));
    await writeFile(apps, JSON.stringify({ apps: [{ name: "Meetless", path: appBinary, sha256: hash("meetless-host") }] }));
    const result = await publishM3Evidence({
      contextPath, inspectionPath, runId: "20260819T120000Z-live",
      uiScreenshotPath: screenshot, citedAudioPath: audio, playbackMetadataPath: playback,
      toolIdentitiesPath: tools, appIdentitiesPath: apps,
    }, { repositoryRoot, candidateSnapshot: () => candidate });
    expect(JSON.parse(await readFile(path.join(result.destination, "manifest.json"), "utf8"))).toMatchObject({
      schema: "MEETLESS_M3_LIVE_EVIDENCE v1", status: "passed", candidateSnapshot: candidate,
    });

    const rejectedDestination = path.join(repositoryRoot, "test/evidence/m3/20260819T120001Z-rejected");
    await writeFile(tools, JSON.stringify({ tools: [{ name: "bad", path: toolBinary, sha256: hash("ffmpeg"), value: "sk-proj-abcdefghijklmnop" }] }));
    await expect(publishM3Evidence({
      contextPath, inspectionPath, runId: "20260819T120001Z-rejected",
      uiScreenshotPath: screenshot, citedAudioPath: audio, playbackMetadataPath: playback,
      toolIdentitiesPath: tools, appIdentitiesPath: apps,
    }, { repositoryRoot, candidateSnapshot: () => candidate })).rejects.toThrow(/forbidden credential material/);
    await expect(readFile(path.join(rejectedDestination, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fakeFixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-m3-fixtures-"));
  roots.push(root);
  const fixtureRoot = path.join(root, "test/fixtures/m3");
  await mkdir(fixtureRoot, { recursive: true });
  const fixtures = [
    { file: "english.mp3", languages: ["en"], expectedExactPhrase: "Meetless records clear English." },
    { file: "vietnamese.mp3", languages: ["vi"], expectedExactPhrase: "Meetless ghi âm tiếng Việt rõ ràng." },
    { file: "mixed-en-vi.mp3", languages: ["en", "vi"], expectedExactPhrase: "Meetless records the meeting. Và lưu bản ghi an toàn." },
  ];
  await writeFile(path.join(fixtureRoot, "manifest.json"), JSON.stringify({ version: 1, fixtures }));
  await Promise.all(fixtures.map((fixture) => writeFile(path.join(fixtureRoot, fixture.file), `ID3fake-${fixture.file}`)));
  return root;
}

function dependencies(repositoryRoot: string) {
  return {
    repositoryRoot, MeetingStore,
    assertCommittedFixture: async () => undefined,
    candidateSnapshot: () => candidate,
  };
}

function freshRuntimePath() {
  return path.join(tmpdir(), `meetless-m3-live-${randomUUID()}`);
}

async function publishFakeTranscript(store: MeetingStore, fixture: any) {
  let transcript = await store.ensureTranscript({
    meetingId: fixture.meetingId, recordingId: fixture.recordingId,
    audio: { destination: fixture.destination, ...fixture.outputIdentity, durationMs: 1_000 },
  });
  const request = await store.beginTranscriptRequest(transcript.id);
  transcript = await store.checkpointTranscriptRange(transcript.id, {
    range: request!.range, attempts: request!.attempt, text: fixture.expectedExactPhrase,
    usage: { durationSeconds: 1 }, detectedLanguages: fixture.languages,
  });
  await store.publishTranscript(transcript.id);
}

function fakeConnectedClient(store: MeetingStore) {
  return {
    client: {
      getMeetingTranscript: async (meetingId: string) => {
        const meeting = (await store.list()).find((item) => item.id === meetingId)!;
        const transcript = (await store.getTranscriptForMeeting(meetingId))!;
        return {
          meeting,
          transcript: {
            id: transcript.id, meetingId, recordingId: transcript.recordingId, status: transcript.status,
            plannerVersion: transcript.plannerVersion, audioDurationMs: transcript.audio.durationMs,
            ranges: transcript.ranges,
            segments: transcript.checkpoints.map((checkpoint) => ({
              range: checkpoint.range, text: checkpoint.text, completedAt: checkpoint.completedAt,
              detectedLanguages: checkpoint.detectedLanguages,
            })),
            requestCount: transcript.requestCount, usage: transcript.usage,
            detectedLanguages: transcript.detectedLanguages, failureReason: transcript.failureReason,
          },
          consent: await store.transcriptionConsent(), provider: { status: "configured" },
        };
      },
      resolveCitation: async ({ meetingId, segmentId }: { meetingId: string; segmentId: string }) => {
        const citation = await store.resolveCitation(meetingId, segmentId);
        return { ...citation, audio: { mimeType: "audio/mpeg", base64: "AQID" } };
      },
    },
    close: async () => undefined,
  };
}

function scanCategory() { return { scanned: 0, credentialNameHits: 0, keyShapeHits: 0 }; }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function totalHits(scan: any) {
  return [scan.processArgv, scan.processEnvironment, ...Object.values(scan.runtimeFiles) as any[]]
    .reduce((sum, item) => sum + item.credentialNameHits + item.keyShapeHits, 0);
}

function publicationContext(runtimeRoot: string) {
  return {
    schema: "MEETLESS_M3_LIVE_CONTEXT v1", runtimeRoot, storeRoot: path.join(runtimeRoot, "meeting-store"),
    listen: "127.0.0.1:6796", daemonUrl: "ws://127.0.0.1:6796/ws", candidateSnapshot: candidate,
    leadSteps: { restoreDefaultHostConfiguration: "env -u MEETLESS_RUNTIME_ROOT -u MEETLESS_LISTEN npm run host:install" },
  };
}

function publicationInspection(runtimeRoot: string) {
  return {
    schema: "MEETLESS_M3_LIVE_INSPECTION v1", status: "passed", runtimeRoot, listen: "127.0.0.1:6796",
    candidateSnapshot: candidate, providerStatus: "configured",
    meetings: [{
      meetingId: "m-1",
      transcript: { segmentId: "segment-1", range: { startMs: 0, endMs: 1_000 } },
      citation: { sha256: hash("ID3fixture-audio") },
    }],
    restart: { readyTranscriptCount: 3, stateBytesUnchanged: true, noProviderCall: true },
    privacyScan: {
      processArgv: scanCategory(), processEnvironment: scanCategory(),
      runtimeFiles: { log: scanCategory(), manifest: scanCategory(), renderer: scanCategory(), other: scanCategory() },
    },
  };
}
