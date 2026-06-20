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
pi install git:github.com/<user>/pi-conduct

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

## Configuration

Create a config file at one of these locations (first match wins):

- `.pi/conduct/config.json`
- `conduct.config.json`

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
| `loop.requirePassingChecks` | Require all configured checks to pass | `true` |
| `loop.continueAfterCheckFailure` | Continue to reviewer even if checks fail | `true` |
| `loop.minorFindingIterationCutoff` | Stop when only minor findings remain past this iteration | `3` |
| `safety.allowNetwork` | Allow network/package-install commands in agent bash | `false` |
| `safety.blockedCommandPatterns` | Extra regex patterns to block in agent bash | `[]` |
| `commands.format` | Format check commands | `[]` |
| `commands.lint` | Lint check commands | `[]` |
| `commands.test` | Test check commands | `[]` |
| `artifacts.root` | Root directory for run artifacts | `.pi/conduct/runs` |

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
  ui.ts           - Progress UI helpers
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
  iterations/
    1/
      coder-prompt.md
      coder-response.md
      coder-compliance.json
      coder-transcript.json
      git-diff.patch
      git-diff-stat.txt
      checks/
        format-*.txt
        lint-*.txt
        test-*.txt
      review-prompt.md
      review-response.md
      review.json
      reviewer-transcript.json
    2/
      ...
  final-summary.md
```

`state.json` persists the workflow state machine (§6) at every stage
transition so a run can be inspected without trusting model prose.

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
- **No auto-commits** — all changes are visible via `git diff`.

This is a guardrail, not a sandbox (§15). Real isolation should later use
containers.

## State Machine

```
Idle -> Initializing -> ValidatingWorkspace -> Planning
  -> ValidatingPlan -> Implementing -> RunningChecks -> Reviewing
  -> (loop: Fixing -> RunningChecks -> Reviewing)
  -> Completed / Failed / NeedsUserIntervention
```
