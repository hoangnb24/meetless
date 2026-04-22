import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return [];
  }
  return body
    .split(",")
    .map((item) => parseScalar(item))
    .filter(Boolean);
}

function formatPluginSkillName(skillName) {
  if (!skillName) {
    return skillName;
  }
  return skillName.includes(":") ? skillName : `khuym:${skillName}`;
}

function parseSkillMetadata(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  let inMetadata = false;
  let inDependencies = false;
  let dependenciesDeclared = false;
  const metadata = {};
  const dependencies = [];
  let current = null;

  for (const line of lines) {
    if (!inMetadata) {
      if (/^metadata:\s*$/.test(line)) {
        inMetadata = true;
      }
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    if (/^[^\s]/.test(line)) {
      break;
    }

    const metadataFieldMatch = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (metadataFieldMatch) {
      const [, key, rawValue] = metadataFieldMatch;
      if (key === "dependencies") {
        dependenciesDeclared = true;
        const inlineList = parseInlineList(rawValue);
        if (inlineList !== null) {
          metadata.dependencies = inlineList;
          inDependencies = false;
          current = null;
          continue;
        }

        if (!rawValue.trim()) {
          metadata.dependencies = dependencies;
          inDependencies = true;
          current = null;
          continue;
        }
      }

      if (inDependencies) {
        inDependencies = false;
        current = null;
      }

      const inlineList = parseInlineList(rawValue);
      metadata[key] = inlineList ?? parseScalar(rawValue);
      continue;
    }

    if (!inDependencies) {
      continue;
    }

    const entryMatch = line.match(/^\s{4}-\s+id:\s*(.+)$/);
    if (entryMatch) {
      current = { id: parseScalar(entryMatch[1]) };
      dependencies.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const fieldMatch = line.match(/^\s{6}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }

    const [, key, rawValue] = fieldMatch;
    const inlineList = parseInlineList(rawValue);
    current[key] = inlineList ?? parseScalar(rawValue);
  }

  return {
    metadata,
    dependencies,
    dependencies_declared: dependenciesDeclared,
  };
}

function parseSkillFile(skillFilePath) {
  const source = fs.readFileSync(skillFilePath, "utf8");
  const frontmatterMatch = source.match(FRONTMATTER_PATTERN);
  if (!frontmatterMatch) {
    return {
      skill_name: path.basename(path.dirname(skillFilePath)),
      skill_file: skillFilePath,
      metadata: {},
      dependencies: [],
      dependencies_declared: false,
    };
  }

  const frontmatter = frontmatterMatch[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const skillName = nameMatch ? parseScalar(nameMatch[1]) : path.basename(path.dirname(skillFilePath));
  const parsedMetadata = parseSkillMetadata(frontmatter);

  return {
    skill_name: formatPluginSkillName(skillName),
    skill_file: skillFilePath,
    metadata: parsedMetadata.metadata,
    dependencies: parsedMetadata.dependencies_declared
      ? parsedMetadata.metadata.dependencies || []
      : [],
    dependencies_declared: parsedMetadata.dependencies_declared,
  };
}

function listSkillDeclarationFiles(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
    .filter((filePath) => fs.existsSync(filePath));
}

function canExecute(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultCommandProbe(command, envPath = process.env.PATH || "") {
  for (const segment of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(segment, command);
    if (fs.existsSync(candidate) && canExecute(candidate)) {
      return {
        available: true,
        detail: candidate,
      };
    }
  }

  return {
    available: false,
    detail: `Missing from PATH for command '${command}'`,
  };
}

function parseMcpServerNamesFromToml(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const source = fs.readFileSync(filePath, "utf8");
  const names = new Set();
  const patterns = [
    /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm,
    /^\s*\[mcp\.servers\.([^\]]+)\]\s*$/gm,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      names.add(parseScalar(match[1]));
    }
  }

  return [...names];
}

function parseMcpServerNamesFromJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }
    const manifest =
      payload.mcpServers && typeof payload.mcpServers === "object" && !Array.isArray(payload.mcpServers)
        ? payload.mcpServers
        : payload;
    return Object.keys(manifest);
  } catch {
    return [];
  }
}

function resolvePluginMcpManifestPath(pluginRoot) {
  const pluginManifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(pluginManifestPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
    const manifestPath = typeof payload?.mcpServers === "string" ? payload.mcpServers.trim() : "";
    if (!manifestPath) {
      return null;
    }
    return path.resolve(pluginRoot, manifestPath);
  } catch {
    return null;
  }
}

function collectMcpSources({ repoRoot, skillsRoot, globalCodexConfigPath }) {
  const sources = [];
  const repoCodexConfigPath = path.join(repoRoot, ".codex", "config.toml");
  const globalConfigPath = globalCodexConfigPath || path.join(os.homedir(), ".codex", "config.toml");
  const pluginRoot = path.resolve(path.join(skillsRoot, ".."));

  sources.push({
    key: "repo_codex_config",
    type: "toml",
    path: repoCodexConfigPath,
    server_names: parseMcpServerNamesFromToml(repoCodexConfigPath),
  });

  sources.push({
    key: "global_codex_config",
    type: "toml",
    path: globalConfigPath,
    server_names: parseMcpServerNamesFromToml(globalConfigPath),
  });

  const pluginMcpManifestPath =
    resolvePluginMcpManifestPath(pluginRoot) || path.join(pluginRoot, ".mcp.json");
  sources.push({
    key: "plugin_mcp_manifest",
    type: "json",
    path: pluginMcpManifestPath,
    server_names: parseMcpServerNamesFromJson(pluginMcpManifestPath),
  });

  return sources;
}

function probeDependency(dependency, context) {
  if (dependency.kind === "command") {
    const command = dependency.command || dependency.id;
    const result = context.commandProbe(command);
    return {
      ...dependency,
      target: command,
      available: result.available,
      probe: {
        kind: "command",
        detail: result.detail,
      },
    };
  }

  if (dependency.kind === "mcp_server") {
    const requestedNames = Array.isArray(dependency.server_names)
      ? dependency.server_names
      : [dependency.server_names].filter(Boolean);
    const requestedSources = Array.isArray(dependency.config_sources)
      ? dependency.config_sources
      : [dependency.config_sources].filter(Boolean);
    const candidateSources =
      requestedSources.length > 0
        ? context.mcpSources.filter((source) => requestedSources.includes(source.key))
        : context.mcpSources;
    const configuredNames = new Set();
    const matchedSources = [];

    for (const source of candidateSources) {
      const sourceNames = source.server_names || [];
      for (const serverName of sourceNames) {
        configuredNames.add(serverName);
      }
      const hasMatch = requestedNames.some((name) => sourceNames.includes(name));
      if (hasMatch) {
        matchedSources.push(source.key);
      }
    }

    const available = requestedNames.length > 0 && requestedNames.some((name) => configuredNames.has(name));
    return {
      ...dependency,
      target: requestedNames,
      available,
      probe: {
        kind: "mcp_server",
        detail: available
          ? `Configured in ${matchedSources.join(", ")}`
          : `Missing from configured MCP sources (${candidateSources.map((source) => source.key).join(", ")})`,
        matched_sources: matchedSources,
        checked_sources: candidateSources.map((source) => source.key),
      },
    };
  }

  return {
    ...dependency,
    target: dependency.id,
    available: false,
    probe: {
      kind: "unknown",
      detail: `Unsupported dependency kind '${dependency.kind || "unknown"}'`,
    },
  };
}

function summarizeSkillStatus(probedDependencies) {
  const missing = probedDependencies.filter((dependency) => !dependency.available);
  if (missing.length === 0) {
    return "available";
  }
  const unavailable = missing.some((dependency) => dependency.missing_effect === "unavailable");
  return unavailable ? "unavailable" : "degraded";
}

function aggregateMissingDependencies(skills) {
  const byKey = new Map();

  for (const skill of skills) {
    for (const dependency of skill.missing_dependencies) {
      const target =
        Array.isArray(dependency.target) && dependency.target.length > 0
          ? dependency.target.join(",")
          : String(dependency.target ?? "");
      const key = `${dependency.id}|${dependency.kind}|${target}`;

      if (!byKey.has(key)) {
        byKey.set(key, {
          id: dependency.id,
          kind: dependency.kind,
          target: dependency.target,
          required_by: [],
          missing_effects: [],
        });
      }

      const aggregate = byKey.get(key);
      aggregate.required_by.push(skill.skill_name);
      if (!aggregate.missing_effects.includes(dependency.missing_effect)) {
        aggregate.missing_effects.push(dependency.missing_effect);
      }
    }
  }

  return [...byKey.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function collectKhuymSkillDependencies(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const skillsRoot = path.resolve(
    options.skillsRoot || path.join(repoRoot, "plugins", "khuym", "skills"),
  );
  const files = listSkillDeclarationFiles(skillsRoot);

  const declarations = [];
  for (const filePath of files) {
    const parsed = parseSkillFile(filePath);
    if (!parsed) {
      continue;
    }

    declarations.push({
      ...parsed,
      skill_file: path.relative(repoRoot, parsed.skill_file),
    });
  }

  return declarations.sort((left, right) => left.skill_name.localeCompare(right.skill_name));
}

function getCoverageStatus(declaration) {
  if (declaration.dependencies_declared && declaration.dependencies.length === 0) {
    return "dependency_free";
  }
  if (declaration.dependencies.length > 0) {
    return "declared_dependencies";
  }
  return "uncovered";
}

export function buildKhuymDependencyReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const skillsRoot = path.resolve(
    options.skillsRoot || path.join(repoRoot, "plugins", "khuym", "skills"),
  );
  const declarations = collectKhuymSkillDependencies({ repoRoot, skillsRoot });
  const commandProbe = options.commandProbe || defaultCommandProbe;
  const mcpSources = collectMcpSources({
    repoRoot,
    skillsRoot,
    globalCodexConfigPath: options.globalCodexConfigPath,
  });

  const skills = declarations.map((declaration) => {
    const coverageStatus = getCoverageStatus(declaration);
    const dependencies = declaration.dependencies.map((dependency) =>
      probeDependency(dependency, {
        commandProbe,
        mcpSources,
      }),
    );
    const status = coverageStatus === "uncovered" ? "uncovered" : summarizeSkillStatus(dependencies);
    const missingDependencies = dependencies.filter((dependency) => !dependency.available);
    return {
      skill_name: declaration.skill_name,
      skill_file: declaration.skill_file,
      coverage_status: coverageStatus,
      status,
      dependencies,
      missing_dependencies: missingDependencies,
    };
  });

  const missingDependencies = aggregateMissingDependencies(skills);
  const uncoveredSkills = skills
    .filter((skill) => skill.coverage_status === "uncovered")
    .map((skill) => ({
      skill_name: skill.skill_name,
      skill_file: skill.skill_file,
    }));
  const summary = {
    skills_total: skills.length,
    skills_covered: skills.filter((skill) => skill.coverage_status !== "uncovered").length,
    skills_with_declared_dependencies: skills.filter(
      (skill) => skill.coverage_status === "declared_dependencies",
    ).length,
    skills_dependency_free: skills.filter((skill) => skill.coverage_status === "dependency_free")
      .length,
    skills_uncovered: uncoveredSkills.length,
    skills_available: skills.filter((skill) => skill.status === "available").length,
    skills_degraded: skills.filter((skill) => skill.status === "degraded").length,
    skills_unavailable: skills.filter((skill) => skill.status === "unavailable").length,
    declared_dependencies: skills.reduce((count, skill) => count + skill.dependencies.length, 0),
    missing_dependencies: missingDependencies.length,
  };

  return {
    checked_at: new Date().toISOString(),
    summary,
    skills,
    uncovered_skills: uncoveredSkills,
    missing_dependencies: missingDependencies,
    mcp_sources: mcpSources.map((source) => ({
      key: source.key,
      type: source.type,
      path: path.relative(repoRoot, source.path),
      server_names: source.server_names,
      exists: fs.existsSync(source.path),
    })),
  };
}
