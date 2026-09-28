import type { EditorThemeKind } from "@workbench/shared";

/** VS Code's own defaults for each kind, when nothing is preferred. */
export const DEFAULT_THEMES: Record<EditorThemeKind, string> = {
  light: "Default Light Modern",
  dark: "Default Dark Modern",
};

/**
 * The color theme to switch to when the app turns light or dark: the one
 * VS Code already prefers for that kind (`workbench.preferredLightColorTheme`
 * / `preferredDarkColorTheme`, which a person may have set), else the default
 * Modern pair. Null when the current theme is already it.
 */
export function themeToApply(kind: EditorThemeKind, get: (key: string) => string | undefined): string | null {
  const preferred = get(kind === "dark" ? "preferredDarkColorTheme" : "preferredLightColorTheme");
  const target = preferred && preferred.trim() ? preferred : DEFAULT_THEMES[kind];
  return get("colorTheme") === target ? null : target;
}
