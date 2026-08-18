import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const manifestPath = new URL("./20260818T031937Z-live-partial/manifest.json", import.meta.url);

describe("M2 production live-partial evidence manifest", () => {
  test("retains compact source identities without claiming unproved acceptance", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      candidateCommit: string;
      sourceInventory: { retainedAtManifest: { microphone: number; system: number; total: number }; representativeChunks: Array<{ path: string; byteLength: number; sha256: string; source: string }> };
      collisionEvidence: { path: string; byteLength: number; sha256: string | null; hashStatus: string };
      ownerHandback: { systemPhraseAudibility: string; microphoneAcceptance: string; playableMp3: string };
      preservation: Record<string, boolean>;
    };
    expect(manifest.candidateCommit).toBe("c82da856d25a2f4a59e24e7e46ea440a77ed5b7b");
    expect(manifest.sourceInventory.retainedAtManifest).toEqual({ microphone: 12926, system: 7210, total: 20136 });
    expect(new Set(manifest.sourceInventory.representativeChunks.map((chunk) => chunk.source))).toEqual(new Set(["microphone", "system"]));
    for (const chunk of manifest.sourceInventory.representativeChunks) {
      const bytes = await readFile(chunk.path);
      expect(bytes.byteLength).toBe(chunk.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(chunk.sha256);
    }
    expect((await stat(manifest.collisionEvidence.path)).size).toBe(manifest.collisionEvidence.byteLength);
    expect(manifest.collisionEvidence.sha256).toBeNull();
    expect(manifest.collisionEvidence.hashStatus).toMatch(/bounded content reads blocked.*not regenerated/u);
    expect(manifest.ownerHandback).toMatchObject({
      systemPhraseAudibility: "unproven-by-executable-inspection",
      microphoneAcceptance: "unproven",
      playableMp3: "unproven-no-finalization-attempted",
    });
    expect(manifest.preservation).toEqual({
      chunksCopied: false, chunksDeleted: false, finalizationAttempted: false, newCollisionSentinelCreated: false,
    });
  });
});
