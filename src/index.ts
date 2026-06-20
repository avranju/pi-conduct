import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { validateCleanGit } from "./git.js";
import { createRunDirectory, saveUserPrompt, saveConfig, saveFinalSummary } from "./artifacts.js";
import { status, clearStatus, notify } from "./ui.js";
import { runConductWorkflow, type WorkflowResult } from "./supervisor.js";
import { generateRunId, slugify } from "./utils.js";

// ============================================================================
// Pi Conduct Extension - Entry Point
// ============================================================================

export default function conductExtension(pi: ExtensionAPI) {
  pi.registerCommand("conduct", {
    description: "Run the Pi Conduct multi-agent coding workflow",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const userPrompt = args.trim();

      // Validate input
      if (!userPrompt) {
        ctx.ui.notify("Usage: /conduct <task prompt>", "error");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Conduct requires interactive TUI mode", "error");
        return;
      }

      // Check git repo
      const gitRoot = await getGitRoot(ctx.cwd, ctx.exec.bind(ctx));
      if (!gitRoot) {
        ctx.ui.notify("Conduct requires a git repository", "error");
        return;
      }

      // --- Load Config ---
      const { config, warnings, configPath } = loadConfig(ctx.cwd);

      // Show config warnings
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }

      // --- Validate Clean Git ---
      if (config.loop.requireCleanGit) {
        const { clean, status: gitStatus } = await validateCleanGit(ctx.cwd, ctx.exec.bind(ctx));
        if (!clean) {
          const msg = [
            "Working tree is not clean. Aborting.",
            "Git status:",
            gitStatus.slice(0, 500),
            "",
            "Use --allow-dirty to proceed (not yet implemented).",
          ].join("\n");
          ctx.ui.notify(msg, "error");
          return;
        }
      }

      // --- Create Run Directory ---
      const slug = slugify(userPrompt, 3);
      const runId = generateRunId(slug);
      const artifactRoot = path.join(ctx.cwd, config.artifacts.root);
      const { dir: runDir, root: runRoot } = createRunDirectory(artifactRoot, runId);

      // Save initial artifacts
      saveUserPrompt(runDir, userPrompt);
      saveConfig(runDir, config);

      // --- Gather Repository Context ---
      const repoContext = await gatherRepoContext(ctx.cwd, ctx.exec.bind(ctx));

      // --- Run Workflow ---
      const result = await runConductWorkflow(userPrompt, config, ctx, repoContext, runDir);

      // --- Save Final Summary ---
      saveFinalSummary(runDir, result.summary);

      // --- Print Final Summary ---
      await printFinalSummary(result, ctx, runRoot);

      // --- Cleanup ---
      await clearStatus(ctx);
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function getGitRoot(cwd: string, execFn: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<string | null> {
  try {
    const result = await execFn("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
    if (result.code === 0) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

async function gatherRepoContext(
  cwd: string,
  execFn: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<string> {
  const parts: string[] = [];

  // Get git remote info
  try {
    const remote = await execFn("git", ["remote", "-v"], { timeout: 5000 });
    if (remote.code === 0 && remote.stdout.trim()) {
      parts.push(`## Git Remote\n${remote.stdout.trim().slice(0, 500)}`);
    }
  } catch {
    // Ignore
  }

  // Get file structure (top-level only)
  try {
    const lsResult = await execFn("ls", ["-la", cwd], { timeout: 5000 });
    if (lsResult.code === 0) {
      parts.push(`## Top-level Files\n\`\`\`\n${lsResult.stdout.trim().slice(0, 1000)}\n\`\`\``);
    }
  } catch {
    // Ignore
  }

  // Check for common project files
  const projectIndicators: string[] = [];
  const checkFiles = [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "build.gradle",
    "pom.xml",
    "Makefile",
    "README.md",
    "tsconfig.json",
  ];

  for (const file of checkFiles) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) {
      projectIndicators.push(file);
    }
  }

  if (projectIndicators.length > 0) {
    parts.push(`## Project Indicators: ${projectIndicators.join(", ")}`);
  }

  return parts.join("\n\n");
}

async function printFinalSummary(
  result: WorkflowResult,
  ctx: ExtensionCommandContext,
  artifactPath: string,
): Promise<void> {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Conduct completed successfully.");
  } else {
    lines.push("✗ Conduct stopped before approval.");
  }

  lines.push("");
  lines.push(`Reason: ${result.reason}`);
  lines.push(`Iterations: ${result.iterations}`);
  lines.push(`Modified files: ${result.modifiedFiles.length > 0 ? result.modifiedFiles.join(", ") : "none"}`);
  lines.push("");

  if (result.lastChecks && result.lastChecks.length > 0) {
    const checkSummary = result.lastChecks
      .map((g) => `${g.groupName}: ${g.results.every((r) => r.exitCode === 0) ? "✓" : "✗"}`)
      .join(", ");
    lines.push(`Checks: ${checkSummary}`);
  }

  if (result.lastReview) {
    lines.push(`Last reviewer: ${result.lastReview.status}`);
    if (result.lastReview.summary) {
      lines.push(`  ${result.lastReview.summary}`);
    }
  }

  lines.push("");
  lines.push(`Artifacts: ${artifactPath}`);

  const summary = lines.join("\n");
  ctx.ui.notify(summary, result.success ? "info" : "warning");
}
