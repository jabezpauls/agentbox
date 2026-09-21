import { describe, expect, it } from "vitest";
import { themeFromTokens } from "./themes.ts";

describe("themeFromTokens", () => {
  it("maps every xterm slot onto a design token", () => {
    const theme = themeFromTokens((name) => `value(${name})`);
    expect(theme.background).toBe("value(--term-bg)");
    expect(theme.foreground).toBe("value(--term-fg)");
    expect(theme.cursor).toBe("value(--term-cursor)");
    expect(theme.selectionBackground).toBe("value(--term-selection)");
    expect(theme.red).toBe("value(--ansi-red)");
    expect(theme.brightWhite).toBe("value(--ansi-bright-white)");
  });

  it("covers the whole ANSI set, so no colour is left to xterm's defaults", () => {
    const theme = themeFromTokens((name) => name);
    const slots = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow",
      "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ] as const;
    for (const slot of slots) expect(theme[slot]).toBeTruthy();
  });

  it("trims the whitespace getPropertyValue leaves on a custom property", () => {
    expect(themeFromTokens(() => "  #101010 ").background).toBe("#101010");
  });

  it("omits slots whose token is undefined instead of emitting empty colours", () => {
    const theme = themeFromTokens((name) => (name === "--term-bg" ? "#fff" : ""));
    expect(theme.background).toBe("#fff");
    expect(theme.foreground).toBeUndefined();
  });
});
