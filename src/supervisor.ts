import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  ConductConfig,
  ImplementationPlan,
  CoderCompliance,
  ReviewResult,
  CheckGroup,
} from "./schemas.js";
import type { RunDirectory } from "./artifacts.js";
import { status, clearStatus, notify } from "./ui.js";
import {
  runPlanner,
  runCoder,
  runReviewer,
  type PlannerResult,
  type CoderResult,
} from "./agents.js";
import {
  runConfiguredChecks,
  evaluateRequiredChecks,
  summarizeCheckGroups,
} from "./checks.js";
import { collectGitDiff, collectModifiedFiles } from "./git.js";
import {
  savePlanRaw,
  savePlanJson,
  savePlanValidation,
  getIterationDir,
  saveCoderArtifacts,
  saveGitDiff,
  saveCheckResults,
  saveReviewerArtifacts,
  saveFinalSummary,
} from "./artifacts.js";
import { slugify, formatDuration } from "./utils.js";
import { buildPlannerPrompt, buildCoderPrompt, buildReviewerPrompt } from "./prompts.js";

// ============================================================================
// Supervisor - Main Workflow Orchestrator
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
}

export async function runConductWorkflow(
  userPrompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  repoContext: string,
  runDir?: RunDirectory,
): Promise<WorkflowResult> {
  const signal = ctx.signal ?? new AbortController().signal;

  // --- Initialize ---
  await status(ctx, "Conduct: initializing");

  // --- Validate Workspace ---
  await status(ctx, "Conduct: validating workspace");

  // --- Planning Phase ---
  await status(ctx, `Conduct: planning with ${config.models.planner.provider}/${config.models.planner.model}`);

  const plannerPrompt = buildPlannerPrompt(userPrompt, repoContext);
  const plannerResult = await runPlanner(plannerPrompt, config.models.planner, ctx, signal);

  // Save plan artifacts
  if (runDir) {
    savePlanRaw(runDir, plannerResult.rawResponse);
    savePlanJson(runDir, plannerResult.plan);
    savePlanValidation(runDir, plannerResult.valid, plannerResult.errors);
  }

  if (!plannerResult.valid) {
    await status(ctx, "Conduct: plan validation failed");
    notify(ctx, `Plan validation failed: ${plannerResult.errors?.join(", ")}`, "error");
    return {
      success: false,
      reason: `Planner output validation failed: ${plannerResult.errors?.join(", ")}`,
      iterations: 0,
      modifiedFiles: [],
      summary: "Failed to produce a valid implementation plan.",
      artifactPath: "",
    };
  }

  await status(
    ctx,
    `Conduct: plan created, ${plannerResult.plan.filesToModify.length} files to modify, ${plannerResult.plan.filesToCreate.length} files to create`,
  );

  // --- Implementation Loop ---
  let reviewHistory: ReviewResult[] = [];
  let lastReview: ReviewResult | null = null;
  let lastChecks: CheckGroup[] = [];

  for (let iteration = 1; iteration <= config.loop.maxIterations; iteration++) {
    if (signal.aborted) break;

    // --- Coder ---
    await status(
      ctx,
      `Conduct: implementing with ${config.models.coder.provider}/${config.models.coder.model}`,
    );

    const previousFeedback = lastReview
      ? lastReview.findings.map((f) => `[${f.severity}] ${f.issue} → ${f.expectedFix}`).join("\n")
      : "";

    const checkOutputText = lastChecks.length > 0 ? summarizeCheckGroups(lastChecks) : "";

    const coderPrompt = buildCoderPrompt(
      userPrompt,
      plannerResult.plan,
      iteration,
      previousFeedback,
      checkOutputText,
    );

    const coderResult = await runCoder(coderPrompt, config.models.coder, ctx, signal);

    // --- Save Coder Artifacts ---
    if (runDir) {
      const iterDir = getIterationDir(runDir, iteration);
      saveCoderArtifacts(iterDir, coderResult.rawResponse, coderResult.compliance);
    }

    // --- Collect Git Diff ---
    const diff = await collectGitDiff(ctx.exec.bind(ctx));
    const modifiedFiles = await collectModifiedFiles(ctx.exec.bind(ctx));

    // --- Save Git Diff ---
    if (runDir) {
      const iterDir = getIterationDir(runDir, iteration);
      saveGitDiff(iterDir, diff.diff, diff.stat);
    }

    // --- Run Checks ---
    await status(ctx, "Conduct: running checks");

    const checks = await runConfiguredChecks(
      {
        format: config.commands.format,
        lint: config.commands.lint,
        test: config.commands.test,
      },
      ctx.exec.bind(ctx),
    );
    lastChecks = checks;

    const checksPass = evaluateRequiredChecks(checks, config.loop.requirePassingChecks);

    // --- Save Check Results ---
    if (runDir) {
      const iterDir = getIterationDir(runDir, iteration);
      saveCheckResults(iterDir, checks);
    }

    if (checksPass) {
      await status(ctx, "Conduct: checks passed");
    } else {
      await status(ctx, "Conduct: checks failed, sending to reviewer");
    }

    // --- Reviewer ---
    await status(ctx, "Conduct: reviewing iteration");

    const reviewerPrompt = buildReviewerPrompt(
      userPrompt,
      plannerResult.plan,
      coderResult.compliance,
      diff.stat,
      diff.diff,
      checks.flatMap((g) => g.results),
      reviewHistory,
    );

    const reviewerResult = await runReviewer(
      reviewerPrompt,
      config.models.reviewer,
      ctx,
      signal,
    );

    reviewHistory.push(reviewerResult.review);
    lastReview = reviewerResult.review;

    // --- Save Reviewer Artifacts ---
    if (runDir) {
      const iterDir = getIterationDir(runDir, iteration);
      saveReviewerArtifacts(iterDir, reviewerResult.rawResponse, reviewerResult.review);
    }

    // Evaluate stop conditions
    const requiredChecksPass = evaluateRequiredChecks(
      checks,
      config.loop.requirePassingChecks,
    );
    const hasBlockingFindings = reviewerResult.review.findings.some(
      (f) => f.severity === "blocking",
    );

    const allChecksOk = requiredChecksPass || !config.loop.requirePassingChecks;

    if (
      reviewerResult.review.status === "approved" &&
      allChecksOk &&
      !hasBlockingFindings
    ) {
      // SUCCESS
      const summary = buildSuccessSummary(
        userPrompt,
        plannerResult.plan,
        coderResult.compliance,
        checks,
        iteration,
        reviewerResult.review,
      );
      await status(ctx, "Conduct: completed successfully");
      notify(ctx, "Conduct completed successfully", "info");

      return {
        success: true,
        reason: "Reviewer approved, all checks passed",
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath: "", // Will be set by caller
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    if (reviewerResult.review.status === "blocked") {
      const summary = buildBlockedSummary(
        userPrompt,
        checks,
        reviewerResult.review,
        iteration,
      );
      await status(ctx, "Conduct: blocked");
      notify(ctx, `Conduct blocked: ${reviewerResult.review.summary}`, "warning");

      return {
        success: false,
        reason: `Reviewer blocked: ${reviewerResult.review.summary}`,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath: "",
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    if (iteration >= config.loop.maxIterations) {
      const summary = buildMaxIterationsSummary(
        userPrompt,
        plannerResult.plan,
        coderResult.compliance,
        checks,
        reviewerResult.review,
      );
      await status(ctx, "Conduct: max iterations reached");
      notify(ctx, `Conduct stopped: max iterations (${config.loop.maxIterations}) reached`, "warning");

      return {
        success: false,
        reason: `Max iterations reached (${config.loop.maxIterations})`,
        iterations: iteration,
        modifiedFiles,
        summary,
        artifactPath: "",
        lastChecks: checks,
        lastReview: reviewerResult.review,
      };
    }

    // Continue to next iteration
    const blockingCount = reviewerResult.review.findings.filter(
      (f) => f.severity === "blocking",
    ).length;
    const importantCount = reviewerResult.review.findings.filter(
      (f) => f.severity === "important",
    ).length;
    const minorCount = reviewerResult.review.findings.filter(
      (f) => f.severity === "minor",
    ).length;

    await status(
      ctx,
      `Conduct: reviewer found ${blockingCount} blocking, ${importantCount} important, ${minorCount} minor`,
    );
  }

  // Should not reach here, but just in case
  const summary = buildMaxIterationsSummary(
    userPrompt,
    plannerResult.plan,
    {} as CoderCompliance,
    lastChecks,
    lastReview ?? {
      status: "needs_changes",
      summary: "Loop ended without reviewer verdict",
      findings: [],
      testsToRun: [],
      riskNotes: [],
    },
  );

  return {
    success: false,
    reason: "Workflow loop ended without approval",
    iterations: config.loop.maxIterations,
    modifiedFiles: [],
    summary,
    artifactPath: "",
    lastChecks,
    lastReview: lastReview ?? undefined,
  };
}

// ============================================================================
// Summary Builders
// ============================================================================

function buildSuccessSummary(
  userPrompt: string,
  plan: ImplementationPlan,
  compliance: CoderCompliance,
  checks: CheckGroup[],
  iterations: number,
  review: ReviewResult,
): string {
  const modifiedFiles = compliance.filesChanged.length > 0 ? compliance.filesChanged.join(", ") : "none";
  const testsAdded = plan.tests.filter((t) => t.kind === "unit" || t.kind === "integration").length;

  const checkStatuses = checks
    .map((g) => `${g.groupName}: ${g.results.every((r) => r.exitCode === 0) ? "✓" : "✗"}`)
    .join(", ");

  return [
    `Conduct completed successfully.`,
    ``,
    `Summary:`,
    `- Task: ${userPrompt.slice(0, 100)}${userPrompt.length > 100 ? "..." : ""}`,
    `- Modified files: ${modifiedFiles}`,
    `- Tests added/updated: ${testsAdded}`,
    `- Checks: ${checkStatuses}`,
    `- Reviewer approved after ${iterations} iteration(s)`,
    `- Approval rationale: ${review.approvalRationale || "N/A"}`,
    ``,
    `Compliance:`,
    `- Plan items completed: ${compliance.planItemsCompleted.length}`,
    `- Plan items skipped: ${compliance.planItemsSkipped.length}`,
    `- Known issues: ${compliance.knownIssues.length}`,
  ].join("\n");
}

function buildBlockedSummary(
  userPrompt: string,
  checks: CheckGroup[],
  review: ReviewResult,
  iteration: number,
): string {
  return [
    `Conduct stopped: reviewer blocked.`,
    ``,
    `Reason: ${review.summary}`,
    `Iteration: ${iteration}`,
    ``,
    review.findings
      .map((f) => `- [${f.severity}] ${f.issue}: ${f.expectedFix}`)
      .join("\n"),
  ].join("\n");
}

function buildMaxIterationsSummary(
  userPrompt: string,
  plan: ImplementationPlan,
  compliance: CoderCompliance,
  checks: CheckGroup[],
  review: ReviewResult,
): string {
  const checkStatuses = checks
    .map((g) => `${g.groupName}: ${g.results.every((r) => r.exitCode === 0) ? "✓" : "✗"}`)
    .join(", ");

  return [
    `Conduct stopped before approval.`,
    ``,
    `Reason: Max iterations reached`,
    ``,
    `Current state:`,
    `- Modified files: ${compliance.filesChanged.length > 0 ? compliance.filesChanged.join(", ") : "none"}`,
    `- Last check status: ${checkStatuses || "no checks run"}`,
    `- Last reviewer status: ${review.status}`,
    `- Last reviewer findings:`,
    ...review.findings.map((f) => `  - [${f.severity}] ${f.issue}: ${f.expectedFix}`),
    ``,
    `Partial implementation may be in progress. Review git diff for details.`,
  ].join("\n");
}
