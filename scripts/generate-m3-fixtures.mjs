import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const outputRoot = path.resolve("test/fixtures/m3");
const workingRoot = mkdtempSync(path.join(tmpdir(), "meetless-m3-fixtures-"));
const ffmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
const common = [
  "-hide_banner", "-loglevel", "error", "-y", "-map_metadata", "-1",
  "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "32k",
  "-write_xing", "0", "-fflags", "+bitexact", "-flags:a", "+bitexact",
];

try {
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  const english = path.join(workingRoot, "english.aiff");
  const vietnameseBrand = path.join(workingRoot, "vietnamese-brand.aiff");
  const vietnameseClause = path.join(workingRoot, "vietnamese-clause.aiff");
  const mixedEnglish = path.join(workingRoot, "mixed-english.aiff");
  const mixedVietnamese = path.join(workingRoot, "mixed-vietnamese.aiff");
  say("Samantha", "Meetless records clear English.", english);
  // Separate the brand syllables and clause acoustically so the short fixture
  // remains intelligible without changing the spoken sentence.
  say("Samantha", "Meet less", vietnameseBrand, 155);
  say("Linh", "ghi âm tiếng Việt rõ ràng.", vietnameseClause, 150);
  say("Samantha", "Meetless records the meeting.", mixedEnglish);
  say("Linh", "Và lưu bản ghi an toàn.", mixedVietnamese);
  encode(["-i", english], "english.mp3");
  encode(
    [
      "-i", vietnameseBrand,
      "-i", vietnameseClause,
      "-filter_complex", "[1:a]adelay=250:all=1[vi];[0:a][vi]concat=n=2:v=0:a=1",
    ],
    "vietnamese.mp3",
  );
  encode(
    ["-i", mixedEnglish, "-i", mixedVietnamese, "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1"],
    "mixed-en-vi.mp3",
  );
} finally {
  rmSync(workingRoot, { recursive: true, force: true });
}

function say(voice, phrase, destination, rate = 170) {
  execFileSync("/usr/bin/say", ["-v", voice, "-r", String(rate), "-o", destination, phrase]);
}

function encode(inputArguments, filename) {
  execFileSync(ffmpeg, [...inputArguments, ...common, path.join(outputRoot, filename)]);
}
