import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConductConfig,
  ImplementationPlan,
  CoderCompliance,
  ReviewResult,
  CheckGroup,
  RunState,
} from "./schemas.js";

// ============================================================================
// Artifact Storage (§7)
// ============================================================================

export interface RunDirectory {
  root: string;
  userPromptPath: string;
  configPath: string;
  statePath: string;
  plannerPromptPath: string;
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
  fs.mkdirSync(path.join(root, "iterations"), { recursive: true });

  return {
    dir: {
      root,
      userPromptPath: path.join(root, "user-prompt.md"),
      configPath: path.join(root, "config.resolved.json"),
      statePath: path.join(root, "state.json"),
      plannerPromptPath: path.join(root, "planner-prompt.md"),
      planRawPath: path.join(root, "plan.raw.md"),
      planJsonPath: path.join(root, "plan.json"),
      planValidationPath: path.join(root, "plan.validation.json"),
      iterationPaths: new Map<number, string>(),
      finalSummaryPath: path.join(root, "final-summary.md"),
    },
    root,
  };
}

function writeText(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function saveUserPrompt(dir: RunDirectory, prompt: string): void {
  writeText(dir.userPromptPath, prompt);
}

export function saveConfig(dir: RunDirectory, config: ConductConfig): void {
  writeJson(dir.configPath, config);
}

export function saveState(dir: RunDirectory, state: RunState): void {
  writeJson(dir.statePath, state);
}

export function savePlannerPrompt(dir: RunDirectory, prompt: string): void {
  writeText(dir.plannerPromptPath, prompt);
}

export function savePlanRaw(dir: RunDirectory, rawText: string): void {
  writeText(dir.planRawPath, rawText);
}

export function savePlanJson(dir: RunDirectory, plan: ImplementationPlan): void {
  writeJson(dir.planJsonPath, plan);
}

export function savePlanValidation(
  dir: RunDirectory,
  valid: boolean,
  errors?: string[],
): void {
  writeJson(dir.planValidationPath, {
    valid,
    errors: errors || [],
    timestamp: new Date().toISOString(),
  });
}

export function saveTranscript(
  dir: RunDirectory | undefined,
  filePath: string,
  transcript: string,
  keep: boolean,
): void {
  if (!dir || !keep) return;
  writeText(filePath, transcript);
}

export function getIterationDir(dir: RunDirectory, iteration: number): string {
  let iterDir = dir.iterationPaths.get(iteration);
  if (!iterDir) {
    iterDir = path.join(dir.root, "iterations", String(iteration));
    fs.mkdirSync(iterDir, { recursive: true });
    dir.iterationPaths.set(iteration, iterDir);
  }
  return iterDir;
}

export function saveCoderPrompt(iterationDir: string, prompt: string): void {
  writeText(path.join(iterationDir, "coder-prompt.md"), prompt);
}

export function saveCoderArtifacts(
  iterationDir: string,
  coderResponse: string,
  compliance: CoderCompliance,
): void {
  writeText(path.join(iterationDir, "coder-response.md"), coderResponse);
  writeJson(path.join(iterationDir, "coder-compliance.json"), compliance);
}

export function saveGitDiff(
  iterationDir: string,
  diff: string,
  stat: string,
): void {
  writeText(path.join(iterationDir, "git-diff.patch"), diff);
  writeText(path.join(iterationDir, "git-diff-stat.txt"), stat);
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
      writeText(filePath, content);
    }
  }
}

export function saveReviewerPrompt(iterationDir: string, prompt: string): void {
  writeText(path.join(iterationDir, "review-prompt.md"), prompt);
}

export function saveReviewerArtifacts(
  iterationDir: string,
  reviewResponse: string,
  reviewResult: ReviewResult,
): void {
  writeText(path.join(iterationDir, "review-response.md"), reviewResponse);
  writeJson(path.join(iterationDir, "review.json"), reviewResult);
}

export function saveFinalSummary(dir: RunDirectory, summary: string): void {
  writeText(dir.finalSummaryPath, summary);
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
