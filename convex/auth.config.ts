import type { AuthConfig } from "convex/server";
import { readManagedRuntimeConfig } from "./managedConfig";

const deploymentMode = typeof process === "undefined" ? undefined : process.env.MEETLESS_DEPLOYMENT_MODE;

let config: AuthConfig;
try {
  const runtime = readManagedRuntimeConfig();
  const jwk = JSON.parse(runtime.authPublicJwk) as Record<string, unknown>;
  if (
    jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
    jwk.kid !== runtime.authKeyId || jwk.alg !== "ES256" || jwk.use !== "sig" || "d" in jwk
  ) {
    throw new Error("public JWKS must contain only the configured ES256 public key");
  }
  config = {
    providers: [{
      type: "customJwt",
      issuer: runtime.authIssuer,
      applicationID: runtime.authAudience,
      algorithm: "ES256",
      jwks: `data:application/json;base64,${base64(JSON.stringify({ keys: [jwk] }))}`,
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

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
