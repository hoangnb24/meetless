#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readKhuymStatus, renderKhuymStatus, resolveRepoRoot } from "./khuym_state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseCliArgs(argv) {
  const args = {
    repoRoot: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      args.repoRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      args.repoRoot = arg.slice("--repo-root=".length);
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: khuym_status.mjs [--repo-root <path>] [--json]",
          "",
          "Shows a read-only Khuym status snapshot from onboarding, state, and handoff files.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const repoRoot = resolveRepoRoot(args.repoRoot, SCRIPT_DIR);
  const status = readKhuymStatus(repoRoot);

  process.stdout.write(
    args.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderKhuymStatus(status)}\n`,
  );
  return 0;
}

if (process.argv[1]) {
  process.exitCode = main();
}
