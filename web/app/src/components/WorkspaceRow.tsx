import { ChevronRight } from "lucide-react";
import type { TabInfo, WorkspaceInfo } from "@workbench/shared";
import { StatusBadge } from "./StatusBadge.tsx";

interface Props {
  workspace: WorkspaceInfo;
  tabs: TabInfo[];
  expanded: boolean;
  focused: boolean;
  focusedTabId: string | null;
  onToggleExpand(): void;
  onFocusWorkspace(): void;
  onFocusTab(tabId: string): void;
}

export function WorkspaceRow({
  workspace,
  tabs,
  expanded,
  focused,
  focusedTabId,
  onToggleExpand,
  onFocusWorkspace,
  onFocusTab,
}: Props) {
  const muted = workspace.agent_status === "unknown";
  return (
    <li className="ws">
      <div className={`ws-row${focused ? " is-focused" : ""}`}>
        <button
          className={`ws-chevron${expanded ? " is-open" : ""}`}
          onClick={onToggleExpand}
          aria-label={expanded ? "Collapse tabs" : "Expand tabs"}
          aria-expanded={expanded}
        >
          <ChevronRight size={14} strokeWidth={2.5} />
        </button>
        <button className="ws-main" onClick={onFocusWorkspace} title={workspace.label}>
          <span className="ws-num">{workspace.number}</span>
          <span className="ws-label">{workspace.label}</span>
          <StatusBadge status={workspace.agent_status} muted={muted} />
        </button>
      </div>
      {expanded && tabs.length > 0 && (
        <ul className="tab-list">
          {tabs.map((t) => (
            <li key={t.tab_id}>
              <button
                className={`tab-item${t.tab_id === focusedTabId ? " is-focused" : ""}`}
                onClick={() => onFocusTab(t.tab_id)}
                title={t.label}
              >
                <StatusBadge status={t.agent_status} muted={t.agent_status === "unknown"} />
                <span className="tab-item-label">{t.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
