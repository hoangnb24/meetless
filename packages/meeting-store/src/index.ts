import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  createMeeting,
  MEETING_STATUSES,
  transitionMeeting,
  type Meeting,
  type MeetingStatus,
} from "@meetless/meeting-domain";
import { z } from "zod";

const MeetingSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: z.enum(MEETING_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const MeetingStateSchema = z
  .object({
    version: z.literal(1),
    meetings: z.array(MeetingSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    state.meetings.forEach((meeting, index) => {
      if (ids.has(meeting.id)) {
        context.addIssue({
          code: "custom",
          path: ["meetings", index, "id"],
          message: `Duplicate meeting id: ${meeting.id}`,
        });
      }
      ids.add(meeting.id);
    });
  });

interface MeetingState {
  version: 1;
  meetings: Meeting[];
}

export class MeetingStoreCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Meeting state is corrupt at ${filePath}; repair or restore it before retrying`, { cause });
    this.name = "MeetingStoreCorruptError";
  }
}

export class DuplicateMeetingError extends Error {
  constructor(id: string) {
    super(`Meeting already exists: ${id}`);
    this.name = "DuplicateMeetingError";
  }
}

export interface MeetingStoreOptions {
  root: string;
  now?: () => string;
  createId?: () => string;
}

export class MeetingStore {
  readonly filePath: string;
  private readonly root: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: MeetingStoreOptions) {
    this.root = path.resolve(options.root);
    this.filePath = path.join(this.root, "meetings.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
  }

  async list(): Promise<Meeting[]> {
    await this.mutationTail;
    const state = await this.readState();
    return state.meetings.map((meeting) => ({ ...meeting }));
  }

  create(input: { title: string; id?: string }): Promise<Meeting> {
    return this.mutate(async (state) => {
      const meeting = createMeeting({
        id: input.id ?? this.createId(),
        title: input.title,
        now: this.now(),
      });
      if (state.meetings.some((candidate) => candidate.id === meeting.id)) {
        throw new DuplicateMeetingError(meeting.id);
      }
      state.meetings.push(meeting);
      return meeting;
    });
  }

  transition(id: string, status: MeetingStatus): Promise<Meeting> {
    return this.mutate(async (state) => {
      const index = state.meetings.findIndex((meeting) => meeting.id === id);
      if (index < 0) throw new Error(`Meeting not found: ${id}`);
      const current = state.meetings[index];
      if (!current) throw new Error(`Meeting not found: ${id}`);
      const next = transitionMeeting(current, status, this.now());
      state.meetings[index] = next;
      return next;
    });
  }

  private mutate<T>(change: (state: MeetingState) => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const state = await this.readState();
      const result = await change(state);
      await this.writeState(state);
      return result;
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async readState(): Promise<MeetingState> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { version: 1, meetings: [] };
      throw error;
    }
    try {
      return MeetingStateSchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new MeetingStoreCorruptError(this.filePath, error);
    }
  }

  private async writeState(state: MeetingState): Promise<void> {
    const checked = MeetingStateSchema.parse(state);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.root, `.meetings.${process.pid}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      temporaryCreated = false;
      await syncDirectory(this.root);
    } finally {
      if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
