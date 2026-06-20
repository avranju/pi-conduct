import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { complete, type Message } from "@earendil-works/pi-ai";
import type {
  ImplementationPlan,
  CoderCompliance,
  ReviewResult,
  ModelConfig,
} from "./schemas.js";
import { parseJson } from "./utils.js";

// ============================================================================
// Internal Agent Communication
// ============================================================================

/**
 * Resolve a model from the context's model registry.
 */
export async function resolveModel(
  ctx: ExtensionCommandContext,
  config: ModelConfig,
): Promise<Model> {
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(
      `Configured model not found: ${config.provider}/${config.model}`,
    );
  }
  return model;
}

/**
 * Get API key and headers for a model.
 */
async function getModelAuth(
  model: Model,
  ctx: ExtensionCommandContext,
): Promise<{ apiKey: string; headers?: Record<string, string> }> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error ?? `Authentication failed for ${model.provider}/${model.modelId}`);
  }
  if (!auth.apiKey) {
    throw new Error(`No API key available for ${model.provider}/${model.modelId}`);
  }
  return { apiKey: auth.apiKey, headers: auth.headers };
}

// ============================================================================
// Planner Agent
// ============================================================================

export interface PlannerResult {
  rawResponse: string;
  plan: ImplementationPlan;
  valid: boolean;
  errors?: string[];
}

export async function runPlanner(
  userPrompt: string,
  modelConfig: ModelConfig,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<PlannerResult> {
  const model = await resolveModel(ctx, modelConfig);
  const auth = await getModelAuth(model, ctx);

  const systemPrompt = [
    `You are a planning agent. You produce structured implementation plans as JSON.`,
    `Always respond with a markdown code block containing valid JSON.`,
    `If your JSON is invalid, the system will ask you to retry.`,
  ].join("\n");

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: Date.now(),
  };

  // Retry loop
  const messages: Message[] = [userMessage];
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await complete(
      model,
      {
        messages: messages.map((m) => ({ ...m })),
        systemPrompt,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
      },
    );

    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Try to parse as ImplementationPlan
    const plan = parseJson<ImplementationPlan>(text);
    if (plan) {
      // Validate required fields
      const errors = validatePlan(plan);
      if (errors.length === 0) {
        return { rawResponse: text, plan, valid: true };
      }
      if (attempt < maxRetries) {
        messages.push(
          { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Your previous response had validation errors:\n${errors.join("\n")}\n\nPlease fix and return valid JSON.`,
              },
            ],
            timestamp: Date.now(),
          },
        );
        continue;
      }
      return { rawResponse: text, plan, valid: false, errors };
    }

    // Could not extract JSON
    if (attempt < maxRetries) {
      messages.push(
        { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Your response did not contain valid JSON. Please wrap your JSON in a markdown code block with the language "json" and ensure it matches the ImplementationPlan schema.`,
            },
          ],
          timestamp: Date.now(),
        },
      );
      continue;
    }

    return { rawResponse: text, plan: {} as ImplementationPlan, valid: false, errors: ["Could not parse JSON from response"] };
  }

  throw new Error("Planner failed after retries");
}

function validatePlan(plan: Partial<ImplementationPlan>): string[] {
  const errors: string[] = [];
  if (!plan.goal) errors.push("Missing required field: goal");
  if (!plan.filesToModify) errors.push("Missing required field: filesToModify");
  if (!plan.implementationOrder) errors.push("Missing required field: implementationOrder");
  return errors;
}

// ============================================================================
// Coder Agent
// ============================================================================

export interface CoderResult {
  rawResponse: string;
  compliance: CoderCompliance;
}

export async function runCoder(
  prompt: string,
  modelConfig: ModelConfig,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<CoderResult> {
  const model = await resolveModel(ctx, modelConfig);
  const auth = await getModelAuth(model, ctx);

  const systemPrompt = [
    `You are a coding agent. You implement changes to a codebase following a detailed plan.`,
    `You have access to read, edit, write, and bash tools.`,
    `At the end, provide a concise summary and a strict JSON CoderCompliance object.`,
    `Wrap your JSON in a markdown code block with the language "json".`,
  ].join("\n");

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const resp = await complete(
    model,
    { messages: [userMessage], systemPrompt },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
    },
  );

  const text = resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const compliance = parseJson<CoderCompliance>(text);
  if (!compliance) {
    return { rawResponse: text, compliance: {
      summary: "(could not parse compliance report)",
      filesChanged: [],
      planItemsCompleted: [],
      planItemsSkipped: [],
      reviewerItemsAddressed: [],
      commandsRun: [],
      knownIssues: ["Could not parse CoderCompliance JSON from response"],
    }};
  }

  return { rawResponse: text, compliance };
}

// ============================================================================
// Reviewer Agent
// ============================================================================

export interface ReviewerResult {
  rawResponse: string;
  review: ReviewResult;
}

export async function runReviewer(
  prompt: string,
  modelConfig: ModelConfig,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<ReviewerResult> {
  const model = await resolveModel(ctx, modelConfig);
  const auth = await getModelAuth(model, ctx);

  const systemPrompt = [
    `You are a reviewer agent. You review code changes against a plan and requirements.`,
    `You must return strict JSON matching the ReviewResult schema.`,
    `Your status must be one of: "approved", "needs_changes", "blocked".`,
    `Wrap your JSON in a markdown code block with the language "json".`,
  ].join("\n");

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  // Retry loop for JSON parsing
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await complete(
      model,
      { messages: [userMessage], systemPrompt },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
      },
    );

    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const review = parseJson<ReviewResult>(text);
    if (review && review.status && ["approved", "needs_changes", "blocked"].includes(review.status)) {
      return { rawResponse: text, review };
    }

    if (attempt < maxRetries) {
      userMessage.content.push({
        type: "text",
        text: `\n\n[SYSTEM: Your previous response did not contain valid ReviewResult JSON. Please retry with proper JSON.]`,
      });
      continue;
    }

    // Final attempt - treat as blocked if we can't parse
    return {
      rawResponse: text,
      review: {
        status: "blocked",
        summary: "Could not parse reviewer JSON output after retries",
        findings: [],
        testsToRun: [],
        riskNotes: ["Reviewer output was malformed"],
      },
    };
  }

  throw new Error("Reviewer failed after retries");
}
