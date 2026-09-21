import { create } from "zustand";
import type { EventsMessage, HerdrEvent, ListeningPort } from "@workbench/shared";
import type { ConnStatus } from "../api/events.ts";
import { getSession, rpc, RpcError, type HealthInfo } from "../api/client.ts";
import { applyEvent, emptySession, fromSnapshot, type Session } from "./session.ts";
import { blockedCount, notifyTransitions, type Toast } from "../notify.ts";
import type { Theme } from "../theme/useTheme.ts";

export interface StoredToast extends Toast {
  id: string;
}

export type InspectorTab = "preview" | "review";
export interface PaletteState { mode: string }
export interface DialogState { kind: string; [k: string]: unknown }

/**
 * The inspector drawer's state, kept as one object so it can be persisted and
 * updated atomically via `setInspector`. `port`/`path` are the preview target a
 * localhost link click writes here; `reviewKey` is the review session the
 * Review panel is showing, or null for its session list.
 */
export type PreviewDevice = "auto" | 390 | 768 | 1024;

export interface InspectorState {
  open: boolean;
  tab: InspectorTab;
  width: number;
  port: number | null;
  path: string;
  device: PreviewDevice;
  reviewKey: string | null;
}

const INSPECTOR_KEY = "workbench.inspector";

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
  inspector: InspectorState;
  palette: null | PaletteState;
  dialog: null | DialogState;
  theme: Theme;
  prefixArmed: boolean;
}

export interface AppState {
  status: ConnStatus;
  session: Session;
  ports: ListeningPort[];
  health: HealthInfo | null;
  ui: UiState;
  seenDone: Record<string, number>;
  toasts: StoredToast[];
  // The theme lives in the useTheme hook (it owns the DOM). App registers its
  // cycle here so actions and the palette can toggle the theme too.
  themeCycle: (() => void) | null;
  applyMessage(m: EventsMessage): void;
  setStatus(s: ConnStatus): void;
  setHealth(h: HealthInfo): void;
  setUi(partial: Partial<UiState>): void;
  /**
   * Update the inspector. `persist: false` is for the live phase of a resize
   * drag, which would otherwise write localStorage on every pointermove.
   */
  setInspector(partial: Partial<InspectorState>, opts?: { persist?: boolean }): void;
  pushToast(toast: Toast): void;
  reportRpcError(method: string, err: unknown): void;
  focusPane(id: string): void;
  focusTab(id: string): void;
  focusWorkspace(id: string): void;
  markSeen(paneId: string): void;
  dismissToast(id: string): void;
  setThemeCycle(fn: (() => void) | null): void;
}

// Toast ids only need to be unique within a session; the pane and kind make
// duplicates from a burst distinguishable in React's reconciliation.
function toastId(t: Toast): string {
  return `${t.paneId}:${t.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}

// Reflect the blocked count in the document title so a background tab shows it.
function syncTitle(session: Session): void {
  if (typeof document === "undefined") return;
  const n = blockedCount(session);
  document.title = n > 0 ? `(${n}) Workbench` : "Workbench";
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

const initialUi: UiState = {
  sidebarOpen: wideViewport,
  inspector: { open: false, tab: "preview", width: 420, port: null, path: "/", device: "auto", reviewKey: null, ...readInspector() },
  palette: null,
  dialog: null,
  theme: "system",
  prefixArmed: false,
};

export const useApp = create<AppState>((set, get) => ({
  status: "connecting",
  session: emptySession(),
  ports: [],
  health: null,
  ui: initialUi,
  seenDone: {},
  toasts: [],
  themeCycle: null,

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
          const stored = fresh.map((t) => ({ ...t, id: toastId(t) }));
          set((s) => ({ toasts: [...s.toasts, ...stored] }));
          systemNotify(fresh, (id) => get().focusPane(id));
        }
        syncTitle(next);
        break;
      }
      case "ports": {
        set({ ports: m.ports });
        // The first time a real (non-system) port appears while the inspector
        // is closed, open it on that port — once per session.
        if (!previewAutoOpened) {
          const port = m.ports.find((p) => !p.system);
          if (port && !get().ui.inspector.open) {
            previewAutoOpened = true;
            get().setInspector({ open: true, tab: "preview", port: port.port, path: "/" });
          }
        }
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

  pushToast(toast) {
    set((s) => ({ toasts: [...s.toasts, { ...toast, id: toastId(toast) }] }));
  },

  reportRpcError(method, err) {
    const detail = err instanceof RpcError ? err.message : err instanceof Error ? err.message : String(err);
    get().pushToast({ kind: "error", paneId: "", title: `${method} failed`, detail });
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
    rpc("workspace.focus", { workspace_id: id }).catch((err) => get().reportRpcError("workspace.focus", err));
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
    rpc("tab.focus", { tab_id: id }).catch((err) => get().reportRpcError("tab.focus", err));
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
    rpc("pane.focus", { pane_id: id }).catch((err) => get().reportRpcError("pane.focus", err));
  },

  markSeen(paneId) {
    const { session } = get();
    const seq = session.agents[paneId]?.state_change_seq ?? 0;
    set((s) => ({ seenDone: { ...s.seenDone, [paneId]: seq } }));
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setThemeCycle(fn) {
    set({ themeCycle: fn });
  },
}));

// Dev-only affordance: expose the store on window so the app can be inspected
// and driven from the browser console (and from automated live checks). Never
// included in a production build.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { useApp?: typeof useApp }).useApp = useApp;
}
