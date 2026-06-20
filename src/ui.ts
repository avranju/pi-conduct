import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Progress UI
// ============================================================================

/**
 * Send a progress status update to the user.
 * Uses both setStatus (footer) and notify for visibility.
 */
export async function status(
  ctx: ExtensionCommandContext,
  message: string,
): Promise<void> {
  ctx.ui.setStatus("conduct", message);
  // Only notify for notable transitions to avoid spam
  if (
    message.startsWith("Conduct: planning") ||
    message.startsWith("Conduct: plan created") ||
    message.startsWith("Conduct: implementing") ||
    message.startsWith("Conduct: running checks") ||
    message.startsWith("Conduct: reviewer") ||
    message.startsWith("Conduct: fixing") ||
    message.startsWith("Conduct: checks passed") ||
    message.startsWith("Conduct: reviewer approved") ||
    message.startsWith("Conduct: completed") ||
    message.startsWith("Conduct: stopped")
  ) {
    ctx.ui.notify(message, "info");
  }
}

/**
 * Clear the conduct status.
 */
export async function clearStatus(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus("conduct", undefined);
}

/**
 * Show a progress bar-like status for iterations.
 */
export async function iterationStatus(
  ctx: ExtensionCommandContext,
  iteration: number,
  maxIterations: number,
  stage: string,
): Promise<void> {
  const progress = `[${iteration}/${maxIterations}]`;
  ctx.ui.setStatus("conduct", `Conduct: ${progress} ${stage}`);
}

/**
 * Show a notification with severity.
 */
export function notify(
  ctx: ExtensionCommandContext,
  message: string,
  severity: "info" | "warning" | "error" = "info",
): void {
  ctx.ui.notify(message, severity);
}
