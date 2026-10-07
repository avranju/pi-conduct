import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, Text, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
import { LiveOutputViewer } from "../src/ui.js";

function terminal(): Terminal & { columns: number; rows: number } {
  return {
    columns: 60, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {},
    showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
}
function fixture(overlay = false) {
  const term = terminal(); const tui = new TuiAltScreen(term);
  const content = Array.from({ length: 100 }, (_value, index) => `content ${index}`);
  let closed = 0; let invalidated = 0; let selectedTheme = theme;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": "ctrl+k", "tui.select.cancel": "ctrl+q" });
  const viewer = new LiveOutputViewer(
    tui, theme, () => "Conduct output", () => ({ provider: "unit", model: "test", thinkingLevel: "max" }),
    () => ["Token stats"], () => content, () => { closed++; }, ["f12"], keys,
    () => selectedTheme, () => { invalidated++; },
  );
  tui.setLayoutRoot(overlay ? new Text("Underlying parent session") : viewer);
  if (overlay) tui.showOverlay(viewer, { width: "90%", maxHeight: "85%", anchor: "center" });
  tui.start();
  return { term, tui, viewer, content, get closed() { return closed; }, get invalidated() { return invalidated; }, setTheme(next: Theme) { selectedTheme = next; } };
}

describe("native live output viewport", () => {
  it("allocates available fullscreen height, follows the end, and obeys remapped navigation", () => {
    const f = fixture();
    try {
      f.tui.renderNow(true);
      assert.ok(f.viewer.scrollView.viewportHeight > 10);
      assert.equal(f.tui.getScreenLines().length, f.term.rows);
      assert.equal(f.viewer.scrollView.isFollowingEnd, true);
      assert.match(f.tui.getScreenLines().join("\n"), /content 99/);
      f.viewer.handleInput("\x1b[A"); // Default Up was overridden.
      assert.equal(f.viewer.scrollView.isFollowingEnd, true);
      f.viewer.handleInput("\x0b"); // Ctrl+K
      assert.equal(f.viewer.scrollView.isFollowingEnd, false);
      f.viewer.handleInput("\x1b[F");
      assert.equal(f.viewer.scrollView.isFollowingEnd, true);
      f.content.push("content 100"); f.viewer.contentChanged(); f.tui.renderNow();
      assert.match(f.tui.getScreenLines().join("\n"), /content 100/);
      f.viewer.handleInput("\x11"); f.viewer.close();
      assert.equal(f.closed, 1);
    } finally { f.tui.stop({ preserveScreen: true }); }
  });

  it("uses the native viewport inside a constrained live-output overlay", () => {
    const f = fixture(true);
    try {
      f.tui.renderNow(true);
      assert.ok(f.viewer.scrollView.viewportHeight > 10);
      assert.ok(f.viewer.scrollView.viewportHeight < f.term.rows);
      assert.match(f.tui.getScreenLines().join("\n"), /content 99/);
      f.viewer.handleInput("\x1b[H"); f.tui.renderNow();
      assert.match(f.tui.getScreenLines().join("\n"), /content 0/);
    } finally { f.tui.stop({ preserveScreen: true }); }
  });

  it("does not overflow narrow terminals and updates render-time themes", () => {
    const f = fixture();
    try {
      for (const width of [1, 2, 4, 8, 20, 80]) {
        f.term.columns = width; f.tui.renderNow(true);
        assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width), `width=${width}`);
      }
      f.setTheme({ fg: (_color: string, text: string) => text, bold: (text: string) => `UPDATED ${text}` } as Theme);
      f.viewer.invalidate(); f.tui.renderNow(true);
      assert.ok(f.invalidated > 0);
      assert.match(f.tui.getScreenLines().join("\n"), /UPDATED Conduct output/);
    } finally { f.tui.stop({ preserveScreen: true }); }
  });
});
