import { describe, it, expect } from "vitest";
import { themeToApply } from "../src/theme.js";

const settings = (s: Record<string, string>) => (key: string) => s[key];

describe("following the app's theme", () => {
  it("switches to VS Code's Modern pair by default", () => {
    expect(themeToApply("dark", settings({ colorTheme: "Default Light Modern" }))).toBe("Default Dark Modern");
    expect(themeToApply("light", settings({ colorTheme: "Default Dark Modern" }))).toBe("Default Light Modern");
  });

  it("uses the theme a person prefers for that kind", () => {
    const s = settings({ colorTheme: "Default Light Modern", preferredDarkColorTheme: "Solarized Dark" });
    expect(themeToApply("dark", s)).toBe("Solarized Dark");
  });

  it("changes nothing when the editor already matches", () => {
    expect(themeToApply("dark", settings({ colorTheme: "Default Dark Modern" }))).toBeNull();
  });
});
