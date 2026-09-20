import { useApp } from "../store/app.ts";
import type { Theme } from "../theme/useTheme.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TabBar } from "./TabBar.tsx";

interface Props {
  theme: Theme;
  onCycleTheme(): void;
}

export function Shell({ theme, onCycleTheme }: Props) {
  const sidebarOpen = useApp((s) => s.ui.sidebarOpen);
  const setUi = useApp((s) => s.setUi);

  const openSidebar = () => setUi({ sidebarOpen: true });
  const closeSidebar = () => setUi({ sidebarOpen: false });

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
        <div className="stage">
          <div className="empty-stage">
            <p className="empty-title">Select a pane</p>
            <p className="empty-sub">Choose a workspace, tab, or agent to begin.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
