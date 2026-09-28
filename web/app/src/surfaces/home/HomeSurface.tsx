import { useEffect, useMemo, useState } from "react";
import { AppWindow, ArrowRight, CheckCircle2, CloudOff, ExternalLink, FolderPlus, GitBranch, Plus } from "lucide-react";
import { useApp } from "../../store/app.ts";
import { useApps, type AppView } from "../../apps/model.ts";
import { LiveBadge, VisibilityBadge } from "../../apps/badges.tsx";
import { openAppFullScreen, openAppInDock, showApp } from "../../apps/open.ts";
import { useProjects } from "../../projects/model.ts";
import { useSystem } from "../../system/model.ts";
import { formatBytes, formatCores, formatDuration, formatMemory, greeting, plural } from "../../lib/format.ts";
import { Empty, PageHeader, Section } from "../../components/ui/Page.tsx";
import { Meter } from "../../components/ui/Meter.tsx";
import { usePolling, useWhenHidden } from "../../shell/activity.tsx";
import { useNeeds } from "../../shell/attention.ts";
import { navigate } from "../../shell/router.ts";
import { useGateSession } from "../../shell/session.ts";
import { useRequests } from "../../shell/requests.ts";
import { useOutOfReach } from "../../shell/health.ts";
import { launchableAgents } from "../../workbench/launch.ts";
import { NeedsYou } from "./NeedsYou.tsx";
import { CloneCard, ProjectCard } from "./ProjectCard.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";

function ProjectSkeletons() {
  return (
    <div className="card-grid" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card project-card is-skeleton">
          <div className="skeleton" style={{ width: "40%", height: 14 }} />
          <div className="skeleton" style={{ width: "70%", height: 10, marginTop: 10 }} />
          <div className="skeleton" style={{ width: "100%", height: 28, marginTop: 22 }} />
        </div>
      ))}
    </div>
  );
}

function AppRow({ app }: { app: AppView }) {
  return (
    <li className="app-row">
      <button className="app-row-main" onClick={() => showApp(app.id)}>
        <span className="app-row-name">{app.name}</span>
        <span className="app-row-port">:{app.port}</span>
      </button>
      <LiveBadge app={app} />
      <VisibilityBadge app={app} />
      <span className="app-row-actions">
        <button className="btn btn-small btn-ghost" onClick={() => openAppInDock(app)} disabled={!app.live.listening}>
          Preview
        </button>
        <button className="icon-btn" aria-label={`Open ${app.name} in a new tab`} title="Open in a new tab" onClick={() => openAppFullScreen(app)}>
          <ExternalLink size={14} />
        </button>
      </span>
    </li>
  );
}

/**
 * Home: where the box stands, at a glance. What needs you comes first — one
 * step to each thing — then your projects with what is running in them, your
 * apps, and how the box itself is doing.
 */
export function HomeSurface() {
  const needs = useNeeds();
  const session = useApp((s) => s.session);
  const user = useGateSession((s) => s.session?.user ?? null);
  const projects = useProjects((s) => s.projects);
  const projectsError = useProjects((s) => s.error);
  const clones = useProjects((s) => s.clones);
  const dismissClone = useProjects((s) => s.dismissClone);
  const apps = useApps((s) => s.apps);
  const appsSupported = useApps((s) => s.supported);
  const appsError = useApps((s) => s.error);
  const system = useSystem((s) => s.info);
  const systemError = useSystem((s) => s.error);
  const lost = useOutOfReach();
  const [newProject, setNewProject] = useState<null | "clone" | "empty">(null);
  useWhenHidden(() => setNewProject(null));

  // "New project" from the palette lands here — even before Home was built.
  const requested = useRequests((s) => s.newProject);
  useEffect(() => {
    if (!requested) return;
    setNewProject(requested);
    useRequests.setState({ newProject: null });
  }, [requested]);

  usePolling(() => useProjects.getState().refresh(), 10_000);
  usePolling(() => useSystem.getState().refresh(), 5_000);

  const working = Object.values(session.agents).filter((a) => a.agent_status === "working").length;
  const running = (apps ?? []).filter((a) => a.live.listening).length;
  const agents = useMemo(() => launchableAgents(system?.versions.agents ?? [{ name: "claude" }]), [system]);

  // What is running, when it can be known. Out of reach, the last word
  // from the box is not "nothing is running".
  const summary = lost
    ? "The box is not answering. Reconnecting…"
    : [
        working ? `${plural(working, "agent")} working` : "No agents working",
        appsSupported && apps !== null ? (running ? `${plural(running, "app")} running` : "no apps running") : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const cloneList = Object.values(clones);
  const workspaceDisk = system?.disks.find((d) => d.label === "workspace");

  return (
    <div className="page home">
      <div className="page-inner">
        <PageHeader
          title={user ? `${greeting()}, ${user}` : greeting()}
          subtitle={
            <>
              {location.host}
              {system?.uptime.box != null && <> · up {formatDuration(system.uptime.box)}</>}
            </>
          }
          actions={
            <button className="btn btn-small" onClick={() => setNewProject("clone")}>
              <Plus size={14} aria-hidden="true" />
              New project
            </button>
          }
        />

        <section className={`home-hero${needs.length === 0 && !lost ? " is-clear" : ""}${lost ? " is-lost" : ""}`} aria-labelledby="needs-title">
          {needs.length > 0 ? (
            <div className="hero-figure" aria-hidden="true">
              {needs.length}
            </div>
          ) : lost ? (
            <span className="hero-clear" aria-hidden="true">
              <CloudOff size={20} />
            </span>
          ) : (
            <span className="hero-clear" aria-hidden="true">
              <CheckCircle2 size={20} />
            </span>
          )}
          <div className="hero-text">
            {/* The figure shows the count; the heading does not say it twice
                (a screen reader, which skips the figure, hears it here). */}
            <h2 className="section-label" id="needs-title">
              {needs.length === 0 ? (
                lost ? (
                  "Out of reach"
                ) : (
                  "Nothing needs you"
                )
              ) : (
                <>
                  <span className="sr-only">{needs.length} </span>
                  {needs.length === 1 ? "Needs you" : "Need you"}
                </>
              )}
            </h2>
            <p className="hero-sub">{summary}</p>
          </div>
        </section>
        {needs.length > 0 && <NeedsYou needs={needs} />}

        <Section
          title="Projects"
          count={projects?.length}
          id="projects"
          action={
            <button className="btn btn-small btn-ghost" onClick={() => setNewProject("empty")}>
              <FolderPlus size={14} aria-hidden="true" />
              Empty folder
            </button>
          }
        >
          {projects === null && !projectsError ? (
            <ProjectSkeletons />
          ) : projects === null ? (
            <Empty title="Couldn't read the workspace." sub={projectsError} action={<button className="btn btn-small" onClick={() => void useProjects.getState().refresh()}>Retry</button>} compact />
          ) : projects.length === 0 && cloneList.length === 0 ? (
            <Empty
              icon={<GitBranch size={22} />}
              title="No projects yet."
              sub="Clone a repository or make a folder, and it shows up here with what is running in it."
              action={
                <button className="btn btn-small btn-primary" onClick={() => setNewProject("clone")}>
                  Clone a repository
                </button>
              }
            />
          ) : (
            <div className="card-grid">
              {cloneList.map((c) => (
                <CloneCard key={c.id} clone={c} onDismiss={() => dismissClone(c.id)} />
              ))}
              {projects.map((p) => (
                <ProjectCard key={p.path} project={p} agents={agents} />
              ))}
            </div>
          )}
        </Section>

        {appsSupported !== false && (
          <Section
            title="Apps"
            count={apps?.length}
            id="apps"
            action={
              <button className="btn btn-small btn-ghost" onClick={() => navigate({ surface: "apps" })}>
                All apps
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            }
          >
            {apps === null && appsError ? (
              <Empty
                compact
                title="Couldn't read the apps."
                sub={appsError}
                action={
                  <button className="btn btn-small" onClick={() => void useApps.getState().refresh()}>
                    Retry
                  </button>
                }
              />
            ) : apps === null ? (
              <div className="skeleton" style={{ height: 44 }} aria-hidden="true" />
            ) : apps.length === 0 ? (
              <Empty
                compact
                icon={<AppWindow size={22} />}
                title="No apps yet."
                sub={
                  <>
                    Ask an agent to put something in your preview, or run <code>agentbox-preview start -- npm run dev</code> in a terminal.
                  </>
                }
              />
            ) : (
              <ul className="app-list">
                {apps.map((a) => (
                  <AppRow key={a.id} app={a} />
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section
          title="System"
          id="system"
          action={
            <button className="btn btn-small btn-ghost" onClick={() => navigate({ surface: "system", view: "overview" })}>
              Details
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          }
        >
          {!system && systemError && (
            <p className="section-note" role="status">
              Couldn't read the system. {systemError}
            </p>
          )}
          <div className="meter-row">
            <Meter
              compact
              label="CPU"
              fraction={system?.sandbox.cpu != null ? system.sandbox.cpu / system.host.cores : null}
              value={system ? formatCores(system.sandbox.cpu, system.host.cores) : "—"}
              sub="The sandbox, of the host's cores"
            />
            <Meter
              compact
              label="Memory"
              fraction={system ? system.sandbox.memory / system.host.memory : null}
              value={system ? `${formatMemory(system.sandbox.memory)} of ${formatMemory(system.host.memory)}` : "—"}
              sub="The sandbox, of the host's memory"
            />
            <Meter
              compact
              label="Disk"
              fraction={workspaceDisk ? workspaceDisk.used / workspaceDisk.total : null}
              value={workspaceDisk ? `${formatBytes(workspaceDisk.used)} of ${formatBytes(workspaceDisk.total)}` : "—"}
              sub="The workspace volume"
            />
          </div>
        </Section>
      </div>
      {newProject && <NewProjectDialog initial={newProject} onClose={() => setNewProject(null)} />}
    </div>
  );
}
