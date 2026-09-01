/** Exact hosted-development target lock shared by the canary and pure tests. */

export const HOSTED_DEV_TARGET = Object.freeze({
  team: "hoang-bang",
  project: "meetless",
  deployment: "frugal-mandrill-646",
  reference: "dev/hoang-bang",
  cloudUrl: "https://frugal-mandrill-646.convex.cloud",
  siteUrl: "https://frugal-mandrill-646.convex.site",
});

export const HOSTED_DEV_ENVIRONMENT_NAMES = Object.freeze([
  "MEETLESS_APPLE_VERIFIER_MODE",
  "MEETLESS_AUTH_AUDIENCE",
  "MEETLESS_AUTH_ISSUER",
  "MEETLESS_AUTH_KEY_ID",
  "MEETLESS_AUTH_PRIVATE_KEY_PKCS8",
  "MEETLESS_AUTH_PUBLIC_JWK",
  "MEETLESS_DEPLOYMENT_MODE",
  "MEETLESS_MANAGED_ALLOWANCE_SECONDS",
  "MEETLESS_MANAGED_ALLOWANCE_SOURCE",
  "MEETLESS_MANAGED_PROVIDER_MODE",
  "MEETLESS_REVENUECAT_AUTH_MODE",
  "MEETLESS_REVENUECAT_ENVIRONMENT",
  "MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER",
]);

export const HOSTED_CANARY_READ_ENVIRONMENT_NAMES = Object.freeze([
  "MEETLESS_AUTH_AUDIENCE",
  "MEETLESS_AUTH_ISSUER",
  "MEETLESS_AUTH_KEY_ID",
  "MEETLESS_AUTH_PUBLIC_JWK",
  "MEETLESS_REVENUECAT_WEBHOOK_AUTH_HEADER",
]);

export function parseHostedEnvironmentNames(output) {
  if (typeof output !== "string") throw new Error("hosted environment name listing is not text");
  const names = [];
  for (const rawLine of output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || /^No environment variables set(?: \(on [^)]+ deployment [^)]+\))?$/u.test(line)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(line)) throw new Error("hosted environment name listing contains a malformed name");
    names.push(line);
  }
  return names.sort();
}

export function validateHostedEnvironmentNames(output, expectedNames) {
  const actual = parseHostedEnvironmentNames(output);
  const expected = [...expectedNames].sort();
  if (new Set(expected).size !== expected.length || actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("hosted environment names do not equal the exact approved allowlist");
  }
  return actual;
}

export function formatHostedDotenv(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("hosted environment values must be an object");
  return `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("hosted environment value has a malformed name");
    return `${name}=${formatHostedDotenvValue(value)}`;
  }).join("\n")}\n`;
}

export function formatHostedDotenvValue(value) {
  if (typeof value !== "string") throw new Error("hosted environment values must be strings");
  if (value.includes("\0") || value.includes("\r")) throw new Error("hosted environment value contains an unsupported control character");
  const needsQuote = value.length === 0 || value !== value.trim() || value.includes("#") || value.includes("\n") || /^["'`]/u.test(value) || /["'`]$/u.test(value);
  if (!needsQuote) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value.replaceAll("\n", "\\n")}"`;
  throw new Error("hosted environment value cannot be represented safely in dotenv syntax");
}

export function parseHostedFunctionSpec(output) {
  if (typeof output !== "string") throw new Error("hosted function spec is not text");
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("hosted function spec is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.functions) || parsed.functions.length === 0) {
    throw new Error("hosted function spec is empty");
  }
  assertExactUrl(parsed.url, HOSTED_DEV_TARGET.cloudUrl, "function spec URL");
  return { url: parsed.url, functionCount: parsed.functions.length };
}

export function assertHostedDevTarget({
  deployment = HOSTED_DEV_TARGET.deployment,
  cloudUrl = HOSTED_DEV_TARGET.cloudUrl,
  siteUrl = HOSTED_DEV_TARGET.siteUrl,
  reference = HOSTED_DEV_TARGET.reference,
} = {}) {
  if (deployment !== HOSTED_DEV_TARGET.deployment) throw new Error("hosted canary deployment does not match the locked dev target");
  if (reference !== HOSTED_DEV_TARGET.reference) throw new Error("hosted canary reference does not match the locked dev target");
  assertExactUrl(cloudUrl, HOSTED_DEV_TARGET.cloudUrl, "cloud URL");
  assertExactUrl(siteUrl, HOSTED_DEV_TARGET.siteUrl, "site URL");
  return HOSTED_DEV_TARGET;
}

export function assertHostedUrl(rawUrl, kind, { path = null, allowQuery = true } = {}) {
  const expected = kind === "cloud" ? HOSTED_DEV_TARGET.cloudUrl : kind === "site" ? HOSTED_DEV_TARGET.siteUrl : null;
  if (!expected) throw new Error("hosted canary URL kind is unsupported");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`hosted canary ${kind} URL is invalid`);
  }
  const expectedUrl = new URL(expected);
  if (parsed.protocol !== "https:" || parsed.origin !== expectedUrl.origin) throw new Error(`hosted canary ${kind} URL is outside the locked target`);
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`hosted canary ${kind} URL contains credentials or a fragment`);
  if (!allowQuery && parsed.search) throw new Error(`hosted canary ${kind} URL contains an unexpected query`);
  if (path !== null && parsed.pathname !== path) throw new Error(`hosted canary ${kind} URL path is outside the locked route`);
  return parsed;
}

export function assertHostedCliArguments(kind, args, envFilePath = null) {
  const expected = kind === "env-list"
    ? ["env", "list", "--deployment", HOSTED_DEV_TARGET.deployment, "--names-only"]
    : kind === "env-set"
      ? [["env", "set", "--deployment", HOSTED_DEV_TARGET.deployment, "--from-file", envFilePath], ["env", "set", "--deployment", HOSTED_DEV_TARGET.deployment, "--from-file", envFilePath, "--force"]]
      : kind === "env-get"
        ? HOSTED_CANARY_READ_ENVIRONMENT_NAMES.includes(envFilePath)
          ? ["env", "get", envFilePath, "--deployment", HOSTED_DEV_TARGET.deployment]
          : null
      : kind === "dev"
        ? ["dev"]
        : kind === "function-spec"
          ? ["function-spec", "--deployment", HOSTED_DEV_TARGET.deployment]
        : null;
  const matches = Array.isArray(expected?.[0])
    ? expected.some((candidate) => candidate.length === args.length && candidate.every((value, index) => args[index] === value))
    : expected?.length === args.length && expected.every((value, index) => args[index] === value);
  if (!expected || !matches) {
    throw new Error(`hosted canary ${kind} CLI argv is outside the exact target allowlist`);
  }
}

function assertExactUrl(rawUrl, expected, name) {
  let actual;
  try {
    actual = new URL(rawUrl);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  const target = new URL(expected);
  if (actual.href !== target.href || actual.username || actual.password || actual.search || actual.hash) {
    throw new Error(`${name} is not the exact locked hosted-dev URL`);
  }
}

export function redactHostedDiagnostic(value, secrets = [], maxBytes = 8 * 1024) {
  let text = String(value ?? "");
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => String(right).length - String(left).length)) {
    text = text.split(String(secret)).join("<redacted>");
  }
  text = text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "<redacted-private-key>")
    .replace(/(?:^|\n)[ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-revenuecat-webhook-signature)\s*:[^\n]*/giu, (line) => line.startsWith("\n") ? "\n[redacted-sensitive-diagnostic]" : "[redacted-sensitive-diagnostic]")
    .replace(/\b(?:token|secret|password|credential|receipt|jws|signature)\s*[:=]\s*[^\s,;)]+/giu, (match) => `${match.slice(0, match.search(/[:=]/u) + 1)}<redacted>`)
    .replace(/\b(?:private|admin|signing|api)[-_ ]?key\s*[:=]\s*[^\s,;)]+/giu, (match) => `${match.slice(0, match.search(/[:=]/u) + 1)}<redacted>`)
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{8,}\b/gu, "<redacted-token>");
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= maxBytes ? text : bytes.subarray(-maxBytes).toString("utf8");
}

export function classifyHostedDiagnostic(value) {
  const text = String(value ?? "").toLowerCase();
  if (/deadline|tim(?:e|ed) ?out|sigterm|sigkill|exceeded/u.test(text)) return "timeout";
  if (/unauthor|forbidden|authorization|auth[-_ ]?header|credential|login|bearer|token/u.test(text)) return "authorization";
  if (/typecheck|typescript|\btsc\b/u.test(text)) return "typecheck";
  if (/codegen|generated/u.test(text)) return "codegen";
  if (/function.?spec|schema|deployment|\bdeploy\b|\bpush\b/u.test(text)) return "deployment";
  if (/network|fetch|connection|dns|redirect/u.test(text)) return "network";
  return "unknown";
}

export function formatHostedDiagnostic(value, secrets = [], maxBytes = 8 * 1024) {
  const raw = String(value ?? "");
  return {
    classification: classifyHostedDiagnostic(raw),
    stderr: redactHostedDiagnostic(raw, secrets, maxBytes) || "<empty>",
  };
}
