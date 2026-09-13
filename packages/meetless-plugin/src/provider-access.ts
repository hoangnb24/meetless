import net from "node:net";
import { randomUUID } from "node:crypto";
import { NativeProviderAccessRequestSchema, NativeProviderAccessResponseSchema, type ProviderAccessId, type ProviderAccessResult } from "@meetless/meeting-contracts";

/** Native host owns the chooser, bookmarks and access lifetime. No paths cross this boundary. */
export function providerAccess(socketPath: string, provider?: ProviderAccessId): Promise<ProviderAccessResult> {
  const requestId = randomUUID();
  const request = NativeProviderAccessRequestSchema.parse({ version: 1, requestId,
    ...(provider ? { operation: "providerAccessRequest", provider } : { operation: "providerAccessStatus" }) });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result?: ProviderAccessResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result) resolve(result); else reject(new Error("Provider folder access is unavailable. Try again."));
    };
    socket.setEncoding("utf8");
    socket.setTimeout(provider ? 300_000 : 5_000, () => finish());
    socket.once("error", () => finish());
    socket.once("end", () => finish());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) return finish();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = NativeProviderAccessResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.requestId !== requestId) return finish();
        finish({ providers: response.providers, outcome: response.outcome });
      } catch { finish(); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  });
}
