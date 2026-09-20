import { useEffect, useRef, useState } from "react";
import { PanelLeftOpen, Plus, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import { tabsOf } from "../store/session.ts";
import { rpc } from "../api/client.ts";
import { StatusBadge } from "./StatusBadge.tsx";

interface Props {
  sidebarOpen: boolean;
  onOpenSidebar(): void;
}

interface Menu {
  tabId: string;
  x: number;
  y: number;
}

export function TabBar({ sidebarOpen, onOpenSidebar }: Props) {
  const session = useApp((s) => s.session);
  const focusTab = useApp((s) => s.focusTab);
  const wid = session.focusedWorkspaceId;
  const tabs = wid ? tabsOf(session, wid) : [];

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const startRename = (tabId: string, label: string) => {
    setEditing(tabId);
    setDraft(label);
  };

  const commitRename = () => {
    if (!editing) return;
    const label = draft.trim();
    const current = tabs.find((t) => t.tab_id === editing);
    if (label && current && label !== current.label) {
      rpc("tab.rename", { tab_id: editing, label }).catch(() => {});
    }
    setEditing(null);
  };

  const newTab = () => {
    if (wid) rpc("tab.create", { workspace_id: wid }).catch(() => {});
  };

  const closeTab = (tabId: string) => {
    rpc("tab.close", { tab_id: tabId }).catch(() => {});
    setMenu(null);
  };

  return (
    <div className="tabbar">
      {!sidebarOpen && (
        <button className="icon-btn tabbar-menu" onClick={onOpenSidebar} title="Show sidebar" aria-label="Show sidebar">
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className="tabbar-tabs" role="tablist">
        {tabs.map((t) => {
          const active = t.tab_id === session.focusedTabId;
          return (
            <div
              key={t.tab_id}
              role="tab"
              aria-selected={active}
              className={`tab${active ? " is-active" : ""}`}
              onClick={() => editing !== t.tab_id && focusTab(t.tab_id)}
              onDoubleClick={() => startRename(t.tab_id, t.label)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: t.tab_id, x: e.clientX, y: e.clientY });
              }}
            >
              <StatusBadge status={t.agent_status} muted={t.agent_status === "unknown"} />
              {editing === t.tab_id ? (
                <input
                  ref={inputRef}
                  className="tab-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="tab-label">{t.label}</span>
              )}
            </div>
          );
        })}

        {wid && (
          <button className="icon-btn tab-add" onClick={newTab} title="New tab" aria-label="New tab">
            <Plus size={16} />
          </button>
        )}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button className="ctx-item" role="menuitem" onClick={() => closeTab(menu.tabId)}>
            <X size={14} />
            Close tab
          </button>
        </div>
      )}
    </div>
  );
}
