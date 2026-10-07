import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRunDirectory, saveConfig, saveUserPrompt } from "../src/artifacts.js";
import { ConductProgress } from "../src/ui.js";
import { runConductWorkflow } from "../src/supervisor.js";
import { loadResumeRun } from "../src/resume.js";
import type { Exec } from "../src/git.js";
import { plan, compliance, review, servicesFor, tempDirectory, testConfig, testRuntime, toolCall } from "./helpers.js";

async function fixture(interrupt: boolean) {
  const cwd = tempDirectory(); const agentDir = tempDirectory(); const config = testConfig();
  const exec: Exec = async (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
  };
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(cwd, "work.txt"), "before");
  await exec("git", ["add", "."]); await exec("git", ["commit", "-qm", "initial"]);
  const ctx = { cwd, isProjectTrusted: () => true, ui: {
    setWidget() {}, setStatus() {}, notify() {},
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
  } } as unknown as ExtensionCommandContext;
  config.loop.requirePassingChecks = true;
  config.commands.test = ["test \"$(cat work.txt)\" = after"];
  const root = path.join(cwd, config.artifacts.root);
  const { dir } = createRunDirectory(root, "synthetic-run");
  saveUserPrompt(dir, "Update work.txt"); saveConfig(dir, config);
  const provider = await testRuntime(agentDir, (_ctx, request) => {
    if (request === 1) return [toolCall("submit_plan", plan)];
    if (request === 2) return [toolCall("write", { path: "work.txt", content: "after" })];
    if (interrupt && request === 3) throw new Error("ECONNREFUSED");
    if (request === (interrupt ? 5 : 4)) return [toolCall("submit_review", review)];
    return [toolCall("submit_compliance", compliance)];
  });
  const progress = new ConductProgress(ctx, ["f12"]);
  const services = servicesFor(cwd, agentDir, config, provider.runtime, dir.root);
  return { cwd, agentDir, config, exec, ctx, dir, root, provider, services, progress,
    cleanup() { progress.clear(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); } };
}

describe("synthetic model-backed workflows", () => {
  it("runs planning, file edits, real checks, review and artifacts end to end", async () => {
    const f = await fixture(false);
    try {
      const result = await runConductWorkflow("Update work.txt", f.config, f.ctx, f.exec, "", f.dir, undefined, f.progress, undefined, f.services);
      assert.equal(result.success, true); assert.equal(result.iterations, 1);
      assert.deepEqual(result.modifiedFiles, ["work.txt"]);
      assert.equal(f.provider.requests, 4);
      assert.equal(f.services.usage.snapshot().sessions.length, 3);
      assert.equal(JSON.parse(fs.readFileSync(f.dir.statePath, "utf8")).status, "completed");
      assert.ok(fs.existsSync(path.join(f.dir.root, "final-summary.md")));
      const transcript = JSON.parse(fs.readFileSync(path.join(f.dir.root, "iteration-1", "coder-transcript.json"), "utf8"));
      assert.ok(transcript.some((message: { role: string; model?: string }) => message.role === "assistant" && message.model === "test"));
    } finally { f.cleanup(); }
  });

  it("retains partial edits, resumes without replanning, and carries usage forward", async () => {
    const f = await fixture(true);
    try {
      const first = await runConductWorkflow("Update work.txt", f.config, f.ctx, f.exec, "", f.dir, undefined, f.progress, undefined, f.services);
      assert.equal(first.resumable, true); assert.equal(first.success, false);
      assert.equal(fs.readFileSync(path.join(f.cwd, "work.txt"), "utf8"), "after");
      const loaded = await loadResumeRun(f.root, "synthetic-run", f.cwd, f.exec);
      assert.equal(loaded.resume.state.resumeAction, "coder");
      const resumedServices = servicesFor(f.cwd, f.agentDir, loaded.config, f.provider.runtime, f.dir.root);
      const result = await runConductWorkflow("Update work.txt", loaded.config, f.ctx, f.exec, "", loaded.dir, undefined, f.progress, loaded.resume, resumedServices);
      assert.equal(result.success, true); assert.equal(f.provider.requests, 5);
      assert.equal(resumedServices.usage.snapshot().sessions.length, 4);
      assert.equal(resumedServices.usage.snapshot().totals.cost, 0.01);
      assert.ok(fs.existsSync(path.join(f.dir.root, "iteration-1", "attempt-2", "coder-transcript.json")));
    } finally { f.cleanup(); }
  });
});
