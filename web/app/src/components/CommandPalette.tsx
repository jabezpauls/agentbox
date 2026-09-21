import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Boxes, Command, PanelTop, Search, SquareTerminal } from "lucide-react";
import { useApp } from "../store/app.ts";
import { actionCtx } from "../api/call.ts";
import { agentsSorted, paneTitle, tabsOf, type Session } from "../store/session.ts";
import { runAction, type ActionId } from "../keys/actions.ts";
import { searchItems, type PaletteItem, type PaletteKind } from "../palette/search.ts";
import { StatusBadge } from "./StatusBadge.tsx";

/** The standing action list (id + label), independent of the session. */
const ACTIONS: { id: ActionId; label: string }[] = [
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
  { id: "sidebar.toggle", label: "Toggle sidebar" },
  { id: "inspector.toggle", label: "Toggle inspector" },
  { id: "theme.toggle", label: "Toggle theme" },
];

function buildItems(session: Session, mode: string, query: string): PaletteItem[] {
  const s = useApp.getState();
  const items: PaletteItem[] = [];

  for (const w of session.workspaces) {
    items.push({
      id: `ws:${w.workspace_id}`,
      kind: "workspace",
      label: `Workspace: ${w.label}`,
      hint: `${w.tab_count} tab${w.tab_count === 1 ? "" : "s"}`,
      status: w.agent_status,
      run: () => s.focusWorkspace(w.workspace_id),
    });
  }
  if (mode === "workspaces") return searchItems(query, items);

  for (const w of session.workspaces) {
    for (const t of tabsOf(session, w.workspace_id)) {
      items.push({
        id: `tab:${t.tab_id}`,
        kind: "tab",
        label: `Tab: ${w.label} / ${t.label}`,
        status: t.agent_status,
        run: () => s.focusTab(t.tab_id),
      });
    }
  }
  for (const a of agentsSorted(session)) {
    const title = paneTitle(session.panes[a.pane_id], a);
    items.push({
      id: `agent:${a.pane_id}`,
      kind: "agent",
      label: `Agent: ${title}`,
      status: a.agent_status,
      run: () => s.focusPane(a.pane_id),
    });
  }
  for (const p of Object.values(session.panes)) {
    if (session.agents[p.pane_id]) continue; // agents already listed above
    items.push({
      id: `pane:${p.pane_id}`,
      kind: "pane",
      label: `Pane: ${paneTitle(p)}`,
      status: p.agent_status,
      run: () => s.focusPane(p.pane_id),
    });
  }
  for (const a of ACTIONS) {
    items.push({ id: `action:${a.id}`, kind: "action", label: a.label, run: () => runAction(a.id, actionCtx()) });
  }
  // "Open preview on port N" when the query mentions a number.
  const m = query.match(/\d{2,5}/);
  if (m) {
    const port = Number(m[0]);
    items.push({
      id: `preview:${port}`,
      kind: "action",
      label: `Open preview on port ${port}`,
      run: () => s.setInspector({ open: true, tab: "preview", port, path: "/" }),
    });
  }
  return searchItems(query, items);
}

const KIND_LABEL: Record<PaletteKind, string> = {
  workspace: "Workspaces",
  tab: "Tabs",
  pane: "Panes",
  agent: "Agents",
  action: "Commands",
};

const KIND_GLYPH: Record<PaletteKind, typeof Bot> = {
  workspace: Boxes,
  tab: PanelTop,
  pane: SquareTerminal,
  agent: Bot,
  action: Command,
};

/**
 * Group the ranked results by kind without disturbing the ranking: a group
 * appears in the order its best match did, and rows keep their score order
 * inside it. Grouping that reorders results would fight the search.
 */
function groupItems(items: PaletteItem[]): { kind: PaletteKind; items: PaletteItem[] }[] {
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

/** The query the list is actually filtered by lags typing by this much. */
const DEBOUNCE_MS = 120;

/**
 * The command palette (⌘/Ctrl+K, or prefix+w filtered to workspaces). A fuzzy
 * search over every workspace, tab, pane and agent plus the action list, with
 * keyboard-first navigation and a live "open preview on port N" item.
 *
 * Mouse and keyboard share one cursor: moving the pointer over a row selects
 * it, so Enter always runs the row under the eye. ↑/↓ wrap.
 */
export function CommandPalette() {
  const palette = useApp((s) => s.ui.palette);
  const session = useApp((s) => s.session); // re-render as the session changes
  const setUi = useApp((s) => s.setUi);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  // The pointer only takes the cursor once it has actually moved. Without this
  // a palette opened under a resting mouse selects whatever row landed beneath
  // it and scrolls there, instead of starting at the top.
  const [pointerLive, setPointerLive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const open = palette !== null;
  const mode = palette?.mode ?? "all";

  // Every open starts clean: a palette that remembers last time's query is a
  // palette you have to clear before you can use it.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setActive(0);
      setPointerLive(false);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (query === debounced) return;
    const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, debounced]);

  const results = useMemo(
    () => (open ? buildItems(session, mode, debounced) : []),
    [open, mode, debounced, session],
  );
  const groups = useMemo(() => groupItems(results), [results]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const close = () => setUi({ palette: null });
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = results.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (n === 0 ? 0 : (a + 1) % n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (n === 0 ? 0 : (a - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // The palette is a single focus stop: Tab must not walk behind the scrim.
      e.preventDefault();
    }
  };

  // One running index across every group, so ↑/↓ walk the flat list.
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
      >
        <div className="palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={mode === "workspaces" ? "Jump to a workspace…" : "Search workspaces, tabs, agents and commands…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Command palette query"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-opt-${active}` : undefined}
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={listRef}>
          {results.length === 0 && (
            <li className="empty">
              <p className="empty-title">Nothing matches that.</p>
              <p className="empty-sub">Try a shorter term, or a command name.</p>
            </li>
          )}
          {groups.map((group) => (
            <li key={group.kind}>
              <p className="section-label palette-group">
                {KIND_LABEL[group.kind]} · {group.items.length}
              </p>
              <ul role="group" aria-label={KIND_LABEL[group.kind]}>
                {group.items.map((item) => {
                  const i = ++index;
                  const Glyph = KIND_GLYPH[item.kind];
                  return (
                    <li
                      key={item.id}
                      id={`palette-opt-${i}`}
                      data-i={i}
                      style={{ ["--row-i" as string]: i }}
                      role="option"
                      aria-selected={i === active}
                      className={`palette-item${i === active ? " is-active" : ""}`}
                      onMouseEnter={() => pointerLive && setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(item);
                      }}
                    >
                      <span className="palette-glyph" aria-hidden="true">
                        <Glyph size={14} />
                      </span>
                      <span className="palette-label">{item.label}</span>
                      {item.hint && <span className="palette-hint">{item.hint}</span>}
                      {item.status && <StatusBadge status={item.status} muted={item.status === "unknown"} />}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
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
