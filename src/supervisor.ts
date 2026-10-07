import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type {
  ConductConfig,
  ImplementationPlan,
  CoderCompliance,
  ReviewResult,
  RunState,
  RunStage,
  ResumeAction,
} from "./schemas.js";
import { emptyRunState } from "./schemas.js";
import type { RunDirectory } from "./artifacts.js";
import { ConductProgress, notify } from "./ui.js";
import { getLiveOutputKeybindings } from "./keybindings.js";
import {
  runPlanner,
  runCoder,
  runReviewer,
  type PlannerResult,
  type CoderResult,
  type ReviewerResult,
} from "./agents.js";
import {
  runConfiguredChecks,
  evaluateRequiredChecks,
  summarizeCheckGroups,
  type CheckGroup,
} from "./checks.js";
import type { Exec } from "./git.js";
import { collectGitDiff, collectModifiedFiles, fingerprintWorkspace } from "./git.js";
import {
  savePlannerPrompt,
  savePlanRaw,
  savePlanJson,
  savePlanValidation,
  saveState,
  saveTranscript,
  getIterationAttemptDir,
  saveCoderPrompt,
  saveCoderArtifacts,
  saveGitDiff,
  saveCheckResults,
  saveReviewerPrompt,
  saveReviewerArtifacts,
  saveFinalSummary,
} from "./artifacts.js";
import { buildPlannerPrompt, buildCoderPrompt, buildReviewerPrompt } from "./prompts.js";
import { countFindings, hasNonMinorFindings, truncate } from "./utils.js";
import { initializeRunIdentity, type ResumeWorkflowData } from "./resume.js";
import type { WorkflowAgentServices } from "./runtime.js";

// ============================================================================
// Supervisor - Main Workflow Orchestrator (§6, §13)
// ============================================================================

export interface WorkflowResult {
  success: boolean;
  reason: string;
  iterations: number;
  modifiedFiles: string[];
  summary: string;
  artifactPath: string;
  lastChecks?: CheckGroup[];
  lastReview?: ReviewResult;
  resumable?: boolean;
}

export async function runConductWorkflow(
  userPrompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  exec: Exec,
  repoContext: string,
  runDir?: RunDirectory,
  signal?: AbortSignal,
  progress = new ConductProgress(ctx, getLiveOutputKeybindings(config)),
  resume?: ResumeWorkflowData,
  services?: WorkflowAgentServices,
): Promise<WorkflowResult> {
  const state: RunState = resume
    ? {
        ...resume.state,
        status: "running",
        attempt: resume.state.attempt + 1,
        inFlightRole: undefined,
        error: undefined,
        interruptionKind: undefined,
        updatedAt: new Date().toISOString(),
      }
    : emptyRunState(config.loop.maxIterations);

  const updateState = (
    stage: RunStage,
    resumeAction: ResumeAction,
    patch: Partial<RunState> = {},
  ): void => {
    state.stage = stage;
    state.resumeAction = resumeAction;
    Object.assign(state, patch);
    state.updatedAt = new Date().toISOString();
    if (runDir) saveState(runDir, state);
  };

  const checkpoint = async (
    stage: RunStage,
    resumeAction: ResumeAction,
    patch: Partial<RunState> = {},
  ): Promise<void> => {
    if (runDir) state.workspaceFingerprint = await fingerprintWorkspace(exec, [runDir.root]);
    updateState(stage, resumeAction, patch);
  };

  const setStatus = (
    status: RunState["status"],
    error?: string,
  ): void => {
    state.status = status;
    state.error = error;
    state.updatedAt = new Date().toISOString();
    if (runDir) saveState(runDir, state);
  };

  const artifactPath = runDir?.root ?? "";

  if (!resume) await initializeRunIdentity(state, runDir, exec);
  if (runDir) saveState(runDir, state);

  const finishInterrupted = async (
    reason: string,
    kind: "cancelled" | "agent" | "unexpected",
    iterations: number,
    modifiedFiles: string[] = [],
    checks: CheckGroup[] = [],
    review: ReviewResult | null = null,
    diffStat = "",
  ): Promise<WorkflowResult> => {
    const summary = [buildFailureSummary(
      reason,
      userPrompt,
      checks,
      review,
      { stat: diffStat, modifiedFiles },
      artifactPath,
    ), "", `Resume with: /conduct resume ${path.basename(artifactPath)}`].join("\n");
    state.status = "interrupted";
    state.error = reason;
    state.interruptionKind = kind;
    if (runDir) {
      state.workspaceFingerprint = await fingerprintWorkspace(exec, [runDir.root]);
      state.updatedAt = new Date().toISOString();
      saveState(runDir, state);
    }
    if (runDir) saveFinalSummary(runDir, summary);
    progress.failStep(kind === "cancelled" ? "Cancelled by user" : reason);
    progress.finish();
    return {
      success: false,
      reason,
      iterations,
      modifiedFiles,
      summary,
      artifactPath,
      lastChecks: checks.length > 0 ? checks : undefined,
      lastReview: review ?? undefined,
      resumable: true,
    };
  };

  let plan: ImplementationPlan | undefined = resume?.plan;
  if (!plan || state.resumeAction === "planning") {
    updateState("planning", "planning", { iteration: 0 });
    progress.startStep("Planning", "Starting planner sub-agent…", config.models.planner);
    const plannerPrompt = buildPlannerPrompt(userPrompt, repoContext);
    if (runDir) savePlannerPrompt(runDir, plannerPrompt);
    const plannerResult: PlannerResult = await runPlanner(
      plannerPrompt, config, ctx, signal, progress, services,
    );
    if (runDir) {
      savePlanRaw(runDir, plannerResult.rawResponse);
      if (plannerResult.plan) savePlanJson(runDir, plannerResult.plan);
      savePlanValidation(runDir, plannerResult.valid, plannerResult.errors);
      saveTranscript(
        runDir,
        path.join(runDir.root, "planner-transcript.json"),
        plannerResult.transcript,
        config.artifacts.keepTranscripts,
      );
    }
    if (signal?.aborted) {
      return finishInterrupted("Workflow cancelled", "cancelled", 0);
    }
    if (plannerResult.interrupted) {
      return finishInterrupted(
        plannerResult.errors?.join(", ") ?? "Planner agent was interrupted",
        "agent",
        0,
      );
    }
    updateState("validatingPlan", "planning", { planValid: plannerResult.valid });
    if (!plannerResult.valid || !plannerResult.plan) {
      const reason = `Planner output validation failed: ${plannerResult.errors?.join(", ") ?? "unknown"}`;
      setStatus("failed", reason);
      progress.failStep("Plan validation failed");
      notify(ctx, `Plan validation failed: ${plannerResult.errors?.join(", ")}`, "error");
      const summary = buildFailureSummary(reason, userPrompt, [], null, null, artifactPath);
      if (runDir) saveFinalSummary(runDir, summary);
      progress.finish();
      return { success: false, reason, iterations: 0, modifiedFiles: [], summary, artifactPath };
    }
    plan = plannerResult.plan;
    progress.completeStep();
    await checkpoint("implementing", "coder", { iteration: 1, planValid: true });
  }

  if (!plan) throw new Error("Conduct has no implementation plan");

  // --- Implementation Loop ---
  const reviewHistory: ReviewResult[] = [...(resume?.reviewHistory ?? [])];
  let lastReview: ReviewResult | null = reviewHistory.at(-1) ?? null;
  let lastChecks: CheckGroup[] = resume?.lastChecks ?? [];
  let lastCoderCompliance: CoderCompliance | null = resume?.lastCoderCompliance ?? null;
  let lastModifiedFiles: string[] = [];
  let lastDiffStat = "";

  const firstIteration = resume && resume.state.resumeAction !== "planning"
    ? Math.max(resume.state.iteration, 1)
    : 1;

  for (let iteration = firstIteration; iteration <= config.loop.maxIterations; iteration++) {
    if (signal?.aborted) break;
    let action: ResumeAction =
      resume && iteration === firstIteration && resume.state.resumeAction !== "planning"
        ? resume.state.resumeAction
        : "coder";
    const coderStage: RunStage = iteration === 1 ? "implementing" : "fixing";
    let coderResult: CoderResult = {
      rawResponse: "",
      compliance: lastCoderCompliance,
      valid: lastCoderCompliance !== null,
      transcript: "[]",
    };

    if (action !== "coder") {
      progress.startStep(
        `Resume iteration ${iteration}/${config.loop.maxIterations}`,
        action === "checks" ? "Re-running configured checks…" : "Restoring review inputs…",
      );
    }

    // --- Coder ---
    if (action === "coder") {
      updateState(coderStage, "coder", { iteration });
      progress.startStep(
        iteration === 1
          ? `Implementation ${iteration}/${config.loop.maxIterations}`
          : `Fixing review feedback ${iteration}/${config.loop.maxIterations}`,
        "Starting coder sub-agent…",
        config.models.coder,
      );
      const previousFeedback = lastReview
        ? lastReview.findings.map((f) => `[${f.severity}] ${f.issue} → ${f.expectedFix}`).join("\n")
        : "";
      const checkOutputText = lastChecks.length > 0 ? summarizeCheckGroups(lastChecks) : "";
      const recoveryNote = resume && iteration === firstIteration
        ? `This run was interrupted during ${resume.state.stage}. Existing workspace changes may be partial.`
        : undefined;
      const coderPrompt = buildCoderPrompt(
        userPrompt, plan, iteration, previousFeedback, checkOutputText, recoveryNote,
      );
      const coderIterationDir = runDir
        ? getIterationAttemptDir(runDir, iteration, state.attempt)
        : undefined;
      if (coderIterationDir) saveCoderPrompt(coderIterationDir, coderPrompt);
      updateState(coderStage, "coder", { iteration, inFlightRole: "coder" });
      coderResult = await runCoder(coderPrompt, config, ctx, signal, progress, services, `iteration ${iteration} coder`);
      lastCoderCompliance = coderResult.compliance;
      if (coderIterationDir && runDir) {
        saveCoderArtifacts(coderIterationDir, coderResult.rawResponse, coderResult.compliance ?? {
          summary: "(none)", filesChanged: [], planItemsCompleted: [], planItemsSkipped: [],
          reviewerItemsAddressed: [], commandsRun: [], knownIssues: coderResult.errors ?? [],
        });
        saveTranscript(
          runDir,
          path.join(coderIterationDir, "coder-transcript.json"),
          coderResult.transcript,
          config.artifacts.keepTranscripts,
        );
      }
      if (signal?.aborted) {
        return finishInterrupted("Workflow cancelled", "cancelled", iteration, lastModifiedFiles, lastChecks, lastReview, lastDiffStat);
      }
      if (coderResult.interrupted) {
        return finishInterrupted(coderResult.errors?.join(", ") ?? "Coder agent was interrupted", "agent", iteration, lastModifiedFiles, lastChecks, lastReview, lastDiffStat);
      }
      action = "checks";
      await checkpoint("runningChecks", "checks", { iteration, inFlightRole: undefined });
    }

    // --- Collect Git Diff (§8) ---
    progress.setActivity("Collecting the implementation diff…");
    const artifactExcludes = runDir ? [runDir.root] : [];
    const diff = await collectGitDiff(exec, artifactExcludes);
    lastDiffStat = diff.stat;
    const modifiedFiles = await collectModifiedFiles(exec, artifactExcludes);
    lastModifiedFiles = modifiedFiles;

    if (runDir && config.artifacts.keepDiffs) {
      const iterDir = getIterationAttemptDir(runDir, iteration, state.attempt);
      saveGitDiff(iterDir, diff.diff, diff.stat);
    }

    if (signal?.aborted) {
      return finishInterrupted("Workflow cancelled", "cancelled", iteration, modifiedFiles, lastChecks, lastReview, diff.stat);
    }

    // --- Running Checks (§9) ---
    let checks = lastChecks;
    if (action !== "reviewer") {
      progress.setActivity("Running configured checks…");
      checks = await runConfiguredChecks(
        { format: config.commands.format, lint: config.commands.lint, test: config.commands.test },
        exec,
        signal,
      );
      lastChecks = checks;
      if (runDir) saveCheckResults(getIterationAttemptDir(runDir, iteration, state.attempt), checks);
      if (signal?.aborted) {
        return finishInterrupted("Workflow cancelled", "cancelled", iteration, modifiedFiles, checks, lastReview, diff.stat);
      }
      action = "reviewer";
    }
    const checksPass = evaluateRequiredChecks(checks, config.loop.requirePassingChecks);
    await checkpoint("reviewing", "reviewer", { iteration, checksPass });
    progress.completeStep();

    // §16.4: if checks fail and continueAfterCheckFailure is false, stop now.
    if (!checksPass && !config.loop.continueAfterCheckFailure) {
      const reason = "Checks failed and continueAfterCheckFailure is false";
      const summary = buildFailureSummary(
        reason,
        userPrompt,
        checks,
        null,
        { stat: diff.stat, modifiedFiles },
        artifactPath,
      );
      setStatus("failed", reason);
      if (runDir) saveFinalSummary(runDir, summary);
      notify(ctx, "Conduct stopped: checks failed", "warning");
      progress.finish();
      return {
        success: false,
        reason,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath,
        lastChecks: checks,
      };
    }

    // --- Reviewing (§12) ---
    updateState("reviewing", "reviewer", { iteration });
    progress.startStep(
      `Review ${iteration}/${config.loop.maxIterations}`,
      "Starting reviewer sub-agent…",
      config.models.reviewer,
    );

    // §16.3: flag when the coder made no progress so the reviewer can judge
    // whether the failure is recoverable or a blocker.
    const reviewerNotes: string[] = [];
    if (!diff.diff.trim()) {
      reviewerNotes.push(
        "The coder produced no git diff this iteration (no file changes detected). " +
          "Determine whether this is a recoverable failure (e.g. the coder misread the task) " +
          "or a blocker requiring user intervention. If recoverable, return needs_changes with " +
          "specific guidance; otherwise return blocked.",
      );
    }
    if (!coderResult.valid) {
      reviewerNotes.push(
        `The coder's compliance report was malformed: ${coderResult.errors?.join(", ")}`,
      );
    }

    const savedCheckArtifact = checks
      .flatMap((group) => group.results)
      .find((result) => result.artifactPath)?.artifactPath;

    const reviewerPrompt = buildReviewerPrompt(
      userPrompt,
      plan,
      coderResult.compliance ?? {
        summary: "(none)",
        filesChanged: [],
        planItemsCompleted: [],
        planItemsSkipped: [],
        reviewerItemsAddressed: [],
        commandsRun: [],
        knownIssues: [],
      },
      diff.stat,
      diff.diff,
      checks.flatMap((g) => g.results),
      reviewHistory,
      reviewerNotes.length > 0 ? reviewerNotes.join("\n\n") : undefined,
      savedCheckArtifact
        ? path.dirname(savedCheckArtifact)
        : runDir
          ? path.join(getIterationAttemptDir(runDir, iteration, state.attempt), "checks")
          : undefined,
    );

    const reviewerIterationDir = runDir
      ? getIterationAttemptDir(runDir, iteration, state.attempt)
      : undefined;
    if (reviewerIterationDir) saveReviewerPrompt(reviewerIterationDir, reviewerPrompt);
    const reviewerResult: ReviewerResult = await runReviewer(
      reviewerPrompt,
      config,
      ctx,
      signal,
      progress,
      services,
      `iteration ${iteration} reviewer`,
    );

    if (reviewerIterationDir && runDir) {
      saveReviewerArtifacts(reviewerIterationDir, reviewerResult.rawResponse, reviewerResult.review);
      saveTranscript(
        runDir,
        path.join(reviewerIterationDir, "reviewer-transcript.json"),
        reviewerResult.transcript,
        config.artifacts.keepTranscripts,
      );
    }

    if (signal?.aborted) {
      return finishInterrupted("Workflow cancelled", "cancelled", iteration, modifiedFiles, checks, lastReview, diff.stat);
    }
    if (reviewerResult.interrupted) {
      return finishInterrupted(reviewerResult.errors?.join(", ") ?? "Reviewer agent was interrupted", "agent", iteration, modifiedFiles, checks, lastReview, diff.stat);
    }

    reviewHistory.push(reviewerResult.review);
    lastReview = reviewerResult.review;
    progress.completeStep();

    const counts = countFindings(reviewerResult.review);
    updateState("reviewing", "reviewer", {
      reviewStatus: reviewerResult.review.status,
      reviewFindingCount: counts,
    });

    const requiredChecksPass = checksPass;
    const hasBlockingFindings = reviewerResult.review.findings.some(
      (f) => f.severity === "blocking",
    );

    // --- Stop condition: success (§6.1) ---
    if (
      reviewerResult.review.status === "approved" &&
      requiredChecksPass &&
      !hasBlockingFindings
    ) {
      const summary = buildSuccessSummary(
        userPrompt,
        plan,
        coderResult.compliance,
        checks,
        iteration,
        reviewerResult.review,
        artifactPath,
      );
      setStatus("completed");
      if (runDir) saveFinalSummary(runDir, summary);
      notify(ctx, "Conduct completed successfully", "info");
      progress.finish();
      return {
        success: true,
        reason: "Reviewer approved, all checks passed",
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath,
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    // --- Stop condition: blocked (§6.1) ---
    if (reviewerResult.review.status === "blocked") {
      const reason = `Reviewer blocked: ${reviewerResult.review.summary}`;
      const summary = buildBlockedSummary(
        userPrompt,
        checks,
        reviewerResult.review,
        iteration,
        { stat: diff.stat, modifiedFiles },
        artifactPath,
      );
      setStatus("needsUserIntervention", reason);
      if (runDir) saveFinalSummary(runDir, summary);
      notify(ctx, `Conduct blocked: ${reviewerResult.review.summary}`, "warning");
      progress.finish();
      return {
        success: false,
        reason,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath,
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    // --- Stop condition: minor-only findings past cutoff (bounds polish loops) ---
    if (
      reviewerResult.review.status === "needs_changes" &&
      !hasNonMinorFindings(reviewerResult.review) &&
      iteration >= config.loop.minorFindingIterationCutoff
    ) {
      const reason =
        `Only minor findings remain after iteration ${iteration} (>= minorFindingIterationCutoff ${config.loop.minorFindingIterationCutoff}); stopping to avoid polishing loops`;
      const summary = buildFailureSummary(
        reason,
        userPrompt,
        checks,
        reviewerResult.review,
        { stat: diff.stat, modifiedFiles },
        artifactPath,
      );
      setStatus("completed", reason);
      if (runDir) saveFinalSummary(runDir, summary);
      notify(ctx, "Conduct stopped: only minor findings remain", "warning");
      progress.finish();
      return {
        success: false,
        reason,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath,
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    // --- Stop condition: max iterations (§6.1) ---
    if (iteration >= config.loop.maxIterations) {
      const reason = `Max iterations reached (${config.loop.maxIterations})`;
      const summary = buildMaxIterationsSummary(
        userPrompt,
        plan,
        coderResult.compliance,
        checks,
        reviewerResult.review,
        { stat: diff.stat, modifiedFiles },
        artifactPath,
      );
      setStatus("failed", reason);
      if (runDir) saveFinalSummary(runDir, summary);
      notify(
        ctx,
        `Conduct stopped: max iterations (${config.loop.maxIterations}) reached`,
        "warning",
      );
      progress.finish();
      return {
        success: false,
        reason,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath,
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    // --- Continue to next iteration ---
    lastChecks = checks;
    await checkpoint("fixing", "coder", { iteration: iteration + 1 });
  }

  // Loop exited without a verdict (e.g. aborted).
  if (signal?.aborted) {
    return finishInterrupted(
      "Workflow cancelled",
      "cancelled",
      state.iteration,
      lastModifiedFiles,
      lastChecks,
      lastReview,
      lastDiffStat,
    );
  }

  const reason = "Workflow loop ended without approval";
  const summary = buildFailureSummary(
    reason,
    userPrompt,
    lastChecks,
    lastReview,
    { stat: lastDiffStat, modifiedFiles: lastModifiedFiles },
    artifactPath,
  );
  setStatus("failed", reason);
  if (runDir) saveFinalSummary(runDir, summary);
  progress.finish();
  return {
    success: false,
    reason,
    iterations: state.iteration,
    modifiedFiles: lastModifiedFiles,
    summary,
    artifactPath,
    lastChecks: lastChecks.length > 0 ? lastChecks : undefined,
    lastReview: lastReview ?? undefined,
  };
}

// ============================================================================
// Summary Builders (§17)
// ============================================================================

interface DiffSummary {
  stat: string;
  modifiedFiles: string[];
}

function formatCheckStatuses(checks: CheckGroup[]): string {
  if (checks.length === 0) return "(no checks run)";
  return checks
    .map((g) => `${g.groupName}: ${g.results.every((r) => r.exitCode === 0) ? "✓" : "✗"}`)
    .join(", ");
}

function buildSuccessSummary(
  userPrompt: string,
  plan: ImplementationPlan,
  compliance: CoderCompliance | null,
  checks: CheckGroup[],
  iterations: number,
  review: ReviewResult,
  artifactPath: string,
): string {
  const modifiedFiles =
    compliance && compliance.filesChanged.length > 0
      ? compliance.filesChanged.join(", ")
      : "none";
  const testsAdded = plan.tests.filter(
    (t) => t.kind === "unit" || t.kind === "integration",
  ).length;

  return [
    `Conduct completed successfully.`,
    ``,
    `Summary:`,
    `- Task: ${truncate(userPrompt, 100)}`,
    `- Modified files: ${modifiedFiles}`,
    `- Tests added/updated (planned): ${testsAdded}`,
    `- Checks: ${formatCheckStatuses(checks)}`,
    `- Reviewer approved after ${iterations} iteration(s)`,
    `- Approval rationale: ${review.approvalRationale ?? "N/A"}`,
    ``,
    `Compliance:`,
    `- Plan items completed: ${compliance?.planItemsCompleted.length ?? 0}`,
    `- Plan items skipped: ${compliance?.planItemsSkipped.length ?? 0}`,
    `- Known issues: ${compliance?.knownIssues.length ?? 0}`,
    ``,
    `Artifacts:`,
    artifactPath,
  ].join("\n");
}

function buildBlockedSummary(
  userPrompt: string,
  checks: CheckGroup[],
  review: ReviewResult,
  iteration: number,
  diff: DiffSummary,
  artifactPath: string,
): string {
  return [
    `Conduct stopped before approval.`,
    ``,
    `Reason: Reviewer blocked`,
    `- ${review.summary}`,
    `Iteration: ${iteration}`,
    ``,
    `Current state:`,
    `- Modified files: ${diff.modifiedFiles.length > 0 ? diff.modifiedFiles.join(", ") : "none"}`,
    `- Last check status: ${formatCheckStatuses(checks)}`,
    `- Git diff stat:`,
    truncate(diff.stat, 1000) || "(empty)",
    ``,
    `Last reviewer findings:`,
    ...review.findings.map((f) => `  - [${f.severity}] ${f.issue}: ${f.expectedFix}`),
    ``,
    `Artifacts:`,
    artifactPath,
  ].join("\n");
}

function buildMaxIterationsSummary(
  userPrompt: string,
  plan: ImplementationPlan,
  compliance: CoderCompliance | null,
  checks: CheckGroup[],
  review: ReviewResult,
  diff: DiffSummary,
  artifactPath: string,
): string {
  return [
    `Conduct stopped before approval.`,
    ``,
    `Reason: Max iterations reached`,
    ``,
    `Current state:`,
    `- Modified files: ${diff.modifiedFiles.length > 0 ? diff.modifiedFiles.join(", ") : "none"}`,
    `- Last check status: ${formatCheckStatuses(checks)}`,
    `- Last reviewer status: ${review.status}`,
    `- Git diff stat:`,
    truncate(diff.stat, 1000) || "(empty)",
    ``,
    `Last reviewer findings:`,
    ...review.findings.map((f) => `  - [${f.severity}] ${f.issue}: ${f.expectedFix}`),
    ``,
    `Partial implementation may be in progress. Review git diff for details.`,
    ``,
    `Artifacts:`,
    artifactPath,
  ].join("\n");
}

function buildFailureSummary(
  reason: string,
  userPrompt: string,
  checks: CheckGroup[],
  review: ReviewResult | null,
  diff: DiffSummary | null,
  artifactPath: string,
): string {
  const lines: string[] = [
    `Conduct stopped before approval.`,
    ``,
    `Reason: ${reason}`,
    ``,
    `Current state:`,
    `- Task: ${truncate(userPrompt, 100)}`,
  ];
  if (diff) {
    lines.push(
      `- Modified files: ${diff.modifiedFiles.length > 0 ? diff.modifiedFiles.join(", ") : "none"}`,
    );
    lines.push(`- Git diff stat:`, truncate(diff.stat, 1000) || "(empty)");
  }
  lines.push(`- Last check status: ${formatCheckStatuses(checks)}`);
  if (review) {
    lines.push(`- Last reviewer status: ${review.status}`);
    if (review.findings.length > 0) {
      lines.push(`- Last reviewer findings:`);
      for (const f of review.findings) {
        lines.push(`  - [${f.severity}] ${f.issue}: ${f.expectedFix}`);
      }
    }
  }
  lines.push(``, `Artifacts:`, artifactPath);
  return lines.join("\n");
}
