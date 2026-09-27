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

/**
 * Directories' sorted names, kept for a few seconds so paging through a big
 * folder — or a WebDAV client listing it again — does not read and sort the
 * whole of it for every page. An entry is used only while the directory's
 * modification time, change time and inode are what they were when it was
 * read, so adding, removing or renaming anything in it is seen at once.
 */
export class ListingCache {
  private readonly cache = new Map<string, { at: number; stamp: string; names: Named[] }>();

  constructor(
    private readonly ttlMs = 5000,
    private readonly max = 64,
  ) {}

  async names(real: string, where: string): Promise<Named[]> {
    let stamp: string;
    let dirents: Dirent<Buffer>[];
    try {
      const st = await fsp.stat(fsPath(real), { bigint: true });
      stamp = `${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
      const hit = this.cache.get(real);
      if (hit && hit.stamp === stamp && Date.now() - hit.at < this.ttlMs) {
        // Most recently used last, so the oldest is evicted first.
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
    this.cache.delete(real);
    this.cache.set(real, { at: Date.now(), stamp, names });
    if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return names;
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
  const all = await (opts.cache ?? new ListingCache(0)).names(dir.real, dir.abs);
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
