import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentStatus, ReviewSession } from "@workbench/shared";
import { emptySession } from "../store/session.ts";
import type { AppView } from "../apps/model.ts";
import { needsYou } from "./attention.ts";

function agent(id: string, status: AgentStatus, seq = 1): AgentInfo {
  return {
    pane_id: id,
    terminal_id: `t-${id}`,
    workspace_id: "w1",
    tab_id: "t1",
    focused: false,
    agent_status: status,
    agent: "claude",
    terminal_title_stripped: `agent ${id}`,
    revision: 0,
    interactive_ready: true,
    launch_pending: false,
    state_change_seq: seq,
    cwd: "/workspace/demo",
  };
}

function session(agents: AgentInfo[]) {
  const s = emptySession();
  s.workspaces = [{ workspace_id: "w1", number: 1, label: "demo", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t1", agent_status: "idle" }];
  for (const a of agents) {
    s.agents[a.pane_id] = a;
    s.panes[a.pane_id] = a;
  }
  return s;
}

const review = (key: string, status: "open" | "ended", pending = 0): ReviewSession => ({
  key,
  label: `Plan ${key}`,
  file: "/tmp/plan.html",
  created: "",
  updated: "",
  status,
  pending,
});

const app = (id: string, over: Partial<AppView> & { listening?: boolean }): AppView => {
  const { listening = true, ...rest } = over;
  return {
    id,
    name: id,
    port: 5173,
    keepPrefix: false,
    pinned: false,
    createdBy: "agent",
    createdAt: 0,
    visibility: { mode: "private", expiresAt: null },
    compat: "auto",
    url: `/a/${id}/`,
    live: { listening, pid: null, process: null, cwd: null, paneId: null, tabId: null, workspaceId: null },
    ...rest,
  };
};

describe("needsYou", () => {
  it("leads with blocked agents, then reviews, crashed apps and finished agents", () => {
    const needs = needsYou(
      session([agent("p1", "done"), agent("p2", "blocked"), agent("p3", "working")]),
      {},
      [review("aaaa0000", "open")],
      [app("goofy", { pinned: true, command: "npm run dev", listening: false })],
    );
    expect(needs.map((n) => n.kind)).toEqual(["blocked", "review", "crashed", "done"]);
    expect(needs[0]).toMatchObject({ paneId: "p2", detail: "Waiting for you in demo" });
  });

  it("drops a finished agent once it has been looked at, until it finishes again", () => {
    expect(needsYou(session([agent("p1", "done", 4)]), { p1: 4 }, [], null)).toEqual([]);
    expect(needsYou(session([agent("p1", "done", 5)]), { p1: 4 }, [], null)).toHaveLength(1);
  });

  it("counts only reviews still waiting on the human", () => {
    const needs = needsYou(session([]), {}, [review("a", "open", 2), review("b", "ended"), review("c", "open")], null);
    expect(needs.map((n) => n.reviewKey)).toEqual(["c"]);
  });

  it("counts a pinned app with a command that is not answering, and nothing else", () => {
    const needs = needsYou(
      session([]),
      {},
      [],
      [
        app("up", { pinned: true, command: "x", listening: true }),
        app("adhoc", { pinned: false, listening: false }),
        app("nocmd", { pinned: true, listening: false }),
        app("down", { pinned: true, command: "x", listening: false }),
      ],
    );
    expect(needs.map((n) => n.appId)).toEqual(["down"]);
  });
});
