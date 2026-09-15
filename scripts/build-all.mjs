import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTestEvidence, parseNativeTestPolicyArguments } from "./lib/native-test-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeTestPolicy = parseNativeTestPolicyArguments(process.argv.slice(2));

await run("npm", ["run", "build:paseo"]);
await run("npm", ["run", "build:meetless"]);
await run(process.execPath, [path.join(repositoryRoot, "scripts/build-native.mjs"), `--native-test-policy=${nativeTestPolicy}`]);
await run("npm", ["run", "build:app"]);

process.stdout.write(`${JSON.stringify({ nativeTests: nativeTestEvidence(nativeTestPolicy) })}\n`);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${code ?? "unknown"}`}`));
    });
  });
}
