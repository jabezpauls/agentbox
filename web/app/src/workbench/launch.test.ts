import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySession } from "../store/session.ts";
import { useApp } from "../store/app.ts";

const call = vi.fn();
vi.mock("../api/call.ts", () => ({ call: (...args: unknown[]) => call(...args), actionCtx: () => ({}) }));

const { agentHere, projectOf, runHere, terminalHere, workspaceFor, launchableAgents } = await import("./launch.ts");

function session() {
  const s = emptySession();
  s.workspaces = [
    { workspace_id: "w1", number: 1, label: "demo", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t1", agent_status: "idle" },
    { workspace_id: "w2", number: 2, label: "misc", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "t2", agent_status: "idle" },
  ];
  s.panes = {
    p2: { pane_id: "p2", terminal_id: "x", workspace_id: "w2", tab_id: "t2", focused: false, agent_status: "idle", revision: 0, cwd: "/workspace/other/src" },
  };
  return s;
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ type: "tab_created", root_pane: { pane_id: "new" } });
  useApp.setState({ session: session(), health: { workspaceRoot: "/workspace" } as never });
});

describe("launch", () => {
  it("finds the project a path belongs to", () => {
    expect(projectOf("/workspace/demo/src/a.ts", "/workspace")).toEqual({ name: "demo", path: "/workspace/demo" });
    expect(projectOf("/workspace", "/workspace")).toBeNull();
    expect(projectOf("/home/coder/x", "/workspace")).toBeNull();
  });

  it("finds the project's workspace by name, or by where its panes work", () => {
    const s = session();
    expect(workspaceFor(s, { name: "demo", path: "/workspace/demo" })?.workspace_id).toBe("w1");
    expect(workspaceFor(s, { name: "other", path: "/workspace/other" })?.workspace_id).toBe("w2");
    expect(workspaceFor(s, { name: "new", path: "/workspace/new" })).toBeNull();
  });

  it("opens a tab in the project's workspace", async () => {
    const pane = await terminalHere("/workspace/demo/src");
    expect(call).toHaveBeenCalledWith("tab.create", { workspace_id: "w1", cwd: "/workspace/demo/src", label: "src", focus: true });
    expect(pane).toBe("new");
    expect(window.location.pathname).toBe("/workbench");
  });

  it("makes a workspace for a project that has none", async () => {
    await terminalHere("/workspace/fresh/lib");
    expect(call).toHaveBeenCalledWith("workspace.create", { cwd: "/workspace/fresh/lib", label: "fresh", focus: true });
  });

  it("starts a known agent through herdr, and types an unknown one", async () => {
    await agentHere("/workspace/demo", "claude");
    expect(call).toHaveBeenLastCalledWith("agent.start", { name: "claude", kind: "claude", pane_id: "new" });
    await agentHere("/workspace/demo", "aider");
    expect(call).toHaveBeenLastCalledWith("pane.send_input", { pane_id: "new", text: "aider", keys: ["Enter"] });
  });

  it("runs a command in a new tab", async () => {
    await runHere("/workspace/demo/site", "agentbox-preview static .", "site");
    expect(call).toHaveBeenLastCalledWith("pane.send_input", { pane_id: "new", text: "agentbox-preview static .", keys: ["Enter"] });
  });

  it("does nothing more when the tab could not be made", async () => {
    call.mockResolvedValueOnce(undefined);
    await agentHere("/workspace/demo", "claude");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("offers Claude and Codex first", () => {
    expect(launchableAgents([{ name: "gemini" }, { name: "codex" }, { name: "claude" }])).toEqual(["claude", "codex", "gemini"]);
  });
});
