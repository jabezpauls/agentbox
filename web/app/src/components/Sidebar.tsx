import { useState } from "react";
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
const THEME_LABEL = { system: "System theme", light: "Light theme", dark: "Dark theme" } as const;

const CONN_TEXT = { connecting: "Connecting", open: "Connected", closed: "Reconnecting" } as const;

export function Sidebar({ theme, onCycleTheme, onCollapse }: Props) {
  const session = useApp((s) => s.session);
  const status = useApp((s) => s.status);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const focusTab = useApp((s) => s.focusTab);
  const focusPane = useApp((s) => s.focusPane);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isExpanded = (id: string) => !collapsed.has(id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <span className="brand">Workbench</span>
      </div>

      <nav className="sidebar-scroll" aria-label="Workspaces and agents">
        <section className="sb-section">
          <h2 className="sb-heading">Workspaces</h2>
          {session.workspaces.length === 0 ? (
            <p className="agents-empty">No workspaces yet.</p>
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
          <h2 className="sb-heading">Agents</h2>
          <AgentList session={session} onFocusPane={focusPane} />
        </section>
      </nav>

      <footer className="sidebar-foot">
        <span className={`conn-pill is-${status}`} title={`herdr: ${CONN_TEXT[status]}`}>
          <span className="conn-dot" aria-hidden="true" />
          {CONN_TEXT[status]}
        </span>
        <div className="foot-actions">
          <button className="icon-btn" onClick={onCycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
            <ThemeIcon size={16} />
          </button>
          <button className="icon-btn" onClick={onCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">
            <PanelLeftClose size={16} />
          </button>
        </div>
      </footer>
    </div>
  );
}
