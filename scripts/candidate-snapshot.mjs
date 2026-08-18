import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

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
  const body = readFileSync(entry.path);
  return {
    path: entry.path,
    status: entry.status,
    mode: (stats.mode & 0o777).toString(8).padStart(3, "0"),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
});
const digest = createHash("sha256").update(JSON.stringify({ head, files })).digest("hex");
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
      files,
    },
    null,
    2,
  )}\n`,
);
