import { useEffect, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { PreviewDevice } from "../store/app.ts";
import { basePath } from "../api/base.ts";
import { previewTarget } from "../preview/url.ts";
import { Dialog } from "./dialogs/Dialog.tsx";

const DEVICES: { id: PreviewDevice; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: 390, label: "390" },
  { id: 768, label: "768" },
  { id: 1024, label: "1024" },
];

/**
 * The preview panel: every listening port the bridge reports, and the selected
 * one shown in an iframe through the bridge's proxy. System ports (agentbox's
 * own services) are hidden behind a toggle; the address bar edits the path
 * within the app; device widths mimic phones and tablets; full-screen opens the
 * app on its own hostname when a preview domain is configured.
 *
 * The trade-off in the two preview modes is a security one. Through the path
 * proxy the previewed page is served from the Workbench's own origin, so
 * without a sandbox an agent-written dev server could script this document,
 * read its storage and POST to /api/rpc as the signed-in user. The iframe below
 * therefore drops `allow-same-origin` in that mode, which costs the page its
 * cookies, storage and same-origin fetches. Configure a preview domain and the
 * page is loaded from its own origin instead, where the browser's own origin
 * separation does the work and no sandbox is needed.
 *
 * Full screen is the hole in that reasoning: a top-level window has no sandbox
 * attribute, so in path mode the ↗ button would hand the agent's page the
 * Workbench's own origin — its storage, its API and its terminals. It therefore
 * asks first in that mode, and opens straight away when a preview domain makes
 * the page a separate origin anyway.
 */
export function PreviewPanel() {
  const ports = useApp((s) => s.ports);
  const port = useApp((s) => s.ui.inspector.port);
  const path = useApp((s) => s.ui.inspector.path);
  const device = useApp((s) => s.ui.inspector.device);
  const previewDomain = useApp((s) => s.health?.previewDomain ?? null);
  const setInspector = useApp((s) => s.setInspector);

  const [showSystem, setShowSystem] = useState(false);
  const [confirmFullScreen, setConfirmFullScreen] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setPathDraft(path), [path]);

  const visible = ports.filter((p) => showSystem || !p.system);
  const base = basePath();

  const commitPath = () => setInspector({ path: pathDraft.startsWith("/") ? pathDraft : `/${pathDraft}` });

  if (port === null) {
    return (
      <div className="prev">
        <PortList ports={visible} selected={port} showSystem={showSystem} onToggleSystem={setShowSystem} onSelect={(p) => setInspector({ port: p, path: "/" })} />
        {ports.length === 0 && (
          <div className="prev-empty">
            <p className="prev-empty-title">No ports yet</p>
            <p className="prev-empty-sub">Start a dev server in any pane and it will appear here.</p>
          </div>
        )}
      </div>
    );
  }

  const src = previewTarget(port, path, previewDomain, base);
  const openFullScreen = () => {
    setConfirmFullScreen(false);
    window.open(src, "_blank", "noopener,noreferrer");
  };
  const frameWidth = device === "auto" ? "100%" : `${device}px`;
  const sandboxed = !previewDomain;

  return (
    <div className="prev">
      <PortList ports={visible} selected={port} showSystem={showSystem} onToggleSystem={setShowSystem} onSelect={(p) => setInspector({ port: p, path: "/" })} />

      <div className="prev-bar">
        <span className="prev-origin">:{port}</span>
        <input
          className="prev-path"
          value={pathDraft}
          aria-label="Path"
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitPath()}
          onBlur={commitPath}
        />
        <button className="icon-btn" aria-label="Refresh" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCw size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label="Open full screen"
          onClick={() => (previewDomain ? openFullScreen() : setConfirmFullScreen(true))}
        >
          <ExternalLink size={15} />
        </button>
      </div>

      <div className="prev-devices" role="group" aria-label="Device width">
        {DEVICES.map((d) => (
          <button
            key={d.id}
            className={`chip${device === d.id ? " is-active" : ""}`}
            aria-pressed={device === d.id}
            onClick={() => setInspector({ device: d.id })}
          >
            {d.label}
          </button>
        ))}
      </div>

      {sandboxed && (
        <p className="prev-note">
          Sandboxed: this preview runs without cookies, storage or live reload because it shares the Workbench's
          origin. Set a preview domain for full fidelity.
        </p>
      )}

      {confirmFullScreen && (
        <Dialog
          title="Open outside the sandbox?"
          onClose={() => setConfirmFullScreen(false)}
          onSubmit={openFullScreen}
          submitLabel="Open anyway"
          danger
        >
          <p className="dialog-text">
            This page was written by an agent. Opening it full screen gives it the same access to Workbench that you
            have. A preview domain avoids this.
          </p>
        </Dialog>
      )}

      <div className={`prev-frame-wrap${device === "auto" ? " is-auto" : ""}`}>
        <iframe
          key={reloadKey}
          className="prev-frame"
          style={{ width: frameWidth }}
          src={src}
          title={`Preview on port ${port}`}
          sandbox={sandboxed ? "allow-scripts allow-forms allow-popups allow-modals" : undefined}
        />
      </div>
    </div>
  );
}

interface PortListProps {
  ports: { port: number; process: string | null; system: boolean }[];
  selected: number | null;
  showSystem: boolean;
  onToggleSystem(v: boolean): void;
  onSelect(port: number): void;
}

function PortList({ ports, selected, showSystem, onToggleSystem, onSelect }: PortListProps) {
  return (
    <div className="port-list">
      <div className="port-list-head">
        <span className="port-list-title">Ports</span>
        <label className="port-system-toggle">
          <input type="checkbox" checked={showSystem} onChange={(e) => onToggleSystem(e.target.checked)} />
          Show system
        </label>
      </div>
      <ul className="ports">
        {ports.length === 0 && <li className="ports-empty">No ports</li>}
        {ports.map((p) => (
          <li key={p.port}>
            <button className={`port-row${p.port === selected ? " is-active" : ""}`} onClick={() => onSelect(p.port)}>
              <span className="port-num">:{p.port}</span>
              <span className="port-proc">{p.process ?? "unknown"}</span>
              {p.system && <span className="port-tag">system</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
