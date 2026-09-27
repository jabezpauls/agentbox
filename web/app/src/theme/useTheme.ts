import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

export type Theme = "system" | "light" | "dark";
export type Resolved = "light" | "dark";

const STORAGE_KEY = "workbench.theme";
const ORDER: Theme[] = ["system", "light", "dark"];

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Private mode or blocked storage: fall back to following the system.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Applies the chosen theme to <html>: an explicit choice stamps
 * `data-theme`, and `system` removes it so `prefers-color-scheme` decides.
 */
function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function useTheme(): { theme: Theme; resolved: Resolved; cycle: () => void; set: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(readStored);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // A layout effect, not a passive one: a parent's layout effect runs before
  // every child's passive effect, so the terminals — which re-read the palette
  // off the document in a passive effect — see the new theme rather than the
  // one it replaced.
  useLayoutEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; the choice still holds for this session.
    }
  }, [theme]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const cycle = useCallback(() => {
    setTheme((prev) => ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length]!);
  }, []);

  const resolved: Resolved = useMemo(
    () => (theme === "system" ? (systemDark ? "dark" : "light") : theme),
    [theme, systemDark],
  );

  return { theme, resolved, cycle, set: setTheme };
}
