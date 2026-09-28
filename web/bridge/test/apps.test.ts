import { describe, expect, it } from "vitest";
import type { App, EventsMessage, ListeningPort, SessionSnapshot } from "@workbench/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { BridgeEvents } from "../src/events.js";
import { GateError, type AppFields, type GateApps, type WatchResult } from "../src/apps/gate.js";
import { APPS_WORKSPACE, AppsService, cleanBy } from "../src/apps/service.js";
import type { SessionHub } from "../src/herdr/session.js";

/** The gate's sandbox-side API, in memory, as strict about ports as the real one. */
class FakeGate implements GateApps {
  apps: App[] = [];
  revision = 0;
  sharing = true;
  private waiters: Array<() => void> = [];
  private n = 0;

  private bump(): void {
    this.revision += 1;
    for (const w of this.waiters.splice(0)) w();
  }
  async list() {
    return structuredClone(this.apps);
  }
  async get(id: string) {
    return structuredClone(this.apps.find((a) => a.id === id) ?? null);
  }
  async create(f: AppFields) {
    if (f.port === 7800) throw new GateError(400, { error: "infrastructure_port", message: "port 7800 belongs to agentbox itself" });
    const app: App = {
      id: `app${String(++this.n).padStart(23, "a")}`,
      name: f.name ?? `port ${f.port}`,
      port: f.port as number,
      keepPrefix: f.keepPrefix ?? false,
      ...(f.cwd ? { cwd: f.cwd } : {}),
      ...(f.command ? { command: f.command } : {}),
      pinned: f.pinned ?? false,
      createdBy: "agent",
      createdAt: 1,
      visibility: { mode: "private", expiresAt: null },
      compat: "auto",
    };
    this.apps.push(app);
    this.bump();
    return structuredClone(app);
  }
  async update(id: string, f: AppFields) {
    const app = this.apps.find((a) => a.id === id);
    if (!app) throw new GateError(404, { error: "no such app" });
    Object.assign(app, f);
    this.bump();
    return structuredClone(app);
  }
  async remove(id: string) {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.id !== id);
    if (this.apps.length !== before) this.bump();
    return this.apps.length !== before;
  }
  async watch(since: number, waitMs: number, signal?: AbortSignal): Promise<WatchResult> {
    if (since === this.revision) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(waitMs, 200));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
        signal?.addEventListener("abort", () => r());
      });
    }
    return { revision: this.revision, sharing: this.sharing };
  }
}

interface Rig {
  gate: FakeGate;
  apps: AppsService;
  events: EventsMessage[];
  herdr: Array<[string, Record<string, unknown>]>;
  ports: ListeningPort[];
  kills: Array<[number, string]>;
  snap: SessionSnapshot;
}

function rig(opts: { environ?: Record<number, Record<string, string>> } = {}): Rig {
  const gate = new FakeGate();
  const bus = new BridgeEvents();
  const events: EventsMessage[] = [];
  bus.on((m) => events.push(m));
  const herdr: Rig["herdr"] = [];
  const kills: Rig["kills"] = [];
  const r: Rig = {
    gate,
    events,
    herdr,
    kills,
    ports: [],
    snap: {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w1", number: 1, label: "goofy", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }],
      tabs: [],
      panes: [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "working", agent: "claude", revision: 1 }],
      layouts: [],
      agents: [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "working", agent: "claude", display_agent: "claude", revision: 1, interactive_ready: true, launch_pending: false }],
    },
    apps: undefined as unknown as AppsService,
  };
  let tabs = 0;
  r.apps = new AppsService({
    gate,
    events: bus,
    scanPorts: async () => r.ports,
    snapshot: async () => r.snap,
    herdr: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      herdr.push([method, params]);
      if (method === "workspace.create") {
        r.snap.workspaces.push({ workspace_id: "w9", number: 9, label: String(params.label), focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w9:t1", agent_status: "unknown" });
        return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } } as T;
      }
      if (method === "tab.create") {
        tabs += 1;
        const ws = String(params.workspace_id);
        return { tab: { tab_id: `${ws}:t${tabs + 1}` }, root_pane: { pane_id: `${ws}:p${tabs + 1}`, workspace_id: ws } } as T;
      }
      if (method === "pane.read") return { text: "vite ready" } as T;
      return {} as T;
    },
    herdrReady: () => true,
    environ: async (pid) => opts.environ?.[pid] ?? null,
    processTree: async (pid) => [pid, pid + 1],
    kill: (pid, sig) => kills.push([pid, sig]),
    stopGraceMs: 300,
  });
  return r;
}

const listening = (port: number, pid = 4242): ListeningPort => ({ port, pid, process: "node", system: false, address: "127.0.0.1", cwd: "/workspace/goofy" });

describe("apps with their live state", () => {
  it("say what is listening, and in which herdr pane", async () => {
    const r = rig({ environ: { 4242: { HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" } } });
    r.ports = [listening(5173)];
    const up = await r.apps.create({ port: 5173, name: "goofy" });
    await r.apps.create({ port: 5174, name: "down" });
    const views = await r.apps.views();
    expect(views.find((v) => v.id === up.id)).toMatchObject({
      url: `/a/${up.id}/`,
      live: { listening: true, pid: 4242, process: "node", cwd: "/workspace/goofy", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    });
    expect(views.find((v) => v.name === "down")?.live).toMatchObject({ listening: false, pid: null, paneId: null });
  });
});

describe("opening an app in every tab's Preview", () => {
  it("names the agent in the pane that asked", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173, name: "goofy" });
    await r.apps.open(app.id, { paneId: "w1:p1", path: "/about" });
    expect(r.events.at(-1)).toEqual({ kind: "app.open", id: app.id, name: "goofy", by: "claude", path: "/about" });
    await r.apps.open(app.id, { by: "codex\n" });
    expect(r.events.at(-1)).toMatchObject({ by: "codex" });
    await r.apps.open(app.id, {});
    expect(r.events.at(-1)).toMatchObject({ by: "agentbox-preview" });
    await expect(r.apps.open("nope")).rejects.toThrow("no such app");
  });

  it("keeps who asked to one plain line", () => {
    expect(cleanBy("  claude  ")).toBe("claude");
    expect(cleanBy("a\u0000b")).toBe("ab");
    expect(cleanBy("x".repeat(80))).toHaveLength(40);
    expect(cleanBy("")).toBeNull();
    expect(cleanBy(3)).toBeNull();
  });
});

describe("launching an app's command", () => {
  it("runs it in a tab of its own in the workspace asked for, with its port and base path", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173, name: "goofy", cwd: "/workspace/goofy", command: "npm run dev -- --port 5173" });
    const at = await r.apps.launch(app.id, { workspaceId: "w1" });
    expect(at.workspaceId).toBe("w1");
    const [create, run] = r.herdr;
    expect(create).toEqual([
      "tab.create",
      {
        workspace_id: "w1",
        cwd: "/workspace/goofy",
        label: "goofy",
        env: { PORT: "5173", HOST: "127.0.0.1", AGENTBOX_BASE_PATH: `/a/${app.id}/`, AGENTBOX_APP_ID: app.id },
        focus: false,
      },
    ]);
    expect(run).toEqual(["pane.send_input", { pane_id: at.paneId, text: "npm run dev -- --port 5173", keys: ["enter"] }]);
  });

  it("uses an Apps workspace when the caller's cannot be told, making it once", async () => {
    const r = rig();
    const a = await r.apps.create({ port: 5173, name: "one", cwd: "/workspace/one", command: "npm run dev" });
    const b = await r.apps.create({ port: 5174, name: "two", cwd: "/workspace/two", command: "npm run dev" });
    const first = await r.apps.launch(a.id, { workspaceId: "nope" });
    expect(r.herdr[0]?.[0]).toBe("workspace.create");
    expect(r.herdr[0]?.[1]).toMatchObject({ label: APPS_WORKSPACE, cwd: "/workspace/one" });
    // The new workspace's own first tab takes the app, named after it.
    expect(first).toEqual({ workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" });
    expect(r.herdr.find(([m]) => m === "tab.rename")?.[1]).toEqual({ tab_id: "w9:t1", label: "one" });
    await r.apps.launch(b.id);
    expect(r.herdr.filter(([m]) => m === "workspace.create")).toHaveLength(1);
    expect(r.herdr.find(([m]) => m === "tab.create")?.[1]).toMatchObject({ workspace_id: "w9", label: "two" });
  });

  it("needs a command and a folder", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173 });
    await expect(r.apps.launch(app.id)).rejects.toThrow("no command");
  });
});

describe("stopping and restarting", () => {
  it("ends the listening process and what it started, and kills it if it holds on", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173, cwd: "/w", command: "npm run dev" });
    r.ports = [listening(5173, 900)];
    const done = r.apps.stop(app.id);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.kills).toEqual([
      [900, "SIGTERM"],
      [901, "SIGTERM"],
    ]);
    await done;
    expect(r.kills.slice(2)).toEqual([
      [900, "SIGKILL"],
      [901, "SIGKILL"],
    ]);
  });

  it("does not kill what let go of the port in time, and does nothing when nothing listens", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173 });
    expect(await r.apps.stop(app.id)).toEqual({ stopped: false });
    r.ports = [listening(5173, 900)];
    const done = r.apps.stop(app.id);
    setTimeout(() => (r.ports = []), 20);
    expect(await done).toEqual({ stopped: true });
    expect(r.kills.every(([, s]) => s === "SIGTERM")).toBe(true);
  });

  it("restarts in the pane it was launched in, while that pane is there", async () => {
    const r = rig();
    const app = await r.apps.create({ port: 5173, name: "goofy", cwd: "/w", command: "npm run dev" });
    const at = await r.apps.launch(app.id, { workspaceId: "w1" });
    r.snap.panes.push({ pane_id: at.paneId, terminal_id: "x", workspace_id: "w1", tab_id: at.tabId, focused: false, agent_status: "unknown", revision: 1 });
    r.herdr.length = 0;
    expect(await r.apps.restart(app.id)).toEqual(at);
    expect(r.herdr).toEqual([["pane.send_input", { pane_id: at.paneId, text: "npm run dev", keys: ["enter"] }]]);
  });
});

describe("pinned apps", () => {
  it("come back when the box starts, unless already serving", async () => {
    const r = rig();
    const pinned = await r.apps.create({ port: 5173, name: "staging", cwd: "/w/s", command: "npm run preview", pinned: true });
    await r.apps.create({ port: 5174, name: "serving", cwd: "/w/x", command: "x", pinned: true });
    await r.apps.create({ port: 5175, name: "unpinned", cwd: "/w/y", command: "y" });
    await r.apps.create({ port: 5176, name: "no command", pinned: true });
    r.ports = [listening(5174)];
    expect(await r.apps.relaunchPinned({ waitMs: 1000 })).toEqual([pinned.id]);
  });
});

describe("keeping up with the gate", () => {
  it("tells every tab when the apps change, and learns whether sharing is on", async () => {
    const r = rig();
    r.gate.sharing = false;
    r.apps.start();
    await new Promise((res) => setTimeout(res, 50));
    expect(r.apps.sharing).toBe(false);
    await r.gate.create({ port: 5173 });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.events.filter((e) => e.kind === "apps.changed")).toHaveLength(1);
    r.apps.stopWatching();
  });
});

describe("/api/apps", () => {
  const stubHub = {
    connected: false,
    version: null,
    protocol: null,
    snapshot: async () => ({}),
    on: () => () => {},
    start: async () => {},
    stop: () => {},
  } as unknown as SessionHub;

  async function app(r: Rig): Promise<FastifyInstance> {
    const config = loadConfig({ WORKBENCH_PORT: "0", HERDR_SOCKET_PATH: "/does/not/exist-apps.sock", WORKBENCH_STATIC_DIR: "/does/not/exist" });
    return buildApp(config, { hub: stubHub, apps: r.apps });
  }

  it("lists, registers, changes and removes apps", async () => {
    const r = rig();
    const a = await app(r);
    const created = await a.inject({ method: "POST", url: "/api/apps", payload: { port: 5173, name: "goofy", visibility: { mode: "link" } } });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ visibility: { mode: "private" }, url: `/a/${id}/` });
    expect((await a.inject({ method: "GET", url: "/api/apps" })).json()).toHaveLength(1);
    expect((await a.inject({ method: "PATCH", url: `/api/apps/${id}`, payload: { name: "renamed" } })).json()).toMatchObject({ name: "renamed" });
    expect((await a.inject({ method: "GET", url: `/api/apps/${id}` })).json()).toMatchObject({ name: "renamed" });
    expect((await a.inject({ method: "DELETE", url: `/api/apps/${id}` })).statusCode).toBe(204);
    expect((await a.inject({ method: "GET", url: `/api/apps/${id}` })).statusCode).toBe(404);
    await a.close();
  });

  it("passes the gate's refusals on as they are", async () => {
    const r = rig();
    const a = await app(r);
    const res = await a.inject({ method: "POST", url: "/api/apps", payload: { port: 7800 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "infrastructure_port" });
    await a.close();
  });

  it("opens, restarts and stops", async () => {
    const r = rig();
    const a = await app(r);
    const { id } = (await a.inject({ method: "POST", url: "/api/apps", payload: { port: 5173, name: "g", cwd: "/w", command: "npm run dev" } })).json<{ id: string }>();
    expect((await a.inject({ method: "POST", url: `/api/apps/${id}/open`, payload: { by: "claude" } })).statusCode).toBe(204);
    expect(r.events.some((e) => e.kind === "app.open" && e.id === id)).toBe(true);
    const started = await a.inject({ method: "POST", url: `/api/apps/${id}/restart`, payload: { workspaceId: "w1" } });
    expect(started.json()).toMatchObject({ workspaceId: "w1" });
    const out = await a.inject({ method: "GET", url: `/api/apps/${id}/output?paneId=${encodeURIComponent(started.json<{ paneId: string }>().paneId)}` });
    expect(out.json()).toEqual({ text: "vite ready" });
    const stopped = await a.inject({ method: "POST", url: `/api/apps/${id}/stop`, payload: { remove: true } });
    expect(stopped.json()).toEqual({ stopped: false, removed: true });
    expect(r.herdr.some(([m]) => m === "tab.close")).toBe(true);
    await a.close();
  });

  it("reports whether sharing is on in health", async () => {
    const r = rig();
    const a = await app(r);
    expect((await a.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ sharing: false });
    await a.close();
  });
});
