import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  IMPLEMENTATION_PLAN_JSON_SCHEMA,
  CODER_COMPLIANCE_JSON_SCHEMA,
  REVIEW_RESULT_JSON_SCHEMA,
  type AgentRole,
  type ImplementationPlan,
  type CoderCompliance,
  type ReviewResult,
} from "./schemas.js";
import {
  validateImplementationPlan,
  validateCoderCompliance,
  validateReviewResult,
  type ValidationResult,
} from "./validation.js";

export interface RoleOutputs {
  planner: ImplementationPlan;
  coder: CoderCompliance;
  reviewer: ReviewResult;
}

export const HANDOFF_NAMES = {
  planner: "submit_plan",
  coder: "submit_compliance",
  reviewer: "submit_review",
} as const;

const SCHEMAS = {
  planner: IMPLEMENTATION_PLAN_JSON_SCHEMA,
  coder: CODER_COMPLIANCE_JSON_SCHEMA,
  reviewer: REVIEW_RESULT_JSON_SCHEMA,
};
const VALIDATORS: Record<AgentRole, (value: unknown) => ValidationResult> = {
  planner: validateImplementationPlan,
  coder: validateCoderCompliance,
  reviewer: validateReviewResult,
};

/** One handoff channel per role session. It is intentionally unreachable from codemode. */
export function createHandoff<R extends AgentRole>(role: R) {
  const { $schema: _draft, ...jsonSchema } = SCHEMAS[role];
  const schema = Type.Unsafe<RoleOutputs[R]>(jsonSchema);
  let value: RoleOutputs[R] | undefined;
  const validate = (candidate: unknown): ValidationResult => {
    const result = VALIDATORS[role](candidate);
    if (!Value.Check(schema, candidate)) {
      result.errors.push("Submission does not match the strict JSON schema (including optional fields and unknown properties)");
      result.valid = false;
    }
    return result;
  };
  const tool: ToolDefinition<typeof schema, { accepted: boolean; errors?: string[] }> = {
    name: HANDOFF_NAMES[role],
    label: `Submit ${role} result`,
    description: "Submit the completed structured handoff. Call this tool ALONE, after all other work and tool calls have finished. A valid submission ends this agent run.",
    parameters: schema,
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, candidate, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const lastAssistant = ctx?.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant") {
        const calls = lastAssistant.message.content.filter((part) => part.type === "toolCall");
        if (calls.length !== 1 || calls[0]?.name !== HANDOFF_NAMES[role]) {
          throw new Error("A handoff must be called alone, after all other tools have finished");
        }
      }
      const validation = validate(candidate);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.errors.join("\n") }],
          details: { accepted: false, errors: validation.errors },
          isError: true,
        };
      }
      // Accept a detached value so later argument/result mutations cannot alter the handoff.
      value = structuredClone(candidate);
      return {
        content: [{ type: "text", text: "Handoff accepted." }],
        details: { accepted: true },
        terminate: true,
      };
    },
    renderCall: (_args, theme) => new Text(theme.fg("toolTitle", `Submit ${role} result`), 0, 0),
    renderResult: (result, _options, theme) => new Text(
      theme.fg(result.details?.accepted ? "success" : "error", result.details?.accepted ? "✓ Handoff accepted" : "Handoff rejected; correcting output…"), 0, 0,
    ),
  };
  return { tool: defineTool(tool), validate, get value() { return value; } };
}
