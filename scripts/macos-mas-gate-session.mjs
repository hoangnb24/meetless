import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import {
  MAS_GATE_CLEANUP_DIAGNOSTIC,
  archiveMasGateSessionTransaction,
  beginMasGateSessionTransaction,
  readMasGateSessionStatus,
  recoverMasGateSessionTransaction,
  restoreMasGateSessionTransaction,
} from "./lib/macos-mas-gate-session-transaction.mjs";
import { acceptedMacOSPackagePaths } from "./lib/macos-package-contract.mjs";
import { macAppStoreInstallationContract } from "./lib/macos-app-store-package-contract.mjs";

const command = process.argv[2] ?? "status";
const requiredFreeBytes = readRequiredFreeBytes(process.argv.slice(3));
const packagePaths = acceptedMacOSPackagePaths();
const masContract = macAppStoreInstallationContract();
const masRuntimeRoot = path.resolve(homedir(), ...masContract.userSupportRelativePath.split("/"));
const masIdentityPath = path.join(masRuntimeRoot, masContract.identityRelativePath);

if (command === "help" || command === "--help") {
  process.stdout.write("Usage: node scripts/macos-mas-gate-session.mjs <status|begin|recover|restore|archive> [--required-free-bytes=N]\n");
} else {
  const context = runtimeContext();
  let result;
  if (command === "status") {
    result = await readMasGateSessionStatus(context);
  } else if (command === "begin") {
    if (requiredFreeBytes === undefined) {
      throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: begin requires --required-free-bytes=N; no disk budget is selected by this command`);
    }
    result = await beginMasGateSessionTransaction({ ...context, requiredFreeBytes });
  } else if (command === "recover") {
    result = await recoverActive(context);
  } else if (command === "restore") {
    result = await restoreActive(context);
  } else if (command === "archive") {
    result = await archiveActive(context);
  } else {
    throw new Error(`unknown MAS gate session command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
}

function runtimeContext() {
  return {
    runtimeRoot: masRuntimeRoot,
    contractRuntimeRoot: masRuntimeRoot,
    runtimeRootParent: path.dirname(masRuntimeRoot),
    activePath: path.join(path.dirname(masRuntimeRoot), ".meetless-mas-gate-session.active"),
    identityRelativePath: masContract.identityRelativePath,
    identityPath: masIdentityPath,
    assertNoLiveOwnedRuntime: async () => {
      const rows = processRows();
      const live = rows.filter((row) => row.command.includes(masRuntimeRoot) || row.command === path.join(packagePaths.canonicalBundlePath, "Contents/MacOS/MeetlessHost"));
      if (live.length > 0) return true;
      return false;
    },
  };
}

async function recoverActive(context) {
  const status = await readMasGateSessionStatus(context);
  if (status.status !== "active" && status.status !== "recovery-required") return status;
  return recoverMasGateSessionTransaction(status.journalPath, context);
}

async function restoreActive(context) {
  const status = await readMasGateSessionStatus(context);
  if (status.status !== "active") throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: no active MAS gate session is available for restore`);
  return restoreMasGateSessionTransaction(status.journalPath, context);
}

async function archiveActive(context) {
  const status = await readMasGateSessionStatus(context);
  if (status.status !== "active") throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: no active MAS gate session is available for archive`);
  return archiveMasGateSessionTransaction(status.journalPath, context);
}

function summarize(value) {
  if (!value || typeof value !== "object") return value;
  if ("schema" in value && "phase" in value) {
    return {
      schema: value.schema,
      version: value.version,
      runId: value.runId,
      phase: value.phase,
      stateScope: value.stateScope,
      canonicalPath: value.canonicalPath,
      parent: value.parent,
      active: value.active,
      quarantine: value.quarantine,
      freshRetained: value.freshRetained,
      archivePath: value.archivePath,
      journalPath: value.journalPath,
      priorExists: value.priorExists,
      requiredFreeBytes: value.requiredFreeBytes,
      observedFreeBytes: value.observedFreeBytes,
    };
  }
  return value;
}

function processRows() {
  const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function readRequiredFreeBytes(arguments_) {
  const argument = arguments_.find((value) => value.startsWith("--required-free-bytes="));
  if (argument === undefined) return undefined;
  const value = Number(argument.slice("--required-free-bytes=".length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--required-free-bytes must be an explicit positive integer");
  return value;
}
