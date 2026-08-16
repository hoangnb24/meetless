export const MEETING_STATUSES = [
  "draft",
  "recording",
  "processing",
  "ready",
  "archived",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMeetingInput {
  id: string;
  title: string;
  now: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<MeetingStatus, readonly MeetingStatus[]>> = {
  draft: ["recording"],
  recording: ["processing"],
  processing: ["ready"],
  ready: ["archived"],
  archived: [],
};

export class InvalidMeetingTransitionError extends Error {
  constructor(from: MeetingStatus, to: MeetingStatus) {
    super(`Meeting cannot transition from ${from} to ${to}`);
    this.name = "InvalidMeetingTransitionError";
  }
}

function requireText(value: string, field: "id" | "title" | "now"): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Meeting ${field} must not be empty`);
  return normalized;
}

export function createMeeting(input: CreateMeetingInput): Meeting {
  const now = requireText(input.now, "now");
  return {
    id: requireText(input.id, "id"),
    title: requireText(input.title, "title"),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionMeeting(
  meeting: Meeting,
  nextStatus: MeetingStatus,
  now: string,
): Meeting {
  if (!ALLOWED_TRANSITIONS[meeting.status].includes(nextStatus)) {
    throw new InvalidMeetingTransitionError(meeting.status, nextStatus);
  }
  return { ...meeting, status: nextStatus, updatedAt: requireText(now, "now") };
}
