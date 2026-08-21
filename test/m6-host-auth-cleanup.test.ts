import { describe, expect, test, vi } from "vitest";
// @ts-expect-error The preflight helper is an executable Node module outside the TypeScript build.
import { assertCleanState, runFailClosedCleanup } from "../scripts/lib/m6-host-auth-cleanup.mjs";

const clean = {
  hostProcessIds: [],
  listenerProcessIds: [],
  ownedSocketPaths: [],
  runtimeRootExists: false,
  launchPasswordKeys: [],
};

describe("M6 host-auth preflight cleanup", () => {
  test("publishes a clean result only after every cleanup step and the clean-state gate", async () => {
    const order: string[] = [];
    await runFailClosedCleanup([
      ["stop", async () => { order.push("stop"); }],
      ["unset password", async () => { order.push("unset"); }],
    ], async () => { order.push("verify"); return clean; });
    expect(order).toEqual(["stop", "unset", "verify"]);
  });

  test("aggregates forced stop and launch-environment failures and still verifies clean state", async () => {
    const verify = vi.fn(async () => clean);
    await expect(runFailClosedCleanup([
      ["stop temporary host", async () => { throw new Error("forced stop failure"); }],
      ["unset MEETLESS_DIRECT_PASSWORD", async () => { throw new Error("forced unset failure"); }],
    ], verify)).rejects.toSatisfy((error: AggregateError) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors.map((entry) => entry.message)).toEqual([
        "stop temporary host failed: forced stop failure",
        "unset MEETLESS_DIRECT_PASSWORD failed: forced unset failure",
      ]);
      return true;
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  test("rejects each dirty owned resource before pass", () => {
    expect(() => assertCleanState({ ...clean, hostProcessIds: [101] })).toThrow(/owned host processes remain: 101/);
    expect(() => assertCleanState({ ...clean, listenerProcessIds: [202] })).toThrow(/owned listener remains: 202/);
    expect(() => assertCleanState({ ...clean, ownedSocketPaths: ["recording.sock", "transcription.sock"] }))
      .toThrow(/owned sockets remain: recording\.sock,transcription\.sock/);
    expect(() => assertCleanState({ ...clean, runtimeRootExists: true })).toThrow(/runtime root remains/);
    expect(() => assertCleanState({ ...clean, launchPasswordKeys: ["PASEO_PASSWORD"] })).toThrow(/password keys remain/);
  });
});
