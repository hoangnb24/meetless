import {
  MAS_GATE_COORDINATOR_SCHEMA,
  beginMasGateSessionTransaction,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  readMasGateSessionStatus,
  restoreMasDevelopmentGate,
} from "./macos-mas-development-gate.mjs";
import { MAS_GATE_CLEANUP_DIAGNOSTIC } from "./lib/macos-mas-gate-session-transaction.mjs";

const [command = "status", ...arguments_] = process.argv.slice(2);
const context = masDevelopmentRuntimeContext();

if (command === "help" || command === "--help") {
  process.stdout.write("Usage: node scripts/macos-mas-gate-session.mjs <status|begin|recover|restore|archive> [--required-free-bytes=N]\n");
} else if (command === "status") {
  process.stdout.write(`${JSON.stringify(await readMasGateSessionStatus(masGateRuntimeOptions(context)), null, 2)}\n`);
} else if (command === "begin") {
  const requiredFreeBytes = readRequiredFreeBytes(arguments_);
  if (requiredFreeBytes === undefined) {
    throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: begin requires --required-free-bytes=N; no budget default is selected`);
  }
  const result = await beginMasGateSessionTransaction(masGateRuntimeOptions(context, { requiredFreeBytes }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "recover" || command === "restore" || command === "archive") {
  // Recovery, restore, and archive all use the MAS coordinator's package-first
  // ordering. There is no transaction-only cleanup bypass.
  const result = await restoreMasDevelopmentGate({ context });
  process.stdout.write(`${JSON.stringify({ coordinator: MAS_GATE_COORDINATOR_SCHEMA, ...result }, null, 2)}\n`);
} else {
  throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: unknown MAS gate session command ${command}`);
}

function readRequiredFreeBytes(arguments_) {
  const argument = arguments_.find((value) => value.startsWith("--required-free-bytes="));
  if (argument === undefined) return undefined;
  const value = Number(argument.slice("--required-free-bytes=".length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--required-free-bytes must be an explicit positive integer");
  return value;
}
