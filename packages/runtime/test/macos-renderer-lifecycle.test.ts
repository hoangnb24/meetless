import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("requires trusted renderer origin, Host, and a fresh one-use intent for native permission mutations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-permission-boundary-test-"));
    roots.push(root);
    await writeFile(path.join(root, "index.html"), "<!DOCTYPE html><html><body>permissions</body></html>\n");
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const nativeRequest = vi.fn(async (_socket: string, operation: string, source: string | null) => ({
      microphone: "authorized",
      systemAudio: "authorized",
      operation,
      source,
      settingsOpened: true,
    }));
    const server = await startPackagedRendererForTest(root, origin, controller.signal, {
      nativeSocket: "/fixture/meetless-capture.sock",
      nativeRequest,
    });
    const trustedHeaders = { Origin: origin, "Content-Type": "application/json" };

    const status = await fetch(`${origin}/__meetless/capture-permissions`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(nativeRequest).toHaveBeenCalledTimes(1);

    const missing = await fetch(`${origin}/__meetless/capture-permissions/request`, {
      method: "POST", headers: trustedHeaders, body: "{}",
    });
    expect(missing.status).toBe(409);

    const foreignOriginToken = await issueIntent(origin, { ...trustedHeaders, Origin: "http://foreign.invalid" });
    expect(foreignOriginToken.status).toBe(403);
    const foreignHostStatus = await rawPost(`${origin}/__meetless/capture-permissions/intent`, {
      ...trustedHeaders, Host: "foreign.invalid",
    });
    expect(foreignHostStatus).toBe(403);

    const invalid = await fetch(`${origin}/__meetless/capture-permissions/request`, {
      method: "POST",
      headers: { ...trustedHeaders, "X-Meetless-Permission-Intent": "not-issued" },
      body: "{}",
    });
    expect(invalid.status).toBe(409);
    expect(nativeRequest).toHaveBeenCalledTimes(1);

    const formToken = await trustedIntentToken(origin, trustedHeaders);
    const formPost = await fetch(`${origin}/__meetless/capture-permissions/request`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Meetless-Permission-Intent": formToken,
      },
      body: "source=microphone",
    });
    expect(formPost.status).toBe(403);
    expect(nativeRequest).toHaveBeenCalledTimes(1);

    const validToken = await trustedIntentToken(origin, trustedHeaders);
    const valid = await fetch(`${origin}/__meetless/capture-permissions/request`, {
      method: "POST",
      headers: { ...trustedHeaders, "X-Meetless-Permission-Intent": validToken },
      body: "{}",
    });
    expect(valid.status).toBe(200);
    expect(nativeRequest).toHaveBeenCalledWith(
      "/fixture/meetless-capture.sock", "capturePermissionRequest", null,
    );
    const callsAfterValid = nativeRequest.mock.calls.length;

    const replay = await fetch(`${origin}/__meetless/capture-permissions/request`, {
      method: "POST",
      headers: { ...trustedHeaders, "X-Meetless-Permission-Intent": validToken },
      body: "{}",
    });
    expect(replay.status).toBe(409);

    const wrongOriginToken = await trustedIntentToken(origin, trustedHeaders);
    const wrongOrigin = await fetch(`${origin}/__meetless/capture-permissions/settings?source=microphone`, {
      method: "POST",
      headers: {
        ...trustedHeaders,
        Origin: "http://foreign.invalid",
        "X-Meetless-Permission-Intent": wrongOriginToken,
      },
      body: "{}",
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongHostToken = await trustedIntentToken(origin, trustedHeaders);
    const wrongHostStatus = await rawPost(`${origin}/__meetless/capture-permissions/settings?source=microphone`, {
      ...trustedHeaders, Host: "foreign.invalid", "X-Meetless-Permission-Intent": wrongHostToken,
    });
    expect(wrongHostStatus).toBe(403);
    expect(nativeRequest).toHaveBeenCalledTimes(callsAfterValid);

    const validSettingsToken = await trustedIntentToken(origin, trustedHeaders);
    const validSettings = await fetch(`${origin}/__meetless/capture-permissions/settings?source=systemAudio`, {
      method: "POST",
      headers: { ...trustedHeaders, "X-Meetless-Permission-Intent": validSettingsToken },
      body: "{}",
    });
    expect(validSettings.status).toBe(200);
    expect(nativeRequest).toHaveBeenCalledWith(
      "/fixture/meetless-capture.sock", "capturePermissionSettings", "systemAudio",
    );
    const callsAfterValidMutations = nativeRequest.mock.calls.length;

    const malformedSourceToken = await trustedIntentToken(origin, trustedHeaders);
    const malformedSource = await fetch(`${origin}/__meetless/capture-permissions/settings?source=display`, {
      method: "POST",
      headers: { ...trustedHeaders, "X-Meetless-Permission-Intent": malformedSourceToken },
      body: "{}",
    });
    expect(malformedSource.status).toBe(400);
    expect(nativeRequest).toHaveBeenCalledTimes(callsAfterValidMutations);

    controller.abort();
    await closePackagedRendererForTest(server);
  });
});

async function issueIntent(origin: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/__meetless/capture-permissions/intent`, { method: "POST", headers, body: "{}" });
}

async function trustedIntentToken(origin: string, headers: Record<string, string>): Promise<string> {
  const response = await issueIntent(origin, headers);
  expect(response.status).toBe(200);
  const decoded = await response.json() as { intentToken?: unknown };
  expect(typeof decoded.intentToken).toBe("string");
  return decoded.intentToken as string;
}

async function rawPost(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

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
