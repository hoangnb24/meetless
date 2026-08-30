import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  MACOS_APP_STORE_CONTRACT,
  resolveMacAppStoreApplicationGroup,
  validateMacAppStoreEntitlementClosure,
} from "./lib/macos-app-store-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await main(parseArguments(process.argv.slice(2)));

async function main(applicationGroupInput) {
  const parent = await readPlist(MACOS_APP_STORE_CONTRACT.signing.parentEntitlements);
  const child = await readPlist(MACOS_APP_STORE_CONTRACT.signing.childEntitlements);
  const applicationGroup = resolveMacAppStoreApplicationGroup(applicationGroupInput);
  validateMacAppStoreEntitlementClosure(parent, child, applicationGroup);
  process.stdout.write(`${JSON.stringify({
    status: "valid",
    target: MACOS_APP_STORE_CONTRACT.target,
    electron: MACOS_APP_STORE_CONTRACT.electron,
    stateOwner: MACOS_APP_STORE_CONTRACT.state.owner,
    parentEntitlements: Object.keys(parent).sort(),
    childEntitlements: Object.keys(child).sort(),
    applicationGroup,
    inAppPurchaseCapability: MACOS_APP_STORE_CONTRACT.signing.inAppPurchaseCapability,
  }, null, 2)}\n`);
}

function parseArguments(arguments_) {
  let teamId = null;
  let applicationGroup = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (name !== "--team-id" && name !== "--application-group") {
      throw new Error(`Unsupported Mac App Store validation option ${name}; use --team-id or --application-group`);
    }
    const value = equals === -1 ? arguments_[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires an explicit value`);
    if (name === "--team-id") {
      if (teamId !== null) throw new Error("--team-id was supplied more than once");
      teamId = value;
    } else {
      if (applicationGroup !== null) throw new Error("--application-group was supplied more than once");
      applicationGroup = value;
    }
  }
  const configuredInput = MACOS_APP_STORE_CONTRACT.signing.applicationGroup;
  return {
    teamId: teamId ?? process.env[configuredInput.teamEnvironment]?.trim() ?? null,
    applicationGroup: applicationGroup ?? process.env[configuredInput.applicationGroupEnvironment]?.trim() ?? null,
  };
}

async function readPlist(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  await readFile(absolutePath);
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", absolutePath], { encoding: "utf8" });
  return JSON.parse(stdout);
}
