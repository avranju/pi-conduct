# Pi `/conduct` Extension Design Spec

## 1. Purpose

Build a Pi extension that adds a custom slash command:

```text
/conduct <user prompt>
```

The command starts an orchestrated multi-agent coding workflow inside Pi while preserving the existing Pi UX. The visible Pi session remains the cockpit for user interaction and progress updates. The extension acts as a supervisor that creates internal SDK-backed agent sessions for planning, coding, reviewing, fixing, and summarizing.

The core workflow is:

```text
User prompt
  -> Supervisor extension
  -> Planner agent using frontier model
  -> Structured implementation plan
  -> Coder agent using configured coding model, often local/smaller
  -> Supervisor runs tests/lint/format checks
  -> Reviewer agent using frontier model
  -> Coder agent addresses feedback
  -> Repeat until approved or max iterations reached
  -> Final user summary
```

The design goal is not perfect determinism, but operational determinism: explicit stages, schemas, persisted artifacts, bounded loops, test outputs, git diffs, and machine-readable review verdicts.

---

## 2. High-Level Requirements

### 2.1 Functional Requirements

The extension must:

1. Register a Pi slash command named `/conduct`.
2. Accept the full user task prompt after the command.
3. Load orchestration configuration from a JSON file.
4. Create separate internal Pi SDK `AgentSession`s for:
   - Planner
   - Coder
   - Reviewer
5. Allow each role to use a different configured model/provider.
6. Ask the planner to produce a detailed implementation plan.
7. Require the plan to include both human-readable explanation and strict JSON.
8. Validate planner JSON before continuing.
9. Ask the coder agent to implement the plan.
10. Run configured supervisor-owned checks, such as tests, format, lint, and git diff.
11. Ask the reviewer agent to review the implementation using:
    - Original user prompt
    - Approved plan
    - Current git diff
    - Test/lint/format output
    - Coder compliance report
    - Previous reviewer feedback, if any
12. Require reviewer output as strict JSON with an explicit verdict.
13. Continue the coder/reviewer loop until:
    - Reviewer approves
    - Required checks pass
    - No blocking findings remain
    - Or `maxIterations` is reached
14. Persist all run artifacts under a run directory.
15. Inform the user of stage-level progress using Pi UI facilities.
16. Emit a final summary in the visible Pi session.

### 2.2 Non-Goals for MVP

The MVP does not need:

1. A complex custom TUI dashboard.
2. Distributed execution.
3. Container sandboxing.
4. Background execution after Pi exits.
5. Multi-repo orchestration.
6. Automatic package installation.
7. Fully autonomous destructive command execution.
8. Perfect recovery from every possible malformed model response.

---

## 3. Pi Extension Entry Point

The extension should be implemented as a Pi package (declared via the `pi`
manifest in `package.json`), with its source at:

```text
src/
  index.ts
  config.ts
  supervisor.ts
  agents.ts
  prompts.ts
  schemas.ts
  git.ts
  checks.ts
  artifacts.ts
  ui.ts
  utils.ts
```

The extension should register the command:

```ts
pi.registerCommand("conduct", async (args, ctx) => {
  const userPrompt = args.trim();
  await runConductWorkflow(userPrompt, ctx);
});
```

If `userPrompt` is empty, print usage:

```text
Usage: /conduct <task prompt>
```

---

## 4. Configuration

The extension should merge configuration from these locations in order, with
later values overriding earlier values:

```text
~/.pi/agent/conduct/config.json
<repo>/.pi/conduct/config.json
```

If no config exists, use safe defaults and tell the user which defaults are being used.

### 4.1 Example Config

```json
{
  "models": {
    "planner": {
      "provider": "openai",
      "model": "gpt-5.5",
      "thinkingLevel": "high"
    },
    "coder": {
      "provider": "ollama",
      "model": "qwen3.5-coder-32b",
      "thinkingLevel": "off"
    },
    "reviewer": {
      "provider": "openai",
      "model": "gpt-5.5",
      "thinkingLevel": "high"
    }
  },
  "loop": {
    "maxIterations": 5,
    "requireCleanGit": true,
    "requireApproval": true,
    "requirePassingChecks": true,
    "continueAfterCheckFailure": true,
    "minorFindingIterationCutoff": 3
  },
  "commands": {
    "format": ["cargo fmt --check"],
    "lint": ["cargo clippy --all-targets -- -D warnings"],
    "test": ["cargo test"]
  },
  "artifacts": {
    "root": ".pi/conduct/runs",
    "keepTranscripts": true,
    "keepDiffs": true
  }
}
```

### 4.2 Config Validation

Validate config before starting.

Reject or warn on:

1. Missing planner/coder/reviewer model config.
2. `maxIterations < 1`.
3. Empty test/lint/format commands when `requirePassingChecks` is true.
4. Invalid artifact root.

---

## 5. Model Resolution

Use Pi's model registry to resolve configured models.

Conceptual helper:

```ts
async function resolveRoleModel(ctx, roleConfig): Promise<Model> {
  const model = ctx.modelRegistry.find(roleConfig.provider, roleConfig.model);
  if (!model) {
    throw new Error(`Configured model not found: ${roleConfig.provider}/${roleConfig.model}`);
  }
  return model;
}
```

Each role should use its own SDK-created `AgentSession`.

Recommended role isolation:

```text
Planner tools:
  read, grep, find, ls, bash

Coder tools:
  read, edit, write, bash, grep, find, ls

Reviewer tools:
  read, grep, find, ls, bash
```

The reviewer should generally not edit files. The supervisor, not the reviewer, should run checks.

---

## 6. Workflow State Machine

Use an explicit state machine.

```text
Idle
  -> Planning
  -> ValidatingPlan
  -> Implementing
  -> RunningChecks
  -> Reviewing
  -> Fixing
  -> RunningChecks
  -> Reviewing
  -> Completed
  -> Failed
  -> NeedsUserIntervention
```

### 6.1 Stop Conditions

Stop successfully only when:

```text
review.status == "approved"
AND no blocking findings remain
AND configured required checks pass
```

Stop unsuccessfully when:

```text
iteration >= maxIterations
OR unrecoverable config/model/tool error occurs
OR planner output cannot be parsed after retries
OR coder cannot make progress
OR reviewer returns blocked
```

When stopping unsuccessfully, produce a useful partial summary with:

1. What was completed.
2. Current git diff summary.
3. Last check output summary.
4. Last reviewer findings.
5. Artifact directory path.

---

## 7. Artifact Storage

Every `/conduct` run gets a unique run directory:

```text
.pi/conduct/runs/<timestamp>-<slug>/
```

Example:

```text
.pi/conduct/runs/2026-06-20-153012-json-tracing/
```

### 7.1 Artifact Layout

```text
user-prompt.md
config.resolved.json
state.json
plan.raw.md
plan.json
plan.validation.json
iteration-1/
  coder-prompt.md
  coder-response.md
  coder-compliance.json
  git-diff.patch
  git-diff-stat.txt
  checks/
    format.txt
    lint.txt
    test.txt
  review-prompt.md
  review-response.md
  review.json
iteration-2/
  coder-prompt.md
  coder-response.md
  coder-compliance.json
  git-diff.patch
  git-diff-stat.txt
  checks/
    format.txt
    lint.txt
    test.txt
  review-prompt.md
  review-response.md
  review.json
final-summary.md
```

Persist enough information that a user can inspect what happened without trusting model prose.

---

## 8. Git Workspace Policy

Before starting, run:

```bash
git status --porcelain
```

If `requireCleanGit` is true and output is non-empty, abort with a clear message.

Recommended future extension:

```text
/conduct --allow-dirty <prompt>
/conduct --stash <prompt>
/conduct --branch conduct/<slug> <prompt>
```

For MVP, prefer strict clean working tree.

During the run, collect after each implementation/fix iteration:

```bash
git diff --stat
git diff
```

Do not auto-commit.

---

## 9. Check Execution

The supervisor runs configured checks, not the agents.

Run command groups in this order:

1. Format
2. Lint
3. Test

Each command should capture:

```json
{
  "command": "cargo test",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 12345
}
```

Store full outputs in artifact files. Feed summarized outputs to reviewer. If output is short, include full output. If long, include head/tail plus path to full artifact.

---

## 10. Planner Contract

The planner receives:

1. Original user prompt.
2. Repository context summary, if available.
3. Relevant files discovered by read/grep/find.
4. Instruction to produce both Markdown and strict JSON.

### 10.1 Planner Output Requirements

Planner must output:

1. Human-readable plan.
2. Strict JSON block matching `ImplementationPlan` schema.

### 10.2 ImplementationPlan Schema

```ts
export type ImplementationPlan = {
  goal: string;
  assumptions: string[];
  risks: string[];
  filesToInspect: string[];
  filesToModify: Array<{
    path: string;
    reason: string;
    plannedChanges: string[];
  }>;
  filesToCreate: Array<{
    path: string;
    reason: string;
    plannedContentsSummary: string;
  }>;
  typesToCreate: Array<{
    name: string;
    kind: "struct" | "enum" | "type" | "interface" | "trait" | "class" | "function" | "other";
    location: string;
    purpose: string;
    fieldsOrSignature?: string;
  }>;
  controlFlow: string[];
  errorHandling: string[];
  tests: Array<{
    path?: string;
    kind: "unit" | "integration" | "snapshot" | "manual" | "other";
    description: string;
  }>;
  acceptanceCriteria: string[];
  implementationOrder: string[];
};
```

### 10.3 Planner Prompt Template

```text
You are the planner agent for Pi Conduct.

Your job is to design a detailed implementation plan for the user's coding task. Do not modify files. Inspect the repository as needed.

User task:
{{USER_PROMPT}}

Produce:
1. A concise human-readable plan.
2. A strict JSON object matching the ImplementationPlan schema.

ImplementationPlan JSON Schema:
{{IMPLEMENTATION_PLAN_JSON_SCHEMA}}

The plan must be specific enough that a smaller coding model can implement it without re-designing the solution.

Include:
- Files to inspect
- Files to modify
- Files to create
- Types/functions to create or change
- Control flow
- Error handling
- Tests
- Acceptance criteria
- Implementation order

Do not include vague instructions like "update as needed". Be concrete.
```

---

## 11. Coder Contract

The coder receives:

1. Original user prompt.
2. Validated implementation plan JSON.
3. Current iteration number.
4. Previous reviewer feedback, if any.
5. Relevant check failures, if any.

The coder may modify files and run local commands subject to safety policy.

### 11.1 Coder Output Requirements

Coder must produce:

1. A concise implementation summary.
2. A strict JSON compliance report.

### 11.2 CoderCompliance Schema

```ts
export type CoderCompliance = {
  summary: string;
  filesChanged: string[];
  planItemsCompleted: string[];
  planItemsSkipped: Array<{
    item: string;
    reason: string;
  }>;
  reviewerItemsAddressed: Array<{
    item: string;
    status: "addressed" | "partially_addressed" | "not_addressed";
    notes: string;
  }>;
  commandsRun: Array<{
    command: string;
    purpose: string;
  }>;
  knownIssues: string[];
};
```

### 11.3 Coder Prompt Template

```text
You are the coder agent for Pi Conduct.

Your job is to implement the validated plan. Follow the plan closely. Do not redesign unless necessary. If the plan is impossible or unsafe, explain why in the compliance report.

Original user task:
{{USER_PROMPT}}

Implementation plan:
{{PLAN_JSON}}

Current iteration:
{{ITERATION}}

Previous reviewer feedback:
{{REVIEW_FEEDBACK_OR_NONE}}

Relevant check output:
{{CHECK_OUTPUT_OR_NONE}}

CoderCompliance JSON Schema:
{{CODER_COMPLIANCE_JSON_SCHEMA}}

Rules:
- Modify only files needed for the task.
- Keep changes minimal and focused.
- Prefer idiomatic existing project style.
- Add or update tests when the plan calls for it.
- Do not perform destructive shell actions.
- Do not install packages unless explicitly allowed by config.
- At the end, provide a concise summary and a strict JSON CoderCompliance object.
```

---

## 12. Reviewer Contract

The reviewer receives:

1. Original user prompt.
2. Validated implementation plan.
3. Coder compliance report.
4. Git diff.
5. Diff stat.
6. Check outputs.
7. Previous review history, if any.

The reviewer must not edit files.

### 12.1 Reviewer Verdicts

Reviewer must return one of:

```text
approved
needs_changes
blocked
```

Use:

- `approved`: implementation satisfies prompt, plan, and checks.
- `needs_changes`: fixable issues remain.
- `blocked`: cannot proceed without user decision or missing external dependency.

### 12.2 ReviewFinding Schema

```ts
export type ReviewFinding = {
  severity: "blocking" | "important" | "minor";
  file?: string;
  issue: string;
  expectedFix: string;
  rationale: string;
};
```

### 12.3 ReviewResult Schema

```ts
export type ReviewResult = {
  status: "approved" | "needs_changes" | "blocked";
  summary: string;
  findings: ReviewFinding[];
  testsToRun: string[];
  riskNotes: string[];
  approvalRationale?: string;
};
```

### 12.4 Reviewer Prompt Template

```text
You are the reviewer agent for Pi Conduct.

Your job is to review the implementation against the user's original task, the validated implementation plan, the current git diff, the coder compliance report, and check outputs.

Original user task:
{{USER_PROMPT}}

Implementation plan:
{{PLAN_JSON}}

Coder compliance report:
{{CODER_COMPLIANCE_JSON}}

Git diff stat:
{{GIT_DIFF_STAT}}

Git diff:
{{GIT_DIFF}}

Check outputs:
{{CHECK_OUTPUTS}}

Previous review history:
{{REVIEW_HISTORY_OR_NONE}}

Return a strict JSON ReviewResult object.

ReviewResult JSON Schema:
{{REVIEW_RESULT_JSON_SCHEMA}}

Rules:
- Be specific.
- Distinguish blocking issues from minor polish.
- Do not ask for unnecessary changes.
- Do not approve if configured required checks are failing, unless the failures are clearly unrelated and explain why.
- If approved, include approvalRationale.
- If needs_changes, include actionable expectedFix values.
- If blocked, explain exactly what user decision or missing dependency is required.
```

---

## 13. Supervisor Loop

Pseudo-code:

```ts
async function runConductWorkflow(userPrompt: string, ctx: ExtensionContext) {
  const config = await loadAndValidateConfig(ctx.cwd);
  const run = await createRunArtifacts(config, userPrompt);

  await ui.status(ctx, "Conduct: planning");
  const planRaw = await runPlanner(userPrompt, config, ctx, run);
  const plan = await parseAndValidatePlan(planRaw);
  await savePlan(run, planRaw, plan);

  let reviewHistory = [];
  let lastReview = null;
  let lastChecks = null;

  for (let iteration = 1; iteration <= config.loop.maxIterations; iteration++) {
    await ui.status(ctx, `Conduct: implementing iteration ${iteration}`);
    const coderResult = await runCoder({
      userPrompt,
      plan,
      iteration,
      previousReview: lastReview,
      checkOutput: lastChecks,
      config,
      ctx,
      run
    });

    await ui.status(ctx, `Conduct: running checks iteration ${iteration}`);
    const diff = await collectGitDiff();
    const checks = await runConfiguredChecks(config);
    lastChecks = checks;
    await saveIterationArtifacts(run, iteration, coderResult, diff, checks);

    await ui.status(ctx, `Conduct: reviewing iteration ${iteration}`);
    const review = await runReviewer({
      userPrompt,
      plan,
      coderCompliance: coderResult.compliance,
      diff,
      checks,
      reviewHistory,
      config,
      ctx,
      run
    });

    reviewHistory.push(review);
    lastReview = review;
    await saveReview(run, iteration, review);

    const requiredChecksPass = evaluateRequiredChecks(config, checks);
    const hasBlockingFindings = review.findings.some(f => f.severity === "blocking");

    if (
      review.status === "approved" &&
      requiredChecksPass &&
      !hasBlockingFindings
    ) {
      await completeSuccessfully(ctx, run, review, checks);
      return;
    }

    if (review.status === "blocked") {
      await completeBlocked(ctx, run, review, checks);
      return;
    }

    if (iteration >= config.loop.maxIterations) {
      await completeMaxIterations(ctx, run, review, checks);
      return;
    }
  }
}
```

---

## 14. Progress UX

Use stage-level progress, not token-level noise.

Examples:

```text
Conduct: planning with openai/gpt-5.5
Conduct: plan created, 5 files to modify, 2 files to create
Conduct: implementing with ollama/qwen3.5-coder-32b
Conduct: running checks
Conduct: tests failed, sending diff and output to reviewer
Conduct: reviewer found 2 blocking issues and 1 important issue
Conduct: fixing iteration 2/5
Conduct: checks passed
Conduct: reviewer approved
```

Use Pi UI facilities such as status/notify/session entries. Avoid custom widgets in MVP.

---

## 15. Safety Policy

### 15.1 Shell Command Blocking

The extension should inspect `bash` tool calls from coder agents when possible. Block commands matching configured dangerous patterns.

Default blocked patterns:

```text
rm -rf /
rm -rf ~
chmod -R 777
curl ... | sh
wget ... | sh
sudo
```

### 15.2 File Write Restrictions

For MVP, rely on clean git state and diff inspection.

Future improvement: intercept edit/write tool calls and reject writes outside configured paths.

### 15.3 Network and Package Installs

If `allowNetwork` is false, block obvious network commands:

```text
curl
wget
npm install
pnpm install
cargo install
pip install
go get
```

This will not be a perfect sandbox. It is a guardrail. Real isolation should later use containers or another sandbox.

---

## 16. Error Handling

### 16.1 Malformed Planner JSON

Retry planner up to 2 times with a repair prompt:

```text
Your previous response did not contain valid JSON matching the required schema. Return only corrected JSON.
```

If still invalid, abort with artifact path and raw response.

### 16.2 Malformed Reviewer JSON

Retry reviewer up to 2 times with a repair prompt.

If still invalid, treat as `blocked` and present raw response.

### 16.3 Coder Failure

If coder fails or produces no diff:

1. Run checks anyway if meaningful.
2. Ask reviewer whether the failure is recoverable.
3. If recoverable, allow next iteration.
4. Otherwise stop as blocked.

### 16.4 Check Failures

If checks fail and `continueAfterCheckFailure` is true, still run reviewer and include check output.

If checks fail and `continueAfterCheckFailure` is false, stop after checks and summarize.

---

## 17. Final Summary

At successful completion, print:

```text
Conduct completed successfully.

Summary:
- Implemented ...
- Modified ... files
- Added/updated ... tests
- Checks passed: format, lint, test
- Reviewer approved after N iteration(s)

Artifacts:
.pi/conduct/runs/<run-id>/
```

At unsuccessful completion:

```text
Conduct stopped before approval.

Reason:
- Max iterations reached / reviewer blocked / config error / malformed output

Current state:
- Modified files: ...
- Last check status: ...
- Last reviewer findings: ...

Artifacts:
.pi/conduct/runs/<run-id>/
```

---

## 18. Suggested MVP Milestones

### Milestone 1: Command Skeleton

- Register `/conduct`.
- Parse prompt.
- Load config.
- Print progress status.

### Milestone 2: Planner Only

- Create planner SDK session.
- Generate plan.
- Parse and validate plan JSON.
- Persist artifacts.

### Milestone 3: Coder Once

- Create coder SDK session.
- Feed prompt + plan.
- Allow edits.
- Collect git diff.
- Persist artifacts.

### Milestone 4: Checks

- Run configured checks.
- Capture stdout/stderr/exit code/duration.
- Persist check results.

### Milestone 5: Reviewer Once

- Create reviewer SDK session.
- Feed prompt + plan + diff + checks.
- Parse review JSON.
- Persist review.

### Milestone 6: Feedback Loop

- Feed review findings back to coder.
- Repeat until approved or max iterations.

### Milestone 7: Safety Gates

- Require clean git tree.
- Block destructive shell patterns.
- Warn on writes outside repo if detectable.

### Milestone 8: Polish

- Better status messages.
- Final summary.
- Resume/cancel/status subcommands.

---

## 19. Future Commands

Future command surface:

```text
/conduct <prompt>
/conduct status
/conduct resume <run-id>
/conduct cancel
/conduct config
/conduct last
/conduct review
```

MVP only requires:

```text
/conduct <prompt>
```

---

## 20. Important Design Principle

Never let prose be the protocol.

Every major handoff should use explicit structured data:

1. Planner returns `ImplementationPlan`.
2. Coder returns `CoderCompliance`.
3. Reviewer returns `ReviewResult`.
4. Supervisor owns state, git diffs, tests, loop limits, and final stop conditions.

The agents propose, implement, and review. The supervisor decides what happens next.

That is the difference between an engineering system and three chatbots in a trench coat claiming they did a pull request.
