import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { connectMeetlessClient } from "@meetless/client";

let daemon: ChildProcess | null = null;
let runtimeRoot: string | null = null;

afterEach(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => daemon?.once("exit", () => resolve()));
  }
  daemon = null;
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = null;
});

describe("real Paseo daemon/plugin/client composition", () => {
  test("desktop creates and lists, then a second compact/mobile client reads the same record", async () => {
    const port = await availablePort();
    expect(port).not.toBe(6767);
    const listen = `127.0.0.1:${port}`;
    runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-composition-"));
    const output: string[] = [];
    daemon = spawn(process.execPath, ["packages/runtime/dist/cli.js", "daemon"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEETLESS_RUNTIME_ROOT: runtimeRoot,
        MEETLESS_LISTEN: listen,
        PASEO_NODE_INSPECT: "0",
        PASEO_LOG_CONSOLE_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.on("data", (chunk) => output.push(String(chunk)));
    daemon.stderr?.on("data", (chunk) => output.push(String(chunk)));
    await waitForDaemon(runtimeRoot, daemon, output);

    const url = `ws://${listen}/ws`;
    const desktop = await connectMeetlessClient({
      url,
      clientId: `meetless-desktop-proof-${Date.now()}`,
      clientType: "browser",
    });
    try {
      const created = await desktop.client.createMeeting({ title: "Milestone 1 proof" });
      expect(await desktop.client.listMeetings()).toEqual([created]);

      const mobile = await connectMeetlessClient({
        url,
        clientId: `meetless-mobile-proof-${Date.now()}`,
        clientType: "mobile",
      });
      try {
        expect(await mobile.client.listMeetings()).toEqual([created]);
        expect(mobile.serverInfo?.serverId).toBe(desktop.serverInfo?.serverId);
        console.info(
          `[composition] endpoint=${url} serverId=${desktop.serverInfo?.serverId} meetingId=${created.id}`,
        );
      } finally {
        await mobile.close();
      }
    } finally {
      await desktop.close();
    }

    const persisted = JSON.parse(
      await readFile(path.join(runtimeRoot, "meeting-store", "meetings.json"), "utf8"),
    );
    expect(persisted.meetings).toMatchObject([{ title: "Milestone 1 proof", status: "draft" }]);
  });
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForDaemon(root: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  const pidPath = path.join(root, "paseo-home", "paseo.pid");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated daemon exited ${child.exitCode}:\n${output.join("")}`);
    }
    try {
      const lock = JSON.parse(await readFile(pidPath, "utf8"));
      if (typeof lock.listen === "string" && lock.listen.includes(":")) return;
    } catch {
      // The pinned supervisor writes the lock before the worker reports readiness.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated daemon:\n${output.join("")}`);
}
