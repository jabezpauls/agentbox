import { useEffect, useState } from "react";
import {
  AppWindow,
  Check,
  Copy,
  Dices,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Play,
  Radio,
  RotateCw,
  Share2,
  X,
} from "lucide-react";
import type { AppView, AppVisibilityMode } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import type { PreviewDevice } from "../store/app.ts";
import { probeApp, restartApp, shareApp, stopSharing, updateApp, type Probe } from "../api/client.ts";
import { appLink, appUrl, forwardCommand, normalisePath } from "../preview/url.ts";

const DEVICES: { id: PreviewDevice; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: 390, label: "390" },
  { id: 768, label: "768" },
  { id: 1024, label: "1024" },
];

/**
 * What the frame may do: the same sandbox the gate puts on every app response,
 * and never `allow-same-origin` — an app runs with an opaque origin, in the
 * panel and full screen alike, so what the owner sees here is exactly what
 * someone opening the link sees.
 */
export const APP_FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

const EXPIRIES: { label: string; seconds: number | null }[] = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { label: "Until I stop sharing", seconds: null },
];
const DEFAULT_EXPIRY = 2;

/** The shortest passcode the box takes. */
export const MIN_PASSCODE = 8;

/**
 * A passcode made here, as the box makes one: three groups of four from an
 * alphabet without look-alikes (about 60 bits).
 */
export function makePasscode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  bytes.forEach((b, i) => {
    if (i > 0 && i % 4 === 0) out += "-";
    out += alphabet[b % alphabet.length];
  });
  return out;
}

/** A shared app's remaining lifetime, phrased for the panel. */
export function expiryLabel(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "until you stop sharing";
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 2) return `for ${days} more days`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 1) return `for ${hours} more hour${hours === 1 ? "" : "s"}`;
  const mins = Math.max(1, Math.round(ms / (60 * 1000)));
  return `for ${mins} more minute${mins === 1 ? "" : "s"}`;
}

function isPublic(app: AppView): boolean {
  return app.visibility.mode !== "private";
}

/** Copy text, and say so for a moment. */
function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
      },
      () => {},
    );
  };
  return [copied, copy];
}

/**
 * The Preview panel: the apps of the box — servers in the sandbox, each with
 * its own URL, `/a/<id>/` — and the one chosen, framed. Ports that are
 * listening but are not apps yet sit under "Also listening"; choosing one
 * makes it an app (private, the owner's).
 *
 * The frame is sandboxed the way the gate serves every app, so nothing here
 * is more trusted than a visitor's view. Before the frame mounts, the panel
 * probes the app, so "the server isn't up yet" is a calm message rather than
 * a flash of an error page; the probe also carries the gate's hint when the
 * app assumes it runs at `/` in a way the path fixes cannot reach.
 *
 * Share is the owner's alone (the gate refuses anyone else): anyone with the
 * link, or with the link and a passcode, until a time or until stopped. A
 * shared app carries a persistent banner, so a public app is never a surprise;
 * stopping sharing cuts off anyone still connected.
 */
export function PreviewPanel() {
  const apps = useApp((s) => s.apps);
  const ports = useApp((s) => s.ports);
  const portsReadable = useApp((s) => s.portsReadable);
  const appId = useApp((s) => s.ui.previewAppId);
  const path = useApp((s) => s.ui.inspector.path);
  const device = useApp((s) => s.ui.inspector.device);
  const sharingEnabled = useApp((s) => s.health?.sharing ?? false);
  const setInspector = useApp((s) => s.setInspector);
  const openApp = useApp((s) => s.openApp);
  const openPort = useApp((s) => s.openPort);
  const refreshApps = useApp((s) => s.refreshApps);
  const reportRpcError = useApp((s) => s.reportRpcError);

  const [pathDraft, setPathDraft] = useState(path);
  const [reloadKey, setReloadKey] = useState(0);
  const [probe, setProbe] = useState<Probe | "checking">("checking");
  const [panel, setPanel] = useState<"share" | "info" | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [copied, copy] = useCopy();

  const app = apps?.find((a) => a.id === appId) ?? null;

  useEffect(() => setPathDraft(path), [path]);
  useEffect(() => setPanel(null), [appId]);

  // Probe the app before mounting the frame, and again on reload, so a server
  // that is not up yet is a message rather than an error page.
  const probeUrl = app ? appUrl(app.id, path) : null;
  useEffect(() => {
    if (!probeUrl) return;
    let live = true;
    setProbe("checking");
    void probeApp(probeUrl).then((p) => {
      if (live) setProbe(p);
    });
    return () => {
      live = false;
    };
    // The path is left out: the frame navigating inside the app is not a reason to probe again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id, app?.port, app?.compat, reloadKey]);

  const appPorts = new Set((apps ?? []).map((a) => a.port));
  const others = ports.filter((p) => !appPorts.has(p.port) && (showSystem || !p.system));

  const picker = (
    <AppPicker
      apps={apps}
      others={others}
      selected={appId}
      readable={portsReadable}
      showSystem={showSystem}
      onToggleSystem={setShowSystem}
      onSelectApp={(id) => openApp(id)}
      onSelectPort={(p) => void openPort(p)}
    />
  );

  if (!app) {
    const nothing = (apps?.length ?? 0) === 0 && others.length === 0;
    return (
      <div className="prev">
        {picker}
        <div className="empty">
          <span className="empty-glyph" aria-hidden="true">
            <Radio size={22} />
          </span>
          {apps === null ? (
            <p className="empty-title">Loading apps…</p>
          ) : !portsReadable && nothing ? (
            <>
              <p className="empty-title">Couldn&apos;t read ports.</p>
              <p className="empty-sub">The bridge could not read /proc to list listening ports.</p>
            </>
          ) : nothing ? (
            <>
              <p className="empty-title">Nothing is running yet.</p>
              <p className="empty-sub">
                Ask an agent to put something in your preview, or run <code>agentbox-preview start -- npm run dev</code> in
                any pane.
              </p>
            </>
          ) : (
            <>
              <p className="empty-title">No app picked.</p>
              <p className="empty-sub">Choose one above and it loads in place.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const commitPath = () => setInspector({ path: normalisePath(pathDraft) });
  const src = appUrl(app.id, path);
  const frameWidth = device === "auto" ? "100%" : `${device}px`;
  const reload = () => setReloadKey((k) => k + 1);

  const togglePanel = (which: "share" | "info") => setPanel((p) => (p === which ? null : which));

  const setCompat = (on: boolean) => {
    updateApp(app.id, { compat: on ? "auto" : "off" })
      .then(() => refreshApps())
      .then(reload)
      .catch((err) => reportRpcError("app.update", err));
  };

  const start = () => {
    restartApp(app.id)
      .then(() => setTimeout(reload, 1500))
      .catch((err) => reportRpcError("app.update", err));
  };

  return (
    <div className="prev">
      {picker}

      <div className="prev-bar">
        <span className="prev-origin" title={`Port ${app.port}`}>
          {app.name}
        </span>
        <input
          className="prev-path"
          value={pathDraft}
          aria-label="Path"
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitPath()}
          onBlur={commitPath}
        />
        {sharingEnabled && (
          <button
            className={`icon-btn${panel === "share" ? " is-active" : ""}`}
            aria-label="Share"
            aria-expanded={panel === "share"}
            title="Share"
            onClick={() => togglePanel("share")}
          >
            <Share2 size={14} />
          </button>
        )}
        <button className="icon-btn" aria-label="Reload" title="Reload" onClick={reload}>
          <RotateCw size={14} />
        </button>
        <button
          className="icon-btn"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={14} />
        </button>
        <button
          className={`icon-btn${panel === "info" ? " is-active" : ""}`}
          aria-label="About this app"
          aria-expanded={panel === "info"}
          title="About this app"
          onClick={() => togglePanel("info")}
        >
          <Info size={14} />
        </button>
      </div>

      {isPublic(app) && panel !== "share" && (
        <div className="prev-share" role="group" aria-label="Shared">
          <p className="prev-share-banner">
            {app.visibility.mode === "passcode" ? <KeyRound size={13} aria-hidden="true" /> : <Globe size={13} aria-hidden="true" />}
            <span>
              {app.visibility.mode === "passcode" ? "Shared with a passcode" : "Public: anyone with the link can open it"},{" "}
              {expiryLabel(app.visibility.expiresAt)}.
            </span>
            <button className="btn btn-ghost btn-small" onClick={() => setPanel("share")}>
              Manage
            </button>
          </p>
        </div>
      )}

      {panel === "share" && sharingEnabled && (
        <SharePanel app={app} copied={copied} onCopy={copy} onChanged={() => void refreshApps()} onClose={() => setPanel(null)} />
      )}

      {panel === "info" && <InfoPanel app={app} copied={copied} onCopy={copy} onCompat={setCompat} />}

      {probe !== "checking" && probe.hint && app.compat === "auto" && (
        <p className="prev-note" role="note">
          <span>
            This app assumes it runs at <code>/</code>. Start it with <code>agentbox-preview</code> or set its base path to{" "}
            <code>/a/{app.id}/</code>.
          </span>
          <button
            className="icon-btn is-sm"
            aria-label="Copy the base path"
            title="Copy the base path"
            onClick={() => copy("base", `/a/${app.id}/`)}
          >
            {copied === "base" ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </p>
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

      <div className={`prev-frame-wrap${device === "auto" ? " is-auto" : ""}`}>
        {probe !== "checking" && probe.state === "ready" ? (
          <iframe
            key={`${app.id}:${reloadKey}`}
            className="prev-frame"
            style={{ width: frameWidth }}
            src={src}
            title={`Preview of ${app.name}`}
            sandbox={APP_FRAME_SANDBOX}
          />
        ) : (
          <PreviewStatus
            port={app.port}
            state={probe === "checking" ? "checking" : "down"}
            onRetry={reload}
            onStart={app.command && app.cwd ? start : null}
          />
        )}
      </div>
    </div>
  );
}

interface SharePanelProps {
  app: AppView;
  copied: string | null;
  onCopy(key: string, text: string): void;
  onChanged(): void;
  onClose(): void;
}

/** Who may open the app: private, anyone with the link, or the link and a passcode — until when. */
export function SharePanel({ app, copied, onCopy, onChanged, onClose }: SharePanelProps) {
  const reportRpcError = useApp((s) => s.reportRpcError);
  const [mode, setMode] = useState<AppVisibilityMode>(app.visibility.mode === "private" ? "link" : app.visibility.mode);
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shared = isPublic(app);
  const link = appLink(app.id);
  // A passcode typed must be long enough; none typed, the box makes one (or
  // an app already behind one keeps it).
  const tooShort = mode === "passcode" && passcode.length > 0 && passcode.length < MIN_PASSCODE;
  const needsPasscode = tooShort;

  const apply = () => {
    setBusy(true);
    setError(null);
    shareApp(app.id, {
      mode,
      expiresIn: EXPIRIES[expiry]?.seconds ?? null,
      ...(mode === "passcode" && passcode ? { passcode } : {}),
    })
      .then((shared) => {
        // The box made one: show it, to be copied and handed on.
        setPasscode(shared.passcode ?? passcode);
        onChanged();
        onCopy("link", link);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const stop = () => {
    setBusy(true);
    stopSharing(app.id)
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err) => reportRpcError("app.share", err))
      .finally(() => setBusy(false));
  };

  return (
    <div className="prev-share" role="group" aria-label="Share this app">
      {shared && (
        <p className="prev-share-banner">
          <Globe size={13} aria-hidden="true" />
          <span>
            {app.visibility.mode === "passcode" ? "Shared with a passcode" : "Public: anyone with the link can open it"},{" "}
            {expiryLabel(app.visibility.expiresAt)}.
          </span>
        </p>
      )}
      <div className="prev-share-link">
        <input className="prev-share-url" readOnly value={link} aria-label="Link" />
        <button className="icon-btn" aria-label="Copy link" title="Copy link" onClick={() => onCopy("link", link)}>
          {copied === "link" ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="prev-share-modes" role="radiogroup" aria-label="Who can open it">
        {(
          [
            ["link", "Anyone with the link", Globe],
            ["passcode", "Link and a passcode", KeyRound],
          ] as const
        ).map(([m, label, Icon]) => (
          <label key={m} className={`prev-share-mode${mode === m ? " is-active" : ""}`}>
            <input type="radio" name="share-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
            <Icon size={13} aria-hidden="true" />
            {label}
          </label>
        ))}
      </div>
      {mode === "passcode" && (
        <div className="prev-share-link">
          <input
            className="input prev-share-passcode"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="Passcode"
            placeholder={
              app.visibility.mode === "passcode"
                ? "New passcode (leave empty to keep it)"
                : `${MIN_PASSCODE} characters or more, or leave empty for one made for you`
            }
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
          <button className="icon-btn" aria-label="Make a passcode" title="Make a passcode" onClick={() => setPasscode(makePasscode())}>
            <Dices size={14} />
          </button>
          <button
            className="icon-btn"
            aria-label="Copy passcode"
            title="Copy passcode"
            disabled={passcode === ""}
            onClick={() => onCopy("passcode", passcode)}
          >
            {copied === "passcode" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      )}
      {tooShort && <p className="prev-share-error">A passcode is at least {MIN_PASSCODE} characters.</p>}
      <label className="prev-share-expiry">
        <span>For</span>
        <select className="input" aria-label="How long" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
          {EXPIRIES.map((x, i) => (
            <option key={x.label} value={i}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="prev-share-error" role="alert">
          {error}
        </p>
      )}
      <div className="prev-share-actions">
        <button className="btn btn-primary btn-small" disabled={busy || needsPasscode} onClick={apply}>
          {shared ? "Update sharing" : "Share and copy link"}
        </button>
        {shared ? (
          <button className="btn btn-danger btn-small" disabled={busy} onClick={stop}>
            <Lock size={13} aria-hidden="true" /> Stop sharing
          </button>
        ) : (
          <button className="btn btn-ghost btn-small" onClick={onClose}>
            <X size={13} aria-hidden="true" /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}

interface InfoPanelProps {
  app: AppView;
  copied: string | null;
  onCopy(key: string, text: string): void;
  onCompat(on: boolean): void;
}

/** The path-fixes switch, how to open the app at full fidelity, and what an app here cannot do. */
function InfoPanel({ app, copied, onCopy, onCompat }: InfoPanelProps) {
  const command = forwardCommand(app.port);
  return (
    <div className="prev-info" role="group" aria-label="About this app">
      <label className="prev-info-row">
        <input type="checkbox" checked={app.compat === "auto"} onChange={(e) => onCompat(e.target.checked)} />
        <span>
          <strong>Path fixes</strong> — rewrite the app&apos;s pages so an app built for <code>/</code> works under{" "}
          <code>/a/{app.id}/</code>. Turn off for an app started with that base path.
        </span>
      </label>
      <div className="prev-info-row">
        <span>
          <strong>Open on your machine</strong> — at full fidelity, on <code>http://localhost:{app.port}</code>, with the
          agentbox CLI:
        </span>
      </div>
      <div className="prev-share-link">
        <input className="prev-share-url" readOnly value={command} aria-label="Command" />
        <button className="icon-btn" aria-label="Copy command" title="Copy command" onClick={() => onCopy("forward", command)}>
          {copied === "forward" ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <p className="prev-info-limits">
        Apps run with an opaque origin, here and full screen: no service workers or IndexedDB, and storage resets on
        reload. An app that writes its own absolute address into its pages may need its base path set.
      </p>
    </div>
  );
}

interface PreviewStatusProps {
  port: number;
  state: "checking" | "down";
  onRetry(): void;
  /** Start the app's command again, when it has one. */
  onStart: (() => void) | null;
}

/** The in-app checking / not-responding state, shown in place of the frame. */
function PreviewStatus({ port, state, onRetry, onStart }: PreviewStatusProps) {
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
      <div className="empty-actions">
        <button className="btn btn-primary btn-small" onClick={onRetry}>
          <RotateCw size={13} aria-hidden="true" /> Retry
        </button>
        {onStart && (
          <button className="btn btn-small" onClick={onStart}>
            <Play size={13} aria-hidden="true" /> Start it
          </button>
        )}
      </div>
    </div>
  );
}

interface AppPickerProps {
  apps: AppView[] | null;
  others: { port: number; process: string | null; system: boolean }[];
  selected: string | null;
  readable: boolean;
  showSystem: boolean;
  onToggleSystem(v: boolean): void;
  onSelectApp(id: string): void;
  onSelectPort(port: number): void;
}

function AppPicker({ apps, others, selected, readable, showSystem, onToggleSystem, onSelectApp, onSelectPort }: AppPickerProps) {
  return (
    <div className="port-list">
      <div className="port-list-head">
        <span className="section-label">Apps</span>
      </div>
      <ul className="ports" aria-label="Apps">
        {apps !== null && apps.length === 0 && <li className="ports-empty">No apps yet</li>}
        {(apps ?? []).map((a) => (
          <li key={a.id}>
            <button className={`port-row${a.id === selected ? " is-active" : ""}`} onClick={() => onSelectApp(a.id)}>
              <span
                className={`port-dot${a.live.listening ? " is-up" : ""}`}
                role="img"
                aria-label={a.live.listening ? "serving" : "not serving"}
                title={a.live.listening ? "Serving" : "Not serving"}
              />
              <span className="port-proc">{a.name}</span>
              <span className="port-num">:{a.port}</span>
              {a.visibility.mode !== "private" && (
                <span className="port-tag is-public" title="Shared">
                  <Globe size={10} aria-hidden="true" /> {a.visibility.mode === "passcode" ? "passcode" : "public"}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="port-list-head">
        <span className="section-label">Also listening</span>
        <label className="port-system-toggle">
          <input type="checkbox" checked={showSystem} onChange={(e) => onToggleSystem(e.target.checked)} />
          System ports
        </label>
      </div>
      <ul className="ports" aria-label="Also listening">
        {others.length === 0 && <li className="ports-empty">{readable ? "Nothing else" : "Couldn't read ports"}</li>}
        {others.map((p) => (
          <li key={p.port}>
            <button
              className="port-row"
              disabled={p.system}
              title={p.system ? "One of agentbox's own services" : "Show it in Preview (makes it an app)"}
              onClick={() => onSelectPort(p.port)}
            >
              <AppWindow size={12} aria-hidden="true" />
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
