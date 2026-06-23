import type {
  AgentSession,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  type TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "conduct-progress";
const DETAIL_RENDER_INTERVAL_MS = 80;

type StepState = "active" | "complete" | "failed";

export interface StepModelDetails {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

interface ProgressStep {
  title: string;
  state: StepState;
  activity?: string;
  modelDetails?: StepModelDetails;
  startedAt: number;
  durationMs?: number;
}

interface DetailEntry {
  toolCallId?: string;
  prefix?: string;
  text: string;
}

/**
 * Owns the compact workflow widget and the optional live sub-agent output view.
 * A single keyed widget is replaced in place, so activity updates never add
 * rows to the conversation history.
 */
export class ConductProgress {
  private readonly steps: ProgressStep[] = [];
  private readonly detailEntries: DetailEntry[] = [];
  private detailTitle = "Conduct activity";
  private detailViewer?: LiveOutputViewer;
  private detailDialogOpen = false;
  private detailRenderTimer?: ReturnType<typeof setTimeout>;
  private activityTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly ctx: ExtensionCommandContext) {}

  startStep(
    title: string,
    activity: string,
    modelDetails?: StepModelDetails,
  ): void {
    const current = this.currentStep();
    if (current?.state === "active") {
      current.state = "complete";
      current.durationMs = Date.now() - current.startedAt;
    }

    this.steps.push({
      title,
      state: "active",
      activity,
      modelDetails,
      startedAt: Date.now(),
    });
    this.detailTitle = title;
    this.detailEntries.length = 0;
    this.render();
    this.startActivityTimer();
    this.scheduleDetailRender();
  }

  setActivity(activity: string): void {
    const current = this.currentStep();
    if (!current || current.state !== "active" || current.activity === activity) return;
    current.activity = activity;
    this.render();
  }

  completeStep(): void {
    const current = this.currentStep();
    if (!current || current.state !== "active") return;
    current.state = "complete";
    current.activity = undefined;
    current.durationMs = Date.now() - current.startedAt;
    this.stopActivityTimer();
    this.render();
  }

  failStep(activity: string): void {
    const current = this.currentStep();
    if (!current || current.state !== "active") return;
    current.state = "failed";
    current.activity = activity;
    current.durationMs = Date.now() - current.startedAt;
    this.stopActivityTimer();
    this.render();
  }

  /** Freeze progress and clear the footer until the caller archives the widget. */
  finish(): void {
    this.stopActivityTimer();
    this.ctx.ui.setStatus("conduct", undefined);
    this.flushDetailRender();
  }

  clear(): void {
    this.ctx.ui.setStatus("conduct", undefined);
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (this.detailRenderTimer) clearTimeout(this.detailRenderTimer);
    this.stopActivityTimer();
    this.detailViewer?.close();
  }

  /** Render the final progress history without ANSI styling for chat output. */
  getSummaryLines(): string[] {
    const lines: string[] = [];
    for (const step of this.steps) {
      const marker = step.state === "complete" ? "✓" : step.state === "failed" ? "✗" : "●";
      const modelDetails = step.modelDetails
        ? ` · (${step.modelDetails.provider}) ${step.modelDetails.model}${step.modelDetails.thinkingLevel ? ` / ${step.modelDetails.thinkingLevel}` : ""}`
        : "";
      const duration =
        step.durationMs ?? Math.max(0, Date.now() - step.startedAt);
      lines.push(`${marker} ${step.title}${modelDetails} · ${formatElapsed(duration)}`);
      if (step.state === "failed" && step.activity) lines.push(`  ${step.activity}`);
    }
    return lines;
  }

  isShowingDetails(): boolean {
    return this.detailDialogOpen;
  }

  /**
   * Subscribe to one isolated role session. The returned function removes the
   * subscription; callers should invoke it before disposing the session.
   */
  observeAgent(session: AgentSession): () => void {
    let streamingKind: "thinking" | "text" | undefined;

    return session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          this.setActivity("Starting sub-agent…");
          break;
        case "turn_start":
          this.setActivity("Thinking…");
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "thinking_delta") {
            if (streamingKind !== "thinking") {
              streamingKind = "thinking";
              this.setActivity("Reasoning about the next action…");
              this.appendDetail("\n[thinking]\n");
            }
            this.appendDetail(update.delta);
          } else if (update.type === "text_delta") {
            if (streamingKind !== "text") {
              streamingKind = "text";
              this.setActivity("Preparing the result…");
              this.appendDetail("\n[assistant]\n");
            }
            this.appendDetail(update.delta);
          }
          break;
        }
        case "tool_execution_start":
          streamingKind = undefined;
          this.setActivity(describeTool(event.toolName, event.args));
          const prefix = `\n\n[tool] ${event.toolName}\n${formatValue(event.args)}\n`;
          this.detailEntries.push({
            toolCallId: event.toolCallId,
            prefix,
            text: prefix,
          });
          this.scheduleDetailRender();
          break;
        case "tool_execution_update":
          this.updateToolDetail(event.toolCallId, extractResultText(event.partialResult));
          break;
        case "tool_execution_end":
          this.finishToolDetail(
            event.toolCallId,
            event.toolName,
            event.isError,
            extractResultText(event.result),
          );
          this.setActivity(
            event.isError
              ? `${capitalize(event.toolName)} failed; assessing the result…`
              : `${capitalize(event.toolName)} completed; continuing…`,
          );
          break;
        case "auto_retry_start":
          this.setActivity(`Retrying model request (${event.attempt}/${event.maxAttempts})…`);
          this.appendDetail(`\n[retry] ${event.errorMessage}\n`);
          break;
        case "compaction_start":
          this.setActivity("Compacting sub-agent context…");
          this.appendDetail("\n[compacting context]\n");
          break;
      }
    });
  }

  async showDetails(ctx: ExtensionContext): Promise<void> {
    if (this.detailDialogOpen) return;
    if (this.steps.length === 0) {
      ctx.ui.notify("No Conduct step is currently available", "info");
      return;
    }

    this.detailDialogOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const viewer = new LiveOutputViewer(
            tui,
            theme,
            () => this.detailTitle,
            () => this.detailEntries.map((entry) => entry.text).join(""),
            () => done(),
          );
          this.detailViewer = viewer;
          return viewer;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            maxHeight: "85%",
            anchor: "center",
          },
        },
      );
    } finally {
      this.detailViewer = undefined;
      this.detailDialogOpen = false;
    }
  }

  private currentStep(): ProgressStep | undefined {
    return this.steps[this.steps.length - 1];
  }

  private render(): void {
    const theme = this.ctx.ui.theme;
    const lines: string[] = [];

    for (const step of this.steps) {
      const modelDetails = step.modelDetails
        ? ` · (${step.modelDetails.provider}) ${step.modelDetails.model}${step.modelDetails.thinkingLevel ? ` / ${step.modelDetails.thinkingLevel}` : ""}`
        : "";
      if (step.state === "complete") {
        lines.push(
          theme.fg("success", "✓ ") +
            theme.bold(theme.fg("success", step.title)) +
            theme.fg("muted", modelDetails) +
            theme.fg("muted", ` · ${formatElapsed(step.durationMs ?? 0)}`),
        );
      } else if (step.state === "failed") {
        lines.push(
          theme.fg("error", "✗ ") +
            theme.bold(theme.fg("error", step.title)) +
            theme.fg("muted", modelDetails) +
            theme.fg("muted", ` · ${formatElapsed(step.durationMs ?? 0)}`),
        );
        if (step.activity) lines.push(theme.fg("muted", `  ${step.activity}`));
      } else {
        lines.push(
          theme.fg("accent", "● ") +
            theme.bold(theme.fg("accent", step.title)) +
            theme.fg("muted", modelDetails) +
            theme.fg("muted", ` · ${formatElapsed(Date.now() - step.startedAt)}`),
        );
        if (step.activity) lines.push(theme.fg("muted", `  ${step.activity}`));
      }
    }

    if (this.currentStep()?.state === "active") {
      lines.push(theme.fg("dim", "  Ctrl+Alt+D: live sub-agent output"));
    }

    this.ctx.ui.setWidget(WIDGET_KEY, lines);
    const current = this.currentStep();
    this.ctx.ui.setStatus(
      "conduct",
      current?.state === "active" ? `Conduct: ${current.title}` : undefined,
    );
  }

  private appendDetail(text: string): void {
    if (!text) return;
    const last = this.detailEntries[this.detailEntries.length - 1];
    if (last && last.toolCallId === undefined) last.text += text;
    else this.detailEntries.push({ text });
    this.scheduleDetailRender();
  }

  private updateToolDetail(toolCallId: string, output: string): void {
    const entry = this.detailEntries.find((item) => item.toolCallId === toolCallId);
    if (!entry) return;
    entry.text = (entry.prefix ?? "") + output;
    this.scheduleDetailRender();
  }

  private finishToolDetail(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    output: string,
  ): void {
    const entry = this.detailEntries.find((item) => item.toolCallId === toolCallId);
    const suffix = `\n[tool ${isError ? "failed" : "completed"}] ${toolName}\n`;
    if (entry) {
      entry.text = (entry.prefix ?? "") + output + suffix;
      entry.toolCallId = undefined;
      entry.prefix = undefined;
    } else {
      this.detailEntries.push({ text: output + suffix });
    }
    this.scheduleDetailRender();
  }

  private scheduleDetailRender(): void {
    if (!this.detailViewer || this.detailRenderTimer) return;
    this.detailRenderTimer = setTimeout(() => {
      this.detailRenderTimer = undefined;
      this.detailViewer?.contentChanged();
    }, DETAIL_RENDER_INTERVAL_MS);
  }

  private flushDetailRender(): void {
    if (this.detailRenderTimer) {
      clearTimeout(this.detailRenderTimer);
      this.detailRenderTimer = undefined;
    }
    this.detailViewer?.contentChanged();
  }

  private startActivityTimer(): void {
    this.stopActivityTimer();
    this.activityTimer = setInterval(() => this.render(), 1_000);
    this.activityTimer.unref();
  }

  private stopActivityTimer(): void {
    if (!this.activityTimer) return;
    clearInterval(this.activityTimer);
    this.activityTimer = undefined;
  }
}

class LiveOutputViewer implements Component, Focusable {
  focused = false;
  private linesFromBottom = 0;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getTitle: () => string,
    private readonly getOutput: () => string,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+alt+d")) {
      this.close();
      return;
    }
    if (matchesKey(data, "up")) this.linesFromBottom += 1;
    else if (matchesKey(data, "down")) this.linesFromBottom = Math.max(0, this.linesFromBottom - 1);
    else if (matchesKey(data, "pageUp")) this.linesFromBottom += 12;
    else if (matchesKey(data, "pageDown")) this.linesFromBottom = Math.max(0, this.linesFromBottom - 12);
    else if (matchesKey(data, "end")) this.linesFromBottom = 0;
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const raw = this.getOutput().trim() || "Waiting for sub-agent output…";
    const wrapped = raw
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth));
    const windowSize = 24;
    const maxOffset = Math.max(0, wrapped.length - windowSize);
    this.linesFromBottom = Math.min(this.linesFromBottom, maxOffset);
    const end = wrapped.length - this.linesFromBottom;
    const start = Math.max(0, end - windowSize);
    const visible = wrapped.slice(start, end);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => {
      const clipped = truncateToWidth(text, innerWidth);
      return `${border("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${border("│")}`;
    };

    return [
      border(`╭${"─".repeat(innerWidth + 2)}╮`),
      row(this.theme.bold(this.theme.fg("accent", this.getTitle()))),
      row(this.theme.fg("dim", "Live output • ↑↓/PgUp/PgDn scroll • End follow • Esc close")),
      border(`├${"─".repeat(innerWidth + 2)}┤`),
      ...visible.map(row),
      border(`╰${"─".repeat(innerWidth + 2)}╯`),
    ];
  }

  contentChanged(): void {
    if (this.linesFromBottom === 0) this.tui.requestRender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  invalidate(): void {}
}

function describeTool(toolName: string, args: unknown): string {
  const values = isRecord(args) ? args : {};
  const path = firstString(values, "path", "file_path", "filePath");
  const pattern = firstString(values, "pattern", "query");
  const command = firstString(values, "command", "cmd");
  const target = compact(path ?? pattern ?? command ?? "", 90);

  switch (toolName) {
    case "read":
      return target ? `Reading ${target}` : "Reading a file…";
    case "grep":
      return target ? `Searching for ${target}` : "Searching the codebase…";
    case "find":
      return target ? `Finding ${target}` : "Finding files…";
    case "ls":
      return target ? `Listing ${target}` : "Listing files…";
    case "edit":
      return target ? `Editing ${target}` : "Editing a file…";
    case "write":
      return target ? `Writing ${target}` : "Writing a file…";
    case "bash":
      return target ? `Running ${target}` : "Running a command…";
    default:
      return `Using ${toolName}…`;
  }
}

function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return result === undefined ? "" : formatValue(result);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function compact(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1)}…`;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function notify(
  ctx: ExtensionCommandContext,
  message: string,
  severity: "info" | "warning" | "error" = "info",
): void {
  ctx.ui.notify(message, severity);
}
