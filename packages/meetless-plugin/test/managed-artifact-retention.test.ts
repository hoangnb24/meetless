import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ManagedTimelineArtifactStore } from "../src/managed-transcription.js";
import { MANAGED_TEMPORARY_DATA_TTL_MS } from "@meetless/managed-transcription-foundation";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-retention-")); roots.push(root);
  const bytes = Buffer.from("retained canonical WAV identity");
  const source = path.join(root, "source.wav"); await writeFile(source, bytes);
  const directory = path.join(root, "managed-artifacts");
  const owner = new ManagedTimelineArtifactStore(directory, { now: () => 1000 });
  await owner.accept({ recordingId: "recording", path: source, manifestSha256: "a".repeat(64),
    identity: { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    startMs: 0, endMs: 1000, cleanup: async () => undefined,
  }, { meetingId: "meeting" });
  const owned = owner.artifactDirectory("recording");
  const receipt = path.join(owned, "metadata.json");
  const wav = path.join(owned, "timeline.wav");
  const metadata = JSON.parse(await readFile(receipt, "utf8"));
  await rm(source);
  return { root, bytes, directory, owner, owned, receipt, wav, metadata };
}
const retained = { recordings: [{ id: "recording", meetingId: "meeting" }], meetingIds: ["meeting"] };

describe("retained canonical artifact ownership", () => {
  test("migrates an expired V2 receipt only with verified retained owner and preserves WAV bytes across restart", async () => {
    const f = await fixture();
    const legacy = { ...f.metadata, version: 2, expiresAt: 1000 + MANAGED_TEMPORARY_DATA_TTL_MS };
    await writeFile(f.receipt, JSON.stringify(legacy));
    const restarted = new ManagedTimelineArtifactStore(f.directory, { now: () => legacy.expiresAt + 1 });
    const borrowed = await restarted.get("recording");
    expect(borrowed).not.toBeNull();
    await borrowed!.cleanup();
    expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(legacy);
    expect(await restarted.sweep(retained)).toBe(0);
    expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(f.metadata);
    expect(await readFile(f.wav)).toEqual(f.bytes);
    await (await restarted.get("recording", "meeting"))!.cleanup();
    expect(await readFile(f.wav)).toEqual(f.bytes);
  });

  test.each(["missing", "corrupt", "wrong-recording", "wrong-meeting", "wrong-bytes"])("preserves %s receipt/data while failing closed without rewriting", async (damage) => {
    const f = await fixture();
    const legacy = { ...f.metadata, version: 2, expiresAt: 1000 + MANAGED_TEMPORARY_DATA_TTL_MS };
    await writeFile(f.receipt, JSON.stringify(legacy));
    if (damage === "missing") await rm(f.receipt);
    if (damage === "corrupt") await writeFile(f.receipt, "{broken");
    if (damage === "wrong-recording") await writeFile(f.receipt, JSON.stringify({ ...legacy, recordingId: "foreign" }));
    if (damage === "wrong-meeting") await writeFile(f.receipt, JSON.stringify({ ...legacy, meetingId: "foreign" }));
    if (damage === "wrong-bytes") await writeFile(f.wav, "changed bytes");
    await mkdir(path.join(f.owned, "staging"));
    await writeFile(path.join(f.owned, "staging", "recoverable"), "stage");
    const before = await readFile(f.receipt, "utf8").catch(() => null);
    if (damage === "missing") await expect(f.owner.get("recording", "meeting")).resolves.toBeNull();
    else await expect(f.owner.get("recording", "meeting")).rejects.toThrow();
    expect(await f.owner.sweep(retained)).toBe(0);
    expect(await readFile(f.receipt, "utf8").catch(() => null)).toEqual(before);
    expect(await readFile(path.join(f.owned, "staging", "recoverable"), "utf8")).toBe("stage");
    expect(await f.owner.ownedArtifactPaths("meeting", ["recording"])).toEqual([{ recordingId: "recording", path: f.owned }]);
  });

  test.each(["directory", "metadata", "wav"])("refuses migration through a %s symlink and preserves the foreign target", async (kind) => {
    const f = await fixture();
    const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
    const legacy = JSON.stringify({ ...f.metadata, version: 2, expiresAt: 1000 + MANAGED_TEMPORARY_DATA_TTL_MS });
    await writeFile(path.join(foreign, "metadata.json"), legacy);
    await writeFile(path.join(foreign, "timeline.wav"), f.bytes);
    await writeFile(f.receipt, legacy);
    const destination = kind === "directory" ? f.owned : kind === "metadata" ? f.receipt : f.wav;
    const target = kind === "directory" ? foreign : path.join(foreign, kind === "metadata" ? "metadata.json" : "timeline.wav");
    await rm(destination, { recursive: true }); await symlink(target, destination);
    await expect(f.owner.get("recording", "meeting")).rejects.toThrow("symlink");
    expect(await f.owner.sweep(retained)).toBe(0);
    expect(await readFile(path.join(foreign, "metadata.json"), "utf8")).toBe(legacy);
    expect(await readFile(path.join(foreign, "timeline.wav"))).toEqual(f.bytes);
  });
});
