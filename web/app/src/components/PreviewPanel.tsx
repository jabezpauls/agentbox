import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Radio, RotateCw, Share2, X } from "lucide-react";
import type { PreviewShare } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import type { PreviewDevice } from "../store/app.ts";
import { basePath } from "../api/base.ts";
import {
  createShare,
  extendShare,
  listShares,
  probePreview,
  revokeShare,
  type ProbeState,
} from "../api/client.ts";
import { previewTarget } from "../preview/url.ts";
import { Dialog } from "./dialogs/Dialog.tsx";

const DEVICES: { id: PreviewDevice; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: 390, label: "390" },
  { id: 768, label: "768" },
  { id: 1024, label: "1024" },
];

/** A live share's remaining lifetime, phrased for the panel. */
function expiryLabel(expires: string): string {
  const ms = Date.parse(expires) - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 1) return `expires in ${hours}h`;
  const mins = Math.max(1, Math.round(ms / (60 * 1000)));
  return `expires in ${mins}m`;
}

/**
 * The preview panel: every listening port the bridge reports, and the selected
 * one shown in an iframe through the bridge's proxy. System ports (agentbox's
 * own services) are hidden behind a toggle; the address bar edits the path
 * within the app; device widths mimic phones and tablets; full-screen opens the
 * app on its own hostname when a preview domain is configured.
 *
 * Before the iframe is mounted the panel probes the port through the same
 * proxy, so the common "the server isn't up yet" case is a calm in-app message
 * rather than a flash of an error page. When sharing is enabled each port can be
 * exposed as an unguessable, expiring public link; a shared port carries a
 * persistent "public" banner so a live share is never a surprise.
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
  const portsReadable = useApp((s) => s.portsReadable);
  const port = useApp((s) => s.ui.inspector.port);
  const path = useApp((s) => s.ui.inspector.path);
  const device = useApp((s) => s.ui.inspector.device);
  const previewDomain = useApp((s) => s.health?.previewDomain ?? null);
  const sharingEnabled = useApp((s) => s.health?.previewSharing ?? false);
  const setInspector = useApp((s) => s.setInspector);
  const reportRpcError = useApp((s) => s.reportRpcError);

  const [showSystem, setShowSystem] = useState(false);
  const [confirmFullScreen, setConfirmFullScreen] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [reloadKey, setReloadKey] = useState(0);
  const [probe, setProbe] = useState<ProbeState | "checking">("checking");
  const [shares, setShares] = useState<PreviewShare[]>([]);
  const [busyShare, setBusyShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => setPathDraft(path), [path]);

  const refreshShares = useCallback(() => {
    if (!sharingEnabled) return;
    listShares()
      .then(setShares)
      .catch(() => {
        // A failed list leaves the previous view; the mint/revoke actions
        // surface their own errors, which is where it matters.
      });
  }, [sharingEnabled]);

  useEffect(() => refreshShares(), [refreshShares]);

  // Probe the selected port before mounting the iframe, and again on reload, so
  // a not-yet-serving port is a message rather than a browser error page.
  useEffect(() => {
    if (port === null) return;
    let live = true;
    setProbe("checking");
    void probePreview(port, "/").then((state) => {
      if (live) setProbe(state);
    });
    return () => {
      live = false;
    };
  }, [port, reloadKey]);

  const visible = ports.filter((p) => showSystem || !p.system);
  const sharedPorts = new Set(shares.map((s) => s.port));
  const base = basePath();

  const commitPath = () => setInspector({ path: pathDraft.startsWith("/") ? pathDraft : `/${pathDraft}` });

  const portList = (
    <PortList
      ports={visible}
      selected={port}
      showSystem={showSystem}
      readable={portsReadable}
      sharedPorts={sharedPorts}
      onToggleSystem={setShowSystem}
      onSelect={(p) => setInspector({ port: p, path: "/" })}
    />
  );

  if (port === null) {
    return (
      <div className="prev">
        {portList}
        <div className="empty">
          <span className="empty-glyph" aria-hidden="true">
            <Radio size={22} />
          </span>
          {!portsReadable ? (
            <>
              <p className="empty-title">Couldn&apos;t read ports.</p>
              <p className="empty-sub">The bridge could not read /proc to list listening ports.</p>
            </>
          ) : ports.length === 0 ? (
            <>
              <p className="empty-title">Nothing is listening.</p>
              <p className="empty-sub">Start a dev server in any pane and its port shows up here.</p>
            </>
          ) : (
            <>
              <p className="empty-title">No port picked.</p>
              <p className="empty-sub">Choose one above and the page loads in place.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const activeShare = shares.find((s) => s.port === port) ?? null;
  // agentbox's own services are never shareable; the bridge refuses them too.
  const selectedIsSystem = ports.some((p) => p.port === port && p.system);
  const src = previewTarget(port, path, previewDomain, base);
  // A shared preview opens full screen at its public `/s/` link, so what the
  // owner opens and what a viewer opens are the same page.
  const fullScreenSrc = activeShare ? activeShare.url : src;
  const openFullScreen = () => {
    setConfirmFullScreen(false);
    window.open(fullScreenSrc, "_blank", "noopener,noreferrer");
  };
  const frameWidth = device === "auto" ? "100%" : `${device}px`;
  const sandboxed = !previewDomain;

  const share = () => {
    setBusyShare(true);
    createShare(port)
      .then((s) => setShares((list) => [s, ...list.filter((x) => x.port !== port)]))
      .catch((err) => reportRpcError("preview.share", err))
      .finally(() => setBusyShare(false));
  };
  const extend = () => {
    if (!activeShare) return;
    setBusyShare(true);
    extendShare(activeShare.id)
      .then((s) => setShares((list) => list.map((x) => (x.id === s.id ? s : x))))
      .catch((err) => reportRpcError("preview.share", err))
      .finally(() => setBusyShare(false));
  };
  const revoke = () => {
    if (!activeShare) return;
    setBusyShare(true);
    revokeShare(activeShare.id)
      .then(() => setShares((list) => list.filter((x) => x.id !== activeShare.id)))
      .catch((err) => reportRpcError("preview.share", err))
      .finally(() => setBusyShare(false));
  };
  const copyLink = () => {
    if (!activeShare) return;
    void navigator.clipboard?.writeText(activeShare.url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="prev">
      {portList}

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
        {sharingEnabled && !activeShare && !selectedIsSystem && (
          <button
            className="icon-btn"
            aria-label="Share this port"
            title="Share this port"
            disabled={busyShare}
            onClick={share}
          >
            <Share2 size={14} />
          </button>
        )}
        <button className="icon-btn" aria-label="Reload" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCw size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={() => (previewDomain && !activeShare ? openFullScreen() : setConfirmFullScreen(true))}
        >
          <ExternalLink size={14} />
        </button>
      </div>

      {activeShare && (
        <div className="prev-share" role="group" aria-label="Public share">
          <p className="prev-share-banner">
            <Globe size={13} aria-hidden="true" />
            <span>Public — anyone with this link can view this. Revoke when you&apos;re done.</span>
          </p>
          <div className="prev-share-link">
            <input className="prev-share-url" readOnly value={activeShare.url} aria-label="Public link" />
            <button className="icon-btn" aria-label="Copy link" title="Copy link" onClick={copyLink}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="prev-share-actions">
            <span className="prev-share-expiry">{expiryLabel(activeShare.expires)}</span>
            <button className="btn btn-ghost btn-small" disabled={busyShare} onClick={extend}>
              Extend
            </button>
            <button className="btn btn-danger btn-small" disabled={busyShare} onClick={revoke}>
              <X size={13} aria-hidden="true" /> Revoke
            </button>
          </div>
        </div>
      )}

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
          Sandboxed. This preview shares the Workbench's origin, so it runs without cookies, storage or live
          reload. Set a preview domain for full fidelity.
        </p>
      )}

      {confirmFullScreen && (
        <Dialog
          title={activeShare ? "Open the public link?" : "Open outside the sandbox?"}
          onClose={() => setConfirmFullScreen(false)}
          onSubmit={openFullScreen}
          submitLabel="Open anyway"
          danger
          narrow
        >
          <p className="dialog-text">
            {activeShare
              ? "This opens the shared page on this box's own address. It is served sandboxed, so it cannot reach Workbench's storage, API or terminals — but it is still a page an agent wrote, and anyone with the link sees the same thing."
              : "This page was written by an agent. Full screen gives it the same access to Workbench that you have — its storage, its API and its terminals. Setting a preview domain avoids that."}
          </p>
        </Dialog>
      )}

      <div className={`prev-frame-wrap${device === "auto" ? " is-auto" : ""}`}>
        {probe === "ready" ? (
          <iframe
            key={reloadKey}
            className="prev-frame"
            style={{ width: frameWidth }}
            src={src}
            title={`Preview on port ${port}`}
            sandbox={sandboxed ? "allow-scripts allow-forms allow-popups allow-modals" : undefined}
          />
        ) : (
          <PreviewStatus port={port} state={probe} onRetry={() => setReloadKey((k) => k + 1)} />
        )}
      </div>
    </div>
  );
}

interface PreviewStatusProps {
  port: number;
  state: "checking" | "down";
  onRetry(): void;
}

/** The in-app checking / not-responding state, shown in place of the iframe. */
function PreviewStatus({ port, state, onRetry }: PreviewStatusProps) {
  if (state === "checking") {
    return (
      <div className="prev-status">
        <span className="prev-status-glyph is-spin" aria-hidden="true">
          <Loader2 size={22} />
        </span>
        <p className="prev-status-title">Checking port {port}…</p>
      </div>
    );
  }
  return (
    <div className="prev-status">
      <span className="prev-status-glyph" aria-hidden="true">
        <Radio size={22} />
      </span>
      <p className="prev-status-title">Nothing is serving on port {port} yet</p>
      <p className="prev-status-sub">If you just started a server, give it a moment.</p>
      <button className="btn btn-primary btn-small" onClick={onRetry}>
        <RotateCw size={13} aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

interface PortListProps {
  ports: { port: number; process: string | null; system: boolean }[];
  selected: number | null;
  showSystem: boolean;
  readable: boolean;
  sharedPorts: Set<number>;
  onToggleSystem(v: boolean): void;
  onSelect(port: number): void;
}

function PortList({ ports, selected, showSystem, readable, sharedPorts, onToggleSystem, onSelect }: PortListProps) {
  return (
    <div className="port-list">
      <div className="port-list-head">
        <span className="section-label">Ports</span>
        <label className="port-system-toggle">
          <input type="checkbox" checked={showSystem} onChange={(e) => onToggleSystem(e.target.checked)} />
          System ports
        </label>
      </div>
      <ul className="ports">
        {ports.length === 0 && (
          <li className="ports-empty">{readable ? "No ports" : "Couldn't read ports"}</li>
        )}
        {ports.map((p) => (
          <li key={p.port}>
            <button className={`port-row${p.port === selected ? " is-active" : ""}`} onClick={() => onSelect(p.port)}>
              <span className="port-num">:{p.port}</span>
              <span className="port-proc">{p.process ?? "unknown"}</span>
              {sharedPorts.has(p.port) && (
                <span className="port-tag is-public" title="Public share is live">
                  <Globe size={10} aria-hidden="true" /> public
                </span>
              )}
              {p.system && <span className="port-tag">system</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
