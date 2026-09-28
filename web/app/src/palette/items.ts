import type { FileEntry, Project, ReviewSession } from "@workbench/shared";
import {
  AppWindow,
  Bot,
  Boxes,
  Command,
  FileText,
  Folder,
  FolderGit2,
  Keyboard,
  LogOut,
  MessageSquareText,
  Monitor,
  Moon,
  PanelRight,
  PanelTop,
  Plus,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { agentsSorted, paneTitle, tabsOf, type Session } from "../store/session.ts";
import type { ActionId } from "../keys/actions.ts";
import type { AppView } from "../apps/model.ts";
import type { Route, SettingsSection, SurfaceId } from "../shell/routes.ts";
import { SURFACES } from "../shell/surfaces.ts";
import { chordLabel } from "../shell/keys.ts";
import { searchItems, type PaletteItem, type PaletteKind } from "./search.ts";

/** What the palette does with a choice. The component wires these to the stores. */
export interface PaletteEffects {
  /** Go to a surface, where it was last left — as the rail does. */
  go(surface: SurfaceId): void;
  navigate(route: Route): void;
  focusPane(id: string): void;
  focusTab(id: string): void;
  focusWorkspace(id: string): void;
  runAction(id: ActionId): void;
  openApp(app: AppView): void;
  openReview(key: string): void;
  openPort(port: number): void;
  openInEditor(path: string): void;
  terminalHere(path: string): void;
  newProject(): void;
  setTheme(t: "system" | "light" | "dark"): void;
  toggleDock(): void;
  showDock(tab: "preview" | "review"): void;
  keymap(): void;
  signOut(): void;
}

export interface PaletteSources {
  session: Session;
  projects: Project[] | null;
  apps: AppView[] | null;
  reviews: ReviewSession[];
  /** Name-search results for the query, when they have arrived. */
  files: FileEntry[] | null;
  workspaceRoot: string;
}

/** The Workbench's own commands, as the palette lists them. */
const HERDR_ACTIONS: { id: ActionId; label: string }[] = [
  { id: "workspace.new", label: "New workspace" },
  { id: "worktree.new", label: "New worktree" },
  { id: "tab.new", label: "New tab" },
  { id: "pane.splitRight", label: "Split right" },
  { id: "pane.splitDown", label: "Split down" },
  { id: "pane.zoom", label: "Zoom pane" },
  { id: "pane.close", label: "Close pane" },
  { id: "pane.rename", label: "Rename pane" },
  { id: "tab.close", label: "Close tab" },
  { id: "workspace.rename", label: "Rename workspace" },
  { id: "workspace.close", label: "Close workspace" },
  { id: "agent.nextBlocked", label: "Next blocked agent" },
  { id: "sidebar.toggle", label: "Toggle the Workbench sidebar" },
];

const SETTINGS: { id: SettingsSection; label: string }[] = [
  { id: "account", label: "Settings: account and two-factor" },
  { id: "cli", label: "Settings: devices and the CLI" },
  { id: "sharing", label: "Settings: sharing" },
  { id: "appearance", label: "Settings: appearance" },
  { id: "about", label: "Settings: about" },
];

/** How many of a kind an empty query shows; typing searches them all. */
const IDLE_CAP: Partial<Record<PaletteKind, number>> = { project: 6, app: 6, review: 5 };
/** Kinds that only show up once something is typed — too many to list idle. */
const ONLY_WHEN_TYPING = new Set<PaletteKind>(["tab", "pane"]);

function rel(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export function buildItems(src: PaletteSources, fx: PaletteEffects, mode: string, query: string): PaletteItem[] {
  const { session } = src;
  const items: PaletteItem[] = [];
  const q = query.trim();

  for (const w of session.workspaces) {
    items.push({
      id: `ws:${w.workspace_id}`,
      kind: "workspace",
      label: w.label,
      keywords: "workspace",
      hint: `${w.tab_count} tab${w.tab_count === 1 ? "" : "s"}`,
      status: w.agent_status,
      run: () => fx.focusWorkspace(w.workspace_id),
    });
  }
  if (mode === "workspaces") return searchItems(q, items);

  for (const s of SURFACES) {
    items.push({
      id: `surface:${s.id}`,
      kind: "surface",
      label: s.label,
      sub: s.hint,
      keywords: `go to ${s.id}`,
      keys: chordLabel(s.key),
      icon: s.icon,
      run: () => fx.go(s.id),
    });
  }

  for (const a of agentsSorted(session)) {
    const pane = session.panes[a.pane_id];
    items.push({
      id: `agent:${a.pane_id}`,
      kind: "agent",
      label: paneTitle(pane, a),
      sub: pane?.cwd ?? undefined,
      keywords: `agent ${a.agent ?? ""}`,
      status: a.agent_status,
      run: () => fx.focusPane(a.pane_id),
    });
  }

  for (const p of src.projects ?? []) {
    items.push({
      id: `project:${p.path}`,
      kind: "project",
      label: p.name,
      sub: p.git?.branch ? `${p.git.branch}${p.git.uncommitted ? ` · ${p.git.uncommitted} changed` : ""}` : p.path,
      keywords: "project folder",
      icon: FolderGit2,
      run: () => fx.navigate({ surface: "files", path: p.path }),
    });
  }

  for (const a of src.apps ?? []) {
    items.push({
      id: `app:${a.id}`,
      kind: "app",
      label: a.name,
      sub: `:${a.port}${a.live.listening ? "" : " · not running"}`,
      keywords: `app preview ${a.port}`,
      icon: AppWindow,
      run: () => fx.openApp(a),
    });
  }

  for (const r of src.reviews.filter((x) => x.status === "open")) {
    items.push({
      id: `review:${r.key}`,
      kind: "review",
      label: r.label,
      sub: r.pending > 0 ? "Sent, waiting for the agent" : "Waiting for your comments",
      keywords: "review",
      icon: MessageSquareText,
      run: () => fx.openReview(r.key),
    });
  }

  if (q) {
    for (const w of session.workspaces) {
      for (const t of tabsOf(session, w.workspace_id)) {
        items.push({ id: `tab:${t.tab_id}`, kind: "tab", label: `${w.label} / ${t.label}`, keywords: "tab", status: t.agent_status, run: () => fx.focusTab(t.tab_id) });
      }
    }
    for (const p of Object.values(session.panes)) {
      if (session.agents[p.pane_id]) continue; // agents are listed above
      items.push({ id: `pane:${p.pane_id}`, kind: "pane", label: paneTitle(p), sub: p.cwd ?? undefined, keywords: "pane terminal", status: p.agent_status, run: () => fx.focusPane(p.pane_id) });
    }
  }

  const commands: PaletteItem[] = [
    { id: "cmd:new-project", kind: "action", label: "New project", keywords: "clone repository git folder", icon: Plus, run: fx.newProject },
    { id: "cmd:dock", kind: "action", label: "Toggle the dock", keywords: "preview review panel", keys: chordLabel("d"), icon: PanelRight, run: fx.toggleDock },
    { id: "cmd:preview", kind: "action", label: "Show Preview", keywords: "dock app", icon: AppWindow, run: () => fx.showDock("preview") },
    { id: "cmd:review", kind: "action", label: "Show Review", keywords: "dock comments", icon: MessageSquareText, run: () => fx.showDock("review") },
    { id: "cmd:trash", kind: "action", label: "Open the trash", keywords: "files deleted restore", icon: Folder, run: () => fx.navigate({ surface: "files", path: "", trash: true }) },
    { id: "cmd:monitor", kind: "action", label: "Detailed monitor", keywords: "btop system processes", icon: Monitor, run: () => fx.navigate({ surface: "system", view: "monitor" }) },
    { id: "cmd:light", kind: "action", label: "Theme: light", keywords: "appearance", icon: Sun, run: () => fx.setTheme("light") },
    { id: "cmd:dark", kind: "action", label: "Theme: dark", keywords: "appearance", icon: Moon, run: () => fx.setTheme("dark") },
    { id: "cmd:system", kind: "action", label: "Theme: follow the system", keywords: "appearance", icon: Monitor, run: () => fx.setTheme("system") },
    { id: "cmd:keys", kind: "action", label: "Keyboard shortcuts", keywords: "keymap help", keys: "?", icon: Keyboard, run: fx.keymap },
    ...SETTINGS.map((s) => ({ id: `cmd:settings:${s.id}`, kind: "action" as const, label: s.label, run: () => fx.navigate({ surface: "settings", section: s.id }) })),
    ...HERDR_ACTIONS.map((a) => ({ id: `action:${a.id}`, kind: "action" as const, label: a.label, keywords: "workbench", icon: Command, run: () => fx.runAction(a.id) })),
    { id: "cmd:sign-out", kind: "action", label: "Sign out", icon: LogOut, run: fx.signOut },
  ];
  items.push(...commands);

  let ranked = searchItems(q, items);
  if (!q) {
    const seen: Partial<Record<PaletteKind, number>> = {};
    ranked = ranked.filter((i) => {
      if (ONLY_WHEN_TYPING.has(i.kind)) return false;
      const cap = IDLE_CAP[i.kind];
      seen[i.kind] = (seen[i.kind] ?? 0) + 1;
      return cap === undefined || seen[i.kind]! <= cap;
    });
  }

  // What the query itself names comes first, whatever else matched: a port
  // to show, or a path to open.
  const port = /^:?(\d{2,5})$/.exec(q)?.[1];
  if (port && Number(port) < 65536) {
    ranked.unshift({ id: `port:${port}`, kind: "action", label: `Preview port ${port}`, icon: AppWindow, run: () => fx.openPort(Number(port)) });
  }
  if (/^[/~]/.test(q) && q.length > 1) {
    const path = q.length > 1 ? q.replace(/\/+$/, "") : q;
    ranked.unshift({ id: `path:${path}`, kind: "file", label: `Open ${path} in Files`, icon: Folder, run: () => fx.navigate({ surface: "files", path }) });
  }

  // Files come from the server's own name search, already ranked.
  for (const f of src.files ?? []) {
    const isDir = f.type === "dir" || (f.type === "symlink" && f.targetType === "dir");
    ranked.push({
      id: `file:${f.path}`,
      kind: "file",
      label: f.name,
      sub: rel(f.path, src.workspaceRoot),
      icon: isDir ? Folder : FileText,
      run: () => fx.navigate({ surface: "files", path: f.path }),
    });
  }
  return ranked;
}

export const KIND_LABEL: Record<PaletteKind, string> = {
  surface: "Go to",
  agent: "Agents",
  project: "Projects",
  file: "Files",
  app: "Apps",
  review: "Reviews",
  workspace: "Workspaces",
  tab: "Tabs",
  pane: "Panes",
  action: "Commands",
};

export const KIND_GLYPH: Record<PaletteKind, typeof Bot> = {
  surface: Boxes,
  agent: Bot,
  project: FolderGit2,
  file: FileText,
  app: AppWindow,
  review: MessageSquareText,
  workspace: Boxes,
  tab: PanelTop,
  pane: SquareTerminal,
  action: Command,
};

/**
 * Group the ranked results by kind without disturbing the ranking: a group
 * appears in the order its best match did, and rows keep their score order
 * inside it. Grouping that reorders results would fight the search.
 */
export function groupItems(items: PaletteItem[]): { kind: PaletteKind; items: PaletteItem[] }[] {
  const groups: { kind: PaletteKind; items: PaletteItem[] }[] = [];
  const byKind = new Map<PaletteKind, PaletteItem[]>();
  for (const item of items) {
    let bucket = byKind.get(item.kind);
    if (!bucket) {
      bucket = [];
      byKind.set(item.kind, bucket);
      groups.push({ kind: item.kind, items: bucket });
    }
    bucket.push(item);
  }
  return groups;
}
