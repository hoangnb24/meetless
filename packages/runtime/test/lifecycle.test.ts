import { describe, expect, test } from "vitest";
import {
  assertStopAuthorization,
  listenerAddressMatchesExpected,
  type LiveProcessIdentity,
  type PidLockIdentity,
} from "../src/lifecycle.js";

const expectedListen = "127.0.0.1:6777";
const expectedPaseoHome = "/tmp/meetless-owned/paseo-home";
const expectedSupervisorEntrypoint =
  "/repo/vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js";

const lock: PidLockIdentity = {
  pid: 4242,
  startedAt: "2026-08-16T12:00:00.700Z",
  hostname: "meetless.local",
  uid: 501,
  listen: expectedListen,
  desktopManaged: true,
};

const live: LiveProcessIdentity = {
  running: true,
  startedAt: "2026-08-16T12:00:00.000Z",
  hostname: "meetless.local",
  uid: 501,
  commandLine: "Paseo Supervisor",
  paseoHomeMatches: true,
  supervisorEntrypointMatches: true,
  desktopManagedMarkerMatches: true,
  listener: { pid: 4243, address: expectedListen, belongsToSupervisor: true },
};

function authorize(overrides: {
  lock?: Partial<PidLockIdentity>;
  live?: Partial<LiveProcessIdentity>;
  expectedListen?: string;
} = {}): void {
  assertStopAuthorization({
    lock: { ...lock, ...overrides.lock },
    expectedListen: overrides.expectedListen ?? expectedListen,
    expectedPaseoHome,
    expectedSupervisorEntrypoint,
    live: { ...live, ...overrides.live },
  });
}

describe("isolated daemon stop authorization", () => {
  test("canonicalizes only lsof's wildcard display for the configured port", () => {
    expect(listenerAddressMatchesExpected("*:6777", "0.0.0.0:6777")).toBe(true);
    expect(listenerAddressMatchesExpected("*:6888", "0.0.0.0:6777")).toBe(false);
    expect(listenerAddressMatchesExpected("*:6777", "127.0.0.1:6777")).toBe(false);
  });

  test("accepts the exact isolated supervisor environment and owned listener tree", () => {
    expect(() => authorize()).not.toThrow();
  });

  test.each([
    ["the observed packaged bootstrap delay", "2026-08-16T12:00:03.259Z"],
    ["the exact bounded acquisition delay", "2026-08-16T12:00:05.000Z"],
  ])("accepts %s", (_label, startedAt) => {
    expect(() => authorize({ lock: { startedAt } })).not.toThrow();
  });

  test.each([
    ["a lock timestamp before process birth", "2026-08-16T11:59:59.999Z"],
    ["an acquisition beyond the bounded startup interval", "2026-08-16T12:00:05.001Z"],
    ["an invalid lock timestamp", "not-a-timestamp"],
  ])("rejects %s", (_label, startedAt) => {
    expect(() => authorize({ lock: { startedAt } })).toThrow(
      /lock start.*does not follow live process start.*within 5000ms.*stale or reused/s,
    );
  });

  test("rejects a stale lock whose PID was reused by a later process", () => {
    expect(() => authorize({ live: { startedAt: "2026-08-16T13:00:00.000Z" } })).toThrow(
      /lock start.*does not follow live process start.*stale or reused/s,
    );
  });

  test("rejects a matching lock when the live PASEO_HOME differs", () => {
    expect(() => authorize({ live: { paseoHomeMatches: false } })).toThrow(
      /PASEO_HOME does not match the expected isolated home/,
    );
  });

  test("rejects an endpoint with no actual listening child", () => {
    expect(() => authorize({ live: { listener: null } })).toThrow(
      /no live daemon worker listens on isolated endpoint/,
    );
  });

  test("rejects a listener owned by an unrelated process tree", () => {
    expect(() =>
      authorize({
        live: {
          listener: { pid: 9001, address: expectedListen, belongsToSupervisor: false },
        },
      }),
    ).toThrow(/listener PID 9001 does not belong to the locked supervisor process tree/);
  });

  test.each([
    ["hostname", { hostname: "other.local" }, {}, /hostname/],
    ["uid", { uid: 999 }, {}, /live process uid/],
    ["exact command", { commandLine: "node supervisor-entrypoint.js" }, {}, /not exactly/],
    ["entrypoint marker", { supervisorEntrypointMatches: false }, {}, /exact pinned entrypoint/],
    ["desktop marker", { desktopManagedMarkerMatches: false }, {}, /ownership marker/],
    ["desktop lock ownership", {}, { desktopManaged: false }, /not marked desktopManaged/],
  ] as const)("rejects mismatched %s identity", (_label, livePatch, lockPatch, expected) => {
    expect(() => authorize({ lock: lockPatch, live: livePatch })).toThrow(expected);
  });

  test("rejects a configured endpoint mismatch before signaling", () => {
    expect(() => authorize({ expectedListen: "127.0.0.1:6888" })).toThrow(
      /lock endpoint.*does not match isolated endpoint/,
    );
  });

  test("accepts Paseo's desktop-managed null lock endpoint when live ownership proves the endpoint", () => {
    expect(() => authorize({ lock: { listen: null } })).not.toThrow();
  });
});
