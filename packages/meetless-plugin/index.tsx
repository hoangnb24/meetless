import type { PluginContext } from "@paseo/plugin";
import { MeetingCreateRpc, MeetingListRpc } from "@meetless/meeting-contracts";

export default function contribute(plugin: PluginContext) {
  let cleanup: (() => Promise<void>) | null = null;
  plugin.handle(MeetingCreateRpc, async ({ title }) => {
    const server = await import("./src/server.js");
    await server.startRecordingRuntime();
    cleanup = server.stopRecordingRuntime;
    return server.getMeetingStore().create({ title });
  });
  plugin.handle(MeetingListRpc, async () => {
    const server = await import("./src/server.js");
    await server.startRecordingRuntime();
    cleanup = server.stopRecordingRuntime;
    return { meetings: await server.getMeetingStore().list() };
  });
  return () => cleanup?.();
}
