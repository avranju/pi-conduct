// ============================================================================
// Safe Bash Tool (§15.1, §15.3)
//
// A custom "bash" ToolDefinition that wraps Pi's built-in local bash operations
// with a guard. Dangerous commands are always blocked; network/package-install
// commands are blocked when safety.allowNetwork is false. Passed via
// createAgentSession's `customTools`, it overrides the built-in "bash" tool
// (same-name custom tools take precedence in the tool registry).
// ============================================================================

import {
  createBashToolDefinition,
  createLocalBashOperations,
  defineTool,
  type BashOperations,
  type BashToolOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { SafetyConfig } from "./schemas.js";
import { isBlockedCommand, isNetworkCommand } from "./utils.js";

/**
 * Build BashOperations that enforce the conduct safety policy before delegating
 * to Pi's standard local shell execution backend.
 */
function guardedOperations(safety: SafetyConfig, shellPath?: string): BashOperations {
  const base = createLocalBashOperations({ shellPath });
  return {
    exec: async (command, cwd, options) => {
      if (isBlockedCommand(command, safety.blockedCommandPatterns)) {
        const msg = `[conduct] Blocked dangerous command: ${command}\n`;
        options.onData(Buffer.from(msg, "utf8"));
        return { exitCode: 1 };
      }
      if (!safety.allowNetwork && isNetworkCommand(command)) {
        const msg = `[conduct] Network/package install disabled (safety.allowNetwork=false): ${command}\n`;
        options.onData(Buffer.from(msg, "utf8"));
        return { exitCode: 1 };
      }
      return base.exec(command, cwd, options);
    },
  };
}

/**
 * Create a safe "bash" tool definition for the given cwd and safety policy.
 * The returned definition is named "bash" so it overrides the built-in.
 */
export function createSafeBashTool(
  cwd: string,
  safety: SafetyConfig,
  options: Pick<BashToolOptions, "shellPath" | "commandPrefix"> = {},
): ToolDefinition {
  return defineTool(createBashToolDefinition(cwd, { ...options, operations: guardedOperations(safety, options.shellPath) }));
}
