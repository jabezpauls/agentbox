import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../store/app.ts";

import { PreviewPanel } from "./PreviewPanel.tsx";

const open = vi.fn();

afterEach(() => vi.unstubAllGlobals());

// A probe HEAD that reports the port as ready, so the iframe mounts. Individual
// tests override `fetch` when they need a share list or a mint response.
function readyProbe(): Response {
  return { status: 200, headers: new Headers() } as Response;
}

// The panel is served on the Workbench route; the proxy it opens sits at the
// root of the origin regardless.
function setup(previewDomain: string | null, previewSharing = false): void {
  open.mockClear();
  vi.stubGlobal("open", open);

  vi.stubGlobal("location", { pathname: "/workbench", protocol: "http:", host: "box.example" } as Location);
  act(() => {
    useApp.setState({
      ports: [{ port: 3000, pid: 42, process: "node", system: false, address: "127.0.0.1" }],
      health: {
        ok: true,
        herdr: { connected: true, version: "0.9.1", protocol: 1 },
        workspaceRoot: "/workspace",
        previewDomain,
        previewSharing,
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

    expect(open).toHaveBeenCalledWith("/preview/3000/", "_blank", "noopener,noreferrer");
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
    vi.stubGlobal("location", { pathname: "/workbench", protocol: "http:", host: "box.example" } as Location);
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

const SHARE = {
  id: "abc123abc123",
  token: "f".repeat(32),
  port: 3000,
  created: new Date().toISOString(),
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  url: "http://box.example/s/" + "f".repeat(32) + "/",
};

/** Route the panel's calls: probe HEAD, the share list, and mint/revoke. */
function shareFetch(shares: typeof SHARE[]): ReturnType<typeof vi.fn> {
  const state = { shares };
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/preview/3000/")) return readyProbe();
    if (url.endsWith("/api/preview/shares") && method === "GET") {
      return { ok: true, status: 200, json: async () => state.shares } as Response;
    }
    if (url.endsWith("/api/preview/shares") && method === "POST") {
      state.shares = [SHARE];
      return { ok: true, status: 200, json: async () => SHARE } as Response;
    }
    if (url.includes("/api/preview/shares/") && method === "DELETE") {
      state.shares = [];
      return { ok: true, status: 204 } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

describe("sharing a preview", () => {

  it("hides the Share action when sharing is disabled", async () => {
    setup(null, false);
    vi.stubGlobal("fetch", shareFetch([]));
    render(<PreviewPanel />);
    // Let the probe settle so nothing updates after the test ends.
    await screen.findByTitle("Preview on port 3000");
    expect(screen.queryByRole("button", { name: "Share this port" })).not.toBeInTheDocument();
  });

  it("mints a share and shows the public banner, link and revoke", async () => {
    setup(null, true);
    vi.stubGlobal("fetch", shareFetch([]));
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "Share this port" }));

    expect(await screen.findByText(/anyone with this link can view/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Public link")).toHaveValue(SHARE.url);
    expect(screen.getByRole("button", { name: /Revoke/ })).toBeInTheDocument();
  });

  it("revokes a share and drops the banner", async () => {
    setup(null, true);
    vi.stubGlobal("fetch", shareFetch([SHARE]));
    const user = userEvent.setup();
    render(<PreviewPanel />);

    expect(await screen.findByText(/anyone with this link can view/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Revoke/ }));

    await waitFor(() =>
      expect(screen.queryByText(/anyone with this link can view/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Share this port" })).toBeInTheDocument();
  });

  it("opens a shared preview full screen at its public link", async () => {
    setup(null, true);
    vi.stubGlobal("fetch", shareFetch([SHARE]));
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await screen.findByText(/anyone with this link can view/i);
    await user.click(screen.getByRole("button", { name: "Open full screen" }));
    // Same-origin top-level still warns; confirming opens the /s/ link.
    await user.click(screen.getByRole("button", { name: "Open anyway" }));

    expect(open).toHaveBeenCalledWith(SHARE.url, "_blank", "noopener,noreferrer");
  });
});

describe("guarding a shared preview", () => {
  it("still asks before opening a share full screen when a preview domain is set", async () => {
    setup("previews.example.com", true);
    vi.stubGlobal("fetch", shareFetch([SHARE]));
    const user = userEvent.setup();
    render(<PreviewPanel />);

    await screen.findByText(/anyone with this link can view/i);
    await user.click(screen.getByRole("button", { name: "Open full screen" }));

    // The /s/ link is on the box's own address whatever the preview domain.
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /open the public link/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open anyway" }));
    expect(open).toHaveBeenCalledWith(SHARE.url, "_blank", "noopener,noreferrer");
  });

  it("offers no Share action on one of agentbox's own ports", async () => {
    setup(null, true);
    vi.stubGlobal("fetch", shareFetch([]));
    act(() => {
      useApp.setState({
        ports: [{ port: 3000, pid: 1, process: "code-server", system: true, address: "0.0.0.0" }],
      });
    });
    render(<PreviewPanel />);
    await screen.findByTitle("Preview on port 3000");
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringMatching(/api\/preview\/shares$/), expect.anything()));
    expect(screen.queryByRole("button", { name: "Share this port" })).not.toBeInTheDocument();
  });
});

describe("probing the port", () => {
  function probeWith(headers: Record<string, string>, status = 200): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({ status, ok: status < 400, headers: new Headers(headers) }) as Response);
  }

  it("shows the not-serving state, not a frame, when the bridge marks the port down", async () => {
    setup(null);
    vi.stubGlobal("fetch", probeWith({ "x-preview-upstream": "down" }, 502));
    render(<PreviewPanel />);
    expect(await screen.findByText(/Nothing is serving on port 3000 yet/)).toBeInTheDocument();
    expect(screen.queryByTitle("Preview on port 3000")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("mounts the frame for an app's own error status, so its error page shows", async () => {
    setup(null);
    vi.stubGlobal("fetch", probeWith({}, 503));
    render(<PreviewPanel />);
    expect(await screen.findByTitle("Preview on port 3000")).toBeInTheDocument();
  });

  it("mounts the frame for a live port", async () => {
    setup(null);
    vi.stubGlobal("fetch", probeWith({}));
    render(<PreviewPanel />);
    expect(await screen.findByTitle("Preview on port 3000")).toBeInTheDocument();
  });
});
