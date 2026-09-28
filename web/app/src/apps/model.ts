import type { AppView } from "@workbench/shared";
import { http } from "../api/http.ts";
import { makeApp, restartApp, stopSharing, updateApp } from "../api/client.ts";
import { useApp, type AppState } from "../store/app.ts";

/**
 * The apps, as Phase C's store holds them (`apps`, `refreshApps`), seen by
 * Home, Apps, the palette and "needs you" through one small facade, and the
 * calls those surfaces make that the store does not.
 */
export type { App, AppLive, AppView, AppVisibility, AppVisibilityMode } from "@workbench/shared";

const enc = encodeURIComponent;

export const appsApi = {
  /** A port made an app, as the owner (through the gate's side). */
  create: (body: { port: number; name?: string }) => makeApp(body.port, body.name),
  update: (id: string, patch: Parameters<typeof updateApp>[1]) => updateApp(id, patch),
  remove: (id: string) => http.del<void>(`/api/apps/${enc(id)}`),
  restart: (id: string) => restartApp(id),
  /** Stop what serves it; with `remove`, forget the app as well. */
  stop: (id: string, remove = false) => http.post<{ stopped: boolean; removed: boolean }>(`/api/apps/${enc(id)}/stop`, { remove }),
  unshare: (id: string) => stopSharing(id),
};

interface AppsView {
  /** null until read — and, when a read failed and none are known, while it fails. */
  apps: AppView[] | null;
  error: string | null;
  refresh(): Promise<void>;
}

function view(s: AppState): AppsView {
  return { apps: s.appsError && !s.apps?.length ? null : s.apps, error: s.appsError, refresh: s.refreshApps };
}

/** The store's apps, with the error the surfaces show. */
export function useApps<T>(select: (v: AppsView) => T): T {
  return useApp((s) => select(view(s)));
}
useApps.getState = (): AppsView => view(useApp.getState());

/** An app a pinned command should be running but nothing answers on its port. */
export function isCrashed(app: AppView): boolean {
  return app.pinned && Boolean(app.command) && !app.live.listening;
}

/** Shared publicly right now (not expired). */
export function isPublic(app: AppView, now = Date.now()): boolean {
  const v = app.visibility;
  return v.mode !== "private" && (v.expiresAt === null || v.expiresAt > now);
}
