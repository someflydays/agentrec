import type { ITheme } from "@xterm/xterm";

export const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Advance width per font size for the mono stack; cell height at lineHeight 1. */
const CHAR_ADVANCE_RATIO = 0.602;
const LINE_HEIGHT_RATIO = 1.22;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 15;

/**
 * The recording's geometry is authoritative — a replay must not reflow the
 * agent's output — so the pane scales the font instead of resizing the grid.
 */
export function fitFontSize(width: number, height: number, cols: number, rows: number): number {
  if (cols < 1 || rows < 1 || width < 1 || height < 1) return MAX_FONT_SIZE;
  const byWidth = width / (cols * CHAR_ADVANCE_RATIO);
  const byHeight = height / (rows * LINE_HEIGHT_RATIO);
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(Math.min(byWidth, byHeight))));
}

export const TERMINAL_THEME: ITheme = {
  background: "#08090b",
  foreground: "#d5d9de",
  cursor: "#ff8a3d",
  cursorAccent: "#08090b",
  selectionBackground: "#2b3138",
  black: "#15181c",
  red: "#ff5f56",
  green: "#4ec9a5",
  yellow: "#e3b341",
  blue: "#6aa9f4",
  magenta: "#c78ef0",
  cyan: "#4ec9d4",
  white: "#c8ced5",
  brightBlack: "#5d666f",
  brightRed: "#ff8078",
  brightGreen: "#6fdcbc",
  brightYellow: "#f0c96a",
  brightBlue: "#8fc0ff",
  brightMagenta: "#d7abf7",
  brightCyan: "#7adde6",
  brightWhite: "#f2f5f7",
};
