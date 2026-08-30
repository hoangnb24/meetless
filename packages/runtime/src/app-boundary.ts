import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_BOUNDARY_AUTHORITY = "docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md";

export interface AppSourceFile {
  path: string;
  source: string;
}

export function assertMeetlessAppBoundary(files: AppSourceFile[], repositoryRoot: string): void {
  const codingAppRoot = path.resolve(repositoryRoot, "vendor/paseo/packages/app");
  for (const file of files) {
    for (const specifier of importSpecifiers(file.source)) {
      const resolved = specifier.startsWith(".")
        ? path.resolve(path.dirname(file.path), specifier)
        : null;
      const importsCodingApp =
        specifier === "@getpaseo/app" ||
        specifier.startsWith("@getpaseo/app/") ||
        specifier.includes("vendor/paseo/packages/app") ||
        (resolved !== null && isSameOrDescendant(resolved, codingAppRoot));
      if (importsCodingApp) {
        throw new Error(
          `${path.relative(repositoryRoot, file.path)} imports forbidden coding-product module ` +
            `"${specifier}". Meetless app code must not import vendor Paseo app/screens ` +
            `(${APP_BOUNDARY_AUTHORITY}). Depend on @meetless/client, @meetless/meeting-* or a ` +
            "pinned neutral @getpaseo/client/protocol adapter instead.",
        );
      }
    }
  }
}

function importSpecifiers(source: string): string[] {
  const results: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectSources(root: string): Promise<AppSourceFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<AppSourceFile[]> => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return collectSources(entryPath);
      if (!/\.[cm]?[jt]sx?$/u.test(entry.name)) return [];
      return [{ path: entryPath, source: await readFile(entryPath, "utf8") }];
    }),
  );
  return nested.flat();
}

async function main(): Promise<void> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(moduleDirectory, "../../..");
  const appRoot = path.join(repositoryRoot, "packages/meetless-app");
  assertMeetlessAppBoundary(await collectSources(appRoot), repositoryRoot);
  process.stdout.write(`Meetless app import boundary satisfies ${APP_BOUNDARY_AUTHORITY}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
