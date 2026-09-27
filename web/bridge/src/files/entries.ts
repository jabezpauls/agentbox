import type { Dirent, Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileEntry, FileListing, FileType, GitFileStatus } from "@workbench/shared";
import { decodeName, fsPath, hasEscapes } from "./names.js";
import { fsError, FilesError, within, type Roots, type TargetRef } from "./roots.js";

/** The most entries one listing page carries. */
export const MAX_PAGE = 5000;

export function typeOf(st: Stats | Dirent): FileType {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/** Git status lookup for one entry, bound to the repository it sits in. */
export type GitLookup = (abs: string, isDir: boolean) => GitFileStatus | null;

/**
 * Describe the entry at `fs` (a real path), reported as `abs`. A symlink is
 * described as itself, plus what it leads to when that is inside `rootReal`.
 */
export async function describe(abs: string, fs: string, rootReal: string, git?: GitLookup): Promise<FileEntry> {
  let st: Stats;
  try {
    st = await fsp.lstat(fsPath(fs));
  } catch (err) {
    throw fsError(err, abs);
  }
  return describeStat(abs, fs, st, rootReal, git);
}

async function describeStat(abs: string, fs: string, st: Stats, rootReal: string, git?: GitLookup): Promise<FileEntry> {
  const name = abs === "/" ? "/" : path.basename(abs);
  const type = typeOf(st);
  const entry: FileEntry = {
    name,
    path: abs,
    type,
    size: type === "dir" ? 0 : st.size,
    mtime: Math.round(st.mtimeMs),
  };
  if (hasEscapes(name)) entry.rawName = true;
  if (type === "symlink") {
    try {
      entry.target = decodeName(await fsp.readlink(fsPath(fs), { encoding: "buffer" }));
    } catch {
      entry.target = "";
    }
    entry.targetType = null;
    try {
      const real = decodeName(await fsp.realpath(fsPath(fs), { encoding: "buffer" }));
      if (within(real, rootReal)) {
        const t = typeOf(await fsp.stat(fsPath(real)));
        entry.targetType = t === "symlink" ? null : t;
      }
    } catch {
      // Broken or looping: the link exists, its target does not.
    }
  }
  if (git) entry.git = git(abs, type === "dir" || entry.targetType === "dir");
  return entry;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A directory's names, in the order a person reads them: folders first. */
export interface Named {
  name: string;
  dir: boolean;
}

export interface ListingCacheOptions {
  /** How long a listing is kept; 0 keeps nothing. */
  ttlMs?: number;
  /** At most this many directories… */
  maxDirs?: number;
  /** …holding at most this many names between them. */
  maxNames?: number;
  /** How long a directory must have gone unchanged before its listing is kept. */
  settleMs?: number;
}

/**
 * Directories' sorted names, kept for a few seconds so paging through a big
 * folder — or a WebDAV client listing it again — does not read and sort the
 * whole of it for every page. An entry is used only while the directory's
 * modification time, change time and inode are what they were when it was
 * read, so adding, removing or renaming anything in it is seen at once.
 *
 * That holds only if every change moves the timestamp, and timestamps come
 * from a clock that ticks coarsely: the kernel's (a scheduler tick, before
 * Linux 6.13's fine-grained timestamps) or the filesystem's (whole seconds on
 * some, two on FAT). A second change within the tick of the first leaves the
 * stamp as it was. So a directory whose modification time is younger than
 * `settleMs` is read afresh every time and never kept: any later change to a
 * directory that has settled lands in a later tick.
 */
export class ListingCache {
  private readonly cache = new Map<string, { at: number; stamp: string; names: Named[] }>();
  private held = 0;
  private readonly ttlMs: number;
  private readonly maxDirs: number;
  private readonly maxNames: number;
  private readonly settleMs: number;

  constructor(opts: ListingCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5000;
    this.maxDirs = opts.maxDirs ?? 64;
    this.maxNames = opts.maxNames ?? 200_000;
    this.settleMs = opts.settleMs ?? 2000;
  }

  /** What is held now: directories, and names across them. */
  get size(): { dirs: number; names: number } {
    return { dirs: this.cache.size, names: this.held };
  }

  async names(real: string, where: string): Promise<Named[]> {
    const now = Date.now();
    this.expire(now);
    let stamp: string;
    let mtimeMs: number;
    let dirents: Dirent<Buffer>[];
    try {
      const st = await fsp.stat(fsPath(real), { bigint: true });
      stamp = `${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
      mtimeMs = Number(st.mtimeNs / 1_000_000n);
      const hit = this.cache.get(real);
      if (hit && hit.stamp === stamp) {
        // Most recently used last, so the least recently used goes first.
        this.cache.delete(real);
        this.cache.set(real, hit);
        return hit.names;
      }
      dirents = await fsp.readdir(fsPath(real), { withFileTypes: true, encoding: "buffer" });
    } catch (err) {
      throw fsError(err, where);
    }
    const names = dirents
      .map((d) => ({ name: decodeName(d.name), dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
    this.forget(real);
    // `now` was read before the stat, so a change after the read above
    // happens later still. A timestamp in the future is never settled.
    const settled = now - mtimeMs >= this.settleMs;
    if (this.ttlMs > 0 && settled && names.length <= this.maxNames) {
      this.cache.set(real, { at: now, stamp, names });
      this.held += names.length;
      while (this.cache.size > this.maxDirs || this.held > this.maxNames) this.forget(this.cache.keys().next().value!);
    }
    return names;
  }

  private forget(real: string): void {
    const kept = this.cache.get(real);
    if (!kept) return;
    this.cache.delete(real);
    this.held -= kept.names.length;
  }

  /** Drop what has outlived its time, used or not, so nothing idles in memory. */
  private expire(now: number): void {
    for (const [real, kept] of this.cache) if (now - kept.at >= this.ttlMs) this.forget(real);
  }
}

export interface ListOptions {
  hidden: boolean;
  offset: number;
  limit: number;
  git?: GitLookup;
  /** Where sorted names are kept between pages; none reads afresh. */
  cache?: ListingCache;
}

/**
 * One page of a directory: directories first, then by name, as a person
 * reads them. The names are read and sorted once — and kept briefly, for the
 * next page — before anything is stat'ed, so a page of a 100 000-entry
 * directory costs a page of `lstat`s, not the whole directory's.
 */
export async function listDirectory(roots: Roots, dir: TargetRef, opts: ListOptions): Promise<FileListing> {
  const rootReal = await roots.realRoot(dir.root);
  const all = await (opts.cache ?? new ListingCache({ ttlMs: 0 })).names(dir.real, dir.abs);
  const named = opts.hidden ? all : all.filter((d) => !d.name.startsWith("."));

  const page = named.slice(opts.offset, opts.offset + opts.limit);
  const entries = await mapLimit(page, 64, async (d) => {
    const abs = path.join(dir.abs, d.name);
    try {
      return await describe(abs, path.join(dir.real, d.name), rootReal, opts.git);
    } catch (err) {
      // Deleted between readdir and lstat: leave it out rather than fail.
      if (err instanceof FilesError && err.status === 404) return null;
      throw err;
    }
  });
  const kept = entries.filter((e): e is FileEntry => e !== null);
  return {
    path: dir.abs,
    root: dir.root.id,
    entries: kept,
    total: named.length,
    offset: opts.offset,
    truncated: opts.offset + page.length < named.length,
  };
}

/** `Promise.all` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
