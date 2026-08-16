import { defineRpc } from "@paseo/plugin";
import { z } from "zod";

export const MeetingWireSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: z.enum(["draft", "recording", "processing", "ready", "archived"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MeetingWire = z.infer<typeof MeetingWireSchema>;

export const MeetingCreateRpc = defineRpc({
  name: "meeting.create",
  input: z.object({ title: z.string().trim().min(1).max(200) }).strict(),
  output: MeetingWireSchema,
});

export const MeetingListRpc = defineRpc({
  name: "meeting.list",
  input: z.object({}).strict(),
  output: z.object({ meetings: z.array(MeetingWireSchema) }).strict(),
});
