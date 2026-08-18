import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve(import.meta.dirname, "../../../test/fixtures/m3");

describe("committed M3 live-acceptance audio fixtures", () => {
  test("includes short English, Vietnamese, and mixed audio with exact phrase metadata", async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8")) as {
      authority: string;
      generator: string;
      fixtures: Array<{
        file: string;
        languages: string[];
        voice: string;
        expectedExactPhrase: string;
        maximumDurationSeconds: number;
      }>;
    };
    expect(manifest.authority).toContain("v1-paseo-foundation.md#milestone-3");
    expect(manifest.generator).toBe("node scripts/generate-m3-fixtures.mjs");
    expect(manifest.fixtures.map((fixture) => fixture.languages)).toEqual([["en"], ["vi"], ["en", "vi"]]);
    expect(manifest.fixtures.map((fixture) => fixture.expectedExactPhrase)).toEqual([
      "Meetless records clear English.",
      "Meetless ghi âm tiếng Việt rõ ràng.",
      "Meetless records the meeting. Và lưu bản ghi an toàn.",
    ]);

    for (const fixture of manifest.fixtures) {
      expect(fixture.voice.length).toBeGreaterThan(0);
      expect(fixture.expectedExactPhrase.endsWith(".")).toBe(true);
      const filePath = path.join(fixtureRoot, fixture.file);
      expect((await stat(filePath)).size).toBeGreaterThan(1_000);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", filePath,
      ]);
      const duration = Number(stdout.trim());
      expect(duration).toBeGreaterThan(0.5);
      expect(duration).toBeLessThanOrEqual(fixture.maximumDurationSeconds);
    }
  });
});
