import { useMemo, useState } from "react";
import {
  AppWindow,
  Code2,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCw,
  Share2,
  Square,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { ListeningPort } from "@workbench/shared";
import { useApp } from "../../store/app.ts";
import { appsApi, isPublic, useApps, type AppView } from "../../apps/model.ts";
import { LiveBadge, VisibilityBadge } from "../../apps/badges.tsx";
import { openAppFullScreen, openAppInDock } from "../../apps/open.ts";
import { ShareDialog } from "../../apps/ShareDialog.tsx";
import { formatAgo } from "../../lib/format.ts";
import { Empty, PageHeader, Section } from "../../components/ui/Page.tsx";
import { Menu, type MenuAnchor, type MenuEntry } from "../../components/ui/Menu.tsx";
import { confirm, promptText } from "../../components/ui/prompts.tsx";
import { usePolling, useWhenHidden } from "../../shell/activity.tsx";
import { openInEditor } from "../../shell/editor.ts";
import { useRouter } from "../../shell/router.ts";
import { toast, toastError } from "../../shell/toast.ts";
import { terminalHere } from "../../workbench/launch.ts";

async function act(label: string, fn: () => Promise<unknown>, done?: string): Promise<void> {
  try {
    await fn();
    if (done) toast("success", done);
  } catch (err) {
    toastError(label, err);
  }
  void useApps.getState().refresh();
}

/**
 * Make an app of a port something is listening on — in one click, named after
 * its process (rename it later); private until shared.
 */
async function makeApp(port: number, suggested?: string | null): Promise<void> {
  const name = suggested && /^[\w .-]{1,40}$/.test(suggested) ? suggested : `port-${port}`;
  try {
    const app = await appsApi.create({ port, name });
    void useApps.getState().refresh();
    useRouter.getState().navigate({ surface: "apps", appId: app.id });
    openAppInDock(app);
  } catch (err) {
    toastError(`Couldn't make an app of port ${port}.`, err);
  }
}

function appMenu(app: AppView, onShare: () => void): MenuEntry[] {
  const shared = isPublic(app);
  return [
    { label: "Preview", icon: AppWindow, onSelect: () => openAppInDock(app) },
    { label: "Open in a new tab", icon: ExternalLink, onSelect: () => openAppFullScreen(app) },
    { label: shared ? "Sharing…" : "Share…", icon: Share2, onSelect: onShare },
    { label: "Copy link", icon: Copy, onSelect: () => void navigator.clipboard.writeText(`${location.origin}${app.url}`).then(() => toast("info", "Copied the link.")) },
    { separator: true },
    ...(app.command
      ? [{ label: app.live.listening ? "Restart" : "Start", icon: app.live.listening ? RotateCw : Play, onSelect: () => void act(`Couldn't restart ${app.name}.`, () => appsApi.restart(app.id)) }]
      : []),
    ...(app.live.listening ? [{ label: "Stop", icon: Square, onSelect: () => void act(`Couldn't stop ${app.name}.`, () => appsApi.stop(app.id), `Stopped ${app.name}.`) }] : []),
    ...(app.cwd
      ? [
          { label: "Open its folder in the editor", icon: Code2, onSelect: () => void openInEditor(app.cwd!) },
          { label: "Terminal in its folder", icon: SquareTerminal, onSelect: () => void terminalHere(app.cwd!) },
        ]
      : []),
    { separator: true },
    {
      label: "Rename…",
      icon: Pencil,
      onSelect: async () => {
        const name = await promptText({ title: "Rename app", label: "Name", initial: app.name, confirmLabel: "Rename" });
        if (name && name !== app.name) await act(`Couldn't rename ${app.name}.`, () => appsApi.update(app.id, { name }));
      },
    },
    {
      label: app.pinned ? "Unpin" : "Pin (start with the box)",
      icon: app.pinned ? PinOff : Pin,
      disabled: !app.pinned && !app.command,
      onSelect: () => void act(`Couldn't change ${app.name}.`, () => appsApi.update(app.id, { pinned: !app.pinned })),
    },
    {
      label: app.compat === "auto" ? "Turn path fixes off" : "Turn path fixes on",
      icon: Wrench,
      onSelect: () => void act(`Couldn't change ${app.name}.`, () => appsApi.update(app.id, { compat: app.compat === "auto" ? "off" : "auto" })),
    },
    { separator: true },
    {
      label: "Delete…",
      icon: Trash2,
      danger: true,
      onSelect: async () => {
        const ok = await confirm({
          title: `Delete ${app.name}?`,
          body: "Its link stops working and it leaves this list. A server still running on the port keeps running.",
          confirmLabel: "Delete",
        });
        if (ok) await act(`Couldn't delete ${app.name}.`, () => appsApi.remove(app.id), `Deleted ${app.name}.`);
      },
    },
  ];
}

function AppRow({ app, selected, onSelect, onShare, onMenu }: { app: AppView; selected: boolean; onSelect(): void; onShare(): void; onMenu(a: MenuAnchor): void }) {
  const session = useApp((s) => s.session);
  const pane = app.live.paneId ? session.panes[app.live.paneId] : undefined;
  const where = [
    app.live.listening && app.live.process ? `${app.live.process}${app.live.pid ? ` · pid ${app.live.pid}` : ""}` : null,
    pane ? `in the pane “${pane.label || pane.terminal_title_stripped || pane.pane_id}”` : null,
    app.createdBy === "agent" ? `made by an agent ${formatAgo(app.createdAt)}` : `made ${formatAgo(app.createdAt)}`,
    app.pinned ? "pinned" : null,
  ].filter(Boolean);
  return (
    <li className={`apps-row${selected ? " is-selected" : ""}`}>
      <button className="apps-row-main" onClick={onSelect} aria-current={selected ? "true" : undefined}>
        <span className={`apps-light${app.live.listening ? " is-live" : ""}`} aria-hidden="true" />
        <span className="apps-row-text">
          <span className="apps-row-title">
            <span className="apps-name">{app.name}</span>
            <span className="apps-port">:{app.port}</span>
          </span>
          <span className="apps-row-sub">{where.join(" · ")}</span>
        </span>
      </button>
      <span className="apps-row-badges">
        <LiveBadge app={app} />
        <VisibilityBadge app={app} />
      </span>
      <span className="apps-row-actions">
        <button className="btn btn-small btn-ghost" onClick={() => openAppInDock(app)}>
          Preview
        </button>
        <button className="btn btn-small btn-ghost" onClick={onShare}>
          <Share2 size={14} aria-hidden="true" />
          {isPublic(app) ? "Sharing" : "Share"}
        </button>
        <button className="icon-btn" aria-label={`Open ${app.name} in a new tab`} title="Open in a new tab" onClick={() => openAppFullScreen(app)}>
          <ExternalLink size={14} />
        </button>
        <button className="icon-btn" aria-label={`More for ${app.name}`} aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)}>
          <MoreHorizontal size={15} />
        </button>
      </span>
    </li>
  );
}

function Detail({ app, onShare }: { app: AppView; onShare(): void }) {
  const props: [string, React.ReactNode][] = [
    ["Link", <code key="l">{`${location.origin}${app.url}`}</code>],
    ["Port", <span key="p" className="mono">{app.port}</span>],
    ["Id", <span key="i" className="mono">{app.id}</span>],
    ["Folder", app.cwd ? <span className="mono">{app.cwd}</span> : "—"],
    ["Command", app.command ? <span className="mono">{app.command}</span> : "None — it was not started through agentbox"],
    ["Path fixes", app.compat === "auto" ? "On: served under /a/<id>/ as if at the root" : "Off: HTML passes through untouched"],
    ["Base path", app.keepPrefix ? "Configured for /a/<id>/ (the full path is forwarded)" : "The root (the prefix is stripped)"],
    ["Starts with the box", app.pinned ? "Yes (pinned)" : "No"],
  ];
  return (
    <section className="apps-detail" aria-label={`${app.name} details`}>
      <header className="apps-detail-head">
        <h2 className="card-title">{app.name}</h2>
        <VisibilityBadge app={app} />
      </header>
      <dl className="props">
        {props.map(([k, v]) => (
          <div className="prop" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="apps-detail-actions">
        <button className="btn btn-small btn-primary" onClick={() => openAppInDock(app)}>
          Preview
        </button>
        <button className="btn btn-small" onClick={onShare}>
          <Share2 size={14} aria-hidden="true" />
          {isPublic(app) ? "Change sharing" : "Share"}
        </button>
        {app.command && (
          <button className="btn btn-small" onClick={() => void act(`Couldn't restart ${app.name}.`, () => appsApi.restart(app.id))}>
            <RotateCw size={14} aria-hidden="true" />
            {app.live.listening ? "Restart" : "Start"}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Apps: every dev server the box knows as an app — its link, whether it is
 * running, who made it, who can open it and until when — with Preview,
 * Share, restart, stop and the rest a click away. Ports something listens on
 * that are not apps yet sit below, one click from being one.
 */
export function AppsSurface() {
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const apps = useApps((s) => s.apps);
  const supported = useApps((s) => s.supported);
  const error = useApps((s) => s.error);
  const ports = useApp((s) => s.ports);
  const [sharing, setSharing] = useState<AppView | null>(null);
  const [menu, setMenu] = useState<{ app: AppView; anchor: MenuAnchor } | null>(null);
  useWhenHidden(() => {
    setSharing(null);
    setMenu(null);
  });

  usePolling(() => useApps.getState().refresh(), 5000, supported !== false);

  const selectedId = route.surface === "apps" ? (route.appId ?? null) : null;
  const selected = apps?.find((a) => a.id === selectedId) ?? null;
  const appPorts = useMemo(() => new Set((apps ?? []).map((a) => a.port)), [apps]);
  const also: ListeningPort[] = ports.filter((p) => !p.system && !appPorts.has(p.port));

  return (
    <div className="page apps">
      <div className="page-inner">
        <PageHeader
          title="Apps"
          subtitle="Servers in the box, each with its own link. Private until you share them."
          actions={
            supported !== false && (
              <button
                className="btn btn-small"
                onClick={async () => {
                  const raw = await promptText({
                    title: "Make an app",
                    label: "Port",
                    placeholder: "5173",
                    confirmLabel: "Next",
                    validate: (v) => (/^\d{2,5}$/.test(v) && Number(v) < 65536 ? null : "A port is a number, like 5173."),
                  });
                  if (raw) await makeApp(Number(raw));
                }}
              >
                <Plus size={14} aria-hidden="true" />
                Make an app
              </button>
            )
          }
        />

        {supported === false ? (
          <Empty
            icon={<AppWindow size={22} />}
            title="This box does not serve apps yet."
            sub="Update agentbox to get apps: a link per dev server, a Preview that runs real apps, and sharing."
          />
        ) : error && apps === null ? (
          <Empty title="Couldn't read the apps." sub={error} action={<button className="btn btn-small" onClick={() => void useApps.getState().refresh()}>Retry</button>} />
        ) : apps === null ? (
          <div className="skeleton" style={{ height: 120 }} aria-hidden="true" />
        ) : apps.length === 0 ? (
          <Empty
            icon={<AppWindow size={22} />}
            title="No apps yet."
            sub={
              <>
                Ask an agent to put something in your preview, run <code>agentbox-preview start -- npm run dev</code> in a terminal, or make an app of a
                port below.
              </>
            }
          />
        ) : (
          <div className={`apps-layout${selected ? " has-detail" : ""}`}>
            <ul className="apps-list">
              {apps.map((a) => (
                <AppRow
                  key={a.id}
                  app={a}
                  selected={a.id === selectedId}
                  onSelect={() => navigate({ surface: "apps", ...(a.id === selectedId ? {} : { appId: a.id }) })}
                  onShare={() => setSharing(a)}
                  onMenu={(anchor) => setMenu({ app: a, anchor })}
                />
              ))}
            </ul>
            {selected && <Detail app={selected} onShare={() => setSharing(selected)} />}
          </div>
        )}

        <Section title="Also listening" count={also.length} id="also">
          {also.length === 0 ? (
            <p className="section-note">Nothing else is listening. A server an agent starts shows up here until it is an app.</p>
          ) : (
            <ul className="app-list">
              {also.map((p) => (
                <li key={`${p.address}:${p.port}`} className="app-row">
                  <span className="app-row-main is-static">
                    <span className="app-row-name mono">:{p.port}</span>
                    <span className="app-row-port">
                      {p.process ?? "unknown process"}
                      {p.cwd ? ` · ${p.cwd}` : ""}
                    </span>
                  </span>
                  <span className="app-row-actions">
                    {supported ? (
                      <button className="btn btn-small" onClick={() => void makeApp(p.port, p.process)}>
                        Make an app
                      </button>
                    ) : (
                      <button className="btn btn-small btn-ghost" onClick={() => useApp.getState().setInspector({ open: true, tab: "preview", port: p.port, path: "/" } as never)}>
                        Preview
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      {sharing && <ShareDialog app={sharing} onClose={() => setSharing(null)} />}
      {menu && <Menu anchor={menu.anchor} label={`Actions for ${menu.app.name}`} align="end" items={appMenu(menu.app, () => setSharing(menu.app))} onClose={() => setMenu(null)} />}
    </div>
  );
}
