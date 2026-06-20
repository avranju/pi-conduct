import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./schemas.js";
import { truncate } from "./utils.js";
import type { Exec } from "./git.js";

// ============================================================================
// Check Execution (§9)
// ============================================================================

export interface CheckGroup {
  groupName: string;
  results: CheckResult[];
}

export async function runCheckCommand(
  command: string,
  exec: Exec,
  timeoutMs: number = 120_000,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await exec("sh", ["-c", command], { timeout: timeoutMs });
    return {
      command,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Command execution failed";
    return {
      command,
      exitCode: -1,
      stdout: "",
      stderr: message,
      durationMs: Date.now() - start,
    };
  }
}

export async function runConfiguredChecks(
  commands: { format: string[]; lint: string[]; test: string[] },
  exec: Exec,
): Promise<CheckGroup[]> {
  const groups: CheckGroup[] = [];

  // §9: format -> lint -> test
  for (const [groupName, cmds] of [
    ["format", commands.format],
    ["lint", commands.lint],
    ["test", commands.test],
  ] as const) {
    if (cmds.length === 0) continue;
    const results: CheckResult[] = [];
    for (const cmd of cmds) {
      results.push(await runCheckCommand(cmd, exec));
    }
    groups.push({ groupName, results });
  }

  return groups;
}

export function evaluateRequiredChecks(
  groups: CheckGroup[],
  requirePassingChecks: boolean,
): boolean {
  if (!requirePassingChecks) return true;
  if (groups.length === 0) return true; // No checks configured, pass by default

  for (const group of groups) {
    for (const result of group.results) {
      if (result.exitCode !== 0) {
        return false;
      }
    }
  }
  return true;
}

export function checkGroupsHaveFailures(groups: CheckGroup[]): boolean {
  for (const group of groups) {
    for (const result of group.results) {
      if (result.exitCode !== 0) {
        return true;
      }
    }
  }
  return false;
}

export function summarizeCheckGroups(groups: CheckGroup[]): string {
  if (groups.length === 0) return "(no checks configured)";

  const parts: string[] = [];
  for (const group of groups) {
    const allPassed = group.results.every((r) => r.exitCode === 0);
    const status = allPassed ? "✓ PASSED" : "✗ FAILED";
    parts.push(`--- ${group.groupName} (${status}) ---`);
    for (const result of group.results) {
      const cmdStatus = result.exitCode === 0 ? "PASS" : "FAIL";
      const summary = truncate(result.stdout || result.stderr, 1000);
      parts.push(`  [${cmdStatus}] ${result.command} (exit ${result.exitCode}, ${result.durationMs}ms)`);
      if (summary) {
        parts.push(`    ${summary}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}
