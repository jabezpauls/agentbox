import path from "node:path";
import type { AgentInfo, SessionSnapshot } from "@workbench/shared";
import { bool } from "../args.js";
import { openBrowser } from "../browser.js";
import { ApiError, CliError, EXIT } from "../errors.js";
import { formatBytes, formatDuration, safeText, table } from "../format.js";
import type { BoxClient } from "../http.js";
import type { AppSummary, HealthInfo, SystemSummary } from "../remote.js";
import { VERSION } from "../version.js";
import { command, type Command } from "./types.js";

/** Settle a read, keeping what went wrong for the report instead of failing all of it. */
async function attempt<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; status: number | null }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: (err as Error).message, status: err instanceof ApiError ? err.status : null };
  }
}

interface AgentRow {
  paneId: string;
  agent: string;
  status: string;
  workspace: string;
  cwd: string | null;
}

export function agentRows(snapshot: SessionSnapshot): AgentRow[] {
  const labels = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w.label]));
  return snapshot.agents.map((a: AgentInfo) => ({
    paneId: a.pane_id,
    agent: a.display_agent ?? a.agent ?? a.name ?? "agent",
    status: a.agent_status,
    workspace: labels.get(a.workspace_id) ?? a.workspace_id,
    cwd: a.foreground_cwd ?? a.cwd ?? null,
  }));
}

/** "3 — 1 blocked, 2 working", worst first. */
export function agentTally(rows: AgentRow[]): string {
  if (rows.length === 0) return "none";
  const order = ["blocked", "working", "done", "idle", "unknown"];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([s, n]) => `${n} ${s}`);
  return `${rows.length} — ${parts.join(", ")}`;
}

export function systemLine(sys: SystemSummary): string {
  const parts: string[] = [];
  const cores = sys.container?.cpu?.limit ?? sys.host?.cores;
  if (typeof sys.sandbox?.cpu === "number") parts.push(`CPU ${sys.sandbox.cpu.toFixed(1)}${cores ? ` of ${cores} cores` : ""}`);
  if (typeof sys.sandbox?.memory === "number") {
    const limit = sys.container?.memory?.limit ?? sys.host?.memory;
    parts.push(`memory ${formatBytes(sys.sandbox.memory)}${limit ? ` of ${formatBytes(limit)}` : ""}`);
  }
  for (const d of sys.disks ?? []) {
    if (typeof d.available === "number") parts.push(`${d.label ?? d.path} ${formatBytes(d.available)} free${d.total ? ` of ${formatBytes(d.total)}` : ""}`);
  }
  if (typeof sys.uptime?.box === "number") parts.push(`up ${formatDuration(sys.uptime.box)}`);
  return parts.length ? parts.join(" · ") : "-";
}

async function readApps(client: BoxClient): Promise<AppSummary[] | null> {
  try {
    const apps = await client.json<AppSummary[] | { apps?: AppSummary[] }>("GET", "/api/apps", { what: "reading apps" });
    return Array.isArray(apps) ? apps : (apps?.apps ?? []);
  } catch (err) {
    // A box from before apps: nothing to list, and nothing wrong.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const status = command({
  path: ["status"],
  summary: "how the box is doing: version, agents, apps, system",
  usage: "",
  json: true,
  async run(ctx) {
    const { name, box, client } = await ctx.connect({ checkVersion: false });
    const [version, session, health, snapshot, apps, system] = await Promise.all([
      ctx.checkVersion(name, client),
      attempt(client.json<{ user?: string; name?: string }>("GET", "/_gate/session", { what: "asking who this is" })),
      attempt(client.json<HealthInfo>("GET", "/api/health", { what: "reading health" })),
      attempt(client.json<SessionSnapshot>("GET", "/api/session", { what: "reading agents" })),
      attempt(readApps(client)),
      attempt(client.json<SystemSummary>("GET", "/api/system", { what: "reading system" })),
    ]);
    if (!session.ok && session.status === 401) {
      throw new CliError("the box did not accept this device's sign-in; run `agentbox login` again", EXIT.AUTH);
    }
    const agents = snapshot.ok ? agentRows(snapshot.value) : null;
    const failed = [session, health, snapshot, apps, system].some((r) => !r.ok);

    if (ctx.json) {
      ctx.printJson({
        box: { name, url: box.url, version, user: session.ok ? (session.value.user ?? null) : null },
        cli: { version: VERSION },
        herdr: health.ok ? (health.value.herdr ?? null) : { error: health.error },
        agents: agents ?? { error: snapshot.ok ? null : snapshot.error },
        apps: apps.ok ? apps.value : { error: apps.error },
        system: system.ok ? system.value : { error: system.error },
      });
      return failed ? EXIT.FAILURE : EXIT.OK;
    }

    const row = (label: string, text: string): void => ctx.out(`  ${label.padEnd(8)} ${text}\n`);
    ctx.out(`${name}  ${box.url}\n`);
    row(
      "box",
      `agentbox ${version ?? "?"}${version && version !== VERSION ? ` (this CLI is ${VERSION}: run \`agentbox update\`)` : ""}${
        session.ok && session.value.user ? ` · signed in as ${session.value.user}` : ""
      }`,
    );
    if (health.ok) {
      const h = health.value.herdr;
      row("herdr", h?.connected ? `connected${h.version ? `, ${h.version}` : ""}` : "not connected (the Workbench is starting it, or it is down)");
    } else {
      row("herdr", `unknown: ${health.error}`);
    }
    if (agents) {
      row("agents", agentTally(agents));
      if (agents.length) {
        const lines = table(
          ["AGENT", "STATUS", "WORKSPACE", "WHERE"],
          agents.map((a) => [safeText(a.agent), a.status, safeText(a.workspace), safeText(a.cwd ?? "-")]),
        );
        for (const l of lines.trimEnd().split("\n")) ctx.out(`           ${l}\n`);
      }
    } else {
      row("agents", `unknown: ${snapshot.ok ? "" : snapshot.error}`);
    }
    if (apps.ok) {
      const list = apps.value;
      if (list === null) row("apps", "not available on this box yet");
      else if (list.length === 0) row("apps", "none");
      else {
        const shared = list.filter((a) => a.visibility?.mode && a.visibility.mode !== "private").length;
        row("apps", `${list.length}${shared ? ` (${shared} shared)` : ""}`);
        const lines = table(
          ["NAME", "PORT", "STATE", "SHARING"],
          list.map((a) => [safeText(a.name ?? a.id), String(a.port ?? "-"), a.listening === false ? "not up" : a.listening ? "up" : "-", a.visibility?.mode ?? "private"]),
        );
        for (const l of lines.trimEnd().split("\n")) ctx.out(`           ${l}\n`);
      }
    } else {
      row("apps", `unknown: ${apps.error}`);
    }
    row("system", system.ok ? systemLine(system.value) : `unknown: ${system.error}`);
    return failed ? EXIT.FAILURE : EXIT.OK;
  },
});

/** The app's surfaces, by the names `open` takes. */
export const SURFACES: Record<string, string> = {
  home: "/",
  workbench: "/workbench",
  editor: "/editor",
  files: "/files",
  apps: "/apps",
  system: "/system",
  settings: "/settings",
  devices: "/settings/devices",
  terminal: "/terminal/",
  shell: "/shell/",
  monitor: "/monitor/",
  vscode: "/vscode/",
};

/**
 * Where `open <what>` goes: a surface by name, else a path in the box's files
 * (relative to the workspace, as the files API takes them), shown in Files.
 */
export function openTarget(what: string | undefined, workspaceRoot = "/workspace"): string {
  if (what === undefined || what === "") return "/";
  const surface = SURFACES[what.toLowerCase()];
  if (surface) return surface;
  let p = what;
  if (!p.startsWith("/") && !p.startsWith("~")) p = `${workspaceRoot}/${p}`;
  const segments = path.posix
    .normalize(p)
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map((s) => encodeURIComponent(s));
  return `/files/${segments.join("/")}`;
}

export const open = command({
  path: ["open"],
  summary: "open the box in your browser (a surface, or a file)",
  usage: "[surface|path]",
  operands: { min: 0, max: 1 },
  options: [{ name: "print", type: "boolean", description: "print the URL instead of opening it" }],
  details: `Surfaces: ${Object.keys(SURFACES).join(", ")}. Anything else is a path in the box's files\n(relative to /workspace), opened in Files.`,
  async run(ctx, p) {
    const { box } = ctx.selected();
    const url = `${box.url}${openTarget(p.operands[0])}`;
    if (bool(p.options, "print") || !(await openBrowser(url, ctx.platform, ctx.env))) {
      ctx.out(`${url}\n`);
      return;
    }
    ctx.err(`Opened ${url}\n`);
  },
});

export const STATUS_COMMANDS: Command[] = [status, open];
