import { useRef, useState } from "react";
import { Monitor, Moon, PanelLeftClose, Sun } from "lucide-react";
import { useApp } from "../store/app.ts";
import { tabsOf } from "../store/session.ts";
import type { Theme } from "../theme/useTheme.ts";
import { WorkspaceRow } from "./WorkspaceRow.tsx";
import { AgentList } from "./AgentList.tsx";

interface Props {
  theme: Theme;
  onCycleTheme(): void;
  onCollapse(): void;
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL = { system: "Follow the system theme", light: "Light theme", dark: "Dark theme" } as const;

const CONN_TEXT = { connecting: "Connecting", open: "Connected", closed: "Reconnecting" } as const;
const CONN_TITLE = {
  connecting: "Opening the connection to herdr.",
  open: "Connected to herdr.",
  closed: "The connection dropped. Reconnecting.",
} as const;

export function Sidebar({ theme, onCycleTheme, onCollapse }: Props) {
  const session = useApp((s) => s.session);
  const status = useApp((s) => s.status);
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

  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <span className="brand">Workbench</span>
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

      <footer className="sidebar-foot">
        <span className={`conn-pill is-${status}`} title={CONN_TITLE[status]}>
          <span className="conn-dot" aria-hidden="true" />
          {CONN_TEXT[status]}
        </span>
        <div className="foot-actions">
          <button className="icon-btn" onClick={onCycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
            <ThemeIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onCollapse} title="Hide sidebar (⌘B)" aria-label="Hide sidebar">
            <PanelLeftClose size={15} />
          </button>
        </div>
      </footer>

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
