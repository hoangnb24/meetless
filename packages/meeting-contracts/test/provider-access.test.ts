import { expect, test } from "vitest";
import { NativeProviderAccessRequestSchema, NativeProviderAccessResponseSchema } from "../src/index.js";
const response = { version: 1, requestId: "request", ok: true, type: "provider.access", outcome: "status", providers: [
  { id: "codex", status: "needs_access" }, { id: "claude", status: "unavailable" }, { id: "opencode", status: "unavailable" },
] };
test("provider access accepts status and strictly bounds chooser inputs and path-free outputs", () => {
  expect(NativeProviderAccessResponseSchema.parse(response)).toEqual(response);
  expect(NativeProviderAccessResponseSchema.safeParse({ ...response, outcome: "pending" }).success).toBe(false);
  expect(NativeProviderAccessRequestSchema.safeParse({ version: 1, requestId: "request", operation: "providerAccessRequest", provider: "codex" }).success).toBe(true);
  for (const extra of [{ path: "/private/auth" }, { token: "secret" }, { provider: "other" }]) {
    expect(NativeProviderAccessRequestSchema.safeParse({ version: 1, requestId: "request", operation: "providerAccessRequest", provider: "codex", ...extra }).success).toBe(false);
  }
  expect(NativeProviderAccessResponseSchema.safeParse({ ...response, path: "/private/auth" }).success).toBe(false);
  expect(NativeProviderAccessResponseSchema.safeParse({ ...response, providers: [response.providers[0], response.providers[0], response.providers[2]] }).success).toBe(false);
  expect(NativeProviderAccessResponseSchema.safeParse({ ...response, providers: [{ id: "codex", status: "ready", token: "secret" }, ...response.providers.slice(1)] }).success).toBe(false);
});
