import type { ITheme } from "@xterm/xterm";

// xterm needs concrete colours, not CSS variables, so the palette is read out
// of theme/tokens.css at theme-apply time rather than restated here. That keeps
// one source of truth: change a token and the terminal follows.

/** Token name (without the leading `--`) for each xterm theme slot. */
const SLOTS = {
  background: "term-bg",
  foreground: "term-fg",
  cursor: "term-cursor",
  cursorAccent: "term-cursor-accent",
  selectionBackground: "term-selection",
  selectionInactiveBackground: "term-selection-inactive",
  black: "ansi-black",
  red: "ansi-red",
  green: "ansi-green",
  yellow: "ansi-yellow",
  blue: "ansi-blue",
  magenta: "ansi-magenta",
  cyan: "ansi-cyan",
  white: "ansi-white",
  brightBlack: "ansi-bright-black",
  brightRed: "ansi-bright-red",
  brightGreen: "ansi-bright-green",
  brightYellow: "ansi-bright-yellow",
  brightBlue: "ansi-bright-blue",
  brightMagenta: "ansi-bright-magenta",
  brightCyan: "ansi-bright-cyan",
  brightWhite: "ansi-bright-white",
} as const;

export type TokenReader = (name: string) => string;

/**
 * Build an xterm theme from a token reader. Pure, so the mapping is testable
 * without a DOM: any slot the reader cannot resolve is simply left unset and
 * xterm falls back to its own default for it.
 */
export function themeFromTokens(read: TokenReader): ITheme {
  const theme: Record<string, string> = {};
  for (const [slot, token] of Object.entries(SLOTS)) {
    const value = read(`--${token}`).trim();
    if (value) theme[slot] = value;
  }
  return theme as ITheme;
}

/** Read the live palette off `:root`, which carries whichever theme is applied. */
export function terminalTheme(): ITheme {
  if (typeof document === "undefined") return {};
  const styles = getComputedStyle(document.documentElement);
  return themeFromTokens((name) => styles.getPropertyValue(name));
}
