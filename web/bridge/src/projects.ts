import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ListeningPort,
  PaneInfo,
  Project,
  ProjectAgent,
  ProjectCloneEvent,
  ProjectCloneStart,
  ProjectGit,
  SessionSnapshot,
} from "@workbench/shared";
import type { BridgeEvents } from "./events.js";
import { mapLimit } from "./files/entries.js";
import { decodeName, fsPath } from "./files/names.js";
import { fsError, FilesError, STATE_DIR, within } from "./files/roots.js";
import type { FilesService } from "./files/service.js";
import { noClobberRename, removeTree } from "./files/tree.js";

export interface ProjectsDeps {
  files: FilesService;
  /** herdr's session, for the panes working in each project. */
  snapshot: () => Promise<Pick<SessionSnapshot, "panes">>;
  /** Listening sockets with their owning process's cwd. */
  scanPorts: () => Promise<ListeningPort[]>;
  events: BridgeEvents;
  /** The git binary (tests). */
  git?: string;
}

/**
 * A project name: one path segment a person would type. No slashes, no
 * leading dot (a hidden directory is not a project card), nothing that is not
 * printable, and short enough for any filesystem.
 */
export function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw new FilesError(400, "name required");
  const name = raw.trim();
  if (name === "" || name === "." || name === "..") throw new FilesError(400, "name required");
  if (name.startsWith(".")) throw new FilesError(400, "a project name cannot start with a dot");
  if (/[/\\\0]/.test(name) || /\p{Cc}/u.test(name)) throw new FilesError(400, "a project name is one plain folder name");
  if (Buffer.byteLength(name) > 255) throw new FilesError(400, "name too long");
  return name;
}

/**
 * What `git clone` is allowed to fetch from: https, http, ssh and git URLs,
 * and scp-style `user@host:path`. Anything else — a local path, `file://`,
 * the `ext::` transport that runs a command, or a leading dash that git would
 * read as an option — is refused before git sees it.
 */
export function checkUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new FilesError(400, "url required");
  const url = raw.trim();
  if (url.length === 0 || url.length > 2048) throw new FilesError(400, "url required");
  if (/[\s\0]/.test(url) || url.startsWith("-")) throw new FilesError(400, "not a repository URL");
  // A user or host that starts with a dash is how ssh options were once
  // smuggled through git (CVE-2017-1000117); git refuses them today, and so
  // does this, before git is involved.
  const scheme = /^(https?|ssh|git):\/\/(?:[^/@]*@)?[A-Za-z0-9[][^/]*/i.test(url) && !/:\/\/[^/]*@-/.test(url);
  const scp = /^[A-Za-z0-9_][\w.-]*@[A-Za-z0-9][\w.-]*:(?!\/\/)[^:]+$/.test(url);
  if (!scheme && !scp) throw new FilesError(400, "use an https, ssh or git URL, or user@host:path");
  return url;
}

/** The folder a URL clones into by default: its last segment, less `.git`. */
export function nameFromUrl(url: string): string {
  const tail = url.replace(/[/:]+$/, "").split(/[/:]/).pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

/** Parse `Receiving objects:  42% (123/456)` out of git's progress output. */
export function parseProgress(line: string): { stage: string; percent: number } | null {
  const m = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]+):\s+(\d{1,3})%/.exec(line.trim());
  return m ? { stage: m[1]!.trim(), percent: Number(m[2]) } : null;
}

/**
 * The projects on Home: every top-level directory of the workspace, with its
 * git state, the panes working in it and the servers it runs; and making new
 * ones, empty or cloned.
 */
export class Projects {
  private readonly clones = new Map<string, { name: string; child: ChildProcess }>();

  constructor(private readonly deps: ProjectsDeps) {}

  private get root(): string {
    return this.deps.files.roots.workspace.path;
  }

  async list(): Promise<Project[]> {
    const rootReal = await this.deps.files.roots.realRoot(this.deps.files.roots.workspace);
    let dirents;
    try {
      dirents = await fsp.readdir(fsPath(rootReal), { withFileTypes: true, encoding: "buffer" });
    } catch (err) {
      throw fsError(err, this.root);
    }
    const names = dirents
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => decodeName(d.name))
      .filter((n) => !n.startsWith("."));
    const [snap, ports] = await Promise.all([
      this.deps.snapshot().catch(() => ({ panes: [] as PaneInfo[] })),
      this.deps.scanPorts().catch(() => [] as ListeningPort[]),
    ]);
    const projects = await mapLimit(names, 4, (name) => this.describe(name, rootReal, snap.panes, ports).catch(() => null));
    return projects
      .filter((p): p is Project => p !== null)
      .sort((a, b) => b.lastChange - a.lastChange || a.name.localeCompare(b.name));
  }

  private async describe(name: string, rootReal: string, panes: PaneInfo[], ports: ListeningPort[]): Promise<Project | null> {
    const abs = path.join(this.root, name);
    // A symlinked project counts only if it is a directory inside the root.
    const real = decodeName(await fsp.realpath(fsPath(path.join(rootReal, name)), { encoding: "buffer" }));
    if (!within(real, rootReal)) return null;
    const st = await fsp.stat(fsPath(real));
    if (!st.isDirectory()) return null;

    let git: ProjectGit | null = null;
    const top = await this.deps.files.git.repoFor(abs, abs);
    if (top) {
      const [status, lastCommit] = await Promise.all([this.deps.files.git.status(top), this.deps.files.git.lastCommit(top)]);
      if (status) {
        git = {
          branch: status.branch,
          detached: status.detached,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          uncommitted: status.changed,
          lastCommit,
        };
      }
    }

    const inside = (dir: string | null | undefined): dir is string => !!dir && (within(dir, abs) || within(dir, real));
    const agents: ProjectAgent[] = [];
    for (const p of panes) {
      const cwd = p.foreground_cwd ?? p.cwd;
      if (!inside(cwd)) continue;
      agents.push({ paneId: p.pane_id, workspaceId: p.workspace_id, agent: p.agent ?? null, status: p.agent_status, cwd });
    }
    const listeners = ports
      .filter((l) => !l.system && inside(l.cwd))
      .map((l) => ({ port: l.port, pid: l.pid, process: l.process, cwd: l.cwd as string }));

    return {
      name,
      path: abs,
      git,
      lastChange: Math.max(git?.lastCommit ?? 0, Math.round(st.mtimeMs)),
      agents,
      listeners,
    };
  }

  /** One project by name, described like the list does. */
  private async one(name: string): Promise<Project> {
    const rootReal = await this.deps.files.roots.realRoot(this.deps.files.roots.workspace);
    const project = await this.describe(name, rootReal, [], []);
    if (!project) throw new FilesError(404, "no such project");
    return project;
  }

  /** An empty folder, for a project started from scratch. */
  async create(body: { name?: unknown }): Promise<Project> {
    const name = checkName(body.name);
    const dest = await this.deps.files.roots.creatable(path.join(this.root, name));
    try {
      await fsp.mkdir(fsPath(dest.fs));
    } catch (err) {
      throw fsError(err, dest.abs);
    }
    return this.one(name);
  }

  /**
   * Start `git clone` into a new top-level folder and answer at once; the
   * progress goes out as `project.clone` events. The clone is made under the
   * API's scratch space and renamed into place only when it is complete, so a
   * half-cloned folder never shows up as a project.
   */
  async clone(body: { url?: unknown; name?: unknown }): Promise<ProjectCloneStart> {
    const url = checkUrl(body.url);
    const name = checkName(body.name === undefined || body.name === "" ? nameFromUrl(url) : body.name);
    const dest = await this.deps.files.roots.creatable(path.join(this.root, name));
    const taken = await fsp.lstat(fsPath(dest.fs)).then(
      () => true,
      () => false,
    );
    if (taken || [...this.clones.values()].some((c) => c.name === name)) {
      throw new FilesError(409, `${name} already exists`, "exists");
    }

    const id = randomBytes(6).toString("hex");
    const scratchDir = path.join(this.deps.files.roots.stateDir(this.deps.files.roots.workspace), "clones");
    await fsp.mkdir(scratchDir, { recursive: true });
    const scratch = path.join(scratchDir, id);
    const start: ProjectCloneStart = { id, name, path: dest.abs, url };
    const emit = (e: Omit<ProjectCloneEvent, keyof ProjectCloneStart | "kind">): void =>
      this.deps.events.emit({ kind: "project.clone", ...start, ...e });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Nobody is at a terminal to answer a password or host-key prompt; a
      // private repository must fail rather than hang forever.
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    };
    const child = spawn(
      this.deps.git ?? "git",
      [
        // Only the network transports, whatever the URL said.
        "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always",
        "-c", "protocol.http.allow=always",
        "-c", "protocol.ssh.allow=always",
        "-c", "protocol.git.allow=always",
        "clone", "--progress", "--", url, scratch,
      ],
      { cwd: this.root, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    this.clones.set(id, { name, child });
    emit({ phase: "started" });

    let last = "";
    let lastStage = "";
    let lastSent = 0;
    let buffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split(/[\r\n]/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line.trim()) last = line.trim();
        const p = parseProgress(line);
        if (!p) continue;
        // At most a few updates a second, but every change of stage.
        const now = Date.now();
        if (p.stage !== lastStage || now - lastSent >= 250 || p.percent === 100) {
          lastStage = p.stage;
          lastSent = now;
          emit({ phase: "progress", stage: p.stage, percent: p.percent });
        }
      }
    });
    child.on("error", (err) => {
      this.clones.delete(id);
      void removeTree(scratch).catch(() => {});
      emit({ phase: "error", message: err.message });
    });
    child.on("close", (code) => {
      if (!this.clones.delete(id)) return;
      void (async () => {
        if (code !== 0) {
          await removeTree(scratch).catch(() => {});
          emit({ phase: "error", message: (buffer.trim() || last || `git exited with ${code}`).replace(/^fatal:\s*/, "") });
          return;
        }
        try {
          await noClobberRename(scratch, dest.fs);
          emit({ phase: "done" });
        } catch (err) {
          await removeTree(scratch).catch(() => {});
          const e = fsError(err, dest.abs);
          emit({ phase: "error", message: e.message });
        }
      })();
    });
    return start;
  }

  /** Stop any clone still running (the bridge is shutting down). */
  stop(): void {
    for (const { child } of this.clones.values()) child.kill("SIGTERM");
    this.clones.clear();
  }
}

/** Where abandoned clones wait to be swept: see {@link sweepClones}. */
export function clonesDir(root: string): string {
  return path.join(root, STATE_DIR, "clones");
}

/** Remove clones a restart left half-done, once they are a day old. */
export async function sweepClones(root: string, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(clonesDir(root));
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = path.join(clonesDir(root), name);
    const st = await fsp.lstat(p).catch(() => null);
    if (st && now - st.mtimeMs > 24 * 60 * 60 * 1000) {
      await removeTree(p);
      removed += 1;
    }
  }
  return removed;
}
