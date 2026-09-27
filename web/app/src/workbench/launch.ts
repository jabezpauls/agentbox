import type { PaneInfo, TabInfo, WorkspaceInfo } from "@workbench/shared";
import { call } from "../api/call.ts";
import { useApp } from "../store/app.ts";
import type { Session } from "../store/session.ts";
import { navigate } from "../shell/router.ts";

/**
 * "Terminal here", "New agent here" and "Run this here", from Home, Files and
 * the palette. Each opens a tab in the Workbench at a folder: in the
 * workspace that already belongs to the folder's project when there is one,
 * else in a new workspace named after the project — so a project's
 * terminals gather in one place instead of scattering over whatever
 * workspace happened to be focused.
 */

/** herdr's `agent.start` kinds, by the command name the system surface lists. */
const AGENT_KINDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  amp: "amp",
  "cursor-agent": "cursor",
  qwen: "qwen",
};

const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "opencode",
  amp: "Amp",
  "cursor-agent": "Cursor",
  qwen: "Qwen Code",
  aider: "Aider",
  goose: "Goose",
  crush: "Crush",
};

export function agentLabel(name: string): string {
  return AGENT_LABEL[name] ?? name;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** The project a path is in: the workspace root's top-level folder that holds it. */
export function projectOf(path: string, root: string): { name: string; path: string } | null {
  const r = root.replace(/\/+$/, "");
  if (path !== r && !path.startsWith(`${r}/`)) return null;
  const first = path.slice(r.length + 1).split("/")[0];
  if (!first) return null;
  return { name: first, path: `${r}/${first}` };
}

function inside(path: string | null | undefined, dir: string): boolean {
  return !!path && (path === dir || path.startsWith(`${dir}/`));
}

/** The workspace that already belongs to a project: named after it, or working inside it. */
export function workspaceFor(session: Session, project: { name: string; path: string }): WorkspaceInfo | null {
  const byName = session.workspaces.find((w) => w.label === project.name);
  if (byName) return byName;
  for (const w of session.workspaces) {
    if (inside(w.worktree?.path ?? null, project.path)) return w;
    const panes = Object.values(session.panes).filter((p) => p.workspace_id === w.workspace_id);
    if (panes.length > 0 && panes.every((p) => inside(p.cwd ?? p.foreground_cwd, project.path))) return w;
  }
  return null;
}

interface Created {
  type?: string;
  tab?: TabInfo;
  workspace?: WorkspaceInfo;
  root_pane?: PaneInfo;
}

/** Open a terminal at `cwd`, show the Workbench, and return the new pane's id. */
export async function terminalHere(cwd: string, opts: { label?: string } = {}): Promise<string | null> {
  const { session, health } = useApp.getState();
  const root = health?.workspaceRoot ?? "/workspace";
  const project = projectOf(cwd, root);
  const label = opts.label ?? basename(cwd);
  const ws = project ? workspaceFor(session, project) : null;
  navigate({ surface: "workbench" });
  let created: Created | undefined;
  if (ws) {
    created = await call<Created>("tab.create", { workspace_id: ws.workspace_id, cwd, label, focus: true });
  } else {
    created = await call<Created>("workspace.create", { cwd, label: project?.name ?? label, focus: true });
  }
  return created?.root_pane?.pane_id ?? null;
}

/**
 * Start an agent at `cwd`: a new tab, then herdr starts the agent in it and
 * waits for it to be ready. Agents herdr does not know how to start are typed
 * into the tab as their command instead.
 */
export async function agentHere(cwd: string, agent = "claude"): Promise<void> {
  const paneId = await terminalHere(cwd, { label: `${agentLabel(agent)} · ${basename(cwd)}` });
  if (!paneId) return;
  const kind = AGENT_KINDS[agent];
  if (kind) await call("agent.start", { name: agent, kind, pane_id: paneId });
  else await call("pane.send_input", { pane_id: paneId, text: agent, keys: ["Enter"] });
}

/** Run a command at `cwd` in a new tab (serving a folder, say), where you can watch and stop it. */
export async function runHere(cwd: string, command: string, label?: string): Promise<void> {
  const paneId = await terminalHere(cwd, label ? { label } : {});
  if (!paneId) return;
  await call("pane.send_input", { pane_id: paneId, text: command, keys: ["Enter"] });
}

/** The agent CLIs the box has, in the order worth offering them. */
export function launchableAgents(found: { name: string }[]): string[] {
  const names = found.map((a) => a.name);
  const preferred = ["claude", "codex"];
  return [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n))];
}
