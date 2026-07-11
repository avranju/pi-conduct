// ============================================================================
// Utility Functions
// ============================================================================

import type { ReviewResult, RetryConfig } from "./schemas.js";

/**
 * Truncate text to max bytes, appending a truncation notice.
 */
export function truncate(text: string, maxBytes: number): string {
  if (!text) return "";
  if (text.length <= maxBytes) return text;
  const truncated = text.slice(0, maxBytes);
  const omitted = text.length - maxBytes;
  return `${truncated}\n\n[Output truncated: ${omitted} characters omitted]`;
}

/**
 * Truncate text to max lines, appending a notice.
 */
export function truncateLines(text: string, maxLines: number, maxBytes?: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  const omitted = lines.length - maxLines;
  let result = kept.join("\n");
  if (maxBytes && Buffer.byteLength(result, "utf8") > maxBytes) {
    result = truncate(result, maxBytes);
  }
  return `${result}\n\n[Output truncated: ${omitted} lines omitted]`;
}

/**
 * Extract JSON from a markdown code block or raw text.
 * Tries to find a JSON block in ```json ... ``` or ``` ... ``` markers.
 */
export function extractJson(text: string): string | null {
  if (!text) return null;

  // Try to find a JSON code block (json or bare fence)
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch && jsonBlockMatch[1] !== undefined) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find a JSON object in the text (greedy outermost braces)
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch && braceMatch[0] !== undefined) {
    try {
      JSON.parse(braceMatch[0]);
      return braceMatch[0];
    } catch {
      // Not valid JSON, continue
    }
  }

  // Try to find a JSON array in the text
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch && bracketMatch[0] !== undefined) {
    try {
      JSON.parse(bracketMatch[0]);
      return bracketMatch[0];
    } catch {
      // Not valid JSON, continue
    }
  }

  // Return the whole text as-is (might be pure JSON)
  try {
    JSON.parse(text.trim());
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Parse and validate JSON text, returning the parsed value or null.
 */
export function parseJson<T>(text: string): T | null {
  const extracted = extractJson(text);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted) as T;
  } catch {
    return null;
  }
}

/**
 * Generate a slug from a string for use in run directory names.
 */
export function slugify(text: string, maxWords: number = 3): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 30);
}

/**
 * Generate a run ID from timestamp and slug (§7: <timestamp>-<slug>).
 */
export function generateRunId(slug: string): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${date}-${time}-${slug || "run"}`;
}

/**
 * Format a duration in ms to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
}

// ============================================================================
// Safety: command classification (§15.1, §15.3)
// ============================================================================

/** Built-in dangerous command patterns that are always blocked. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s+\/(\s|$)/, // rm -rf /
  /rm\s+-rf?\s+\/\*/, // rm -rf /*
  /rm\s+-rf?\s+~/,
  /rm\s+-rf?\s+\$HOME/,
  /chmod\s+-R\s+0?777/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\|\s*(sh|bash)\b/,
  /curl\s+[^\n|]*\|\s*(sh|bash)\b/,
  /wget\s+[^\n|]*\|\s*(sh|bash)\b/,
  /\bsudo\b/,
];

/** Network / package-install command patterns (blocked when allowNetwork=false). */
const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bnpm\s+(install|i|ci|add)\b/,
  /\bpnpm\s+(install|add|i)\b/,
  /\byarn\s+(add|install)\b/,
  /\bcargo\s+install\b/,
  /\bpip\s+install\b/,
  /\bpip3\s+install\b/,
  /\buv\s+(pip\s+)?install\b/,
  /\bgo\s+install\b/,
  /\bgo\s+get\b/,
  /\bbrew\s+install\b/,
  /\bapt(-get)?\s+install\b/,
  /\bdnf\s+install\b/,
  /\bpacman\s+-S\b/,
  /\bgem\s+install\b/,
  /\bcomposer\s+require\b/,
  /\bgit\s+clone\b/,
];

/**
 * Check if a command is dangerous/blocked (§15.1). Always-on guardrail.
 */
export function isBlockedCommand(command: string, extraPatterns: string[] = []): boolean {
  const patterns = [...DANGEROUS_PATTERNS];
  for (const p of extraPatterns) {
    try {
      patterns.push(new RegExp(p));
    } catch {
      // Ignore invalid regex from config
    }
  }
  for (const pattern of patterns) {
    if (pattern.test(command)) return true;
  }
  return false;
}

/**
 * Check if a command involves network/package installs (§15.3).
 */
export function isNetworkCommand(command: string): boolean {
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

// ============================================================================
// Review finding helpers (§6.1, minor cutoff)
// ============================================================================

export interface FindingCounts {
  blocking: number;
  important: number;
  minor: number;
}

export function countFindings(review: ReviewResult): FindingCounts {
  let blocking = 0;
  let important = 0;
  let minor = 0;
  for (const f of review.findings) {
    if (f.severity === "blocking") blocking++;
    else if (f.severity === "important") important++;
    else minor++;
  }
  return { blocking, important, minor };
}

/** True when the review has blocking or important findings (i.e. not only minor). */
export function hasNonMinorFindings(review: ReviewResult): boolean {
  return review.findings.some((f) => f.severity === "blocking" || f.severity === "important");
}

// ============================================================================
// Transient model/transport error classification (§16.5)
// ============================================================================
//
// Used by the agent retry wrapper to decide whether a failed agent turn should
// be retried. Mirrors the transient-error heuristics used by the Pi SDK's own
// in-turn retry (overloaded / rate limit / 5xx / network / fetch / socket /
// stream / websocket failures) and adds common Node fetch error codes. Quota,
// billing, and authentication failures are NOT retryable — retrying will not
// help and only delays surfacing the real problem.

const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /provider.?returned.?error/i,
  /network.?error/i,
  /connection.?(error|refused|lost|reset|closed|aborted)/i,
  /other side closed/i,
  /fetch failed/i,
  /upstream.?connect/i,
  /reset before headers/i,
  /socket hang up/i,
  /timed.?out/i,
  /\btimeout\b/i,
  /terminated/i,
  /websocket.?(closed|error)/i,
  /ended without/i,
  /stream ended/i,
  /http2 request did not get a response/i,
  /econnrefused/i,
  /econnreset/i,
  /epipe/i,
  /eai_again/i,
  /retry delay/i,
  /you can retry your request/i,
  /try your request again/i,
  /please retry your request/i,
];

const NON_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  /insufficient_quota/i,
  /out of budget/i,
  /quota exceeded/i,
  /billing/i,
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /monthly usage limit reached/i,
  /available balance/i,
  /\b401\b/,
  /\b403\b/,
  /unauthor/i,
  /forbidden/i,
  /invalid api key/i,
  /authentication/i,
  /context (length|window|overflow|limit)/i,
];

/**
 * Returns true when an error message looks like a transient model/transport
 * failure that might succeed on retry (e.g. a crashed inference server coming
 * back up). Non-retryable failures (auth, quota, context overflow) return false.
 */
export function isTransientModelError(
  errorMessage: string | undefined,
  extraPatterns: string[] = [],
): boolean {
  if (!errorMessage) return false;
  for (const pattern of NON_RETRYABLE_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) return false;
  }
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) return true;
  }
  for (const raw of extraPatterns) {
    try {
      if (new RegExp(raw, "i").test(errorMessage)) return true;
    } catch {
      // Invalid user regex is dropped by config validation; ignore here.
    }
  }
  return false;
}

/**
 * Compute the exponential-backoff delay for a retry attempt (1-indexed),
 * capped by `maxDelayMs`.
 */
export function retryDelayFor(
  attempt: number,
  retry: Pick<RetryConfig, "baseDelayMs" | "maxDelayMs">,
): number {
  const raw = retry.baseDelayMs * 2 ** (attempt - 1);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, retry.maxDelayMs);
}

/**
 * Abortable sleep. Resolves (rather than rejecting) when the signal aborts so
 * callers can fall through to their own abort handling.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
