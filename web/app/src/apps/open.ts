import { useApp } from "../store/app.ts";
import { navigate } from "../shell/router.ts";
import type { AppView } from "./model.ts";

/**
 * Show an app in the dock. The store's `openApp` (Phase C's action) opens the
 * dock on Preview with that app; before it exists, the dock is pointed at the
 * app's port the old way.
 */
export function openAppInDock(app: AppView): void {
  const s = useApp.getState() as ReturnType<typeof useApp.getState> & { openApp?: (id: string) => void };
  if (typeof s.openApp === "function") s.openApp(app.id);
  else s.setInspector({ open: true, tab: "preview", port: app.port, path: "/" });
}

/**
 * An app's address as the bridge gives it — a path under `/a/` on this
 * origin — or null for anything else. The URL comes from the box's app
 * registry, which a project's own files feed; it is never opened as-is.
 */
export function appPageUrl(url: string): string | null {
  if (!url.startsWith("/a/") || url.includes("\\")) return null;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith("/a/")) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/** The app's own page, in a new tab. */
export function openAppFullScreen(app: AppView): void {
  const url = appPageUrl(app.url);
  if (url) window.open(url, "_blank", "noopener");
}

export function showApp(id: string): void {
  navigate({ surface: "apps", appId: id });
}
