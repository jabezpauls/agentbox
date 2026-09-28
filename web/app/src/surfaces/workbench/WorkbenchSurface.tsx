import { useApp } from "../../store/app.ts";
import type { Resolved } from "../../theme/useTheme.ts";
import { Sidebar } from "../../components/Sidebar.tsx";
import { TabBar } from "../../components/TabBar.tsx";
import { PaneGrid } from "../../components/PaneGrid.tsx";
import { Composer } from "../../components/Composer.tsx";
import { focusOnArrival, useOnActivate } from "../../shell/activity.tsx";
import { focusTerminal } from "../../terminal/registry.ts";

/**
 * The Workbench: the herdr client — workspaces, tabs, panes, agents and the
 * composer — as it always was, minus the brand (the rail has it) and the
 * inspector (the app's dock took it over).
 *
 * It is kept mounted when you move to another surface, so every terminal's
 * socket stays open; coming back puts the keyboard in the focused pane.
 */
export function WorkbenchSurface({ resolved }: { resolved: Resolved }) {
  const sidebarOpen = useApp((s) => s.ui.sidebarOpen);
  const sidebarWidth = useApp((s) => s.ui.sidebarWidth);
  const setUi = useApp((s) => s.setUi);

  useOnActivate(() => focusOnArrival(() => focusTerminal(useApp.getState().session.focusedPaneId)));

  return (
    <div className="wb" data-sidebar={sidebarOpen ? "open" : "closed"} style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}>
      {sidebarOpen && (
        <button className="sidebar-scrim" aria-label="Close sidebar" tabIndex={-1} onClick={() => setUi({ sidebarOpen: false })} />
      )}
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <Sidebar onCollapse={() => setUi({ sidebarOpen: false })} />
      </aside>
      <div className="main">
        <TabBar sidebarOpen={sidebarOpen} onOpenSidebar={() => setUi({ sidebarOpen: true })} />
        <PaneGrid resolved={resolved} />
        <Composer />
      </div>
    </div>
  );
}
