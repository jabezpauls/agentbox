export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface Rect { x: number; y: number; width: number; height: number }
export interface ScrollInfo { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number }
export interface WorkspaceWorktreeInfo { path?: string | null; branch?: string | null; label?: string | null; [k: string]: unknown }
export interface WorkspaceInfo {
  workspace_id: string; number: number; label: string; focused: boolean;
  pane_count: number; tab_count: number; active_tab_id: string; agent_status: AgentStatus;
  tokens?: Record<string, string>; worktree?: WorkspaceWorktreeInfo | null;
}
export interface TabInfo { tab_id: string; workspace_id: string; number: number; label: string; focused: boolean; pane_count: number; agent_status: AgentStatus }
export interface PaneInfo {
  pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; focused: boolean;
  cwd?: string | null; foreground_cwd?: string | null; agent_status: AgentStatus;
  agent?: string | null; display_agent?: string | null; label?: string | null; title?: string | null;
  terminal_title?: string | null; terminal_title_stripped?: string | null;
  state_labels?: Record<string, string>; scroll?: ScrollInfo | null; revision: number;
}
export interface AgentInfo extends PaneInfo { name?: string | null; interactive_ready: boolean; launch_pending: boolean; state_change_seq?: number }
export interface LayoutPane { pane_id: string; focused: boolean; rect: Rect }
export interface LayoutSplit { id: string; direction: "right" | "down"; ratio: number; rect: Rect }
export interface PaneLayoutSnapshot { workspace_id: string; tab_id: string; zoomed: boolean; area: Rect; focused_pane_id: string | null; panes: LayoutPane[]; splits: LayoutSplit[] }
export interface SessionSnapshot {
  version: string; protocol: number;
  focused_workspace_id?: string | null; focused_tab_id?: string | null; focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[]; tabs: TabInfo[]; panes: PaneInfo[]; layouts: PaneLayoutSnapshot[]; agents: AgentInfo[];
}
export interface WorktreeInfo { path: string; label: string; branch?: string | null; is_bare: boolean; is_detached: boolean; is_prunable: boolean; is_linked_worktree: boolean; open_workspace_id?: string | null }

/** Lifecycle events exactly as herdr streams them: {event, data}. */
export type HerdrEvent =
  | { event: "workspace_created" | "workspace_updated" | "workspace_metadata_updated"; data: { workspace: WorkspaceInfo } }
  | { event: "workspace_closed"; data: { workspace_id: string; workspace?: WorkspaceInfo | null } }
  | { event: "workspace_renamed"; data: { workspace_id: string; label: string } }
  | { event: "workspace_moved"; data: { workspace_id: string; insert_index: number; workspaces: WorkspaceInfo[] } }
  | { event: "workspace_reordered"; data: { workspace_ids: string[]; before_workspace_id?: string | null; workspaces: WorkspaceInfo[] } }
  | { event: "workspace_focused"; data: { workspace_id: string } }
  | { event: "worktree_created" | "worktree_opened"; data: { workspace: WorkspaceInfo; worktree: WorktreeInfo; already_open?: boolean } }
  | { event: "worktree_removed"; data: { workspace_id: string; workspace?: WorkspaceInfo | null; worktree: WorktreeInfo; forced: boolean } }
  | { event: "tab_created"; data: { tab: TabInfo } }
  | { event: "tab_closed"; data: { tab_id: string; workspace_id: string } }
  | { event: "tab_renamed"; data: { tab_id: string; workspace_id: string; label: string } }
  | { event: "tab_moved"; data: { tab_id: string; workspace_id: string; insert_index: number; tabs: TabInfo[] } }
  | { event: "tab_focused"; data: { tab_id: string; workspace_id: string } }
  | { event: "pane_created" | "pane_updated"; data: { pane: PaneInfo } }
  | { event: "pane_closed" | "pane_exited"; data: { pane_id: string; workspace_id: string } }
  | { event: "pane_focused"; data: { pane_id: string; workspace_id: string } }
  | { event: "pane_moved"; data: { pane: PaneInfo; previous_pane_id: string; previous_tab_id: string; previous_workspace_id: string; created_tab?: TabInfo | null; created_workspace?: WorkspaceInfo | null; closed_tab_id?: string | null; closed_workspace_id?: string | null } }
  | { event: "pane_agent_detected"; data: { pane_id: string; workspace_id: string; agent?: string | null; final_status?: AgentStatus | null; released?: boolean } }
  | { event: "pane_agent_status_changed"; data: { pane_id: string; workspace_id: string; agent_status: AgentStatus; agent?: string | null; display_agent?: string | null; title?: string | null; state_labels?: Record<string, string> } }
  | { event: "layout_updated"; data: { layout: PaneLayoutSnapshot } };

export type HerdrEventName = HerdrEvent["event"];

/** Messages on /ws/events, bridge → browser. */
export interface ListeningPort { port: number; pid: number | null; process: string | null; system: boolean; address: string }
export type EventsMessage =
  | { kind: "snapshot"; snapshot: SessionSnapshot }
  | { kind: "event"; event: HerdrEventName; data: unknown }
  | { kind: "ports"; ports: ListeningPort[]; readable?: boolean }
  | { kind: "reset"; reason: string };

/** Browser → bridge control messages on /ws/terminal (JSON text frames). Output arrives as binary frames of raw ANSI bytes. */
export type TerminalClientMessage =
  | { type: "input"; text?: string; bytes?: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "scroll"; direction: "up" | "down"; lines: number }
  | { type: "focus" };
export type TerminalServerMessage = { type: "closed"; reason: string } | { type: "size"; cols: number; rows: number };

/** Review: an artifact an agent published, and the comments a human anchored to it. */
export type ReviewStatus = "open" | "ended";
export type ReviewEndedBy = "agent" | "human";
export type ReviewCommentKind = "element" | "selection" | "note";
/** One comment. `anchor` is a CSS path into the artifact; `quote` the text it refers to. */
export interface ReviewComment { kind: ReviewCommentKind; anchor?: string; quote?: string; note: string; at?: string }
export interface ReviewSession {
  key: string; label: string; file: string; created: string; updated: string;
  status: ReviewStatus; endedBy?: ReviewEndedBy; pending: number;
}
export interface ReviewSessionDetail { session: ReviewSession; comments: ReviewComment[] }
/** What an anchor picked inside the sandboxed artifact frame looks like. */
export type AnnotatorMessage =
  | { source: "agentbox-review"; kind: "element"; selector: string; text: string; rect: Rect }
  | { source: "agentbox-review"; kind: "selection"; selector: string; text: string }
  | { source: "agentbox-review"; kind: "scrolled"; selector: string; ok: boolean };
export interface DirEntry { name: string; path: string }
/** A minted public preview share, as the owner's API returns it. */
export interface PreviewShare { id: string; token: string; port: number; created: string; expires: string; url: string }
export interface RpcRequest { method: string; params?: Record<string, unknown> }

/**
 * Files. The API serves two roots: the workspace (`/workspace`) and home
 * (`/home/coder`, hidden in the app by default). Every path it takes or returns
 * is absolute; a relative one is taken against the workspace root, and `~` or
 * `~/…` against home.
 *
 * Linux filenames are bytes. A byte that is not valid UTF-8 travels as the
 * lone surrogate U+DC80 + (byte − 0x80), so every name round-trips exactly:
 * send a `path` back unchanged in a JSON body, and through
 * {@link encodePathParam} in a query string. Such entries carry `rawName`.
 */
export type FileRoot = "workspace" | "home";
export type FileType = "file" | "dir" | "symlink" | "other";
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored" | "conflicted";
export interface FileEntry {
  name: string; path: string; type: FileType;
  /** Bytes; 0 for a directory. */
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  /** A symlink's link text, exactly as written. */
  target?: string;
  /** What a symlink leads to; null when it is broken or leads out of its root. */
  targetType?: Exclude<FileType, "symlink"> | null;
  /** Working-tree status when the entry is inside a git repository; null when clean. */
  git?: GitFileStatus | null;
  /** The name is not valid UTF-8 (see above). */
  rawName?: true;
}
/** `GET /api/files/list`: a directory, capped at `limit` entries per page. */
export interface FileListing {
  path: string; root: FileRoot; entries: FileEntry[];
  /** Entries in the directory after the hidden filter, across all pages. */
  total: number; offset: number;
  /** More entries follow this page. */
  truncated: boolean;
}
/** Something in the trash, with where it came from. */
export interface TrashItem {
  id: string; name: string; originalPath: string; root: FileRoot; type: FileType;
  /** Bytes for a file; null for a directory. */
  size: number | null;
  trashedAt: number;
}
/** A chunked upload in progress (or just finished). */
export interface UploadSession {
  id: string; path: string; size: number;
  /** Bytes accepted so far; the next chunk goes at this offset. */
  received: number;
  overwrite: boolean; created: number; updated: number; done: boolean;
}
/**
 * `GET /api/system`: how the sandbox is doing. CPU and memory are the
 * bridge's own cgroup (v2), which is the sandbox container the agents run in;
 * `limit` is null when the cgroup sets none.
 */
export interface SystemInfo {
  at: number;
  /** False when no cgroup v2 files could be read; the figures fall back to the host's. */
  cgroup: boolean;
  cpu: {
    /** CPUs busy over the last sample (0.5 = half of one core); null before a second sample exists. */
    usage: number | null;
    /** CPUs the cgroup may use, e.g. 2; null when unlimited. */
    limit: number | null;
    /** Logical CPUs on the host. */
    cores: number;
  };
  memory: {
    /** Bytes in use, not counting reclaimable page cache. */
    used: number;
    limit: number | null;
    /** The host's memory. */
    total: number;
  };
  pids: { current: number | null; limit: number | null };
  disks: SystemDisk[];
  /** Seconds. `box` is since the sandbox started; null when it cannot be told. */
  uptime: { box: number | null; bridge: number; host: number };
  /** The busiest processes, most CPU first. */
  processes: SystemProcess[];
  versions: SystemVersions;
}
export interface SystemDisk { label: FileRoot; path: string; total: number; used: number; available: number }
export interface SystemProcess {
  pid: number; name: string; command: string;
  /** Percent of one core over the last sample. */
  cpu: number;
  /** Resident bytes. */
  memory: number;
}
export interface SystemVersions {
  agentbox: string | null; herdr: string | null; codeServer: string | null; node: string;
  /** Each coding-agent CLI found on PATH. */
  agents: { name: string; version: string | null }[];
}
/** Percent-encode a (possibly byte-escaped) path for a query string. */
export function encodePathParam(path: string): string {
  let out = "";
  for (const ch of path) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0xdc80 && cp <= 0xdcff ? `%${(cp - 0xdc00).toString(16).toUpperCase()}` : encodeURIComponent(ch);
  }
  return out;
}
