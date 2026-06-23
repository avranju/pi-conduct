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
import { parseJson } from "./utils.js";

export interface AgentProgressObserver {
  observeAgent(session: AgentSession): () => void;
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
