import type { rpc as rpcFn } from "../api/client.ts";
import type { useApp } from "../store/app.ts";
import { tabsOf } from "../store/session.ts";

/** Every keyboard-driven action, shared by the prefix map and the palette. */
export type ActionId =
  | "tab.new"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusLeft"
  | "pane.focusDown"
  | "pane.focusUp"
  | "pane.focusRight"
  | "pane.swapLeft"
  | "pane.swapDown"
  | "pane.swapUp"
  | "pane.swapRight"
  | "pane.zoom"
  | "pane.close"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.goto1"
  | "tab.goto2"
  | "tab.goto3"
  | "tab.goto4"
  | "tab.goto5"
  | "tab.goto6"
  | "tab.goto7"
  | "tab.goto8"
  | "tab.goto9"
  | "workspace.new"
  | "workspace.rename"
  | "workspace.close"
  | "palette.workspaces"
  | "palette.all"
  | "sidebar.toggle"
  | "terminal.blur"
  | "keymap.show";

export interface ActionCtx {
  store: typeof useApp;
  rpc: typeof rpcFn;
}

export interface Binding {
  /** The key combo pressed after the prefix, e.g. "c", "shift+h", "minus". */
  combo: string;
  id: ActionId;
  /** Human label for the keymap sheet. */
  label: string;
  /** How the combo reads to a person, e.g. "C", "⇧H", "-". */
  keys: string;
  /** Grouping for the keymap sheet. */
  group: "Panes" | "Tabs" | "Workspaces" | "View";
}

/**
 * The default herdr keymap, reproduced so muscle memory from the TUI carries
 * over. Each entry is the combo *after* the ctrl+b prefix. The single control
 * byte (prefix pressed twice) is handled by PrefixMachine, not a binding here.
 */
export const BINDINGS: Binding[] = [
  { combo: "c", id: "tab.new", label: "New tab", keys: "C", group: "Tabs" },
  { combo: "n", id: "tab.next", label: "Next tab", keys: "N", group: "Tabs" },
  { combo: "p", id: "tab.prev", label: "Previous tab", keys: "P", group: "Tabs" },
  { combo: "shift+x", id: "tab.close", label: "Close tab", keys: "⇧X", group: "Tabs" },
  { combo: "1", id: "tab.goto1", label: "Go to tab 1", keys: "1", group: "Tabs" },
  { combo: "2", id: "tab.goto2", label: "Go to tab 2", keys: "2", group: "Tabs" },
  { combo: "3", id: "tab.goto3", label: "Go to tab 3", keys: "3", group: "Tabs" },
  { combo: "4", id: "tab.goto4", label: "Go to tab 4", keys: "4", group: "Tabs" },
  { combo: "5", id: "tab.goto5", label: "Go to tab 5", keys: "5", group: "Tabs" },
  { combo: "6", id: "tab.goto6", label: "Go to tab 6", keys: "6", group: "Tabs" },
  { combo: "7", id: "tab.goto7", label: "Go to tab 7", keys: "7", group: "Tabs" },
  { combo: "8", id: "tab.goto8", label: "Go to tab 8", keys: "8", group: "Tabs" },
  { combo: "9", id: "tab.goto9", label: "Go to tab 9", keys: "9", group: "Tabs" },

  { combo: "v", id: "pane.splitRight", label: "Split right", keys: "V", group: "Panes" },
  { combo: "minus", id: "pane.splitDown", label: "Split down", keys: "-", group: "Panes" },
  { combo: "h", id: "pane.focusLeft", label: "Focus left", keys: "H", group: "Panes" },
  { combo: "j", id: "pane.focusDown", label: "Focus down", keys: "J", group: "Panes" },
  { combo: "k", id: "pane.focusUp", label: "Focus up", keys: "K", group: "Panes" },
  { combo: "l", id: "pane.focusRight", label: "Focus right", keys: "L", group: "Panes" },
  { combo: "shift+h", id: "pane.swapLeft", label: "Swap left", keys: "⇧H", group: "Panes" },
  { combo: "shift+j", id: "pane.swapDown", label: "Swap down", keys: "⇧J", group: "Panes" },
  { combo: "shift+k", id: "pane.swapUp", label: "Swap up", keys: "⇧K", group: "Panes" },
  { combo: "shift+l", id: "pane.swapRight", label: "Swap right", keys: "⇧L", group: "Panes" },
  { combo: "z", id: "pane.zoom", label: "Zoom pane", keys: "Z", group: "Panes" },
  { combo: "x", id: "pane.close", label: "Close pane", keys: "X", group: "Panes" },

  { combo: "shift+n", id: "workspace.new", label: "New workspace", keys: "⇧N", group: "Workspaces" },
  { combo: "shift+w", id: "workspace.rename", label: "Rename workspace", keys: "⇧W", group: "Workspaces" },
  { combo: "shift+d", id: "workspace.close", label: "Close workspace", keys: "⇧D", group: "Workspaces" },

  { combo: "w", id: "palette.workspaces", label: "Palette: workspaces", keys: "W", group: "View" },
  { combo: "g", id: "palette.all", label: "Command palette", keys: "G", group: "View" },
  { combo: "b", id: "sidebar.toggle", label: "Toggle sidebar", keys: "B", group: "View" },
  { combo: "q", id: "terminal.blur", label: "Blur terminal", keys: "Q", group: "View" },
  { combo: "?", id: "keymap.show", label: "Show this keymap", keys: "?", group: "View" },
];

export const DEFAULT_BINDINGS: Record<string, ActionId> = Object.fromEntries(
  BINDINGS.map((b) => [b.combo, b.id]),
);

const FOCUS_DIRECTION: Partial<Record<ActionId, "left" | "down" | "up" | "right">> = {
  "pane.focusLeft": "left",
  "pane.focusDown": "down",
  "pane.focusUp": "up",
  "pane.focusRight": "right",
};

const SWAP_DIRECTION: Partial<Record<ActionId, "left" | "down" | "up" | "right">> = {
  "pane.swapLeft": "left",
  "pane.swapDown": "down",
  "pane.swapUp": "up",
  "pane.swapRight": "right",
};

function gotoTab(ctx: ActionCtx, n: number): void {
  const s = ctx.store.getState();
  const wid = s.session.focusedWorkspaceId;
  if (!wid) return;
  const tabs = tabsOf(s.session, wid);
  const target = tabs[n - 1];
  if (target) s.focusTab(target.tab_id);
}

function stepTab(ctx: ActionCtx, delta: number): void {
  const s = ctx.store.getState();
  const wid = s.session.focusedWorkspaceId;
  if (!wid) return;
  const tabs = tabsOf(s.session, wid);
  if (tabs.length === 0) return;
  const i = tabs.findIndex((t) => t.tab_id === s.session.focusedTabId);
  const base = i === -1 ? 0 : i;
  const next = tabs[(base + delta + tabs.length) % tabs.length];
  if (next) s.focusTab(next.tab_id);
}

/**
 * Run one action. Direct pane/tab/layout effects go to herdr through `rpc`;
 * herdr's resulting events flow back and update the mirror, so we do not mutate
 * the session optimistically here. UI-only actions touch the store's ui slice.
 * Palette and workspace dialogs are hooks Task 9 fills in; they set ui state
 * that nothing renders yet, so they are harmless no-ops for now.
 */
export function runAction(id: ActionId, ctx: ActionCtx): void {
  const { rpc } = ctx;
  const s = ctx.store.getState();
  const { session, setUi, ui } = s;
  const paneId = session.focusedPaneId;
  const tabId = session.focusedTabId;
  const wid = session.focusedWorkspaceId;

  if (id in FOCUS_DIRECTION) {
    rpc("pane.focus_direction", { direction: FOCUS_DIRECTION[id] }).catch(() => {});
    return;
  }
  if (id in SWAP_DIRECTION) {
    rpc("pane.swap", { direction: SWAP_DIRECTION[id] }).catch(() => {});
    return;
  }
  if (id.startsWith("tab.goto")) {
    gotoTab(ctx, Number(id.slice("tab.goto".length)));
    return;
  }

  switch (id) {
    case "tab.new":
      if (wid) rpc("tab.create", { workspace_id: wid, focus: true }).catch(() => {});
      break;
    case "tab.next":
      stepTab(ctx, 1);
      break;
    case "tab.prev":
      stepTab(ctx, -1);
      break;
    case "tab.close":
      if (tabId) rpc("tab.close", { tab_id: tabId }).catch(() => {});
      break;
    case "pane.splitRight":
      if (paneId) rpc("pane.split", { direction: "right", target_pane_id: paneId, focus: true }).catch(() => {});
      break;
    case "pane.splitDown":
      if (paneId) rpc("pane.split", { direction: "down", target_pane_id: paneId, focus: true }).catch(() => {});
      break;
    case "pane.zoom":
      rpc("pane.zoom", { mode: "toggle" }).catch(() => {});
      break;
    case "pane.close":
      if (paneId) rpc("pane.close", { pane_id: paneId }).catch(() => {});
      break;
    case "workspace.new":
      setUi({ dialog: { kind: "workspace.new" } });
      break;
    case "workspace.rename":
      if (wid) setUi({ dialog: { kind: "workspace.rename", workspaceId: wid } });
      break;
    case "workspace.close":
      if (wid) rpc("workspace.close", { workspace_id: wid }).catch(() => {});
      break;
    case "palette.all":
      setUi({ palette: { mode: "all" } });
      break;
    case "palette.workspaces":
      setUi({ palette: { mode: "workspaces" } });
      break;
    case "sidebar.toggle":
      setUi({ sidebarOpen: !ui.sidebarOpen });
      break;
    case "terminal.blur":
      if (typeof document !== "undefined") (document.activeElement as HTMLElement | null)?.blur();
      break;
    case "keymap.show":
      setUi({ dialog: { kind: "keymap" } });
      break;
  }
}
