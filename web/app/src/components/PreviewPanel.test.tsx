import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store/app.ts";
import { PreviewPanel } from "./PreviewPanel.tsx";

const open = vi.fn();

// The app derives every URL from the current location, so the panel only
// produces the real `/workbench` prefix under a matching pathname.
function setup(previewDomain: string | null): void {
  open.mockClear();
  vi.stubGlobal("open", open);
  vi.stubGlobal("location", { pathname: "/workbench/", protocol: "http:", host: "box.example" } as Location);
  act(() => {
    useApp.setState({
      ports: [{ port: 3000, pid: 42, process: "node", system: false, address: "127.0.0.1" }],
      health: {
        ok: true,
        herdr: { connected: true, version: "0.9.1", protocol: 1 },
        workspaceRoot: "/workspace",
        previewDomain,
      },
      ui: {
        ...useApp.getState().ui,
        inspector: { ...useApp.getState().ui.inspector, port: 3000, path: "/" },
      },
    });
  });
}

describe("opening a preview full screen", () => {
  beforeEach(() => setup(null));
  afterEach(() => vi.unstubAllGlobals());

  it("asks before handing a path preview the Workbench's own origin", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "Open full screen" }));

    // A top-level window has no sandbox, so the page would be same-origin with
    // the Workbench: nothing may open until the user agrees to that.
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /outside the sandbox/i })).toBeInTheDocument();
    expect(screen.getByText(/written by an agent/i)).toBeInTheDocument();
  });

  it("opens the preview once the warning is confirmed", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "Open full screen" }));
    await user.click(screen.getByRole("button", { name: "Open anyway" }));

    expect(open).toHaveBeenCalledWith("/workbench/preview/3000/", "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens nothing when the warning is dismissed", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "Open full screen" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says it couldn't read ports, not that none are listening, when /proc was unreadable", () => {
    vi.stubGlobal("location", { pathname: "/workbench/", protocol: "http:", host: "box.example" } as Location);
    act(() => {
      useApp.setState({
        ports: [],
        portsReadable: false,
        ui: { ...useApp.getState().ui, inspector: { ...useApp.getState().ui.inspector, port: null } },
      });
    });
    render(<PreviewPanel />);
    expect(screen.getByText(/Couldn't read ports\./)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is listening\./)).not.toBeInTheDocument();
  });

  it("does not ask when a preview domain puts the page on its own origin", async () => {
    setup("previews.example.com");
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "Open full screen" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledWith(
      "https://3000.previews.example.com/",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
