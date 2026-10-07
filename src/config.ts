import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConductConfig } from "./schemas.js";
import { DEFAULT_CONFIG, DEFAULT_LIVE_OUTPUT_KEYBINDING } from "./schemas.js";
import { normalizeKeybindingList } from "./keybindings.js";

// --- Config Loading (§4) ---

export function findConfigFiles(cwd: string, agentDir = getAgentDir(), projectTrusted = true): string[] {
  return [
    path.join(agentDir, "conduct", "config.json"),
    ...(projectTrusted ? [path.join(cwd, ".pi", "conduct", "config.json")] : []),
  ].filter((candidate) => fs.existsSync(candidate));
}

export interface LoadConfigResult {
  config: ConductConfig;
  warnings: string[];
  configPaths: string[];
}

export function loadConfig(cwd: string, agentDir = getAgentDir(), projectTrusted = true): LoadConfigResult {
  const configPaths = findConfigFiles(cwd, agentDir, projectTrusted);
  const warnings: string[] = [];
  if (!projectTrusted && fs.existsSync(path.join(cwd, ".pi", "conduct", "config.json"))) {
    warnings.push("Ignoring project Conduct config until the repository is trusted by Pi");
  }
  let config = structuredClone(DEFAULT_CONFIG);

  if (configPaths.length === 0) {
    warnings.push("No config file found. Using safe defaults.");
    warnings.push(`  See ${path.join(agentDir, "conduct", "config.json")}`);
    warnings.push("  Or <repo>/.pi/conduct/config.json");
    return { config, warnings: [...warnings, ...validateConfig(config)], configPaths };
  }

  // Apply the global config first, then layer the repository config over it.
  for (const configPath of configPaths) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ConductConfig>;
      config = mergeConfig(config, parsed);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to parse config at ${configPath}: ${message}`);
    }
  }

  return { config, warnings: [...warnings, ...validateConfig(config)], configPaths };
}

export function mergeConfig(base: ConductConfig, override: Partial<ConductConfig>): ConductConfig {
  return {
    models: {
      planner: mergeModel(base.models.planner, override.models?.planner),
      coder: mergeModel(base.models.coder, override.models?.coder),
      reviewer: mergeModel(base.models.reviewer, override.models?.reviewer),
    },
    loop: { ...base.loop, ...(override.loop ?? {}) },
    safety: { ...base.safety, ...(override.safety ?? {}) },
    retry: { ...base.retry, ...(override.retry ?? {}) },
    sessions: { ...base.sessions, ...(override.sessions ?? {}) },
    capabilities: {
      codemode: { ...base.capabilities.codemode, ...(override.capabilities?.codemode ?? {}) },
      mcp: {
        ...base.capabilities.mcp,
        ...(override.capabilities?.mcp ?? {}),
        servers: {
          ...base.capabilities.mcp.servers,
          ...(override.capabilities?.mcp?.servers ?? {}),
        },
        tools: {
          ...base.capabilities.mcp.tools,
          ...(override.capabilities?.mcp?.tools ?? {}),
        },
      },
    },
    commands: {
      format: override.commands?.format ?? base.commands.format,
      lint: override.commands?.lint ?? base.commands.lint,
      test: override.commands?.test ?? base.commands.test,
    },
    artifacts: { ...base.artifacts, ...(override.artifacts ?? {}) },
    keybindings: { ...base.keybindings, ...(override.keybindings ?? {}) },
  };
}

/**
 * Validate config (§4.2). Rejects by clamping/fixing where possible and warns.
 * Returns warnings; the caller decides whether to proceed.
 */
export function validateConfig(config: ConductConfig): string[] {
  const warnings: string[] = [];

  // §4.2.1: Missing role model config
  if (!config.models.planner.provider || !config.models.planner.model) {
    warnings.push("WARNING: Missing planner model config (provider/model)");
  }
  if (!config.models.coder.provider || !config.models.coder.model) {
    warnings.push("WARNING: Missing coder model config (provider/model)");
  }
  if (!config.models.reviewer.provider || !config.models.reviewer.model) {
    warnings.push("WARNING: Missing reviewer model config (provider/model)");
  }

  for (const role of ["planner", "coder", "reviewer"] as const) {
    const model = config.models[role];
    if (!THINKING_LEVELS.has(model.thinkingLevel)) {
      warnings.push(`WARNING: Invalid ${role} thinking level, using medium`);
      model.thinkingLevel = "medium";
    }
    for (const target of ["continuation", "fallback"] as const) {
      const selection = model.routing?.[target];
      if (selection && (!selection.provider || !selection.model || !THINKING_LEVELS.has(selection.thinkingLevel))) {
        warnings.push(`WARNING: Invalid ${role} routing.${target}, disabling it`);
        delete model.routing![target];
      }
    }
    const allowed = config.capabilities.mcp.tools[role];
    if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== "string" || !/^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(name))) {
      warnings.push(`WARNING: Invalid MCP tool allowlist for ${role}, disabling its MCP access`);
      config.capabilities.mcp.tools[role] = [];
    }
  }
  const codemode = config.capabilities.codemode;
  codemode.enabled = codemode.enabled === true;
  if (codemode.mode !== "on" && codemode.mode !== "only") codemode.mode = "on";
  if (!Number.isSafeInteger(codemode.inlineBudget) || codemode.inlineBudget < 0) codemode.inlineBudget = 3000;
  config.capabilities.mcp.enabled = config.capabilities.mcp.enabled === true;
  if (!config.capabilities.mcp.servers || typeof config.capabilities.mcp.servers !== "object" || Array.isArray(config.capabilities.mcp.servers)) {
    warnings.push("WARNING: Invalid MCP servers, disabling MCP access");
    config.capabilities.mcp.servers = {};
    config.capabilities.mcp.enabled = false;
  }
  config.sessions.inheritSettings = config.sessions.inheritSettings === true;
  config.sessions.inheritProviders = config.sessions.inheritProviders === true;

  // §4.2.2: maxIterations < 1 — clamp to 1
  if (config.loop.maxIterations < 1) {
    warnings.push(`WARNING: maxIterations ${config.loop.maxIterations} < 1, clamping to 1`);
    config.loop.maxIterations = 1;
  }

  // §4.2.3: Empty test/lint/format commands when requirePassingChecks is true
  if (config.loop.requirePassingChecks) {
    if (config.commands.format.length === 0) {
      warnings.push("WARNING: requirePassingChecks is true but no format commands configured");
    }
    if (config.commands.lint.length === 0) {
      warnings.push("WARNING: requirePassingChecks is true but no lint commands configured");
    }
    if (config.commands.test.length === 0) {
      warnings.push("WARNING: requirePassingChecks is true but no test commands configured");
    }
  }

  const rawKeybindings = (config as { keybindings?: { liveOutput?: unknown } }).keybindings;
  if (!rawKeybindings || typeof rawKeybindings !== "object") {
    warnings.push("WARNING: Missing keybindings config, using platform default live output shortcut");
    config.keybindings = { liveOutput: [DEFAULT_LIVE_OUTPUT_KEYBINDING] };
  } else {
    const liveOutput = normalizeKeybindingList(rawKeybindings.liveOutput);
    if (liveOutput.length === 0) {
      warnings.push(
        `WARNING: keybindings.liveOutput is empty or invalid, using ${DEFAULT_LIVE_OUTPUT_KEYBINDING}`,
      );
      config.keybindings.liveOutput = [DEFAULT_LIVE_OUTPUT_KEYBINDING];
    } else {
      config.keybindings.liveOutput = liveOutput;
    }
  }

  // §4.2.4: Invalid artifact root. Keep MVP artifacts inside the repo.
  if (
    !config.artifacts.root ||
    config.artifacts.root.trim() === "" ||
    path.isAbsolute(config.artifacts.root) ||
    config.artifacts.root.split(/[\\/]+/).includes("..")
  ) {
    warnings.push("WARNING: Invalid artifact root, using default .pi/conduct/runs");
    config.artifacts.root = ".pi/conduct/runs";
  }

  // Transient retry config (§16.5): clamp obviously bad values.
  const retry = config.retry;
  if (retry.maxRetries < 0) {
    warnings.push(`WARNING: retry.maxRetries ${retry.maxRetries} < 0, clamping to 0`);
    retry.maxRetries = 0;
  }
  if (retry.baseDelayMs < 0) {
    warnings.push(`WARNING: retry.baseDelayMs ${retry.baseDelayMs} < 0, clamping to 0`);
    retry.baseDelayMs = 0;
  }
  if (retry.maxDelayMs < 0) {
    warnings.push(`WARNING: retry.maxDelayMs ${retry.maxDelayMs} < 0, clamping to 0`);
    retry.maxDelayMs = 0;
  }
  if (retry.maxDelayMs < retry.baseDelayMs && retry.maxDelayMs > 0) {
    warnings.push(
      `WARNING: retry.maxDelayMs ${retry.maxDelayMs} < retry.baseDelayMs ${retry.baseDelayMs}, raising maxDelayMs`,
    );
    retry.maxDelayMs = retry.baseDelayMs;
  }
  if (retry.timeoutMs < 0) {
    warnings.push(`WARNING: retry.timeoutMs ${retry.timeoutMs} < 0, clamping to 0`);
    retry.timeoutMs = 0;
  }
  // Drop user patterns that are not valid regex; keep the rest.
  const validPatterns: string[] = [];
  for (const pattern of retry.retryableErrorPatterns) {
    try {
      new RegExp(pattern, "i");
      validPatterns.push(pattern);
    } catch {
      warnings.push(`WARNING: retry.retryableErrorPatterns entry is not valid regex and was dropped: ${pattern}`);
    }
  }
  retry.retryableErrorPatterns = validPatterns;

  return warnings;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function mergeModel(base: ConductConfig["models"]["planner"], override?: ConductConfig["models"]["planner"]): ConductConfig["models"]["planner"] {
  return {
    ...base,
    ...override,
    routing: override?.routing === undefined
      ? base.routing
      : { ...base.routing, ...override.routing },
  };
}

export { DEFAULT_CONFIG };
