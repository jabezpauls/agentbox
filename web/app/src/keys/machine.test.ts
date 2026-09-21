import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/client.ts", () => ({ rpc, RpcError: class extends Error {} }));

import { useApp } from "../store/app.ts";
import { emptySession, type Session } from "../store/session.ts";
import { feedGlobal, isTextEntry } from "./machine.ts";

function key(init: KeyboardEventInit & { target?: HTMLElement }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  if (init.target) Object.defineProperty(e, "target", { value: init.target });
  return e;
}

function seed(): void {
  const session: Session = {
    ...emptySession(),
    workspaces: [{ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t1", agent_status: "unknown" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 1, agent_status: "unknown" }],
    focusedWorkspaceId: "w1",
    focusedTabId: "t1",
  };
  useApp.setState({ session, ui: { ...useApp.getState().ui, palette: null, dialog: null, sidebarOpen: true } });
}

beforeEach(() => {
  rpc.mockClear();
  // Disarm any state a previous test left behind.
  feedGlobal(key({ key: "Escape" }));
  seed();
});

describe("feedGlobal", () => {
  it("runs a binding with no terminal focused, so prefix+q does not end the keymap", () => {
    expect(feedGlobal(key({ key: "b", ctrlKey: true }))).toBe(true);
    expect(feedGlobal(key({ key: "c" }))).toBe(true);
    expect(rpc).toHaveBeenCalledWith("tab.create", { workspace_id: "w1", focus: true });
  });

  it("swallows the consumed follow-up rather than letting the page see it", () => {
    feedGlobal(key({ key: "b", ctrlKey: true }));
    const e = key({ key: "b" });
    feedGlobal(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores an unarmed keystroke so ordinary typing is untouched", () => {
    const e = key({ key: "c" });
    expect(feedGlobal(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps out of text fields, including xterm's hidden helper textarea", () => {
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    expect(feedGlobal(key({ key: "b", ctrlKey: true, target: textarea }))).toBe(false);
  });

  it("stands down while the palette or a dialog owns the keyboard", () => {
    useApp.setState({ ui: { ...useApp.getState().ui, palette: { mode: "all" } } });
    expect(feedGlobal(key({ key: "b", ctrlKey: true }))).toBe(false);

    useApp.setState({ ui: { ...useApp.getState().ui, palette: null, dialog: { kind: "keymap" } } });
    expect(feedGlobal(key({ key: "b", ctrlKey: true }))).toBe(false);
  });

  it("mirrors the armed state into the store for the HUD pill", () => {
    feedGlobal(key({ key: "b", ctrlKey: true }));
    expect(useApp.getState().ui.prefixArmed).toBe(true);
    feedGlobal(key({ key: "c" }));
    expect(useApp.getState().ui.prefixArmed).toBe(false);
  });
});

describe("isTextEntry", () => {
  it("recognises the elements that must keep their own keystrokes", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTextEntry(document.createElement(tag))).toBe(true);
    }
    const div = document.createElement("div");
    expect(isTextEntry(div)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
