import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempDirectory } from "./helpers.js";
import { acquireRepositoryLock } from "../src/artifacts.js";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import conductExtension from "../src/index.js";
import { WorkflowOwner } from "../src/lifecycle.js";

describe("workflow lifecycle ownership", () => {
  it("reserves synchronously, rejects overlap, and releases ownership on finish", () => {
    const owner = new WorkflowOwner(); const run = owner.begin();
    assert.equal(owner.isActive, true);
    assert.throws(() => owner.begin(), /already active/);
    run.finish(); assert.equal(owner.isActive, false);
    owner.begin().finish();
  });
  it("aborts on shutdown, awaits actual cleanup, and prevents starts during shutdown", async () => {
    const owner = new WorkflowOwner(); const run = owner.begin(); let cleanups = 0; let settled = false;
    run.addCleanup(() => { cleanups++; });
    const closing = owner.shutdown().then(() => { settled = true; });
    assert.equal(run.controller.signal.aborted, true);
    assert.equal(settled, false); assert.equal(cleanups, 0);
    assert.throws(() => owner.begin(), /shutting down/);
    run.finish(); run.finish();
    await Promise.all([closing, owner.shutdown()]);
    assert.equal(settled, true); assert.equal(cleanups, 1);
    run.addCleanup(() => { cleanups++; }); assert.equal(cleanups, 2);
  });
  it("rejects another Conduct run sharing the Git directory and releases the repository lock idempotently", () => {
    const gitDir = tempDirectory();
    try {
      const release = acquireRepositoryLock(gitDir);
      assert.throws(() => acquireRepositoryLock(gitDir), /repository is already active/);
      release(); release();
      acquireRepositoryLock(gitDir)();
      assert.equal(fs.existsSync(path.join(gitDir, "pi-conduct.lock")), false);
      fs.writeFileSync(path.join(gitDir, "pi-conduct.lock"), "");
      assert.throws(() => acquireRepositoryLock(gitDir), /being initialized/);
    } finally { fs.rmSync(gitDir, { recursive: true, force: true }); }
  });
  it("continues cleanup when a cleanup throws", async () => {
    const owner = new WorkflowOwner(); const run = owner.begin(); const order: number[] = [];
    run.addCleanup(() => { order.push(1); });
    run.addCleanup(() => { order.push(2); throw new Error("cleanup"); });
    run.finish(); await run.completion;
    assert.deepEqual(order, [2, 1]); assert.equal(owner.isActive, false);
  });
});

function commandFixture() {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const notices: string[] = [];
  let resolveGit!: (value: { code: number; stdout: string; stderr: string; killed: boolean }) => void;
  let execCalls = 0;
  const git = new Promise((resolve) => { resolveGit = resolve; });
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => { events.set(event, handler); },
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
    registerEntryRenderer: () => {}, registerMessageRenderer: () => {}, registerShortcut: () => {},
    exec: async () => { execCalls++; return git; },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", cwd: process.cwd(), isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  conductExtension(pi);
  return { events, command, ctx, notices, resolveGit, get execCalls() { return execCalls; } };
}

describe("parent session coordination", () => {
  it("refuses a non-idle parent or queued messages before preflight", async () => {
    const f = commandFixture();
    await f.command("Task", { ...f.ctx, isIdle: () => false });
    await f.command("Task", { ...f.ctx, hasPendingMessages: () => true });
    assert.equal(f.execCalls, 0); assert.match(f.notices.join("\n"), /parent agent/);
  });
  it("reserves during preflight and blocks parent input, tools, and tree navigation", async () => {
    const f = commandFixture();
    const first = f.command("Task", f.ctx);
    await f.command("Second task", f.ctx);
    assert.equal(f.execCalls, 1); assert.match(f.notices.join("\n"), /already active/);
    assert.deepEqual(f.events.get("input")!({}, f.ctx), { action: "handled" });
    assert.equal((f.events.get("tool_call")!({}) as { block: boolean }).block, true);
    assert.deepEqual(f.events.get("session_before_tree")!({}, f.ctx), { cancel: true });
    let shutdownFinished = false;
    const shutdown = Promise.resolve(f.events.get("session_shutdown")!({})).then(() => { shutdownFinished = true; });
    await Promise.resolve(); assert.equal(shutdownFinished, false);
    f.resolveGit({ code: 1, stdout: "", stderr: "not a repository", killed: false });
    await Promise.all([first, shutdown]);
    assert.equal(shutdownFinished, true);
    assert.equal(f.events.get("tool_call")!({}), undefined);
  });
});
