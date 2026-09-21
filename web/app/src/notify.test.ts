import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentStatus, PaneInfo } from "@workbench/shared";
import { emptySession, type Session } from "./store/session.ts";
import { notifyTransitions } from "./notify.ts";

function pane(id: string, status: AgentStatus, title: string): PaneInfo {
  return {
    pane_id: id,
    terminal_id: `t-${id}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent_status: status,
    terminal_title_stripped: title,
    revision: 0,
  };
}

function agent(id: string, status: AgentStatus, title: string): AgentInfo {
  return { ...pane(id, status, title), agent: "claude", interactive_ready: true, launch_pending: false };
}

function sessionWith(agents: AgentInfo[]): Session {
  const s = emptySession();
  for (const a of agents) {
    s.agents[a.pane_id] = a;
    s.panes[a.pane_id] = a;
  }
  return s;
}

describe("notifyTransitions", () => {
  it("toasts when an unfocused pane becomes blocked", () => {
    const prev = sessionWith([agent("w1:p2", "working", "claude")]);
    const next = sessionWith([agent("w1:p2", "blocked", "claude")]);
    const toasts = notifyTransitions(prev, next, "w1:p1");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "blocked", paneId: "w1:p2", title: "claude" });
  });

  it("does not toast a transition on the focused pane", () => {
    const prev = sessionWith([agent("w1:p2", "working", "claude")]);
    const next = sessionWith([agent("w1:p2", "blocked", "claude")]);
    expect(notifyTransitions(prev, next, "w1:p2")).toEqual([]);
  });

  it("toasts when an unfocused pane becomes done", () => {
    const prev = sessionWith([agent("w1:p2", "working", "claude")]);
    const next = sessionWith([agent("w1:p2", "done", "claude")]);
    const toasts = notifyTransitions(prev, next, null);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "done", paneId: "w1:p2" });
  });

  it("does not toast when the status is unchanged", () => {
    const prev = sessionWith([agent("w1:p2", "blocked", "claude")]);
    const next = sessionWith([agent("w1:p2", "blocked", "claude")]);
    expect(notifyTransitions(prev, next, null)).toEqual([]);
  });
});
