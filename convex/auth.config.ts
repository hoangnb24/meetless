import type { AuthConfig } from "convex/server";
import { readManagedRuntimeConfig } from "./managedConfig";

const deploymentMode = typeof process === "undefined" ? undefined : process.env.MEETLESS_DEPLOYMENT_MODE;

let config: AuthConfig;
try {
  const runtime = readManagedRuntimeConfig();
  const jwk = JSON.parse(runtime.authPublicJwk) as Record<string, unknown>;
  config = {
    providers: [{
      type: "customJwt",
      issuer: runtime.authIssuer,
      applicationID: runtime.authAudience,
      algorithm: "ES256",
      // Convex accepts a data-URI JWKS. Keep the diagnostic route separate:
      // auth validation must not depend on a same-deployment HTTP route.
      jwks: buildInlinePublicJwks(jwk, runtime.authKeyId),
    }],
  };
} catch (error) {
  if (deploymentMode === "production") throw error;
  // Local source checkout and an unconfigured deployment have no auth
  // provider. Managed functions still fail closed when they read runtime
  // configuration, while Convex can boot for pure codegen/tests.
  config = { providers: [] };
}

export default config;

export function buildInlinePublicJwks(publicJwk: Record<string, unknown>, expectedKid?: string): string {
  if (
    !publicJwk || Array.isArray(publicJwk) || publicJwk.kty !== "EC" || publicJwk.crv !== "P-256" ||
    typeof publicJwk.x !== "string" || typeof publicJwk.y !== "string" || publicJwk.alg !== "ES256" ||
    publicJwk.use !== "sig" || "d" in publicJwk
  ) {
    throw new Error("public JWKS must contain only the configured ES256 public key");
  }
  if (expectedKid !== undefined && publicJwk.kid !== expectedKid) {
    throw new Error("public JWKS key identifier does not match the configured key identifier");
  }
  return `data:application/json;base64,${base64(JSON.stringify({ keys: [publicJwk] }))}`;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
