import { useApp } from "../store/app.ts";
import { actionCtx } from "../api/call.ts";
import { runAction } from "../keys/actions.ts";
import { openAppInDock } from "../apps/open.ts";
import { showDock, toggleDock, openKeymap } from "../shell/actions.ts";
import { openInEditor } from "../shell/editor.ts";
import { navigate, useRouter } from "../shell/router.ts";
import { requestNewProject } from "../shell/requests.ts";
import { signOut } from "../shell/session.ts";
import { terminalHere } from "../workbench/launch.ts";
import type { PaletteEffects } from "./items.ts";

/** What the palette's choices do, wired to the app's stores and router. */
export const paletteEffects: PaletteEffects = {
  // A surface is gone to the way the rail goes to it: where it was left.
  go: (surface) => useRouter.getState().go(surface),
  navigate: (r) => navigate(r),
  focusPane: (id) => {
    navigate({ surface: "workbench" });
    useApp.getState().focusPane(id);
  },
  focusTab: (id) => {
    navigate({ surface: "workbench" });
    useApp.getState().focusTab(id);
  },
  focusWorkspace: (id) => {
    navigate({ surface: "workbench" });
    useApp.getState().focusWorkspace(id);
  },
  runAction: (id) => runAction(id, actionCtx()),
  openApp: openAppInDock,
  openReview: (key) => useApp.getState().setInspector({ open: true, tab: "review", reviewKey: key }),
  openPort: (port) => void useApp.getState().openPort(port),
  openInEditor: (p) => void openInEditor(p),
  terminalHere: (p) => void terminalHere(p),
  newProject: () => {
    requestNewProject("clone");
    useRouter.getState().go("home");
  },
  setTheme: (t) => useApp.getState().themeSet?.(t),
  toggleDock: () => toggleDock(),
  showDock,
  keymap: openKeymap,
  signOut: () => void signOut(),
};
