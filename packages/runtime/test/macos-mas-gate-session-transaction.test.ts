import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
  MAS_GATE_SESSION_INDEX_BASENAME,
  MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY,
  MAS_GATE_SESSION_INDEX_SCHEMA,
  MAS_GATE_SESSION_INDEX_VERSION,
  archiveMasGateSessionTransaction,
  assertMasGateSessionReady,
  attestMasGateRuntimeRoot,
  beginMasGateSessionTransaction,
  initializeMasGateSessionIndex,
  readMasGateSessionStatus,
  recoverMasGateSessionTransaction,
  restoreMasGateSessionTransaction,
} from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";
import { acquireMasGateLock } from "../../../scripts/lib/macos-mas-gate-lock.mjs";
import { freezeMasGateArtifactBinding } from "../../../scripts/lib/mas-gate-artifact-binding.mjs";

const execFile = promisify(execFileCallback);
const testRoots: string[] = [];
const identityRelativePath = "host-identity.json";

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MAS runtime-root preservation transaction", () => {
  it("quarantines and restores opaque state with metadata, symlink, and internal hardlink equivalence", async () => {
    const fixture = await createFixture({ prior: true });
    const before = await lstat(fixture.runtime);
    const beforeAttestation = await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true });
    const transaction = await begin(fixture);

    expect(transaction.schema).toBe("MAS_GATE_SESSION_TRANSACTION v2");
    expect(transaction.version).toBe(2);
    expect(transaction.stateScope).toBe("runtime-root-only");
    expect(transaction.ownerToken).toMatch(/^[A-Za-z0-9_-]{40,80}$/u);
    expect(transaction.priorExists).toBe(true);
    expect(transaction.priorRootIdentity).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      uid: before.uid,
      gid: before.gid,
    });
    expect(transaction.priorAggregateAttestation.digest).toBe(beforeAttestation.digest);
    const journal = await readFile(transaction.journalPath, "utf8");
    expect(journal).not.toContain("opaque.bin");
    expect(journal).not.toContain("literal-link");
    expect(journal).not.toContain("hardlink-alias");
    expect(await readdir(fixture.runtime)).toEqual([]);
    expect(await readFile(path.join(transaction.quarantinePath, "opaque.bin"), "utf8")).toBe("opaque\n");

    await mkdir(path.join(fixture.runtime, "fresh-data"));
    await writeFile(path.join(fixture.runtime, "fresh-data", "created.txt"), "fresh-only\n");
    const restored = await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    expect(restored.phase).toBe("restored");
    expect((await lstat(fixture.runtime)).ino).toBe(before.ino);
    expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(beforeAttestation);
    expect(await readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).toBe("opaque\n");
    await expect(readFile(path.join(fixture.runtime, "fresh-data", "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(restored.freshRetainedPath, "fresh-data", "created.txt"), "utf8")).toBe("fresh-only\n");
    expect(await lstat(restored.freshRetainedPath)).toMatchObject({ ino: restored.freshRootIdentity.ino });

    await expect(restoreMasGateSessionTransaction(restored, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "restored" });
    const archived = await archiveMasGateSessionTransaction(restored, runtimeOptions(fixture));
    expect(archived.phase).toBe("archived");
    await expect(archiveMasGateSessionTransaction(archived, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "archived" });
    await expect(lstat(archived.activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(archived.archivePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "archived" });
  });

  it("restores prior absence while retaining the fresh run root and journal", async () => {
    const fixture = await createFixture({ prior: false });
    const transaction = await begin(fixture);
    await writeFile(path.join(fixture.runtime, "run-only.txt"), "run\n");

    const restored = await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    expect(restored.priorExists).toBe(false);
    await expect(lstat(fixture.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(restored.freshRetainedPath, "run-only.txt"), "utf8")).resolves.toBe("run\n");
    await archiveMasGateSessionTransaction(restored, runtimeOptions(fixture));
    await expect(lstat(restored.freshRetainedPath)).resolves.toBeDefined();
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "archived" });
  });

  it("reports a prompt typed uninitialized state when the exact fixed records are absent", async () => {
    const fixture = await createFixture({ prior: false, index: false });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({
      status: "uninitialized",
      state: "absent-safe",
      runtimeRoot: fixture.runtime,
      parentPath: fixture.parent,
      activePath: path.join(fixture.parent, ".meetless-mas-gate-session.active"),
      indexPath: path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME),
      indexIntentPath: path.join(fixture.parent, ".meetless-mas-gate-session.index-intent"),
      stateScope: "runtime-root-only",
    });
    expect(status).not.toHaveProperty("journalPath");
  });

  it("quarantines a stale marker mixed with state instead of treating the marker as subtree ownership", async () => {
    const fixture = await createFixture({ prior: true });
    await writeFile(path.join(fixture.runtime, "package-proof-owner.json"), "stale marker\n");
    const transaction = await begin(fixture);
    expect(await readFile(path.join(transaction.quarantinePath, "package-proof-owner.json"), "utf8")).toBe("stale marker\n");
    expect(await readFile(path.join(transaction.quarantinePath, "opaque.bin"), "utf8")).toBe("opaque\n");
    await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    expect(await readFile(path.join(fixture.runtime, "package-proof-owner.json"), "utf8")).toBe("stale marker\n");
  });

  it.each([
    ".meetless-mas-gate-session.orphan.quarantine",
    ".meetless-mas-gate-session.orphan.fresh-retained",
    ".meetless-mas-gate-session.orphan.unknown",
  ])("leaves an unregistered sibling transaction artifact %s untouched and unowned", async (name) => {
    const fixture = await createFixture({ prior: true });
    const artifact = path.join(fixture.parent, name);
    await mkdir(artifact, { mode: 0o700 });
    await writeFile(path.join(artifact, "opaque-state"), "retain me\n", { mode: 0o600 });
    const before = await readFile(path.join(artifact, "opaque-state"));
    const transaction = await begin(fixture);
    await expect(readFile(path.join(artifact, "opaque-state"))).resolves.toEqual(before);
    await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    await archiveMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    await expect(readFile(path.join(artifact, "opaque-state"))).resolves.toEqual(before);
  });

  it("publishes a bounded fixed session locator and keeps it separate from ownership proof", async () => {
    const fixture = await createFixture({ prior: true });
    const transaction = await begin(fixture);
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(index).toMatchObject({
      schema: MAS_GATE_SESSION_INDEX_SCHEMA,
      version: MAS_GATE_SESSION_INDEX_VERSION,
      runtimeRoot: fixture.runtime,
      parentPath: fixture.parent,
      activePath: transaction.activePath,
      entries: [{ runId: transaction.runId, activePath: transaction.activePath }],
    });
    expect(index.entries[0].constructionPath).toBe(transaction.constructionPath);
    expect(index.entries[0].archivePath).toBe(path.join(fixture.parent, `.meetless-mas-gate-session.${transaction.runId}.archived`));
    const unknown = path.join(fixture.parent, ".meetless-mas-gate-session.unregistered.quarantine");
    await mkdir(unknown, { mode: 0o700 });
    await writeFile(path.join(unknown, "opaque-state"), "unregistered\n", { mode: 0o600 });
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "active" });
    await expect(readFile(path.join(unknown, "opaque-state"), "utf8")).resolves.toBe("unregistered\n");
  });

  it.each([
    "index-intent-journaled",
    "index-published",
    "index-intent-committed",
    "construction-intent-journaled",
    "prepared",
    "quarantine-intent",
    "quarantined",
    "fresh-intent",
    "fresh-created",
    "ready",
  ])("recovers after the begin fault point %s", async (faultAt) => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(["active", "recovery-required"]).toContain(status.status);
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "restored" });
    expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(
      recovered.priorAggregateAttestation,
    );
  });

  it("recovers idempotently after a crash before fixed index-intent publication", async () => {
    const fixture = await createFixture({ prior: true });
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    const before = await readFile(indexPath);
    await expect(begin(fixture, { faultAt: "index-intent" })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    await expect(readFile(indexPath)).resolves.toEqual(before);
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "absent" });
  });

  it.each(["index-intent-journaled", "index-published", "index-intent-committed"])(
    "recovers after a subprocess crash at the fixed index boundary %s",
    async (faultAt) => {
      const fixture = await createFixture({ prior: true });
      const result = await runHardExitBegin(fixture, faultAt);
      expect(result.signal).toBe("SIGKILL");
      const status = await readMasGateSessionStatus(runtimeOptions(fixture));
      expect(status.status).toBe("recovery-required");
      const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("restored");
      await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
      await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "active", phase: "restored" });
    },
  );

  it.each([
    "missing-index",
    "malformed-index",
    "stale-index",
    "path-mismatched-index",
    "overflow-index",
  ])("fails closed for a %s locator without touching the active transaction", async (kind) => {
    const fixture = await createFixture({ prior: true });
    const transaction = await begin(fixture);
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    if (kind === "missing-index") {
      await rm(indexPath, { force: true });
    } else if (kind === "malformed-index") {
      await writeFile(indexPath, "{not-json\n");
    } else {
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      if (kind === "stale-index") index.entries[0].runId = "stale-run";
      if (kind === "path-mismatched-index") index.entries[0].archivePath = path.join(fixture.parent, "other.archived");
      if (kind === "overflow-index") index.entries = Array.from({ length: 257 }, () => index.entries[0]);
      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    }
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).rejects.toThrow(/index|locator|reconciliation|malformed/iu);
    await expect(readFile(transaction.journalPath, "utf8")).resolves.toContain(transaction.runId);
  });

  it("leaves an unregistered legacy active construction untouched and reports only fixed-scope initialization state", async () => {
    const fixture = await createFixture({ prior: false, index: false });
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    await rm(indexPath, { force: true });
    const legacy = path.join(fixture.parent, ".meetless-mas-gate-session.legacy.active-building");
    await mkdir(legacy, { mode: 0o700 });
    await writeFile(path.join(legacy, "opaque-state"), "legacy\n", { mode: 0o600 });
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({
      status: "uninitialized",
      state: "absent-safe",
    });
    await expect(begin(fixture)).rejects.toThrow(/fixed MAS session index is missing/iu);
    await expect(readFile(path.join(legacy, "opaque-state"), "utf8")).resolves.toBe("legacy\n");
  });

  it.each(["index-intent", "active-slot"])(
    "fails closed for a missing index with fixed %s evidence without mutating it",
    async (evidence) => {
      const fixture = await createFixture({ prior: false, index: false });
      const evidencePath = evidence === "index-intent"
        ? path.join(fixture.parent, ".meetless-mas-gate-session.index-intent")
        : path.join(fixture.parent, ".meetless-mas-gate-session.active");
      if (evidence === "index-intent") await writeFile(evidencePath, "fixed evidence\n", { mode: 0o600 });
      else await mkdir(evidencePath, { mode: 0o700 });
      const before = evidence === "index-intent" ? await readFile(evidencePath) : await lstat(evidencePath);
      await expect(readMasGateSessionStatus(runtimeOptions(fixture))).rejects.toThrow(/fixed (?:index-intent|active-slot)|reconciliation/iu);
      if (evidence === "index-intent") await expect(readFile(evidencePath)).resolves.toEqual(before);
      else await expect(lstat(evidencePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    },
  );

  it("requires the fixed index for public begin and every recovery operation", async () => {
    const uninitialized = await createFixture({ prior: false, index: false });
    await expect(begin(uninitialized)).rejects.toThrow(/fixed MAS session index is missing/iu);

    for (const operation of ["recover", "restore", "archive"] as const) {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      const journalBefore = await readFile(transaction.journalPath);
      await rm(path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME), { force: true });
      const invoke = {
        recover: () => recoverMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture)),
        restore: () => restoreMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture)),
        archive: () => archiveMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture)),
      }[operation];
      await expect(invoke()).rejects.toThrow(/fixed MAS session index|fixed .*evidence/iu);
      await expect(readFile(transaction.journalPath)).resolves.toEqual(journalBefore);
    }
  });

  it("initializes one exact empty fixed index under the live lease and permits the first begin", async () => {
    const fixture = await createFixture({ prior: false, index: false });
    const first = await initialize(fixture);
    expect(first.status).toBe("initialized");
    expect(first.index).toMatchObject({
      schema: MAS_GATE_SESSION_INDEX_SCHEMA,
      version: MAS_GATE_SESSION_INDEX_VERSION,
      runtimeRoot: fixture.runtime,
      parentPath: fixture.parent,
      entries: [],
    });
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    const firstBytes = await readFile(indexPath);
    const second = await initialize(fixture);
    expect(second.status).toBe("existing");
    await expect(readFile(indexPath)).resolves.toEqual(firstBytes);

    const transaction = await begin(fixture);
    expect(transaction.schema).toBe("MAS_GATE_SESSION_TRANSACTION v2");
    const restored = await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    await archiveMasGateSessionTransaction(restored, runtimeOptions(fixture));
  });

  it.each(["malformed-index", "index-collision", "fixed-index-intent", "fixed-active-slot"])(
    "fails closed without mutation for initial fixed-index evidence: %s",
    async (kind) => {
      const fixture = await createFixture({ prior: false, index: false });
      const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
      const intentPath = path.join(fixture.parent, ".meetless-mas-gate-session.index-intent");
      const activePath = path.join(fixture.parent, ".meetless-mas-gate-session.active");
      let evidencePath = indexPath;
      if (kind === "malformed-index") {
        await writeFile(indexPath, "{not-json\n", { mode: 0o600 });
      } else if (kind === "index-collision") {
        await mkdir(indexPath, { mode: 0o700 });
        await writeFile(path.join(indexPath, "collision"), "keep index collision\n", { mode: 0o600 });
      } else if (kind === "fixed-index-intent") {
        evidencePath = intentPath;
        await writeFile(intentPath, "keep intent evidence\n", { mode: 0o600 });
      } else {
        evidencePath = activePath;
        await mkdir(activePath, { mode: 0o700 });
      }
      const before = kind === "index-collision"
        ? await readFile(path.join(indexPath, "collision"))
        : kind === "fixed-active-slot"
          ? await lstat(activePath)
          : await readFile(evidencePath);
      await expect(initialize(fixture)).rejects.toThrow(/fixed MAS session index|fixed index-intent|active-slot|collision|malformed|regular file/iu);
      if (kind === "index-collision") await expect(readFile(path.join(indexPath, "collision"))).resolves.toEqual(before);
      else if (kind === "fixed-active-slot") await expect(lstat(activePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      else await expect(readFile(evidencePath)).resolves.toEqual(before);
      await expect(lstat(`${indexPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves an exact index destination when a collision appears after the initial probe", async () => {
    const fixture = await createFixture({ prior: false, index: false });
    const collision = Buffer.from("post-probe collision\n");
    await expect(initialize(fixture, {
      beforeRename: async ({ target }: { target: string }) => {
        await writeFile(target, collision, { mode: 0o600 });
      },
    })).rejects.toThrow(/both source and destination|collision|destination/iu);
    await expect(readFile(path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME))).resolves.toEqual(collision);
  });

  it("never resets a populated indexed session", async () => {
    const fixture = await createFixture({ prior: false, index: false });
    await initialize(fixture);
    const transaction = await begin(fixture);
    const restored = await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
    const archived = await archiveMasGateSessionTransaction(restored, runtimeOptions(fixture));
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    const before = await readFile(indexPath);
    const existing = await initialize(fixture);
    expect(existing.status).toBe("existing");
    expect(existing.index.entries).toHaveLength(1);
    await expect(readFile(indexPath)).resolves.toEqual(before);
    await expect(lstat(archived.archivePath)).resolves.toBeDefined();
  });

  it("rejects a 257th begin before index publication and keeps the 256-entry state usable", async () => {
    const fixture = await createCapacityFixture();
    const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
    const before = await readFile(indexPath);
    await expect(begin(fixture, { runId: "capacity-overflow" })).rejects.toThrow(/capacity 256|exhausted/iu);
    await expect(readFile(indexPath)).resolves.toEqual(before);
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({
      status: "archived",
      archived: expect.arrayContaining([expect.any(Object)]),
    });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status.archived).toHaveLength(256);
    await expect(begin(fixture, { runId: "capacity-overflow-again" })).rejects.toThrow(/capacity 256|exhausted/iu);
    await expect(readFile(indexPath)).resolves.toEqual(before);
  });

  it.each(["index-initialize", "index-initialize-published"])(
    "survives a subprocess crash at the initial index boundary %s without losing the record",
    async (faultAt) => {
      const fixture = await createFixture({ prior: false, index: false });
      const result = await runHardExitInitialize(fixture, faultAt);
      expect(result.signal).toBe("SIGKILL");
      const indexPath = path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME);
      if (faultAt === "index-initialize") {
        await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({
          status: "uninitialized",
          state: "absent-safe",
        });
        await expect(lstat(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "absent" });
        const before = await readFile(indexPath);
        expect(JSON.parse(before.toString("utf8")).entries).toEqual([]);
        const second = await initialize(fixture);
        expect(second.status).toBe("existing");
        await expect(readFile(indexPath)).resolves.toEqual(before);
      }
      if (faultAt === "index-initialize") await initialize(fixture);
      const transaction = await begin(fixture);
      const restored = await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
      await archiveMasGateSessionTransaction(restored, runtimeOptions(fixture));
    },
  );

  it.each([
    "journal-published",
    "active-journal-published",
    "rename-active-publish",
    "fresh-mkdir",
    "fresh-identity-journaled",
    "rename-quarantine",
  ])("recovers after the physical begin boundary %s", async (faultAt) => {
    const fixture = await createFixture({ prior: true });
    const before = await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true });
    await expect(begin(fixture, { faultAt })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(["active", "recovery-required"]).toContain(status.status);
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(before);
  });

  it("recovers a construction directory created before its first directory journal", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt: "active-mkdir" })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({ status: "recovery-required", phase: "construction-intent" });
    expect(status.journalPath).toMatch(/\.active-intent$/u);
    const entries = await readdir(fixture.parent);
    expect(entries.some((name) => name.endsWith(".active-building"))).toBe(true);
    expect(await readdir(status.constructionPath)).toEqual([]);
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("uses the native no-replace move for every root destination", async () => {
    const activePublication = await createFixture({ prior: true });
    let activeCollisionPath = "";
    await expect(begin(activePublication, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "active transaction publish rename") {
          activeCollisionPath = target;
          await createTargetCollision(target, "keep active target\n");
        }
      },
    })).rejects.toThrow(/EEXIST|both source and destination|preserve/);
    expect(activeCollisionPath).not.toBe("");
    await expect(readFile(path.join(activeCollisionPath, "collision"), "utf8")).resolves.toBe("keep active target\n");
    await expect(readFile(path.join(activePublication.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");

    const quarantine = await createFixture({ prior: true });
    let quarantineCollisionPath = "";
    await expect(begin(quarantine, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "runtime quarantine rename") {
          quarantineCollisionPath = target;
          await createTargetCollision(target, "keep quarantine target\n");
        }
      },
    })).rejects.toThrow(/EEXIST|both source and destination|preserve/);
    expect(quarantineCollisionPath).not.toBe("");
    await expect(readFile(path.join(quarantineCollisionPath, "collision"), "utf8")).resolves.toBe("keep quarantine target\n");
    await expect(readFile(path.join(quarantine.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");

    const freshDetach = await createFixture({ prior: true });
    const freshTransaction = await begin(freshDetach);
    await writeFile(path.join(freshDetach.runtime, "fresh.txt"), "fresh\n");
    let freshCollisionPath = "";
    await expect(restoreMasGateSessionTransaction(freshTransaction, runtimeOptions(freshDetach, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "fresh runtime detach rename") {
          freshCollisionPath = target;
          await createTargetCollision(target, "keep fresh target\n");
        }
      },
    }))).rejects.toThrow(/EEXIST|both source and destination|preserve/);
    expect(freshCollisionPath).not.toBe("");
    await expect(readFile(path.join(freshCollisionPath, "collision"), "utf8")).resolves.toBe("keep fresh target\n");
    await expect(readFile(path.join(freshDetach.runtime, "fresh.txt"), "utf8")).resolves.toBe("fresh\n");

    const priorRestore = await createFixture({ prior: true });
    const priorTransaction = await begin(priorRestore);
    let priorCollisionPath = "";
    await expect(restoreMasGateSessionTransaction(priorTransaction, runtimeOptions(priorRestore, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "prior runtime restore rename") {
          priorCollisionPath = target;
          await createTargetCollision(target, "keep canonical target\n");
        }
      },
    }))).rejects.toThrow(/EEXIST|both source and destination|preserve/);
    expect(priorCollisionPath).not.toBe("");
    await expect(readFile(path.join(priorCollisionPath, "collision"), "utf8")).resolves.toBe("keep canonical target\n");
    await expect(readFile(path.join(priorRestore.runtime, "opaque.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(priorTransaction.quarantinePath, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");

    const archive = await createFixture({ prior: true });
    const archiveTransaction = await begin(archive);
    await restoreMasGateSessionTransaction(archiveTransaction, runtimeOptions(archive));
    let archiveCollisionPath = "";
    await expect(archiveMasGateSessionTransaction(archiveTransaction, runtimeOptions(archive, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "completed session archive rename") {
          archiveCollisionPath = target;
          await createTargetCollision(target, "keep archive target\n");
        }
      },
    }))).rejects.toThrow(/EEXIST|both source and destination|preserve/);
    expect(archiveCollisionPath).not.toBe("");
    await expect(readFile(path.join(archiveCollisionPath, "collision"), "utf8")).resolves.toBe("keep archive target\n");
    await expect(readFile(path.join(archive.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each(["file", "directory", "symlink"] as const)("returns kernel EEXIST for a post-check %s collision", async (kind) => {
    const active = await createFixture({ prior: true });
    let activeTarget = "";
    const failure = await begin(active, {
      beforeRename: async ({ label, target }: { label: string; target: string }) => {
        if (label === "active transaction publish rename") {
          activeTarget = target;
          await createTypedTargetCollision(target, kind, "keep active target\n");
        }
      },
    }).then(() => null, (error) => error);
    expect(failure).toMatchObject({
      code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
      cause: { code: "EEXIST" },
    });
    expect(activeTarget).not.toBe("");
    await assertTypedTargetCollision(activeTarget, kind, "keep active target\n");
    await expect(readFile(path.join(active.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each(["symlink", "identity"] as const)(
    "rejects a package-parent %s ancestor swap before the protected syscall and preserves source plus collision",
    async (swap) => {
      const fixture = await createFixture({ prior: false });
      const packageAncestor = path.join(fixture.base, "package-container");
      const packageParent = path.join(packageAncestor, "Applications");
      const replacedAncestor = `${packageAncestor}.replaced`;
      await mkdir(packageParent, { recursive: true, mode: 0o700 });
      const lease = await acquireMasGateLock({ parentPath: fixture.parent, packageParentPath: packageParent });
      try {
        await writeFile(path.join(packageParent, "source.txt"), "source\n", { mode: 0o600 });
        await writeFile(path.join(packageParent, "destination.txt"), "collision\n", { mode: 0o600 });
        await rename(packageAncestor, replacedAncestor);
        if (swap === "symlink") {
          await symlink(replacedAncestor, packageAncestor);
        } else {
          await mkdir(packageParent, { recursive: true, mode: 0o700 });
          await writeFile(path.join(packageParent, "source.txt"), "source\n", { mode: 0o600 });
          await writeFile(path.join(packageParent, "destination.txt"), "collision\n", { mode: 0o600 });
        }

        await expect(lease.renameNoReplace(
          path.join(packageParent, "source.txt"),
          path.join(packageParent, "destination.txt"),
          { pathClass: "package-sibling", authorizedParentPath: packageParent },
        )).rejects.toThrow(/ELOOP|ENOTDIR|EPERM|identity|symlink/);

        const preservedRoot = swap === "symlink" ? path.join(replacedAncestor, "Applications") : packageParent;
        await expect(readFile(path.join(preservedRoot, "source.txt"), "utf8")).resolves.toBe("source\n");
        await expect(readFile(path.join(preservedRoot, "destination.txt"), "utf8")).resolves.toBe("collision\n");
      } finally {
        await lease.release();
        await rm(packageAncestor, { recursive: true, force: true });
        await rename(replacedAncestor, packageAncestor);
      }
    },
  );

  it("rejects an active transaction whose sibling directory mode changed", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt: "prepared" })).rejects.toThrow(/injected MAS gate session/);
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    await chmod(status.constructionPath, 0o755);
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).rejects.toThrow(/secure directory/);
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each(["detach-intent", "fresh-retained", "restore-intent", "restored"] as const)(
    "recovers after the restore fault point %s",
    async (faultAt) => {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      await writeFile(path.join(fixture.runtime, "run-only.txt"), "run\n");
      await expect(restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture, { faultAt }))).rejects.toMatchObject({
        code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
      });
      const recovered = await recoverMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("restored");
      expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(transaction.priorAggregateAttestation);
      await expect(recoverMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "restored" });
    },
  );

  it.each(["archive-intent", "archive-renamed", "archived"] as const)(
    "recovers after the archive fault point %s",
    async (faultAt) => {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
      await expect(archiveMasGateSessionTransaction(transaction, runtimeOptions(fixture, { faultAt }))).rejects.toMatchObject({
        code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
      });
      const status = await readMasGateSessionStatus(runtimeOptions(fixture));
      const journalPath = status.status === "active" ? status.journalPath : status.archived[0].journalPath;
      const archived = await restoreMasGateSessionTransaction(journalPath, runtimeOptions(fixture));
      expect(archived.phase).toBe("archived");
      const recovered = await recoverMasGateSessionTransaction(archived, runtimeOptions(fixture));
      expect(recovered.phase).toBe("archived");
      expect(await readMasGateSessionStatus(runtimeOptions(fixture))).toMatchObject({ status: "archived" });
    },
  );

  it("recovers after a subprocess hard-exit instead of treating the interrupted fresh root as deletable", async () => {
    const fixture = await createFixture({ prior: true });
    const moduleUrl = new URL("../../../scripts/lib/macos-mas-gate-session-transaction.mjs", import.meta.url).href;
    const childInput: Record<string, unknown> = { ...runtimeOptions(fixture) };
    delete childInput.assertNoLiveOwnedRuntime;
    const code = [
      `import { beginMasGateSessionTransaction, restoreMasGateSessionTransaction } from ${JSON.stringify(moduleUrl)};`,
      `const absent = { status: "absent", runtimeRoot: ${JSON.stringify(childInput.runtimeRoot)}, parentPath: ${JSON.stringify(childInput.runtimeRootParent)}, stateScope: "runtime-root-only", processes: [], listeners: [], sockets: [], openHandles: [] };`,
      `const transaction = await beginMasGateSessionTransaction({ ...${JSON.stringify(childInput)}, assertNoLiveOwnedRuntime: async () => absent });`,
      `await restoreMasGateSessionTransaction(transaction, { ...${JSON.stringify({ ...childInput, faultAt: "fresh-retained", faultAction: "hard-exit" })}, assertNoLiveOwnedRuntime: async () => absent });`,
    ].join("\n");
    const result = await execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: path.resolve(".") }).catch((error) => error);
    expect(result.signal).toBe("SIGKILL");
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status.status).toBe("active");
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    expect(await readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).toBe("opaque\n");
    expect(await readdir(recovered.freshRetainedPath)).toEqual([]);
  });

  it.each([
    "journal-published",
    "active-journal-published",
    "rename-active-publish",
    "fresh-mkdir",
    "fresh-identity-journaled",
    "rename-quarantine",
  ])("recovers a subprocess SIGKILL at the physical begin boundary %s", async (faultAt) => {
    const fixture = await createFixture({ prior: true });
    const result = await runHardExitBegin(fixture, faultAt);
    expect(result.signal).toBe("SIGKILL");
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("retains a subprocess SIGKILL between active mkdir and its first journal publication", async () => {
    const fixture = await createFixture({ prior: true });
    const result = await runHardExitBegin(fixture, "active-mkdir");
    expect(result.signal).toBe("SIGKILL");
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({ status: "recovery-required", phase: "construction-intent" });
    expect(status.journalPath).toMatch(/\.active-intent$/u);
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("recovers when the native lock holder dies before the protected syscall", async () => {
    const fixture = await createFixture({ prior: true });
    const lease = await acquireMasGateLock({ parentPath: fixture.parent });
    try {
      await expect(begin(fixture, {
        lockLease: lease,
        beforeRename: async ({ label }: { label: string }) => {
          if (label === "active transaction publish rename") process.kill(lease.holderPid, "SIGKILL");
        },
      })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    } finally {
      await lease.release();
    }
    await expect(lstat(fixture.runtime)).resolves.toBeDefined();
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({ status: "recovery-required", phase: "prepared" });
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("recovers when the native lock holder dies after the syscall before acknowledgement", async () => {
    const fixture = await createFixture({ prior: true });
    const lease = await acquireMasGateLock({ parentPath: fixture.parent });
    try {
      await expect(begin(fixture, {
        lockLease: lease,
        afterRenameSyscall: async ({ label }: { label: string }) => {
          if (label === "runtime quarantine rename") {
            process.kill(lease.holderPid, "SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    } finally {
      await lease.release();
    }
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({ status: "active", phase: "quarantine-intent" });
    const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
    expect(recovered.phase).toBe("restored");
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each(["rename-fresh-retained", "rename-prior-restore"]) (
    "recovers a subprocess SIGKILL at the physical restore boundary %s",
    async (faultAt) => {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      await writeFile(path.join(fixture.runtime, "run-only.txt"), "run\n");
      const result = await runHardExitRestore(fixture, transaction.journalPath, faultAt);
      expect(result.signal).toBe("SIGKILL");
      const status = await readMasGateSessionStatus(runtimeOptions(fixture));
      const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("restored");
      await expect(attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).resolves.toEqual(transaction.priorAggregateAttestation);
    },
  );

  it.each(["rename-archive", "archive-renamed"] as const)(
    "recovers a subprocess SIGKILL at archive boundary %s with the fixed active slot reusable",
    async (faultAt) => {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      await restoreMasGateSessionTransaction(transaction, runtimeOptions(fixture));
      const result = await runHardExitArchive(fixture, transaction.journalPath, faultAt);
      expect(result.signal).toBe("SIGKILL");
      const status = await readMasGateSessionStatus(runtimeOptions(fixture));
      expect(status.status).toBe("recovery-required");
      const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("archived");
      await expect(readMasGateSessionStatus(runtimeOptions(fixture))).resolves.toMatchObject({ status: "archived" });
    },
  );

  it("fails closed for token/path/attestation, live, free-space, aliases, symlink roots, and external hardlinks", async () => {
    const fixture = await createFixture({ prior: true });
    const priorBytes = await readFile(path.join(fixture.runtime, "opaque.bin"));
    await expect(begin(fixture, { requiredFreeBytes: undefined })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    await expect(begin(fixture, { requiredFreeBytes: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    await expect(begin(fixture, { assertNoLiveOwnedRuntime: async () => true })).rejects.toThrow(/live owned runtime/);
    await expect(begin(fixture, { runtimeRoot: `${fixture.parent}/alias/../Meetless`, contractRuntimeRoot: fixture.runtime })).rejects.toThrow(/canonical absolute path/);
    await expect(begin(fixture, { contractRuntimeRoot: path.join(fixture.parent, "other") })).rejects.toThrow(/contract-derived runtime root/);
    const paseoHome = path.join(fixture.runtime, "paseo-home");
    await expect(begin(fixture, {
      runtimeRoot: paseoHome,
      contractRuntimeRoot: paseoHome,
      runtimeRootParent: fixture.runtime,
      identityPath: path.join(paseoHome, identityRelativePath),
    })).rejects.toThrow(/whole runtime root|paseo-home/);
    expect(await readFile(path.join(fixture.runtime, "opaque.bin"))).toEqual(priorBytes);

    const symlinkFixture = await createFixture({ prior: false });
    const target = path.join(symlinkFixture.parent, "real-runtime");
    await mkdir(target);
    await symlink(target, symlinkFixture.runtime);
    await expect(begin(symlinkFixture)).rejects.toThrow(/symlink/);

    const hardlinkFixture = await createFixture({ prior: true });
    await link(path.join(hardlinkFixture.runtime, "opaque.bin"), path.join(hardlinkFixture.parent, "external-hardlink"));
    await expect(begin(hardlinkFixture)).rejects.toThrow(/hard-linked outside/);
    expect(await readFile(path.join(hardlinkFixture.runtime, "opaque.bin"))).toEqual(priorBytes);
  });

  it("checks the live-runtime adapter before early restore preparation", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt: "quarantine-intent" })).rejects.toMatchObject({
      code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
    });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    expect(status).toMatchObject({ status: "active", phase: "quarantine-intent" });
    await expect(restoreMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture, {
      assertNoLiveOwnedRuntime: async () => true,
    }))).rejects.toThrow(/live owned runtime/);
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each([
    undefined,
    false,
    {},
    { status: "absent" },
    { status: "absent", runtimeRoot: "wrong", parentPath: "wrong", stateScope: "runtime-root-only", processes: [], listeners: [], sockets: [], openHandles: [] },
  ])("rejects an ambiguous live-runtime result %j without moving prior bytes", async (observation) => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { assertNoLiveOwnedRuntime: async () => observation })).rejects.toMatchObject({
      code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE,
    });
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("rejects live-runtime inspection errors such as EPERM without moving prior bytes", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, {
      assertNoLiveOwnedRuntime: async () => {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EPERM" });
        throw error;
      },
    })).rejects.toThrow(/live-owned-runtime validation failed.*EPERM/);
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it.each(["EXDEV", "EBUSY", "EPERM", "ENOSPC"] as const)(
    "retains every byte and leaves an actionable journal when quarantine reports %s",
    async (code) => {
      const fixture = await createFixture({ prior: true });
      const before = await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true });
      await expect(begin(fixture, { faultErrorAt: "rename-quarantine", faultErrorCode: code })).rejects.toThrow(new RegExp(code));
      const status = await readMasGateSessionStatus(runtimeOptions(fixture));
      expect(status).toMatchObject({ status: "active", phase: "quarantine-intent" });
      const recovered = await recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("restored");
      expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(before);
      await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
    },
  );

  it("fails closed on journal token, path, inode, device, and owner mismatches", async () => {
    const tokenFixture = await createFixture({ prior: true });
    await expect(begin(tokenFixture, { faultAt: "prepared" })).rejects.toThrow(/injected MAS gate session/);
    const tokenStatus = await readMasGateSessionStatus(runtimeOptions(tokenFixture));
    await expect(recoverMasGateSessionTransaction(tokenStatus.journalPath, runtimeOptions(tokenFixture, { ownerToken: "wrong-owner-token" }))).rejects.toThrow(/owner token mismatch/);
    expect(await readFile(path.join(tokenFixture.runtime, "opaque.bin"))).toEqual(Buffer.from("opaque\n"));

    const pathFixture = await createFixture({ prior: true });
    await expect(begin(pathFixture, { faultAt: "prepared" })).rejects.toThrow(/injected MAS gate session/);
    const pathStatus = await readMasGateSessionStatus(runtimeOptions(pathFixture));
    const originalJournal = JSON.parse(await readFile(pathStatus.journalPath, "utf8"));
    await writeFile(pathStatus.journalPath, `${JSON.stringify({ ...originalJournal, canonicalRuntimeRoot: path.join(pathFixture.parent, "other") }, null, 2)}\n`);
    await expect(recoverMasGateSessionTransaction(pathStatus.journalPath, runtimeOptions(pathFixture))).rejects.toThrow(/contract-derived runtime root/);
    await writeFile(pathStatus.journalPath, `${JSON.stringify(originalJournal, null, 2)}\n`);
    await expect(recoverMasGateSessionTransaction(pathStatus.journalPath, runtimeOptions(pathFixture))).resolves.toMatchObject({ phase: "restored" });

    for (const field of ["ino", "dev", "uid"] as const) {
      const fixture = await createFixture({ prior: true });
      const transaction = await begin(fixture);
      const journal = JSON.parse(await readFile(transaction.journalPath, "utf8"));
      const changed = journal.priorAggregateAttestation.root[field] + 1;
      journal.priorRootIdentity[field] = changed;
      journal.prior.rootIdentity[field] = changed;
      journal.priorAggregateAttestation.root[field] = changed;
      journal.prior.aggregateAttestation.root[field] = changed;
      await writeFile(transaction.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await expect(restoreMasGateSessionTransaction(transaction.journalPath, runtimeOptions(fixture))).rejects.toThrow(
        new RegExp(`${field}|attestation`),
      );
      await expect(lstat(transaction.quarantinePath)).resolves.toBeDefined();
      await expect(readFile(path.join(transaction.quarantinePath, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
    }

    const journalPathFixture = await createFixture({ prior: true });
    const journalPathTransaction = await begin(journalPathFixture);
    await expect(restoreMasGateSessionTransaction({ ...journalPathTransaction, journalPath: path.join(journalPathFixture.parent, "wrong.json") }, runtimeOptions(journalPathFixture))).rejects.toThrow(/transaction journal is missing/);
  });

  it("retains roots when terminal recovery sees both or neither prior roots", async () => {
    const both = await createFixture({ prior: true });
    const bothTransaction = await begin(both);
    await expect(restoreMasGateSessionTransaction(bothTransaction, runtimeOptions(both, { faultAt: "restore-intent" }))).rejects.toThrow(/injected MAS gate session/);
    await mkdir(both.runtime);
    await expect(recoverMasGateSessionTransaction(bothTransaction.journalPath, runtimeOptions(both))).rejects.toThrow(/both restored canonical/);
    await expect(readFile(path.join(bothTransaction.quarantinePath, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");

    const neither = await createFixture({ prior: true });
    const neitherTransaction = await begin(neither);
    await expect(restoreMasGateSessionTransaction(neitherTransaction, runtimeOptions(neither, { faultAt: "restore-intent" }))).rejects.toThrow(/injected MAS gate session/);
    const held = path.join(neither.parent, "held-prior-root");
    await rename(neitherTransaction.quarantinePath, held);
    await expect(recoverMasGateSessionTransaction(neitherTransaction.journalPath, runtimeOptions(neither))).rejects.toThrow(/neither restored canonical/);
    await expect(readFile(path.join(held, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("fails closed for special files, quarantine mutation, root ambiguity, and malformed/non-monotonic journals", async () => {
    const special = await createFixture({ prior: true });
    await execFile("/usr/bin/mkfifo", [path.join(special.runtime, "special.pipe")]);
    await expect(begin(special)).rejects.toThrow(/special file/);

    const mutation = await createFixture({ prior: true });
    const transaction = await begin(mutation);
    await writeFile(path.join(transaction.quarantinePath, "opaque.bin"), "mutated\n");
    await expect(restoreMasGateSessionTransaction(transaction, runtimeOptions(mutation))).rejects.toThrow(/attestation changed/);
    await expect(readFile(path.join(transaction.quarantinePath, "opaque.bin"), "utf8")).resolves.toBe("mutated\n");
    await expect(lstat(mutation.runtime)).rejects.toMatchObject({ code: "ENOENT" });

    const swapped = await createFixture({ prior: true });
    const swappedTransaction = await begin(swapped);
    const heldPrior = path.join(swapped.parent, "held-quarantine");
    await rename(swappedTransaction.quarantinePath, heldPrior);
    await symlink(heldPrior, swappedTransaction.quarantinePath);
    await expect(restoreMasGateSessionTransaction(swappedTransaction, runtimeOptions(swapped))).rejects.toThrow(/symlink/);
    await expect(readFile(path.join(heldPrior, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");

    const ambiguous = await createFixture({ prior: true });
    const ambiguousTransaction = await begin(ambiguous);
    await mkdir(ambiguousTransaction.freshRetainedPath, { mode: 0o700 });
    await expect(restoreMasGateSessionTransaction(ambiguousTransaction, runtimeOptions(ambiguous))).rejects.toThrow(/both fresh canonical/);
    await rm(ambiguousTransaction.freshRetainedPath, { recursive: true, force: true });

    const malformed = await createFixture({ prior: true });
    await expect(begin(malformed, { faultAt: "prepared" })).rejects.toThrow(/injected MAS gate session/);
    const status = await readMasGateSessionStatus(runtimeOptions(malformed));
    const journal = JSON.parse(await readFile(status.journalPath, "utf8"));
    journal.phase = "ready";
    journal.phaseHistory = ["prepared", "ready", "quarantined"];
    await writeFile(status.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await expect(recoverMasGateSessionTransaction(status.journalPath, runtimeOptions(malformed))).rejects.toThrow(/non-monotonic|current phase/);
    await expect(lstat(malformed.runtime)).resolves.toBeDefined();
  });

  it("requires the identity path to be inside the fresh root and absent before composition", async () => {
    const fixture = await createFixture({ prior: true });
    const transaction = await begin(fixture);
    await expect(assertMasGateSessionReady(transaction, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "ready" });
    await writeFile(fixture.identityPath, "unexpected identity\n");
    await expect(assertMasGateSessionReady(transaction, runtimeOptions(fixture))).rejects.toThrow(/identity path is not absent/);
  });

  it("rejects reintroduction of recursive runtime cleanup in both package proof runners", async () => {
    const [packageProof, acceptanceProof, transactionSource, coordinatorSource, cliSource, nativeSource, mutationSource, installerSource, launcherSource, stopperSource, packageJsonSource] = await Promise.all([
      readFile("scripts/prove-macos-package.mjs", "utf8"),
      readFile("scripts/prove-macos-package-acceptance.mjs", "utf8"),
      readFile("scripts/lib/macos-mas-gate-session-transaction.mjs", "utf8"),
      readFile("scripts/macos-mas-development-gate.mjs", "utf8"),
      readFile("scripts/macos-mas-gate-session.mjs", "utf8"),
      readFile("native/macos-host/MeetlessHost.swift", "utf8"),
      readFile("native/macos-host/mas-gate-mutation/main.swift", "utf8"),
      readFile("scripts/install-macos-host.mjs", "utf8"),
      readFile("scripts/launch-macos-host.mjs", "utf8"),
      readFile("scripts/stop-macos-host.mjs", "utf8"),
      readFile("package.json", "utf8"),
    ]);
    const packageScripts = JSON.parse(packageJsonSource).scripts;
    expect(packageScripts["runtime:mas:development"]).toBe("node scripts/macos-mas-development-gate.mjs");
    expect(packageScripts["runtime:host"]).toBe("node scripts/launch-macos-host.mjs");
    expect(packageScripts["runtime:host:stop"]).toBe("node scripts/stop-macos-host.mjs");
    expect(packageScripts["host:install"]).toContain("node scripts/install-macos-host.mjs");
    for (const name of Object.keys(packageScripts)) {
      if (name.startsWith("runtime:mas")) expect(name).toBe("runtime:mas:development");
    }
    for (const source of [packageProof, acceptanceProof]) {
      expect(source).toContain("acceptedMacOSPackagePaths");
      expect(source).toContain("Direct-DMG proof authority only");
      expect(source).not.toContain("macos-mas-gate-session-transaction");
      expect(source).not.toContain("macAppStoreInstallationContract");
    }
    expect(transactionSource).not.toMatch(/\b(?:rm|rmSync|cp|cpSync)\b/u);
    expect(transactionSource).not.toMatch(/recursive\s*:\s*true/u);
    expect(transactionSource).toContain("renameNoReplace");
    expect(transactionSource).toContain("index.entries.length >= MAX_SESSION_INDEX_ENTRIES");
    expect(transactionSource).toContain("initializeMasGateSessionIndex");
    expect(transactionSource).not.toMatch(/readdir\(\s*context\.parentPath/u);
    expect(transactionSource).not.toContain("renameReservation");
    expect(transactionSource).not.toContain("beforeRenameReservation");
    expect(coordinatorSource).not.toMatch(/\b(?:rm|rmSync|cp|cpSync)\b/u);
    expect(coordinatorSource).not.toMatch(/recursive\s*:\s*true/u);
    expect(coordinatorSource).toContain("macAppStoreInstallationContract");
    expect(coordinatorSource).toContain("acquireMasGateLock");
    expect(coordinatorSource).toContain("MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY");
    expect(coordinatorSource).toContain("validatedArtifactBinding");
    expect(coordinatorSource).toContain("restoreInRequiredOrder");
    expect(coordinatorSource).toContain("inspectNativeArgumentVector");
    expect(coordinatorSource).toContain("daemon-worker.js");
    expect(coordinatorSource).toContain("Paseo Supervisor");
    expect(coordinatorSource).toContain("Paseo Daemon");
    expect(coordinatorSource).toContain("validateMasDevelopmentArtifact");
    expect(coordinatorSource).toContain("artifactBinding");
    expect(coordinatorSource).toContain("--manifest=");
    expect(cliSource).toContain("masDevelopmentRuntimeContext");
    expect(cliSource).toContain("restoreMasDevelopmentGate");
    expect(cliSource).not.toContain("initializeMasGateSessionIndex");
    expect(nativeSource).not.toMatch(/removeItem\([^)]*runtimeRoot[^)]*recursive/su);
    expect(nativeSource).not.toMatch(/copyItem\([^)]*runtimeRoot/su);
    expect(nativeSource).not.toContain("contentsOfDirectory");
    expect(nativeSource).toContain("assertStrictMasGateKeys");
    for (const source of [installerSource, launcherSource, stopperSource]) {
      expect(source).toContain("MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH");
      expect(source).toContain("assertDirectRuntimeTarget");
      expect(source).toContain("candidate.startsWith(`${masRoot}${path.sep}`)");
      expect(source).toContain("MEETLESS_RUNTIME_ROOT");
      expect(source).not.toContain("MEETLESS_RUNTIME_ROOT === undefined");
    }
    expect(stopperSource).not.toContain("MEETLESS_MAS_COORDINATOR_AUTHORITY");
    expect(coordinatorSource).not.toContain("MEETLESS_MAS_COORDINATOR_AUTHORITY");
    expect(coordinatorSource).toContain("required-free-bytes");
    expect(cliSource).not.toMatch(/beginMasGateSessionTransaction|\bbegin\b/u);
    expect(mutationSource).toContain("renameatx_np");
    expect(mutationSource).toContain("RENAME_EXCL");
    expect(mutationSource).toContain("RENAME_NOFOLLOW_ANY");
  });
});

async function begin(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return beginMasGateSessionTransaction({ ...runtimeOptions(fixture), ...overrides });
}

function testArtifactBinding() {
  const digest = "f".repeat(64);
  return freezeMasGateArtifactBinding({
    schema: "MAS_GATE_ARTIFACT_BINDING v1",
    version: 1,
    manifestPath: path.resolve("release/macos/app-store-development-manifest.json"),
    bundlePath: path.resolve("release/macos/Meetless.app"),
    manifestSha256: digest,
    bundleFingerprint: digest,
    artifactDigest: digest,
    candidateSnapshotDigest: digest,
    packageInputDigest: digest,
    artifactInputDigest: digest,
    licenseDigest: digest,
    signatureDigest: digest,
    publicSdkKeySha256: digest,
  });
}

async function initialize(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const lease = await acquireMasGateLock({ parentPath: fixture.parent });
  try {
    return await initializeMasGateSessionIndex({
      ...runtimeOptions(fixture, overrides),
      installAuthorization: MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY,
      validatedArtifactBinding: testArtifactBinding(),
      lockLease: lease,
    });
  } finally {
    await lease.release();
  }
}

function runtimeOptions(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    runtimeRoot: fixture.runtime,
    contractRuntimeRoot: fixture.runtime,
    runtimeRootParent: fixture.parent,
    activePath: path.join(fixture.parent, ".meetless-mas-gate-session.active"),
    identityRelativePath,
    identityPath: fixture.identityPath,
    requiredFreeBytes: 1,
    assertNoLiveOwnedRuntime: async () => ({
      status: "absent",
      runtimeRoot: fixture.runtime,
      parentPath: fixture.parent,
      stateScope: "runtime-root-only",
      processes: [],
      listeners: [],
      sockets: [],
      openHandles: [],
    }),
    ...overrides,
  };
}

async function runHardExitBegin(fixture: Fixture, faultAt: string) {
  const input = childRuntimeOptions(fixture);
  return runHardExit([
    `import { beginMasGateSessionTransaction } from ${JSON.stringify(new URL("../../../scripts/lib/macos-mas-gate-session-transaction.mjs", import.meta.url).href)};`,
    `const options = ${JSON.stringify(input)};`,
    `const absent = ${JSON.stringify(absentRuntimeLiteral(input.runtimeRoot as string, input.runtimeRootParent as string))};`,
    `await beginMasGateSessionTransaction({ ...options, faultAt: ${JSON.stringify(faultAt)}, faultAction: "hard-exit", assertNoLiveOwnedRuntime: async () => absent });`,
  ].join("\n"));
}

async function runHardExitInitialize(fixture: Fixture, faultAt: string) {
  const input = childRuntimeOptions(fixture);
  const binding = testArtifactBinding();
  return runHardExit([
    `import { initializeMasGateSessionIndex, MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY } from ${JSON.stringify(new URL("../../../scripts/lib/macos-mas-gate-session-transaction.mjs", import.meta.url).href)};`,
    `import { acquireMasGateLock } from ${JSON.stringify(new URL("../../../scripts/lib/macos-mas-gate-lock.mjs", import.meta.url).href)};`,
    `import { freezeMasGateArtifactBinding } from ${JSON.stringify(new URL("../../../scripts/lib/mas-gate-artifact-binding.mjs", import.meta.url).href)};`,
    `const options = ${JSON.stringify(input)};`,
    `const lease = await acquireMasGateLock({ parentPath: options.runtimeRootParent });`,
    `await initializeMasGateSessionIndex({ ...options, faultAt: ${JSON.stringify(faultAt)}, faultAction: "hard-exit", installAuthorization: MAS_GATE_SESSION_INDEX_INITIALIZATION_AUTHORITY, validatedArtifactBinding: freezeMasGateArtifactBinding(${JSON.stringify(binding)}), lockLease: lease });`,
  ].join("\n"));
}

async function runHardExitRestore(fixture: Fixture, journalPath: string, faultAt: string) {
  const input = childRuntimeOptions(fixture);
  return runHardExit([
    `import { restoreMasGateSessionTransaction } from ${JSON.stringify(new URL("../../../scripts/lib/macos-mas-gate-session-transaction.mjs", import.meta.url).href)};`,
    `const options = ${JSON.stringify(input)};`,
    `const absent = ${JSON.stringify(absentRuntimeLiteral(input.runtimeRoot as string, input.runtimeRootParent as string))};`,
    `await restoreMasGateSessionTransaction(${JSON.stringify(journalPath)}, { ...options, faultAt: ${JSON.stringify(faultAt)}, faultAction: "hard-exit", assertNoLiveOwnedRuntime: async () => absent });`,
  ].join("\n"));
}

async function runHardExitArchive(fixture: Fixture, journalPath: string, faultAt: string) {
  const input = childRuntimeOptions(fixture);
  return runHardExit([
    `import { archiveMasGateSessionTransaction } from ${JSON.stringify(new URL("../../../scripts/lib/macos-mas-gate-session-transaction.mjs", import.meta.url).href)};`,
    `const options = ${JSON.stringify(input)};`,
    `const absent = ${JSON.stringify(absentRuntimeLiteral(input.runtimeRoot as string, input.runtimeRootParent as string))};`,
    `await archiveMasGateSessionTransaction(${JSON.stringify(journalPath)}, { ...options, faultAt: ${JSON.stringify(faultAt)}, faultAction: "hard-exit", assertNoLiveOwnedRuntime: async () => absent });`,
  ].join("\n"));
}

function childRuntimeOptions(fixture: Fixture) {
  const options = runtimeOptions(fixture);
  delete (options as { assertNoLiveOwnedRuntime?: unknown }).assertNoLiveOwnedRuntime;
  return options;
}

function absentRuntimeLiteral(runtimeRoot: string, parentPath: string) {
  return {
    status: "absent",
    runtimeRoot,
    parentPath,
    stateScope: "runtime-root-only",
    processes: [],
    listeners: [],
    sockets: [],
    openHandles: [],
  };
}

async function runHardExit(source: string) {
  return execFile(process.execPath, ["--input-type=module", "-e", source], { cwd: path.resolve(".") }).catch((error) => error);
}

type Fixture = {
  base: string;
  parent: string;
  runtime: string;
  identityPath: string;
};

async function createFixture({ prior, index = true }: { prior: boolean; index?: boolean }): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "meetless-mas-gate-session-test-")));
  testRoots.push(base);
  const parent = path.join(base, "support");
  const runtime = path.join(parent, "Meetless");
  const identityPath = path.join(runtime, identityRelativePath);
  await mkdir(parent, { recursive: true });
  if (prior) {
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "opaque.bin"), "opaque\n", { mode: 0o640 });
    await link(path.join(runtime, "opaque.bin"), path.join(runtime, "hardlink-alias"));
    await symlink("opaque.bin", path.join(runtime, "literal-link"));
    await mkdir(path.join(runtime, "nested"), { mode: 0o750 });
    await writeFile(path.join(runtime, "nested", "metadata.txt"), "metadata\n", { mode: 0o600 });
    await writeFile(identityPath, "prior identity\n", { mode: 0o600 });
    await chmod(runtime, 0o750);
  }
  if (index) {
    await writeFile(
      path.join(parent, MAS_GATE_SESSION_INDEX_BASENAME),
      `${JSON.stringify({
        schema: MAS_GATE_SESSION_INDEX_SCHEMA,
        version: MAS_GATE_SESSION_INDEX_VERSION,
        runtimeRoot: runtime,
        parentPath: parent,
        activePath: path.join(parent, ".meetless-mas-gate-session.active"),
        indexPath: path.join(parent, MAS_GATE_SESSION_INDEX_BASENAME),
        indexIntentPath: path.join(parent, ".meetless-mas-gate-session.index-intent"),
        entries: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return { base, parent, runtime, identityPath };
}

async function createCapacityFixture(): Promise<Fixture> {
  const fixture = await createFixture({ prior: false, index: false });
  const entries = [];
  const phaseHistory = [
    "construction-intent",
    "prepared",
    "quarantine-intent",
    "quarantined",
    "fresh-intent",
    "fresh-created",
    "ready",
    "detach-intent",
    "fresh-retained",
    "restore-intent",
    "restored",
    "archive-intent",
    "archived",
  ];
  for (let index = 0; index < 256; index += 1) {
    const runId = `capacity-${String(index).padStart(3, "0")}`;
    const constructionPath = path.join(fixture.parent, `.meetless-mas-gate-session.${runId}.active-building`);
    const constructionIntentPath = path.join(fixture.parent, `.meetless-mas-gate-session.${runId}.active-intent`);
    const quarantinePath = path.join(fixture.parent, `.meetless-mas-gate-session.${runId}.quarantine`);
    const freshRetainedPath = path.join(fixture.parent, `.meetless-mas-gate-session.${runId}.fresh-retained`);
    const archivePath = path.join(fixture.parent, `.meetless-mas-gate-session.${runId}.archived`);
    await mkdir(freshRetainedPath, { mode: 0o700 });
    await mkdir(archivePath, { mode: 0o700 });
    const retained = await lstat(freshRetainedPath);
    const identity = {
      type: "directory",
      mode: Number(retained.mode),
      uid: Number(retained.uid),
      gid: Number(retained.gid),
      dev: Number(retained.dev),
      ino: Number(retained.ino),
      nlink: Number(retained.nlink),
      size: Number(retained.size),
    };
    const journal = {
      schema: "MAS_GATE_SESSION_TRANSACTION v2",
      version: 2,
      ownerToken: "a".repeat(40),
      runId,
      canonicalRuntimeRoot: fixture.runtime,
      runtimeRoot: fixture.runtime,
      canonicalPath: fixture.runtime,
      parentPath: fixture.parent,
      parent: fixture.parent,
      lockPath: path.join(fixture.parent, ".meetless-mas-gate.lock"),
      activePath: path.join(fixture.parent, ".meetless-mas-gate-session.active"),
      active: path.join(fixture.parent, ".meetless-mas-gate-session.active"),
      constructionPath,
      quarantinePath,
      quarantine: quarantinePath,
      freshRetainedPath,
      freshRetained: freshRetainedPath,
      archivePath,
      constructionIntentPath,
      constructionIntent: constructionIntentPath,
      journalPath: path.join(archivePath, "transaction.json"),
      identityRelativePath,
      identityPath: fixture.identityPath,
      identity: { relativePath: identityRelativePath, path: fixture.identityPath },
      priorExists: false,
      priorRootIdentity: null,
      priorAggregateAttestation: null,
      prior: { exists: false, rootIdentity: null, aggregateAttestation: null },
      freshRootIdentity: identity,
      freshRetainedRootIdentity: identity,
      requiredFreeBytes: "1",
      observedFreeBytes: "1",
      stateScope: "runtime-root-only",
      phase: "archived",
      phaseHistory,
    };
    await writeFile(journal.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    entries.push({
      runId,
      activePath: journal.activePath,
      constructionPath,
      constructionIntentPath,
      quarantinePath,
      freshRetainedPath,
      archivePath,
    });
  }
  await writeFile(
    path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME),
    `${JSON.stringify({
      schema: MAS_GATE_SESSION_INDEX_SCHEMA,
      version: MAS_GATE_SESSION_INDEX_VERSION,
      runtimeRoot: fixture.runtime,
      parentPath: fixture.parent,
      activePath: path.join(fixture.parent, ".meetless-mas-gate-session.active"),
      indexPath: path.join(fixture.parent, MAS_GATE_SESSION_INDEX_BASENAME),
      indexIntentPath: path.join(fixture.parent, ".meetless-mas-gate-session.index-intent"),
      entries,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return fixture;
}

async function createTargetCollision(target: string, contents: string) {
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(target, "collision"), contents, { mode: 0o600 });
}

async function createTypedTargetCollision(target: string, kind: "file" | "directory" | "symlink", contents: string) {
  if (kind === "file") {
    await writeFile(target, contents, { mode: 0o600 });
    return;
  }
  if (kind === "directory") {
    await createTargetCollision(target, contents);
    return;
  }
  const pointedPath = `${target}.pointed-file`;
  await writeFile(pointedPath, contents, { mode: 0o600 });
  await symlink(pointedPath, target);
}

async function assertTypedTargetCollision(target: string, kind: "file" | "directory" | "symlink", contents: string) {
  const info = await lstat(target);
  if (kind === "file") {
    expect(info.isFile()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe(contents);
    return;
  }
  if (kind === "directory") {
    expect(info.isDirectory()).toBe(true);
    await expect(readFile(path.join(target, "collision"), "utf8")).resolves.toBe(contents);
    return;
  }
  expect(info.isSymbolicLink()).toBe(true);
  await expect(readFile(target, "utf8")).resolves.toBe(contents);
}
