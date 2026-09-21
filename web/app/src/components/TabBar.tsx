import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, PanelLeftOpen, PanelRight, Pencil, Plus, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import { tabsOf } from "../store/session.ts";
import { call } from "../api/call.ts";
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
  const inspectorOpen = useApp((s) => s.ui.inspector.open);
  const setInspector = useApp((s) => s.setInspector);
  const wid = session.focusedWorkspaceId;
  const tabs = wid ? tabsOf(session, wid) : [];

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The element focus returns to when a menu closes.
  const menuTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // On open, move focus into the menu; on close, restore it to the trigger.
  useEffect(() => {
    if (menu) {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else {
      menuTrigger.current?.focus();
      menuTrigger.current = null;
    }
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [menu]);

  const startRename = (tabId: string, label: string) => {
    setMenu(null);
    setEditing(tabId);
    setDraft(label);
  };

  const commitRename = () => {
    if (!editing) return;
    const label = draft.trim();
    const current = tabs.find((t) => t.tab_id === editing);
    if (label && current && label !== current.label) {
      void call("tab.rename", { tab_id: editing, label });
    }
    setEditing(null);
  };

  const newTab = () => {
    if (wid) void call("tab.create", { workspace_id: wid });
  };

  const closeTab = (tabId: string) => {
    void call("tab.close", { tab_id: tabId });
    setMenu(null);
  };

  const openMenuFrom = (tabId: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    menuTrigger.current = el;
    setMenu({ tabId, x: r.left, y: r.bottom + 4 });
  };

  const onTabKeyDown = (e: React.KeyboardEvent, tabId: string, label: string, active: boolean) => {
    switch (e.key) {
      case "F2":
        e.preventDefault();
        startRename(tabId, label);
        break;
      case "Enter":
      case " ":
        // Activation on an inactive tab falls through to the button's click;
        // on the active tab, the same key starts an inline rename.
        if (active) {
          e.preventDefault();
          startRename(tabId, label);
        }
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        closeTab(tabId);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.tab_id === tabId);
        const next = tabs[e.key === "ArrowRight" ? i + 1 : i - 1];
        if (next) document.getElementById(`tab-${next.tab_id}`)?.focus();
        break;
      }
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setMenu(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="tabbar">
      {!sidebarOpen && (
        <button className="icon-btn tabbar-menu" onClick={onOpenSidebar} title="Show sidebar" aria-label="Show sidebar">
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className="tabbar-tabs" role="tablist" aria-label="Tabs">
        {tabs.map((t) => {
          const active = t.tab_id === session.focusedTabId;
          return (
            <div key={t.tab_id} className={`tab${active ? " is-active" : ""}`}>
              {editing === t.tab_id ? (
                <>
                  <StatusBadge status={t.agent_status} muted={t.agent_status === "unknown"} />
                  <input
                    ref={inputRef}
                    className="tab-rename"
                    aria-label={`Rename tab ${t.label}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                </>
              ) : (
                <>
                  <button
                    id={`tab-${t.tab_id}`}
                    role="tab"
                    aria-selected={active}
                    className="tab-btn"
                    onClick={() => focusTab(t.tab_id)}
                    onDoubleClick={() => startRename(t.tab_id, t.label)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      menuTrigger.current = e.currentTarget;
                      setMenu({ tabId: t.tab_id, x: e.clientX, y: e.clientY });
                    }}
                    onKeyDown={(e) => onTabKeyDown(e, t.tab_id, t.label, active)}
                  >
                    <StatusBadge status={t.agent_status} muted={t.agent_status === "unknown"} />
                    <span className="tab-label">{t.label}</span>
                  </button>
                  <button
                    className="tab-menu-btn"
                    aria-label={`Tab actions for ${t.label}`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.tabId === t.tab_id}
                    onClick={(e) => openMenuFrom(t.tab_id, e.currentTarget)}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </>
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

      <button
        className={`icon-btn tabbar-inspector${inspectorOpen ? " is-active" : ""}`}
        onClick={() => setInspector({ open: !inspectorOpen })}
        title="Toggle inspector"
        aria-label="Toggle inspector"
        aria-pressed={inspectorOpen}
      >
        <PanelRight size={16} />
      </button>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              const t = tabs.find((tab) => tab.tab_id === menu.tabId);
              if (t) startRename(t.tab_id, t.label);
            }}
          >
            <Pencil size={14} />
            Rename
          </button>
          <button className="ctx-item" role="menuitem" onClick={() => closeTab(menu.tabId)}>
            <X size={14} />
            Close tab
          </button>
        </div>
      )}
    </div>
  );
}
