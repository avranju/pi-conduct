import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Git Utilities (§8)
// ============================================================================

/** Shell executor shape (matches ExtensionAPI.exec). */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export async function getGitStatus(porcelain: boolean, exec: Exec): Promise<string> {
  try {
    const args = porcelain ? ["status", "--porcelain"] : ["status"];
    const result = await exec("git", args, { timeout: 10_000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function isGitRepo(exec: Exec): Promise<boolean> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function validateCleanGit(exec: Exec): Promise<{
  clean: boolean;
  status: string;
}> {
  const status = await getGitStatus(true, exec);
  return { clean: status.trim() === "", status };
}

export async function collectGitDiff(exec: Exec): Promise<{ diff: string; stat: string }> {
  const [diffResult, statResult] = await Promise.all([
    exec("git", ["diff"], { timeout: 15_000 }),
    exec("git", ["diff", "--stat"], { timeout: 10_000 }),
  ]);

  return {
    diff: diffResult.stdout,
    stat: statResult.stdout,
  };
}

export async function collectGitDiffStat(exec: Exec): Promise<string> {
  try {
    const result = await exec("git", ["diff", "--stat"], { timeout: 10_000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function collectModifiedFiles(exec: Exec): Promise<string[]> {
  try {
    const result = await exec("git", ["diff", "--name-only"], { timeout: 10_000 });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getGitRoot(exec: Exec): Promise<string | null> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5_000 });
    if (result.code === 0) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}
