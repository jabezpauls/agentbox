import { describe, expect, it } from "vitest";
import type { AgentInfo, HerdrEvent, SessionSnapshot } from "@workbench/shared";
import {
  agentsSorted,
  applyEvent,
  emptySession,
  fromSnapshot,
  panesOf,
  rollup,
  tabsOf,
  type Session,
} from "./session.ts";
import snapshotFixture from "./fixtures/snapshot.json" with { type: "json" };
import eventsFixture from "./fixtures/events.json" with { type: "json" };

interface RecordedEvent {
  label: string;
  event: string;
  data: unknown;
}

const recorded = eventsFixture as RecordedEvent[];
const snapshot = snapshotFixture as unknown as SessionSnapshot;

/** The first recorded event with the given name; fixtures are real herdr output. */
function ev(name: HerdrEvent["event"]): HerdrEvent {
  const found = recorded.find((r) => r.event === name);
  if (!found) throw new Error(`no recorded ${name} event in the fixture`);
  return { event: found.event, data: found.data } as HerdrEvent;
}

function evWithLabel(label: string, name: HerdrEvent["event"]): HerdrEvent {
  const found = recorded.find((r) => r.label === label && r.event === name);
  if (!found) throw new Error(`no recorded ${name} event labelled ${label}`);
  return { event: found.event, data: found.data } as HerdrEvent;
}

function base(): Session {
  return fromSnapshot(snapshot);
}

describe("fromSnapshot", () => {
  it("keys panes, layouts and agents and carries focus", () => {
    const s = base();
    expect(s.workspaces.length).toBe(snapshot.workspaces.length);
    expect(Object.keys(s.panes)).toEqual(snapshot.panes.map((p) => p.pane_id));
    expect(s.layouts[snapshot.layouts[0]!.tab_id]).toBeTruthy();
    expect(s.focusedPaneId).toBe(snapshot.focused_pane_id ?? null);
  });
});

describe("applyEvent is pure", () => {
  it("does not mutate its input", () => {
    const s = base();
    const frozen = JSON.stringify(s);
    applyEvent(s, ev("pane_created"));
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("workspace events", () => {
  it("creates a workspace", () => {
    const s = applyEvent(emptySession(), ev("workspace_created"));
    expect(s.workspaces.some((w) => w.workspace_id === "w1")).toBe(true);
  });

  it("renames a workspace", () => {
    const start = applyEvent(emptySession(), ev("workspace_created"));
    // the recorded rename targets w2; rename w1 with a synthetic-shaped real event
    const renamed = applyEvent(start, {
      event: "workspace_renamed",
      data: { workspace_id: "w1", label: "renamed" },
    } as HerdrEvent);
    expect(renamed.workspaces.find((w) => w.workspace_id === "w1")?.label).toBe("renamed");
  });

  it("removes a workspace and everything under it", () => {
    const e = ev("workspace_closed");
    const wid = (e.data as { workspace_id?: string; workspace?: { workspace_id: string } }).workspace_id
      ?? (e.data as { workspace: { workspace_id: string } }).workspace.workspace_id;
    // seed the target workspace with a tab, pane, layout and agent
    let s = base();
    s = {
      ...s,
      workspaces: [
        ...s.workspaces,
        { workspace_id: wid, number: 9, label: "doomed", focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${wid}:t1`, agent_status: "blocked" },
      ],
      tabs: [
        ...s.tabs,
        { tab_id: `${wid}:t1`, workspace_id: wid, number: 1, label: "1", focused: false, pane_count: 1, agent_status: "blocked" },
      ],
      panes: {
        ...s.panes,
        [`${wid}:p1`]: { pane_id: `${wid}:p1`, terminal_id: "t", workspace_id: wid, tab_id: `${wid}:t1`, focused: false, agent_status: "blocked", revision: 0 },
      },
      layouts: { ...s.layouts, [`${wid}:t1`]: { workspace_id: wid, tab_id: `${wid}:t1`, zoomed: false, area: { x: 0, y: 0, width: 1, height: 1 }, focused_pane_id: null, panes: [], splits: [] } },
      agents: { ...s.agents, [`${wid}:p1`]: { pane_id: `${wid}:p1`, terminal_id: "t", workspace_id: wid, tab_id: `${wid}:t1`, focused: false, agent_status: "blocked", revision: 0, interactive_ready: true, launch_pending: false } },
    };
    const closed = applyEvent(s, e);
    expect(closed.workspaces.some((w) => w.workspace_id === wid)).toBe(false);
    expect(closed.tabs.some((t) => t.workspace_id === wid)).toBe(false);
    expect(Object.values(closed.panes).some((p) => p.workspace_id === wid)).toBe(false);
    expect(closed.layouts[`${wid}:t1`]).toBeUndefined();
    expect(Object.values(closed.agents).some((a) => a.workspace_id === wid)).toBe(false);
  });
});

describe("tab and pane events", () => {
  it("creates a tab", () => {
    const s = applyEvent(base(), ev("tab_created"));
    const tab = (ev("tab_created").data as { tab: { tab_id: string } }).tab;
    expect(s.tabs.some((t) => t.tab_id === tab.tab_id)).toBe(true);
  });

  it("creates and closes a pane", () => {
    const created = applyEvent(base(), evWithLabel("pane_split", "pane_created"));
    const pane = (evWithLabel("pane_split", "pane_created").data as { pane: { pane_id: string } }).pane;
    expect(created.panes[pane.pane_id]).toBeTruthy();
    const closed = applyEvent(created, ev("pane_closed"));
    const closedId = (ev("pane_closed").data as { pane_id: string }).pane_id;
    expect(closed.panes[closedId]).toBeUndefined();
  });

  it("focuses a pane", () => {
    const s = applyEvent(base(), ev("pane_focused"));
    const pid = (ev("pane_focused").data as { pane_id: string }).pane_id;
    expect(s.focusedPaneId).toBe(pid);
  });
});

describe("layout_updated", () => {
  it("replaces the layout keyed by tab_id", () => {
    const e = evWithLabel("layout_updated", "layout_updated");
    const layout = (e.data as { layout: { tab_id: string; panes: unknown[] } }).layout;
    const s = applyEvent(base(), e);
    expect(s.layouts[layout.tab_id]).toEqual(layout);
    expect(s.layouts[layout.tab_id]!.panes.length).toBe(layout.panes.length);
  });
});

describe("agent events", () => {
  it("upserts an agent and mirrors status on the pane", () => {
    const e = ev("pane_agent_status_changed");
    const d = e.data as { pane_id: string; agent_status: string };
    const s = applyEvent(base(), e);
    expect(s.agents[d.pane_id]?.agent_status).toBe(d.agent_status);
    expect(s.panes[d.pane_id]?.agent_status).toBe(d.agent_status);
  });

  it("advances state_change_seq only on a real status change", () => {
    // seed an agent at seq 3 with status working
    const seeded: Session = {
      ...base(),
      agents: {
        "w1:p1": {
          pane_id: "w1:p1",
          terminal_id: "t",
          workspace_id: "w1",
          tab_id: "w1:t1",
          focused: false,
          agent_status: "working",
          revision: 0,
          interactive_ready: true,
          launch_pending: false,
          state_change_seq: 3,
        },
      },
    };
    const changed = applyEvent(seeded, {
      event: "pane_agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" },
    } as HerdrEvent);
    expect(changed.agents["w1:p1"]?.state_change_seq).toBe(4);

    const sameAgain = applyEvent(changed, {
      event: "pane_agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" },
    } as HerdrEvent);
    expect(sameAgain.agents["w1:p1"]?.state_change_seq).toBe(4);

    // markSeen then compares correctly: seen (3) < current (4) => unseen Done
    expect((seeded.agents["w1:p1"]?.state_change_seq ?? 0) < (changed.agents["w1:p1"]?.state_change_seq ?? 0)).toBe(
      true,
    );
  });

  it("removes the agent when detection reports released", () => {
    const withAgent = applyEvent(base(), ev("pane_agent_status_changed"));
    const pid = (ev("pane_agent_status_changed").data as { pane_id: string }).pane_id;
    expect(withAgent.agents[pid]).toBeTruthy();
    // real herdr shape for a release (see @workbench/shared HerdrEvent)
    const released = applyEvent(withAgent, {
      event: "pane_agent_detected",
      data: { pane_id: pid, workspace_id: "w1", agent: "claude", released: true },
    } as HerdrEvent);
    expect(released.agents[pid]).toBeUndefined();
  });
});

describe("selectors", () => {
  it("tabsOf and panesOf filter by parent", () => {
    const s = base();
    const wid = s.workspaces[0]!.workspace_id;
    for (const t of tabsOf(s, wid)) expect(t.workspace_id).toBe(wid);
    const tid = s.tabs[0]!.tab_id;
    for (const p of panesOf(s, tid)) expect(p.tab_id).toBe(tid);
  });

  it("rolls status up by severity", () => {
    expect(rollup(["idle", "blocked"])).toBe("blocked");
    expect(rollup(["idle", "working", "done"])).toBe("working");
    expect(rollup(["done", "idle"])).toBe("done");
    expect(rollup([])).toBe("unknown");
  });

  it("sorts agents blocked, done, working, idle, unknown then by workspace number", () => {
    const mk = (pane_id: string, workspace_id: string, agent_status: AgentInfo["agent_status"]): AgentInfo => ({
      pane_id,
      terminal_id: `t_${pane_id}`,
      workspace_id,
      tab_id: `${workspace_id}:t1`,
      focused: false,
      agent_status,
      revision: 0,
      interactive_ready: true,
      launch_pending: false,
    });
    const s: Session = {
      ...emptySession(),
      workspaces: [
        { workspace_id: "w1", number: 1, label: "a", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "unknown" },
        { workspace_id: "w2", number: 2, label: "b", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "unknown" },
      ],
      agents: {
        a1: mk("a1", "w2", "working"),
        a2: mk("a2", "w1", "working"),
        a3: mk("a3", "w1", "blocked"),
        a4: mk("a4", "w1", "idle"),
        a5: mk("a5", "w1", "done"),
        a6: mk("a6", "w1", "unknown"),
      },
    };
    expect(agentsSorted(s).map((a) => a.pane_id)).toEqual(["a3", "a5", "a2", "a1", "a4", "a6"]);
  });
});
