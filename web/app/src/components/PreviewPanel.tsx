import { useEffect, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { PreviewDevice } from "../store/app.ts";
import { basePath } from "../api/base.ts";
import { fullScreenUrl, previewUrl } from "../preview/url.ts";

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
 */
export function PreviewPanel() {
  const ports = useApp((s) => s.ports);
  const port = useApp((s) => s.ui.inspector.port);
  const path = useApp((s) => s.ui.inspector.path);
  const device = useApp((s) => s.ui.inspector.device);
  const previewDomain = useApp((s) => s.health?.previewDomain ?? null);
  const setInspector = useApp((s) => s.setInspector);

  const [showSystem, setShowSystem] = useState(false);
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

  const src = previewUrl(base, port, path);
  const frameWidth = device === "auto" ? "100%" : `${device}px`;

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
          onClick={() => window.open(fullScreenUrl(port, path, previewDomain, base), "_blank", "noopener,noreferrer")}
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

      <div className={`prev-frame-wrap${device === "auto" ? " is-auto" : ""}`}>
        <iframe
          key={reloadKey}
          className="prev-frame"
          style={{ width: frameWidth }}
          src={src}
          title={`Preview on port ${port}`}
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
