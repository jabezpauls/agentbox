import type { EditorThemeKind } from "@workbench/shared";

/** VS Code's own defaults for each kind. */
export const DEFAULT_THEMES: Record<EditorThemeKind, string> = {
  light: "Default Light Modern",
  dark: "Default Dark Modern",
};

/**
 * What the extension can see of the `workbench` settings. `get` answers as
 * VS Code's own does — with the default when nobody set the key — so
 * `userSet` is what tells a person's choice from a default.
 */
export interface ThemeSettings {
  get(key: "colorTheme" | "preferredDarkColorTheme" | "preferredLightColorTheme"): string | undefined;
  /** Whether anyone set `colorTheme` (user, workspace or folder settings). */
  userSet(key: "colorTheme"): boolean;
}

/**
 * The color theme to switch to when the app turns light or dark, or null to
 * leave the editor alone.
 *
 * The editor follows the app only while its theme is one agentbox manages:
 * VS Code's untouched default, the theme agentbox itself applied last, or
 * one of the two it would apply (a person picking one of those hands the
 * theme back). A theme someone picked by hand — Monokai, Solarized — is
 * theirs, and stays, however often the app changes.
 *
 * The theme applied is the one VS Code prefers for that kind
 * (`workbench.preferredLightColorTheme` / `preferredDarkColorTheme`, whose
 * defaults are the Modern pair).
 */
export function themeToApply(kind: EditorThemeKind, settings: ThemeSettings, lastApplied: string | undefined): string | null {
  const preferred = (k: EditorThemeKind) => {
    const v = settings.get(k === "dark" ? "preferredDarkColorTheme" : "preferredLightColorTheme");
    return v && v.trim() ? v : DEFAULT_THEMES[k];
  };
  const target = preferred(kind);
  const current = settings.get("colorTheme");
  const ours =
    !settings.userSet("colorTheme") ||
    (lastApplied !== undefined && current === lastApplied) ||
    current === preferred("light") ||
    current === preferred("dark");
  if (!ours || current === target) return null;
  return target;
}
