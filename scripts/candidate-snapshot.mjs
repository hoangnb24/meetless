import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { PASEO_DEPENDENCY } from "./lib/paseo-dependency.mjs";

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
const files = entries.map((entry) => {
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

function isGitlink(candidate) {
  return execFileSync("git", ["ls-files", "--stage", "--", candidate], { encoding: "utf8" })
    .startsWith("160000 ");
}
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
const digest = createHash("sha256").update(JSON.stringify({ head, files, dependencyArtifacts })).digest("hex");
const publishedEvidenceRoot = "test/evidence";
const publishedEvidenceFiles = files
  .filter((file) => file.path.startsWith(`${publishedEvidenceRoot}/`))
  .map(({ path, sha256 }) => ({ path, sha256 }));
process.stdout.write(
  `${JSON.stringify(
    {
      algorithm: "sha256",
      head,
      digest,
      publishedEvidence: {
        root: publishedEvidenceRoot,
        files: publishedEvidenceFiles,
        boundByDigest: true,
      },
      dependencyArtifacts,
      files,
    },
    null,
    2,
  )}\n`,
);
