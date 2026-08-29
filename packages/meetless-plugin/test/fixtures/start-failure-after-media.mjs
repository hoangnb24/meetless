import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [sourceWav, mode] = process.argv.slice(2);
process.stdin.setEncoding("utf8");
process.stdin.once("data", (line) => {
  const command = JSON.parse(line);
  mkdirSync(command.sessionDirectory, { recursive: true, mode: 0o700 });
  const id = "chunk--microphone--000000--000000000000--000000016000--16000--1";
  const destination = path.join(command.sessionDirectory, `${id}.wav`);
  copyFileSync(sourceWav, destination);
  const chunk = {
    version: 1,
    event: "chunkCommitted",
    id,
    source: "microphone",
    path: destination,
    byteLength: statSync(destination).size,
    sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
    logicalStartMs: 0,
    durationMs: 1_000,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
  const failure = { version: 1, event: "error", error: "capture startup failed after media" };
  const events = mode === "orphan" ? [failure] : mode === "late" ? [failure, chunk] : [chunk, failure];
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
});
