import { useRef, useState } from "react";
import { PanelLeftClose, Plus } from "lucide-react";
import { useApp } from "../store/app.ts";
import { tabsOf } from "../store/session.ts";
import { WorkspaceRow } from "./WorkspaceRow.tsx";
import { AgentList } from "./AgentList.tsx";

interface Props {
  onCollapse(): void;
}

/**
 * The Workbench's own column: workspaces with their tabs, and every agent.
 * The app's rail carries the brand, the theme and the connection light now,
 * so this column is only the herdr session.
 */
export function Sidebar({ onCollapse }: Props) {
  const session = useApp((s) => s.session);
  const setUi = useApp((s) => s.setUi);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const focusTab = useApp((s) => s.focusTab);
  const focusPane = useApp((s) => s.focusPane);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState(false);
  const dragging = useRef(false);
  const isExpanded = (id: string) => !collapsed.has(id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The panel tracks the pointer 1:1 for the whole drag and only writes
  // localStorage on release; the width transition is off while `resizing`.
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    setResizing(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setSidebarWidth(e.clientX, { persist: false });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    setResizing(false);
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    setSidebarWidth(useApp.getState().ui.sidebarWidth);
  };

  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <h1 className="sidebar-title">Workbench</h1>
        <button
          className="icon-btn"
          onClick={() => setUi({ dialog: { kind: "workspace.new" } })}
          title="New workspace (⌃B ⇧N)"
          aria-label="New workspace"
        >
          <Plus size={15} />
        </button>
        <button className="icon-btn" onClick={onCollapse} title="Hide sidebar (⌘B)" aria-label="Hide sidebar">
          <PanelLeftClose size={15} />
        </button>
      </div>

      <nav className="sidebar-scroll" aria-label="Workspaces and agents">
        <section className="sb-section">
          <div className="sb-heading">
            <h2 className="section-label">Workspaces</h2>
          </div>
          {session.workspaces.length === 0 ? (
            <p className="sb-empty">No workspaces yet. Open the palette and run “New workspace”.</p>
          ) : (
            <ul className="ws-list">
              {session.workspaces.map((w) => (
                <WorkspaceRow
                  key={w.workspace_id}
                  workspace={w}
                  tabs={tabsOf(session, w.workspace_id)}
                  expanded={isExpanded(w.workspace_id)}
                  focused={w.workspace_id === session.focusedWorkspaceId}
                  focusedTabId={session.focusedTabId}
                  onToggleExpand={() => toggle(w.workspace_id)}
                  onFocusWorkspace={() => focusWorkspace(w.workspace_id)}
                  onFocusTab={(tid) => focusTab(tid)}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="sb-section">
          <div className="sb-heading">
            <h2 className="section-label">Agents</h2>
          </div>
          <AgentList session={session} onFocusPane={focusPane} />
        </section>
      </nav>

      <div
        className={`sidebar-resize${resizing ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
}
