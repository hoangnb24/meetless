import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const [statePath, sourceWav] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.command === "start") {
    if (!existsSync(statePath)) {
      writeFileSync(statePath, "denied\n", { mode: 0o600 });
      emit({ version: 1, event: "error", error: "The user declined TCCs for application, window, display capture" });
      return;
    }
    mkdirSync(command.sessionDirectory, { recursive: true, mode: 0o700 });
    const id = "chunk--microphone--000000--000000000000--000000016000--16000--1";
    const destination = path.join(command.sessionDirectory, `${id}.wav`);
    copyFileSync(sourceWav, destination);
    emit({ version: 1, event: "started" });
    emit(chunkEvent(id, destination));
    return;
  }
  if (command.command === "stop") {
    emit({ version: 1, event: "stopped" });
    lines.close();
  }
});

function chunkEvent(id, filePath) {
  const data = readFileSync(filePath);
  return {
    version: 1,
    event: "chunkCommitted",
    id,
    source: "microphone",
    path: filePath,
    byteLength: statSync(filePath).size,
    sha256: createHash("sha256").update(data).digest("hex"),
    logicalStartMs: 0,
    durationMs: 1_000,
    sampleRate: 16_000,
    channels: 1,
    format: "wav",
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
