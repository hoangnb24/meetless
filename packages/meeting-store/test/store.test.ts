import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InvalidMeetingTransitionError } from "@meetless/meeting-domain";
import { MeetingStore, MeetingStoreCorruptError } from "../src/index.js";

const roots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-store-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("meeting store", () => {
  test("persists a create and rejects an invalid transition without changing disk", async () => {
    const root = await temporaryRoot();
    let tick = 0;
    const store = new MeetingStore({
      root,
      now: () => `2026-08-16T10:00:0${tick++}.000Z`,
      createId: () => "m-1",
    });
    await store.create({ title: "Design sync" });
    const before = await readFile(store.filePath, "utf8");

    await expect(store.transition("m-1", "ready")).rejects.toBeInstanceOf(
      InvalidMeetingTransitionError,
    );

    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect(await store.list()).toMatchObject([{ id: "m-1", status: "draft" }]);
  });

  test("serializes concurrent atomic creates without losing records", async () => {
    const root = await temporaryRoot();
    let id = 0;
    const store = new MeetingStore({
      root,
      now: () => "2026-08-16T10:00:00.000Z",
      createId: () => `m-${++id}`,
    });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.create({ title: `Meeting ${index}` })),
    );

    const meetings = await store.list();
    expect(meetings).toHaveLength(40);
    expect(new Set(meetings.map((meeting) => meeting.id))).toHaveLength(40);
    expect((await readdir(root)).sort()).toEqual(["meetings.json"]);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({ version: 1 });
  });

  test("fails closed and preserves corrupt state", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "meetings.json");
    await writeFile(filePath, "{ corrupt state\n", "utf8");
    const store = new MeetingStore({ root });

    await expect(store.create({ title: "Must not overwrite" })).rejects.toBeInstanceOf(
      MeetingStoreCorruptError,
    );
    expect(await readFile(filePath, "utf8")).toBe("{ corrupt state\n");
  });
});
