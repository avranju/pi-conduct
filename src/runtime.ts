import * as path from "node:path";
import * as fs from "node:fs";
import {
  ModelRuntime,
  createCodemodeExtension,
  createMcpExtension,
  getAgentDir,
  type AgentSession,
  type SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type ModelRegistry,
  type ModelRoute,
  type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole, ConductConfig, ModelConfig, ModelSelection } from "./schemas.js";
import { HANDOFF_NAMES } from "./handoffs.js";
import { isTransientModelError } from "./utils.js";
import { RunUsageLedger, getSessionMessages } from "./usage.js";

export type HostSettings = ReturnType<ExtensionAPI["getSettings"]>;
export const ROLE_TOOLS: Record<AgentRole, string[]> = {
  planner: ["read", "grep", "find", "ls", "bash"],
  coder: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  reviewer: ["read", "grep", "find", "ls", "bash"],
};

/** Deliberately exclude defaults, resources, packages, trust policy and session paths. */
export function selectRoleSettings(host: HostSettings = {}): HostSettings {
  const keys = [
    "transport", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "httpProxy",
    "compaction", "retry", "thinkingBudgets", "cacheWarming", "showCacheMissNotices",
    "shellPath", "shellCommandPrefix", "images", "terminal", "markdown", "warnings",
  ] as const;
  const settings: HostSettings = { compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } };
  for (const key of keys) {
    if (host[key] !== undefined) Object.assign(settings, { [key]: structuredClone(host[key]) });
  }
  return settings;
}

/** Copy public provider registrations, not factories/tools/commands or opaque virtual routers. */
export async function inheritProviders(runtime: ModelRuntime, host: ModelRegistry, providers: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const id of new Set(providers)) {
    signal?.throwIfAborted();
    const native = host.getRegisteredNativeProvider(id);
    const config = host.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    if (config) runtime.registerProvider(id, config);
    // Runtime --api-key overrides aren't in auth.json. Never freeze an OAuth token into an API key.
    if (host.getProviderAuthStatus(id).source === "runtime") {
      const key = await host.getApiKeyForProvider(id);
      signal?.throwIfAborted();
      if (key) await runtime.setRuntimeApiKey(id, key, { signal });
    }
  }
  // Selected providers may discover their catalog through refreshModels(). This is provider
  // integration traffic, not role-tool network access; do not refresh unrelated providers here.
  await runtime.refresh({ allowNetwork: true, providers: [...new Set(providers)], signal });
  signal?.throwIfAborted();
}

interface RoutingState { target: "continuation" | "fallback" }
export function createRoleRouter(runtime: ModelRuntime, config: ModelConfig, patterns: string[] = []) {
  const to = (selection: ModelSelection, state?: RoutingState): ModelRoute<RoutingState> => {
    const model = runtime.getPhysicalModel(selection.provider, selection.model);
    if (!model) throw new Error(`Routing target is not a physical catalog model: ${selection.provider}/${selection.model}`);
    return { model, thinkingLevel: selection.thinkingLevel, state };
  };
  return (request: ModelRouteRequest<RoutingState>): ModelRoute<RoutingState> => {
    const routing = config.routing;
    if (request.reason === "retry" && routing?.fallback && request.state?.target !== "fallback" &&
        isTransientModelError(request.failed?.message.errorMessage, patterns)) {
      return to(routing.fallback, { target: "fallback" });
    }
    if (request.reason === "retry" && request.failed) {
      return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? config.thinkingLevel, state: request.state };
    }
    if (request.state?.target === "fallback" && routing?.fallback) return to(routing.fallback, request.state);
    if (request.state?.target === "continuation" && routing?.continuation) return to(routing.continuation, request.state);
    if ((request.reason === "continuation" || request.reason === "direct") && routing?.continuation) {
      return to(routing.continuation, { target: "continuation" });
    }
    return to(config);
  };
}

export function routedRoleModel(runtime: ModelRuntime, role: AgentRole, config: ModelConfig, patterns: string[] = []) {
  if (!config.routing?.continuation && !config.routing?.fallback) return runtime.getModel(config.provider, config.model);
  const primary = runtime.getPhysicalModel(config.provider, config.model);
  if (!primary) throw new Error(`Configured model not found: ${config.provider}/${config.model}`);
  // Validate every target before any agent is started.
  for (const selection of [config.routing.continuation, config.routing.fallback]) {
    if (selection && !runtime.getPhysicalModel(selection.provider, selection.model)) {
      throw new Error(`Routing target not found: ${selection.provider}/${selection.model}`);
    }
  }
  runtime.registerVirtualModel({
    provider: "pi-conduct", id: role, name: `Conduct ${role}`,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: primary.contextWindow, maxTokens: primary.maxTokens, input: [...primary.input],
    route: createRoleRouter(runtime, config, patterns),
  });
  return runtime.getModel("pi-conduct", role);
}

export function roleMcpConfig(role: AgentRole, config: ConductConfig): LoadedMcpConfig {
  const mcp = config.capabilities.mcp;
  const servers: LoadedMcpConfig["servers"] = [];
  if (!mcp.enabled) return { servers, errors: [], autoEnableCodemode: false };
  const tools = mcp.tools[role];
  const namespaces = new Set<string>();
  for (const [name, connection] of Object.entries(mcp.servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
    const namespace = name.replaceAll("-", "_");
    if (namespaces.has(namespace)) throw new Error(`MCP server names collide after normalization: ${name}`);
    namespaces.add(namespace);
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) throw new Error(`Invalid MCP connection config for ${name}`);
    if (!tools.some((tool) => tool.startsWith(`mcp__${namespace}__`))) continue;
    if (connection.enabled === false) continue;
    if (!("command" in connection && typeof connection.command === "string" && connection.command.trim()) &&
        !("url" in connection && typeof connection.url === "string" && /^https?:\/\//.test(connection.url))) {
      throw new Error(`Invalid MCP connection config for ${name}`);
    }
    if ("url" in connection && !config.safety.allowNetwork) {
      throw new Error(`HTTP MCP server ${name} requires safety.allowNetwork=true`);
    }
    servers.push({
      name, source: "pi-conduct", scope: "extension",
      // SDK tool allowlists filter registrations too, including indirect codemode access.
      config: { ...connection, exposure: "direct", toolExposure: {} },
    });
  }
  for (const tool of tools) {
    if (!/^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(tool)) throw new Error(`MCP allowlists require exact fully-qualified names: ${tool}`);
    if (!servers.some(({ name }) => tool.startsWith(`mcp__${name.replaceAll("-", "_")}__`))) {
      throw new Error(`MCP tool ${tool} has no enabled connection config`);
    }
  }
  return { servers, errors: [], autoEnableCodemode: false };
}

export function roleExtensions(role: AgentRole, config: ConductConfig): { factories: ExtensionFactory[]; tools: string[] } {
  const mcp = roleMcpConfig(role, config);
  const allowedMcp = config.capabilities.mcp.enabled ? config.capabilities.mcp.tools[role] : [];
  const tools = [...ROLE_TOOLS[role], HANDOFF_NAMES[role], ...allowedMcp];
  const factories: ExtensionFactory[] = [];
  if (config.capabilities.codemode.enabled) {
    factories.push(createCodemodeExtension({ ...config.capabilities.codemode, models: false }));
    tools.push("codemode");
  }
  if (mcp.servers.length > 0) factories.push(createMcpExtension({ loadConfig: () => mcp }));
  // Include an unmatched MCP name when there are no allowed MCP tools, so Pi cannot implicitly
  // keep all MCP registrations. Resource tools never bypass the exact role allowlist.
  if (allowedMcp.length === 0) tools.push("mcp__conduct_disabled__none");
  const allowed = new Set(tools);
  factories.push((pi) => {
    pi.on("tool_call", (event) => {
      if (!allowed.has(event.toolName)) return { block: true, reason: "Tool is outside the Conduct role allowlist" };
      if (event.toolName.startsWith("mcp__") && role !== "coder") {
        const hints = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
        if (hints?.readOnlyHint !== true || hints.destructiveHint === true) {
          return { block: true, reason: "Planner/reviewer MCP tools must declare readOnlyHint=true and must not declare destructiveHint=true" };
        }
      }
    });
  });
  return { factories, tools };
}

export interface WorkflowAgentServices {
  agentDir: string;
  modelRuntime: ModelRuntime;
  settings: HostSettings;
  config: ConductConfig;
  usage: RunUsageLedger;
  runName: string;
  projectTrusted: boolean;
  createSessionManager?(): SessionManager;
  onSessionFinished(role: AgentRole, label: string, attempt: number, session: AgentSession): void;
}

export async function createWorkflowAgentServices(config: ConductConfig, ctx: ExtensionCommandContext, pi: ExtensionAPI, root: string, signal?: AbortSignal, agentDir = getAgentDir()): Promise<WorkflowAgentServices> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), signal,
  });
  const selections = Object.values(config.models).flatMap((model) => [model, model.routing?.continuation, model.routing?.fallback]).filter((model): model is ModelSelection => model !== undefined);
  if (config.sessions.inheritProviders) await inheritProviders(modelRuntime, ctx.modelRegistry, selections.map((model) => model.provider), signal);
  signal?.throwIfAborted();
  for (const role of ["planner", "coder", "reviewer"] as const) {
    if (!routedRoleModel(modelRuntime, role, config.models[role], config.retry.retryableErrorPatterns)) {
      throw new Error(`Configured model not found: ${config.models[role].provider}/${config.models[role].model}. Host virtual routers cannot be copied; configure Conduct routing with physical targets.`);
    }
    roleMcpConfig(role, config);
  }
  const usage = new RunUsageLedger(root);
  return {
    agentDir, modelRuntime, config, usage,
    settings: selectRoleSettings(config.sessions.inheritSettings ? pi.getSettings() : {}),
    runName: path.basename(root), projectTrusted: ctx.isProjectTrusted(),
    onSessionFinished: (role, label, attempt, session) => {
      usage.record(role, label, attempt, session);
      if (config.artifacts.keepTranscripts) {
        const directory = path.join(root, "sessions");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `${session.sessionId}.json`), JSON.stringify(getSessionMessages(session), null, 2), { mode: 0o600 });
        fs.writeFileSync(path.join(directory, `${session.sessionId}.entries.json`), JSON.stringify(session.sessionManager.getEntries(), null, 2), { mode: 0o600 });
      }
    },
  };
}
