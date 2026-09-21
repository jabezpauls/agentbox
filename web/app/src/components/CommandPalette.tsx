import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/app.ts";
import { actionCtx } from "../api/call.ts";
import { agentsSorted, paneTitle, tabsOf, type Session } from "../store/session.ts";
import { runAction, type ActionId } from "../keys/actions.ts";
import { searchItems, type PaletteItem } from "../palette/search.ts";
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

const KIND_LABEL: Record<PaletteItem["kind"], string> = {
  workspace: "Workspace",
  tab: "Tab",
  pane: "Pane",
  agent: "Agent",
  action: "Action",
};

/**
 * The command palette (⌘/Ctrl+K, or prefix+w filtered to workspaces). A fuzzy
 * search over every workspace, tab, pane and agent plus the action list, with
 * keyboard-first navigation and a live "open preview on port N" item.
 */
export function CommandPalette() {
  const palette = useApp((s) => s.ui.palette);
  const session = useApp((s) => s.session); // re-render as the session changes
  const setUi = useApp((s) => s.setUi);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const open = palette !== null;
  const mode = palette?.mode ?? "all";

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(
    () => (open ? buildItems(session, mode, query) : []),
    [open, mode, query, session],
  );

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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
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

  return (
    <div className="sheet-scrim palette-scrim" onMouseDown={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={mode === "workspaces" ? "Jump to a workspace…" : "Search or run a command…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Command palette query"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `palette-opt-${active}` : undefined}
        />
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={listRef}>
          {results.length === 0 && <li className="palette-empty">No matches</li>}
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`palette-opt-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={`palette-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(item);
              }}
            >
              {item.status ? <StatusBadge status={item.status} muted={item.status === "unknown"} /> : <span className="palette-kind">{KIND_LABEL[item.kind]}</span>}
              <span className="palette-label">{item.label}</span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
