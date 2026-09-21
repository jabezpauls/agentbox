import { useEffect } from "react";
import { connectEvents } from "./api/events.ts";
import { getHealth, getSession } from "./api/client.ts";
import { fromSnapshot } from "./store/session.ts";
import { useApp } from "./store/app.ts";
import { useTheme } from "./theme/useTheme.ts";
import { Shell } from "./components/Shell.tsx";

export function App() {
  const { theme, resolved, cycle } = useTheme();
  const applyMessage = useApp((s) => s.applyMessage);
  const setStatus = useApp((s) => s.setStatus);
  const setHealth = useApp((s) => s.setHealth);
  const setUi = useApp((s) => s.setUi);
  const setThemeCycle = useApp((s) => s.setThemeCycle);

  // Keep the store's mirror of the theme in step with the hook (the source of
  // truth for the DOM), so other surfaces can read it. Register the cycle so
  // actions and the palette can toggle the theme too.
  useEffect(() => {
    setUi({ theme });
  }, [theme, setUi]);

  useEffect(() => {
    setThemeCycle(cycle);
    return () => setThemeCycle(null);
  }, [cycle, setThemeCycle]);

  // Learn the preview/lavish configuration and the picker's root once.
  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => {});
  }, [setHealth]);

  useEffect(() => {
    // Seed from the REST snapshot so the UI has content before the socket opens.
    let cancelled = false;
    getSession()
      .then((snap) => {
        if (!cancelled) useApp.setState({ session: fromSnapshot(snap) });
      })
      .catch(() => {});

    const dispose = connectEvents({
      onMessage: applyMessage,
      onStatus: setStatus,
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [applyMessage, setStatus]);

  return <Shell theme={theme} resolved={resolved} onCycleTheme={cycle} />;
}
