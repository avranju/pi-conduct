import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { validateCleanGit, getGitRoot, type Exec } from "./git.js";
import {
  createRunDirectory,
  saveUserPrompt,
  saveConfig,
  saveFinalSummary,
} from "./artifacts.js";
import { status, clearStatus, notify } from "./ui.js";
import { runConductWorkflow, type WorkflowResult } from "./supervisor.js";
import { generateRunId, slugify } from "./utils.js";

// ============================================================================
// Pi Conduct Extension - Entry Point (§3)
// ============================================================================

export default function conductExtension(pi: ExtensionAPI) {
  pi.registerCommand("conduct", {
    description: "Run the Pi Conduct multi-agent coding workflow",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const userPrompt = args.trim();

      // §3: validate input
      if (!userPrompt) {
        ctx.ui.notify("Usage: /conduct <task prompt>", "error");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Conduct requires interactive TUI mode", "error");
        return;
      }

      const exec: Exec = pi.exec.bind(pi);

      // Must be a git repo (§8)
      const gitRoot = await getGitRoot(exec);
      if (!gitRoot) {
        ctx.ui.notify("Conduct requires a git repository", "error");
        return;
      }

      // --- Load Config (§4) ---
      const { config, warnings, configPaths } = loadConfig(ctx.cwd);
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }
      if (configPaths.length === 0) {
        ctx.ui.notify("Using safe default config (no config file found)", "info");
      }

      // --- Prepare Run Directory (§7) ---
      const slug = slugify(userPrompt, 3);
      const runId = generateRunId(slug);
      const artifactRoot = path.join(ctx.cwd, config.artifacts.root);
      const createRun = () => {
        const { dir } = createRunDirectory(artifactRoot, runId);
        saveUserPrompt(dir, userPrompt);
        // Save the resolved config for transparency and debugging, even if it
        // was all defaults or had parsing errors. This lets the user be able
        // to see exactly what config was used for the run.
        saveConfig(dir, config);
        return dir;
      };

      if (
        config.loop.requirePassingChecks &&
        config.commands.format.length === 0 &&
        config.commands.lint.length === 0 &&
        config.commands.test.length === 0
      ) {
        const runDir = createRun();
        const summary = [
          "Conduct stopped before approval.",
          "",
          "Reason: requirePassingChecks is true but no check commands are configured.",
          "",
          "Current state:",
          "- No agents were started.",
          "- Add commands.format, commands.lint, or commands.test, or set loop.requirePassingChecks to false.",
          "",
          "Artifacts:",
          runDir.root,
        ].join("\n");
        saveFinalSummary(runDir, summary);
        ctx.ui.notify(summary, "error");
        return;
      }

      // --- Validate Clean Git (§8) ---
      // Check before writing run artifacts when the tree is clean; if already
      // dirty, create a failure run afterward so even aborts have artifacts.
      if (config.loop.requireCleanGit) {
        const { clean, status: gitStatus } = await validateCleanGit(exec);
        if (!clean) {
          const runDir = createRun();
          const summary = [
            "Conduct stopped before approval.",
            "",
            "Reason: Working tree is not clean.",
            "",
            "Current state:",
            "- No agents were started.",
            "- Git status:",
            gitStatus.trim() || "(empty)",
            "",
            "Artifacts:",
            runDir.root,
          ].join("\n");
          saveFinalSummary(runDir, summary);
          const msg = [
            "Working tree is not clean. Aborting.",
            "Git status:",
            gitStatus.slice(0, 500),
            "",
            `Artifacts: ${runDir.root}`,
            "",
            "Future: use /conduct --allow-dirty <prompt> (not yet implemented).",
          ].join("\n");
          ctx.ui.notify(msg, "error");
          return;
        }
      }

      const runDir = createRun();

      // --- Gather Repository Context ---
      const repoContext = await gatherRepoContext(ctx.cwd, exec);

      // --- Workflow abort signal ---
      // ctx.signal is typically undefined in command handlers (the host agent is
      // idle), so create an internal controller and forward the host signal if
      // present.
      const controller = new AbortController();
      if (ctx.signal) {
        if (ctx.signal.aborted) controller.abort();
        else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const signal = controller.signal;

      // --- Run Workflow ---
      let result: WorkflowResult;
      try {
        result = await runConductWorkflow(
          userPrompt,
          config,
          ctx,
          exec,
          repoContext,
          runDir,
          signal,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const summary = `Conduct failed with an unexpected error: ${message}`;
        saveFinalSummary(runDir, summary);
        ctx.ui.notify(summary, "error");
        await clearStatus(ctx);
        return;
      }

      // --- Save Final Summary ---
      saveFinalSummary(runDir, result.summary);

      // --- Print Final Summary (§17) ---
      await printFinalSummary(result, ctx);

      // --- Cleanup ---
      await clearStatus(ctx);
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function gatherRepoContext(cwd: string, exec: Exec): Promise<string> {
  const parts: string[] = [];

  // Git remote info
  try {
    const remote = await exec("git", ["remote", "-v"], { timeout: 5_000 });
    if (remote.code === 0 && remote.stdout.trim()) {
      parts.push(`## Git Remote\n${remote.stdout.trim().slice(0, 500)}`);
    }
  } catch {
    // Ignore
  }

  // Top-level file structure
  try {
    const lsResult = await exec("ls", ["-la", cwd], { timeout: 5_000 });
    if (lsResult.code === 0) {
      parts.push(`## Top-level Files\n\`\`\`\n${lsResult.stdout.trim().slice(0, 1000)}\n\`\`\``);
    }
  } catch {
    // Ignore
  }

  // Common project files
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
  const projectIndicators: string[] = [];
  for (const file of checkFiles) {
    if (fs.existsSync(path.join(cwd, file))) {
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
  lines.push(
    `Modified files: ${result.modifiedFiles.length > 0 ? result.modifiedFiles.join(", ") : "none"}`,
  );
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
  lines.push(`Artifacts: ${result.artifactPath}`);

  ctx.ui.notify(lines.join("\n"), result.success ? "info" : "warning");
}
