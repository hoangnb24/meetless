import type { PluginContext } from "@paseo/plugin";
import { MeetingCreateRpc, MeetingListRpc } from "@meetless/meeting-contracts";
import { getMeetingStore } from "./src/server.js";

export default function contribute(plugin: PluginContext) {
  plugin.handle(MeetingCreateRpc, ({ title }) => getMeetingStore().create({ title }));
  plugin.handle(MeetingListRpc, async () => ({ meetings: await getMeetingStore().list() }));
  return () => undefined;
}
