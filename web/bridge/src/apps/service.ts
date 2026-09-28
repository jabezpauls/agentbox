import fsp from "node:fs/promises";
import type { App, AppLive, AppView, ListeningPort, SessionSnapshot } from "@workbench/shared";
import type { BridgeEvents } from "../events.js";
import { GateError, type AppFields, type GateApps } from "./gate.js";

/**
 * Apps as the bridge sees them: the gate's records (who may open an app is
 * the gate's to say), merged with what is true in the sandbox right now — is
 * anything listening on the port, which process, which herdr pane — and the
 * things only the sandbox can do: launch an app's command in a herdr tab,
 * stop it, restart it, bring pinned apps back when the box starts, and tell
 * every open tab to show one in Preview.
 */

/** The workspace apps are launched in when the caller's own cannot be told. */
export const APPS_WORKSPACE = "Apps";

export interface LaunchedAt {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrCall {
  <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface AppsDeps {
  gate: GateApps;
  events: BridgeEvents;
  /** A fresh list of listening sockets with their owners. */
  scanPorts(): Promise<ListeningPort[]>;
  /** herdr's session, for panes, agents and workspaces. */
  snapshot(): Promise<SessionSnapshot>;
  /** One herdr request. */
  herdr: HerdrCall;
  /** Whether herdr is answering (pinned apps wait for it). */
  herdrReady(): boolean;
  /** A process's environment; tests stand in for /proc. */
  environ?(pid: number): Promise<Record<string, string> | null>;
  /** A process and everything it started; tests stand in for /proc. */
  processTree?(pid: number): Promise<number[]>;
  /** Signal a process; tests record it. */
  kill?(pid: number, signal: NodeJS.Signals): void;
  /** How long a stopped server has to let go of its port before it is killed. */
  stopGraceMs?: number;
}

export class AppsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readEnviron(pid: number): Promise<Record<string, string> | null> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`, "utf8");
    const out: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** A process's parent, from /proc/<pid>/stat. */
async function parentOf(pid: string): Promise<number | null> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
    // The command sits in parentheses and may hold spaces; fields resume after it.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** `pid` and everything it started, however deep. */
async function readProcessTree(pid: number): Promise<number[]> {
  let names: string[];
  try {
    names = (await fsp.readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return [pid];
  }
  const children = new Map<number, number[]>();
  await Promise.all(
    names.map(async (n) => {
      const ppid = await parentOf(n);
      if (ppid === null) return;
      const list = children.get(ppid) ?? [];
      list.push(Number(n));
      children.set(ppid, list);
    }),
  );
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop() as number;
    if (out.includes(p)) continue;
    out.push(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Who asked to open an app, as a toast names them: one short line of plain text. */
export function cleanBy(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  return t === "" ? null : t;
}

export class AppsService {
  private readonly launched = new Map<string, LaunchedAt>();
  private readonly environ: (pid: number) => Promise<Record<string, string> | null>;
  private readonly processTree: (pid: number) => Promise<number[]>;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private sharingOn = false;
  private watching: AbortController | null = null;
  private portsCache: { at: number; ports: Promise<ListeningPort[]> } | null = null;

  constructor(private readonly deps: AppsDeps) {
    this.environ = deps.environ ?? readEnviron;
    this.processTree = deps.processTree ?? readProcessTree;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  }

  /** Whether the owner may share apps (the gate says, on every watch). */
  get sharing(): boolean {
    return this.sharingOn;
  }

  private ports(): Promise<ListeningPort[]> {
    const t = Date.now();
    if (!this.portsCache || t - this.portsCache.at > 1_000) {
      this.portsCache = { at: t, ports: this.deps.scanPorts().catch(() => []) };
    }
    return this.portsCache.ports;
  }

  private async live(app: App, ports: ListeningPort[]): Promise<AppLive> {
    const hit = ports.find((p) => p.port === app.port);
    const live: AppLive = {
      listening: hit !== undefined,
      pid: hit?.pid ?? null,
      process: hit?.process ?? null,
      cwd: hit?.cwd ?? null,
      paneId: null,
      tabId: null,
      workspaceId: null,
    };
    // A process started in a herdr pane carries the pane in its environment.
    const env = live.pid !== null ? await this.environ(live.pid) : null;
    if (env?.HERDR_PANE_ID) {
      live.paneId = env.HERDR_PANE_ID;
      live.tabId = env.HERDR_TAB_ID ?? null;
      live.workspaceId = env.HERDR_WORKSPACE_ID ?? null;
    } else {
      const at = this.launched.get(app.id);
      if (at) Object.assign(live, { paneId: at.paneId, tabId: at.tabId, workspaceId: at.workspaceId });
    }
    return live;
  }

  private async toView(app: App, ports: ListeningPort[]): Promise<AppView> {
    return { ...app, url: `/a/${app.id}/`, live: await this.live(app, ports) };
  }

  async views(): Promise<AppView[]> {
    const [apps, ports] = await Promise.all([this.deps.gate.list(), this.ports()]);
    return Promise.all(apps.map((a) => this.toView(a, ports)));
  }

  async view(id: string): Promise<AppView | null> {
    const app = await this.deps.gate.get(id);
    return app ? this.toView(app, await this.ports()) : null;
  }

  private async must(id: string): Promise<App> {
    const app = await this.deps.gate.get(id);
    if (!app) throw new AppsError(404, "no such app");
    return app;
  }

  async create(fields: AppFields): Promise<AppView> {
    const app = await this.deps.gate.create(fields);
    this.portsCache = null;
    return this.toView(app, await this.ports());
  }

  async update(id: string, fields: AppFields): Promise<AppView> {
    const app = await this.deps.gate.update(id, fields);
    return this.toView(app, await this.ports());
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.deps.gate.remove(id);
    this.launched.delete(id);
    return removed;
  }

  /** Every open tab shows the app in its Preview, with a toast saying who asked. */
  async open(id: string, opts: { by?: unknown; paneId?: unknown; path?: unknown } = {}): Promise<void> {
    const app = await this.must(id);
    let by = cleanBy(opts.by);
    if (by === null && typeof opts.paneId === "string") {
      try {
        const snap = await this.deps.snapshot();
        const pane = snap.panes.find((p) => p.pane_id === opts.paneId);
        const agent = snap.agents.find((a) => a.pane_id === opts.paneId);
        by = cleanBy(agent?.display_agent ?? agent?.agent ?? pane?.display_agent ?? pane?.agent);
      } catch {
        // herdr not answering: the toast just says less.
      }
    }
    const path = typeof opts.path === "string" && opts.path.startsWith("/") && opts.path.length < 2048 ? opts.path : undefined;
    this.deps.events.emit({ kind: "app.open", id: app.id, name: app.name, by: by ?? "agentbox-preview", ...(path ? { path } : {}) });
  }

  // --- launching, stopping ---------------------------------------------------------

  /** The workspace labelled Apps, made when there is none. */
  private async appsWorkspace(app: App, env: Record<string, string>): Promise<LaunchedAt | string> {
    const snap = await this.deps.snapshot();
    const existing = snap.workspaces.find((w) => w.label === APPS_WORKSPACE);
    if (existing) return existing.workspace_id;
    // A new workspace comes with a tab and a pane of its own: the app starts there.
    const created = await this.deps.herdr<{ workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: APPS_WORKSPACE, cwd: app.cwd, env, focus: false },
    );
    await this.deps.herdr("tab.rename", { tab_id: created.tab.tab_id, label: app.name }).catch(() => {});
    return { workspaceId: created.workspace.workspace_id, tabId: created.tab.tab_id, paneId: created.root_pane.pane_id };
  }

  /**
   * Run an app's command in a herdr tab of its own, named after the app — in
   * the workspace asked for (the calling agent's), else in **Apps** — with
   * `PORT`, `HOST` and `AGENTBOX_BASE_PATH` set. The pane stays, so the owner
   * can watch the server and stop it by hand.
   */
  async launch(id: string, where: { workspaceId?: unknown } = {}): Promise<LaunchedAt> {
    const app = await this.must(id);
    if (!app.command || !app.cwd) throw new AppsError(400, "this app has no command and folder to start it with");
    const env = { PORT: String(app.port), HOST: "127.0.0.1", AGENTBOX_BASE_PATH: `/a/${app.id}/`, AGENTBOX_APP_ID: app.id };
    let at: LaunchedAt;
    const snap = await this.deps.snapshot();
    const asked = typeof where.workspaceId === "string" ? snap.workspaces.find((w) => w.workspace_id === where.workspaceId) : undefined;
    const workspace = asked ? asked.workspace_id : await this.appsWorkspace(app, env);
    if (typeof workspace === "string") {
      const created = await this.deps.herdr<{ tab: { tab_id: string }; root_pane: { pane_id: string; workspace_id: string } }>("tab.create", {
        workspace_id: workspace,
        cwd: app.cwd,
        label: app.name,
        env,
        focus: false,
      });
      at = { workspaceId: workspace, tabId: created.tab.tab_id, paneId: created.root_pane.pane_id };
    } else {
      at = workspace;
    }
    await this.run(at.paneId, app.command);
    this.launched.set(app.id, at);
    this.portsCache = null;
    return at;
  }

  private run(paneId: string, command: string): Promise<unknown> {
    return this.deps.herdr("pane.send_input", { pane_id: paneId, text: command, keys: ["enter"] });
  }

  /** The last lines a pane showed, for an app that never came up. */
  async output(paneId: string, lines = 40): Promise<string> {
    const res = await this.deps.herdr<{ text: string }>("pane.read", { pane_id: paneId, source: "recent_unwrapped", lines });
    return res.text;
  }

  /**
   * Stop whatever serves the app: the listening process and everything it
   * started are asked to end, then killed if the port is still held after the
   * grace. Never what started it — the `npm run` wrapping it exits on its own
   * once its script does, and above that are the pane's shell or an agent,
   * which must survive. The pane stays.
   */
  async stop(id: string): Promise<{ stopped: boolean }> {
    const app = await this.must(id);
    this.portsCache = null;
    const hit = (await this.deps.scanPorts()).find((p) => p.port === app.port);
    if (!hit || hit.pid === null || hit.pid === process.pid) return { stopped: false };
    const tree = (await this.processTree(hit.pid)).filter((p) => p !== process.pid && p > 1);
    const signal = (sig: NodeJS.Signals): void => {
      for (const pid of tree) {
        try {
          this.kill(pid, sig);
        } catch {
          // already gone
        }
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + (this.deps.stopGraceMs ?? 5_000);
    while (Date.now() < deadline) {
      await sleep(200);
      if (!(await this.deps.scanPorts()).some((p) => p.port === app.port)) return { stopped: true };
    }
    signal("SIGKILL");
    return { stopped: true };
  }

  /** Stop the app if it is running, then start it again with its command. */
  async restart(id: string, where: { workspaceId?: unknown } = {}): Promise<LaunchedAt> {
    const app = await this.must(id);
    if (!app.command || !app.cwd) throw new AppsError(400, "this app has no command and folder to start it with");
    await this.stop(id);
    const at = this.launched.get(id);
    if (at) {
      // Its pane is still there (a shell, once the server stopped): run it again in place.
      const snap = await this.deps.snapshot().catch(() => null);
      if (snap?.panes.some((p) => p.pane_id === at.paneId)) {
        await this.run(at.paneId, app.command);
        return at;
      }
    }
    return this.launch(id, where);
  }

  /** Close the tab an app was launched in, when it was this bridge that launched it. */
  async closeLaunched(id: string): Promise<void> {
    const at = this.launched.get(id);
    if (!at) return;
    this.launched.delete(id);
    await this.deps.herdr("tab.close", { tab_id: at.tabId }).catch(() => {});
  }

  // --- keeping up with the gate -----------------------------------------------------------

  /**
   * Hold a watch on the gate's registry, and tell every open tab when an app
   * changes — shared or stopped from any tab, expired, renamed by an agent.
   */
  start(): void {
    if (this.watching) return;
    const ctl = new AbortController();
    this.watching = ctl;
    void (async () => {
      let since = -1;
      while (!ctl.signal.aborted) {
        try {
          const r = await this.deps.gate.watch(since, 25_000, ctl.signal);
          this.sharingOn = r.sharing;
          if (r.revision !== since) {
            if (since !== -1) this.deps.events.emit({ kind: "apps.changed" });
            since = r.revision;
          }
        } catch {
          if (ctl.signal.aborted) return;
          // The gate is restarting, or not up yet: try again shortly. A
          // restarted gate starts its revisions over, so start from scratch.
          since = -1;
          await sleep(2_000);
        }
      }
    })();
  }

  stopWatching(): void {
    this.watching?.abort();
    this.watching = null;
  }

  /**
   * On start: every pinned app with a command and a folder that is not
   * already serving is launched again in the Apps workspace, once herdr
   * answers. This is what keeps a staging link working across a restart.
   */
  async relaunchPinned(opts: { waitMs?: number } = {}): Promise<string[]> {
    const deadline = Date.now() + (opts.waitMs ?? 120_000);
    while (!this.deps.herdrReady()) {
      if (Date.now() > deadline) return [];
      await sleep(1_000);
    }
    let apps: App[] = [];
    for (;;) {
      try {
        apps = await this.deps.gate.list();
        break;
      } catch (err) {
        if (!(err instanceof GateError) || Date.now() > deadline) return [];
        await sleep(2_000);
      }
    }
    const listening = new Set((await this.deps.scanPorts()).map((p) => p.port));
    const started: string[] = [];
    for (const app of apps) {
      if (!app.pinned || !app.command || !app.cwd || listening.has(app.port)) continue;
      try {
        await this.launch(app.id);
        started.push(app.id);
        console.log(`[workbench] relaunched pinned app ${app.name} (:${app.port})`);
      } catch (err) {
        console.warn(`[workbench] could not relaunch pinned app ${app.name}: ${(err as Error).message}`);
      }
    }
    return started;
  }
}
