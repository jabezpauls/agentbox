import { useEffect } from "react";
import { useApp } from "../store/app.ts";
import type { Resolved, Theme } from "../theme/useTheme.ts";
import { actionCtx } from "../api/call.ts";
import { runAction } from "../keys/actions.ts";
import { feedGlobal } from "../keys/machine.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TabBar } from "./TabBar.tsx";
import { PaneGrid } from "./PaneGrid.tsx";
import { KeymapSheet } from "./KeymapSheet.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Composer } from "./Composer.tsx";
import { Inspector } from "./Inspector.tsx";
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
  const sidebarWidth = useApp((s) => s.ui.sidebarWidth);
  const inspectorOpen = useApp((s) => s.ui.inspector.open);
  const inspectorWidth = useApp((s) => s.ui.inspector.width);
  const setUi = useApp((s) => s.setUi);

  const openSidebar = () => setUi({ sidebarOpen: true });
  const closeSidebar = () => setUi({ sidebarOpen: false });

  // ⌘/Ctrl+K opens the command palette from anywhere outside a terminal
  // (inside a terminal it is intercepted in the xterm key handler). Escape
  // dismisses the palette. The same prefix layer the terminals use is armed
  // from here too, so ⌃B bindings keep working once focus leaves a terminal —
  // after prefix+q, say — as long as the keystroke is not going into a text
  // field (xterm's helper textarea included; that cell handles its own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        runAction("palette.all", actionCtx());
        return;
      }
      // ⌘B hides and shows the sidebar, as it does in rubl. Only the Meta
      // variant: Ctrl+B is the terminal prefix and must stay untouched.
      if (e.metaKey && !e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        runAction("sidebar.toggle", actionCtx());
        return;
      }
      if (e.key === "Escape" && useApp.getState().ui.palette) {
        setUi({ palette: null });
        return;
      }
      feedGlobal(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setUi]);

  return (
    <div
      className="shell"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-inspector={inspectorOpen ? "open" : "closed"}
      style={{
        ["--inspector-w" as string]: `${inspectorWidth}px`,
        ["--sidebar-w" as string]: `${sidebarWidth}px`,
      }}
    >
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

      <Inspector />

      <KeymapSheet />
      <CommandPalette />
      <NewWorkspaceDialog />
      <RenameDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
