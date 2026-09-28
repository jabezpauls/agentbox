import { describe, it, expect } from "vitest";
import { themeToApply, type ThemeSettings } from "../src/theme.js";

/**
 * VS Code's configuration as the extension sees it: `get` falls back to the
 * real defaults for anything nobody set, and `userSet` says what somebody did.
 */
function vscodeSettings(user: Partial<Record<"colorTheme" | "preferredDarkColorTheme" | "preferredLightColorTheme", string>>): ThemeSettings {
  const defaults = {
    colorTheme: "Default Dark Modern",
    preferredDarkColorTheme: "Default Dark Modern",
    preferredLightColorTheme: "Default Light Modern",
  };
  return {
    get: (key) => user[key] ?? defaults[key],
    userSet: (key) => user[key] !== undefined,
  };
}

describe("following the app's theme", () => {
  it("switches an untouched editor to the Modern theme of the app's kind", () => {
    expect(themeToApply("light", vscodeSettings({}), undefined)).toBe("Default Light Modern");
    // Already dark by default: nothing to do.
    expect(themeToApply("dark", vscodeSettings({}), undefined)).toBeNull();
  });

  it("keeps following the theme it applied itself", () => {
    const settings = vscodeSettings({ colorTheme: "Default Light Modern" });
    expect(themeToApply("dark", settings, "Default Light Modern")).toBe("Default Dark Modern");
  });

  it("leaves a theme someone picked by hand alone, whatever the app does", () => {
    const monokai = vscodeSettings({ colorTheme: "Monokai" });
    expect(themeToApply("dark", monokai, undefined)).toBeNull();
    expect(themeToApply("light", monokai, undefined)).toBeNull();
    // Even when agentbox had applied one before the person chose theirs.
    expect(themeToApply("light", monokai, "Default Dark Modern")).toBeNull();
  });

  it("follows again once someone picks one of agentbox's themes by hand", () => {
    const settings = vscodeSettings({ colorTheme: "Default Dark Modern" });
    expect(themeToApply("light", settings, "Default Light Modern")).toBe("Default Light Modern");
  });

  it("uses the theme a person prefers for each kind", () => {
    const settings = vscodeSettings({ colorTheme: "Default Light Modern", preferredDarkColorTheme: "Solarized Dark" });
    expect(themeToApply("dark", settings, "Default Light Modern")).toBe("Solarized Dark");
    // And treats their preferred theme as one it manages.
    const onSolarized = vscodeSettings({ colorTheme: "Solarized Dark", preferredDarkColorTheme: "Solarized Dark" });
    expect(themeToApply("light", onSolarized, "Solarized Dark")).toBe("Default Light Modern");
  });
});
