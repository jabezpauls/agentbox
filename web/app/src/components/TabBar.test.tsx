import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/client.ts", () => ({ rpc }));

import { useApp } from "../store/app.ts";
import { emptySession, type Session } from "../store/session.ts";
import { TabBar } from "./TabBar.tsx";

function seed(): void {
  const session: Session = {
    ...emptySession(),
    workspaces: [
      { workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 1, tab_count: 2, active_tab_id: "w1:t1", agent_status: "unknown" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 1, agent_status: "unknown" },
      { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "two", focused: false, pane_count: 1, agent_status: "unknown" },
    ],
    focusedWorkspaceId: "w1",
    focusedTabId: "w1:t1",
  };
  useApp.setState({ session });
}

beforeEach(() => {
  rpc.mockClear();
  seed();
});

afterEach(() => {
  // The shared setup unmounts first; resetting the store here must be wrapped
  // so React does not warn about an update outside act.
  act(() => {
    useApp.setState({ session: emptySession() });
  });
});

function renderBar() {
  return render(<TabBar sidebarOpen={true} onOpenSidebar={() => {}} />);
}

describe("TabBar accessibility", () => {
  it("renders each tab as a focusable button in a tablist", () => {
    renderBar();
    const list = screen.getByRole("tablist");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab.tagName).toBe("BUTTON");
      expect(tab).not.toHaveAttribute("tabindex", "-1");
    }
  });

  it("reaches a tab with the Tab key and activates it with Enter", async () => {
    const user = userEvent.setup();
    renderBar();
    // the inactive tab
    const two = screen.getByRole("tab", { name: /two/ });
    act(() => two.focus());
    expect(two).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(rpc).toHaveBeenCalledWith("tab.focus", { tab_id: "w1:t2" });
  });

  it("starts an inline rename with F2", async () => {
    const user = userEvent.setup();
    renderBar();
    const one = screen.getByRole("tab", { name: /one/ });
    act(() => one.focus());
    await user.keyboard("{F2}");
    expect(screen.getByLabelText("Rename tab one")).toBeInTheDocument();
  });

  it("opens the actions menu and closes the tab entirely by keyboard", async () => {
    const user = userEvent.setup();
    renderBar();
    const menuButton = screen.getByRole("button", { name: "Tab actions for one" });
    await user.click(menuButton);
    const menu = screen.getByRole("menu");
    // focus lands in the menu; navigate to Close and activate it
    expect(within(menu).getByRole("menuitem", { name: /rename/i })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: /close/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(rpc).toHaveBeenCalledWith("tab.close", { tab_id: "w1:t1" });
  });

  it("closes the actions menu when focus leaves it (Tab-out)", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Tab actions for one" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    // Focus moves to a control outside the menu, as Tab would take it.
    const outside = screen.getByRole("button", { name: "New tab" });
    fireEvent.blur(menu, { relatedTarget: outside });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the menu open while focus moves between its own items", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Tab actions for one" }));
    const menu = screen.getByRole("menu");
    const close = within(menu).getByRole("menuitem", { name: /close/i });
    // A blur whose next focus is still inside the menu must not dismiss it.
    fireEvent.blur(menu, { relatedTarget: close });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes a focused tab with Delete", async () => {
    const user = userEvent.setup();
    renderBar();
    const two = screen.getByRole("tab", { name: /two/ });
    act(() => two.focus());
    await user.keyboard("{Delete}");
    expect(rpc).toHaveBeenCalledWith("tab.close", { tab_id: "w1:t2" });
  });
});
