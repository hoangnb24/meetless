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
  archiveMasGateSessionTransaction,
  assertMasGateSessionReady,
  attestMasGateRuntimeRoot,
  beginMasGateSessionTransaction,
  readMasGateSessionStatus,
  recoverMasGateSessionTransaction,
  restoreMasGateSessionTransaction,
} from "../../../scripts/lib/macos-mas-gate-session-transaction.mjs";

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

    expect(transaction.schema).toBe("MAS_GATE_SESSION_TRANSACTION v1");
    expect(transaction.version).toBe(1);
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
  ])("fails closed for an unexpected sibling transaction artifact %s without removing it", async (name) => {
    const fixture = await createFixture({ prior: true });
    const artifact = path.join(fixture.parent, name);
    await mkdir(artifact, { mode: 0o700 });
    await writeFile(path.join(artifact, "opaque-state"), "retain me\n", { mode: 0o600 });
    await expect(begin(fixture)).rejects.toThrow(/unexpected MAS transaction artifact/);
    await expect(readFile(path.join(artifact, "opaque-state"), "utf8")).resolves.toBe("retain me\n");
  });

  it.each([
    "prepared",
    "quarantine-intent",
    "quarantined",
    "fresh-intent",
    "fresh-created",
    "ready",
  ])("recovers after the begin fault point %s", async (faultAt) => {
    const fixture = await createFixture({ prior: true });
    let failedJournalPath: string | null = null;
    await expect(begin(fixture, { faultAt })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    const status = await readMasGateSessionStatus(runtimeOptions(fixture));
    if (status.status === "active") {
      failedJournalPath = status.journalPath;
      const recovered = await recoverMasGateSessionTransaction(failedJournalPath, runtimeOptions(fixture));
      expect(recovered.phase).toBe("restored");
      await expect(recoverMasGateSessionTransaction(failedJournalPath, runtimeOptions(fixture))).resolves.toMatchObject({ phase: "restored" });
      expect(await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true })).toEqual(
        await attestMasGateRuntimeRoot(fixture.runtime, { requireOwnerUid: true }),
      );
    }
    expect(failedJournalPath).not.toBeNull();
  });

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

  it("retains an unjournaled active construction after a mkdir crash and fails closed with recovery guidance", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt: "active-mkdir" })).rejects.toMatchObject({ code: MAS_GATE_CLEANUP_DIAGNOSTIC_CODE });
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).rejects.toThrow(/construction transaction journal is missing/);
    const entries = await readdir(fixture.parent);
    expect(entries.some((name) => name.endsWith(".active-building"))).toBe(true);
    await expect(readFile(path.join(fixture.runtime, "opaque.bin"), "utf8")).resolves.toBe("opaque\n");
  });

  it("rejects an active transaction whose sibling directory mode changed", async () => {
    const fixture = await createFixture({ prior: true });
    await expect(begin(fixture, { faultAt: "prepared" })).rejects.toThrow(/injected MAS gate session/);
    await chmod(path.join(fixture.parent, ".meetless-mas-gate-session.active"), 0o755);
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
    await expect(readMasGateSessionStatus(runtimeOptions(fixture))).rejects.toThrow(/construction transaction journal is missing/);
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
    await mkdir(ambiguousTransaction.freshRetainedPath);
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
    const [packageProof, acceptanceProof, transactionSource, coordinatorSource, cliSource, nativeSource, installerSource, launcherSource, stopperSource, packageJsonSource] = await Promise.all([
      readFile("scripts/prove-macos-package.mjs", "utf8"),
      readFile("scripts/prove-macos-package-acceptance.mjs", "utf8"),
      readFile("scripts/lib/macos-mas-gate-session-transaction.mjs", "utf8"),
      readFile("scripts/macos-mas-development-gate.mjs", "utf8"),
      readFile("scripts/macos-mas-gate-session.mjs", "utf8"),
      readFile("native/macos-host/MeetlessHost.swift", "utf8"),
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
    expect(coordinatorSource).not.toMatch(/\b(?:rm|rmSync|cp|cpSync)\b/u);
    expect(coordinatorSource).not.toMatch(/recursive\s*:\s*true/u);
    expect(coordinatorSource).toContain("macAppStoreInstallationContract");
    expect(coordinatorSource).toContain("acquireMasGateLock");
    expect(coordinatorSource).toContain("restoreInRequiredOrder");
    expect(coordinatorSource).toContain("MEETLESS_RUNTIME_ROOT: context.runtimeRoot");
    expect(coordinatorSource).toContain("+D\", context.runtimeRoot");
    expect(cliSource).toContain("masDevelopmentRuntimeContext");
    expect(cliSource).toContain("restoreMasDevelopmentGate");
    expect(nativeSource).not.toMatch(/removeItem\([^)]*runtimeRoot[^)]*recursive/su);
    expect(nativeSource).not.toMatch(/copyItem\([^)]*runtimeRoot/su);
    for (const source of [installerSource, launcherSource, stopperSource]) {
      expect(source).toContain("MACOS_APP_STORE_RUNTIME_ROOT_RELATIVE_PATH");
      expect(source).toContain("assertDirectRuntimeTarget");
      expect(source).toContain("candidate.startsWith(`${masRoot}${path.sep}`)");
      expect(source).toContain("MEETLESS_RUNTIME_ROOT");
      expect(source).not.toContain("MEETLESS_RUNTIME_ROOT === undefined");
    }
    expect(stopperSource).toContain("MEETLESS_MAS_COORDINATOR_AUTHORITY");
    expect(coordinatorSource).toContain("MEETLESS_MAS_COORDINATOR_AUTHORITY: MAS_GATE_COORDINATOR_SCHEMA");
    expect(cliSource).toContain("required-free-bytes");
  });
});

async function begin(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return beginMasGateSessionTransaction({ ...runtimeOptions(fixture), ...overrides });
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

async function createFixture({ prior }: { prior: boolean }): Promise<Fixture> {
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
  return { base, parent, runtime, identityPath };
}
