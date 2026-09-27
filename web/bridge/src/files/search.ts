import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { decodeName, fsPath } from "./names.js";
import { within } from "./roots.js";

/** Directories no name search descends into. */
const SKIP = new Set([".git", "node_modules", ".agentbox"]);

export interface SearchOptions {
  /** Where to search (a real directory inside a root). */
  dir: string;
  query: string;
  limit: number;
  /** Override the fd binary lookup (tests); null forces the built-in walker. */
  fd?: string | null;
  timeoutMs?: number;
}

/** Find `fdfind` (Debian's name for it) or `fd` on PATH, once. */
let fdCache: string | null | undefined;
export function findFd(env = process.env): string | null {
  if (fdCache !== undefined) return fdCache;
  fdCache = null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const name of ["fdfind", "fd"]) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        fdCache = candidate;
        return fdCache;
      } catch {
        // keep looking
      }
    }
  }
  return fdCache;
}

/**
 * How well a path matches: a name that starts with the query beats one that
 * merely contains it, which beats a match only in a parent directory; then
 * shallower and shorter paths first. Lower is better.
 */
export function score(rel: string, query: string): number {
  const q = query.toLowerCase();
  const name = path.basename(rel).toLowerCase();
  let s = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
  s = s * 1000 + rel.split("/").length * 10 + Math.min(rel.length, 9);
  return s;
}

/**
 * File-name search for the palette: absolute real paths of up to `limit`
 * matches, best first. Uses fd when the box has it (it respects .gitignore and
 * is fast on big trees), otherwise a bounded walk that skips the usual heavy
 * directories.
 */
export async function searchNames(opts: SearchOptions): Promise<string[]> {
  const query = opts.query.trim();
  if (!query) return [];
  const fd = opts.fd === undefined ? findFd() : opts.fd;
  // Gather more than asked so the ranking has something to choose from.
  const gather = Math.min(opts.limit * 10, 2000);
  const found = fd ? await runFd(fd, opts.dir, query, gather, opts.timeoutMs ?? 5000) : await walk(opts.dir, query, gather);
  const scored = found
    .filter((p) => within(p, opts.dir) && p !== opts.dir)
    .map((p) => ({ p, s: score(path.relative(opts.dir, p), query) }))
    .sort((a, b) => a.s - b.s || a.p.localeCompare(b.p));
  return scored.slice(0, opts.limit).map((x) => x.p);
}

function runFd(bin: string, dir: string, query: string, max: number, timeoutMs: number): Promise<string[]> {
  const args = [
    "--fixed-strings",
    "--ignore-case",
    "--absolute-path",
    "--print0",
    "--color=never",
    "--max-results",
    String(max),
    ...[...SKIP].flatMap((d) => ["--exclude", d]),
  ];
  // A query with a slash is about where a file is, not just what it is called.
  if (query.includes("/")) args.push("--full-path");
  args.push("--", query, dir);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    const done = (): void => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      const paths: string[] = [];
      let start = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] === 0) {
          paths.push(decodeName(out.subarray(start, i)).replace(/\/+$/, ""));
          start = i + 1;
        }
      }
      resolve(paths);
    };
    child.on("error", done);
    child.on("close", done);
  });
}

/** The fallback: breadth-first, hidden entries and heavy directories skipped. */
async function walk(dir: string, query: string, max: number): Promise<string[]> {
  const q = query.toLowerCase();
  const full = q.includes("/");
  const out: string[] = [];
  const queue = [dir];
  let visited = 0;
  while (queue.length > 0 && out.length < max && visited < 20_000) {
    const d = queue.shift()!;
    visited += 1;
    let names: Buffer[];
    try {
      names = await fsp.readdir(fsPath(d), { encoding: "buffer" });
    } catch {
      continue;
    }
    for (const raw of names) {
      const name = decodeName(raw);
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const p = path.join(d, name);
      const hay = (full ? path.relative(dir, p) : name).toLowerCase();
      if (hay.includes(q)) out.push(p);
      const st = await fsp.lstat(fsPath(p)).catch(() => null);
      if (st?.isDirectory()) queue.push(p);
    }
  }
  return out;
}
