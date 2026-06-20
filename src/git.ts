import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Git Utilities
// ============================================================================

export async function getGitStatus(porcelain: boolean, exec: ExtensionAPI["exec"]): Promise<string> {
  try {
    const result = await exec("git", ["status", porcelain ? "--porcelain" : ""], { timeout: 10000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function isGitRepo(cwd: string, exec: ExtensionAPI["exec"]): Promise<boolean> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function validateCleanGit(cwd: string, exec: ExtensionAPI["exec"]): Promise<{
  clean: boolean;
  status: string;
}> {
  const status = await getGitStatus(true, exec);
  return { clean: status.trim() === "", status };
}

export async function collectGitDiff(
  exec: ExtensionAPI["exec"],
): Promise<{ diff: string; stat: string }> {
  const [diffResult, statResult] = await Promise.all([
    exec("git", ["diff"], { timeout: 15000 }),
    exec("git", ["diff", "--stat"], { timeout: 10000 }),
  ]);

  return {
    diff: diffResult.stdout,
    stat: statResult.stdout,
  };
}

export async function collectGitDiffStat(exec: ExtensionAPI["exec"]): Promise<string> {
  try {
    const result = await exec("git", ["diff", "--stat"], { timeout: 10000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function collectModifiedFiles(exec: ExtensionAPI["exec"]): Promise<string[]> {
  try {
    const result = await exec("git", ["diff", "--name-only"], { timeout: 10000 });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getGitRoot(cwd: string, exec: ExtensionAPI["exec"]): Promise<string | null> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
    if (result.code === 0) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}
