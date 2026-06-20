import * as fs from "node:fs";
import * as path from "node:path";
import type { ConductConfig } from "./schemas.js";
import { DEFAULT_CONFIG } from "./schemas.js";

// --- Config Loading (§4) ---

export function findConfigFile(cwd: string): string | null {
  const candidates = [
    path.join(cwd, ".pi", "conduct", "config.json"),
    path.join(cwd, "conduct.config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface LoadConfigResult {
  config: ConductConfig;
  warnings: string[];
  configPath: string | null;
}

export function loadConfig(cwd: string): LoadConfigResult {
  const configPath = findConfigFile(cwd);
  const warnings: string[] = [];

  if (!configPath) {
    warnings.push("No config file found. Using safe defaults.");
    warnings.push("  See .pi/conduct/config.json or conduct.config.json");
    return { config: structuredClone(DEFAULT_CONFIG), warnings, configPath: null };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ConductConfig>;
    const config = mergeConfig(DEFAULT_CONFIG, parsed);
    const validationWarnings = validateConfig(config);
    return { config, warnings: [...warnings, ...validationWarnings], configPath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to parse config at ${configPath}: ${message}`);
    return { config: structuredClone(DEFAULT_CONFIG), warnings, configPath };
  }
}

function mergeConfig(base: ConductConfig, override: Partial<ConductConfig>): ConductConfig {
  return {
    models: {
      planner: { ...base.models.planner, ...(override.models?.planner ?? {}) },
      coder: { ...base.models.coder, ...(override.models?.coder ?? {}) },
      reviewer: { ...base.models.reviewer, ...(override.models?.reviewer ?? {}) },
    },
    loop: { ...base.loop, ...(override.loop ?? {}) },
    safety: { ...base.safety, ...(override.safety ?? {}) },
    commands: {
      format: override.commands?.format ?? base.commands.format,
      lint: override.commands?.lint ?? base.commands.lint,
      test: override.commands?.test ?? base.commands.test,
    },
    artifacts: { ...base.artifacts, ...(override.artifacts ?? {}) },
  };
}

/**
 * Validate config (§4.2). Rejects by clamping/fixing where possible and warns.
 * Returns warnings; the caller decides whether to proceed.
 */
function validateConfig(config: ConductConfig): string[] {
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

  // §4.2.4: Invalid artifact root
  if (!config.artifacts.root || config.artifacts.root.trim() === "") {
    warnings.push("WARNING: Invalid artifact root, using default .pi/conduct/runs");
    config.artifacts.root = ".pi/conduct/runs";
  }

  return warnings;
}

export { DEFAULT_CONFIG };
