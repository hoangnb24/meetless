import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closePackagedRendererForTest, startPackagedRendererForTest } from "../src/desktop.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged renderer listener lifecycle", () => {
  it("registers before listen completes and closes immediately on abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-m7-renderer-test-"));
    roots.push(root);
    await writeFile(path.join(root, "index.html"), "<!DOCTYPE html><html><body>M7</body></html>\n");
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const server = await startPackagedRendererForTest(root, origin, controller.signal);

    const response = await fetch(`${origin}/`);
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("M7");
    controller.abort();
    await waitForClosed(origin);
    await closePackagedRendererForTest(server);
    await expect(fetch(`${origin}/`)).rejects.toThrow();
    await expect(readFile(path.join(root, "index.html"), "utf8")).resolves.toContain("M7");
  });
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener did not expose a port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForClosed(origin: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`renderer listener remained open at ${origin}`);
}
