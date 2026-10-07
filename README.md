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

Requires **Pi 1.0.4 or newer** and **Node.js 22.19.0 or newer**. Pi libraries and
TypeBox are host-provided peer dependencies, not bundled runtime copies.

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

The parent session must be idle, with no queued messages, before Conduct starts.
Only one Conduct workflow may own a working tree at a time, including across Pi
instances. Parent input, tool calls, and session-tree navigation are blocked
while it runs. Quitting, switching sessions, or reloading Pi aborts Conduct and
waits for its checkpoints, role-session shutdown hooks, and lock cleanup.

While a run is active, Conduct shows a fixed progress widget above the editor.
The last six steps remain visible; the full history is retained in the final
result. Each row includes elapsed time and the agent's provider, model, and
thinking level. With routing enabled, the model updates to the physical model
that actually answered. Colors are resolved at render time for theme changes.

Press the configured live-output keybinding to open the active sub-agent's live
output. The default is `F12` on macOS and `Ctrl+Alt+D` elsewhere. The detail view
continues updating while the agent works. It uses Pi's native scroll view and
fullscreen layout, with follow-end behavior, mouse scrolling, scrollbars, and
terminal-size-aware clipping. Use Pi's configured selection/page keys to scroll,
`Home`/`End` to jump to the start/follow the latest output, and the configured
selection-cancel key (normally `Esc`) or live-output shortcut to close it. The
header shows current-session and aggregate run token/cost statistics.

Outside the detail view, press Pi's interrupt key (normally `Esc`) to request cancellation of the complete
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

When the workflow ends, Conduct persists a rendered **result card** in the parent
session and removes the live widget. The card survives session reopening and
contains the outcome, modified files, checks, review, artifacts, resume command,
progress history, and usage. Expand it with Pi's entry-expansion binding for the
full summary and per-session details. A separate compact, hidden custom message
provides the parent agent with the outcome **without starting an agent turn**.

## Configuration

Configuration is loaded from these locations, with the repository configuration
overriding matching global settings:

- `~/.pi/agent/conduct/config.json`
- `<repo>/.pi/conduct/config.json` (only after Pi trusts the repository)

Untrusted repositories use global configuration and safe defaults. Resuming a
saved resolved configuration requires a trusted repository, because the saved
config can include executable checks and MCP server commands.

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
  "sessions": {
    "inheritSettings": true,
    "inheritProviders": true
  },
  "capabilities": {
    "codemode": { "enabled": false, "mode": "on", "inlineBudget": 3000 },
    "mcp": {
      "enabled": false,
      "servers": {},
      "tools": { "planner": [], "coder": [], "reviewer": [] }
    }
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
| `models.<role>.routing.continuation` | Physical provider/model/thinking selection for continuations and direct summary requests | unset |
| `models.<role>.routing.fallback` | Sticky physical fallback for transient request failures, including outer retries | unset |
| `sessions.inheritSettings` | Copy selected host transport, shell, compaction, retry, rendering and cache settings | `true` |
| `sessions.inheritProviders` | Copy selected provider registrations and runtime API-key overrides | `true` |
| `capabilities.codemode.enabled` | Enable JavaScript tool batching within each role's allowlist | `false` |
| `capabilities.codemode.mode` | `on` preserves direct tools; `only` exposes non-model-only tools through codemode | `on` |
| `capabilities.codemode.inlineBudget` | Estimated token budget for inline tool declarations | `3000` |
| `capabilities.mcp.enabled` | Enable explicitly configured MCP servers | `false` |
| `capabilities.mcp.servers` | Named Pi MCP connection configs (`command`/`args` or `url`, optional env/headers/auth) | `{}` |
| `capabilities.mcp.tools.<role>` | Exact fully qualified MCP tool names permitted for that role; no wildcards | `[]` |
| `commands.format` | Format check commands | `[]` |
| `commands.lint` | Lint check commands | `[]` |
| `commands.test` | Test check commands | `[]` |
| `artifacts.root` | Root directory for run artifacts | `.pi/conduct/runs` |
| `keybindings.liveOutput` | Key(s) to open/close live sub-agent output | macOS: `["f12"]`; other platforms: `["ctrl+alt+d"]` |

### Provider integration and optional model routing

One dedicated `ModelRuntime` is reused for a workflow's role sessions and retries.
Built-in providers and `models.json` work as before. By default, Conduct also
copies the public native/extension registrations of configured providers from
the parent, including runtime API-key overrides. OAuth stays on Pi's request-time
credential path. It does **not** inherit arbitrary host extension factories,
tools, commands, or opaque virtual routers.

Selected host settings are inherited; resource/package paths, tool defaults,
session paths, and trust decisions are not. Host SDK retry settings and Conduct's
outer `retry.*` policy remain separate. Set either inheritance flag to `false`
for a more independent runtime.

Optional routing uses physical catalog targets. For example:

```json
{
  "models": {
    "planner": {
      "provider": "openai",
      "model": "gpt-5.2",
      "thinkingLevel": "high",
      "routing": {
        "continuation": { "provider": "openai", "model": "gpt-4o", "thinkingLevel": "off" },
        "fallback": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "medium" }
      }
    }
  }
}
```

Choose model IDs available in your catalog and authenticate all targets before
starting. Every routing target is validated up front. Continuation/fallback
choices are sticky within a session. Fallback only applies to classified
transient failures, not authentication, billing, or context errors. Replacement
sessions also start on the fallback after transient outer retries. Thinking levels
use Pi's exported type, including `max`; Pi clamps them to model capabilities.

### Opt-in codemode and MCP

Both capabilities default to **disabled**, including for older saved runs.
Codemode runs tool-batching JavaScript in Pi's QuickJS sandbox; it cannot make a
planner/reviewer access `edit` or `write`, bypass guarded bash, or call a
non-allowlisted MCP tool. Conduct disables codemode's model catalog/classifier/
image-model API to avoid another route around role boundaries. Handoff tools
remain direct, model-only tools even in `mode: "only"`.

MCP configuration is explicit, never discovered from host `mcp.json` or host
extensions. For example:

```json
{
  "capabilities": {
    "codemode": { "enabled": true, "mode": "on" },
    "mcp": {
      "enabled": true,
      "servers": {
        "docs": { "command": "node", "args": ["/absolute/path/to/docs-mcp-server.js"] }
      },
      "tools": {
        "planner": ["mcp__docs__search"],
        "coder": ["mcp__docs__search"],
        "reviewer": ["mcp__docs__search"]
      }
    }
  }
}
```

Use the server's actual Pi-normalized fully qualified tool names. Server names
must use letters, digits, underscores or hyphens; normalization collisions are
rejected. Only servers needed by a role are started. Planner/reviewer calls must
also declare MCP `readOnlyHint: true` and must not declare
`destructiveHint: true`; missing metadata denies the call. These checks apply to
direct calls **and** indirect codemode calls. Shared MCP resource tools are
excluded, so they cannot sidestep the exact allowlist. HTTP servers additionally
require `safety.allowNetwork: true`.

Allowlisting is not a sandbox: MCP servers are trusted processes/services, and
safety hints are claims by the server. A stdio server may itself use the network
or modify files regardless of `safety.allowNetwork`. Use servers you trust, with
their own isolation and least-privilege credentials. Conduct awaits MCP shutdown
hooks before disposing each role session.

## Architecture

```
src/
  index.ts        - Entry point, registers /conduct command
  config.ts       - Config loading and validation
  supervisor.ts   - Main workflow orchestrator (state machine + loop)
  agents.ts       - Isolated role sessions, retries, cancellation and disposal
  runtime.ts      - Shared providers/settings, routing and codemode/MCP allowlists
  handoffs.ts     - Schema-backed terminal handoff tools
  lifecycle.ts    - Active-workflow ownership and awaited shutdown
  results.ts      - Durable parent-session result cards and compact agent context
  usage.ts        - Token/cost ledger persisted across retries and resumes
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
`find`/`ls`), and the reviewer exposes no `edit`/`write`, but ordinary shell commands
are not an OS-level read-only sandbox. Sub-sessions load no host
extensions/skills/prompts (so they cannot recurse into `/conduct`) but do load
project context files (`AGENTS.md`) and Conduct-owned capability extensions.

Planner/coder/reviewer submit results through `submit_plan`, `submit_compliance`,
and `submit_review`. These tools validate their JSON Schema and semantic rules,
then terminate the role turn. They must be called alone, after other tools have
finished; mixed batches are rejected. Invalid submissions can be corrected,
with up to two additional repair prompts. Strict prose/fenced JSON parsing is
retained as a compatibility fallback for older prompts/providers. Existing
structured artifacts and the version-1 workflow checkpoint format are preserved.

## Artifact Storage

Every `/conduct` run gets a unique run directory:

```
.pi/conduct/runs/<timestamp>-<slug>/
  user-prompt.md
  config.resolved.json
  state.json
  usage.json
  sessions/
    <session-id>.json           # full raw messages, including retry errors
    <session-id>.entries.json   # complete entries, compaction and usage metadata
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
resumes, and `pi-conduct.lock` in the worktree's Git directory prevents different
Conduct runs from sharing the working tree. Stale PID locks are recoverable;
fresh incomplete locks require a brief retry. These locks do not control other
editors or non-Conduct processes. Completed artifacts are reused; an interrupted coder is restarted
with explicit recovery context so it inspects and reconciles any partial file
changes already present.

`usage.json` records reported tokens/cache usage, estimated cost, physical models,
and session references for every finished attempt, including failed/retried ones.
It is deduplicated by session ID and atomically replaced. Resume carries prior
usage forward. Full transcript messages preserve model, usage, errors, tool
results, and nested-call metadata. Per-session entry snapshots also retain
compaction/context-edit boundaries and usage entries. `artifacts.keepTranscripts: false` disables
run-directory transcript copies, not Pi's underlying role-session files. Treat
all artifacts as sensitive; tool outputs can contain source or credentials.

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
  preserves completed tool work.
- **Outer retry (Conduct, §16.5).** When the SDK gives up on a retryable
  error, Conduct recreates the role session and re-issues the prompt with
  exponential backoff capped by `retry.maxDelayMs` and bounded by a
  `retry.timeoutMs` retry-loop budget. The budget gates subsequent attempts and
  bounds backoff; it is not an absolute timeout for an in-flight model request.
  Replacement coders inspect and reconcile partial edits instead of blindly
  repeating mutations.

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

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Development dependencies pin Pi 1.0.4. CI checks Node 22/24 with the pinned SDK
and the latest published SDK. Tests exercise actual isolated SDK sessions with a
synthetic streaming provider, real edits/checks and workflow resume, a local
stdio MCP server, codemode guardrails, structured handoffs, routing, durable
session results, usage, lifecycle ownership, and native TUI sizing. They require
no model credentials and make no billed provider requests. A live provider and
terminal smoke test is still useful before release.

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
