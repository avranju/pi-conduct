// ============================================================================
// Agent Communication (§5)
//
// Each role (planner, coder, reviewer) runs in its OWN isolated Pi SDK
// AgentSession with a role-specific tool set. This is what makes Conduct an
// engineering system rather than three chatbots: the planner actually inspects
// the repo (read/grep/find), the coder actually edits files (edit/write/bash),
// and the reviewer is structurally read-only (no edit/write tools). Every
// handoff returns strict structured JSON that is schema-validated before the
// supervisor proceeds (§20).
// ============================================================================

import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionCommandContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  ConductConfig,
  CoderCompliance,
  ImplementationPlan,
  ModelConfig,
  ReviewResult,
  SafetyConfig,
} from "./schemas.js";
import {
  validateCoderCompliance,
  validateImplementationPlan,
  validateReviewResult,
  type ValidationResult,
} from "./validation.js";
import { createSafeBashTool } from "./safe-bash.js";
import { buildPlannerRepairPrompt, buildReviewerRepairPrompt } from "./prompts.js";
import { parseJson, isTransientModelError, retryDelayFor, sleep } from "./utils.js";
import type { RetryConfig } from "./schemas.js";

export interface AgentProgressObserver {
  observeAgent(session: AgentSession): () => void;
  /**
   * Called when a transient model/transport failure is about to be retried by
   * the outer Conduct retry layer (§16.5). This is distinct from the Pi SDK's
   * in-turn `auto_retry_start` event, which fires for retries within a single
   * agent turn. Optional; observers may ignore it.
   */
  onTransientRetry?(info: {
    role: string;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }): void;
}

// --- Role tool sets (§5) ---

const PLANNER_TOOLS = ["read", "grep", "find", "ls", "bash"];
const CODER_TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"];
const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "bash"];

const MAX_JSON_RETRIES = 2;

// ============================================================================
// Session factory
// ============================================================================

/**
 * Create an isolated AgentSession for a role.
 *
 * - Uses a persistent session manager so role sessions are recorded in Pi's
 *   global session store.
 * - Loads NO host extensions/skills/prompts/themes, so sub-agents cannot
 *   recurse into /conduct or pick up unrelated tools. Project context files
 *   (AGENTS.md) are still loaded so agents follow repo conventions.
 * - Registers a safe "bash" custom tool that overrides the built-in and
 *   enforces the conduct safety policy (§15).
 */
async function createRoleSession(
  ctx: ExtensionCommandContext,
  roleConfig: ModelConfig,
  tools: string[],
  safety: SafetyConfig,
): Promise<AgentSession> {
  const model = ctx.modelRegistry.find(roleConfig.provider, roleConfig.model);
  if (!model) {
    throw new Error(
      `Configured model not found: ${roleConfig.provider}/${roleConfig.model}`,
    );
  }

  const authStorage = AuthStorage.create();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const safeBash: ToolDefinition = createSafeBashTool(ctx.cwd, safety);

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: roleConfig.thinkingLevel,
    tools,
    customTools: [safeBash],
    resourceLoader: loader,
    sessionManager: SessionManager.create(ctx.cwd),
    settingsManager,
  });

  return session;
}

/**
 * Wire a parent abort signal to a session so cancelling the workflow aborts
 * the in-flight agent turn. Returns a cleanup function.
 */
function wireAbort(session: AgentSession, parentSignal: AbortSignal | undefined): () => void {
  if (!parentSignal) return () => {};
  if (parentSignal.aborted) {
    session.abort();
    return () => {};
  }
  const onAbort = () => session.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onAbort);
}

// ============================================================================
// Message helpers
// ============================================================================

/**
 * Concatenate text content of the last assistant message in the transcript
 * that produced any text. Returns "" if none.
 */
function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: string;
      content?: ReadonlyArray<{ type?: string; text?: string }>;
    } | undefined;
    if (m && m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((c) => c?.type === "text")
        .map((c) => c?.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/**
 * Serialize the full agent transcript for artifact persistence.
 */
export function serializeTranscript(messages: readonly unknown[]): string {
  return JSON.stringify(
    messages.map((m) => {
      const msg = m as { role?: string; content?: unknown; timestamp?: number };
      return {
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
      };
    }),
    null,
    2,
  );
}

// ============================================================================
// Transient retry wrapper (§16.5)
// ============================================================================

/**
 * Minimum shape of an agent run result that the retry wrapper can inspect.
 * All of PlannerResult / CoderResult / ReviewerResult satisfy this.
 */
interface RetryableResult {
  interrupted?: boolean;
  errors?: string[];
}

function extractErrorMessage(result: RetryableResult | undefined, thrown: unknown): string {
  if (result?.errors && result.errors.length > 0) return result.errors[0]!;
  if (thrown instanceof Error) return thrown.message;
  if (thrown !== undefined) return String(thrown);
  return "Unknown error";
}

/**
 * Run an agent attempt, retrying transient model/transport failures with
 * exponential backoff (capped by `retry.maxDelayMs`) and bounded by
 * `retry.timeoutMs`. Each attempt runs in a fresh role session created by
 * `runAttempt`; a fresh session also resets the Pi SDK's own in-turn retry
 * budget, so quick blips are absorbed within a turn and longer outages (e.g.
 * a local inference server restarting) are covered by this outer layer.
 *
 * Non-transient failures (auth, quota, context overflow, malformed output)
 * are returned/thrown immediately without retry.
 */
export async function withTransientRetry<T extends RetryableResult>(
  role: string,
  runAttempt: (attempt: number) => Promise<T>,
  retry: RetryConfig,
  signal: AbortSignal | undefined,
  progress?: AgentProgressObserver,
): Promise<T> {
  const maxAttempts = retry.enabled && retry.maxRetries > 0 ? retry.maxRetries + 1 : 1;
  const startedAt = Date.now();
  const budgetMs = retry.timeoutMs > 0 ? retry.timeoutMs : Number.POSITIVE_INFINITY;

  let lastResult: T | undefined;
  let lastThrown: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      if (lastResult !== undefined) return lastResult;
      throw lastThrown;
    }

    let transient = false;
    try {
      lastResult = await runAttempt(attempt);
      lastThrown = undefined;
      transient =
        lastResult.interrupted === true &&
        isTransientModelError(lastResult.errors?.[0], retry.retryableErrorPatterns);
      if (!transient) return lastResult;
    } catch (err) {
      lastThrown = err;
      lastResult = undefined;
      const message = err instanceof Error ? err.message : String(err);
      transient = isTransientModelError(message, retry.retryableErrorPatterns);
      if (!transient) throw err;
    }

    // Transient failure — decide whether to retry.
    const isLastAttempt = attempt >= maxAttempts;
    const elapsed = Date.now() - startedAt;
    if (isLastAttempt || elapsed >= budgetMs) {
      if (lastResult !== undefined) return lastResult;
      throw lastThrown;
    }

    const reason = extractErrorMessage(lastResult, lastThrown);
    let delayMs = retryDelayFor(attempt, retry);
    const remainingBudget = budgetMs - elapsed;
    if (Number.isFinite(remainingBudget) && delayMs > remainingBudget) {
      delayMs = Math.max(0, remainingBudget);
    }

    progress?.onTransientRetry?.({
      role,
      nextAttempt: attempt + 1,
      maxAttempts,
      delayMs,
      reason,
    });

    await sleep(delayMs, signal);
    if (signal?.aborted) {
      if (lastResult !== undefined) return lastResult;
      throw lastThrown;
    }
  }

  // Loop exited without a verdict (e.g. budget exhausted between iterations).
  if (lastResult !== undefined) return lastResult;
  throw lastThrown;
}

// ============================================================================
// Planner Agent
// ============================================================================

export interface PlannerResult {
  rawResponse: string;
  plan: ImplementationPlan | null;
  valid: boolean;
  errors?: string[];
  transcript: string;
  interrupted?: boolean;
}

export async function runPlanner(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress?: AgentProgressObserver,
): Promise<PlannerResult> {
  return withTransientRetry(
    "planner",
    (attempt) => runPlannerAttempt(prompt, config, ctx, signal, progress, attempt),
    config.retry,
    signal,
    progress,
  );
}

async function runPlannerAttempt(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress: AgentProgressObserver | undefined,
  _attempt: number,
): Promise<PlannerResult> {
  const session = await createRoleSession(ctx, config.models.planner, PLANNER_TOOLS, config.safety);
  const cleanup = wireAbort(session, signal);
  const stopObserving = progress?.observeAgent(session) ?? (() => {});

  try {
    await session.prompt(prompt);
    let text = lastAssistantText(session.agent.state.messages);

    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage) {
      return {
        rawResponse: text,
        plan: null,
        valid: false,
        errors: [`Planner agent error: ${errorMessage}`],
        transcript: serializeTranscript(session.agent.state.messages),
        interrupted: true,
      };
    }

    let parsed = parseJson<ImplementationPlan>(text);
    let validation: ValidationResult = parsed
      ? validateImplementationPlan(parsed)
      : { valid: false, errors: ["Could not parse JSON from planner response"] };

    for (
      let attempt = 0;
      attempt < MAX_JSON_RETRIES && !validation.valid && !signal?.aborted;
      attempt++
    ) {
      await session.prompt(buildPlannerRepairPrompt(validation.errors));
      const repairError = session.agent.state.errorMessage;
      if (repairError) {
        return {
          rawResponse: text,
          plan: null,
          valid: false,
          errors: [`Planner agent error: ${repairError}`],
          transcript: serializeTranscript(session.agent.state.messages),
          interrupted: true,
        };
      }
      text = lastAssistantText(session.agent.state.messages);
      parsed = parseJson<ImplementationPlan>(text);
      validation = parsed
        ? validateImplementationPlan(parsed)
        : { valid: false, errors: ["Could not parse JSON from planner response"] };
    }

    return {
      rawResponse: text,
      plan: parsed,
      valid: validation.valid,
      errors: validation.valid ? undefined : validation.errors,
      transcript: serializeTranscript(session.agent.state.messages),
    };
  } finally {
    stopObserving();
    cleanup();
    session.dispose();
  }
}

// ============================================================================
// Coder Agent
// ============================================================================

export interface CoderResult {
  rawResponse: string;
  compliance: CoderCompliance | null;
  valid: boolean;
  errors?: string[];
  transcript: string;
  interrupted?: boolean;
}

const FALLBACK_COMPLIANCE: CoderCompliance = {
  summary: "(could not parse compliance report)",
  filesChanged: [],
  planItemsCompleted: [],
  planItemsSkipped: [],
  reviewerItemsAddressed: [],
  commandsRun: [],
  knownIssues: ["Could not parse CoderCompliance JSON from response"],
};

export async function runCoder(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress?: AgentProgressObserver,
): Promise<CoderResult> {
  return withTransientRetry(
    "coder",
    (attempt) => runCoderAttempt(prompt, config, ctx, signal, progress, attempt),
    config.retry,
    signal,
    progress,
  );
}

async function runCoderAttempt(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress: AgentProgressObserver | undefined,
  _attempt: number,
): Promise<CoderResult> {
  const session = await createRoleSession(ctx, config.models.coder, CODER_TOOLS, config.safety);
  const cleanup = wireAbort(session, signal);
  const stopObserving = progress?.observeAgent(session) ?? (() => {});

  try {
    await session.prompt(prompt);
    let text = lastAssistantText(session.agent.state.messages);

    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage) {
      return {
        rawResponse: text,
        compliance: null,
        valid: false,
        errors: [`Coder agent error: ${errorMessage}`],
        transcript: serializeTranscript(session.agent.state.messages),
        interrupted: true,
      };
    }

    let parsed = parseJson<CoderCompliance>(text);
    let validation: ValidationResult = parsed
      ? validateCoderCompliance(parsed)
      : { valid: false, errors: ["Could not parse JSON from coder response"] };

    for (
      let attempt = 0;
      attempt < MAX_JSON_RETRIES && !validation.valid && !signal?.aborted;
      attempt++
    ) {
      await session.prompt(
        `Your previous response did not contain valid CoderCompliance JSON.\nErrors:\n${validation.errors.join("\n")}\n\nReturn only the corrected JSON in a markdown code block with the language "json".`,
      );
      const repairError = session.agent.state.errorMessage;
      if (repairError) {
        return {
          rawResponse: text,
          compliance: null,
          valid: false,
          errors: [`Coder agent error: ${repairError}`],
          transcript: serializeTranscript(session.agent.state.messages),
          interrupted: true,
        };
      }
      text = lastAssistantText(session.agent.state.messages);
      parsed = parseJson<CoderCompliance>(text);
      validation = parsed
        ? validateCoderCompliance(parsed)
        : { valid: false, errors: ["Could not parse JSON from coder response"] };
    }

    if (!validation.valid || !parsed) {
      return {
        rawResponse: text,
        compliance: FALLBACK_COMPLIANCE,
        valid: false,
        errors: validation.errors,
        transcript: serializeTranscript(session.agent.state.messages),
      };
    }

    return {
      rawResponse: text,
      compliance: parsed,
      valid: true,
      transcript: serializeTranscript(session.agent.state.messages),
    };
  } finally {
    stopObserving();
    cleanup();
    session.dispose();
  }
}

// ============================================================================
// Reviewer Agent
// ============================================================================

export interface ReviewerResult {
  rawResponse: string;
  review: ReviewResult;
  valid: boolean;
  errors?: string[];
  transcript: string;
  interrupted?: boolean;
}

export async function runReviewer(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress?: AgentProgressObserver,
): Promise<ReviewerResult> {
  return withTransientRetry(
    "reviewer",
    (attempt) => runReviewerAttempt(prompt, config, ctx, signal, progress, attempt),
    config.retry,
    signal,
    progress,
  );
}

async function runReviewerAttempt(
  prompt: string,
  config: ConductConfig,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  progress: AgentProgressObserver | undefined,
  _attempt: number,
): Promise<ReviewerResult> {
  const session = await createRoleSession(ctx, config.models.reviewer, REVIEWER_TOOLS, config.safety);
  const cleanup = wireAbort(session, signal);
  const stopObserving = progress?.observeAgent(session) ?? (() => {});

  try {
    await session.prompt(prompt);
    let text = lastAssistantText(session.agent.state.messages);

    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage) {
      return {
        rawResponse: text,
        review: {
          status: "blocked",
          summary: `Reviewer agent error: ${errorMessage}`,
          findings: [],
          testsToRun: [],
          riskNotes: ["Reviewer agent failed to complete"],
        },
        valid: false,
        errors: [`Reviewer agent error: ${errorMessage}`],
        transcript: serializeTranscript(session.agent.state.messages),
        interrupted: true,
      };
    }

    let parsed = parseJson<ReviewResult>(text);
    let validation: ValidationResult = parsed
      ? validateReviewResult(parsed)
      : { valid: false, errors: ["Could not parse JSON from reviewer response"] };

    for (
      let attempt = 0;
      attempt < MAX_JSON_RETRIES && !validation.valid && !signal?.aborted;
      attempt++
    ) {
      await session.prompt(buildReviewerRepairPrompt(validation.errors));
      const repairError = session.agent.state.errorMessage;
      if (repairError) {
        return {
          rawResponse: text,
          review: {
            status: "blocked",
            summary: `Reviewer agent error: ${repairError}`,
            findings: [],
            testsToRun: [],
            riskNotes: ["Reviewer agent failed to complete"],
          },
          valid: false,
          errors: [`Reviewer agent error: ${repairError}`],
          transcript: serializeTranscript(session.agent.state.messages),
          interrupted: true,
        };
      }
      text = lastAssistantText(session.agent.state.messages);
      parsed = parseJson<ReviewResult>(text);
      validation = parsed
        ? validateReviewResult(parsed)
        : { valid: false, errors: ["Could not parse JSON from reviewer response"] };
    }

    if (!validation.valid || !parsed) {
      // §16.2: treat as blocked and present raw response
      return {
        rawResponse: text,
        review: {
          status: "blocked",
          summary: "Could not parse reviewer JSON output after retries",
          findings: [],
          testsToRun: [],
          riskNotes: ["Reviewer output was malformed", `Raw response: ${text.slice(0, 500)}`],
        },
        valid: false,
        errors: validation.errors,
        transcript: serializeTranscript(session.agent.state.messages),
      };
    }

    return {
      rawResponse: text,
      review: parsed,
      valid: true,
      transcript: serializeTranscript(session.agent.state.messages),
    };
  } finally {
    stopObserving();
    cleanup();
    session.dispose();
  }
}
