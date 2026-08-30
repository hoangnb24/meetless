import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PASEO_DEPENDENCY } from "./lib/paseo-dependency.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(repositoryRoot, PASEO_DEPENDENCY.bundlePath);
const bundleBytes = await readFile(bundlePath);
const bundleStats = await stat(bundlePath);
const digest = createHash("sha256").update(bundleBytes).digest("hex");
if (digest !== PASEO_DEPENDENCY.bundleSha256 || bundleStats.size !== PASEO_DEPENDENCY.bundleSize) {
  throw new Error(
    `Paseo dependency bundle does not match its content address. ` +
    `Authority: docs/decisions/0001-maintained-paseo-fork.md. ` +
    `Next action: restore ${PASEO_DEPENDENCY.bundlePath} with SHA-256 ${PASEO_DEPENDENCY.bundleSha256}.`,
  );
}

const checkout = await mkdtemp(path.join(tmpdir(), "meetless-paseo-bundle-checkout-"));
try {
  await git(["init", "--quiet", checkout]);
  await git(["-C", checkout, "fetch", "--quiet", "--no-tags", bundlePath,
    `${PASEO_DEPENDENCY.bundleRef}:refs/remotes/meetless/candidate`]);
  await git(["-C", checkout, "checkout", "--quiet", "--detach", PASEO_DEPENDENCY.expectedCommit]);
  const head = (await git(["-C", checkout, "rev-parse", "HEAD"])).trim();
  if (head !== PASEO_DEPENDENCY.expectedCommit) {
    throw new Error(`Paseo bundle checkout resolved ${head}, expected ${PASEO_DEPENDENCY.expectedCommit}`);
  }
  await git(["-C", checkout, "fsck", "--full", "--no-dangling"]);
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    expectedCommit: PASEO_DEPENDENCY.expectedCommit,
    bundlePath: PASEO_DEPENDENCY.bundlePath,
    bundleSha256: digest,
    bundleSize: bundleStats.size,
    freshCheckoutHead: head,
  }, null, 2)}\n`);
} finally {
  await rm(checkout, { recursive: true, force: true });
}

async function git(args) {
  return (await execFileAsync("git", args, {
    cwd: repositoryRoot,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
  })).stdout;
}
