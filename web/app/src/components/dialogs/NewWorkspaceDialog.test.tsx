import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, listDirs } = vi.hoisted(() => ({
  rpc: vi.fn(() => Promise.resolve()),
  listDirs: vi.fn(),
}));
vi.mock("../../api/client.ts", () => ({ rpc, listDirs, RpcError: class extends Error {} }));

import { useApp } from "../../store/app.ts";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.tsx";

beforeEach(() => {
  rpc.mockClear();
  listDirs.mockImplementation((rel: string) =>
    Promise.resolve(rel === "" ? [{ name: "api", path: "api" }] : [{ name: "src", path: "api/src" }]),
  );
  act(() => {
    useApp.setState({
      health: { ok: true, herdr: { connected: true, version: "0.9.1", protocol: 1 }, workspaceRoot: "/workspace", sharing: false },
      ui: { ...useApp.getState().ui, dialog: { kind: "workspace.new" } },
    });
  });
});

afterEach(() => {
  act(() => {
    useApp.setState({ ui: { ...useApp.getState().ui, dialog: null } });
  });
});

describe("the directory picker", () => {
  it("descends into a folder from the keyboard, without a double-click", async () => {
    const user = userEvent.setup();
    render(<NewWorkspaceDialog />);

    const row = await screen.findByRole("button", { name: /api/ });
    row.focus();
    await user.keyboard("{Enter}");

    // Enter activated the row instead of submitting the dialog: we descended
    // and the dialog is still open, now listing the child folder.
    expect(await screen.findByRole("button", { name: /src/ })).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
    expect(useApp.getState().ui.dialog).not.toBeNull();
  });

  it("offers the current folder as a real button that creates the workspace", async () => {
    const user = userEvent.setup();
    render(<NewWorkspaceDialog />);

    const use = await screen.findByRole("button", { name: /use this folder/i });
    await user.click(use);

    expect(rpc).toHaveBeenCalledWith("workspace.create", expect.objectContaining({ cwd: "/workspace" }));
    expect(useApp.getState().ui.dialog).toBeNull();
  });

  it("still submits on Enter from a text field", async () => {
    const user = userEvent.setup();
    render(<NewWorkspaceDialog />);

    await screen.findByRole("button", { name: /api/ });
    await user.click(screen.getByLabelText("Workspace label"));
    await user.keyboard("build{Enter}");

    expect(rpc).toHaveBeenCalledWith("workspace.create", expect.objectContaining({ label: "build" }));
  });
});
