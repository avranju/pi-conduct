# Pi Conduct Extension

A Pi extension that adds a custom `/conduct` slash command for orchestrated multi-agent coding workflows.

## Overview

The `/conduct` command starts an orchestrated multi-agent coding workflow inside Pi while preserving the existing Pi UX. The visible Pi session remains the cockpit for user interaction and progress updates. The extension acts as a supervisor that creates internal SDK-backed agent sessions for planning, coding, reviewing, fixing, and summarizing.

### Core Workflow

```
User prompt
  -> Supervisor extension
  -> Planner agent using frontier model
  -> Structured implementation plan
  -> Coder agent using configured coding model
  -> Supervisor runs tests/lint/format checks
  -> Reviewer agent using frontier model
  -> Coder agent addresses feedback
  -> Repeat until approved or max iterations reached
  -> Final user summary
```

## Installation

Install as a Pi package (local path, npm, or git):

```bash
# From a local checkout
pi install ./path/to/pi-conduct

# From npm
pi install npm:pi-conduct

# From git
pi install git:github.com/avranju/pi-conduct

# Try without installing (current run only)
pi -e ./path/to/pi-conduct
```

User installs go to `~/.pi/agent/`; add `-l` to install project-locally
into `.pi/` (shared with your team via `.pi/settings.json`, loaded after
project trust).

For development with hot-reload, symlink the package into Pi's global
auto-discovery directory so `/reload` picks up edits:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-conduct
```

## Usage

```
/conduct <task prompt>
```

Example:
```
/conduct Add a new REST endpoint for user registration with email validation
```

Resume an interrupted run with its artifact-directory name:

```
/conduct resume 2026-06-23-143012-add-rest-endpoint
```

If you intentionally want to accept a changed working tree, use:

```
/conduct force-resume 2026-06-23-143012-add-rest-endpoint
```

`force-resume` rebases the run's workspace checkpoint to the current tree and
is recorded in `state.json`. It still refuses a changed Git `HEAD`; use it only
when all current changes are intentionally part of the recovery baseline.

Because Pi does not normally render extension slash commands in the chat, the
task text is persisted and rendered as a normal user message before Conduct
starts showing progress. It remains available when scrolling back or reopening
the session and does not trigger a separate parent-agent turn.

While a run is active, Conduct shows a fixed progress widget above the editor.
Planning and every implementation/review iteration have their own row. The
active row is highlighted and has a live, subdued activity label underneath;
the major-step row includes elapsed time, and completed rows retain their final
duration and remain visible with a green checkmark. Each agent-backed row also
shows its provider, model, and configured thinking level in subdued styling.

Press the configured live-output keybinding to open the active sub-agent's live
output. The default is `F12` on macOS and `Ctrl+Alt+D` elsewhere. The detail view
continues updating while the agent works; use the arrow or page keys to scroll,
`End` to follow the latest output, and `Esc` or the live-output keybinding to
close it.

Outside the detail view, press `Esc` to request cancellation of the complete
Conduct workflow. Confirm the prompt to cancel; declining or dismissing it
leaves the workflow running. Confirmed cancellation propagates to the active
planner/coder/reviewer session and to any configured check command that is
currently running. File changes already made are retained.
Cancelled runs and runs interrupted by provider, quota, billing, authentication,
or unexpected runtime errors retain a resumable checkpoint. If Pi quits or
crashes, `/conduct resume <run-id>` also detects the abandoned `running` state
from the stale run lock and persisted artifacts. Conduct restarts the interrupted
stage from persisted structured artifacts; it does not attempt to continue a
partial token stream or tool call. Partial workspace changes from an abandoned,
in-flight coder are retained and reconciled by the restarted coder, provided
`HEAD` has not changed; changes while any non-writing or pending stage was
active are still rejected.

When the workflow ends, Conduct copies the final progress rows into the final
chat summary and removes the live widget. Subsequent Pi messages therefore
render beneath the summary instead of accumulating above fixed progress rows.

## Configuration

Configuration is loaded from these locations, with the repository configuration
overriding matching global settings:

- `~/.pi/agent/conduct/config.json`
- `<repo>/.pi/conduct/config.json`

`keybindings.liveOutput` may be a single key string or an array of key strings.
If you change it while pi is already running, run `/reload` to refresh the
registered global shortcut. Active Conduct runs also listen for the configured
shortcut from the run's resolved config.

### Example Config

```json
{
  "models": {
    "planner": {
      "provider": "openai",
      "model": "gpt-5.2",
      "thinkingLevel": "high"
    },
    "coder": {
      "provider": "openai",
      "model": "gpt-4o",
      "thinkingLevel": "off"
    },
    "reviewer": {
      "provider": "openai",
      "model": "gpt-5.2",
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
  "safety": {
    "allowNetwork": false,
    "blockedCommandPatterns": []
  },
  "retry": {
    "enabled": true,
    "maxRetries": 4,
    "baseDelayMs": 2000,
    "maxDelayMs": 30000,
    "timeoutMs": 180000,
    "retryableErrorPatterns": []
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
  },
  "keybindings": {
    "liveOutput": ["f12"]
  }
}
```

### Config Options

| Option | Description | Default |
|--------|-------------|---------|
| `models.planner.provider` | Model provider for planning | `openai` |
| `models.planner.model` | Model name for planning | `gpt-5.2` |
| `models.planner.thinkingLevel` | Thinking level for planning | `high` |
| `models.coder.provider` | Model provider for coding | `openai` |
| `models.coder.model` | Model name for coding | `gpt-4o` |
| `models.coder.thinkingLevel` | Thinking level for coding | `off` |
| `models.reviewer.provider` | Model provider for reviewing | `openai` |
| `models.reviewer.model` | Model name for reviewing | `gpt-5.2` |
| `models.reviewer.thinkingLevel` | Thinking level for reviewing | `high` |
| `loop.maxIterations` | Max coder/reviewer loop iterations | `5` |
| `loop.requireCleanGit` | Require clean git working tree | `true` |
| `loop.requireApproval` | Require reviewer approval | `true` |
| `loop.requirePassingChecks` | Require all configured checks to pass | `false` |
| `loop.continueAfterCheckFailure` | Continue to reviewer even if checks fail | `true` |
| `loop.minorFindingIterationCutoff` | Stop when only minor findings remain past this iteration | `3` |
| `safety.allowNetwork` | Allow network/package-install commands in agent bash | `false` |
| `safety.blockedCommandPatterns` | Extra regex patterns to block in agent bash | `[]` |
| `retry.enabled` | Retry transient model/transport failures (e.g. a crashed local inference server) before giving up on an agent turn | `true` |
| `retry.maxRetries` | Max retry attempts after the initial failure (0 disables) | `4` |
| `retry.baseDelayMs` | Base delay before the first retry; doubles each attempt up to `maxDelayMs` | `2000` |
| `retry.maxDelayMs` | Cap on the delay between retries | `30000` |
| `retry.timeoutMs` | Wall-clock budget across all retries for a turn (0 = no budget) | `180000` |
| `retry.retryableErrorPatterns` | Extra case-insensitive regex patterns classifying an error as transient | `[]` |
| `commands.format` | Format check commands | `[]` |
| `commands.lint` | Lint check commands | `[]` |
| `commands.test` | Test check commands | `[]` |
| `artifacts.root` | Root directory for run artifacts | `.pi/conduct/runs` |
| `keybindings.liveOutput` | Key(s) to open/close live sub-agent output | macOS: `["f12"]`; other platforms: `["ctrl+alt+d"]` |

## Architecture

```
src/
  index.ts        - Entry point, registers /conduct command
  config.ts       - Config loading and validation
  supervisor.ts   - Main workflow orchestrator (state machine + loop)
  agents.ts       - Planner, Coder, and Reviewer AgentSession management
  prompts.ts      - Prompt templates for each agent role
  schemas.ts      - TypeScript type definitions and config defaults
  validation.ts   - Strict schema validation for agent JSON outputs
  safe-bash.ts    - Guarded "bash" tool that enforces the safety policy
  git.ts          - Git utility functions
  checks.ts       - Check execution (format, lint, test)
  artifacts.ts    - Artifact storage and run-state persistence
  ui.ts           - Persistent progress widget and live-output viewer
  utils.ts        - Utility functions (JSON extraction, safety patterns)
```

The package is declared via the `pi` manifest in `package.json`
(`pi.extensions: ["./src/index.ts"]`).

Each role runs in its **own isolated Pi SDK `AgentSession`** with a
role-specific tool set: the planner inspects the repo (`read`/`grep`/`find`/
`ls`/`bash`), the coder edits files (`read`/`edit`/`write`/`bash`/`grep`/
`find`/`ls`), and the reviewer is structurally read-only
(`read`/`grep`/`find`/`ls`/`bash` — no `edit`/`write`). Sub-sessions load no
host extensions/skills/prompts (so they cannot recurse into `/conduct`) but do
load project context files (`AGENTS.md`). Every agent handoff returns strict
JSON that is validated against the schemas in `src/validation.ts` before the
supervisor proceeds.

## Artifact Storage

Every `/conduct` run gets a unique run directory:

```
.pi/conduct/runs/<timestamp>-<slug>/
  user-prompt.md
  config.resolved.json
  state.json
  planner-prompt.md
  planner-transcript.json
  plan.raw.md
  plan.json
  plan.validation.json
  iteration-1/
    coder-prompt.md
    coder-response.md
    coder-compliance.json
    coder-transcript.json
    git-diff.patch
    git-diff-stat.txt
    checks/
      format.txt
      lint.txt
      test.txt
      results.json
    review-prompt.md
    review-response.md
    review.json
    reviewer-transcript.json
    attempt-2/
      ... artifacts produced by a resumed attempt ...
  iteration-2/
    ...
  final-summary.md
```

`state.json` persists workflow status separately from the active work stage,
the next resumable action, attempt number, repository identity, and a workspace
fingerprint. JSON checkpoints are written with an atomic replace. Resume is
rejected if the repository or working tree changed after interruption, except
for partial changes made while an abandoned, in-flight coder was active; the
original Git `HEAD` must still match in every case. A per-run lock prevents concurrent
execution. Completed artifacts are reused; an interrupted coder is restarted
with explicit recovery context so it inspects and reconciles any partial file
changes already present.

## Safety Policy

- **Clean git tree required** by default before a run starts (§8).
- **Dangerous shell commands are always blocked** in agent `bash` calls
  (`rm -rf /`, `rm -rf ~`, `chmod -R 777`, `curl|sh`, `sudo`, fork bombs,
  `dd of=/dev/`, `mkfs`, …). Implemented as a guarded `bash` tool
  (`src/safe-bash.ts`) that overrides the built-in for every role.
- **Network / package installs blocked** when `safety.allowNetwork` is `false`
  (default): `curl`, `wget`, `npm/pnpm/yarn/cargo/pip/uv/go/brew/apt/dnf/
  pacman/gem/composer install`, `git clone`.
- Additional block patterns can be added via `safety.blockedCommandPatterns`
  (regex strings).
- **No auto-commits** — all tracked, staged, and untracked file changes are captured in Conduct diff artifacts.

This is a guardrail, not a sandbox (§15). Real isolation should later use
containers.

## Transient Error Retries

When a locally hosted model server (e.g. llama.cpp) crashes or restarts
mid-inference, the request fails with a transient transport error (connection
refused, socket hang up, 5xx, fetch failed, …). By default such failures used
to end the Conduct run, leaving it to be resumed manually with
`/conduct resume`.

Conduct now retries these transient failures before giving up. Two layers
cooperate:

- **In-turn retry (Pi SDK).** Each role session inherits the SDK's own
  auto-retry, which absorbs quick blips within a single agent turn and
  preserves any in-flight tool work.
- **Outer retry (Conduct, §16.5).** When the SDK gives up on a retryable
  error, Conduct recreates the role session and re-issues the prompt with
  exponential backoff capped by `retry.maxDelayMs` and bounded by a
  `retry.timeoutMs` wall-clock budget. This comfortably covers a 20–30s
  local-server restart.

Non-transient failures (authentication errors, quota/billing exhaustion,
context overflow, malformed agent output) are never retried — retrying would
not help and only delays surfacing the real problem. When retries are
exhausted the run is still left in the resumable `interrupted` state, so
`/conduct resume` remains available for outages longer than the budget.

Retries surface in the progress widget ("*Coder hit a transient error
(2/5); retrying in 2.0s…*") and in the live sub-agent output view as
`[transient-retry]` entries. Tune the behaviour with the `retry.*` config
options; add provider-specific strings to `retry.retryableErrorPatterns` if
your local server reports a transient error Conduct does not already
recognise.

## State Machine

```
status=running:
  Planning -> ValidatingPlan -> Implementing -> RunningChecks -> Reviewing
    -> (loop: Fixing -> RunningChecks -> Reviewing)

terminal status:
  Completed / Failed / NeedsUserIntervention

resumable status:
  Interrupted (retains the active stage and next action)
```
