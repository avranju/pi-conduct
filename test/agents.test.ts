import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHandoff } from "../src/handoffs.js";
import { runPlanner, runCoder, runReviewer, serializeTranscript } from "../src/agents.js";
import { plan, compliance, review, servicesFor, tempDirectory, testConfig, testRuntime, toolCall } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const cwd = tempDirectory(); const agentDir = tempDirectory();
  directories.push(cwd, agentDir);
  const ctx = { cwd, isProjectTrusted: () => false } as ExtensionCommandContext;
  return { cwd, agentDir, ctx, config: testConfig() };
}

describe("structured agent handoffs", () => {
  it("validates all role schemas including optional fields and extra properties", () => {
    assert.equal(createHandoff("planner").validate(plan).valid, true);
    assert.equal(createHandoff("coder").validate(compliance).valid, true);
    assert.equal(createHandoff("reviewer").validate(review).valid, true);
    assert.equal(createHandoff("reviewer").validate({ ...review, findings: [null] }).valid, false);
    assert.equal(createHandoff("planner").validate({ ...plan, goal: "" }).valid, false);
    assert.equal(createHandoff("planner").validate({ ...plan, extra: true }).valid, false);
    assert.equal(createHandoff("reviewer").validate({ ...review, approvalRationale: 42 }).valid, false);
  });

  it("terminates a successful handoff without a follow-up model call and records metadata", async () => {
    const f = fixture();
    const provider = await testRuntime(f.agentDir, () => [toolCall("submit_plan", plan)]);
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    const result = await runPlanner("Plan the change", f.config, f.ctx, undefined, undefined, services);
    assert.equal(result.valid, true);
    assert.deepEqual(result.plan, plan);
    assert.equal(provider.requests, 1);
    const messages = JSON.parse(result.transcript);
    assert.equal(messages.find((message: { role: string }) => message.role === "assistant").provider, "conduct-test");
    assert.equal(services.usage.snapshot().sessions.length, 1);
    assert.equal(services.usage.snapshot().totals.cost, 0.002);
  });

  it("rejects invalid tool arguments and lets the model correct its handoff", async () => {
    const f = fixture();
    const provider = await testRuntime(f.agentDir, (_ctx, request) => [toolCall("submit_review", request === 1 ? { ...review, status: "wrong" } : review, `call-${request}`)]);
    const result = await runReviewer("Review", f.config, f.ctx, undefined, undefined, servicesFor(f.cwd, f.agentDir, f.config, provider.runtime));
    assert.equal(provider.requests, 2);
    assert.equal(result.valid, true);
    assert.equal(result.review.status, "approved");
  });

  it("does not accept a handoff in the same batch as file mutation", async () => {
    const f = fixture();
    const provider = await testRuntime(f.agentDir, (_ctx, request) => request === 1
      ? [toolCall("submit_compliance", compliance, "submit"), toolCall("write", { path: "work.txt", content: "finished" }, "write")]
      : [toolCall("submit_compliance", compliance, "submit-again")]);
    const result = await runCoder("Code", f.config, f.ctx, undefined, undefined, servicesFor(f.cwd, f.agentDir, f.config, provider.runtime));
    assert.equal(provider.requests, 2);
    assert.equal(result.valid, true);
    assert.match(result.transcript, /handoff must be called alone/);
    assert.equal(fs.readFileSync(path.join(f.cwd, "work.txt"), "utf8"), "finished");
  });

  it("keeps strict legacy fenced JSON fallback for providers that do not call handoff tools", async () => {
    const f = fixture();
    const provider = await testRuntime(f.agentDir, () => [{ type: "text", text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }]);
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, servicesFor(f.cwd, f.agentDir, f.config, provider.runtime));
    assert.equal(result.valid, true);
    assert.deepEqual(result.plan, plan);
  });

  it("propagates cancellation to an in-flight provider and still records the attempt", async () => {
    const f = fixture(); const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const provider = await testRuntime(f.agentDir, async (_ctx, _request, signal) => {
      started();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    });
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    const pending = runPlanner("Plan", f.config, f.ctx, controller.signal, undefined, services);
    await ready; controller.abort();
    const result = await pending;
    assert.equal(result.interrupted, true);
    assert.equal(result.valid, false);
    assert.equal(services.usage.snapshot().sessions.length, 1);
  });

  it("reuses the runtime for retries and retains failed-session usage", async () => {
    const f = fixture(); f.config.retry.enabled = true; f.config.retry.maxRetries = 1; f.config.retry.baseDelayMs = 0;
    const provider = await testRuntime(f.agentDir, (_ctx, request) => {
      if (request === 1) throw new Error("ECONNREFUSED");
      return [toolCall("submit_plan", plan)];
    });
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, services);
    assert.equal(result.valid, true);
    assert.equal(provider.requests, 2);
    assert.equal(services.usage.snapshot().sessions.length, 2);
    assert.equal(services.usage.snapshot().totals.cost, 0.004);
  });

  it("keeps terminal handoffs visible and direct in codemode-only sessions", async () => {
    const f = fixture(); f.config.capabilities.codemode.enabled = true; f.config.capabilities.codemode.mode = "only";
    const provider = await testRuntime(f.agentDir, (context) => {
      const names = context.messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
      assert.ok(names.includes("codemode")); assert.ok(names.includes("submit_plan"));
      assert.equal(names.includes("read"), false); assert.equal(names.includes("write"), false);
      return [toolCall("submit_plan", plan)];
    });
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, servicesFor(f.cwd, f.agentDir, f.config, provider.runtime));
    assert.equal(result.valid, true); assert.equal(provider.requests, 1);
  });

  it("routes SDK auto-retry requests to a transient fallback within one session", async () => {
    const f = fixture();
    f.config.models.planner.routing = { fallback: { provider: "conduct-test", model: "fallback", thinkingLevel: "off" } };
    const provider = await testRuntime(f.agentDir, (_context, request) => {
      if (request === 1) throw new Error("HTTP 503 Service Unavailable");
      return [toolCall("submit_plan", plan)];
    });
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    services.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, services);
    assert.equal(result.valid, true); assert.equal(provider.requests, 2);
    assert.equal(services.usage.snapshot().sessions.length, 1);
    assert.deepEqual(services.usage.snapshot().sessions[0]?.models, ["conduct-test/test", "conduct-test/fallback"]);
  });

  it("routes tool continuation requests to the configured physical model", async () => {
    const f = fixture();
    f.config.models.planner.routing = { continuation: { provider: "conduct-test", model: "continuation", thinkingLevel: "off" } };
    const provider = await testRuntime(f.agentDir, (_ctx, request) => request === 1
      ? [toolCall("bash", { command: "printf inspected" })] : [toolCall("submit_plan", plan)]);
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, services);
    assert.equal(result.valid, true);
    assert.deepEqual(services.usage.snapshot().sessions[0]?.models, ["conduct-test/test", "conduct-test/continuation"]);
  });

  it("starts transient outer retries on the fallback even with SDK retries disabled", async () => {
    const f = fixture(); f.config.retry.enabled = true; f.config.retry.maxRetries = 1; f.config.retry.baseDelayMs = 0;
    f.config.models.planner.routing = { fallback: { provider: "conduct-test", model: "fallback", thinkingLevel: "off" } };
    const provider = await testRuntime(f.agentDir, (_ctx, request) => {
      if (request === 1) throw new Error("ECONNREFUSED");
      return [toolCall("submit_plan", plan)];
    });
    const services = servicesFor(f.cwd, f.agentDir, f.config, provider.runtime);
    const result = await runPlanner("Plan", f.config, f.ctx, undefined, undefined, services);
    assert.equal(result.valid, true);
    assert.deepEqual(services.usage.snapshot().sessions.map((session) => session.models), [["conduct-test/test"], ["conduct-test/fallback"]]);
  });

  it("preserves transcript metadata rather than projecting it down to text", () => {
    const message = { role: "assistant", model: "example", provider: "unit", usage: { totalTokens: 5 }, errorMessage: "error", content: [] };
    assert.deepEqual(JSON.parse(serializeTranscript([message])), [message]);
  });
});
