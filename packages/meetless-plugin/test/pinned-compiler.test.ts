import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compilePlugin } from "../../../vendor/paseo/packages/server/dist/server/server/plugins/compiler.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("the pinned production compiler accepts the repository plugin entry", async () => {
  const result = await compilePlugin(path.join(repositoryRoot, "packages/meetless-plugin/index.tsx"));

  expect(result.clientBundle.length).toBeGreaterThan(0);
  expect(result.serverBundle.length).toBeGreaterThan(0);
});

test("the pinned production compiler rejects a two-parameter default entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-pinned-plugin-"));
  const entry = path.join(root, "index.tsx");
  try {
    await writeFile(entry, "export default function invalid(first, second) { return () => {}; }\n", "utf8");

    await expect(compilePlugin(entry)).rejects.toThrow(
      "Plugin default export must receive one named context parameter",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
