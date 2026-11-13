import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { GitFileStatus } from "@workbench/shared";
import { decodeName, fsPath, hasEscapes } from "./names.js";
import { within } from "./roots.js";
import type { GitLookup } from "./entries.js";

/** What `git status --porcelain=v2 --branch` says about one repository. */
export interface RepoStatus {
  /** The repository's top level, as the caller found it. */
  top: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, untracked and ignored paths relative to `top`, without trailing slashes. */
  files: Map<string, GitFileStatus>;
  /** Every directory (relative to `top`, `""` for the top) holding a change that is not ignored. */
  dirty: Set<string>;
  /** Entries that are not ignored: what "uncommitted" counts on a project card. */
  changed: number;
}

export interface GitOptions {
  /** How long a status stays fresh; the design's 2 s by default. */
  ttlMs?: number;
  timeoutMs?: number;
  git?: string;
}

/** Run git and collect stdout, or reject. */
export function runGit(
  args: string[],
  opts: { cwd: string; timeoutMs?: number; git?: string; maxBytes?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.git ?? "git", args, {
      cwd: opts.cwd,
      // Status must never take the index lock: an agent committing in the
      // same repository would otherwise see "index.lock exists" at random.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const max = opts.maxBytes ?? 64 * 1024 * 1024;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 10_000);
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) child.kill("SIGKILL");
      else chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git ${args[0]} failed (${signal ?? code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** Parse `git status --porcelain=v2 -z --branch` output. */
export function parseStatus(top: string, out: Buffer): RepoStatus {
  const status: RepoStatus = {
    top,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: new Map(),
    dirty: new Set(),
    changed: 0,
  };
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) {
      records.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < out.length) records.push(out.subarray(start));

  const add = (p: string, s: GitFileStatus): void => {
    const rel = p.replace(/\/+$/, "");
    status.files.set(rel, s);
    if (s === "ignored") return;
    status.changed += 1;
    let dir = path.posix.dirname(rel);
    for (;;) {
      const key = dir === "." ? "" : dir;
      if (status.dirty.has(key)) break;
      status.dirty.add(key);
      if (key === "") break;
      dir = path.posix.dirname(dir);
    }
  };

  for (let r = 0; r < records.length; r++) {
    const rec = decodeName(records[r]!);
    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") {
        status.detached = value === "(detached)";
        status.branch = status.detached ? null : value;
      } else if (key === "branch.upstream") {
        status.upstream = value;
      } else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === "?") add(rec.slice(2), "untracked");
    else if (kind === "!") add(rec.slice(2), "ignored");
    else if (kind === "1") add(fieldsAfter(rec, 8), classify(rec.slice(2, 4)));
    else if (kind === "2") {
      add(fieldsAfter(rec, 9), "renamed");
      r += 1; // the original path follows as its own record
    } else if (kind === "u") add(fieldsAfter(rec, 10), "conflicted");
  }
  return status;
}

/** The text after the first `n` space-separated fields (the path, which may hold spaces). */
function fieldsAfter(rec: string, n: number): string {
  let i = 0;
  for (let k = 0; k < n; k++) {
    i = rec.indexOf(" ", i) + 1;
    if (i === 0) return "";
  }
  return rec.slice(i);
}

function classify(xy: string): GitFileStatus {
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}

/**
 * Git status for the files API and the project cards, cached per repository
 * for a couple of seconds so a directory listing, a quick refresh and every
 * project card do not each fork a `git status`.
 */
export class GitStatusCache {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly git: string;
  private readonly cache = new Map<string, { at: number; value: Promise<RepoStatus | null> }>();

  constructor(opts: GitOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.git = opts.git ?? "git";
  }

  /**
   * The top of the repository containing `dir`, looking no higher than
   * `stop` (a root): the nearest ancestor with a `.git` entry.
   */
  async repoFor(dir: string, stop: string): Promise<string | null> {
    let d = dir;
    for (;;) {
      try {
        await fsp.lstat(fsPath(path.join(d, ".git")));
        return d;
      } catch {
        // not here
      }
      if (d === stop || !within(d, stop)) return null;
      d = path.dirname(d);
    }
  }

  /** The status of the repository at `top`, or null when git cannot say. */
  status(top: string): Promise<RepoStatus | null> {
    const now = Date.now();
    const hit = this.cache.get(top);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    // A child's working directory is a string; a repository whose path is not
    // valid UTF-8 cannot be named to git at all, so it simply has no marks.
    if (hasEscapes(top)) return Promise.resolve(null);
    const value = runGit(
      ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal", "--ignored=traditional"],
      { cwd: top, timeoutMs: this.timeoutMs, git: this.git },
    ).then(
      (out) => parseStatus(top, out),
      () => null,
    );
    this.cache.set(top, { at: now, value });
    // Keep the map from growing without bound across many repositories.
    if (this.cache.size > 256) {
      for (const [k, v] of this.cache) if (now - v.at >= this.ttlMs) this.cache.delete(k);
    }
    return value;
  }

  /** Seconds-since-epoch of the last commit, in milliseconds, or null. */
  async lastCommit(top: string): Promise<number | null> {
    try {
      const out = await runGit(["log", "-1", "--format=%ct"], { cwd: top, timeoutMs: this.timeoutMs, git: this.git });
      const n = Number(out.toString().trim());
      return Number.isFinite(n) && n > 0 ? n * 1000 : null;
    } catch {
      return null;
    }
  }

  /** A per-entry lookup for listing `dir`, or undefined outside any repository. */
  async lookupFor(dir: string, stop: string): Promise<GitLookup | undefined> {
    const top = await this.repoFor(dir, stop);
    if (!top) return undefined;
    const st = await this.status(top);
    if (!st) return undefined;
    return (abs, isDir) => statusOf(st, path.relative(top, abs).split(path.sep).join("/"), isDir);
  }
}

/** The status of one path in a repository, directories rolled up. */
export function statusOf(st: RepoStatus, rel: string, isDir: boolean): GitFileStatus | null {
  if (rel === ".git" || rel.startsWith(".git/")) return null;
  const own = st.files.get(rel);
  if (own) return own;
  if (isDir && st.dirty.has(rel)) return "modified";
  // Inside an untracked or ignored directory, git lists only the directory.
  let dir = path.posix.dirname(rel);
  while (dir !== "." && dir !== "") {
    const s = st.files.get(dir);
    if (s === "untracked" || s === "ignored") return s;
    dir = path.posix.dirname(dir);
  }
  return null;
}
