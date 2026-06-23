import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

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

export async function collectGitDiff(
  exec: Exec,
  excludePaths: string[] = [],
): Promise<{ diff: string; stat: string }> {
  const pathspec = await buildExcludePathspec(exec, excludePaths);
  const pathArgs = pathspec.length > 0 ? ["--", ".", ...pathspec] : [];
  const [unstagedDiff, stagedDiff, unstagedStat, stagedStat, untracked] = await Promise.all([
    exec("git", ["diff", ...pathArgs], { timeout: 15_000 }),
    exec("git", ["diff", "--cached", ...pathArgs], { timeout: 15_000 }),
    exec("git", ["diff", "--stat", ...pathArgs], { timeout: 10_000 }),
    exec("git", ["diff", "--cached", "--stat", ...pathArgs], { timeout: 10_000 }),
    collectUntrackedFiles(exec, excludePaths),
  ]);

  const untrackedDiff = await buildUntrackedDiff(exec, untracked);
  const untrackedStat = await buildUntrackedStat(exec, untracked);

  return {
    diff: joinNonEmpty([
      unstagedDiff.stdout,
      stagedDiff.stdout,
      untrackedDiff,
    ]),
    stat: joinNonEmpty([
      unstagedStat.stdout,
      stagedStat.stdout ? `# Staged changes\n${stagedStat.stdout}` : "",
      untrackedStat,
    ]),
  };
}

export async function collectGitDiffStat(
  exec: Exec,
  excludePaths: string[] = [],
): Promise<string> {
  try {
    const diff = await collectGitDiff(exec, excludePaths);
    return diff.stat;
  } catch {
    return "";
  }
}

export async function collectModifiedFiles(
  exec: Exec,
  excludePaths: string[] = [],
): Promise<string[]> {
  try {
    const pathspec = await buildExcludePathspec(exec, excludePaths);
    const pathArgs = pathspec.length > 0 ? ["--", ".", ...pathspec] : [];
    const [unstaged, staged, untracked] = await Promise.all([
      exec("git", ["diff", "--name-only", ...pathArgs], { timeout: 10_000 }),
      exec("git", ["diff", "--cached", "--name-only", ...pathArgs], { timeout: 10_000 }),
      collectUntrackedFiles(exec, excludePaths),
    ]);
    const files = [
      ...splitLines(unstaged.stdout),
      ...splitLines(staged.stdout),
      ...untracked,
    ];
    return [...new Set(files)].sort();
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

export async function getGitHead(exec: Exec): Promise<string> {
  try {
    const result = await exec("git", ["rev-parse", "HEAD"], { timeout: 5_000 });
    return result.code === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

export async function fingerprintWorkspace(
  exec: Exec,
  excludePaths: string[] = [],
): Promise<string> {
  const root = await getGitRoot(exec);
  if (!root) throw new Error("Cannot fingerprint a non-git workspace");
  const [head, diff, files] = await Promise.all([
    getGitHead(exec),
    collectGitDiff(exec, excludePaths),
    collectModifiedFiles(exec, excludePaths),
  ]);
  const hash = createHash("sha256");
  hash.update(`HEAD\0${head}\0DIFF\0${diff.diff}\0`);
  for (const file of files) {
    hash.update(`PATH\0${file}\0`);
    const fullPath = path.join(root, file);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) hash.update(`LINK\0${fs.readlinkSync(fullPath)}\0`);
      else if (stat.isFile()) hash.update(fs.readFileSync(fullPath));
      else hash.update(`TYPE\0${stat.mode}\0`);
    } catch {
      hash.update("MISSING\0");
    }
  }
  return hash.digest("hex");
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function joinNonEmpty(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

async function buildExcludePathspec(exec: Exec, excludePaths: string[]): Promise<string[]> {
  if (excludePaths.length === 0) return [];
  const root = await getGitRoot(exec);
  if (!root) return [];

  const specs: string[] = [];
  for (const excludePath of excludePaths) {
    const relative = path.isAbsolute(excludePath)
      ? path.relative(root, excludePath)
      : excludePath;
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join("/").replace(/\/+$/, "");
    if (normalized) specs.push(`:(exclude)${normalized}/**`);
  }
  return specs;
}

async function collectUntrackedFiles(
  exec: Exec,
  excludePaths: string[] = [],
): Promise<string[]> {
  try {
    const pathspec = await buildExcludePathspec(exec, excludePaths);
    const pathArgs = pathspec.length > 0 ? ["--", ".", ...pathspec] : [];
    const result = await exec("git", ["ls-files", "--others", "--exclude-standard", ...pathArgs], {
      timeout: 10_000,
    });
    if (result.code !== 0) return [];
    return splitLines(result.stdout);
  } catch {
    return [];
  }
}

async function buildUntrackedDiff(exec: Exec, files: string[]): Promise<string> {
  if (files.length === 0) return "";
  const root = await getGitRoot(exec);
  if (!root) return "";

  const patches: string[] = [];
  for (const file of files) {
    patches.push(buildNewFilePatch(root, file));
  }
  return joinNonEmpty(patches);
}

async function buildUntrackedStat(exec: Exec, files: string[]): Promise<string> {
  if (files.length === 0) return "";
  const root = await getGitRoot(exec);
  if (!root) return `# Untracked files\n${files.map((f) => ` ${f}`).join("\n")}`;

  const lines = ["# Untracked files"];
  let totalLines = 0;
  for (const file of files) {
    const fullPath = path.join(root, file);
    const lineCount = countTextLines(fullPath);
    totalLines += Math.max(lineCount, 0);
    lines.push(` ${file} | ${lineCount >= 0 ? lineCount : "binary/large"}`);
  }
  if (totalLines > 0) {
    lines.push(` ${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalLines} insertion${totalLines === 1 ? "" : "s"}(+)`);
  }
  return lines.join("\n");
}

function buildNewFilePatch(repoRoot: string, relativeFile: string): string {
  const fullPath = path.join(repoRoot, relativeFile);
  if (!isSafeRepoPath(repoRoot, fullPath)) {
    return `diff --git a/${relativeFile} b/${relativeFile}\n# Skipped unsafe untracked path`;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return `diff --git a/${relativeFile} b/${relativeFile}\n# Could not stat untracked file`;
  }
  if (!stat.isFile()) {
    return `diff --git a/${relativeFile} b/${relativeFile}\n# Untracked path is not a regular file`;
  }
  if (stat.size > 200_000) {
    return [
      `diff --git a/${relativeFile} b/${relativeFile}`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/${relativeFile}`,
      `# Large untracked file omitted from inline diff (${stat.size} bytes)`,
    ].join("\n");
  }

  const buffer = fs.readFileSync(fullPath);
  if (buffer.includes(0)) {
    return `diff --git a/${relativeFile} b/${relativeFile}\nBinary files /dev/null and b/${relativeFile} differ`;
  }

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [
    `diff --git a/${relativeFile} b/${relativeFile}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${relativeFile}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function countTextLines(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 200_000) return -1;
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return -1;
    if (buffer.length === 0) return 0;
    const text = buffer.toString("utf8");
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return -1;
  }
}

function isSafeRepoPath(repoRoot: string, fullPath: string): boolean {
  const relative = path.relative(repoRoot, fullPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
