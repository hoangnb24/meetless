#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findReservationConflicts } from "../khuym_reservations.mjs";
import { resolveRepoRoot } from "../khuym_state.mjs";

const BARE_BV = /(^|\s)bv(\s|$)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const BROAD_WRITE_COMMANDS = [
  /\bgit\s+(add|mv|rm)\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\brm\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bsed\s+-i\b/,
  /\bperl\s+-i\b/,
  /\btee\b/,
];

function getNestedString(payload, pathParts) {
  let current = payload;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return "";
    }
    current = current[part];
  }
  return typeof current === "string" ? current.trim() : "";
}

function inferAgentName(payload, toolInput) {
  const candidates = [
    getNestedString(payload, ["agent_name"]),
    getNestedString(payload, ["agentName"]),
    getNestedString(payload, ["agent_nickname"]),
    getNestedString(payload, ["codex_subagent_name"]),
    getNestedString(payload, ["session", "agent_name"]),
    getNestedString(payload, ["session", "agentName"]),
    getNestedString(payload, ["session", "agent_nickname"]),
    getNestedString(payload, ["thread", "agent_name"]),
    getNestedString(payload, ["thread", "agent_nickname"]),
    getNestedString(toolInput, ["env", "KHUYM_AGENT_NAME"]),
  ];
  return candidates.find(Boolean) || "";
}

function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  }
  return tokens.filter(Boolean);
}

function looksLikePathToken(token, repoRoot) {
  if (!token || token === "-" || ENV_ASSIGNMENT.test(token) || token.startsWith("-")) {
    return false;
  }
  if (token === "." || token === "..") {
    return true;
  }
  if (/[/*?[\]{}]/.test(token) || token.includes("/")) {
    return true;
  }
  if (token.startsWith(".")) {
    return true;
  }
  return token.includes(".") && path.resolve(repoRoot, token).startsWith(repoRoot);
}

function extractCommandPaths(command, repoRoot) {
  const tokens = tokenizeCommand(command);
  const paths = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === ">" || token === ">>") {
      if (tokens[index + 1]) {
        paths.push(tokens[index + 1]);
      }
      continue;
    }
    if (looksLikePathToken(token, repoRoot)) {
      paths.push(token);
    }
  }

  return [...new Set(paths)];
}

function isWriteHeavy(command) {
  if (command.includes(".codex/khuym_reservations.mjs")) {
    return false;
  }
  if (/>|>>/.test(command)) {
    return true;
  }
  return BROAD_WRITE_COMMANDS.some((pattern) => pattern.test(command));
}

function renderConflictSummary(conflicts) {
  return conflicts
    .map((conflict) => `${conflict.agent} -> ${conflict.paths.join(", ")}`)
    .join(" ; ");
}

async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

export async function main() {
  const payload = await readPayload();
  const toolInput = payload.tool_input || {};
  const command = toolInput.command || "";
  const repoRoot = resolveRepoRoot(payload.cwd || toolInput.cwd || process.cwd());

  let message = null;
  let continueRun = true;

  if (BARE_BV.test(command) && !command.includes("--robot-")) {
    message =
      "Khuym expects `bv` only with `--robot-*` flags in agent sessions. Bare `bv` launches the interactive TUI.";
  }

  if (!message && isWriteHeavy(command)) {
    const commandPaths = extractCommandPaths(command, repoRoot);
    const pathsToCheck = commandPaths.length > 0 ? commandPaths : ["**"];
    const agentName = inferAgentName(payload, toolInput);
    const conflicts = findReservationConflicts(repoRoot, {
      agent: agentName || undefined,
      paths: pathsToCheck,
    });

    if (conflicts.length > 0) {
      const conflictSummary = renderConflictSummary(conflicts);
      if (agentName) {
        continueRun = false;
        message =
          `Khuym local reservations blocked this shell command for ${agentName}. ` +
          `Requested paths: ${pathsToCheck.join(", ")}. Active conflicts: ${conflictSummary}.`;
      } else {
        message =
          "Khuym local reservations detected overlapping active claims, but this hook could not " +
          "determine the current agent identity from the Bash payload so it is warning instead of blocking. " +
          `Requested paths: ${pathsToCheck.join(", ")}. Active conflicts: ${conflictSummary}. ` +
          "Prefix write-heavy shell commands with `KHUYM_AGENT_NAME=<codex nickname>` to enable ownership-aware blocking.";
      }
    }
  }

  const output = { continue: continueRun };
  if (message) {
    output.systemMessage = message;
  }

  process.stdout.write(JSON.stringify(output));
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  const argvPath = path.resolve(process.argv[1]);
  const selfPath = fileURLToPath(import.meta.url);
  if (argvPath === selfPath) {
    return true;
  }

  try {
    return realPathOrResolved(argvPath) === realPathOrResolved(selfPath);
  } catch {
    return false;
  }
}

function realPathOrResolved(filePath) {
  try {
    return path.resolve(fs.realpathSync.native(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

if (isDirectExecution()) {
  process.exitCode = await main();
}
