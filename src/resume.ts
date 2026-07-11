import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CheckGroup,
  CoderCompliance,
  ConductConfig,
  ImplementationPlan,
  ReviewResult,
  RunState,
} from "./schemas.js";
import { DEFAULT_CONFIG } from "./schemas.js";
import { mergeConfig } from "./config.js";
import {
  findLatestIterationFile,
  getActiveRunPid,
  openRunDirectory,
  readJson,
  readText,
  saveState,
  type RunDirectory,
} from "./artifacts.js";
import { fingerprintWorkspace, getGitHead, getGitRoot, type Exec } from "./git.js";
import {
  validateCoderCompliance,
  validateImplementationPlan,
  validateReviewResult,
} from "./validation.js";

export interface ResumeWorkflowData {
  state: RunState;
  plan?: ImplementationPlan;
  reviewHistory: ReviewResult[];
  lastChecks: CheckGroup[];
  lastCoderCompliance: CoderCompliance | null;
}

export interface LoadedResumeRun {
  dir: RunDirectory;
  userPrompt: string;
  config: ConductConfig;
  resume: ResumeWorkflowData;
}

export async function loadResumeRun(
  artifactRoot: string,
  runId: string,
  repoRoot: string,
  exec: Exec,
): Promise<LoadedResumeRun> {
  if (!runId || path.basename(runId) !== runId || runId === "." || runId === "..") {
    throw new Error("Invalid Conduct run id");
  }
  const root = path.join(artifactRoot, runId);
  const dir = openRunDirectory(root);
  for (const required of [dir.userPromptPath, dir.configPath, dir.statePath]) {
    if (!fs.existsSync(required)) throw new Error(`Run is missing ${path.basename(required)}`);
  }

  const state = readJson<RunState>(dir.statePath);
  const resumeActions = ["planning", "coder", "checks", "reviewer"];
  const runStages = [
    "planning",
    "validatingPlan",
    "implementing",
    "runningChecks",
    "reviewing",
    "fixing",
  ];
  if (
    state.version !== 1 ||
    !["running", "interrupted", "completed", "failed", "needsUserIntervention"].includes(state.status) ||
    !runStages.includes(state.stage) ||
    !resumeActions.includes(state.resumeAction) ||
    !Number.isInteger(state.iteration) ||
    state.iteration < 0 ||
    !Number.isInteger(state.attempt) ||
    state.attempt < 1
  ) {
    throw new Error("Run predates resumable state format and cannot be resumed safely");
  }
  const abandoned = state.status === "running" && !getActiveRunPid(dir);
  if (state.status !== "interrupted" && !abandoned) {
    throw new Error(`Run status is ${state.status}; only interrupted runs can be resumed`);
  }
  if (state.repoRoot && path.resolve(state.repoRoot) !== path.resolve(repoRoot)) {
    throw new Error(`Run belongs to a different repository: ${state.repoRoot}`);
  }
  if (!state.workspaceFingerprint) {
    throw new Error("Run has no workspace checkpoint and cannot be resumed safely");
  }
  const currentFingerprint = await fingerprintWorkspace(exec, [dir.root]);
  if (currentFingerprint !== state.workspaceFingerprint) {
    throw new Error(
      "The working tree has changed since Conduct was interrupted. Restore the checkpointed workspace before resuming.",
    );
  }
  if (abandoned) {
    state.status = "interrupted";
    state.interruptionKind = "unexpected";
    state.error = "Previous Conduct process exited without a terminal checkpoint";
    state.updatedAt = new Date().toISOString();
    saveState(dir, state);
  }

  let plan: ImplementationPlan | undefined;
  if (fs.existsSync(dir.planJsonPath)) {
    const candidate = readJson<ImplementationPlan>(dir.planJsonPath);
    const validation = validateImplementationPlan(candidate);
    if (!validation.valid) throw new Error(`Saved plan is invalid: ${validation.errors.join(", ")}`);
    plan = candidate;
  }
  if (state.resumeAction !== "planning" && !plan) {
    throw new Error("Run has no valid saved plan");
  }

  const reviewHistory: ReviewResult[] = [];
  for (let iteration = 1; iteration < Math.max(state.iteration, 1); iteration++) {
    const reviewPath = findLatestIterationFile(dir, iteration, "review.json");
    if (reviewPath) {
      const review = readJson<ReviewResult>(reviewPath);
      const validation = validateReviewResult(review);
      if (!validation.valid) throw new Error(`Saved review is invalid: ${validation.errors.join(", ")}`);
      reviewHistory.push(review);
    }
  }

  let lastChecks: CheckGroup[] = [];
  let lastCoderCompliance: CoderCompliance | null = null;
  const handoffIteration = state.resumeAction === "coder" ? state.iteration - 1 : state.iteration;
  if (handoffIteration > 0) {
    const checksPath = findLatestIterationFile(dir, handoffIteration, path.join("checks", "results.json"));
    if (checksPath) lastChecks = readJson<CheckGroup[]>(checksPath);
    const compliancePath = findLatestIterationFile(dir, handoffIteration, "coder-compliance.json");
    if (compliancePath) {
      const compliance = readJson<CoderCompliance>(compliancePath);
      const validation = validateCoderCompliance(compliance);
      if (!validation.valid) {
        throw new Error(`Saved coder compliance is invalid: ${validation.errors.join(", ")}`);
      }
      lastCoderCompliance = compliance;
    }
  }
  if ((state.resumeAction === "checks" || state.resumeAction === "reviewer") && !lastCoderCompliance) {
    throw new Error("Run is missing the coder checkpoint required for resume");
  }
  const savedConfig = readJson<ConductConfig>(dir.configPath);
  // Merge with defaults so runs saved before a config schema change (e.g. the
  // addition of the `retry` section) still load and run with safe defaults for
  // any newly introduced fields.
  const config = mergeConfig(DEFAULT_CONFIG, savedConfig);
  if (state.resumeAction === "reviewer" && lastChecks.length === 0) {
    const hasConfiguredChecks = [
      ...config.commands.format,
      ...config.commands.lint,
      ...config.commands.test,
    ].length > 0;
    if (hasConfiguredChecks) throw new Error("Run is missing the check checkpoint required for resume");
  }

  return {
    dir,
    userPrompt: readText(dir.userPromptPath),
    config,
    resume: { state, plan, reviewHistory, lastChecks, lastCoderCompliance },
  };
}

export async function markRunInterrupted(
  dir: RunDirectory,
  exec: Exec,
  reason: string,
  kind: "cancelled" | "agent" | "unexpected",
): Promise<void> {
  let state: RunState;
  try {
    state = readJson<RunState>(dir.statePath);
  } catch {
    return;
  }
  state.status = "interrupted";
  state.error = reason;
  state.interruptionKind = kind;
  state.workspaceFingerprint = await fingerprintWorkspace(exec, [dir.root]);
  state.updatedAt = new Date().toISOString();
  saveState(dir, state);
}

export async function initializeRunIdentity(
  state: RunState,
  dir: RunDirectory | undefined,
  exec: Exec,
): Promise<void> {
  if (!dir) return;
  state.repoRoot = path.resolve((await getGitRoot(exec)) ?? "");
  state.baseHead = await getGitHead(exec);
  state.workspaceFingerprint = await fingerprintWorkspace(exec, [dir.root]);
}
