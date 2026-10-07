import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type ConductConfig, type ImplementationPlan, type CoderCompliance, type ReviewResult } from "../src/schemas.js";
import { RunUsageLedger } from "../src/usage.js";
import type { WorkflowAgentServices } from "../src/runtime.js";

export const plan: ImplementationPlan = {
  goal: "Implement a tested change", assumptions: [], risks: [], filesToInspect: [],
  filesToModify: [], filesToCreate: [], typesToCreate: [], controlFlow: [],
  errorHandling: [], tests: [], acceptanceCriteria: [], implementationOrder: [],
};
export const compliance: CoderCompliance = {
  summary: "Implemented the change", filesChanged: ["work.txt"], planItemsCompleted: [],
  planItemsSkipped: [], reviewerItemsAddressed: [], commandsRun: [], knownIssues: [],
};
export const review: ReviewResult = {
  status: "approved", summary: "Looks good", findings: [], testsToRun: [], riskNotes: [], approvalRationale: "Tests pass",
};
export function toolCall(name: string, args: unknown, id = "test-call"): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name, arguments: args as Record<string, never> };
}
export function tempDirectory(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "pi-conduct-test-")); }

type Script = (context: TranscriptContext, request: number, signal?: AbortSignal) => AssistantMessage["content"] | Promise<AssistantMessage["content"]>;
export async function testRuntime(agentDir: string, script: Script) {
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  let requests = 0;
  runtime.registerProvider("conduct-test", {
    api: "conduct-test", apiKey: "not-a-real-key", baseUrl: "http://synthetic.invalid",
    models: ["test", "continuation", "fallback"].map((id) => ({
      id, name: `Synthetic ${id} model`, reasoning: false, input: ["text" as const],
      contextWindow: 200_000, maxTokens: 16_384,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    })),
    streamSimple(model: Model<Api>, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "pending",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
      };
      void (async () => {
        try {
          const content = await script(context, ++requests, options?.signal);
          options?.signal?.throwIfAborted();
          message.content = content;
          message.stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
        }
      })();
      return stream;
    },
  });
  await runtime.refresh({ allowNetwork: false, providers: ["conduct-test"] });
  return { runtime, get requests() { return requests; } };
}

export function testConfig(): ConductConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const role of ["planner", "coder", "reviewer"] as const) {
    config.models[role] = { provider: "conduct-test", model: "test", thinkingLevel: "off" };
  }
  config.retry.enabled = false;
  return config;
}

export function servicesFor(cwd: string, agentDir: string, config: ConductConfig, modelRuntime: ModelRuntime, root?: string): WorkflowAgentServices {
  const usage = new RunUsageLedger(root);
  return {
    agentDir, modelRuntime, config, settings: { retry: { enabled: false }, cacheWarming: "off" },
    usage, runName: "unit-test", projectTrusted: false,
    createSessionManager: () => SessionManager.inMemory(cwd),
    onSessionFinished: (role, label, attempt, session) => usage.record(role, label, attempt, session),
  };
}
