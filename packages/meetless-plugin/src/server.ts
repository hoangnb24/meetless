import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";

let store: MeetingStore | null = null;

export function getMeetingStore(): MeetingStore {
  if (store) return store;
  const configuredRoot = process.env.MEETLESS_STORE_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      "MEETLESS_STORE_ROOT must be an absolute isolated path fixed by the Meetless launcher",
    );
  }
  store = new MeetingStore({ root: configuredRoot });
  return store;
}
