import { create } from "zustand";
import type { EventsMessage, HerdrEvent, LavishState, ListeningPort } from "@workbench/shared";
import type { ConnStatus } from "../api/events.ts";
import { getSession, rpc } from "../api/client.ts";
import { applyEvent, emptySession, fromSnapshot, type Session } from "./session.ts";
import type { Theme } from "../theme/useTheme.ts";

export type InspectorTab = "preview" | "lavish";
export interface PaletteState { mode: string }
export interface DialogState { kind: string; [k: string]: unknown }

export interface UiState {
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorWidth: number;
  palette: null | PaletteState;
  dialog: null | DialogState;
  theme: Theme;
  prefixArmed: boolean;
}

export interface AppState {
  status: ConnStatus;
  session: Session;
  ports: ListeningPort[];
  lavish: LavishState | null;
  ui: UiState;
  seenDone: Record<string, number>;
  applyMessage(m: EventsMessage): void;
  setStatus(s: ConnStatus): void;
  setUi(partial: Partial<UiState>): void;
  focusPane(id: string): void;
  focusTab(id: string): void;
  focusWorkspace(id: string): void;
  markSeen(paneId: string): void;
}

// On a phone the sidebar is a sheet, so it starts closed and the main area is
// shown first; on a wider screen it is a persistent column.
const wideViewport = typeof window === "undefined" || window.innerWidth >= 900;

const initialUi: UiState = {
  sidebarOpen: wideViewport,
  inspectorOpen: false,
  inspectorTab: "preview",
  inspectorWidth: 420,
  palette: null,
  dialog: null,
  theme: "system",
  prefixArmed: false,
};

export const useApp = create<AppState>((set, get) => ({
  status: "connecting",
  session: emptySession(),
  ports: [],
  lavish: null,
  ui: initialUi,
  seenDone: {},

  applyMessage(m) {
    switch (m.kind) {
      case "snapshot":
        set({ session: fromSnapshot(m.snapshot) });
        break;
      case "event":
        set((s) => ({ session: applyEvent(s.session, { event: m.event, data: m.data } as HerdrEvent) }));
        break;
      case "ports":
        set({ ports: m.ports });
        break;
      case "reset":
        // herdr reconnected: take a fresh snapshot rather than trust our mirror.
        getSession()
          .then((snap) => set({ session: fromSnapshot(snap) }))
          .catch(() => {});
        break;
    }
  },

  setStatus(status) {
    set({ status });
  },

  setUi(partial) {
    set((s) => ({ ui: { ...s.ui, ...partial } }));
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
    rpc("workspace.focus", { workspace_id: id }).catch(() => {});
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
    rpc("tab.focus", { tab_id: id }).catch(() => {});
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
    rpc("pane.focus", { pane_id: id }).catch(() => {});
  },

  markSeen(paneId) {
    const { session } = get();
    const seq = session.agents[paneId]?.state_change_seq ?? 0;
    set((s) => ({ seenDone: { ...s.seenDone, [paneId]: seq } }));
  },
}));
