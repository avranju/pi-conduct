import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionCommandContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type {
  AgentRole, ConductConfig, CoderCompliance, ImplementationPlan, ModelConfig,
  ReviewResult, RetryConfig, SafetyConfig,
} from "./schemas.js";
import { getSessionMessages } from "./usage.js";
import { createSafeBashTool } from "./safe-bash.js";
import { createHandoff, HANDOFF_NAMES, type RoleOutputs } from "./handoffs.js";
import {
  roleExtensions, routedRoleModel, selectRoleSettings, ROLE_TOOLS,
  type HostSettings, type WorkflowAgentServices,
} from "./runtime.js";
import { parseJson, isTransientModelError, retryDelayFor, sleep } from "./utils.js";

export interface AgentProgressObserver {
  observeAgent(session: AgentSession): () => void;
  onTransientRetry?(info: {
    role: string; nextAttempt: number; maxAttempts: number; delayMs: number; reason: string;
  }): void;
}

export interface RoleSessionDependencies {
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  sessionManager?: SessionManager;
  settings?: HostSettings;
  config?: ConductConfig;
  role?: AgentRole;
  customTools?: ToolDefinition[];
  projectTrusted?: boolean;
  signal?: AbortSignal;
}

/** Load only Conduct-owned inline extensions, with explicit role tool allowlists. */
export async function createRoleSession(
  cwd: string,
  roleConfig: ModelConfig,
  tools: string[],
  safety: SafetyConfig,
  dependencies: RoleSessionDependencies = {},
): Promise<AgentSession> {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const modelRuntime = dependencies.modelRuntime ?? await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
    signal: dependencies.signal,
  });
  dependencies.signal?.throwIfAborted();
  const model = dependencies.role
    ? routedRoleModel(modelRuntime, dependencies.role, roleConfig, dependencies.config?.retry.retryableErrorPatterns)
    : modelRuntime.getModel(roleConfig.provider, roleConfig.model);
  if (!model) throw new Error(`Configured model not found: ${roleConfig.provider}/${roleConfig.model}`);
  const settingsManager = SettingsManager.inMemory(selectRoleSettings(dependencies.settings), {
    projectTrusted: dependencies.projectTrusted ?? false,
  });
  const capabilities = dependencies.role && dependencies.config
    ? roleExtensions(dependencies.role, dependencies.config)
    : { factories: [], tools };
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: capabilities.factories,
  });
  await loader.reload();
  dependencies.signal?.throwIfAborted();
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, thinkingLevel: roleConfig.thinkingLevel,
    tools: capabilities.tools,
    excludeTools: ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
    customTools: [createSafeBashTool(cwd, safety, {
      shellPath: settingsManager.getShellPath(), commandPrefix: settingsManager.getShellCommandPrefix(),
    }), ...(dependencies.customTools ?? [])],
    resourceLoader: loader,
    sessionManager: dependencies.sessionManager ?? SessionManager.create(cwd), settingsManager,
  });
  try {
    dependencies.signal?.throwIfAborted();
    await session.bindExtensions({});
    dependencies.signal?.throwIfAborted();
    return session;
  } catch (error) {
    await disposeRoleSession(session);
    throw error;
  }
}

/** SDK dispose() is synchronous; MCP additionally needs its awaited shutdown hook. */
export async function disposeRoleSession(session: AgentSession): Promise<void> {
  try {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

export function wireAbort(session: AgentSession, parentSignal?: AbortSignal): () => void {
  if (!parentSignal) return () => {};
  const abort = () => { void session.abort(); };
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

/** Keep model, usage, error, tool details and nested-call metadata, not just prose. */
export function serializeTranscript(messages: readonly unknown[]): string {
  return JSON.stringify(messages, null, 2);
}

interface RetryableResult { interrupted?: boolean; errors?: string[] }

/** Outer retries recreate a role session; SDK retries preserve work within a session. */
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
      throw lastThrown ?? new Error("Conduct agent was cancelled");
    }
    if (attempt > 1 && Date.now() - startedAt >= budgetMs) {
      if (lastResult !== undefined) return lastResult;
      throw lastThrown;
    }
    try {
      lastResult = await runAttempt(attempt);
      lastThrown = undefined;
      if (!(lastResult.interrupted && isTransientModelError(lastResult.errors?.[0], retry.retryableErrorPatterns))) return lastResult;
    } catch (error) {
      lastThrown = error;
      lastResult = undefined;
      if (!isTransientModelError(error instanceof Error ? error.message : String(error), retry.retryableErrorPatterns)) throw error;
    }
    const elapsed = Date.now() - startedAt;
    if (attempt >= maxAttempts || elapsed >= budgetMs) break;
    const delayMs = Math.max(0, Math.min(retryDelayFor(attempt, retry), budgetMs - elapsed));
    progress?.onTransientRetry?.({
      role, nextAttempt: attempt + 1, maxAttempts, delayMs,
      reason: lastResult?.errors?.[0] ?? (lastThrown instanceof Error ? lastThrown.message : String(lastThrown)),
    });
    await sleep(delayMs, signal);
  }
  if (lastResult !== undefined) return lastResult;
  throw lastThrown ?? new Error("Conduct agent was cancelled");
}

interface RoleResult<R extends AgentRole> extends RetryableResult {
  rawResponse: string;
  output: RoleOutputs[R] | null;
  valid: boolean;
  transcript: string;
}

async function runRole<R extends AgentRole>(
  role: R, prompt: string, config: ConductConfig, ctx: ExtensionCommandContext,
  signal?: AbortSignal, progress?: AgentProgressObserver, services?: WorkflowAgentServices,
  label: string = role,
): Promise<RoleResult<R>> {
  return withTransientRetry(role, async (attempt) => {
    signal?.throwIfAborted();
    const handoff = createHandoff(role);
    // Outer retries always follow a classified transient failure. If SDK retries never fired
    // (or exhausted), start this replacement session on the fallback and stay there.
    const selection = attempt > 1 && config.models[role].routing?.fallback
      ? config.models[role].routing!.fallback!
      : config.models[role];
    const session = await createRoleSession(ctx.cwd, selection, ROLE_TOOLS[role], config.safety, {
      agentDir: services?.agentDir, modelRuntime: services?.modelRuntime, settings: services?.settings,
      role, config, signal, customTools: [handoff.tool], sessionManager: services?.createSessionManager?.(),
      projectTrusted: services?.projectTrusted ?? ctx.isProjectTrusted(),
    });
    session.setSessionName(`Conduct ${services?.runName ?? "run"} · ${label} · attempt ${attempt}`);
    const cleanup = wireAbort(session, signal);
    const stopObserving = progress?.observeAgent(session) ?? (() => {});
    try {
      // Older saved prompts still mention fenced JSON. The last instruction deliberately wins.
      const recovery = attempt > 1 && role === "coder"
        ? "\nA prior attempt failed and may have left partial edits. Inspect the current tree, preserve correct work, and reconcile it before editing."
        : "";
      await session.prompt(`${prompt}${recovery}\n\nHandoff protocol: submit the finished result with ${HANDOFF_NAMES[role]}. Call it ALONE after all other tools finish. Do not use prose or a fenced JSON block as the handoff.`);
      let text = session.getLastAssistantText() ?? "";
      let output = handoff.value ?? parseJson<RoleOutputs[R]>(text);
      let validation = output ? handoff.validate(output) : { valid: false, errors: ["No structured handoff was submitted"] };
      for (let repair = 0; repair < 2 && !validation.valid && !signal?.aborted && !session.state.errorMessage; repair++) {
        await session.prompt(`Correct the handoff without repeating completed file changes. Errors:\n${validation.errors.join("\n")}\nCall ${HANDOFF_NAMES[role]} ALONE with the corrected result.`);
        text = session.getLastAssistantText() ?? "";
        output = handoff.value ?? parseJson<RoleOutputs[R]>(text);
        validation = output ? handoff.validate(output) : { valid: false, errors: ["No structured handoff was submitted"] };
      }
      const error = session.state.errorMessage;
      return {
        rawResponse: handoff.value ? JSON.stringify(handoff.value, null, 2) : text,
        output: error || signal?.aborted ? null : output,
        valid: !error && !signal?.aborted && validation.valid,
        errors: error ? [`${role} agent error: ${error}`] : signal?.aborted ? ["Workflow cancelled"] : validation.valid ? undefined : validation.errors,
        interrupted: !!error || signal?.aborted,
        transcript: serializeTranscript(getSessionMessages(session)),
      };
    } finally {
      stopObserving();
      cleanup();
      // Persist stats even after a thrown prompt or failed attempt. Always release resources if
      // persistence fails; the workflow will mark that failure resumable.
      try { services?.onSessionFinished(role, label, attempt, session); }
      finally { await disposeRoleSession(session); }
    }
  }, config.retry, signal, progress);
}

export interface PlannerResult {
  rawResponse: string; plan: ImplementationPlan | null; valid: boolean;
  errors?: string[]; transcript: string; interrupted?: boolean;
}
export async function runPlanner(
  prompt: string, config: ConductConfig, ctx: ExtensionCommandContext,
  signal?: AbortSignal, progress?: AgentProgressObserver, services?: WorkflowAgentServices,
): Promise<PlannerResult> {
  const { output, ...result } = await runRole("planner", prompt, config, ctx, signal, progress, services);
  return { ...result, plan: output };
}

export interface CoderResult {
  rawResponse: string; compliance: CoderCompliance | null; valid: boolean;
  errors?: string[]; transcript: string; interrupted?: boolean;
}
export async function runCoder(
  prompt: string, config: ConductConfig, ctx: ExtensionCommandContext,
  signal?: AbortSignal, progress?: AgentProgressObserver, services?: WorkflowAgentServices,
  label = "coder",
): Promise<CoderResult> {
  const { output, ...result } = await runRole("coder", prompt, config, ctx, signal, progress, services, label);
  return { ...result, compliance: output };
}

export interface ReviewerResult {
  rawResponse: string; review: ReviewResult; valid: boolean;
  errors?: string[]; transcript: string; interrupted?: boolean;
}
export async function runReviewer(
  prompt: string, config: ConductConfig, ctx: ExtensionCommandContext,
  signal?: AbortSignal, progress?: AgentProgressObserver, services?: WorkflowAgentServices,
  label = "reviewer",
): Promise<ReviewerResult> {
  const { output, ...result } = await runRole("reviewer", prompt, config, ctx, signal, progress, services, label);
  return {
    ...result,
    review: result.valid && output ? output : {
      status: "blocked", summary: result.errors?.join(", ") ?? "Reviewer did not complete a valid handoff",
      findings: [], testsToRun: [], riskNotes: ["Reviewer failed to complete a valid handoff"],
    },
  };
}
