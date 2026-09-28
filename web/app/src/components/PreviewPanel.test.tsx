import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppView } from "@workbench/shared";

import { useApp } from "../store/app.ts";

import { APP_FRAME_SANDBOX, PreviewPanel, expiryLabel } from "./PreviewPanel.tsx";

const ID = "abcdefghijklmnopqrstuvwxyz";
const open = vi.fn();

function appView(over: Partial<AppView> = {}): AppView {
  return {
    id: ID,
    name: "goofy",
    port: 5173,
    keepPrefix: false,
    pinned: false,
    createdBy: "agent",
    createdAt: 1,
    visibility: { mode: "private", expiresAt: null },
    compat: "auto",
    url: `/a/${ID}/`,
    live: { listening: true, pid: 42, process: "node", cwd: "/workspace/goofy", paneId: null, tabId: null, workspaceId: null },
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Route the panel's calls: the probe of the app, the app list, and the gate's
 * sharing API. `down` makes the probe say nothing is serving; `hint` adds the
 * gate's path hint.
 */
function routes(opts: { app?: AppView; down?: boolean; hint?: boolean; shareStatus?: number } = {}) {
  const calls: Call[] = [];
  let current = opts.app ?? appView();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const json = (status: number, data: unknown) =>
      ({ ok: status < 400, status, headers: new Headers(), text: async () => JSON.stringify(data), json: async () => data }) as Response;
    if (url.startsWith(`/a/${ID}/`)) {
      const headers = new Headers();
      if (opts.down) headers.set("x-preview-upstream", "down");
      if (opts.hint) headers.set("x-agentbox-hint", "root-absolute");
      return { ok: true, status: opts.down ? 502 : 200, headers } as Response;
    }
    if (url === "/api/apps") return json(200, [current]);
    if (url === `/_gate/apps/${ID}/visibility` && method === "PUT") {
      if (opts.shareStatus) return json(opts.shareStatus, { error: "sharing_off", message: "sharing is turned off on this box" });
      current = { ...current, visibility: { mode: body.mode, expiresAt: body.expiresIn === null ? null : Date.now() + body.expiresIn * 1000 } };
      return json(200, current);
    }
    if (url === `/_gate/apps/${ID}/visibility` && method === "DELETE") {
      current = { ...current, visibility: { mode: "private", expiresAt: null } };
      return json(200, current);
    }
    if (url === `/api/apps/${ID}` && method === "PATCH") {
      current = { ...current, ...body };
      return json(200, current);
    }
    if (url === "/_gate/apps" && method === "POST") return json(201, appView({ id: "zzzzzzzzzzzzzzzzzzzzzzzzzz", port: body.port }));
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function setup(opts: { apps?: AppView[]; sharing?: boolean; selected?: string | null; ports?: AppView["port"][] } = {}): void {
  open.mockClear();
  vi.stubGlobal("open", open);
  vi.stubGlobal("location", { pathname: "/workbench", protocol: "https:", host: "box.example", origin: "https://box.example" } as Location);
  act(() => {
    useApp.setState({
      apps: opts.apps ?? [appView()],
      ports: (opts.ports ?? [5173]).map((port) => ({ port, pid: 42, process: "node", system: false, address: "127.0.0.1" })),
      portsReadable: true,
      health: { ok: true, herdr: { connected: true, version: "0.9.1", protocol: 1 }, workspaceRoot: "/workspace", sharing: opts.sharing ?? false },
      ui: {
        ...useApp.getState().ui,
        previewAppId: opts.selected === undefined ? ID : opts.selected,
        inspector: { ...useApp.getState().ui.inspector, path: "/", device: "auto" },
      },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("showing an app", () => {
  beforeEach(() => setup());

  it("frames the app's own URL, sandboxed without its origin", async () => {
    routes();
    render(<PreviewPanel />);
    const frame = await screen.findByTitle("Preview of goofy");
    expect(frame).toHaveAttribute("src", `/a/${ID}/`);
    expect(frame.getAttribute("sandbox")).toBe(APP_FRAME_SANDBOX);
    expect(APP_FRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("opens full screen at the same URL, with no warning: the gate sandboxes it there too", async () => {
    routes();
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "Open full screen" }));
    expect(open).toHaveBeenCalledWith(`/a/${ID}/`, "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("follows the path bar within the app", async () => {
    routes();
    const user = userEvent.setup();
    render(<PreviewPanel />);
    const bar = screen.getByLabelText("Path");
    await user.clear(bar);
    await user.type(bar, "about?x=1{Enter}");
    expect(useApp.getState().ui.inspector.path).toBe("/about?x=1");
    expect(await screen.findByTitle("Preview of goofy")).toHaveAttribute("src", `/a/${ID}/about?x=1`);
  });

  it("shows the not-serving state, and offers to start an app that has a command", async () => {
    setup({ apps: [appView({ command: "npm run dev", cwd: "/workspace/goofy" })] });
    routes({ down: true });
    render(<PreviewPanel />);
    expect(await screen.findByText(/Nothing is serving on port 5173 yet/)).toBeInTheDocument();
    expect(screen.queryByTitle("Preview of goofy")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start it/ })).toBeInTheDocument();
  });

  it("says when the app assumes it runs at /, with the base path to copy", async () => {
    routes({ hint: true });
    render(<PreviewPanel />);
    expect(await screen.findByText(/This app assumes it runs at/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the base path" })).toBeInTheDocument();
  });
});

describe("the picker", () => {
  it("lists apps and, apart, what else is listening", async () => {
    setup({ selected: null, ports: [5173, 3000] });
    routes();
    render(<PreviewPanel />);
    expect(screen.getByRole("list", { name: "Apps" })).toHaveTextContent("goofy");
    expect(screen.getByRole("list", { name: "Also listening" })).toHaveTextContent(":3000");
    expect(screen.getByRole("list", { name: "Also listening" })).not.toHaveTextContent(":5173");
    expect(screen.getByText("No app picked.")).toBeInTheDocument();
  });

  it("makes an app of a port when it is chosen, as the owner", async () => {
    setup({ selected: null, ports: [5173, 3000] });
    const { calls } = routes();
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: /:3000/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/_gate/apps" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url === "/_gate/apps")?.body).toEqual({ port: 3000 });
  });

  it("says nothing is running yet when there is nothing at all", () => {
    setup({ apps: [], selected: null, ports: [] });
    routes();
    render(<PreviewPanel />);
    expect(screen.getByText("Nothing is running yet.")).toBeInTheDocument();
  });
});

describe("sharing", () => {
  it("offers no Share when the box has sharing off", async () => {
    setup({ sharing: false });
    routes();
    render(<PreviewPanel />);
    await screen.findByTitle("Preview of goofy");
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  it("shares with the link for the chosen time, and copies the link", async () => {
    setup({ sharing: true });
    const { calls } = routes();
    // user-event puts a clipboard of its own in place; read the link back from it.
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByLabelText("Link")).toHaveValue(`https://box.example/a/${ID}/`);
    await user.selectOptions(screen.getByLabelText("How long"), "1 day");
    await user.click(screen.getByRole("button", { name: "Share and copy link" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "link", expiresIn: 86400 });
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(`https://box.example/a/${ID}/`));
  });

  it("needs a passcode to share with one, and sends it to the gate", async () => {
    setup({ sharing: true });
    const { calls } = routes();
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(screen.getByLabelText(/Link and a passcode/));
    const go = screen.getByRole("button", { name: "Share and copy link" });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText("Passcode"), "open sesame");
    await user.selectOptions(screen.getByLabelText("How long"), "Until I stop sharing");
    await user.click(go);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ mode: "passcode", expiresIn: null, passcode: "open sesame" }));
  });

  it("shows a shared app's banner, and stops sharing", async () => {
    setup({ sharing: true, apps: [appView({ visibility: { mode: "link", expiresAt: Date.now() + 3 * 86400_000 } })] });
    const { calls } = routes({ app: appView({ visibility: { mode: "link", expiresAt: Date.now() + 3 * 86400_000 } }) });
    const user = userEvent.setup();
    render(<PreviewPanel />);
    expect(screen.getByText(/anyone with the link can open it/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: /Stop sharing/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/_gate/apps/${ID}/visibility`)).toBe(true));
    await waitFor(() => expect(screen.queryByText(/anyone with the link can open it/i)).not.toBeInTheDocument());
  });

  it("says why when the gate refuses", async () => {
    setup({ sharing: true });
    routes({ shareStatus: 403 });
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(screen.getByRole("button", { name: "Share and copy link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("sharing is turned off on this box");
  });
});

describe("about an app", () => {
  it("switches the path fixes, and says how to open it on your machine", async () => {
    setup();
    const { calls } = routes();
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "About this app" }));
    expect(screen.getByLabelText("Command")).toHaveValue("agentbox forward 5173");
    await user.click(screen.getByRole("checkbox", { name: /Path fixes/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ compat: "off" }));
  });
});

describe("expiry labels", () => {
  it("say how long is left", () => {
    const now = 1_000_000;
    expect(expiryLabel(null, now)).toBe("until you stop sharing");
    expect(expiryLabel(now - 1, now)).toBe("expired");
    expect(expiryLabel(now + 5 * 86400_000, now)).toBe("for 5 more days");
    expect(expiryLabel(now + 3 * 3600_000, now)).toBe("for 3 more hours");
    expect(expiryLabel(now + 90_000, now)).toBe("for 2 more minutes");
  });
});

describe("the store", () => {
  it("opens an app in Preview, and toasts who asked when an agent does", () => {
    routes();
    act(() => {
      useApp.setState({ toasts: [], ui: { ...useApp.getState().ui, previewAppId: null, inspector: { ...useApp.getState().ui.inspector, open: false } } });
      useApp.getState().applyMessage({ kind: "app.open", id: ID, name: "goofy", by: "claude", path: "/x" });
    });
    const s = useApp.getState();
    expect(s.ui.previewAppId).toBe(ID);
    expect(s.ui.inspector).toMatchObject({ open: true, tab: "preview", path: "/x" });
    expect(s.toasts.at(-1)).toMatchObject({ kind: "app", appId: ID, title: "claude opened goofy in Preview" });
  });

  it("reads the apps again when they change", async () => {
    const { fetchMock } = routes();
    act(() => useApp.setState({ apps: [] }));
    act(() => useApp.getState().applyMessage({ kind: "apps.changed" }));
    await waitFor(() => expect(useApp.getState().apps).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything());
  });
});
