import {
  MAS_GATE_COORDINATOR_SCHEMA,
  masDevelopmentRuntimeContext,
  masGateRuntimeOptions,
  readMasGateSessionStatus,
  restoreMasDevelopmentGate,
} from "./macos-mas-development-gate.mjs";
import { MAS_GATE_CLEANUP_DIAGNOSTIC } from "./lib/macos-mas-gate-session-transaction.mjs";

const [command = "status"] = process.argv.slice(2);
const context = masDevelopmentRuntimeContext();

if (command === "help" || command === "--help") {
  process.stdout.write("Usage: node scripts/macos-mas-gate-session.mjs <status|recover|restore|archive>\n");
} else if (command === "status") {
  process.stdout.write(`${JSON.stringify(await readMasGateSessionStatus(masGateRuntimeOptions(context)), null, 2)}\n`);
} else if (command === "recover" || command === "restore" || command === "archive") {
  // Recovery, restore, and archive all use the MAS coordinator's package-first
  // ordering. There is no transaction-only cleanup bypass.
  const result = await restoreMasDevelopmentGate({ context });
  process.stdout.write(`${JSON.stringify({ coordinator: MAS_GATE_COORDINATOR_SCHEMA, ...result }, null, 2)}\n`);
} else {
  throw new Error(`${MAS_GATE_CLEANUP_DIAGNOSTIC} Reason: unknown MAS gate session command ${command}`);
}
