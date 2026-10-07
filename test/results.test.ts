import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRoleSession, disposeRoleSession } from "../src/agents.js";
import { publishResult, RESULT_ENTRY_TYPE, resultCardLines } from "../src/results.js";
import { RunUsageLedger, totalUsage } from "../src/usage.js";
import { tempDirectory, testConfig, testRuntime } from "./helpers.js";

async function sessionFixture() {
  const cwd = tempDirectory(); const agentDir = tempDirectory(); const config = testConfig();
  const provider = await testRuntime(agentDir, () => [{ type: "text", text: "Synthetic outcome" }]);
  const session = await createRoleSession(cwd, config.models.coder, [], config.safety, {
    modelRuntime: provider.runtime, agentDir, sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  await session.prompt("Synthetic test prompt");
  return { cwd, agentDir, session, async cleanup() {
    await disposeRoleSession(session);
    fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
  } };
}

describe("durable results and usage", () => {
  it("persists a custom result card and non-triggering compact parent context across session reloads", async () => {
    const f = await sessionFixture();
    try {
      let messageOptions: unknown;
      const pi = {
        appendEntry: (type: string, data: unknown) => f.session.sessionManager.appendCustomEntry(type, data),
        sendMessage: (message: { customType: string; content: string; display: boolean }, options: unknown) => {
          messageOptions = options;
          f.session.sessionManager.appendMessage({ role: "custom", ...message, timestamp: Date.now() });
        },
      } as unknown as ExtensionAPI;
      const card = publishResult(pi, {
        success: false, reason: "Cancelled", iterations: 2, modifiedFiles: ["work.txt"],
        summary: "Full detailed outcome", resumable: true, artifactPath: "/artifacts/run-id",
      }, ["✓ Planning", "✗ Coding"]);
      assert.deepEqual(messageOptions, { triggerTurn: false });
      const reopened = SessionManager.open(f.session.sessionManager.getSessionFile()!);
      const entry = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === RESULT_ENTRY_TYPE);
      assert.ok(entry?.type === "custom"); assert.deepEqual(entry.data, JSON.parse(JSON.stringify(card)));
      const custom = reopened.buildSessionContext().messages.find((message) => message.role === "custom");
      assert.ok(custom?.role === "custom"); assert.equal(custom.display, false);
      assert.match(JSON.stringify(custom.content), /Cancelled/);
      assert.doesNotMatch(JSON.stringify(custom.content), /Full detailed outcome|✓ Planning/);
      assert.match(resultCardLines(card).join("\n"), /conduct resume run-id/);
    } finally { await f.cleanup(); }
  });

  it("deduplicates session stats, atomically persists usage, and restores it for resumed runs", async () => {
    const f = await sessionFixture();
    try {
      const ledger = new RunUsageLedger(f.cwd);
      ledger.record("coder", "coder 1", 1, f.session);
      ledger.record("coder", "coder 1", 1, f.session);
      assert.equal(ledger.snapshot().sessions.length, 1);
      assert.equal(ledger.snapshot().totals.total, 20);
      const reopened = new RunUsageLedger(f.cwd);
      assert.deepEqual(reopened.snapshot(), ledger.snapshot());
      await f.session.prompt("Another synthetic request");
      reopened.record("coder", "coder 1", 1, f.session);
      assert.equal(reopened.snapshot().totals.total, 40);
      assert.equal(reopened.snapshot().totals.cost, 0.004);
      assert.deepEqual(reopened.snapshot().sessions[0]?.models, ["conduct-test/test"]);
      assert.ok(reopened.snapshot().sessions[0]?.sessionFile);
      assert.equal(fs.existsSync(path.join(f.cwd, "usage.json.tmp")), false);
      assert.deepEqual(totalUsage([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
    } finally { await f.cleanup(); }
  });

  it("rejects corrupted usage checkpoints rather than silently misreporting costs", () => {
    const cwd = tempDirectory();
    try {
      fs.writeFileSync(path.join(cwd, "usage.json"), JSON.stringify({ version: 1, sessions: [{ sessionId: "a", cost: "bad" }] }));
      assert.throws(() => new RunUsageLedger(cwd), /Invalid Conduct session usage/);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
