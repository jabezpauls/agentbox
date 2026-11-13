import { useCallback, useEffect, useState } from "react";
import { APP_FRAME_SANDBOX } from "../components/PreviewPanel.tsx";
import { machinesApi, type MachineApp } from "./api.ts";

/**
 * Preview on a machine: the apps its agents registered (`agentbox-preview
 * <port>`), each shown from the machine-apps origin in a frame with the same
 * sandbox the gate puts on every app response — an opaque origin, never this
 * one. Opening one asks the gate for a single-use link (a POST), which the
 * machine-apps origin takes for a grant scoped to that app.
 */
export function MachinePreview({ id, ports }: { id: string; ports: boolean }) {
  const [apps, setApps] = useState<MachineApp[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      machinesApi.apps(id).then(
        (a) => {
          if (!live) return;
          setApps(a);
          setSelected((s) => (s && a.some((x) => x.id === s) ? s : (a[0]?.id ?? null)));
        },
        (e: Error) => live && setError(e.message),
      );
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);

  const show = useCallback(
    (appId: string) => {
      setError(null);
      machinesApi.openApp(id, appId).then(
        (url) => setSrc(url),
        (e: Error) => setError(e.message),
      );
    },
    [id],
  );

  useEffect(() => {
    setSrc(null);
    if (selected) show(selected);
  }, [selected, show]);

  const openTab = () => {
    if (!selected) return;
    machinesApi.openApp(id, selected).then(
      (url) => window.open(url, "_blank", "noopener,noreferrer"),
      (e: Error) => setError(e.message),
    );
  };

  if (!ports) return <p className="mx-hint">Apps are off in this machine&apos;s policy.json (&quot;ports&quot;: false).</p>;
  if (apps === null) return <p className="mx-hint">Loading…</p>;
  if (apps.length === 0) {
    return (
      <p className="mx-hint" id="machine-preview-empty">
        No apps yet. On the machine, start a server and run <code>agentbox-preview &lt;port&gt;</code>.
      </p>
    );
  }
  return (
    <div className="mx-preview" id="machine-preview">
      <div className="mx-toolbar">
        <select className="input" aria-label="App" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · port {a.port}
            </option>
          ))}
        </select>
        <button className="btn btn-small" type="button" onClick={() => selected && show(selected)}>
          Reload
        </button>
        <button className="btn btn-small" type="button" onClick={openTab}>
          Open in a new tab
        </button>
      </div>
      {error && (
        <p className="mx-error" role="alert">
          {error}
        </p>
      )}
      {src && <iframe key={src} className="mx-preview-frame" title="App preview" src={src} sandbox={APP_FRAME_SANDBOX} referrerPolicy="no-referrer" />}
    </div>
  );
}
