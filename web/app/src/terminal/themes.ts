import type { ITheme } from "@xterm/xterm";
import type { Resolved } from "../theme/useTheme.ts";

// xterm needs concrete colours, not CSS variables, so these palettes are kept
// in step with theme/tokens.css by hand: the same surfaces, text and accent,
// with an ANSI set tuned to stay legible (WCAG AA for text) on each ground.

const light: ITheme = {
  background: "#ffffff",
  foreground: "#171a1f",
  cursor: "#4c63e6",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(76, 99, 230, 0.22)",
  selectionInactiveBackground: "rgba(76, 99, 230, 0.12)",
  black: "#1f232b",
  red: "#c0392b",
  green: "#2e9e5b",
  yellow: "#a5730a",
  blue: "#4c63e6",
  magenta: "#9b3dcf",
  cyan: "#0e7c86",
  white: "#d7dae1",
  brightBlack: "#838a97",
  brightRed: "#e05545",
  brightGreen: "#37b56a",
  brightYellow: "#c9971f",
  brightBlue: "#6478f0",
  brightMagenta: "#b45ae0",
  brightCyan: "#1596a2",
  brightWhite: "#171a1f",
};

const dark: ITheme = {
  background: "#171a20",
  foreground: "#e8eaef",
  cursor: "#7f92f7",
  cursorAccent: "#171a20",
  selectionBackground: "rgba(127, 146, 247, 0.30)",
  selectionInactiveBackground: "rgba(127, 146, 247, 0.16)",
  black: "#272c36",
  red: "#e06c6c",
  green: "#45c07d",
  yellow: "#d8b25a",
  blue: "#7f92f7",
  magenta: "#c58af0",
  cyan: "#4fd0d8",
  white: "#a3aab8",
  brightBlack: "#6d7482",
  brightRed: "#ef8686",
  brightGreen: "#5fd695",
  brightYellow: "#eac26a",
  brightBlue: "#93a3ff",
  brightMagenta: "#d4a3f5",
  brightCyan: "#6fe0e8",
  brightWhite: "#e8eaef",
};

export function terminalTheme(resolved: Resolved): ITheme {
  return resolved === "dark" ? dark : light;
}
