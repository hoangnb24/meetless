import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  NATIVE_TEST_POLICY_REQUIRED,
  nativeTestEvidence,
  parseNativeTestPolicyArguments,
  validateNativeTestPolicy,
} from "./lib/native-test-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const environment = {
  ...process.env,
  SWIFTPM_MODULECACHE_OVERRIDE: "/private/tmp/meetless-swift-module-cache",
  CLANG_MODULE_CACHE_PATH: "/private/tmp/meetless-clang-module-cache",
};
const nativeTestEnvironment = {
  ...environment,
  MEETLESS_TEST_PACKAGE_NODE_SOURCE: process.execPath,
};

export async function buildNative({ nativeTestPolicy = NATIVE_TEST_POLICY_REQUIRED, runCommand = run } = {}) {
  validateNativeTestPolicy(nativeTestPolicy);
  await mkdir(path.join(repositoryRoot, "packages/runtime/dist"), { recursive: true });
  await runCommand("swift", ["build", "-c", "release", "--package-path", "native/macos-capture"]);
  await runCommand("swift", ["build", "-c", "release", "--package-path", "native/macos-host", "--product", "MeetlessHost"]);
  const hostArtifact = path.join(repositoryRoot, "native/macos-host/.build/release/MeetlessHost");
  await assertRevenueCatLinkedHost(hostArtifact);
  process.stdout.write(`RevenueCat-linked MeetlessHost artifact: ${hostArtifact}\n`);
  await runCommand("swift", ["build", "-c", "release", "--package-path", "native/macos-host", "--product", "MeetlessMasGateMutation"]);
  const mutationArtifact = path.join(repositoryRoot, "native/macos-host/.build/release/MeetlessMasGateMutation");
  await assertArm64MachO(mutationArtifact, "MAS mutation helper");
  process.stdout.write(`Native MAS mutation helper artifact: ${mutationArtifact}\n`);
  await runCommand("xcrun", [
    "swiftc",
    "-O",
    "packages/runtime/native/process-argv.swift",
    "-o",
    "packages/runtime/dist/meetless-process-argv",
  ]);
  await runCommand("swift", ["build", "-c", "debug", "--package-path", "native/macos-host", "--product", "MeetlessHostTests"]);
  await runCommand("swift", ["build", "-c", "release", "--package-path", "native/macos-host", "--product", "MeetlessHostTests"]);

  const evidence = nativeTestEvidence(nativeTestPolicy);
  if (nativeTestPolicy === NATIVE_TEST_POLICY_REQUIRED) {
    await runCommand(path.join(repositoryRoot, "native/macos-host/.build/debug/MeetlessHostTests"), [], nativeTestEnvironment);
    await runCommand(path.join(repositoryRoot, "native/macos-host/.build/release/MeetlessHostTests"), [], nativeTestEnvironment);
  } else {
    process.stdout.write(`Native test executables ${evidence.status}: ${evidence.ownerDecision.pointer}\n`);
  }
  return evidence;
}

async function assertRevenueCatLinkedHost(candidate) {
  const inspected = await stat(candidate).catch(() => null);
  if (!inspected?.isFile()) {
    throw new Error(`SwiftPM did not produce the required RevenueCat-linked host artifact at ${candidate}`);
  }
  const { stdout: fileOutput } = await execFileAsync("file", [candidate], { cwd: repositoryRoot, env: environment });
  if (!/Mach-O 64-bit executable arm64/u.test(fileOutput)) {
    throw new Error(`SwiftPM host artifact is not an arm64 Mach-O executable: ${candidate}`);
  }
  const { stdout: symbols } = await execFileAsync("nm", ["-gU", candidate], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!/\$s10RevenueCat/u.test(symbols)) {
    throw new Error(
      `SwiftPM host artifact has no linked RevenueCat symbols: ${candidate}. ` +
      "Build the native host through native/macos-host/Package.swift; do not use the #else fallback.",
    );
  }
}

async function assertArm64MachO(candidate, label) {
  const inspected = await stat(candidate).catch(() => null);
  if (!inspected?.isFile()) throw new Error(`SwiftPM did not produce the required ${label} at ${candidate}`);
  const { stdout: fileOutput } = await execFileAsync("file", [candidate], { cwd: repositoryRoot, env: environment });
  if (!/Mach-O 64-bit executable arm64/u.test(fileOutput)) {
    throw new Error(`${label} is not an arm64 Mach-O executable: ${candidate}`);
  }
}

function run(command, arguments_, childEnvironment = environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${code ?? "unknown"}`}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nativeTestPolicy = parseNativeTestPolicyArguments(process.argv.slice(2));
  await buildNative({ nativeTestPolicy });
}
