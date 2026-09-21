import { useEffect } from "react";
import { useApp } from "../store/app.ts";
import type { Resolved, Theme } from "../theme/useTheme.ts";
import { rpc } from "../api/client.ts";
import { runAction } from "../keys/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TabBar } from "./TabBar.tsx";
import { PaneGrid } from "./PaneGrid.tsx";
import { KeymapSheet } from "./KeymapSheet.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Composer } from "./Composer.tsx";
import { Toasts } from "./Toasts.tsx";
import { NewWorkspaceDialog } from "./dialogs/NewWorkspaceDialog.tsx";
import { RenameDialog } from "./dialogs/RenameDialog.tsx";
import { ConfirmDialog } from "./dialogs/ConfirmDialog.tsx";

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

  // ⌘/Ctrl+K opens the command palette from anywhere outside a terminal
  // (inside a terminal it is intercepted in the xterm key handler). Escape
  // dismisses the palette.
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
        <Composer />
      </main>

      <KeymapSheet />
      <CommandPalette />
      <NewWorkspaceDialog />
      <RenameDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
