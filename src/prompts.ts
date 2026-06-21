import {
  CODER_COMPLIANCE_JSON_SCHEMA,
  IMPLEMENTATION_PLAN_JSON_SCHEMA,
  REVIEW_RESULT_JSON_SCHEMA,
  type ImplementationPlan,
  type CoderCompliance,
  type ReviewResult,
  type CheckResult,
} from "./schemas.js";

// ============================================================================
// Planner Prompt
// ============================================================================

export function buildPlannerPrompt(
  userPrompt: string,
  repoContext: string,
): string {
  return [
    `You are the planner agent for Pi Conduct.`,
    ``,
    `Your job is to design a detailed implementation plan for the user's coding task. Do not modify files. Inspect the repository as needed.`,
    ``,
    `User task:`,
    `---`,
    `${userPrompt}`,
    `---`,
    ``,
    repoContext ? `Repository context:\n${repoContext}\n` : "",
    `Produce:`,
    `1. A concise human-readable plan.`,
    `2. A strict JSON object matching the ImplementationPlan schema.`,
    ``,
    `ImplementationPlan JSON Schema:`,
    `---`,
    JSON.stringify(IMPLEMENTATION_PLAN_JSON_SCHEMA, null, 2),
    `---`,
    ``,
    `The plan must be specific enough that a smaller coding model can implement it without re-designing the solution.`,
    ``,
    `Include:`,
    `- Files to inspect`,
    `- Files to modify`,
    `- Files to create`,
    `- Types/functions to create or change`,
    `- Control flow`,
    `- Error handling`,
    `- Tests`,
    `- Acceptance criteria`,
    `- Implementation order`,
    ``,
    `Do not include vague instructions like "update as needed". Be concrete.`,
    ``,
    `Wrap your JSON output in a markdown code block with the language "json".`,
  ].join("\n");
}

// ============================================================================
// Coder Prompt
// ============================================================================

export function buildCoderPrompt(
  userPrompt: string,
  plan: ImplementationPlan,
  iteration: number,
  previousReviewerFeedback: string,
  checkOutput: string,
): string {
  const parts: string[] = [
    `You are the coder agent for Pi Conduct.`,
    ``,
    `Your job is to implement the validated plan. Follow the plan closely. Do not redesign unless necessary. If the plan is impossible or unsafe, explain why in the compliance report.`,
    ``,
    `Original user task:`,
    `---`,
    `${userPrompt}`,
    `---`,
    ``,
    `Implementation plan:`,
    `---`,
    JSON.stringify(plan, null, 2),
    `---`,
    ``,
    `Current iteration: ${iteration}`,
  ];

  if (previousReviewerFeedback) {
    parts.push(
      `Previous reviewer feedback:`,
      `---`,
      previousReviewerFeedback,
      `---`,
    );
  } else {
    parts.push(`Previous reviewer feedback: (none - first iteration)`);
  }

  if (checkOutput) {
    parts.push(
      `Relevant check output:`,
      `---`,
      checkOutput,
      `---`,
    );
  } else {
    parts.push(`Relevant check output: (none)`);
  }

  parts.push(
    ``,
    `CoderCompliance JSON Schema:`,
    `---`,
    JSON.stringify(CODER_COMPLIANCE_JSON_SCHEMA, null, 2),
    `---`,
    ``,
    `Rules:`,
    `- Modify only files needed for the task.`,
    `- Keep changes minimal and focused.`,
    `- Prefer idiomatic existing project style.`,
    `- Add or update tests when the plan calls for it.`,
    `- Do not perform destructive shell actions.`,
    `- Do not install packages unless explicitly allowed by config.`,
    `- At the end, provide a concise summary and a strict JSON CoderCompliance object.`,
    ``,
    `Wrap your JSON output in a markdown code block with the language "json".`,
  );

  return parts.join("\n");
}

// ============================================================================
// Reviewer Prompt
// ============================================================================

export function buildReviewerPrompt(
  userPrompt: string,
  plan: ImplementationPlan,
  coderCompliance: CoderCompliance,
  gitDiffStat: string,
  gitDiff: string,
  checkOutputs: CheckResult[],
  reviewHistory: ReviewResult[],
  notes?: string,
  checkArtifactDir?: string,
): string {
  const checkOutputText = formatCheckOutputs(checkOutputs, checkArtifactDir);
  const reviewHistoryText =
    reviewHistory.length > 0
      ? reviewHistory
          .map(
            (r, i) =>
              `--- Review ${i + 1} ---\nStatus: ${r.status}\nSummary: ${r.summary}\nFindings: ${JSON.stringify(r.findings, null, 2)}`,
          )
          .join("\n")
      : "(none - first review)";

  return [
    `You are the reviewer agent for Pi Conduct.`,
    ``,
    `Your job is to review the implementation against the user's original task, the validated implementation plan, the current git diff, the coder compliance report, and check outputs.`,
    ``,
    `Original user task:`,
    `---`,
    `${userPrompt}`,
    `---`,
    ``,
    `Implementation plan:`,
    `---`,
    JSON.stringify(plan, null, 2),
    `---`,
    ``,
    `Coder compliance report:`,
    `---`,
    JSON.stringify(coderCompliance, null, 2),
    `---`,
    ``,
    `Git diff stat:`,
    `---`,
    gitDiffStat || "(empty - no changes)",
    `---`,
    ``,
    `Git diff:`,
    `---`,
    truncate(gitDiff, 40_000) || "(empty - no changes)",
    `---`,
    ``,
    `Check outputs:`,
    `---`,
    checkOutputText || "(no checks configured)",
    `---`,
    ``,
    `Previous review history:`,
    `---`,
    reviewHistoryText,
    `---`,
    ``,
    notes ? `Supervisor notes:\n---\n${notes}\n---\n` : "",
    ``,
    `Return a strict JSON ReviewResult object.`,
    ``,
    `ReviewResult JSON Schema:`,
    `---`,
    JSON.stringify(REVIEW_RESULT_JSON_SCHEMA, null, 2),
    `---`,
    ``,
    `Rules:`,
    `- Be specific.`,
    `- Distinguish blocking issues from minor polish.`,
    `- Do not ask for unnecessary changes.`,
    `- Do not approve if configured required checks are failing, unless the failures are clearly unrelated and explain why.`,
    `- If approved, include approvalRationale.`,
    `- If needs_changes, include actionable expectedFix values.`,
    `- If blocked, explain exactly what user decision or missing dependency is required.`,
    ``,
    `Wrap your JSON output in a markdown code block with the language "json".`,
  ].join("\n");
}

// ============================================================================
// Repair Prompts (for retrying malformed JSON)
// ============================================================================

export function buildPlannerRepairPrompt(errors?: string[]): string {
  const errorList = errors && errors.length > 0
    ? `\nValidation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n`
    : "";
  return [
    `Your previous response did not contain valid JSON matching the required ImplementationPlan schema.${errorList}`,
    `Return only the corrected JSON in a markdown code block with the language "json".`,
    `Ensure all required fields are present, arrays are arrays, and enum values match the schema exactly.`,
  ].join("\n");
}

export function buildReviewerRepairPrompt(errors?: string[]): string {
  const errorList = errors && errors.length > 0
    ? `\nValidation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n`
    : "";
  return [
    `Your previous response did not contain valid JSON matching the required ReviewResult schema.${errorList}`,
    `Return only the corrected JSON in a markdown code block with the language "json".`,
    `Ensure status is one of "approved", "needs_changes", "blocked" and all required fields are present.`,
  ].join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

function formatCheckOutputs(checks: CheckResult[], checkArtifactDir?: string): string {
  if (checks.length === 0) return "(no checks configured)";
  const header = checkArtifactDir ? `Full check artifacts: ${checkArtifactDir}\n\n` : "";
  return header + checks
    .map((c) => {
      const status = c.exitCode === 0 ? "PASS" : "FAIL";
      const parts = [
        `[${status}] ${c.command} (exit ${c.exitCode}, ${c.durationMs}ms)`,
      ];
      if (c.artifactPath) {
        parts.push(`Full output: ${c.artifactPath}`);
      }
      parts.push(`stdout:\n${truncate(c.stdout, 1500) || "(empty)"}`);
      parts.push(`stderr:\n${truncate(c.stderr, 1500) || "(empty)"}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function truncate(text: string, maxBytes: number): string {
  if (!text) return "";
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes) + `\n\n[Output truncated: ${text.length - maxBytes} characters omitted]`;
}
