import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PASEO_DEPENDENCY } from "./lib/paseo-dependency.mjs";

export const DEFAULT_SNAPSHOT_MODE = "default";
export const PACKAGE_SOURCE_MODE = "package-source";
export const PACKAGE_SOURCE_SNAPSHOT_COMMAND = "node scripts/candidate-snapshot.mjs --mode=package-source";
export const PACKAGE_SOURCE_DIGEST_DOMAIN = "MEETLESS_PACKAGE_SOURCE_SNAPSHOT_v1\0";
export const PACKAGE_SOURCE_EXCLUDED_PATHS = Object.freeze([
  "test/evidence/m7/m7-f3-packaged-controlled-lifecycle.json",
]);

const scope = [
  ".gitignore",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "vitest.config.ts",
  "native",
  "packages",
  "scripts",
  "test",
  "vendor/paseo",
  "vendor/paseo-bundles",
];

export function parseSnapshotMode(arguments_) {
  if (arguments_.length === 0) return DEFAULT_SNAPSHOT_MODE;
  if (arguments_.length === 1 && arguments_[0] === `--mode=${PACKAGE_SOURCE_MODE}`) return PACKAGE_SOURCE_MODE;
  if (arguments_.length === 2 && arguments_[0] === "--mode" && arguments_[1] === PACKAGE_SOURCE_MODE) return PACKAGE_SOURCE_MODE;
  throw new Error(`unsupported candidate snapshot mode; expected no arguments or --mode=${PACKAGE_SOURCE_MODE}`);
}

export function snapshotFilesForMode(files, mode = DEFAULT_SNAPSHOT_MODE) {
  if (mode === DEFAULT_SNAPSHOT_MODE) return files;
  if (mode === PACKAGE_SOURCE_MODE) {
    const excluded = new Set(PACKAGE_SOURCE_EXCLUDED_PATHS);
    return files.filter((file) => !excluded.has(file.path));
  }
  throw new Error(`unsupported candidate snapshot mode: ${mode}`);
}

export function digestSnapshot({ mode = DEFAULT_SNAPSHOT_MODE, head, files, dependencyArtifacts }) {
  const payload = JSON.stringify({
    head,
    files: snapshotFilesForMode(files, mode),
    dependencyArtifacts,
  });
  const hash = createHash("sha256");
  if (mode === PACKAGE_SOURCE_MODE) hash.update(PACKAGE_SOURCE_DIGEST_DOMAIN);
  else if (mode !== DEFAULT_SNAPSHOT_MODE) throw new Error(`unsupported candidate snapshot mode: ${mode}`);
  return hash.update(payload).digest("hex");
}

export function collectCandidateSnapshot(mode = DEFAULT_SNAPSHOT_MODE) {
  const raw = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...scope],
    { encoding: "utf8" },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const entries = raw
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const allFiles = entries.map((entry) => {
    const stats = lstatSync(entry.path);
    const gitlink = stats.isDirectory() && isGitlink(entry.path);
    const body = gitlink
      ? Buffer.from(execFileSync("git", ["-C", entry.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
      : readFileSync(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      mode: gitlink ? "160000" : (stats.mode & 0o777).toString(8).padStart(3, "0"),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  });
  const bundleBytes = readFileSync(PASEO_DEPENDENCY.bundlePath);
  const dependencyArtifacts = {
    paseo: {
      expectedCommit: PASEO_DEPENDENCY.expectedCommit,
      gitlinkCommit: execFileSync("git", ["-C", "vendor/paseo", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      bundle: {
        path: PASEO_DEPENDENCY.bundlePath,
        size: bundleBytes.byteLength,
        sha256: createHash("sha256").update(bundleBytes).digest("hex"),
      },
    },
  };
  if (
    dependencyArtifacts.paseo.gitlinkCommit !== PASEO_DEPENDENCY.expectedCommit ||
    dependencyArtifacts.paseo.bundle.size !== PASEO_DEPENDENCY.bundleSize ||
    dependencyArtifacts.paseo.bundle.sha256 !== PASEO_DEPENDENCY.bundleSha256
  ) {
    throw new Error("Paseo gitlink or content-addressed bundle does not match the expected M6 dependency commit");
  }
  const files = snapshotFilesForMode(allFiles, mode);
  const publishedEvidenceRoot = "test/evidence";
  const publishedEvidenceFiles = allFiles
    .filter((file) => file.path.startsWith(`${publishedEvidenceRoot}/`))
    .map(({ path, sha256 }) => ({ path, sha256 }));
  const result = {
    algorithm: "sha256",
    head,
    digest: digestSnapshot({ mode, head, files: allFiles, dependencyArtifacts }),
    publishedEvidence: {
      root: publishedEvidenceRoot,
      files: publishedEvidenceFiles,
      boundByDigest: mode === DEFAULT_SNAPSHOT_MODE,
    },
    dependencyArtifacts,
    files,
  };
  if (mode === PACKAGE_SOURCE_MODE) {
    return {
      ...result,
      mode,
      excludedPaths: [...PACKAGE_SOURCE_EXCLUDED_PATHS],
    };
  }
  return result;
}

function isGitlink(candidate) {
  return execFileSync("git", ["ls-files", "--stage", "--", candidate], { encoding: "utf8" })
    .startsWith("160000 ");
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  const mode = parseSnapshotMode(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(collectCandidateSnapshot(mode), null, 2)}\n`);
}
