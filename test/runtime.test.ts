import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager, ModelRegistry, type AgentSession, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRoleSession, disposeRoleSession, runPlanner } from "../src/agents.js";
import { createWorkflowAgentServices, createRoleRouter, inheritProviders, roleExtensions, roleMcpConfig, selectRoleSettings } from "../src/runtime.js";
import { loadConfig, validateConfig, mergeConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/schemas.js";
import { createHandoff } from "../src/handoffs.js";
import { plan, tempDirectory, testRuntime, testConfig, toolCall } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = tempDirectory(); directories.push(dir); return dir; }
function invoke(session: AgentSession, name: string, args: unknown) {
  return session.extensionRunner.createToolContext("test-parent", undefined).executeTool(name, args);
}

async function roleSession(role: "planner" | "coder" | "reviewer", codemode = false, script: Parameters<typeof testRuntime>[1] = () => []) {
  const cwd = temp(); const agentDir = temp(); const config = testConfig();
  config.capabilities.codemode.enabled = codemode;
  const provider = await testRuntime(agentDir, script);
  const session = await createRoleSession(cwd, config.models[role], [], config.safety, {
    agentDir, role, config, modelRuntime: provider.runtime, sessionManager: SessionManager.inMemory(cwd),
    customTools: [createHandoff(role).tool],
  });
  await session.prompt("Initialize the synthetic tool-test context");
  return { session, config, cwd, provider };
}

describe("role runtime isolation", () => {
  for (const role of ["planner", "coder", "reviewer"] as const) {
    it(`restricts ${role}'s registered tool set and uses guarded bash`, async () => {
      const { session, cwd } = await roleSession(role);
      try {
        const names = session.getAllTools().map((tool) => tool.name);
        assert.equal(names.includes("edit"), role === "coder");
        assert.equal(names.includes("write"), role === "coder");
        assert.equal(names.includes("submit_plan"), role === "planner");
        assert.equal(names.includes("submit_compliance"), role === "coder");
        assert.equal(names.includes("submit_review"), role === "reviewer");
        assert.equal(names.includes("codemode"), false);
        assert.equal(names.some((name) => name.startsWith("mcp__")), false);
        const blocked = await invoke(session, "bash", { command: "sudo echo must-not-execute" });
        assert.match(JSON.stringify(blocked), /Blocked dangerous command/);
        const network = await invoke(session, "bash", { command: "curl https://example.invalid" });
        assert.match(JSON.stringify(network), /Network\/package install disabled/);
        const working = await invoke(session, "bash", { command: "printf conduct" });
        assert.match(JSON.stringify(working), /conduct/);
        assert.equal(fs.existsSync(`${cwd}/must-not-execute`), false);
      } finally { await disposeRoleSession(session); }
    });
  }

  it("selectively copies host settings without resource paths or tool defaults", () => {
    const host = { transport: "sse" as const, shellPath: "/bin/bash", compaction: { enabled: false }, retry: { maxRetries: 7 }, extensions: ["unsafe"], defaultTools: ["write"], sessionDirectory: "unsafe", packages: ["unsafe"], skills: ["unsafe"] };
    const selected = selectRoleSettings(host);
    assert.equal(selected.transport, "sse");
    assert.equal(selected.shellPath, "/bin/bash");
    assert.equal(selected.compaction?.enabled, false);
    assert.equal(selected.retry?.maxRetries, 7);
    assert.equal(selected.defaultTools, undefined);
    assert.equal(selected.extensions, undefined);
    assert.equal(selected.packages, undefined);
    assert.equal("sessionDirectory" in selected, false);
    selected.retry!.maxRetries = 1;
    assert.equal(host.retry.maxRetries, 7);
  });

  it("inherits provider registrations and runtime key overrides without host extensions", async () => {
    const host = await testRuntime(temp(), () => []);
    const target = await testRuntime(temp(), () => []);
    await host.runtime.setRuntimeApiKey("conduct-test", "runtime-override");
    target.runtime.unregisterProvider("conduct-test");
    await inheritProviders(target.runtime, new ModelRegistry(host.runtime), ["conduct-test", "conduct-test"]);
    assert.ok(target.runtime.getPhysicalModel("conduct-test", "test"));
    assert.equal(await new ModelRegistry(target.runtime).getApiKeyForProvider("conduct-test"), "runtime-override");
    assert.equal(target.runtime.getRegisteredProviderConfig("conduct-test")?.streamSimple, host.runtime.getRegisteredProviderConfig("conduct-test")?.streamSimple);
  });

  it("creates real shared workflow services and archives raw messages plus complete session entries", async () => {
    const cwd = temp(); const agentDir = temp(); const root = temp(); const config = testConfig();
    const host = await testRuntime(agentDir, () => [toolCall("submit_plan", plan)]);
    const ctx = { cwd, modelRegistry: new ModelRegistry(host.runtime), isProjectTrusted: () => false } as ExtensionCommandContext;
    const pi = { getSettings: () => ({ transport: "sse", retry: { enabled: false }, extensions: ["not-inherited"] }) } as unknown as ExtensionAPI;
    const services = await createWorkflowAgentServices(config, ctx, pi, root, undefined, agentDir);
    assert.equal(services.settings.extensions, undefined); assert.equal(services.settings.transport, "sse");
    assert.notEqual(services.modelRuntime, host.runtime); assert.equal(services.projectTrusted, false);
    services.createSessionManager = () => SessionManager.create(cwd, path.join(agentDir, "sessions"));
    const result = await runPlanner("Plan", config, ctx, undefined, undefined, services);
    assert.equal(result.valid, true);
    const session = services.usage.snapshot().sessions[0]!;
    const messages = JSON.parse(fs.readFileSync(path.join(root, "sessions", `${session.sessionId}.json`), "utf8"));
    const entries = JSON.parse(fs.readFileSync(path.join(root, "sessions", `${session.sessionId}.entries.json`), "utf8"));
    assert.ok(messages.some((message: { role: string }) => message.role === "assistant"));
    assert.ok(entries.some((entry: { type: string }) => entry.type === "message"));
    assert.ok(fs.existsSync(path.join(root, "usage.json")));
  });

  it("applies inherited shell prefix through guarded bash", async () => {
    const { session, config, cwd, provider } = await roleSession("planner");
    await disposeRoleSession(session);
    const prefixed = await createRoleSession(cwd, config.models.planner, [], config.safety, {
      role: "planner", config, agentDir: temp(), modelRuntime: provider.runtime,
      sessionManager: SessionManager.inMemory(cwd), settings: { shellCommandPrefix: "export CONDUCT_PREFIX_TEST=success;" },
    });
    try {
      await prefixed.prompt("Initialize the synthetic tool-test context");
      assert.match(JSON.stringify(await invoke(prefixed, "bash", { command: "printf \"$CONDUCT_PREFIX_TEST\"" })), /success/);
    } finally { await disposeRoleSession(prefixed); }
  });
});

describe("optional capabilities", () => {
  it("rejects wildcards, bad thinking levels, and invalid routing while accepting max", () => {
    const config = testConfig();
    config.models.planner.thinkingLevel = "max";
    config.models.coder.routing = { fallback: { provider: "", model: "none", thinkingLevel: "off" } };
    config.capabilities.mcp.tools.planner = ["mcp__docs__*"];
    const warnings = validateConfig(config);
    assert.equal(config.models.planner.thinkingLevel, "max");
    assert.equal(config.models.coder.routing.fallback, undefined);
    assert.deepEqual(config.capabilities.mcp.tools.planner, []);
    assert.match(warnings.join("\n"), /allowlist/);
  });

  it("ignores project capabilities and executable checks before Pi trusts the repository", () => {
    const cwd = temp(); const agentDir = temp();
    fs.mkdirSync(path.join(cwd, ".pi", "conduct"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "conduct", "config.json"), JSON.stringify({
      capabilities: { codemode: { enabled: true } }, commands: { test: ["must-not-run"] },
    }));
    const untrusted = loadConfig(cwd, agentDir, false);
    assert.equal(untrusted.config.capabilities.codemode.enabled, false);
    assert.deepEqual(untrusted.config.commands.test, []);
    assert.match(untrusted.warnings.join("\n"), /trusted/);
    const trusted = loadConfig(cwd, agentDir, true);
    assert.equal(trusted.config.capabilities.codemode.enabled, true);
    assert.deepEqual(trusted.config.commands.test, ["must-not-run"]);
  });

  it("merges old saved configurations with safe, disabled capability defaults", () => {
    const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { loop: { ...DEFAULT_CONFIG.loop, maxIterations: 2 } });
    assert.equal(config.capabilities.codemode.enabled, false);
    assert.equal(config.capabilities.mcp.enabled, false);
    assert.deepEqual(config.capabilities.mcp.tools, { planner: [], coder: [], reviewer: [] });
    assert.equal(config.sessions.inheritProviders, true);
  });

  it("loads only servers selected by exact per-role allowlists", () => {
    const config = testConfig(); config.capabilities.mcp.enabled = true;
    config.capabilities.mcp.servers = { docs: { command: "unused" }, other: { command: "unused" } };
    config.capabilities.mcp.tools.planner = ["mcp__docs__read"];
    const loaded = roleMcpConfig("planner", config);
    assert.deepEqual(loaded.servers.map((entry) => entry.name), ["docs"]);
    assert.equal(loaded.autoEnableCodemode, false);
    assert.equal(loaded.servers[0]?.config.exposure, "direct");
    assert.equal(roleMcpConfig("coder", config).servers.length, 0);
    assert.equal(roleExtensions("coder", config).tools.some((name) => name.includes("docs")), false);
    config.capabilities.mcp.tools.coder = ["mcp__absent__read"];
    assert.throws(() => roleMcpConfig("coder", config), /no enabled connection/);
  });

  it("refuses HTTP MCP without explicit network permission and namespace collisions", () => {
    const config = testConfig(); config.capabilities.mcp.enabled = true;
    config.capabilities.mcp.servers = { docs: { url: "https://example.invalid/mcp" } };
    config.capabilities.mcp.tools.planner = ["mcp__docs__read"];
    assert.throws(() => roleMcpConfig("planner", config), /allowNetwork/);
    config.safety.allowNetwork = true;
    assert.equal(roleMcpConfig("planner", config).servers.length, 1);
    config.capabilities.mcp.servers = { "my-docs": { command: "unused" }, my_docs: { command: "unused" } };
    assert.throws(() => roleMcpConfig("planner", config), /collide/);
  });

  it("supports codemode without expanding a planner's registered capabilities", async () => {
    const { session, cwd } = await roleSession("planner", true, (_ctx, request) => {
      if (request === 1) return [toolCall("codemode", { code: 'await tools.write({path:"bad.txt",content:"bad"});' }, "code-write")];
      if (request === 2) return [toolCall("codemode", { code: 'return await tools.bash({command:"sudo echo bad"});' }, "code-bash")];
      return [];
    });
    try {
      assert.ok(session.getAllTools().some((tool) => tool.name === "codemode"));
      assert.equal(session.getToolDefinition("write"), undefined);
      assert.equal(session.getToolDefinition("edit"), undefined);
      const results = session.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 2);
      assert.match(JSON.stringify(results[0]), /write|Unknown|not|undefined/i);
      assert.match(JSON.stringify(results[1]), /Blocked dangerous command/);
      assert.equal(fs.existsSync(`${cwd}/bad.txt`), false);
    } finally { await disposeRoleSession(session); }
  });
});

describe("Conduct role routing", () => {
  it("uses primary first, sticky continuation, and sticky fallback only for transient failures", async () => {
    const { runtime } = await testRuntime(temp(), () => []);
    const model = runtime.getPhysicalModel("conduct-test", "test")!;
    const config = testConfig().models.planner;
    config.routing = {
      continuation: { provider: "conduct-test", model: "test", thinkingLevel: "low" },
      fallback: { provider: "conduct-test", model: "test", thinkingLevel: "high" },
    };
    const route = createRoleRouter(runtime, config);
    const request = { reason: "user" as const, model, thinkingLevel: "off" as const, messages: [] };
    assert.equal(route(request).thinkingLevel, "off");
    const continuation = route({ ...request, reason: "continuation" });
    assert.equal(continuation.thinkingLevel, "low");
    assert.equal(route({ ...request, state: continuation.state }).thinkingLevel, "low");
    const failed = { model, message: { errorMessage: "HTTP 503" }, thinkingLevel: "low" } as never;
    const fallback = route({ ...request, reason: "retry", failed });
    assert.equal(fallback.thinkingLevel, "high");
    assert.equal(route({ ...request, reason: "continuation", state: fallback.state }).thinkingLevel, "high");
    const auth = route({ ...request, reason: "retry", failed: { model, message: { errorMessage: "Invalid API key" }, thinkingLevel: "low" } as never });
    assert.equal(auth.thinkingLevel, "low");
    assert.equal(auth.state, undefined);
  });
});
