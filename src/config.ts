import * as fs from "node:fs";
import * as path from "node:path";
import type { ConductConfig } from "./schemas.js";
import { DEFAULT_CONFIG } from "./schemas.js";

// --- Config Loading ---

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

export function loadConfig(cwd: string): { config: ConductConfig; warnings: string[]; configPath: string | null } {
  const configPath = findConfigFile(cwd);
  const warnings: string[] = [];

  if (!configPath) {
    warnings.push("No config file found. Using safe defaults.");
    warnings.push("  See .pi/conduct/config.json or conduct.config.json");
    return { config: { ...DEFAULT_CONFIG }, warnings, configPath: null };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ConductConfig>;
    const config = mergeConfig(DEFAULT_CONFIG, parsed);
    const validationWarnings = validateConfig(config);
    return { config, warnings: [...warnings, ...validationWarnings], configPath };
  } catch (err: any) {
    warnings.push(`Failed to parse config at ${configPath}: ${err.message}`);
    return { config: { ...DEFAULT_CONFIG }, warnings, configPath };
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
    commands: {
      format: override.commands?.format ?? base.commands.format,
      lint: override.commands?.lint ?? base.commands.lint,
      test: override.commands?.test ?? base.commands.test,
    },
    artifacts: { ...base.artifacts, ...(override.artifacts ?? {}) },
  };
}

function validateConfig(config: ConductConfig): string[] {
  const warnings: string[] = [];

  if (!config.models.planner.provider || !config.models.planner.model) {
    warnings.push("WARNING: Missing planner model config");
  }
  if (!config.models.coder.provider || !config.models.coder.model) {
    warnings.push("WARNING: Missing coder model config");
  }
  if (!config.models.reviewer.provider || !config.models.reviewer.model) {
    warnings.push("WARNING: Missing reviewer model config");
  }
  if (config.loop.maxIterations < 1) {
    warnings.push("WARNING: maxIterations < 1, defaulting to 1");
  }
  if (config.loop.requirePassingChecks && config.commands.test.length === 0) {
    warnings.push("WARNING: requirePassingChecks is true but no test commands configured");
  }
  if (config.loop.requirePassingChecks && config.commands.lint.length === 0) {
    warnings.push("WARNING: requirePassingChecks is true but no lint commands configured");
  }

  return warnings;
}

export { DEFAULT_CONFIG };
