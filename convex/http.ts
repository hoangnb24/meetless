import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { anyApi } from "convex/server";
import {
  MANAGED_ANNUAL_PRODUCT_ID,
  MANAGED_MONTHLY_PRODUCT_ID,
  MANAGED_REVENUECAT_APP_ID,
  readManagedRuntimeConfig,
} from "./managedConfig";
import { lineageKeyForOriginalTransactionId } from "./appleSubscription";
import {
  parseRevenueCatWebhook,
  verifyRevenueCatWebhook,
  RevenueCatWebhookError,
} from "./revenueCatWebhook";

const http = httpRouter();

http.route({
  path: "/managed-auth/jwks.json",
  method: "GET",
  handler: httpAction(async () => {
    try {
      const config = readManagedRuntimeConfig();
      const jwk = JSON.parse(config.authPublicJwk) as Record<string, unknown>;
      if ("d" in jwk || jwk.kid !== config.authKeyId || jwk.alg !== "ES256" || jwk.use !== "sig") return safeResponse("JWKS unavailable", 503);
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return safeResponse("JWKS unavailable", 503);
    }
  }),
});

http.route({
  path: "/webhooks/revenuecat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let rawBody: Uint8Array;
    try {
      rawBody = new Uint8Array(await request.arrayBuffer());
    } catch {
      return safeResponse("invalid webhook body", 400);
    }
    try {
      const config = readManagedRuntimeConfig();
      await verifyRevenueCatWebhook(rawBody, {
        authorization: request.headers.get("authorization") ?? undefined,
        "x-revenuecat-webhook-signature": request.headers.get("x-revenuecat-webhook-signature") ?? undefined,
      }, {
        mode: config.revenueCatAuthMode,
        authorizationHeader: config.revenueCatAuthorizationHeader,
        signingSecret: config.revenueCatSigningSecret,
      });
      const parsed = parseRevenueCatWebhook(
        rawBody,
        MANAGED_REVENUECAT_APP_ID,
        [MANAGED_MONTHLY_PRODUCT_ID, MANAGED_ANNUAL_PRODUCT_ID],
        config.revenueCatEnvironment,
      );
      const lineageKey = await lineageKeyForOriginalTransactionId(parsed.originalTransactionId);
      // The original transaction identifier is used only to select the
      // server-stored hashed lineage. It is not sent to the durable inbox.
      const receipt = await ctx.runMutation(anyApi.managedAuth.receiveRevenueCatEvent, {
        event: {
          eventId: parsed.eventId,
          lineageKey,
          appId: parsed.appId,
          productId: parsed.productId,
          environment: parsed.environment,
          eventType: parsed.eventType,
          eventTimestampMs: parsed.eventTimestampMs,
        },
      });
      return new Response(JSON.stringify({ accepted: true, outcome: receipt.outcome }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof RevenueCatWebhookError) return safeResponse("webhook rejected", 401);
      if (error instanceof Error && error.name === "ManagedConfigurationError") return safeResponse("webhook unavailable", 503);
      return safeResponse("webhook invalid", 400);
    }
  }),
});

http.route({
  path: "/webhooks/revenuecat",
  method: "GET",
  handler: httpAction(async () => safeResponse("method not allowed", 405, { allow: "POST" })),
});

export default http;

function safeResponse(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ accepted: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
