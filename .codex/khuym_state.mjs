#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildKhuymDependencyReport } from "./khuym_dependencies.mjs";

export const STATE_SCHEMA_VERSION = "1.1";

const GKG_SERVER_URL = "http://127.0.0.1:27495";
const SUPPORTED_GKG_LANGUAGE_EXTENSIONS = {
  "TypeScript / JavaScript": new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  Ruby: new Set([".rb", ".rake"]),
  Java: new Set([".java"]),
  Kotlin: new Set([".kt", ".kts"]),
  Python: new Set([".py"]),
};
const SUPPORTED_GKG_BASENAMES = {
  Gemfile: "Ruby",
  Rakefile: "Ruby",
  Vagrantfile: "Ruby",
};
const OTHER_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".el",
  ".erl",
  ".ex",
  ".exs",
  ".go",
  ".groovy",
  ".h",
  ".hpp",
  ".lua",
  ".php",
  ".pl",
  ".pm",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".zig",
]);
const WALK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".idea",
  ".codex",
  ".khuym",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".venv",
  ".vscode",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "history",
  "node_modules",
  "target",
  "tmp",
  "vendor",
]);

const DEFAULT_APPROVED_GATES = {
  context: false,
  phase_plan: false,
  execution: false,
  review: false,
};

function utcNow() {
  return new Date().toISOString();
}

function normalizeFsPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function categorizeGkgLanguage(fileName) {
  if (SUPPORTED_GKG_BASENAMES[fileName]) {
    return { type: "supported", language: SUPPORTED_GKG_BASENAMES[fileName] };
  }

  const extension = path.extname(fileName).toLowerCase();
  for (const [language, extensions] of Object.entries(SUPPORTED_GKG_LANGUAGE_EXTENSIONS)) {
    if (extensions.has(extension)) {
      return { type: "supported", language };
    }
  }

  if (OTHER_SOURCE_EXTENSIONS.has(extension)) {
    return { type: "unsupported_code", language: extension };
  }

  return { type: "ignored", language: "" };
}

function collectRepoLanguageSignals(repoRoot) {
  const supportedCounts = new Map();
  const unsupportedCounts = new Map();

  function walk(dirPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const categorized = categorizeGkgLanguage(entry.name);
      if (categorized.type === "supported") {
        supportedCounts.set(
          categorized.language,
          (supportedCounts.get(categorized.language) || 0) + 1,
        );
        continue;
      }

      if (categorized.type === "unsupported_code") {
        unsupportedCounts.set(
          categorized.language,
          (unsupportedCounts.get(categorized.language) || 0) + 1,
        );
      }
    }
  }

  walk(repoRoot);

  const supportedLanguages = [...supportedCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language]) => language);
  const primarySupportedLanguage = supportedLanguages[0] || "";
  const supportedFileCount = [...supportedCounts.values()].reduce((sum, count) => sum + count, 0);
  const unsupportedCodeFileCount = [...unsupportedCounts.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const coverage =
    supportedFileCount === 0 ? "none" : unsupportedCodeFileCount === 0 ? "full" : "limited";

  return {
    supported_repo: supportedFileCount > 0,
    supported_languages: supportedLanguages,
    primary_supported_language: primarySupportedLanguage,
    coverage,
    supported_file_count: supportedFileCount,
    unsupported_code_file_count: unsupportedCodeFileCount,
    unsupported_code_signals: [...unsupportedCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([extension, count]) => ({ extension, count })),
  };
}

function readJsonViaNode(url) {
  try {
    const script = `
const url = ${JSON.stringify(url)};
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 1200);
fetch(url, { signal: controller.signal })
  .then(async (response) => {
    clearTimeout(timeout);
    if (!response.ok) {
      process.exit(2);
      return;
    }
    const text = await response.text();
    process.stdout.write(text);
  })
  .catch(() => process.exit(3));
`;
    const stdout = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch {
    return null;
  }
}

function extractProjectPaths(payload, collected = new Set()) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      extractProjectPaths(item, collected);
    }
    return collected;
  }

  if (!payload || typeof payload !== "object") {
    return collected;
  }

  const directKeys = [
    "folder_path",
    "path",
    "project_path",
    "project_root",
    "repo_path",
    "workspace_folder_path",
  ];
  for (const key of directKeys) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      collected.add(normalizeFsPath(payload[key]));
    }
  }

  const nestedKeys = ["projects", "workspaces", "items", "entries"];
  for (const key of nestedKeys) {
    if (Array.isArray(payload[key])) {
      extractProjectPaths(payload[key], collected);
    }
  }

  return collected;
}

function readGkgServerStatus(repoRoot) {
  const serverUrl = process.env.KHUYM_GKG_SERVER_URL || GKG_SERVER_URL;
  const info = readJsonViaNode(`${serverUrl}/api/info`);
  const workspaceList = info ? readJsonViaNode(`${serverUrl}/api/workspace/list`) : null;
  const indexedPaths = extractProjectPaths(workspaceList);
  const normalizedRepoRoot = normalizeFsPath(repoRoot);

  return {
    server_reachable: Boolean(info),
    server_version: typeof info?.version === "string" ? info.version : "",
    project_indexed:
      indexedPaths.has(normalizedRepoRoot) ||
      [...indexedPaths].some((indexedPath) => indexedPath.startsWith(`${normalizedRepoRoot}${path.sep}`)),
  };
}

function buildGkgRecommendedAction(repoRoot, readiness) {
  if (!readiness.supported_repo) {
    return "Repo does not contain gkg-supported code; use grep/file inspection fallback.";
  }

  if (!readiness.server_reachable && !readiness.project_indexed) {
    return `Run \`gkg index ${repoRoot}\`, then \`gkg server start\` before planning uses gkg.`;
  }

  if (!readiness.server_reachable) {
    return "Run `gkg server start` before planning uses gkg MCP tools.";
  }

  if (!readiness.project_indexed) {
    return `Project is not indexed. Stop the server if needed, run \`gkg index ${repoRoot}\`, then restart it.`;
  }

  return "gkg is ready for MCP-backed discovery.";
}

export function readGkgReadiness(repoRoot) {
  const languageSignals = collectRepoLanguageSignals(repoRoot);
  const serverStatus = readGkgServerStatus(repoRoot);
  const readiness = {
    ...languageSignals,
    ...serverStatus,
    recommended_action: "",
  };
  readiness.recommended_action = buildGkgRecommendedAction(repoRoot, readiness);
  return readiness;
}

export function resolveRepoRoot(explicitRoot, startFrom = process.cwd()) {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const cwd = path.resolve(startFrom);
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return path.resolve(stdout.trim());
  } catch {
    let candidate = cwd;
    while (true) {
      if (
        fs.existsSync(path.join(candidate, ".git")) ||
        fs.existsSync(path.join(candidate, ".khuym", "onboarding.json"))
      ) {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return cwd;
      }
      candidate = parent;
    }
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.trim() !== "");
}

function normalizeActiveWorkers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((worker) => ({
      codex_name: typeof worker.codex_name === "string" ? worker.codex_name : "",
      agent_id:
        typeof worker.agent_id === "string"
          ? worker.agent_id
          : typeof worker.agent_mail_name === "string"
            ? worker.agent_mail_name
            : "",
      status: typeof worker.status === "string" ? worker.status : "",
      bead_id: typeof worker.bead_id === "string" ? worker.bead_id : "",
    }));
}

function normalizeApprovedGates(value) {
  const gates = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    context: Boolean(gates.context),
    phase_plan: Boolean(gates.phase_plan),
    execution: Boolean(gates.execution),
    review: Boolean(gates.review),
  };
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeLastCompoundingRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      feature: "",
      date: "",
      learnings_file: "",
      critical_promotions: 0,
    };
  }

  return {
    feature: normalizeOptionalString(value.feature),
    date: normalizeOptionalString(value.date),
    learnings_file: normalizeOptionalString(value.learnings_file),
    critical_promotions: Number.isFinite(value.critical_promotions)
      ? value.critical_promotions
      : 0,
  };
}

function readDependencyHealth(repoRoot) {
  try {
    return buildKhuymDependencyReport({ repoRoot });
  } catch (error) {
    return {
      checked_at: utcNow(),
      summary: {
        skills_total: 0,
        skills_covered: 0,
        skills_with_declared_dependencies: 0,
        skills_dependency_free: 0,
        skills_uncovered: 0,
        skills_available: 0,
        skills_degraded: 0,
        skills_unavailable: 0,
        declared_dependencies: 0,
        missing_dependencies: 0,
      },
      skills: [],
      uncovered_skills: [],
      missing_dependencies: [],
      mcp_sources: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildDefaultState(overrides = {}) {
  const approvedGates = normalizeApprovedGates(overrides.approved_gates);
  const state = {
    schema_version: STATE_SCHEMA_VERSION,
    feature_slug: typeof overrides.feature_slug === "string" ? overrides.feature_slug : "",
    mode: typeof overrides.mode === "string" ? overrides.mode : "",
    active_skill: typeof overrides.active_skill === "string" ? overrides.active_skill : "",
    phase: typeof overrides.phase === "string" ? overrides.phase : "idle",
    phase_number: Number.isFinite(overrides.phase_number) ? overrides.phase_number : 0,
    epic_id: typeof overrides.epic_id === "string" ? overrides.epic_id : "",
    approved_gates: {
      ...DEFAULT_APPROVED_GATES,
      ...approvedGates,
    },
    active_beads: normalizeStringArray(overrides.active_beads),
    active_workers: normalizeActiveWorkers(overrides.active_workers),
    blockers: normalizeStringArray(overrides.blockers),
    focus: normalizeOptionalString(overrides.focus),
    summary: normalizeOptionalString(overrides.summary),
    next_action: normalizeOptionalString(overrides.next_action),
    deferred_beads: normalizeStringArray(overrides.deferred_beads),
    last_compounding_run: normalizeLastCompoundingRun(overrides.last_compounding_run),
    last_updated:
      typeof overrides.last_updated === "string" && overrides.last_updated
        ? overrides.last_updated
        : utcNow(),
  };

  return state;
}

export function normalizeKhuymState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return buildDefaultState();
  }

  return buildDefaultState(state);
}

export function getKhuymStatePaths(repoRoot) {
  return {
    onboarding: path.join(repoRoot, ".khuym", "onboarding.json"),
    stateJson: path.join(repoRoot, ".khuym", "state.json"),
    handoff: path.join(repoRoot, ".khuym", "HANDOFF.json"),
    config: path.join(repoRoot, ".khuym", "config.json"),
    agents: path.join(repoRoot, "AGENTS.md"),
    criticalPatterns: path.join(repoRoot, "history", "learnings", "critical-patterns.md"),
  };
}

export function readKhuymState(repoRoot) {
  const paths = getKhuymStatePaths(repoRoot);
  return normalizeKhuymState(readJsonIfExists(paths.stateJson));
}

export function writeKhuymState(repoRoot, nextState) {
  const paths = getKhuymStatePaths(repoRoot);
  const normalized = normalizeKhuymState(nextState);
  ensureParent(paths.stateJson);
  fs.writeFileSync(paths.stateJson, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function deriveFeatureSlug(status) {
  return status.state_json.feature_slug || status.handoff.feature || "";
}

function buildNextReads(status) {
  const reads = ["AGENTS.md"];

  if (status.handoff.exists) {
    reads.push(".khuym/HANDOFF.json");
  }

  if (status.state_json.exists) {
    reads.push(".khuym/state.json");
  }

  const featureSlug = deriveFeatureSlug(status);
  if (featureSlug) {
    reads.push(`history/${featureSlug}/CONTEXT.md`);
  }

  if (status.critical_patterns_exists) {
    reads.push("history/learnings/critical-patterns.md");
  }

  return reads;
}

function buildRecommendedActions(status) {
  if (!status.onboarding.exists) {
    return [
      "Run Khuym onboarding before continuing.",
      "Use the plugin onboarding script in plugins/khuym/skills/using-khuym/scripts/.",
    ];
  }

  if (status.handoff.exists) {
    return [
      "Surface the saved handoff to the user before resuming.",
      "Read the saved handoff, then reopen the active feature context.",
    ];
  }

  if (status.gkg_readiness?.supported_repo) {
    if (!status.gkg_readiness.server_reachable || !status.gkg_readiness.project_indexed) {
      return [
        status.gkg_readiness.recommended_action,
        "Use gkg MCP tools as the default discovery path once readiness is green.",
      ];
    }
  } else if (status.gkg_readiness?.coverage === "none") {
    return [
      status.gkg_readiness.recommended_action,
      "Continue with grep/file inspection because this repo is outside gkg's supported language set.",
    ];
  }

  const activeSkill = status.state_json.active_skill || "";
  const phase = status.state_json.phase || "";
  if (activeSkill || (phase && phase !== "idle")) {
    return [
      `Resume by reopening the active context for ${activeSkill || "the current skill"}.`,
      "Read the active feature CONTEXT.md before planning or execution work.",
    ];
  }

  return [
    "Use this status snapshot to choose the next Khuym skill.",
    "If you move into planning or execution, read critical-patterns.md first when it exists.",
  ];
}

export function readKhuymStatus(repoRoot) {
  const paths = getKhuymStatePaths(repoRoot);
  const onboarding = readJsonIfExists(paths.onboarding);
  const stateJson = readJsonIfExists(paths.stateJson);
  const handoff = readJsonIfExists(paths.handoff);
  const dependencyHealth = readDependencyHealth(repoRoot);
  const gkgReadiness = readGkgReadiness(repoRoot);

  const status = {
    repo_root: repoRoot,
    onboarding: {
      exists: Boolean(onboarding),
      status: onboarding?.status || "",
      plugin_version: onboarding?.plugin_version || "",
    },
    state_json: {
      exists: Boolean(stateJson),
      ...normalizeKhuymState(stateJson),
    },
    handoff: {
      exists: Boolean(handoff),
      feature: typeof handoff?.feature === "string" ? handoff.feature : "",
      skill: typeof handoff?.skill === "string" ? handoff.skill : "",
      phase: typeof handoff?.phase === "string" ? handoff.phase : "",
      next_action: typeof handoff?.next_action === "string" ? handoff.next_action : "",
      context_pct:
        typeof handoff?.context_pct === "number"
          ? handoff.context_pct
          : typeof handoff?.context_pct === "string"
            ? handoff.context_pct
            : "",
    },
    dependency_health: dependencyHealth,
    gkg_readiness: gkgReadiness,
    critical_patterns_exists: fs.existsSync(paths.criticalPatterns),
    next_reads: [],
    recommended_actions: [],
  };

  status.next_reads = buildNextReads(status);
  status.recommended_actions = buildRecommendedActions(status);

  return status;
}

function formatDependencyTarget(target) {
  if (Array.isArray(target)) {
    return target.filter(Boolean).join(", ");
  }
  return String(target || "");
}

function formatDependencyImpact(missingDependency) {
  const requiredBy = Array.isArray(missingDependency.required_by)
    ? missingDependency.required_by.join(", ")
    : "(unknown skills)";
  const effects = Array.isArray(missingDependency.missing_effects)
    ? missingDependency.missing_effects.join(", ")
    : "degraded";
  return `Affects: ${requiredBy}. Reported status impact: ${effects}.`;
}

function renderDependencyHealthLines(status) {
  const dependencyHealth =
    status.dependency_health && typeof status.dependency_health === "object"
      ? status.dependency_health
      : null;
  const summary = dependencyHealth?.summary || {};
  const missingDependencies = Array.isArray(dependencyHealth?.missing_dependencies)
    ? dependencyHealth.missing_dependencies
    : [];
  const uncoveredSkills = Array.isArray(dependencyHealth?.uncovered_skills)
    ? dependencyHealth.uncovered_skills
    : [];

  const lines = [
    "Dependency health:",
    `- Packaged skill coverage: ${summary.skills_total || 0} total (${summary.skills_with_declared_dependencies || 0} with declared dependencies, ${summary.skills_dependency_free || 0} dependency-free, ${summary.skills_uncovered || 0} uncovered)`,
    `- Availability among covered skills: ${summary.skills_available || 0} available, ${summary.skills_degraded || 0} degraded, ${summary.skills_unavailable || 0} unavailable`,
    `- Declared dependencies: ${summary.declared_dependencies || 0}`,
    `- Missing declared dependencies: ${summary.missing_dependencies || 0}`,
  ];

  lines.push("- Uncovered packaged skills:");
  if (uncoveredSkills.length === 0) {
    lines.push("  - none");
  } else {
    for (const skill of uncoveredSkills) {
      lines.push(`  - ${skill.skill_name} (${skill.skill_file})`);
    }
  }

  if (missingDependencies.length === 0) {
    lines.push("- Missing commands: none");
    lines.push("- Missing MCP server configuration: none");
    return lines;
  }

  const missingCommands = missingDependencies.filter((dependency) => dependency.kind === "command");
  const missingMcpServers = missingDependencies.filter(
    (dependency) => dependency.kind === "mcp_server",
  );

  lines.push("- Missing commands:");
  if (missingCommands.length === 0) {
    lines.push("  - none");
  } else {
    for (const dependency of missingCommands) {
      lines.push(
        `  - ${formatDependencyTarget(dependency.target)}. ${formatDependencyImpact(dependency)}`,
      );
    }
  }

  lines.push("- Missing MCP server configuration:");
  if (missingMcpServers.length === 0) {
    lines.push("  - none");
  } else {
    for (const dependency of missingMcpServers) {
      lines.push(
        `  - ${formatDependencyTarget(dependency.target)}. ${formatDependencyImpact(dependency)}`,
      );
    }
  }

  return lines;
}

function renderGkgReadinessLines(status) {
  const readiness = status.gkg_readiness && typeof status.gkg_readiness === "object"
    ? status.gkg_readiness
    : null;
  if (!readiness) {
    return [];
  }

  const supportedLanguages =
    Array.isArray(readiness.supported_languages) && readiness.supported_languages.length > 0
      ? readiness.supported_languages.join(", ")
      : "none";
  const serverStatus = readiness.server_reachable
    ? `reachable${readiness.server_version ? ` (${readiness.server_version})` : ""}`
    : "unreachable";

  return [
    "gkg readiness:",
    `- Supported repo: ${readiness.supported_repo ? "yes" : "no"}`,
    `- Supported languages: ${supportedLanguages}`,
    `- Primary supported language: ${readiness.primary_supported_language || "n/a"}`,
    `- Coverage: ${readiness.coverage || "unknown"}`,
    `- Server: ${serverStatus}`,
    `- Project indexed: ${readiness.project_indexed ? "yes" : "no"}`,
    `- Recommended action: ${readiness.recommended_action || "n/a"}`,
  ];
}

export function renderKhuymStatus(status) {
  const feature = deriveFeatureSlug(status) || "(none)";
  const skill = status.state_json.active_skill || "(none)";
  const phase = status.state_json.phase || "(none)";
  const mode = status.state_json.mode || "(unspecified)";
  const epicId = status.state_json.epic_id || "(none)";
  const handoff = status.handoff.exists ? "present" : "absent";
  const onboarding = status.onboarding.exists
    ? `${status.onboarding.status || "installed"}${status.onboarding.plugin_version ? ` (${status.onboarding.plugin_version})` : ""}`
    : "missing";
  const focus = status.state_json.focus || "(none)";
  const nextAction = status.state_json.next_action || "(none)";

  return [
    "Khuym Status",
    `Repo: ${status.repo_root}`,
    `Onboarding: ${onboarding}`,
    `Feature: ${feature}`,
    `Mode: ${mode}`,
    `Skill: ${skill}`,
    `Phase: ${phase}`,
    `Epic: ${epicId}`,
    `Focus: ${focus}`,
    `Next action: ${nextAction}`,
    `Handoff: ${handoff}`,
    "",
    ...renderGkgReadinessLines(status),
    "",
    ...renderDependencyHealthLines(status),
    "",
    "Next reads:",
    ...status.next_reads.map((item) => `- ${item}`),
    "",
    "Recommended actions:",
    ...status.recommended_actions.map((item) => `- ${item}`),
  ].join("\n");
}
