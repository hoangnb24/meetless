import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PrivateAudioSnapshotStore, sweepOwnedAudioCandidates } from "../src/private-audio-snapshot.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("verified private audio snapshots", () => {
  test("binds copied bytes to the saved identity and source replacement cannot change the snapshot", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "saved.mp3");
    const original = Buffer.from("authoritative saved mp3 bytes");
    await writeFile(source, original, { mode: 0o600 });
    const store = new PrivateAudioSnapshotStore(path.join(root, "snapshots"), "transcription-source");
    const snapshot = await store.create(source, identity(original));
    try {
      await writeFile(source, "replacement bytes");
      expect(await readFile(snapshot.path)).toEqual(original);
      expect(snapshot.path).not.toBe(source);
    } finally {
      await snapshot.cleanup();
    }
  });

  test("rejects tampered bytes and leaves no candidate behind", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "saved.mp3");
    const original = Buffer.from("original bytes");
    await writeFile(source, "tampered bytes", { mode: 0o600 });
    const directory = path.join(root, "snapshots");
    const store = new PrivateAudioSnapshotStore(directory, "transcription-source");
    await expect(store.create(source, identity(original))).rejects.toThrow(/identity changed/);
    expect(await readdir(directory)).toEqual([]);
  });

  test("startup sweeps only its own regular stale candidates", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "snapshots");
    await mkdir(directory);
    const owned = "citation-source-11111111-1111-4111-8111-111111111111.mp3";
    const unrelated = "authoritative-recording.mp3";
    const matchingDirectory = "citation-source-22222222-2222-4222-8222-222222222222.mp3";
    const matchingSymlink = "citation-source-33333333-3333-4333-8333-333333333333.mp3";
    await writeFile(path.join(directory, owned), "stale");
    await writeFile(path.join(directory, unrelated), "keep");
    await mkdir(path.join(directory, matchingDirectory));
    await symlink(path.join(directory, unrelated), path.join(directory, matchingSymlink));

    await new PrivateAudioSnapshotStore(directory, "citation-source").initialize();

    expect((await readdir(directory)).sort()).toEqual([matchingDirectory, matchingSymlink, unrelated].sort());
  });

  test("range and citation-clip owners sweep only UUID MP3 regular files", async () => {
    const root = await temporaryRoot();
    const owned = "11111111-1111-4111-8111-111111111111.mp3";
    await writeFile(path.join(root, owned), "stale range");
    await writeFile(path.join(root, "recording.mp3"), "authoritative");
    await mkdir(path.join(root, "22222222-2222-4222-8222-222222222222.mp3"));

    await sweepOwnedAudioCandidates(root, /^[0-9a-f-]{36}\.mp3$/);

    expect((await readdir(root)).sort()).toEqual([
      "22222222-2222-4222-8222-222222222222.mp3",
      "recording.mp3",
    ]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-audio-snapshot-"));
  roots.add(root);
  return root;
}

function identity(bytes: Buffer) {
  return { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
