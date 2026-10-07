import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { WorkflowResult } from "./supervisor.js";
import { formatUsage, type RunUsage } from "./usage.js";

export const RESULT_ENTRY_TYPE = "conduct-result";
export interface ConductResultCard extends WorkflowResult {
  runId: string;
  timestamp: string;
  progress: string[];
  usage?: RunUsage;
}

export function resultCardLines(result: ConductResultCard): string[] {
  return [
    result.success ? "✓ Conduct completed successfully." : "✗ Conduct stopped before approval.",
    `Reason: ${result.reason}`,
    `Iterations: ${result.iterations}`,
    `Modified files: ${result.modifiedFiles.join(", ") || "none"}`,
    ...(result.lastChecks?.length ? [`Checks: ${result.lastChecks.map((group) => `${group.groupName}: ${group.results.every((check) => check.exitCode === 0) ? "✓" : "✗"}`).join(", ")}`] : []),
    ...(result.lastReview ? [`Last reviewer: ${result.lastReview.status} — ${result.lastReview.summary}`] : []),
    ...(result.usage ? [formatUsage(result.usage.totals)] : []),
    `Artifacts: ${result.artifactPath}`,
    ...(result.resumable ? [`Resume with: /conduct resume ${result.runId}`] : []),
    ...result.progress,
  ];
}

export function renderResultCard(result: ConductResultCard, expanded: boolean, theme: Theme): Container {
  const container = new Container();
  const [title, ...lines] = resultCardLines(result);
  container.addChild(new Text(theme.fg(result.success ? "success" : "warning", theme.bold(title ?? "Conduct result")), 1, 0));
  container.addChild(new Text(lines.join("\n"), 1, 0));
  if (expanded) {
    container.addChild(new Markdown(result.summary, 1, 0, getMarkdownTheme()));
    if (result.usage?.sessions.length) {
      container.addChild(new Text(result.usage.sessions.map((session) =>
        `${session.label} (attempt ${session.attempt}): ${session.models.join(", ")} · $${session.cost.toFixed(4)}\n  ${session.sessionFile ?? session.sessionId}`,
      ).join("\n"), 1, 0));
    }
  }
  return container;
}

export function registerResultRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<ConductResultCard>(RESULT_ENTRY_TYPE, (entry, options, theme) =>
    entry.data ? renderResultCard(entry.data, options.expanded, theme) : undefined,
  );
}

export function publishResult(pi: ExtensionAPI, result: WorkflowResult, progress: string[] = [], usage?: RunUsage): ConductResultCard {
  const card: ConductResultCard = {
    ...result, progress, usage, runId: path.basename(result.artifactPath), timestamp: new Date().toISOString(),
  };
  pi.appendEntry(RESULT_ENTRY_TYPE, card);
  // Only the compact outcome enters model context; the durable card retains full details.
  pi.sendMessage({
    customType: "conduct-result-context", display: false,
    content: resultCardLines({ ...card, progress: [] }).join("\n"),
  }, { triggerTurn: false });
  return card;
}
