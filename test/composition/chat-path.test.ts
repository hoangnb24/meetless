import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PluginContext } from "@paseo/plugin";
import { MeetlessClient, type MeetlessDaemonPort } from "@meetless/client";
import { MeetingStore } from "@meetless/meeting-store";
import contribute from "../../packages/meetless-plugin/index.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  delete process.env.MEETLESS_RUNTIME_ROOT;
  delete process.env.MEETLESS_STORE_ROOT;
});

describe("Meetless chat plugin/client composition", () => {
  test("discovers Codex and restores a durable insufficient-evidence turn without Paseo IDs", async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-chat-composition-"));
    process.env.MEETLESS_RUNTIME_ROOT = root;
    process.env.MEETLESS_STORE_ROOT = path.join(root, "meeting-store");
    const store = new MeetingStore({ root: process.env.MEETLESS_STORE_ROOT, now: () => "2026-08-21T00:00:00.000Z" });
    await readyMeeting(store);

    const archive = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const paseo = {
      providers: { waitForReady: async () => ({ entries: [{
        provider: "codex", enabled: true, status: "ready", label: "Codex",
        models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
      }] }) },
      workspaces: { open: async () => ({ agents: { create: async () => ({
        waitForFinish: async () => ({
          status: "idle", final: null, error: null,
          lastMessage: JSON.stringify({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }),
        }),
        archive,
      }) } }) },
    };
    const handlers = new Map<string, (input: any, context: any) => unknown>();
    const cleanup = contribute({
      handle: (contract: { name: string }, handler: (input: any, context: any) => unknown) => handlers.set(contract.name, handler),
      addSurface: vi.fn(), addSidebarItem: vi.fn(), addAttachmentSource: vi.fn(),
    } as unknown as PluginContext);
    const daemon: MeetlessDaemonPort = {
      getLastServerInfoMessage: () => ({ features: { plugins: true } }),
      getPluginCatalog: async () => [{ id: "meetless", clientBundle: "bundle" }],
      invokePluginRpc: async (_pluginId, method, input) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`Missing plugin handler: ${method}`);
        return handler(input, { paseo });
      },
    };
    const client = new MeetlessClient(daemon);
    await client.initialize();
    await expect(client.listChatProviders()).resolves.toMatchObject({
      providers: [{ id: "codex", models: [{ id: "gpt-5" }] }],
      compatibilityCheck: "on_question_start",
    });
    const running = await client.askMeetingQuestion({
      meetingId: "meeting-1", question: "What is not in the meeting?", provider: "codex", model: "gpt-5",
    });
    expect(running.status).toBe("running");
    await vi.waitFor(async () => expect((await client.getMeetingChat("meeting-1"))?.status).toBe("ready"));
    const restored = await client.getMeetingChat("meeting-1");
    expect(restored?.messages.at(-1)).toMatchObject({ outcome: "insufficient_evidence", text: null, citations: [] });
    const persisted = await readFile(path.join(root, "meeting-store", "meetings.json"), "utf8");
    expect(persisted).not.toMatch(/agentId|workspaceId|sessionId|timeline|paseo-agent/u);
    expect(archive).toHaveBeenCalledOnce();
    await cleanup();
  });
});

async function readyMeeting(store: MeetingStore): Promise<void> {
  const now = "2026-08-21T00:00:00.000Z";
  await store.create({ id: "meeting-1", title: "Chat fixture" });
  await store.startRecording({ id: "recording-1", meetingId: "meeting-1" });
  await store.commitChunk("recording-1", {
    id: "chunk-1", source: "microphone", storageKey: "sessions/recording-1/chunk.wav",
    byteLength: 128, sha256: "chunk-sha", committedAt: now, logicalStartMs: 0,
    durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery("recording-1", "capture closed");
  await store.markInventoryScanning("recording-1");
  await store.publishInventory("recording-1", {
    storageKey: "sessions/recording-1/inventory.ndjson", digest: "inventory-sha",
    chunkCount: recovered.inventory.knownChunkCount, microphoneCount: 1, systemCount: 0, publishedAt: now,
  });
  await store.beginFinalization("recording-1", {
    openChunksDurablyClosed: true, chunkSetDigest: "inventory-sha", destination: "meetings/recording-1.mp3",
    expectedIdentity: { byteLength: 256, sha256: "audio-sha" },
  });
  await store.markRecordingSaved("recording-1", {
    destination: "meetings/recording-1.mp3", identity: { byteLength: 256, sha256: "audio-sha" }, readable: true,
  });
  const transcript = await store.ensureTranscript({
    meetingId: "meeting-1", recordingId: "recording-1", rangeMs: 1_000,
    audio: { destination: "meetings/recording-1.mp3", byteLength: 256, sha256: "audio-sha", durationMs: 1_000 },
  });
  const request = await store.beginTranscriptRequest(transcript.id);
  await store.checkpointTranscriptRange(transcript.id, {
    range: transcript.ranges[0]!, attempts: request!.attempt,
    text: "The meeting chose local-first storage.", usage: null, detectedLanguages: ["en"],
  });
  await store.publishTranscript(transcript.id);
}
