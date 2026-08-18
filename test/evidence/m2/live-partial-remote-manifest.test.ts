import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const manifestPath = new URL("./20260818T060510Z-live-partial-remote/manifest.json", import.meta.url);

describe("M2 remote-owner partial live evidence", () => {
  test("proves playable no-overwrite evidence without claiming microphone acceptance", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      ownerHandback: { systemPhraseAudibility: string; microphonePhraseReported: string | null; microphoneAudibility: string; m2Acceptance: boolean };
      inventory: { microphone: number; system: number; rawChunksDeletedOnlyAfterSaved: boolean; immutableSidecarRetained: boolean };
      collisionEvidence: { sentinelPath: string; sentinelByteLength: number; sentinelSha256After: string; unchanged: boolean; publishedPath: string };
      output: { path: string; byteLength: number; sha256: string; readable: boolean; durableSavedIdentityMatchedFile: boolean };
      acceptanceBoundary: string;
    };
    expect(manifest.ownerHandback).toMatchObject({
      systemPhraseAudibility: "unproven-by-listening",
      microphonePhraseReported: null,
      microphoneAudibility: "unproven-owner-not-at-mac",
      m2Acceptance: false,
    });
    expect(manifest.inventory).toMatchObject({
      microphone: 187,
      system: 193,
      rawChunksDeletedOnlyAfterSaved: true,
      immutableSidecarRetained: true,
    });
    const sentinel = await readFile(manifest.collisionEvidence.sentinelPath);
    expect(sentinel.byteLength).toBe(manifest.collisionEvidence.sentinelByteLength);
    expect(createHash("sha256").update(sentinel).digest("hex")).toBe(manifest.collisionEvidence.sentinelSha256After);
    expect(manifest.collisionEvidence.unchanged).toBe(true);
    expect(manifest.collisionEvidence.publishedPath).not.toBe(manifest.collisionEvidence.sentinelPath);
    const output = await readFile(manifest.output.path);
    expect(output.byteLength).toBe(manifest.output.byteLength);
    expect(createHash("sha256").update(output).digest("hex")).toBe(manifest.output.sha256);
    expect(manifest.output).toMatchObject({ readable: true, durableSavedIdentityMatchedFile: true });
    expect((await stat(manifest.output.path)).isFile()).toBe(true);
    expect(manifest.acceptanceBoundary).toMatch(/both-speaker and microphone acceptance are not proven/u);
  });
});
