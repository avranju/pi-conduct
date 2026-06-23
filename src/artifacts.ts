import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
  let root = path.join(artifactRoot, runId);
  for (let suffix = 2; fs.existsSync(root); suffix++) {
    root = path.join(artifactRoot, `${runId}-${suffix}`);
  }
  fs.mkdirSync(root, { recursive: true });

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

export function openRunDirectory(root: string): RunDirectory {
  return {
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
  };
}

function writeText(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeJson(filePath: string, data: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(temporaryPath, filePath);
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
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
    iterDir = path.join(dir.root, `iteration-${iteration}`);
    fs.mkdirSync(iterDir, { recursive: true });
    dir.iterationPaths.set(iteration, iterDir);
  }
  return iterDir;
}

export function getIterationAttemptDir(
  dir: RunDirectory,
  iteration: number,
  attempt: number,
): string {
  const iterationDir = getIterationDir(dir, iteration);
  if (attempt <= 1) return iterationDir;
  const attemptDir = path.join(iterationDir, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  return attemptDir;
}

export function findLatestIterationFile(
  dir: RunDirectory,
  iteration: number,
  filename: string,
): string | undefined {
  const iterationDir = path.join(dir.root, `iteration-${iteration}`);
  const candidates: Array<{ attempt: number; filePath: string }> = [];
  const original = path.join(iterationDir, filename);
  if (fs.existsSync(original)) candidates.push({ attempt: 1, filePath: original });
  if (fs.existsSync(iterationDir)) {
    for (const entry of fs.readdirSync(iterationDir)) {
      const match = /^attempt-(\d+)$/.exec(entry);
      if (!match) continue;
      const filePath = path.join(iterationDir, entry, filename);
      if (fs.existsSync(filePath)) {
        candidates.push({ attempt: Number(match[1]), filePath });
      }
    }
  }
  candidates.sort((a, b) => b.attempt - a.attempt);
  return candidates[0]?.filePath;
}

export function getActiveRunPid(dir: RunDirectory): number | undefined {
  const lockPath = path.join(dir.root, ".run.lock");
  if (!fs.existsSync(lockPath)) return undefined;
  try {
    const lock = readJson<{ pid?: number }>(lockPath);
    if (!lock.pid) return undefined;
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch {
    return undefined;
  }
}

export function acquireRunLock(dir: RunDirectory): () => void {
  const lockPath = path.join(dir.root, ".run.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2),
        { encoding: "utf-8", flag: "wx" },
      );
      return () => {
        try {
          const lock = readJson<{ token?: string }>(lockPath);
          if (lock.token === token) fs.rmSync(lockPath, { force: true });
        } catch {
          // The lock was already removed or replaced.
        }
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "EEXIST") throw error;
      const activePid = getActiveRunPid(dir);
      if (activePid) throw new Error(`Conduct run is already active (pid ${activePid})`);
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire Conduct run lock");
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
    const groupFile = path.join(checksDir, `${group.groupName}.txt`);
    const sections: string[] = [];

    group.results.forEach((result, index) => {
      result.artifactPath = groupFile;
      sections.push(
        `# ${group.groupName} command ${index + 1}`,
        `Command: ${result.command}`,
        `Exit Code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        ``,
        `--- stdout ---`,
        result.stdout || "(empty)",
        ``,
        `--- stderr ---`,
        result.stderr || "(empty)",
        ``,
      );
    });

    writeText(groupFile, sections.join("\n"));
  }

  // Machine-readable capture of the exact command result shape requested by §9.
  writeJson(path.join(checksDir, "results.json"), groups);
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
