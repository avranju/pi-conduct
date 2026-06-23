import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import {
  DEFAULT_LIVE_OUTPUT_KEYBINDING,
  type ConductConfig,
} from "./schemas.js";

export function normalizeKeybindingList(value: unknown): KeyId[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const result: KeyId[] = [];

  for (const item of values) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(key as KeyId);
  }

  return result;
}

export function getLiveOutputKeybindings(config?: Partial<ConductConfig>): KeyId[] {
  const configured = normalizeKeybindingList(
    (config as { keybindings?: { liveOutput?: unknown } } | undefined)?.keybindings?.liveOutput,
  );
  return configured.length > 0 ? configured : [DEFAULT_LIVE_OUTPUT_KEYBINDING as KeyId];
}

export function matchesAnyKey(data: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

export function formatKeybindings(keys: readonly KeyId[]): string {
  const displayKeys = keys.length > 0 ? keys : [DEFAULT_LIVE_OUTPUT_KEYBINDING as KeyId];
  return displayKeys.map(formatKeybinding).join("/");
}

function formatKeybinding(key: string): string {
  return key
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "ctrl") return "Ctrl";
      if (lower === "alt") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "super") return "Super";
      if (/^f\d+$/.test(lower)) return lower.toUpperCase();
      if (lower === "escape" || lower === "esc") return "Esc";
      if (lower === "pageup") return "PgUp";
      if (lower === "pagedown") return "PgDn";
      if (lower.length === 1) return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}
