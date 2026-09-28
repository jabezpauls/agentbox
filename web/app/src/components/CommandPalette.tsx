import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { FileEntry } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import { filesApi } from "../files/api.ts";
import { useApps } from "../apps/model.ts";
import { useProjects } from "../projects/model.ts";
import { useReviews } from "../shell/attention.ts";
import { openModal } from "../shell/activity.tsx";
import { buildItems, groupItems, KIND_GLYPH, KIND_LABEL } from "../palette/items.ts";
import { paletteEffects as effects } from "../palette/effects.ts";
import { StatusBadge } from "./StatusBadge.tsx";

/** The query the list is actually filtered by lags typing by this much. */
const DEBOUNCE_MS = 120;
/** Below this many characters, no file-name search is sent. */
const FILE_QUERY_MIN = 2;

/**
 * The command palette (⌘K, ⌃⌥K from anywhere, or prefix+w for workspaces):
 * one search over the surfaces, projects, files (by name, from the box),
 * agents, apps, reviews, the Workbench's workspaces, tabs and panes, and
 * every command. Grouped by kind, ranked within, keyboard first.
 *
 * Mouse and keyboard share one cursor: moving the pointer over a row selects
 * it, so Enter always runs the row under the eye. ↑/↓ wrap.
 */
export function CommandPalette() {
  const palette = useApp((s) => s.ui.palette);
  if (!palette) return null;
  // Each request is a fresh palette — built new, not reset — so nothing typed
  // last time can reach the new field before a reset would have landed.
  let key = requests.get(palette);
  if (key === undefined) {
    key = ++requestCount;
    requests.set(palette, key);
  }
  return <PaletteBody key={key} mode={palette.mode} />;
}

const requests = new WeakMap<object, number>();
let requestCount = 0;

function PaletteBody({ mode }: { mode: string }) {
  const session = useApp((s) => s.session);
  const health = useApp((s) => s.health);
  const projects = useProjects((s) => s.projects);
  const apps = useApps((s) => s.apps);
  const reviews = useReviews((s) => s.sessions);
  const setUi = useApp((s) => s.setUi);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [files, setFiles] = useState<{ q: string; entries: FileEntry[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  // The pointer only takes the cursor once it has actually moved. Without this
  // a palette opened under a resting mouse selects whatever row landed beneath
  // it and scrolls there, instead of starting at the top.
  const [pointerLive, setPointerLive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const open = true;

  // The keyboard goes to the field before anything is painted; what the
  // palette lists is read again.
  // Where the keyboard was, to give it back when the palette closes.
  const [returnTo] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));

  useLayoutEffect(() => {
    inputRef.current?.focus();
    void useProjects.getState().refresh();
    void useReviews.getState().refresh();
  }, []);

  useEffect(() => {
    if (query === debounced) return;
    const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, debounced]);

  // File names come from the box, for anything but a path or a port.
  useEffect(() => {
    const q = debounced.trim();
    if (!open || mode !== "all" || q.length < FILE_QUERY_MIN || /^[/~:]|^\d+$/.test(q)) {
      setFiles(null);
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    setSearching(true);
    filesApi
      .search(q, { limit: 12 }, abort.signal)
      .then((entries) => setFiles({ q, entries }))
      .catch(() => setFiles({ q, entries: [] }))
      .finally(() => {
        if (!abort.signal.aborted) setSearching(false);
      });
    return () => abort.abort();
  }, [debounced, open, mode]);

  const rank = (q: string) =>
    groupItems(
      buildItems(
        {
          session,
          projects,
          apps,
          reviews,
          files: files && files.q === q.trim() ? files.entries : null,
          workspaceRoot: health?.workspaceRoot ?? "/workspace",
        },
        effects,
        mode,
        q,
      ),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => (open ? rank(debounced) : []), [open, mode, debounced, session, projects, apps, reviews, files, health]);
  // One running order across every group, so ↑/↓ walk what is on screen.
  const flat = useMemo(() => results.flatMap((g) => g.items), [results]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const restore = () => {
    if (returnTo && document.contains(returnTo) && !returnTo.closest("[inert]")) returnTo.focus({ preventScroll: true });
  };
  /** Dismissed: the keyboard goes back where it was. */
  const close = () => {
    setUi({ palette: null });
    restore();
  };
  /**
   * Chosen: the choice decides where the keyboard goes. One that went
   * somewhere (another surface, a dialog) keeps it; one that changed nothing
   * about where you are (a theme, the dock) hands it back.
   */
  const run = (item: { run(): void }) => {
    const before = `${location.pathname}${location.search}`;
    setUi({ palette: null });
    item.run();
    requestAnimationFrame(() => {
      const moved = `${location.pathname}${location.search}` !== before;
      const modal = openModal();
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!moved && !modal && lost) restore();
    });
  };
  const choose = (i: number) => {
    const item = flat[i];
    if (item) run(item);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (n === 0 ? 0 : (a + 1) % n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (n === 0 ? 0 : (a - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Typed faster than the list follows: run the best match for what is
      // in the field now, not the row the old query left under the cursor.
      if (query !== debounced) {
        const best = rank(query).flatMap((g) => g.items)[0];
        if (best) run(best);
        return;
      }
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // The palette is a single focus stop: Tab must not walk behind the scrim.
      e.preventDefault();
    }
  };

  let index = -1;

  return (
    <div className="scrim palette-scrim" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={() => setPointerLive(true)}
        onBlur={(e) => {
          // A modal keeps the keyboard: whatever takes focus from outside
          // while the palette is open (a surface arriving, a dialog closing)
          // hands it straight back.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          requestAnimationFrame(() => {
            if (useApp.getState().ui.palette) inputRef.current?.focus();
          });
        }}
      >
        <div className="palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={mode === "workspaces" ? "Jump to a workspace…" : "Search projects, files, agents, apps and commands…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Command palette query"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={flat[active] ? `palette-opt-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={listRef}>
          {flat.length === 0 && !searching && (
            <li className="empty">
              <p className="empty-title">Nothing matches that.</p>
              <p className="empty-sub">Try a shorter term, a file name, or a command.</p>
            </li>
          )}
          {results.map((group) => (
            <li key={group.kind}>
              <p className="section-label palette-group">
                {KIND_LABEL[group.kind]} · {group.items.length}
              </p>
              <ul role="group" aria-label={KIND_LABEL[group.kind]}>
                {group.items.map((item) => {
                  const i = ++index;
                  const Glyph = item.icon ?? KIND_GLYPH[item.kind];
                  return (
                    <li
                      key={item.id}
                      id={`palette-opt-${i}`}
                      data-i={i}
                      style={{ ["--row-i" as string]: Math.min(i, 12) }}
                      role="option"
                      aria-selected={i === active}
                      className={`palette-item${i === active ? " is-active" : ""}`}
                      onMouseEnter={() => pointerLive && setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(i);
                      }}
                    >
                      <span className="palette-glyph" aria-hidden="true">
                        <Glyph size={14} />
                      </span>
                      <span className="palette-text">
                        <span className="palette-label">{item.label}</span>
                        {item.sub && <span className="palette-sub">{item.sub}</span>}
                      </span>
                      {item.hint && <span className="palette-hint">{item.hint}</span>}
                      {item.status && <StatusBadge status={item.status} muted={item.status === "unknown"} />}
                      {item.keys && <kbd className="kbd palette-keys">{item.keys}</kbd>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {searching && (
            <li>
              <p className="section-label palette-group">Searching files…</p>
            </li>
          )}
        </ul>

        <div className="palette-foot">
          <span className="palette-foot-item">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> Navigate
          </span>
          <span className="palette-foot-item">
            <kbd className="kbd">↵</kbd> Open
          </span>
          <span className="palette-foot-item">
            <kbd className="kbd">esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
