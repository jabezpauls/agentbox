import { useEffect } from "react";
import { useApp } from "../store/app.ts";
import type { Resolved, Theme } from "../theme/useTheme.ts";
import { rpc } from "../api/client.ts";
import { runAction } from "../keys/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TabBar } from "./TabBar.tsx";
import { PaneGrid } from "./PaneGrid.tsx";
import { KeymapSheet } from "./KeymapSheet.tsx";

interface Props {
  theme: Theme;
  resolved: Resolved;
  onCycleTheme(): void;
}

export function Shell({ theme, resolved, onCycleTheme }: Props) {
  const sidebarOpen = useApp((s) => s.ui.sidebarOpen);
  const setUi = useApp((s) => s.setUi);

  const openSidebar = () => setUi({ sidebarOpen: true });
  const closeSidebar = () => setUi({ sidebarOpen: false });

  // Global shortcuts outside a terminal. ⌘/Ctrl+K is reserved for Task 9's
  // command palette; the hook fires palette.all (a no-op for now) so the key is
  // already claimed. Escape dismisses the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        runAction("palette.all", { store: useApp, rpc });
      } else if (e.key === "Escape" && useApp.getState().ui.palette) {
        setUi({ palette: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setUi]);

  return (
    <div className="shell" data-sidebar={sidebarOpen ? "open" : "closed"}>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          tabIndex={-1}
          onClick={closeSidebar}
        />
      )}
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <Sidebar theme={theme} onCycleTheme={onCycleTheme} onCollapse={closeSidebar} />
      </aside>

      <main className="main">
        <TabBar sidebarOpen={sidebarOpen} onOpenSidebar={openSidebar} />
        <PaneGrid resolved={resolved} />
      </main>

      <KeymapSheet />
    </div>
  );
}
