import { create } from "zustand";
import type { AppView, EventsMessage, HerdrEvent, ListeningPort } from "@workbench/shared";
import type { ConnStatus } from "../api/events.ts";
import { getSession, listApps, makeApp, rpc, RpcError, type HealthInfo } from "../api/client.ts";
import { applyEvent, emptySession, fromSnapshot, type Session } from "./session.ts";
import { blockedCount, notifyTransitions, rpcErrorTitle, type Toast } from "../notify.ts";
import type { Theme } from "../theme/useTheme.ts";
import { setTitleCount } from "../shell/title.ts";

export interface StoredToast extends Toast {
  id: string;
  /**
   * What makes this toast "the same" as another. Two toasts with equal keys
   * refresh one row rather than stacking a second copy of the same sentence;
   * two distinct failures keep their own rows even when they share a headline.
   */
  dedupe: string;
  /** Re-run the call that failed. Error toasts offer this as a Retry action. */
  retry?: () => void;
  /** One action the toast offers — Undo, Open, Show. */
  action?: { label: string; run(): void };
  /** What clicking the toast itself does, for toasts that are not about a pane. */
  open?: () => void;
}

export interface ToastOpts {
  retry?: () => void;
  dedupe?: string;
  action?: { label: string; run(): void };
  open?: () => void;
}

/** At most this many toasts are kept; the stack shows the newest three. */
const MAX_TOASTS = 6;

/**
 * Add a toast, replacing any identical one in place rather than stacking a
 * second copy of the same sentence. The replacement takes a fresh id so its
 * dismissal timer restarts.
 */
function mergeToast(list: StoredToast[], toast: StoredToast): StoredToast[] {
  return [...list.filter((t) => t.dedupe !== toast.dedupe), toast].slice(-MAX_TOASTS);
}

export type InspectorTab = "preview" | "review";
export interface PaletteState { mode: string }
export interface DialogState { kind: string; [k: string]: unknown }

/**
 * The inspector drawer's state, kept as one object so it can be persisted and
 * updated atomically via `setInspector`. `path` is where the Preview panel is
 * within its app (the app itself is `ui.previewAppId`); `reviewKey` is the
 * review session the Review panel is showing, or null for its session list.
 */
export type PreviewDevice = "auto" | 390 | 768 | 1024;

export interface InspectorState {
  open: boolean;
  tab: InspectorTab;
  width: number;
  path: string;
  device: PreviewDevice;
  reviewKey: string | null;
}

const INSPECTOR_KEY = "workbench.inspector";
const PREVIEW_APP_KEY = "workbench.previewApp";

/** The app the Preview panel showed last, so a reload shows it again. */
function readPreviewApp(): string | null {
  try {
    const v = localStorage.getItem(PREVIEW_APP_KEY);
    return v && /^[a-z2-7]{26}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function persistPreviewApp(id: string | null): void {
  try {
    if (id) localStorage.setItem(PREVIEW_APP_KEY, id);
    else localStorage.removeItem(PREVIEW_APP_KEY);
  } catch {
    // Private mode or blocked storage; the choice holds for this session only.
  }
}
const SEEN_KEY = "agentbox.seenDone";

// Which finished agents have been looked at, across reloads, so Home does not
// bring every finished agent back as news each time the page loads.
function readSeen(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

function persistSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Blocked storage: remembered for this page only.
  }
}
const SIDEBAR_KEY = "workbench.sidebarWidth";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;

/** The sidebar's persisted width, clamped to the drag range. */
function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_KEY));
    if (!Number.isFinite(raw) || raw === 0) return 260;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
  } catch {
    return 260;
  }
}

// Remember the inspector's open state, width and tab across reloads.
function readInspector(): Partial<InspectorState> {
  try {
    const raw = localStorage.getItem(INSPECTOR_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<InspectorState>;
    const out: Partial<InspectorState> = {};
    if (typeof v.open === "boolean") out.open = v.open;
    if (v.tab === "preview" || v.tab === "review") out.tab = v.tab;
    if (typeof v.width === "number") out.width = v.width;
    return out;
  } catch {
    return {};
  }
}

function persistInspector(i: InspectorState): void {
  try {
    localStorage.setItem(INSPECTOR_KEY, JSON.stringify({ open: i.open, tab: i.tab, width: i.width }));
  } catch {
    // Private mode or blocked storage; the choice holds for this session only.
  }
}

export interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  inspector: InspectorState;
  /** The app the Preview panel shows; null for its picker alone. */
  previewAppId: string | null;
  palette: null | PaletteState;
  dialog: null | DialogState;
  theme: Theme;
  prefixArmed: boolean;
}

export interface AppState {
  status: ConnStatus;
  session: Session;
  ports: ListeningPort[];
  /** False when the bridge could not read `/proc` to enumerate ports at all. */
  portsReadable: boolean;
  /** Every app, with its live state; null until first loaded. */
  apps: AppView[] | null;
  /** Why the apps could not be read last time, in words; null when they were. */
  appsError: string | null;
  health: HealthInfo | null;
  ui: UiState;
  seenDone: Record<string, number>;
  toasts: StoredToast[];
  // The theme lives in the useTheme hook (it owns the DOM). App registers its
  // cycle here so actions and the palette can toggle the theme too.
  themeCycle: (() => void) | null;
  /** Choose a theme outright (Settings, the palette); registered by App like the cycle. */
  themeSet: ((t: Theme) => void) | null;
  applyMessage(m: EventsMessage): void;
  setStatus(s: ConnStatus): void;
  setHealth(h: HealthInfo): void;
  setUi(partial: Partial<UiState>): void;
  /**
   * Update the inspector. `persist: false` is for the live phase of a resize
   * drag, which would otherwise write localStorage on every pointermove.
   */
  setInspector(partial: Partial<InspectorState>, opts?: { persist?: boolean }): void;
  /**
   * Resize the sidebar. As with the inspector, `persist: false` is for the
   * live phase of a drag — one localStorage write per pointermove would be
   * hundreds of synchronous writes per gesture.
   */
  setSidebarWidth(width: number, opts?: { persist?: boolean }): void;
  /** Read the apps again (the bridge says `apps.changed`, or the panel changed one). */
  refreshApps(): Promise<void>;
  /**
   * Show an app in the right-hand panel's Preview: open the panel on Preview,
   * with that app, at `path` within it (its root by default).
   */
  openApp(appId: string, path?: string): void;
  /**
   * Show whatever serves `port` in Preview: its app, or — for a port that is
   * not one yet — a new app made of it (the owner's; private).
   */
  openPort(port: number, path?: string): Promise<void>;
  pushToast(toast: Toast, opts?: ToastOpts): void;
  reportRpcError(method: string, err: unknown, retry?: () => void): void;
  focusPane(id: string): void;
  focusTab(id: string): void;
  focusWorkspace(id: string): void;
  markSeen(paneId: string): void;
  dismissToast(id: string): void;
  setThemeCycle(fn: (() => void) | null): void;
  setThemeSet(fn: ((t: Theme) => void) | null): void;
}

// Toast ids only need to be unique within a session; the pane and kind make
// duplicates from a burst distinguishable in React's reconciliation.
function toastId(t: Toast): string {
  return `${t.paneId}:${t.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}

// Reflect the blocked count in the document title so a background tab shows it.
function syncTitle(session: Session): void {
  setTitleCount(blockedCount(session));
}

// Fire a system notification per toast when the user has granted permission.
// Clicking one focuses the pane. Permission is never requested here (only on an
// explicit user gesture elsewhere); we simply use it when already granted.
function systemNotify(toasts: Toast[], focus: (paneId: string) => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  for (const t of toasts) {
    try {
      const n = new Notification(`${t.title} · ${t.kind === "blocked" ? "blocked" : "done"}`, {
        body: t.kind === "blocked" ? "An agent needs you." : "An agent finished.",
        tag: `${t.paneId}:${t.kind}`,
      });
      n.onclick = () => {
        window.focus();
        focus(t.paneId);
        n.close();
      };
    } catch {
      // Some environments throw on construction; a missed notification is fine.
    }
  }
}

// On a phone the sidebar is a sheet, so it starts closed and the main area is
// shown first; on a wider screen it is a persistent column.
const wideViewport = typeof window === "undefined" || window.innerWidth >= 900;

// The inspector auto-opens on the first non-system port of a session, once.
let previewAutoOpened = false;

function narrowViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches;
}

const initialUi: UiState = {
  sidebarOpen: wideViewport,
  sidebarWidth: readSidebarWidth(),
  inspector: { open: false, tab: "preview", width: 420, path: "/", device: "auto", reviewKey: null, ...readInspector() },
  previewAppId: readPreviewApp(),
  palette: null,
  dialog: null,
  theme: "system",
  prefixArmed: false,
};

export const useApp = create<AppState>((set, get) => ({
  status: "connecting",
  session: emptySession(),
  ports: [],
  portsReadable: true,
  apps: null,
  appsError: null,
  health: null,
  ui: initialUi,
  seenDone: readSeen(),
  toasts: [],
  themeCycle: null,
  themeSet: null,

  applyMessage(m) {
    switch (m.kind) {
      case "snapshot": {
        const session = fromSnapshot(m.snapshot);
        set({ session });
        syncTitle(session);
        break;
      }
      case "event": {
        const prev = get().session;
        const next = applyEvent(prev, { event: m.event, data: m.data } as HerdrEvent);
        if (next === prev) break;
        const fresh = notifyTransitions(prev, next, prev.focusedPaneId);
        set({ session: next });
        if (fresh.length) {
          const stored = fresh.map((t) => ({ ...t, id: toastId(t), dedupe: `${t.kind}:${t.paneId}` }));
          set((s) => ({ toasts: stored.reduce(mergeToast, s.toasts) }));
          systemNotify(fresh, (id) => get().focusPane(id));
        }
        syncTitle(next);
        break;
      }
      case "ports": {
        const before = new Set(get().ports.map((p) => p.port));
        set({ ports: m.ports, portsReadable: m.readable !== false });
        // The first time a real (non-system) port appears while the inspector
        // is closed, open it on Preview — once per session — where the port
        // is one click from being shown. Not on a phone, where the dock is a
        // full-screen sheet and would take the screen away.
        if (!previewAutoOpened && !narrowViewport()) {
          const port = m.ports.find((p) => !p.system);
          if (port && !get().ui.inspector.open) {
            previewAutoOpened = true;
            get().setInspector({ open: true, tab: "preview" });
          }
        }
        // A server coming up or going away changes what the apps show.
        if (m.ports.some((p) => !before.has(p.port)) || m.ports.length !== before.size) void get().refreshApps();
        break;
      }
      case "app.open": {
        get().openApp(m.id, m.path ?? "/");
        get().pushToast(
          { kind: "app", paneId: "", appId: m.id, title: `${m.by} opened ${m.name} in Preview` },
          { dedupe: `app:${m.id}` },
        );
        void get().refreshApps();
        break;
      }
      case "apps.changed": {
        void get().refreshApps();
        break;
      }
      case "reset": {
        // herdr reconnected: take a fresh snapshot rather than trust our mirror.
        getSession()
          .then((snap) => {
            const session = fromSnapshot(snap);
            set({ session });
            syncTitle(session);
          })
          .catch((err) => get().reportRpcError("session", err));
        break;
      }
    }
  },

  setStatus(status) {
    set({ status });
  },

  setHealth(health) {
    set({ health });
  },

  setUi(partial) {
    set((s) => ({ ui: { ...s.ui, ...partial } }));
  },

  setInspector(partial, opts) {
    set((s) => {
      const inspector = { ...s.ui.inspector, ...partial };
      if (opts?.persist !== false) persistInspector(inspector);
      return { ui: { ...s.ui, inspector } };
    });
  },

  setSidebarWidth(width, opts) {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    if (opts?.persist !== false) {
      try {
        localStorage.setItem(SIDEBAR_KEY, String(clamped));
      } catch {
        // Private mode or blocked storage; the width holds for this session.
      }
    }
    set((s) => ({ ui: { ...s.ui, sidebarWidth: clamped } }));
  },

  async refreshApps() {
    try {
      set({ apps: await listApps(), appsError: null });
    } catch (err) {
      set({
        appsError:
          err instanceof RpcError
            ? err.status >= 500
              ? "The box is not answering right now — it may be restarting."
              : "The box turned the request down."
            : "The box could not be reached. Check the connection.",
      });
      // The list stays as it was; the panel says so if it never loaded.
      if (get().apps === null) set({ apps: [] });
    }
  },

  openApp(appId, path = "/") {
    persistPreviewApp(appId);
    set((s) => ({ ui: { ...s.ui, previewAppId: appId } }));
    get().setInspector({ open: true, tab: "preview", path });
  },

  async openPort(port, path = "/") {
    const known = get().apps?.find((a) => a.port === port);
    if (known) return get().openApp(known.id, path);
    try {
      const app = await makeApp(port);
      await get().refreshApps();
      get().openApp(app.id, path);
    } catch (err) {
      get().reportRpcError("app.create", err);
    }
  },

  pushToast(toast, opts) {
    const dedupe = opts?.dedupe ?? `${toast.kind}:${toast.paneId}:${toast.title}:${toast.detail ?? ""}`;
    const stored: StoredToast = {
      ...toast,
      id: toastId(toast),
      dedupe,
      ...(opts?.retry ? { retry: opts.retry } : {}),
      ...(opts?.action ? { action: opts.action } : {}),
      ...(opts?.open ? { open: opts.open } : {}),
    };
    set((s) => ({ toasts: mergeToast(s.toasts, stored) }));
  },

  reportRpcError(method, err, retry) {
    const detail = err instanceof RpcError ? err.message : err instanceof Error ? err.message : String(err);
    // Keyed by the method, not by the sentence: two different calls that fail
    // the same way are two facts, and collapsing them would hide one.
    get().pushToast(
      { kind: "error", paneId: "", title: rpcErrorTitle(method), detail },
      { ...(retry ? { retry } : {}), dedupe: `error:${method}:${detail}` },
    );
  },

  focusWorkspace(id) {
    const { session } = get();
    const ws = session.workspaces.find((w) => w.workspace_id === id);
    set({
      session: {
        ...session,
        focusedWorkspaceId: id,
        focusedTabId: ws?.active_tab_id ?? session.focusedTabId,
      },
    });
    rpc("workspace.focus", { workspace_id: id }).catch((err) =>
      get().reportRpcError("workspace.focus", err, () => {
        void rpc("workspace.focus", { workspace_id: id }).catch(() => {});
      }),
    );
  },

  focusTab(id) {
    const { session } = get();
    const tab = session.tabs.find((t) => t.tab_id === id);
    set({
      session: {
        ...session,
        focusedTabId: id,
        focusedWorkspaceId: tab?.workspace_id ?? session.focusedWorkspaceId,
      },
    });
    rpc("tab.focus", { tab_id: id }).catch((err) =>
      get().reportRpcError("tab.focus", err, () => {
        void rpc("tab.focus", { tab_id: id }).catch(() => {});
      }),
    );
  },

  focusPane(id) {
    const { session } = get();
    const pane = session.panes[id];
    set({
      session: {
        ...session,
        focusedPaneId: id,
        focusedTabId: pane?.tab_id ?? session.focusedTabId,
        focusedWorkspaceId: pane?.workspace_id ?? session.focusedWorkspaceId,
      },
    });
    rpc("pane.focus", { pane_id: id }).catch((err) =>
      get().reportRpcError("pane.focus", err, () => {
        void rpc("pane.focus", { pane_id: id }).catch(() => {});
      }),
    );
    // Looking at a finished agent is acknowledging it: it leaves "needs you".
    if (session.agents[id]?.agent_status === "done") get().markSeen(id);
  },

  markSeen(paneId) {
    const { session } = get();
    const seq = session.agents[paneId]?.state_change_seq ?? 0;
    set((s) => {
      // Only panes that still exist are worth remembering.
      const seenDone: Record<string, number> = { [paneId]: seq };
      for (const [k, v] of Object.entries(s.seenDone)) if (k !== paneId && session.panes[k]) seenDone[k] = v;
      persistSeen(seenDone);
      return { seenDone };
    });
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setThemeCycle(fn) {
    set({ themeCycle: fn });
  },

  setThemeSet(fn) {
    set({ themeSet: fn });
  },
}));

// Dev-only affordance: expose the store on window so the app can be inspected
// and driven from the browser console (and from automated live checks). Never
// included in a production build.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { useApp?: typeof useApp }).useApp = useApp;
}
