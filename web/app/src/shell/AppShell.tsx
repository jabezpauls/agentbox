import { useEffect, useRef } from "react";
import { useApp } from "../store/app.ts";
import type { Resolved } from "../theme/useTheme.ts";
import { actionCtx } from "../api/call.ts";
import { runAction } from "../keys/actions.ts";
import { feedGlobal } from "../keys/machine.ts";
import { KeymapSheet } from "../components/KeymapSheet.tsx";
import { CommandPalette } from "../components/CommandPalette.tsx";
import { Toasts } from "../components/Toasts.tsx";
import { NewWorkspaceDialog } from "../components/dialogs/NewWorkspaceDialog.tsx";
import { RenameDialog } from "../components/dialogs/RenameDialog.tsx";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog.tsx";
import { dismissPrompts, PromptHost } from "../components/ui/prompts.tsx";
import { useApps } from "../apps/model.ts";
import { HomeSurface } from "../surfaces/home/HomeSurface.tsx";
import { UploadPanel } from "../surfaces/files/UploadPanel.tsx";
import { handleShellKey } from "./actions.ts";
import { useReviews } from "./attention.ts";
import { usePageVisible } from "./activity.tsx";
import { BottomBar } from "./BottomBar.tsx";
import { Dock } from "./Dock.tsx";
import { installDropGuard } from "./drops.ts";
import { followAppTheme } from "./editor.ts";
import { useEditorFollowsTheme } from "../theme/editorSync.ts";
import { dockOnSwitch } from "./dock.ts";
import { Rail } from "./Rail.tsx";
import { useRouter } from "./router.ts";
import type { SurfaceId } from "./routes.ts";
import { SurfaceHost } from "./SurfaceHost.tsx";
import { lazySurface } from "./lazySurface.tsx";
import { SURFACE_BY_ID } from "./surfaces.ts";
import { setTitleSurface } from "./title.ts";

// Home is where most visits start and is built with the page; every other
// surface is its own chunk, fetched on the first visit — the terminal
// emulator, the file manager and the rest are not paid for up front.
const WorkbenchSurface = lazySurface(() => import("../surfaces/workbench/WorkbenchSurface.tsx").then((m) => m.WorkbenchSurface));
const EditorSurface = lazySurface(() => import("../surfaces/editor/EditorSurface.tsx").then((m) => m.EditorSurface));
const FilesSurface = lazySurface(() => import("../surfaces/files/FilesSurface.tsx").then((m) => m.FilesSurface));
const AppsSurface = lazySurface(() => import("../surfaces/apps/AppsSurface.tsx").then((m) => m.AppsSurface));
const SystemSurface = lazySurface(() => import("../surfaces/system/SystemSurface.tsx").then((m) => m.SystemSurface));
const SettingsSurface = lazySurface(() => import("../surfaces/settings/SettingsSurface.tsx").then((m) => m.SettingsSurface));

/** Review sessions and apps are cheap to read and feed "needs you" everywhere. */
const BACKGROUND_POLL_MS = 20_000;

/**
 * The app's frame: the rail (a bottom bar on a phone), every surface kept
 * alive in one stack, the dock on the right, and the overlays — palette,
 * keymap, dialogs, toasts — above it all. The tree is the same at every
 * width; only CSS moves things, so a resize never rebuilds a surface.
 */
export function AppShell({ resolved }: { resolved: Resolved }) {
  const route = useRouter((s) => s.route);
  const surface = route.surface;
  const setUi = useApp((s) => s.setUi);
  const pageVisible = usePageVisible();
  const previous = useRef<SurfaceId>(surface);

  // The editor follows the app's light or dark, unless told not to.
  const connStatus = useApp((s) => s.status);
  const editorFollows = useEditorFollowsTheme((s) => s.on);
  useEffect(() => {
    if (connStatus === "open") void followAppTheme(editorFollows ? resolved : null);
  }, [resolved, connStatus, editorFollows]);

  // Files dropped where nothing takes them must not replace the app.
  useEffect(() => installDropGuard(), []);

  // The Workbench is where most visits go next. Fetch its code once the page
  // is idle, so the first move there does not wait a round trip through the
  // proxy for it (a cold fetch measured 150–250 ms).
  useEffect(() => {
    const load = () => void import("../surfaces/workbench/WorkbenchSurface.tsx").catch(() => {});
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(load, { timeout: 5_000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(load, 2_000);
    return () => clearTimeout(t);
  }, []);

  // The keyboard. Chords and ⌘K from anywhere; the Workbench's own keys
  // (⌘B, the ⌃B prefix) only while the Workbench is what you are looking at.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useApp.getState().ui.palette) {
        setUi({ palette: null });
        return;
      }
      if (handleShellKey(e)) return;
      if (useRouter.getState().route.surface !== "workbench") return;
      // ⌘B hides and shows the sidebar. Only the Meta
      // variant: Ctrl+B is the terminal prefix and must stay untouched.
      if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        runAction("sidebar.toggle", actionCtx());
        return;
      }
      feedGlobal(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setUi]);

  // Each surface remembers its own dock; the title says where you are.
  useEffect(() => {
    setTitleSurface(SURFACE_BY_ID[surface].label);
    const from = previous.current;
    if (from === surface) return;
    previous.current = surface;
    // A question asked on the way out is not answered by leaving.
    dismissPrompts();
    const { open, width } = useApp.getState().ui.inspector;
    const next = dockOnSwitch(from, surface, { open, width });
    if (next.open !== open || next.width !== width) useApp.getState().setInspector(next);
  }, [surface]);

  // `/workbench?review=<key>` — the link `agentbox-review open` prints —
  // opens the dock on that review, once: the address then drops the key, so
  // coming back to the Workbench later does not open it again.
  const review = route.surface === "workbench" ? route.review : undefined;
  useEffect(() => {
    if (!review) return;
    useApp.getState().setInspector({ open: true, tab: "review", reviewKey: review });
    useRouter.getState().navigate({ surface: "workbench" }, { replace: true });
  }, [review]);

  // Reviews and apps in the background, so "needs you" is current on every
  // surface. Paused while the tab is hidden.
  useEffect(() => {
    if (!pageVisible) return;
    const tick = () => {
      void useReviews.getState().refresh();
      void useApps.getState().refresh();
    };
    tick();
    const id = setInterval(tick, BACKGROUND_POLL_MS);
    return () => clearInterval(id);
  }, [pageVisible]);

  return (
    <div className="app">
      <Rail />
      <main className="app-main" id="main">
        <SurfaceHost
          render={{
            home: () => <HomeSurface />,
            workbench: () => <WorkbenchSurface resolved={resolved} />,
            editor: () => <EditorSurface />,
            files: () => <FilesSurface />,
            apps: () => <AppsSurface />,
            system: () => <SystemSurface />,
            settings: () => <SettingsSurface />,
          }}
        />
      </main>
      <Dock />
      <BottomBar />

      <UploadPanel />
      <KeymapSheet />
      <CommandPalette />
      <NewWorkspaceDialog />
      <RenameDialog />
      <ConfirmDialog />
      <PromptHost />
      <Toasts />
    </div>
  );
}
