import { create } from "zustand";
import { http, HttpError } from "../api/http.ts";

/**
 * The app model, as the bridge's `/api/apps` serves it: the gate's record of
 * each app merged with what the bridge sees live (is anything listening on
 * its port, which process, which pane).
 *
 * TODO(one-app/c-apps): this mirrors the spec's App record until Phase C's
 * `AppView` lands in @workbench/shared; switch to that type then.
 */
export type AppVisibilityMode = "private" | "link" | "passcode";

export interface AppVisibility {
  mode: AppVisibilityMode;
  /** Milliseconds; null means until stopped. */
  expiresAt: number | null;
  sharedAt?: number;
}

export interface AppView {
  id: string;
  name: string;
  port: number;
  keepPrefix: boolean;
  cwd?: string;
  command?: string;
  pinned: boolean;
  createdBy: "owner" | "agent";
  createdAt: number;
  visibility: AppVisibility;
  compat: "auto" | "off";
  /** Something is answering on the port right now. */
  listening: boolean;
  pid?: number;
  /** The herdr pane the listening process runs in. */
  paneId?: string;
  /** The app's own URL, `/a/<id>/`. */
  url: string;
}

export interface AppCreate {
  port: number;
  name?: string;
  cwd?: string;
  command?: string;
  pinned?: boolean;
}

export interface AppPatch {
  name?: string;
  pinned?: boolean;
  compat?: "auto" | "off";
  keepPrefix?: boolean;
  command?: string;
  cwd?: string;
}

export interface ShareRequest {
  mode: AppVisibilityMode;
  /** Seconds; omitted means until stopped. */
  expiresIn?: number;
  passcode?: string;
}

const enc = encodeURIComponent;

export const appsApi = {
  /** Every app, or null when this box has no app API (it predates apps). */
  async list(): Promise<AppView[] | null> {
    try {
      return await http.get<AppView[]>("/api/apps");
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 501)) return null;
      throw err;
    }
  },
  create: (body: AppCreate) => http.post<AppView>("/api/apps", body),
  update: (id: string, patch: AppPatch) => http.patch<AppView>(`/api/apps/${enc(id)}`, patch),
  remove: (id: string) => http.del<void>(`/api/apps/${enc(id)}`),
  open: (id: string) => http.post<void>(`/api/apps/${enc(id)}/open`),
  restart: (id: string) => http.post<void>(`/api/apps/${enc(id)}/restart`),
  stop: (id: string) => http.post<void>(`/api/apps/${enc(id)}/stop`),
  /** Make an app public — the owner's call alone, so it goes to the gate. */
  share: (id: string, req: ShareRequest) => http.put<AppView>(`/_gate/apps/${enc(id)}/visibility`, req),
  unshare: (id: string) => http.del<void>(`/_gate/apps/${enc(id)}/visibility`),
};

interface AppsState {
  /** null until known, and while the box has no app API. */
  apps: AppView[] | null;
  supported: boolean | null;
  error: string | null;
  refresh(): Promise<void>;
}

/**
 * The apps, shared by Home, Apps, the palette and "needs you". Refreshed on
 * `apps.changed` from the events socket and by whichever surface is showing.
 */
export const useApps = create<AppsState>((set) => ({
  apps: null,
  supported: null,
  error: null,
  async refresh() {
    try {
      const apps = await appsApi.list();
      if (apps === null) set({ apps: null, supported: false, error: null });
      else set({ apps: [...apps].sort((a, b) => a.name.localeCompare(b.name)), supported: true, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/** An app a pinned command should be running but nothing answers on its port. */
export function isCrashed(app: AppView): boolean {
  return app.pinned && Boolean(app.command) && !app.listening;
}

/** Shared publicly right now (not expired). */
export function isPublic(app: AppView, now = Date.now()): boolean {
  const v = app.visibility;
  return v.mode !== "private" && (v.expiresAt === null || v.expiresAt > now);
}
