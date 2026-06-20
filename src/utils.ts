// ============================================================================
// Utility Functions
// ============================================================================

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

  // Try to find a JSON code block
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find JSON object/array in the text
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      JSON.parse(braceMatch[0]);
      return braceMatch[0];
    } catch {
      // Not valid JSON, continue
    }
  }

  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
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
    .slice(0, maxWords)
    .join("-")
    .slice(0, 30);
}

/**
 * Generate a run ID from timestamp and slug.
 */
export function generateRunId(slug: string): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${timestamp}-${slug}`;
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

/**
 * Check if a command is dangerous/blocked.
 */
export function isBlockedCommand(command: string): boolean {
  const blockedPatterns = [
    /rm\s+-rf\s+\/(\s|$)/,
    /rm\s+-rf\s+~(\s|$)/,
    /chmod\s+-R\s+777/,
    /curl\s+.*\|\s*sh(\s|$)/,
    /wget\s+.*\|\s*sh(\s|$)/,
    /\bsudo\b/,
  ];
  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) return true;
  }
  return false;
}

/**
 * Check if a command involves network/package installs.
 */
export function isNetworkCommand(command: string): boolean {
  const networkPatterns = [
    /\bcurl\b(?!.*\|\s*sh)/,
    /\bwget\b(?!.*\|\s*sh)/,
    /\bnpm\s+install\b/,
    /\bpnpm\s+install\b/,
    /\bcargo\s+install\b/,
    /\bpip\s+install\b/,
    /\bgo\s+get\b/,
  ];
  for (const pattern of networkPatterns) {
    if (pattern.test(command)) return true;
  }
  return false;
}
