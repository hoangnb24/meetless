import { describe, expect, test } from "vitest";
import { summarizePostM3Cleanup } from "../src/post-m3-cleanup.js";

describe("post-M3 cleanup result", () => {
  test("accepts an untouched original workspace when staging never began", () => {
    expect(summarizePostM3Cleanup({
      root: "/tmp/meetless-runtime",
      preservedPath: null,
      originalRootExisted: true,
      staged: false,
      stagedRootRemoved: true,
      originalRootRestored: true,
      runStateRemoved: true,
      liveHostPids: [],
      errors: [],
    })).toMatchObject({ status: "passed", errors: [] });
  });

  test("accepts a fully restored owned workspace", () => {
    expect(summarizePostM3Cleanup({
      root: "/tmp/meetless-runtime",
      preservedPath: "/tmp/meetless-runtime.post-m3-preserved-run",
      originalRootExisted: true,
      staged: true,
      stagedRootRemoved: true,
      originalRootRestored: true,
      runStateRemoved: true,
      liveHostPids: [],
      errors: [],
    })).toMatchObject({ status: "passed", errors: [] });
  });

  test("reports restoration failure without mutating real state", () => {
    const result = summarizePostM3Cleanup({
      root: "/tmp/meetless-runtime",
      preservedPath: "/tmp/meetless-runtime.post-m3-preserved-run",
      originalRootExisted: true,
      staged: true,
      stagedRootRemoved: false,
      originalRootRestored: false,
      runStateRemoved: false,
      liveHostPids: [1234],
      errors: ["injected restore failure"],
    });
    expect(result.status).toBe("failed");
    expect(result.diagnostic).toMatch(/injected restore failure/);
    expect(result.diagnostic).toMatch(/preserved diagnostic path/);
  });
});
