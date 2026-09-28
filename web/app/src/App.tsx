import { useEffect } from "react";
import type { ProjectCloneEvent } from "@workbench/shared";
import { connectEvents } from "./api/events.ts";
import { getSession } from "./api/client.ts";
import { fromSnapshot } from "./store/session.ts";
import { useApp } from "./store/app.ts";
import { useTheme } from "./theme/useTheme.ts";
import { useApps } from "./apps/model.ts";
import { useProjects } from "./projects/model.ts";
import { AppShell } from "./shell/AppShell.tsx";
import { installRouter } from "./shell/router.ts";
import { useGateSession } from "./shell/session.ts";
import { loadHealth } from "./shell/health.ts";

export function App() {
  const { theme, resolved, cycle, set } = useTheme();
  const applyMessage = useApp((s) => s.applyMessage);
  const setStatus = useApp((s) => s.setStatus);
  const setUi = useApp((s) => s.setUi);
  const setThemeCycle = useApp((s) => s.setThemeCycle);
  const setThemeSet = useApp((s) => s.setThemeSet);

  useEffect(() => installRouter(), []);

  // Keep the store's mirror of the theme in step with the hook (the source of
  // truth for the DOM), so other surfaces can read it. Register the cycle and
  // the setter so actions, Settings and the palette can change it too.
  useEffect(() => {
    setUi({ theme });
  }, [theme, setUi]);

  useEffect(() => {
    setThemeCycle(cycle);
    setThemeSet(set);
    return () => {
      setThemeCycle(null);
      setThemeSet(null);
    };
  }, [cycle, set, setThemeCycle, setThemeSet]);

  // Learn the roots and the preview configuration, and who is signed in. A
  // failed read is retried with backoff (see shell/health.ts).
  useEffect(() => {
    void loadHealth();
    void useApp.getState().refreshApps();
    void useGateSession.getState().refresh();
  }, []);

  // The events socket coming back means the bridge is back: read what we
  // could not read while it was away.
  const status = useApp((s) => s.status);
  useEffect(() => {
    if (status === "open" && !useApp.getState().health) void loadHealth();
  }, [status]);

  useEffect(() => {
    // Seed from the REST snapshot so the UI has content before the socket opens,
    // but never let a slow REST response land *after* the socket's own snapshot
    // and overwrite live data with a staler mirror. The socket's snapshot is
    // authoritative the moment it arrives, so its arrival cancels the seed.
    let cancelled = false;
    let socketSeeded = false;
    getSession()
      .then((snap) => {
        if (!cancelled && !socketSeeded) useApp.setState({ session: fromSnapshot(snap) });
      })
      .catch(() => {});

    const dispose = connectEvents({
      onMessage: (m) => {
        if (m.kind === "snapshot") socketSeeded = true;
        // Events for the rest of the app ride the same socket.
        const kind = (m as { kind: string }).kind;
        if (kind === "project.clone") useProjects.getState().onClone(m as ProjectCloneEvent);
        else if (kind === "apps.changed") void useApps.getState().refresh();
        applyMessage(m);
      },
      onStatus: setStatus,
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [applyMessage, setStatus]);

  return <AppShell resolved={resolved} />;
}
