import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./schemas.js";
import { truncate } from "./utils.js";

// ============================================================================
// Check Execution
// ============================================================================

export interface CheckGroup {
  groupName: string;
  results: CheckResult[];
}

export async function runCheckCommand(
  command: string,
  exec: ExtensionAPI["exec"],
  timeoutMs: number = 120_000,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await exec("sh", ["-c", command], { timeout: timeoutMs });
    return {
      command,
      exitCode: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      command,
      exitCode: -1,
      stdout: "",
      stderr: err.message || "Command execution failed",
      durationMs: Date.now() - start,
    };
  }
}

export async function runConfiguredChecks(
  commands: { format: string[]; lint: string[]; test: string[] },
  exec: ExtensionAPI["exec"],
): Promise<CheckGroup[]> {
  const groups: CheckGroup[] = [];

  // Run format checks
  if (commands.format.length > 0) {
    const results: CheckResult[] = [];
    for (const cmd of commands.format) {
      results.push(await runCheckCommand(cmd, exec));
    }
    groups.push({ groupName: "format", results });
  }

  // Run lint checks
  if (commands.lint.length > 0) {
    const results: CheckResult[] = [];
    for (const cmd of commands.lint) {
      results.push(await runCheckCommand(cmd, exec));
    }
    groups.push({ groupName: "lint", results });
  }

  // Run test checks
  if (commands.test.length > 0) {
    const results: CheckResult[] = [];
    for (const cmd of commands.test) {
      results.push(await runCheckCommand(cmd, exec));
    }
    groups.push({ groupName: "test", results });
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
      parts.push(`  [${cmdStatus}] ${result.command}`);
      if (summary) {
        parts.push(`    ${summary}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}
