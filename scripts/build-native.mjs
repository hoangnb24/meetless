import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  SWIFTPM_MODULECACHE_OVERRIDE: "/private/tmp/meetless-swift-module-cache",
  CLANG_MODULE_CACHE_PATH: "/private/tmp/meetless-clang-module-cache",
};

await mkdir(path.join(repositoryRoot, "packages/runtime/dist"), { recursive: true });
await run("swift", ["build", "-c", "release", "--package-path", "native/macos-capture"]);
await run("xcrun", [
  "swiftc",
  "-O",
  "packages/runtime/native/process-argv.swift",
  "-o",
  "packages/runtime/dist/meetless-process-argv",
]);
await run("xcrun", [
  "swiftc",
  "-framework",
  "AppKit",
  "-framework",
  "Security",
  "native/macos-host/MeetlessHost.swift",
  "native/macos-host/TranscriptionCapability.swift",
  "native/macos-host/TranscriptionCapabilityTests.swift",
  "-o",
  "/private/tmp/meetless-transcription-capability-tests",
]);
await run("/private/tmp/meetless-transcription-capability-tests", []);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${code ?? "unknown"}`}`));
    });
  });
}
