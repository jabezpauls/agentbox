import { describe, expect, it, vi } from "vitest";
import type { AgentInfo, FileEntry, Project, ReviewSession } from "@workbench/shared";
import { emptySession } from "../store/session.ts";
import type { AppView } from "../apps/model.ts";
import { buildItems, groupItems, type PaletteEffects, type PaletteSources } from "./items.ts";

function fx(): PaletteEffects {
  return {
    navigate: vi.fn(),
    focusPane: vi.fn(),
    focusTab: vi.fn(),
    focusWorkspace: vi.fn(),
    runAction: vi.fn(),
    openApp: vi.fn(),
    openReview: vi.fn(),
    openPort: vi.fn(),
    openInEditor: vi.fn(),
    terminalHere: vi.fn(),
    newProject: vi.fn(),
    setTheme: vi.fn(),
    toggleDock: vi.fn(),
    showDock: vi.fn(),
    keymap: vi.fn(),
    signOut: vi.fn(),
  };
}

function sources(): PaletteSources {
  const session = emptySession();
  session.workspaces = [{ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t1", agent_status: "working" }];
  session.tabs = [{ tab_id: "t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "working" }];
  const agent: AgentInfo = {
    pane_id: "p1",
    terminal_id: "x",
    workspace_id: "w1",
    tab_id: "t1",
    focused: true,
    agent_status: "blocked",
    agent: "claude",
    terminal_title_stripped: "claude",
    revision: 0,
    interactive_ready: true,
    launch_pending: false,
    cwd: "/workspace/api",
  };
  session.agents = { p1: agent };
  session.panes = { p1: agent };
  const projects: Project[] = Array.from({ length: 9 }, (_, i) => ({
    name: `proj${i}`,
    path: `/workspace/proj${i}`,
    git: null,
    lastChange: 0,
    agents: [],
    listeners: [],
  }));
  const apps = [
    {
      id: "goofy",
      name: "goofy",
      port: 5173,
      url: "/a/goofy/",
      live: { listening: true },
    } as unknown as AppView,
  ];
  const reviews: ReviewSession[] = [
    { key: "aaaa0000", label: "Rollout plan", file: "", created: "", updated: "", status: "open", pending: 0 },
    { key: "bbbb0000", label: "Old plan", file: "", created: "", updated: "", status: "ended", pending: 0 },
  ];
  return { session, projects, apps, reviews, files: null, workspaceRoot: "/workspace" };
}

const kinds = (items: { kind: string }[]) => [...new Set(items.map((i) => i.kind))];

describe("buildItems", () => {
  it("offers every kind with nothing typed, a few of each", () => {
    const items = buildItems(sources(), fx(), "all", "");
    expect(kinds(items)).toEqual(expect.arrayContaining(["workspace", "surface", "agent", "project", "app", "review", "action"]));
    // Tabs and panes wait for a query; projects are capped.
    expect(items.some((i) => i.kind === "tab")).toBe(false);
    expect(items.filter((i) => i.kind === "project")).toHaveLength(6);
    // Only open reviews.
    expect(items.filter((i) => i.kind === "review").map((i) => i.label)).toEqual(["Rollout plan"]);
  });

  it("finds a project, a surface and a command by name", () => {
    const items = buildItems(sources(), fx(), "all", "proj8");
    expect(items[0]).toMatchObject({ kind: "project", label: "proj8" });
    expect(buildItems(sources(), fx(), "all", "files")[0]).toMatchObject({ kind: "surface", label: "Files" });
    expect(buildItems(sources(), fx(), "all", "new proj")[0]).toMatchObject({ label: "New project" });
  });

  it("finds by keyword, below a label match", () => {
    const items = buildItems(sources(), fx(), "all", "preview");
    expect(items.map((i) => i.label)).toContain("goofy");
    expect(items[0]!.label).toBe("Show Preview");
  });

  it("turns a number into a port to preview, and a path into a folder to open", () => {
    const f = fx();
    const byPort = buildItems(sources(), f, "all", "5173");
    expect(byPort[0]!.label).toBe("Preview port 5173");
    byPort[0]!.run();
    expect(f.openPort).toHaveBeenCalledWith(5173);

    const byPath = buildItems(sources(), f, "all", "/workspace/api/src/");
    expect(byPath[0]!.label).toBe("Open /workspace/api/src in Files");
    byPath[0]!.run();
    expect(f.navigate).toHaveBeenCalledWith({ surface: "files", path: "/workspace/api/src" });
  });

  it("puts the box's file-name results after what matched here", () => {
    const src = sources();
    const hit: FileEntry = { name: "server.ts", path: "/workspace/api/src/server.ts", type: "file", size: 1, mtime: 0 };
    src.files = [hit];
    const items = buildItems(src, fx(), "all", "server");
    const file = items.find((i) => i.kind === "file")!;
    expect(file).toMatchObject({ label: "server.ts", sub: "api/src/server.ts" });
  });

  it("does what each kind says", () => {
    const f = fx();
    const items = buildItems(sources(), f, "all", "claude");
    items.find((i) => i.kind === "agent")!.run();
    expect(f.focusPane).toHaveBeenCalledWith("p1");
    buildItems(sources(), f, "all", "goofy").find((i) => i.kind === "app")!.run();
    expect(f.openApp).toHaveBeenCalled();
    buildItems(sources(), f, "all", "rollout").find((i) => i.kind === "review")!.run();
    expect(f.openReview).toHaveBeenCalledWith("aaaa0000");
  });

  it("lists only workspaces in workspace mode", () => {
    expect(kinds(buildItems(sources(), fx(), "workspaces", ""))).toEqual(["workspace"]);
  });
});

describe("groupItems", () => {
  it("groups in the order each kind's best match came, keeping the ranking inside", () => {
    const items = buildItems(sources(), fx(), "all", "proj8");
    const groups = groupItems(items);
    expect(groups[0]!.kind).toBe("project");
    expect(groups.flatMap((g) => g.items)).toHaveLength(items.length);
  });
});
