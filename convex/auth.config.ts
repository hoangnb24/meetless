import type { AuthConfig } from "convex/server";

const deploymentMode = typeof process === "undefined" ? undefined : process.env.MEETLESS_DEPLOYMENT_MODE;

let config: AuthConfig;
try {
  const issuer = requiredAuthEnvironment("MEETLESS_AUTH_ISSUER");
  const audience = requiredAuthEnvironment("MEETLESS_AUTH_AUDIENCE");
  const keyId = requiredAuthEnvironment("MEETLESS_AUTH_KEY_ID");
  const jwk = JSON.parse(requiredAuthEnvironment("MEETLESS_AUTH_PUBLIC_JWK")) as Record<string, unknown>;
  config = {
    providers: [{
      type: "customJwt",
      issuer,
      applicationID: audience,
      algorithm: "ES256",
      // Convex accepts a data-URI JWKS. Keep the diagnostic route separate:
      // auth validation must not depend on a same-deployment HTTP route.
      jwks: buildInlinePublicJwks(jwk, keyId),
    }],
  };
} catch (error) {
  if (deploymentMode !== undefined) throw error;
  // An unconfigured source checkout has no auth provider so pure codegen and
  // local policy tests can boot. Any configured deployment mode must surface
  // configuration errors instead of silently deploying with no provider.
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

function requiredAuthEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the configured custom JWT provider`);
  return value;
}
