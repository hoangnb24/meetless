#!/usr/bin/env node

import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const nodePath = path.resolve(process.execPath);
const vitestPath = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const syntaxTargets = [
  path.join(repositoryRoot, "scripts", "prove-managed-convex-guard.mjs"),
  path.join(repositoryRoot, "scripts", "prove-managed-convex-runtime.mjs"),
  path.join(repositoryRoot, "scripts", "prove-managed-convex-local.mjs"),
  path.join(repositoryRoot, "scripts", "validate-managed-convex-deploy.mjs"),
  path.join(repositoryRoot, "scripts", "prove-managed-convex-hosted-dev-target.mjs"),
  path.join(repositoryRoot, "scripts", "prove-managed-convex-hosted-dev.mjs"),
];
const pureTestTargets = [
  path.join(repositoryRoot, "test", "managed-convex-local-guard.test.ts"),
  path.join(repositoryRoot, "test", "convex-hosted-dev.test.ts"),
  path.join(repositoryRoot, "test", "composition", "managed-transcription-path.test.ts"),
  path.join(repositoryRoot, "packages", "managed-transcription-foundation", "test", "policy.test.ts"),
  path.join(repositoryRoot, "packages", "meetless-plugin", "test", "managed-transcription.test.ts"),
  path.join(repositoryRoot, "packages", "meetless-plugin", "test", "managed-upload.test.ts"),
];
const phase1Environment = { CI: "1", DISABLE_BEACON: "1" };

async function exists(filePath) {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(nodePath, args, {
      cwd: repositoryRoot,
      env: phase1Environment,
      shell: false,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Phase-1 executable failed: ${args.join(" ")}`));
        return;
      }
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolve();
    });
    child.once("error", () => reject(new Error(`Phase-1 executable could not start: ${args.join(" ")}`)));
  });
}

for (const target of syntaxTargets) {
  if (!(await exists(target))) throw new Error(`Phase-1 syntax target is missing: ${target}`);
  await runNode(["--check", target]);
}
await runNode([
  vitestPath,
  "run",
  "--config", path.join(repositoryRoot, "vitest.config.ts"),
  ...pureTestTargets,
  "--maxWorkers=1",
]);
