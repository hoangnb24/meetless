import { anyApi } from "convex/server";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { requirePrincipal } from "./managedAuth";
import { readManagedOpenAICredential } from "./managedConfig";
import { assertManagedAskAdmission } from "./managedAskAdmission";
import { executeOpenAIAsk, MANAGED_ASK_FAILURE } from "./openAIAsk";
import { parseManagedAskRequest } from "../packages/meeting-contracts/src/managed-ask";

export const admit = internalQuery({
  args: {},
  handler: async (ctx) => {
    try {
      const { principal, config } = await requirePrincipal(ctx);
      const lineages = await ctx.db.query("managedLineages").withIndex("by_account", (q) => q.eq("accountId", principal.accountId)).collect();
      assertManagedAskAdmission({ config, principal, lineages, now: Date.now() });
      return { accountId: principal.accountId, deviceId: principal.deviceId };
    } catch {
      throw new ConvexError("Managed Ask requires verified active Sandbox subscription access. Refresh or restore access.");
    }
  },
});

const nullableCount = v.union(v.number(), v.null());
export const recordUsage = internalMutation({
  args: {
    accountId: v.string(), deviceId: v.string(), attemptId: v.string(),
    model: v.literal("gpt-5.6-luna"), latencyMs: v.number(),
    status: v.union(v.literal("supported"), v.literal("insufficient_evidence"), v.literal("invalid_answer"), v.literal("provider_error"), v.literal("unknown")),
    usage: v.object({ inputTokens: nullableCount, outputTokens: nullableCount, totalTokens: nullableCount,
      cachedInputTokens: nullableCount, cacheWriteInputTokens: nullableCount, reasoningTokens: nullableCount }),
  },
  handler: async (ctx, args) => { await ctx.db.insert("managedAskUsage", { ...args, observedAt: Date.now() }); },
});

/** Content exists only in the foreground action. Never pass content to a mutation/scheduler. */
export const ask = action({
  args: { request: v.any() },
  handler: async (ctx, args) => {
    try {
      const request = parseManagedAskRequest(args.request);
      const principal = await ctx.runQuery(anyApi.managedAsk.admit, {});
      return await executeOpenAIAsk(request, readManagedOpenAICredential(), async (observation) => {
        await ctx.runMutation(anyApi.managedAsk.recordUsage, {
          accountId: principal.accountId, deviceId: principal.deviceId,
          attemptId: request.attemptId, ...observation,
        });
      });
    } catch {
      throw new ConvexError(MANAGED_ASK_FAILURE);
    }
  },
});
