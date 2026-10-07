import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRoleSession, disposeRoleSession } from "../src/agents.js";
import { tempDirectory, testConfig, testRuntime, toolCall } from "./helpers.js";

const server = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
describe("explicit MCP capability boundaries", () => {
  for (const role of ["planner", "reviewer", "coder"] as const) {
    it(`${role} enforces exact allowlists and MCP safety metadata on direct and codemode calls`, async () => {
      const cwd = tempDirectory(); const agentDir = tempDirectory(); const config = testConfig();
      const marker = path.join(cwd, "calls.txt");
      config.capabilities.codemode.enabled = true;
      config.capabilities.mcp.enabled = true;
      config.capabilities.mcp.servers = { notes: { command: process.execPath, args: [server, marker] } };
      config.capabilities.mcp.tools[role] = ["mcp__notes__read_note", "mcp__notes__write_note", "mcp__notes__unclassified"];
      const provider = await testRuntime(agentDir, (_ctx, request) => {
        if (request === 1) return [toolCall("mcp__notes__read_note", {}, "read")];
        if (request === 2) return [toolCall("mcp__notes__write_note", {}, "write")];
        if (request === 3) return [toolCall("codemode", { code: 'return await tools.mcp__notes__unclassified({});' }, "code")];
        return [];
      });
      const session = await createRoleSession(cwd, config.models[role], [], config.safety, {
        role, config, agentDir, modelRuntime: provider.runtime, sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        await session.prompt("Exercise the synthetic MCP server");
        assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__notes__read_note"));
        assert.equal(session.getToolDefinition("read_mcp_resource"), undefined);
        const calls = fs.readFileSync(marker, "utf8").trim().split("\n");
        assert.deepEqual(calls, role === "coder" ? ["read_note", "write_note", "unclassified"] : ["read_note"]);
        if (role !== "coder") assert.match(JSON.stringify(session.messages), /must declare readOnlyHint/);
      } finally {
        await disposeRoleSession(session);
        fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
      }
    });
  }

  it("filters non-allowlisted remote registrations out of direct and nested tool catalogs", async () => {
    const cwd = tempDirectory(); const agentDir = tempDirectory(); const config = testConfig();
    const marker = path.join(cwd, "calls.txt");
    config.capabilities.codemode.enabled = true;
    config.capabilities.mcp.enabled = true;
    config.capabilities.mcp.servers = { notes: { command: process.execPath, args: [server, marker] } };
    config.capabilities.mcp.tools.coder = ["mcp__notes__read_note"];
    const provider = await testRuntime(agentDir, (_ctx, request) => request === 1
      ? [toolCall("codemode", { code: 'return await tools.mcp__notes__write_note({});' })] : []);
    const session = await createRoleSession(cwd, config.models.coder, [], config.safety, {
      role: "coder", config, agentDir, modelRuntime: provider.runtime, sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.prompt("Exercise denied remote tool");
      assert.ok(session.getToolDefinition("mcp__notes__read_note"));
      assert.equal(session.getToolDefinition("mcp__notes__write_note"), undefined);
      assert.equal(session.getCallableToolNames().includes("mcp__notes__write_note"), false);
      assert.equal(fs.existsSync(marker), false);
      assert.match(JSON.stringify(session.messages), /write_note.*not|not.*write_note/);
    } finally {
      await disposeRoleSession(session);
      fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
