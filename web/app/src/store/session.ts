import type {
  AgentInfo,
  AgentStatus,
  HerdrEvent,
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "@workbench/shared";

/**
 * A local, normalised copy of herdr's session. herdr owns the truth; the app
 * holds a mirror it keeps up to date by applying herdr's own events. Panes,
 * layouts and agents are keyed for O(1) upserts; workspaces and tabs stay as
 * ordered arrays because their order is meaningful in the UI.
 */
export interface Session {
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: Record<string, PaneInfo>;
  layouts: Record<string /* tab_id */, PaneLayoutSnapshot>;
  agents: Record<string /* pane_id */, AgentInfo>;
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
}

export function emptySession(): Session {
  return {
    workspaces: [],
    tabs: [],
    panes: {},
    layouts: {},
    agents: {},
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
  };
}

export function fromSnapshot(s: SessionSnapshot): Session {
  const panes: Record<string, PaneInfo> = {};
  for (const p of s.panes) panes[p.pane_id] = p;
  const layouts: Record<string, PaneLayoutSnapshot> = {};
  for (const l of s.layouts) layouts[l.tab_id] = l;
  const agents: Record<string, AgentInfo> = {};
  for (const a of s.agents) agents[a.pane_id] = a;
  return {
    workspaces: [...s.workspaces],
    tabs: [...s.tabs],
    panes,
    layouts,
    agents,
    focusedWorkspaceId: s.focused_workspace_id ?? null,
    focusedTabId: s.focused_tab_id ?? null,
    focusedPaneId: s.focused_pane_id ?? null,
  };
}

// --- helpers (all return fresh copies; the reducer never mutates) ------------

function upsertWorkspace(list: WorkspaceInfo[], ws: WorkspaceInfo): WorkspaceInfo[] {
  const i = list.findIndex((w) => w.workspace_id === ws.workspace_id);
  if (i === -1) return [...list, ws];
  const next = [...list];
  next[i] = ws;
  return next;
}

function upsertTab(list: TabInfo[], tab: TabInfo): TabInfo[] {
  const i = list.findIndex((t) => t.tab_id === tab.tab_id);
  if (i === -1) return [...list, tab];
  const next = [...list];
  next[i] = tab;
  return next;
}

function without<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const next = { ...record };
  for (const k of keys) delete next[k];
  return next;
}

/** Apply one herdr event to the session, returning a new Session (pure). */
export function applyEvent(s: Session, e: HerdrEvent): Session {
  switch (e.event) {
    case "workspace_created":
    case "workspace_updated":
    case "workspace_metadata_updated": {
      return { ...s, workspaces: upsertWorkspace(s.workspaces, e.data.workspace) };
    }
    case "worktree_created":
    case "worktree_opened": {
      return { ...s, workspaces: upsertWorkspace(s.workspaces, e.data.workspace) };
    }
    case "worktree_removed": {
      if (e.data.workspace) return { ...s, workspaces: upsertWorkspace(s.workspaces, e.data.workspace) };
      return s;
    }
    case "workspace_renamed": {
      return {
        ...s,
        workspaces: s.workspaces.map((w) =>
          w.workspace_id === e.data.workspace_id ? { ...w, label: e.data.label } : w,
        ),
      };
    }
    case "workspace_moved":
    case "workspace_reordered": {
      return { ...s, workspaces: [...e.data.workspaces] };
    }
    case "workspace_focused": {
      return {
        ...s,
        focusedWorkspaceId: e.data.workspace_id,
        workspaces: s.workspaces.map((w) => ({ ...w, focused: w.workspace_id === e.data.workspace_id })),
      };
    }
    case "workspace_closed": {
      const wid = e.data.workspace_id;
      const doomedTabs = s.tabs.filter((t) => t.workspace_id === wid).map((t) => t.tab_id);
      const doomedPanes = Object.values(s.panes).filter((p) => p.workspace_id === wid).map((p) => p.pane_id);
      return {
        ...s,
        workspaces: s.workspaces.filter((w) => w.workspace_id !== wid),
        tabs: s.tabs.filter((t) => t.workspace_id !== wid),
        panes: without(s.panes, doomedPanes),
        layouts: without(s.layouts, doomedTabs),
        agents: without(s.agents, doomedPanes),
        focusedWorkspaceId: s.focusedWorkspaceId === wid ? null : s.focusedWorkspaceId,
      };
    }
    case "tab_created": {
      return { ...s, tabs: upsertTab(s.tabs, e.data.tab) };
    }
    case "tab_renamed": {
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.tab_id === e.data.tab_id ? { ...t, label: e.data.label } : t)),
      };
    }
    case "tab_moved": {
      const wid = e.data.workspace_id;
      const others = s.tabs.filter((t) => t.workspace_id !== wid);
      return { ...s, tabs: [...others, ...e.data.tabs] };
    }
    case "tab_focused": {
      return {
        ...s,
        focusedTabId: e.data.tab_id,
        focusedWorkspaceId: e.data.workspace_id,
        tabs: s.tabs.map((t) => ({ ...t, focused: t.tab_id === e.data.tab_id })),
      };
    }
    case "tab_closed": {
      const tid = e.data.tab_id;
      const doomedPanes = Object.values(s.panes).filter((p) => p.tab_id === tid).map((p) => p.pane_id);
      return {
        ...s,
        tabs: s.tabs.filter((t) => t.tab_id !== tid),
        panes: without(s.panes, doomedPanes),
        layouts: without(s.layouts, [tid]),
        agents: without(s.agents, doomedPanes),
        focusedTabId: s.focusedTabId === tid ? null : s.focusedTabId,
      };
    }
    case "pane_created":
    case "pane_updated": {
      return { ...s, panes: { ...s.panes, [e.data.pane.pane_id]: e.data.pane } };
    }
    case "pane_closed":
    case "pane_exited": {
      const pid = e.data.pane_id;
      return {
        ...s,
        panes: without(s.panes, [pid]),
        agents: without(s.agents, [pid]),
        focusedPaneId: s.focusedPaneId === pid ? null : s.focusedPaneId,
      };
    }
    case "pane_focused": {
      return {
        ...s,
        focusedPaneId: e.data.pane_id,
        panes: Object.fromEntries(
          Object.entries(s.panes).map(([id, p]) => [id, { ...p, focused: id === e.data.pane_id }]),
        ),
      };
    }
    case "pane_moved": {
      const removed = new Set<string>([e.data.previous_pane_id]);
      let workspaces = s.workspaces;
      let tabs = s.tabs;
      if (e.data.created_workspace) workspaces = upsertWorkspace(workspaces, e.data.created_workspace);
      if (e.data.created_tab) tabs = upsertTab(tabs, e.data.created_tab);
      if (e.data.closed_tab_id) tabs = tabs.filter((t) => t.tab_id !== e.data.closed_tab_id);
      if (e.data.closed_workspace_id) workspaces = workspaces.filter((w) => w.workspace_id !== e.data.closed_workspace_id);
      const panes = { ...without(s.panes, removed), [e.data.pane.pane_id]: e.data.pane };
      const agents = without(s.agents, removed);
      return { ...s, workspaces, tabs, panes, agents };
    }
    case "pane_agent_detected": {
      const pid = e.data.pane_id;
      if (e.data.released) {
        const pane = s.panes[pid];
        return {
          ...s,
          agents: without(s.agents, [pid]),
          panes: pane ? { ...s.panes, [pid]: { ...pane, agent: null, agent_status: e.data.final_status ?? "unknown" } } : s.panes,
        };
      }
      const pane = s.panes[pid];
      if (!pane || e.data.agent == null) return s;
      return { ...s, panes: { ...s.panes, [pid]: { ...pane, agent: e.data.agent } } };
    }
    case "pane_agent_status_changed": {
      const { pane_id, agent_status, agent, display_agent, title, state_labels } = e.data;
      const pane = s.panes[pane_id];
      const prior = s.agents[pane_id];
      const baseAgent: AgentInfo = prior ??
        (pane
          ? { ...pane, interactive_ready: false, launch_pending: false }
          : {
              pane_id,
              terminal_id: "",
              workspace_id: e.data.workspace_id,
              tab_id: "",
              focused: false,
              agent_status,
              revision: 0,
              interactive_ready: false,
              launch_pending: false,
            });
      const nextAgent: AgentInfo = {
        ...baseAgent,
        agent_status,
        ...(agent !== undefined ? { agent } : {}),
        ...(display_agent !== undefined ? { display_agent } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(state_labels !== undefined ? { state_labels } : {}),
      };
      return {
        ...s,
        agents: { ...s.agents, [pane_id]: nextAgent },
        panes: pane ? { ...s.panes, [pane_id]: { ...pane, agent_status } } : s.panes,
      };
    }
    case "layout_updated": {
      return { ...s, layouts: { ...s.layouts, [e.data.layout.tab_id]: e.data.layout } };
    }
    default: {
      // Exhaustiveness: every documented event is handled above.
      return s;
    }
  }
}

// --- selectors ---------------------------------------------------------------

export function tabsOf(s: Session, workspaceId: string): TabInfo[] {
  return s.tabs.filter((t) => t.workspace_id === workspaceId);
}

export function panesOf(s: Session, tabId: string): PaneInfo[] {
  return Object.values(s.panes).filter((p) => p.tab_id === tabId);
}

/** Severity order for rolling many statuses up into one dot. */
const ROLLUP_RANK: Record<AgentStatus, number> = {
  blocked: 4,
  working: 3,
  done: 2,
  idle: 1,
  unknown: 0,
};

export function rollup(statuses: AgentStatus[]): AgentStatus {
  let best: AgentStatus = "unknown";
  for (const st of statuses) {
    if (ROLLUP_RANK[st] > ROLLUP_RANK[best]) best = st;
  }
  return best;
}

/** Order agents want-attention first: blocked, done, working, idle, unknown. */
const SORT_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

export function agentsSorted(s: Session): AgentInfo[] {
  const wsNumber = new Map(s.workspaces.map((w) => [w.workspace_id, w.number]));
  return Object.values(s.agents).sort((a, b) => {
    const byStatus = SORT_RANK[a.agent_status] - SORT_RANK[b.agent_status];
    if (byStatus !== 0) return byStatus;
    return (wsNumber.get(a.workspace_id) ?? 0) - (wsNumber.get(b.workspace_id) ?? 0);
  });
}

/** The rollup status for a workspace, from its agents' current statuses. */
export function workspaceRollup(s: Session, workspaceId: string): AgentStatus {
  const statuses = Object.values(s.agents)
    .filter((a) => a.workspace_id === workspaceId)
    .map((a) => a.agent_status);
  return rollup(statuses);
}
