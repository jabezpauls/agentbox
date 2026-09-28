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
}

const EMPTY: Listing = { dir: "", file: null, entries: [], total: 0, truncated: false, status: "loading", error: null };

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

  const load = useCallback(
    async (path: string, keep: boolean, file: string | null = null) => {
      const my = ++gen.current;
      const abort = new AbortController();
      try {
        let dir = path;
        let page;
        try {
          page = await filesApi.list(dir, { hidden, limit: Math.max(PAGE, keep ? current.current.entries.length : 0) }, abort.signal);
        } catch (err) {
          if (!(err instanceof HttpError && err.code === "not-a-directory")) throw err;
          file = path;
          dir = dirname(path);
          page = await filesApi.list(dir, { hidden, limit: PAGE }, abort.signal);
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
    void load(target, false).finally(() => clearTimeout(t));
    return () => clearTimeout(t);
  }, [target, load]);

  const refresh = useCallback(() => {
    const l = current.current;
    if (!l.dir || l.status === "loading") return Promise.resolve();
    return load(l.dir, true, l.file);
  }, [load]);

  const loadMore = useCallback(async () => {
    const l = current.current;
    if (!l.truncated || l.status !== "ready") return;
    try {
      const page = await filesApi.list(l.dir, { hidden, offset: l.entries.length, limit: PAGE });
      setListing((prev) =>
        prev.dir === l.dir ? { ...prev, entries: [...prev.entries, ...page.entries], truncated: page.truncated, total: page.total } : prev,
      );
    } catch {
      // The next scroll tries again.
    }
  }, [hidden]);

  return { listing, refresh, loadMore };
}
