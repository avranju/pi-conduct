import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Container,
  ScrollView,
  VStack,
  Text,
  isKeyRelease,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type KeyId,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatKeybindings, matchesAnyKey } from "./keybindings.js";
import { formatUsage, totalUsage, type RunUsageLedger, type UsageTotals } from "./usage.js";

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


/**
 * Owns the compact workflow widget and the optional live sub-agent output view.
 * A single keyed widget is replaced in place, so activity updates never add
 * rows to the conversation history.
 */
export class ConductProgress {
  private readonly steps: ProgressStep[] = [];
  private readonly detailTranscript = new PiOutputTranscript();
  private detailTitle = "Conduct activity";
  private detailViewer?: LiveOutputViewer;
  private detailDialogOpen = false;
  private detailRenderTimer?: ReturnType<typeof setTimeout>;
  private activityTimer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private usageLedger?: RunUsageLedger;
  private readonly activeSessions = new Set<AgentSession>();

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly liveOutputKeybindings: KeyId[],
  ) {}

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
    this.detailTranscript.reset();
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
    if (this.disposed) return;
    this.disposed = true;
    this.ctx.ui.setStatus("conduct", undefined);
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (this.detailRenderTimer) clearTimeout(this.detailRenderTimer);
    this.stopActivityTimer();
    this.detailTranscript.detach();
    this.detailViewer?.close();
  }

  setUsageLedger(ledger: RunUsageLedger): void { this.usageLedger = ledger; }

  private getRunUsage(): UsageTotals {
    return totalUsage([
      ...(this.usageLedger?.snapshot().sessions ?? []),
      ...[...this.activeSessions].map((session) => {
        const stats = session.getSessionStats();
        return { ...stats.tokens, cost: stats.cost };
      }),
    ]);
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
    this.detailTranscript.observe(session);
    this.activeSessions.add(session);
    const unsubscribe = session.subscribe((event) => {
      this.detailTranscript.handle(session, event);

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
            this.setActivity("Reasoning about the next action…");
          } else if (update.type === "text_delta") {
            this.setActivity("Preparing the result…");
          }
          break;
        }
        case "message_end":
          if (isAssistantMessage(event.message)) {
            const current = this.currentStep();
            if (current) {
              current.modelDetails = {
                provider: event.message.provider, model: event.message.model,
                thinkingLevel: event.message.thinkingLevel ?? session.thinkingLevel,
              };
              this.render();
            }
          }
          break;
        case "tool_execution_start":
          this.setActivity(describeTool(event.toolName, event.args));
          break;
        case "tool_execution_end":
          this.setActivity(
            event.isError
              ? `${capitalize(event.toolName)} failed; assessing the result…`
              : `${capitalize(event.toolName)} completed; continuing…`,
          );
          break;
        case "auto_retry_start":
          this.setActivity(`Retrying model request (${event.attempt}/${event.maxAttempts})…`);
          break;
        case "auto_retry_end":
          if (!event.success) {
            this.setActivity("Model retries exhausted; retrying the agent turn…");
          }
          break;
        case "compaction_start":
          this.setActivity("Compacting sub-agent context…");
          break;
      }
      this.scheduleDetailRender();
    });
    return () => { unsubscribe(); this.activeSessions.delete(session); };
  }

  onTransientRetry(info: {
    role: string;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }): void {
    const roleLabel = capitalize(info.role);
    this.setActivity(
      `${roleLabel} hit a transient error (${info.nextAttempt}/${info.maxAttempts}); retrying in ${formatElapsed(info.delayMs)}…`,
    );
    this.detailTranscript.addNotice(
      `Retrying ${info.role} (${info.nextAttempt}/${info.maxAttempts}) after ${formatElapsed(info.delayMs)}: ${info.reason}`,
    );
    this.scheduleDetailRender();
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
        (tui, theme, keybindings, done) => {
          this.detailTranscript.attach(tui);
          const viewer = new LiveOutputViewer(
            tui,
            theme,
            () => this.detailTitle,
            () => this.currentStep()?.modelDetails,
            () => [...this.detailTranscript.getStatsLines(), `Run total · ${formatUsage(this.getRunUsage())}`],
            (width) => this.detailTranscript.render(width),
            () => done(),
            this.liveOutputKeybindings,
            keybindings,
            () => ctx.ui.theme,
            () => this.detailTranscript.invalidate(),
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
      this.detailTranscript.detach();
      this.detailViewer = undefined;
      this.detailDialogOpen = false;
    }
  }

  private currentStep(): ProgressStep | undefined {
    return this.steps[this.steps.length - 1];
  }

  private renderProgressLines(): string[] {
    const theme = this.ctx.ui.theme;
    const lines: string[] = [];
    const visibleSteps = this.steps.slice(-6);
    if (this.steps.length > visibleSteps.length) lines.push(theme.fg("dim", `  ${this.steps.length - visibleSteps.length} earlier steps (retained in the final result)`));

    for (const step of visibleSteps) {
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
      lines.push(
        theme.fg("dim", `  ${formatKeybindings(this.liveOutputKeybindings)}: live sub-agent output`),
      );
    }

    return lines;
  }

  private render(): void {
    if (this.disposed) return;
    // Compute theme colors at render time, including after automatic system-theme changes.
    this.ctx.ui.setWidget(WIDGET_KEY, () => ({
      render: (width) => this.renderProgressLines().map((line) => truncateToWidth(line, width)),
      invalidate: () => {},
    }));
    const current = this.currentStep();
    this.ctx.ui.setStatus(
      "conduct",
      current?.state === "active" ? `Conduct: ${current.title}` : undefined,
    );
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

class PiOutputTranscript {
  private readonly sessions: AgentSession[] = [];
  private container?: Container;
  private tui?: TUI;
  private readonly streamingAssistants = new Map<AgentSession, AssistantMessageComponent>();
  private readonly tools = new Map<AgentSession, Map<string, ToolExecutionComponent>>();
  private readonly notices: string[] = [];

  reset(): void {
    this.sessions.length = 0;
    this.notices.length = 0;
    this.clearRenderedState();
    if (this.tui) this.rebuild();
  }

  observe(session: AgentSession): void {
    if (!this.sessions.includes(session)) this.sessions.push(session);
  }

  attach(tui: TUI): void {
    this.tui = tui;
    this.rebuild();
  }

  detach(): void {
    this.tui = undefined;
    this.clearRenderedState();
  }

  addNotice(message: string): void {
    this.notices.push(message);
    if (this.container) this.container.addChild(new Text(message, 1, 0));
  }

  handle(session: AgentSession, event: AgentSessionEvent): void {
    this.observe(session);
    if (!this.container) return;

    switch (event.type) {
      case "message_start":
        if (isAssistantMessage(event.message)) {
          const component = this.ensureAssistant(session, event.message);
          component.updateContent(event.message);
          this.addMessageTools(session, event.message, false);
        } else {
          this.addMessage(session, event.message);
        }
        break;
      case "message_update":
        if (isAssistantMessage(event.message)) {
          const component = this.ensureAssistant(session, event.message);
          component.updateContent(event.message);
          this.addMessageTools(session, event.message, false);
        }
        break;
      case "message_end":
        if (isAssistantMessage(event.message)) {
          const component = this.ensureAssistant(session, event.message);
          component.updateContent(event.message);
          for (const tool of getToolCalls(event.message)) {
            this.getTools(session).get(tool.id)?.setArgsComplete();
          }
          this.streamingAssistants.delete(session);
        }
        break;
      case "tool_execution_start":
        this.ensureTool(session, event.toolCallId, event.toolName, event.args).markExecutionStarted();
        break;
      case "tool_execution_update":
        this.getTools(session)
          .get(event.toolCallId)
          ?.updateResult(toToolResult(event.partialResult, false), true);
        break;
      case "tool_execution_end":
        this.getTools(session)
          .get(event.toolCallId)
          ?.updateResult(toToolResult(event.result, event.isError));
        break;
      case "auto_retry_start":
        this.addNotice(`Retrying model request (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
        break;
      case "compaction_start":
        this.addNotice("Compacting sub-agent context…");
        break;
    }
  }

  render(width: number): string[] {
    return this.container?.render(width) ?? ["Waiting for sub-agent output…"];
  }

  invalidate(): void { this.container?.invalidate(); }

  getStatsLines(): string[] {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let hasUsage = false;

    for (const session of this.sessions) {
      const stats = session.getSessionStats();
      input += stats.tokens.input;
      output += stats.tokens.output;
      cacheRead += stats.tokens.cacheRead;
      cacheWrite += stats.tokens.cacheWrite;
      cost += stats.cost;
      hasUsage ||= stats.tokens.total > 0;
    }

    const context = [...this.sessions]
      .reverse()
      .map((session) => session.getContextUsage())
      .find((usage) => usage !== undefined);
    const tokenParts: string[] = [];
    if (input) tokenParts.push(`↑${formatTokens(input)}`);
    if (output) tokenParts.push(`↓${formatTokens(output)}`);
    if (cacheRead) tokenParts.push(`R${formatTokens(cacheRead)}`);
    if (cacheWrite) tokenParts.push(`W${formatTokens(cacheWrite)}`);
    if (cost) tokenParts.push(`$${cost.toFixed(3)}`);

    const lines = tokenParts.length > 0 ? [`Tokens ${tokenParts.join(" · ")}`] : [];
    if (context) {
      const used = context.tokens === null ? "?" : formatTokens(context.tokens);
      const percent = context.percent === null ? "?" : `${context.percent.toFixed(1)}%`;
      lines.push(`Context ${used}/${formatTokens(context.contextWindow)} (${percent})`);
    } else if (hasUsage) {
      lines.push("Context unavailable");
    }
    return lines;
  }

  private rebuild(): void {
    this.clearRenderedState();
    if (!this.tui) return;
    this.container = new Container();
    for (const session of this.sessions) {
      for (const message of session.messages) this.addMessage(session, message);
    }
    for (const notice of this.notices) this.container.addChild(new Text(notice, 1, 0));
  }

  private clearRenderedState(): void {
    this.container = undefined;
    this.streamingAssistants.clear();
    this.tools.clear();
  }

  private addMessage(session: AgentSession, message: unknown): void {
    if (!this.container) return;
    if (isUserMessage(message)) {
      const text = getUserText(message);
      if (text) this.container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
      return;
    }
    if (isToolResultMessage(message)) {
      this.getTools(session)
        .get(message.toolCallId)
        ?.updateResult(toToolResult(message, message.isError === true));
      return;
    }
    if (!isAssistantMessage(message)) return;

    const component = new AssistantMessageComponent(message, false, getMarkdownTheme());
    this.container.addChild(component);
    this.addMessageTools(session, message, true);
  }

  private ensureAssistant(session: AgentSession, message: AssistantMessage): AssistantMessageComponent {
    const existing = this.streamingAssistants.get(session);
    if (existing) return existing;
    const component = new AssistantMessageComponent(message, false, getMarkdownTheme());
    this.container?.addChild(component);
    this.streamingAssistants.set(session, component);
    return component;
  }

  private addMessageTools(
    session: AgentSession,
    message: AssistantMessage,
    argsComplete: boolean,
  ): void {
    for (const tool of getToolCalls(message)) {
      const component = this.ensureTool(session, tool.id, tool.name, tool.arguments);
      if (argsComplete && message.stopReason !== "error" && message.stopReason !== "aborted") {
        component.setArgsComplete();
      }
    }
  }

  private ensureTool(
    session: AgentSession,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): ToolExecutionComponent {
    const tools = this.getTools(session);
    const existing = tools.get(toolCallId);
    if (existing) {
      existing.updateArgs(args);
      return existing;
    }

    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args,
      undefined,
      session.getToolDefinition(toolName),
      this.tui!,
      session.sessionManager.getCwd(),
    );
    this.container?.addChild(component);
    tools.set(toolCallId, component);
    return component;
  }

  private getTools(session: AgentSession): Map<string, ToolExecutionComponent> {
    let tools = this.tools.get(session);
    if (!tools) {
      tools = new Map();
      this.tools.set(session, tools);
    }
    return tools;
  }
}

export class LiveOutputViewer extends VStack implements Focusable {
  focused = false;
  private closed = false;
  readonly scrollView: ScrollView;
  private readonly header: Component;
  private readonly footer: Component;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    getTitle: () => string,
    getModelDetails: () => StepModelDetails | undefined,
    getStatsLines: () => string[],
    renderContent: (width: number) => string[],
    private readonly done: () => void,
    private readonly closeKeybindings: KeyId[],
    private readonly keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
    private readonly getTheme: () => Theme = () => theme,
    invalidateContent: () => void = () => {},
  ) {
    super();
    const header: Component = {
      render: (width) => {
        const currentTheme = getTheme();
        return [
          currentTheme.bold(currentTheme.fg("accent", getTitle())) +
            currentTheme.fg("dim", formatLiveOutputModelDetails(getModelDetails())),
          ...getStatsLines().map((line) => currentTheme.fg("dim", line)),
          currentTheme.fg("border", "─".repeat(Math.max(0, width))),
        ].map((line) => truncateToWidth(line, width));
      },
      invalidate: () => {},
    };
    const content: Component = {
      render: (width) => renderContent(width).map((line) => truncateToWidth(line, width)),
      invalidate: invalidateContent,
    };
    this.scrollView = new ScrollView(content, {
      follow: "end", primary: true, overscroll: "contain", scrollbar: "always",
      scrollbarTrackStyle: (text) => getTheme().fg("muted", text),
      scrollbarThumbStyle: (text) => getTheme().fg("accent", text),
    });
    this.header = header;
    this.addChild(header, { shrink: 1, minSize: 1, maxSize: 7 });
    this.addChild(this.scrollView, { basis: 0, grow: 1, minSize: 1 });
    this.footer = {
      render: (width) => [truncateToWidth(getTheme().fg("dim",
        `Live output · ↑↓/PgUp/PgDn scroll · End follow · ${formatKeybindings(keybindings.getKeys("tui.select.cancel"))}/${formatKeybindings(closeKeybindings)} close`,
      ), width)],
      invalidate: () => {},
    };
    this.addChild(this.footer, { basis: 1, minSize: 1 });
  }

  // Pi 1.0.4 lays out native stacks in the fullscreen tree, but overlays still call
  // render(width). Use the same public ScrollView state for that compatibility path.
  override render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85));
    const header = this.header.render(width).slice(0, Math.max(0, height - 2));
    const footer = height > 1 ? this.footer.render(width) : [];
    const viewport = Math.max(1, height - header.length - footer.length);
    const content = this.scrollView.render(width);
    this.scrollView.updateLayout(content.length, viewport, () => this.tui.requestRender());
    const start = this.scrollView.scrollTop;
    const visible = content.slice(start, start + viewport);
    while (visible.length < viewport) visible.push("");
    // The native fullscreen renderer draws its own scrollbar; overlays need a compact one.
    const thumb = Math.max(1, Math.floor(viewport * Math.min(1, viewport / Math.max(1, content.length))));
    const top = Math.round((viewport - thumb) * start / Math.max(1, content.length - viewport));
    return [
      ...header,
      ...visible.map((line, row) => {
        if (width <= 1) return truncateToWidth(line, width);
        const clipped = truncateToWidth(line, width - 1);
        const scrollbar = row >= top && row < top + thumb
          ? this.getTheme().fg("accent", "┃") : this.getTheme().fg("muted", "│");
        return `${clipped}${" ".repeat(Math.max(0, width - 1 - visibleWidth(clipped)))}${scrollbar}`;
      }),
      ...footer,
    ].slice(0, height);
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollView.scrollBy(event.wheelDelta);
      return {
        handled: true, render: true,
        target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
      };
    }
    return undefined;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesAnyKey(data, this.closeKeybindings)) {
      this.close();
      return;
    }
    const page = Math.max(1, this.scrollView.viewportHeight - 1);
    if (this.keybindings.matches(data, "tui.select.up")) this.scrollView.scrollBy(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.scrollView.scrollBy(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) this.scrollView.scrollBy(-page);
    else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) this.scrollView.scrollBy(page);
    else if (matchesKey(data, "end") || this.keybindings.matches(data, "tui.altScreen.bottom")) this.scrollView.scrollToEnd();
    else if (matchesKey(data, "home") || this.keybindings.matches(data, "tui.altScreen.top")) this.scrollView.scrollToStart();
    else return;
    this.tui.requestRender();
  }

  contentChanged(): void { if (!this.closed) this.tui.requestRender(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }
}

function formatLiveOutputModelDetails(modelDetails: StepModelDetails | undefined): string {
  if (!modelDetails) return "";
  const thinking = modelDetails.thinkingLevel ? ` • ${modelDetails.thinkingLevel}` : "";
  return ` · (${modelDetails.provider}) ${modelDetails.model}${thinking}`;
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

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant" && Array.isArray(message.content);
}

function isUserMessage(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message.role === "user";
}

function isToolResultMessage(message: unknown): message is Record<string, unknown> & {
  toolCallId: string;
  isError?: boolean;
} {
  return isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string";
}

function getUserText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function getToolCalls(message: AssistantMessage): Array<{
  id: string;
  name: string;
  arguments: unknown;
}> {
  return message.content.flatMap((part) =>
    isRecord(part) &&
    part.type === "toolCall" &&
    typeof part.id === "string" &&
    typeof part.name === "string"
      ? [{ id: part.id, name: part.name, arguments: part.arguments }]
      : [],
  );
}

function toToolResult(
  result: unknown,
  isError: boolean,
): {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError: boolean;
} {
  if (isRecord(result) && Array.isArray(result.content)) {
    return {
      content: result.content.flatMap((part) =>
        isRecord(part) && typeof part.type === "string"
          ? [{
              type: part.type,
              ...(typeof part.text === "string" ? { text: part.text } : {}),
              ...(typeof part.data === "string" ? { data: part.data } : {}),
              ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
            }]
          : [],
      ),
      ...(result.details === undefined ? {} : { details: result.details }),
      isError,
    };
  }
  return {
    content: [{ type: "text", text: result === undefined ? "" : String(result) }],
    isError,
  };
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
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
