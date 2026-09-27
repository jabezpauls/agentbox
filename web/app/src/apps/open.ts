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

/** The app's own page, in a new tab. */
export function openAppFullScreen(app: AppView): void {
  window.open(app.url, "_blank", "noopener");
}

export function showApp(id: string): void {
  navigate({ surface: "apps", appId: id });
}
