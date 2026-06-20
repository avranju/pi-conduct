import * as fs from "node:fs";
import * as path from "node:path";
import type { ConductConfig, ImplementationPlan, CoderCompliance, ReviewResult, CheckGroup } from "./schemas.js";

// ============================================================================
// Artifact Storage
// ============================================================================

export interface RunDirectory {
  root: string;
  userPromptPath: string;
  configPath: string;
  planRawPath: string;
  planJsonPath: string;
  planValidationPath: string;
  iterationPaths: Map<number, string>;
  finalSummaryPath: string;
}

export function createRunDirectory(
  artifactRoot: string,
  runId: string,
): { dir: RunDirectory; root: string } {
  const root = path.join(artifactRoot, runId);
  fs.mkdirSync(root, { recursive: true });

  // Create subdirectories
  fs.mkdirSync(path.join(root, "iterations"), { recursive: true });

  const iterationPaths = new Map<number, string>();

  return {
    dir: {
      root,
      userPromptPath: path.join(root, "user-prompt.md"),
      configPath: path.join(root, "config.resolved.json"),
      planRawPath: path.join(root, "plan.raw.md"),
      planJsonPath: path.join(root, "plan.json"),
      planValidationPath: path.join(root, "plan.validation.json"),
      iterationPaths,
      finalSummaryPath: path.join(root, "final-summary.md"),
    },
    root,
  };
}

export function saveUserPrompt(dir: RunDirectory, prompt: string): void {
  fs.writeFileSync(dir.userPromptPath, prompt, "utf-8");
}

export function saveConfig(dir: RunDirectory, config: ConductConfig): void {
  fs.writeFileSync(dir.configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function savePlanRaw(dir: RunDirectory, rawText: string): void {
  fs.writeFileSync(dir.planRawPath, rawText, "utf-8");
}

export function savePlanJson(dir: RunDirectory, plan: ImplementationPlan): void {
  fs.writeFileSync(dir.planJsonPath, JSON.stringify(plan, null, 2), "utf-8");
}

export function savePlanValidation(
  dir: RunDirectory,
  valid: boolean,
  errors?: string[],
): void {
  const validation = { valid, errors: errors || [], timestamp: new Date().toISOString() };
  fs.writeFileSync(dir.planValidationPath, JSON.stringify(validation, null, 2), "utf-8");
}

export function getIterationDir(dir: RunDirectory, iteration: number): string {
  if (!dir.iterationPaths.has(iteration)) {
    const iterDir = path.join(dir.root, "iterations", String(iteration));
    fs.mkdirSync(iterDir, { recursive: true });
    dir.iterationPaths.set(iteration, iterDir);
  }
  return dir.iterationPaths.get(iteration)!;
}

export function saveCoderArtifacts(
  iterationDir: string,
  coderResponse: string,
  compliance: CoderCompliance,
): void {
  fs.writeFileSync(path.join(iterationDir, "coder-response.md"), coderResponse, "utf-8");
  fs.writeFileSync(
    path.join(iterationDir, "coder-compliance.json"),
    JSON.stringify(compliance, null, 2),
    "utf-8",
  );
}

export function saveGitDiff(
  iterationDir: string,
  diff: string,
  stat: string,
): void {
  fs.writeFileSync(path.join(iterationDir, "git-diff.patch"), diff, "utf-8");
  fs.writeFileSync(path.join(iterationDir, "git-diff-stat.txt"), stat, "utf-8");
}

export function saveCheckResults(
  iterationDir: string,
  groups: CheckGroup[],
): void {
  const checksDir = path.join(iterationDir, "checks");
  fs.mkdirSync(checksDir, { recursive: true });

  for (const group of groups) {
    for (const result of group.results) {
      const safeName = result.command.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
      const filePath = path.join(checksDir, `${group.groupName}-${safeName}.txt`);
      const content = [
        `Command: ${result.command}`,
        `Exit Code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        ``,
        `--- stdout ---`,
        result.stdout || "(empty)",
        ``,
        `--- stderr ---`,
        result.stderr || "(empty)",
      ].join("\n");
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }
}

export function saveReviewerArtifacts(
  iterationDir: string,
  reviewResponse: string,
  reviewResult: ReviewResult,
): void {
  fs.writeFileSync(
    path.join(iterationDir, "review-response.md"),
    reviewResponse,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(iterationDir, "review.json"),
    JSON.stringify(reviewResult, null, 2),
    "utf-8",
  );
}

export function saveFinalSummary(dir: RunDirectory, summary: string): void {
  fs.writeFileSync(dir.finalSummaryPath, summary, "utf-8");
}

export function listRunDirectories(artifactRoot: string): string[] {
  if (!fs.existsSync(artifactRoot)) return [];
  return fs
    .readdirSync(artifactRoot)
    .filter((entry) => {
      const stat = fs.statSync(path.join(artifactRoot, entry));
      return stat.isDirectory();
    })
    .sort()
    .reverse(); // Most recent first
}
