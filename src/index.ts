import {
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { validateCleanGit, getGitRoot, type Exec } from "./git.js";
import {
  createRunDirectory,
  saveUserPrompt,
  saveConfig,
  saveFinalSummary,
  acquireRunLock,
  type RunDirectory,
} from "./artifacts.js";
import { ConductProgress } from "./ui.js";
import { runConductWorkflow, type WorkflowResult } from "./supervisor.js";
import { generateRunId, slugify } from "./utils.js";
import {
  loadResumeRun,
  markRunInterrupted,
  type ResumeWorkflowData,
} from "./resume.js";
import type { ConductConfig } from "./schemas.js";
import { getLiveOutputKeybindings, matchesAnyKey } from "./keybindings.js";

// ============================================================================
// Pi Conduct Extension - Entry Point (§3)
// ============================================================================

const CONDUCT_PROMPT_MESSAGE_TYPE = "conduct-user-prompt";

export default function conductExtension(pi: ExtensionAPI) {
  let activeProgress: ConductProgress | undefined;

  pi.registerMessageRenderer(CONDUCT_PROMPT_MESSAGE_TYPE, (message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    return new UserMessageComponent(text);
  });

  const startupConfig = loadConfig(process.cwd()).config;
  for (const shortcut of getLiveOutputKeybindings(startupConfig)) {
    pi.registerShortcut(shortcut, {
      description: "Show live Conduct sub-agent output",
      handler: async (ctx) => {
        if (!activeProgress) {
          ctx.ui.notify("No Conduct workflow is active", "info");
          return;
        }
        await activeProgress.showDetails(ctx);
      },
    });
  }

  const executeRun = async (
    userPrompt: string,
    config: ConductConfig,
    ctx: ExtensionCommandContext,
    exec: Exec,
    repoContext: string,
    runDir: RunDirectory,
    resume?: ResumeWorkflowData,
  ): Promise<void> => {
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = acquireRunLock(runDir);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    const controller = new AbortController();
    const liveOutputKeybindings = getLiveOutputKeybindings(config);
    const progress = new ConductProgress(ctx, liveOutputKeybindings);
    activeProgress?.clear();
    activeProgress = progress;
    let cancellationConfirmationOpen = false;
    let cancellationConfirmationController: AbortController | undefined;
    let workflowSettled = false;

    const requestCancellation = async (): Promise<void> => {
      if (cancellationConfirmationOpen || controller.signal.aborted) return;
      cancellationConfirmationOpen = true;
      const confirmationController = new AbortController();
      cancellationConfirmationController = confirmationController;
      try {
        const confirmed = await ctx.ui.confirm(
          "Cancel Conduct workflow?",
          "The active sub-agent or check command will be stopped. Any file changes already made will remain in the working tree and the run can be resumed.",
          { signal: confirmationController.signal },
        );
        if (confirmed && !workflowSettled && !controller.signal.aborted) {
          progress.setActivity("Cancelling workflow…");
          controller.abort();
        }
      } catch {
        // The workflow may finish while the confirmation dialog is open.
      } finally {
        if (cancellationConfirmationController === confirmationController) {
          cancellationConfirmationController = undefined;
        }
        cancellationConfirmationOpen = false;
      }
    };

    const showDetailsOnShortcut = ctx.ui.onTerminalInput((data) => {
      if (
        isKeyRelease(data) ||
        progress.isShowingDetails() ||
        cancellationConfirmationOpen ||
        !matchesAnyKey(data, liveOutputKeybindings)
      ) return;
      void progress.showDetails(ctx);
      return { consume: true };
    });

    const cancelOnEscape = ctx.ui.onTerminalInput((data) => {
      if (
        isKeyRelease(data) ||
        !matchesKey(data, Key.escape) ||
        progress.isShowingDetails() ||
        cancellationConfirmationOpen
      ) return;
      void requestCancellation();
      return { consume: true };
    });
    const forwardHostAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", forwardHostAbort, { once: true });
    }

    let result: WorkflowResult;
    try {
      result = await runConductWorkflow(
        userPrompt,
        config,
        ctx,
        exec,
        repoContext,
        runDir,
        controller.signal,
        progress,
        resume,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const summary = [
        `Conduct was interrupted by an unexpected error: ${message}`,
        "",
        `Resume with: /conduct resume ${path.basename(runDir.root)}`,
      ].join("\n");
      try {
        await markRunInterrupted(runDir, exec, message, "unexpected");
      } catch {
        // Preserve the original failure when checkpointing also fails.
      }
      saveFinalSummary(runDir, summary);
      progress.failStep(message);
      progress.finish();
      const progressLines = progress.getSummaryLines();
      progress.clear();
      if (activeProgress === progress) activeProgress = undefined;
      ctx.ui.notify([summary, "", ...progressLines].join("\n"), "error");
      return;
    } finally {
      workflowSettled = true;
      cancellationConfirmationController?.abort();
      showDetailsOnShortcut();
      cancelOnEscape();
      ctx.signal?.removeEventListener("abort", forwardHostAbort);
      releaseLock?.();
    }

    saveFinalSummary(runDir, result.summary);
    const progressLines = progress.getSummaryLines();
    progress.clear();
    if (activeProgress === progress) activeProgress = undefined;
    await printFinalSummary(result, ctx, progressLines);
  };

  pi.registerCommand("conduct", {
    description: "Run the Pi Conduct multi-agent coding workflow",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const commandArgs = args.trim();
      const resumeMatch = /^resume(?:\s+(.+))?$/.exec(commandArgs);

      // §3: validate input
      if (!commandArgs || (resumeMatch && !resumeMatch[1]?.trim())) {
        ctx.ui.notify("Usage: /conduct <task prompt> | /conduct resume <run-id>", "error");
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
      const { config: currentConfig, warnings, configPaths } = loadConfig(ctx.cwd);
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }
      if (configPaths.length === 0) {
        ctx.ui.notify("Using safe default config (no config file found)", "info");
      }

      if (resumeMatch) {
        const requestedRunId = resumeMatch[1]!.trim();
        const artifactRoot = path.join(ctx.cwd, currentConfig.artifacts.root);
        try {
          const loaded = await loadResumeRun(artifactRoot, requestedRunId, gitRoot, exec);
          pi.sendMessage({
            customType: CONDUCT_PROMPT_MESSAGE_TYPE,
            content: `Resume Conduct run ${requestedRunId}\n\n${loaded.userPrompt}`,
            display: true,
          });
          const repoContext = await gatherRepoContext(ctx.cwd, exec);
          await executeRun(
            loaded.userPrompt,
            loaded.config,
            ctx,
            exec,
            repoContext,
            loaded.dir,
            loaded.resume,
          );
        } catch (error) {
          ctx.ui.notify(
            `Cannot resume Conduct run: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      const userPrompt = commandArgs;
      const config = currentConfig;
      // Slash commands are not rendered as user messages by Pi. Persist the
      // task as a non-triggering custom message and render it with Pi's native
      // user-message component so the task remains visible above progress.
      pi.sendMessage({
        customType: CONDUCT_PROMPT_MESSAGE_TYPE,
        content: userPrompt,
        display: true,
      });

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
      await executeRun(userPrompt, config, ctx, exec, repoContext, runDir);

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
  progressLines: string[],
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

  if (result.resumable) {
    lines.push(`Resume with: /conduct resume ${path.basename(result.artifactPath)}`);
  }

  if (progressLines.length > 0) {
    lines.push("");
    lines.push(...progressLines);
  }

  ctx.ui.notify(lines.join("\n"), result.success ? "info" : "warning");
}
