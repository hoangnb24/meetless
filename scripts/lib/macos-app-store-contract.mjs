import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MACOS_APP_STORE_CONTRACT_SCHEMA = "MEETLESS_MAC_APP_STORE_CONTRACT v1";
export const MACOS_APP_STORE_APPLICATION_GROUP_KEY = "com.apple.security.application-groups";
export const MACOS_APP_STORE_DEFAULT_TEAM_ID = "63M98WD275";
export const MACOS_APP_STORE_PARENT_ENTITLEMENTS = Object.freeze([
  "com.apple.security.app-sandbox",
  MACOS_APP_STORE_APPLICATION_GROUP_KEY,
  "com.apple.security.device.audio-input",
  "com.apple.security.network.client",
  "com.apple.security.network.server",
]);
export const MACOS_APP_STORE_CHILD_ENTITLEMENTS = Object.freeze([
  "com.apple.security.app-sandbox",
  "com.apple.security.inherit",
]);

const TEAM_ID_PATTERN = /^[A-Z0-9]{5,20}$/u;
const BUNDLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/u;
const contractPath = fileURLToPath(new URL("./macos-app-store-contract.json", import.meta.url));

export const MACOS_APP_STORE_CONTRACT = validateMacAppStoreContract(
  JSON.parse(readFileSync(contractPath, "utf8")),
);

export function validateMacAppStoreContract(value) {
  const fail = (message) => {
    throw new Error(`Invalid Mac App Store contract: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  if (value.schema !== MACOS_APP_STORE_CONTRACT_SCHEMA) fail("schema must be v1");
  if (value.target !== "macos-app-store-arm64") fail("target must remain the arm64 Mac App Store target");
  if (value.bundleIdentifier !== "com.meetless.app") fail("bundle identifier drifted");
  if (value.distribution !== "mac-app-store") fail("distribution must be Mac App Store");
  if (value.electron?.version !== "41.2.0" || value.electron?.platform !== "mas" || value.electron?.arch !== "arm64") {
    fail("Electron must use the pinned 41.2.0 mas arm64 artifact");
  }
  if (value.electron?.archiveName !== "electron-v41.2.0-mas-arm64.zip") fail("Electron archive name drifted");
  if (value.state?.owner !== "app-container") fail("writable state must be app-container owned");
  if (value.state?.applicationSupportRelativePath !== "Meetless") fail("container Application Support path drifted");
  if (value.state?.recordingExportsRelativePath !== "Meetless/recordings") fail("container recording path drifted");
  if (value.state?.externalExport !== "user-selected-security-scoped-destination") {
    fail("external export must require a user-selected security-scoped destination");
  }
  if (value.signing?.identityKind !== "Apple Distribution") fail("signing identity must be Apple Distribution");
  if (value.signing?.provisioningProfile !== "Mac App Store") fail("an App Store provisioning profile is required");
  if (value.signing?.inAppPurchaseCapability !== "App Store Connect") {
    fail("In-App Purchase must be configured as an App Store Connect capability");
  }
  validateApplicationGroupConfiguration(value.signing?.applicationGroup, value.bundleIdentifier, fail);
  return value;
}

export function resolveMacAppStoreApplicationGroup({ teamId = null, applicationGroup = null } = {}) {
  const configuration = MACOS_APP_STORE_CONTRACT.signing.applicationGroup;
  const explicitTeamId = normalizeOptional(teamId, "Team ID");
  const explicitApplicationGroup = normalizeOptional(applicationGroup, "application group");
  const resolvedTeamId = explicitTeamId ?? (explicitApplicationGroup
    ? explicitApplicationGroup.slice(0, explicitApplicationGroup.indexOf("."))
    : configuration.defaultTeamId);
  if (!TEAM_ID_PATTERN.test(resolvedTeamId)) {
    throw new Error(`Invalid Mac App Store application-group input: Team ID ${resolvedTeamId} is not valid; supply the Team ID from the App Store profile`);
  }
  const resolvedApplicationGroup = explicitApplicationGroup ?? `${resolvedTeamId}.${configuration.bundleIdentifier}`;
  if (!isApplicationGroup(resolvedApplicationGroup, configuration.bundleIdentifier)) {
    throw new Error(
      `Invalid Mac App Store application-group input: expected ${resolvedTeamId}.${configuration.bundleIdentifier}; ` +
      "supply --application-group=TEAM_ID.com.meetless.app or a matching --team-id",
    );
  }
  if (!resolvedApplicationGroup.startsWith(`${resolvedTeamId}.`)) {
    throw new Error(
      `Invalid Mac App Store application-group input: ${resolvedApplicationGroup} does not belong to Team ID ${resolvedTeamId}; ` +
      "use the Team ID embedded in the application group",
    );
  }
  return { teamId: resolvedTeamId, applicationGroup: resolvedApplicationGroup };
}

export function validateEntitlementKeys(actual, expected, label, { applicationGroup = null } = {}) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`${label} entitlements must be a dictionary (docs/decisions/0005-mac-app-store-and-revenuecat.md)`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} entitlements must contain exactly ${expectedKeys.join(", ")}; received ${actualKeys.join(", ") || "none"}. ` +
      "The MAS entitlement closure is defined by docs/decisions/0005-mac-app-store-and-revenuecat.md and Electron's Mac App Store guide; update the exact plist.",
    );
  }
  for (const key of expectedKeys) {
    if (key === MACOS_APP_STORE_APPLICATION_GROUP_KEY) {
      const values = actual[key];
      if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !isApplicationGroup(values[0], "com.meetless.app")) {
        throw new Error(
          `${label} entitlement ${MACOS_APP_STORE_APPLICATION_GROUP_KEY} must contain one TEAM_ID.com.meetless.app value. ` +
          "Use the explicit build-time application-group input required by docs/decisions/0005-mac-app-store-and-revenuecat.md.",
        );
      }
      if (applicationGroup !== null && values[0] !== applicationGroup) {
        throw new Error(
          `${label} entitlement ${MACOS_APP_STORE_APPLICATION_GROUP_KEY} is ${values[0]}, expected ${applicationGroup}. ` +
          "Regenerate the MAS entitlement from the selected build-time Team ID/application-group input.",
        );
      }
      continue;
    }
    if (actual[key] !== true) throw new Error(`${label} entitlement ${key} must be true`);
  }
  if ("com.apple.developer.in-app-payments" in actual) {
    throw new Error(`${label} must not use the Apple Pay merchant entitlement for StoreKit subscriptions`);
  }
  return actual;
}

export function validateMacAppStoreEntitlementClosure(parent, child, options = {}) {
  const resolved = resolveMacAppStoreApplicationGroup(options);
  validateEntitlementKeys(parent, MACOS_APP_STORE_PARENT_ENTITLEMENTS, "parent app", resolved);
  validateEntitlementKeys(child, MACOS_APP_STORE_CHILD_ENTITLEMENTS, "inherited child");
  return resolved;
}

function validateApplicationGroupConfiguration(configuration, bundleIdentifier, fail) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    fail("application-group input configuration is missing");
  }
  if (configuration.source !== "build-input") fail("application-group source must remain build-input");
  if (configuration.teamEnvironment !== "MEETLESS_APP_STORE_TEAM_ID") fail("application-group Team ID input name drifted");
  if (configuration.applicationGroupEnvironment !== "MEETLESS_APP_STORE_APPLICATION_GROUP") {
    fail("application-group input name drifted");
  }
  if (configuration.bundleIdentifier !== bundleIdentifier) fail("application-group bundle identifier drifted");
  if (configuration.defaultTeamId !== MACOS_APP_STORE_DEFAULT_TEAM_ID) {
    fail("application-group default Team ID must match the repository-authorized signing Team ID");
  }
  if (!TEAM_ID_PATTERN.test(configuration.defaultTeamId ?? "")) fail("application-group default Team ID is invalid");
  if (configuration.defaultValue !== `${configuration.defaultTeamId}.${bundleIdentifier}`) {
    fail("application-group default must be TEAM_ID.com.meetless.app");
  }
}

function normalizeOptional(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Mac App Store application-group input: ${label} must not be empty`);
  return value.trim();
}

function isApplicationGroup(value, bundleIdentifier) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(".");
  if (separator < 1 || separator === value.length - 1) return false;
  const teamId = value.slice(0, separator);
  const identifier = value.slice(separator + 1);
  return TEAM_ID_PATTERN.test(teamId) && identifier === bundleIdentifier && BUNDLE_IDENTIFIER_PATTERN.test(identifier);
}
