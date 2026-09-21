import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { LavishState } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import { getLavish } from "../api/client.ts";
import { StatusBadge } from "./StatusBadge.tsx";

function basename(file: string | null): string {
  if (!file) return "";
  const i = file.lastIndexOf("/");
  return i === -1 ? file : file.slice(i + 1);
}

/**
 * The lavish-axi panel. lavish binds loopback and pins its Host header, so it
 * cannot be proxied under a path — it needs its own hostname. When that is not
 * configured we show a setup card rather than a broken frame. Otherwise the
 * review sessions from lavish's state are listed and shown in an iframe on the
 * hostname it requires.
 */
export function LavishPanel() {
  const selected = useApp((s) => s.ui.inspector.lavishKey);
  const setInspector = useApp((s) => s.setInspector);
  const [state, setState] = useState<LavishState | null>(null);

  // Fetch on open and poll every 5s while this panel is mounted (open).
  useEffect(() => {
    let live = true;
    const load = () => getLavish().then((s) => live && setState(s)).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!state) return <div className="lavish"><p className="lavish-loading">Loading…</p></div>;

  if (!state.configured) {
    return (
      <div className="lavish">
        <div className="setup-card">
          <h3 className="setup-title">Lavish is not configured</h3>
          <p className="setup-text">
            lavish-axi refuses requests whose <code>Host</code> is not on its allowlist and uses absolute paths, so it
            needs its own hostname rather than a path under Workbench.
          </p>
          <p className="setup-text">Set these on the bridge, then reload:</p>
          <ul className="setup-vars">
            <li><code>WORKBENCH_LAVISH_URL</code> — the public origin, e.g. <code>https://lavish.code.example.com</code></li>
            <li><code>AGENTBOX_LAVISH_DOMAIN</code> — the Caddy hostname routed to <code>code:4387</code></li>
          </ul>
        </div>
      </div>
    );
  }

  if (!state.running) {
    return (
      <div className="lavish">
        <div className="setup-card">
          <h3 className="setup-title">lavish-axi is not running</h3>
          <p className="setup-text">Start it, then sessions will appear here:</p>
          <pre className="setup-cmd">lavish-axi server</pre>
        </div>
      </div>
    );
  }

  const current = state.sessions.find((s) => s.key === selected) ?? state.sessions[0];

  return (
    <div className="lavish">
      <ul className="lavish-sessions">
        {state.sessions.length === 0 && <li className="lavish-empty">No review sessions</li>}
        {state.sessions.map((s) => (
          <li key={s.key}>
            <button
              className={`lavish-row${current && s.key === current.key ? " is-active" : ""}`}
              onClick={() => setInspector({ lavishKey: s.key })}
            >
              <StatusBadge status={s.active ? "working" : "idle"} muted={!s.active} title={s.status} />
              <span className="lavish-label">{s.label}</span>
              <span className="lavish-file">{basename(s.file)}</span>
            </button>
          </li>
        ))}
      </ul>
      {current?.url && (
        <div className="lavish-view">
          <div className="lavish-view-bar">
            <span className="lavish-view-title">{current.label}</span>
            <button
              className="icon-btn"
              aria-label="Open full screen"
              onClick={() => window.open(current.url!, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink size={15} />
            </button>
          </div>
          <iframe className="lavish-frame" src={current.url} title={`Lavish session ${current.label}`} />
        </div>
      )}
    </div>
  );
}
