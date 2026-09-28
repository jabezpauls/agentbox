import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@workbench/shared";
import { HttpError } from "../../api/http.ts";
import { filesApi } from "../../files/api.ts";
import { dirname } from "../../files/paths.ts";

/** Entries fetched per page; the API allows up to 5000. */
export const PAGE = 1000;

export interface Listing {
  /** The folder shown. */
  dir: string;
  /** When the route named a file: that file (its folder is `dir`). */
  file: string | null;
  entries: FileEntry[];
  total: number;
  truncated: boolean;
  status: "loading" | "ready" | "error" | "missing";
  error: string | null;
  /** The API's reason for an error (`outside`, `not-readable`…). */
  code?: string | null;
}

const EMPTY: Listing = { dir: "", file: null, entries: [], total: 0, truncated: false, status: "loading", error: null };

/**
 * Read a folder a page at a time until at least `count` entries are in hand
 * (or it ends). A refresh must bring back as much as was loaded — asking for
 * it all in one request would be cut at the API's cap, and a big folder
 * scrolled past it would lose rows, and the selection in them, on the next
 * poll. Pages can shift under a folder being written to; an entry seen twice
 * is kept once.
 */
export async function readPages(
  dir: string,
  count: number,
  hidden: boolean,
  signal?: AbortSignal,
): Promise<Pick<Listing, "entries" | "total" | "truncated">> {
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let truncated = false;
  do {
    const page = await filesApi.list(dir, { hidden, offset, limit: PAGE }, signal);
    offset += page.entries.length;
    total = page.total;
    truncated = page.truncated;
    for (const e of page.entries) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      entries.push(e);
    }
    if (page.entries.length === 0) break;
  } while (truncated && offset < count);
  return { entries, total, truncated };
}

/**
 * A folder's contents, for the path the route names. A path that turns out
 * to be a file lists its folder instead and says which file was meant, so a
 * link to a file opens it in quick look. `refresh` re-reads what is loaded
 * (after a change, or on the polling beat) without blanking the list;
 * `loadMore` reads the next page of a big folder.
 */
export function useListing(target: string | null, hidden: boolean) {
  const [listing, setListing] = useState<Listing>(EMPTY);
  const current = useRef<Listing>(EMPTY);
  current.current = listing;
  const gen = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  // A new folder being read: a refresh of the old one must not overtake it.
  const navigating = useRef(false);

  const load = useCallback(
    async (path: string, keep: boolean, file: string | null = null) => {
      const my = ++gen.current;
      // A newer read makes this one pointless: stop it on the wire too.
      inflight.current?.abort();
      const abort = new AbortController();
      inflight.current = abort;
      try {
        let dir = path;
        let page;
        try {
          page = await readPages(dir, keep ? current.current.entries.length : 0, hidden, abort.signal);
        } catch (err) {
          if (!(err instanceof HttpError && err.code === "not-a-directory")) throw err;
          file = path;
          dir = dirname(path);
          page = await readPages(dir, 0, hidden, abort.signal);
        }
        if (my !== gen.current) return;
        setListing({ dir, file, entries: page.entries, total: page.total, truncated: page.truncated, status: "ready", error: null });
      } catch (err) {
        if (my !== gen.current) return;
        const missing = err instanceof HttpError && err.status === 404;
        setListing((l) => ({
          ...(keep ? l : EMPTY),
          dir: keep ? l.dir : path,
          status: missing ? "missing" : "error",
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof HttpError ? (err.code ?? null) : null,
        }));
      }
    },
    [hidden],
  );

  useEffect(() => {
    if (target === null) return;
    // Keep showing the old folder for a moment; a loading state only if it
    // takes long enough to be seen.
    const t = setTimeout(() => {
      if (current.current.dir !== target) setListing((l) => (l.dir === target ? l : { ...EMPTY, dir: target }));
    }, 180);
    navigating.current = true;
    void load(target, false).finally(() => {
      navigating.current = false;
      clearTimeout(t);
    });
    return () => clearTimeout(t);
  }, [target, load]);

  const refresh = useCallback(() => {
    const l = current.current;
    if (!l.dir || l.status === "loading" || navigating.current) return Promise.resolve();
    return load(l.dir, true, l.file);
  }, [load]);

  const loadMore = useCallback(async () => {
    const l = current.current;
    if (!l.truncated || l.status !== "ready") return;
    const my = gen.current;
    try {
      const page = await filesApi.list(l.dir, { hidden, offset: l.entries.length, limit: PAGE });
      // A refresh or a move since: its rows are the truth, not an append to them.
      if (my !== gen.current) return;
      setListing((prev) => {
        if (prev.dir !== l.dir) return prev;
        const have = new Set(prev.entries.map((e) => e.path));
        return { ...prev, entries: [...prev.entries, ...page.entries.filter((e) => !have.has(e.path))], truncated: page.truncated, total: page.total };
      });
    } catch {
      // The next scroll tries again.
    }
  }, [hidden]);

  return { listing, refresh, loadMore };
}
