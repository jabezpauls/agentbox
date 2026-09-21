import { ChevronRight, X } from "lucide-react";
import type { TabInfo, WorkspaceInfo } from "@workbench/shared";
import { call } from "../api/call.ts";
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
          aria-label={expanded ? `Collapse ${workspace.label}` : `Expand ${workspace.label}`}
          aria-expanded={expanded}
        >
          <ChevronRight size={12} />
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
              <div className={`tab-item-row${t.tab_id === focusedTabId ? " is-focused" : ""}`}>
                <button className="tab-item" onClick={() => onFocusTab(t.tab_id)} title={t.label}>
                  <StatusBadge status={t.agent_status} muted={t.agent_status === "unknown"} />
                  <span className="tab-item-label">{t.label}</span>
                </button>
                {/* Row actions stay hidden until the row is hovered or focused,
                    so a long list of tabs reads as names, not as buttons. */}
                <button
                  className="icon-btn is-sm row-action"
                  aria-label={`Close tab ${t.label}`}
                  title="Close tab"
                  onClick={() => void call("tab.close", { tab_id: t.tab_id })}
                >
                  <X size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
