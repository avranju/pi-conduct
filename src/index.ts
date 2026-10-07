import {
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { validateCleanGit, getGitRoot, collectModifiedFiles, type Exec } from "./git.js";
import {
  createRunDirectory,
  saveUserPrompt,
  saveConfig,
  saveFinalSummary,
  acquireRunLock,
  acquireRepositoryLock,
  saveState,
  readJson,
  type RunDirectory,
} from "./artifacts.js";
import { ConductProgress } from "./ui.js";
import { runConductWorkflow, type WorkflowResult } from "./supervisor.js";
import { generateRunId, slugify } from "./utils.js";
import {
  loadResumeRun,
  markRunInterrupted,
  initializeRunIdentity,
  type ResumeWorkflowData,
} from "./resume.js";
import { emptyRunState, type ConductConfig, type RunState } from "./schemas.js";
import { createWorkflowAgentServices, type WorkflowAgentServices } from "./runtime.js";
import { WorkflowOwner, type ActiveWorkflow } from "./lifecycle.js";
import { publishResult, registerResultRenderer } from "./results.js";
import { formatUsage } from "./usage.js";
import { getLiveOutputKeybindings, matchesAnyKey } from "./keybindings.js";

// ============================================================================
// Pi Conduct Extension - Entry Point (§3)
// ============================================================================

const CONDUCT_PROMPT_MESSAGE_TYPE = "conduct-user-prompt";

export default function conductExtension(pi: ExtensionAPI) {
  let activeProgress: ConductProgress | undefined;
  const owner = new WorkflowOwner();
  registerResultRenderer(pi);
  pi.on("session_shutdown", async () => { await owner.shutdown(); });
  pi.on("input", (_event, ctx) => {
    if (!owner.isActive) return;
    ctx.ui.notify("Conduct is active. Cancel it before starting parent-agent work.", "warning");
    return { action: "handled" };
  });
  pi.on("tool_call", () => owner.isActive
    ? { block: true, reason: "Conduct owns this working tree until its workflow finishes" }
    : undefined);
  pi.on("session_before_tree", (_event, ctx) => {
    if (!owner.isActive) return;
    ctx.ui.notify("Finish or cancel Conduct before navigating the session tree.", "warning");
    return { cancel: true };
  });

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
    activeRun: ActiveWorkflow,
    resume?: ResumeWorkflowData,
  ): Promise<void> => {
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = acquireRunLock(runDir);
      activeRun.addCleanup(releaseLock);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    const controller = activeRun.controller;
    let services: WorkflowAgentServices | undefined;
    const liveOutputKeybindings = getLiveOutputKeybindings(config);
    const progress = new ConductProgress(ctx, liveOutputKeybindings);
    activeProgress = progress;
    activeRun.addCleanup(() => {
      progress.clear();
      if (activeProgress === progress) activeProgress = undefined;
    });
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

    activeRun.addCleanup(showDetailsOnShortcut);
    const cancelOnEscape = ctx.ui.onTerminalInput((data) => {
      if (
        isKeyRelease(data) ||
        !getKeybindings().matches(data, "app.interrupt") ||
        progress.isShowingDetails() ||
        cancellationConfirmationOpen
      ) return;
      void requestCancellation();
      return { consume: true };
    });
    activeRun.addCleanup(cancelOnEscape);
    const forwardHostAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", forwardHostAbort, { once: true });
      activeRun.addCleanup(() => ctx.signal?.removeEventListener("abort", forwardHostAbort));
    }

    let result: WorkflowResult;
    try {
      if (!resume) {
        const initial = emptyRunState(config.loop.maxIterations);
        await initializeRunIdentity(initial, runDir, exec);
        saveState(runDir, initial);
      }
      services = await createWorkflowAgentServices(config, ctx, pi, runDir.root, controller.signal);
      progress.setUsageLedger(services.usage);
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
        services,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const usage = services?.usage.snapshot();
      const modifiedFiles = await collectModifiedFiles(exec, [runDir.root]).catch(() => []);
      let iterations = resume?.state.iteration ?? 0;
      try { iterations = readJson<RunState>(runDir.statePath).iteration; } catch { /* Preflight may not have saved state. */ }
      const summary = [
        `Conduct was interrupted by an unexpected error: ${message}`,
        ...(usage ? ["", formatUsage(usage.totals)] : []),
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
      publishResult(pi, {
        success: false, reason: message, iterations,
        modifiedFiles, summary, artifactPath: runDir.root, resumable: true,
      }, progressLines, usage);
      return;
    } finally {
      workflowSettled = true;
      cancellationConfirmationController?.abort();
      showDetailsOnShortcut();
      cancelOnEscape();
      ctx.signal?.removeEventListener("abort", forwardHostAbort);
      releaseLock?.();
    }

    const usage = services?.usage.snapshot();
    if (usage) result.summary += `\n\n${formatUsage(usage.totals)}`;
    saveFinalSummary(runDir, result.summary);
    const progressLines = progress.getSummaryLines();
    progress.clear();
    if (activeProgress === progress) activeProgress = undefined;
    publishResult(pi, result, progressLines, usage);
  };

  pi.registerCommand("conduct", {
    description: "Run the Pi Conduct multi-agent coding workflow",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const commandArgs = args.trim();
      const resumeMatch = /^resume(?:\s+(.+))?$/.exec(commandArgs);
      const forceResumeMatch = /^force-resume(?:\s+(.+))?$/.exec(commandArgs);
      const requestedResume = resumeMatch ?? forceResumeMatch;

      // §3: validate input
      if (!commandArgs || (requestedResume && !requestedResume[1]?.trim())) {
        ctx.ui.notify(
          "Usage: /conduct <task prompt> | /conduct resume <run-id> | /conduct force-resume <run-id>",
          "error",
        );
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Conduct requires interactive TUI mode", "error");
        return;
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the parent agent and queued messages to finish before starting Conduct", "warning");
        return;
      }
      let activeRun: ActiveWorkflow;
      try { activeRun = owner.begin(); }
      catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      try {
      const exec: Exec = pi.exec.bind(pi);

      // Must be a git repo (§8)
      const gitRoot = await getGitRoot(exec);
      if (!gitRoot) {
        ctx.ui.notify("Conduct requires a git repository", "error");
        return;
      }

      // Serialize Conduct across Pi instances too, even when they use different run IDs.
      const gitDir = await exec("git", ["rev-parse", "--absolute-git-dir"]);
      if (gitDir.code !== 0 || !gitDir.stdout.trim()) {
        ctx.ui.notify("Could not resolve the repository lock directory", "error");
        return;
      }
      try { activeRun.addCleanup(acquireRepositoryLock(gitDir.stdout.trim())); }
      catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      activeRun.controller.signal.throwIfAborted();

      // --- Load Config (§4) ---
      const { config: currentConfig, warnings, configPaths } = loadConfig(ctx.cwd, undefined, ctx.isProjectTrusted());
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }
      if (configPaths.length === 0) {
        ctx.ui.notify("Using safe default config (no config file found)", "info");
      }

      if (requestedResume) {
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify("Trust this repository in Pi before resuming a saved Conduct configuration", "error");
          return;
        }
        const requestedRunId = requestedResume[1]!.trim();
        const forceWorkspace = forceResumeMatch !== null;
        const artifactRoot = path.join(ctx.cwd, currentConfig.artifacts.root);
        try {
          const loaded = await loadResumeRun(artifactRoot, requestedRunId, gitRoot, exec, {
            forceWorkspace,
          });
          pi.sendMessage({
            customType: CONDUCT_PROMPT_MESSAGE_TYPE,
            content: `${forceWorkspace ? "Force-resume" : "Resume"} Conduct run ${requestedRunId}\n\n${loaded.userPrompt}`,
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
            activeRun,
            loaded.resume,
          );
        } catch (error) {
          ctx.ui.notify(
            `Cannot ${forceWorkspace ? "force-resume" : "resume"} Conduct run: ${error instanceof Error ? error.message : String(error)}`,
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
        publishResult(pi, { success: false, reason: "No check commands configured", iterations: 0, modifiedFiles: [], summary, artifactPath: runDir.root });
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
            "To run anyway, set loop.requireCleanGit to false in .pi/conduct/config.json.",
          ].join("\n");
          publishResult(pi, { success: false, reason: "Working tree is not clean", iterations: 0, modifiedFiles: [], summary: msg, artifactPath: runDir.root });
          return;
        }
      }

      const runDir = createRun();

      // --- Gather Repository Context ---
      const repoContext = await gatherRepoContext(ctx.cwd, exec);
      await executeRun(userPrompt, config, ctx, exec, repoContext, runDir, activeRun);
      } finally {
        activeRun.finish();
      }
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
