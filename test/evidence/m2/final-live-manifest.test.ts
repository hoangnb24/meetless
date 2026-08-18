import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const manifestPath = new URL("./20260818T152654Z-final-live/manifest.json", import.meta.url);

describe("M2 final production live evidence", () => {
  test("binds both audible degraded sources, no-overwrite, playable output, and a bounded acceptance claim", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      phraseEvidence: Record<"system" | "microphone", { clipPath: string; clipSha256: string; source: string; audible: boolean; quality: string }>;
      collisionEvidence: { sentinelPath: string; sentinelByteLength: number; sentinelSha256After: string; unchanged: boolean; publishedPath: string };
      output: { path: string; byteLength: number; sha256: string; readable: boolean; durableSavedIdentityMatchedFile: boolean };
      shutdown: Record<string, boolean>;
      leadDecision: { milestone2Accepted: boolean; qualityClaim: string; residualRisk: string };
    };
    expect(manifest.phraseEvidence.system).toMatchObject({ source: "system", audible: true, quality: "distorted-static-like" });
    expect(manifest.phraseEvidence.microphone).toMatchObject({ source: "microphone", audible: true, quality: "distorted-static-like" });
    for (const evidence of [manifest.phraseEvidence.system, manifest.phraseEvidence.microphone]) {
      const bytes = await readFile(evidence.clipPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidence.clipSha256);
    }
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
    expect(Object.values(manifest.shutdown).every((value) => value === false)).toBe(true);
    expect(manifest.leadDecision).toMatchObject({ milestone2Accepted: true });
    expect(manifest.leadDecision.qualityClaim).toMatch(/No clean or normal-quality claim/u);
    expect(manifest.leadDecision.residualRisk).toMatch(/before Milestone 7 release acceptance/u);
  });
});
