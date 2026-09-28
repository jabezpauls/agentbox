import { useId, useRef } from "react";
import { Bot, ChevronDown, Code2, Folder, GitBranch, SquareTerminal, X } from "lucide-react";
import type { Project } from "@workbench/shared";
import { formatAgo, plural } from "../../lib/format.ts";
import { StatusBadge, STATUS_LABELS } from "../../components/StatusBadge.tsx";
import { Menu, useMenu } from "../../components/ui/Menu.tsx";
import { openInEditor } from "../../shell/editor.ts";
import { navigate } from "../../shell/router.ts";
import { agentHere, agentLabel, terminalHere } from "../../workbench/launch.ts";
import { projectsApi, type Clone } from "../../projects/model.ts";
import { toastError } from "../../shell/toast.ts";

/** A project's git line: "3 changes · ↑2 ↓1 · changed 5 min ago". */
function gitLine(p: Project): string {
  const parts: string[] = [];
  const g = p.git;
  if (g) {
    parts.push(g.uncommitted === 0 ? "Clean" : plural(g.uncommitted, "change"));
    if (g.ahead) parts.push(`↑${g.ahead}`);
    if (g.behind) parts.push(`↓${g.behind}`);
  } else {
    parts.push("Not a repository");
  }
  parts.push(`changed ${formatAgo(p.lastChange)}`);
  return parts.join(" · ");
}

/** The "New agent" control: one agent starts at once, several offer a choice. */
export function NewAgentButton({ cwd, agents, label = "Agent" }: { cwd: string; agents: string[]; label?: string }) {
  const menu = useMenu();
  const ref = useRef<HTMLButtonElement>(null);
  const only = agents.length <= 1;
  return (
    <>
      <button
        ref={ref}
        className="btn btn-small btn-ghost"
        aria-haspopup={only ? undefined : "menu"}
        aria-expanded={only ? undefined : menu.anchor !== null}
        title={only ? `Start ${agentLabel(agents[0] ?? "claude")} here` : "Start an agent here"}
        onClick={() => (only ? void agentHere(cwd, agents[0] ?? "claude") : menu.open(ref.current!))}
      >
        <Bot size={14} aria-hidden="true" />
        {label}
        {!only && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {menu.render((anchor) => (
        <Menu
          anchor={anchor}
          label="Start an agent"
          onClose={menu.close}
          items={[
            { heading: "Start here" },
            ...agents.map((a) => ({ label: agentLabel(a), icon: Bot, onSelect: () => void agentHere(cwd, a) })),
          ]}
        />
      ))}
    </>
  );
}

export function ProjectCard({ project, agents: launchable }: { project: Project; agents: string[] }) {
  const g = project.git;
  // Panes running an agent get a light each; plain terminals are counted.
  const agents = project.agents.filter((a): a is typeof a & { agent: string } => Boolean(a.agent));
  const shells = project.agents.length - agents.length;
  const openFiles = () => navigate({ surface: "files", path: project.path });
  // A folder's name can hold spaces and anything else; an id cannot.
  const titleId = useId();
  return (
    <article className="card project-card" aria-labelledby={titleId}>
      <div className="card-head">
        <span className="card-icon" aria-hidden="true">
          <Folder size={15} />
        </span>
        <h3 className="card-title" id={titleId}>
          <button className="linklike" onClick={openFiles} title={`Browse ${project.path}`}>
            {project.name}
          </button>
        </h3>
        {g && (
          <span className="branch" title={g.upstream ? `Tracking ${g.upstream}` : "No upstream"}>
            <GitBranch size={12} aria-hidden="true" />
            <span className="branch-name">{g.detached ? "detached" : (g.branch ?? "—")}</span>
          </span>
        )}
      </div>
      <p className="card-meta">{gitLine(project)}</p>
      {(project.agents.length > 0 || project.listeners.length > 0) && (
        <div className="card-live">
          {agents.slice(0, 3).map((a) => (
            <span key={a.paneId} className="card-chip" title={`${a.agent} · ${STATUS_LABELS[a.status]}`}>
              <StatusBadge status={a.status} />
              {a.agent}
            </span>
          ))}
          {agents.length > 3 && <span className="card-chip is-more">+{agents.length - 3}</span>}
          {shells > 0 && (
            <span className="card-chip is-more" title="Terminals open in this project">
              {plural(shells, "terminal")}
            </span>
          )}
          {project.listeners.map((l) => (
            <span key={l.port} className="card-chip is-port" title={l.process ? `${l.process} on port ${l.port}` : `Port ${l.port}`}>
              :{l.port}
              {l.process && <span className="card-chip-sub">{l.process}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="card-actions">
        <button className="btn btn-small btn-ghost" onClick={() => void openInEditor(project.path)} title="Open in the editor">
          <Code2 size={14} aria-hidden="true" />
          Editor
        </button>
        <button className="btn btn-small btn-ghost" onClick={openFiles} title="Browse its files">
          <Folder size={14} aria-hidden="true" />
          Files
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => void terminalHere(project.path)} title="Open a terminal here">
          <SquareTerminal size={14} aria-hidden="true" />
          Terminal
        </button>
        <NewAgentButton cwd={project.path} agents={launchable} />
      </div>
    </article>
  );
}

const PHASE: Record<Clone["phase"], string> = {
  started: "Starting",
  progress: "Cloning",
  done: "Cloned",
  error: "Couldn't clone",
  cancelled: "Cancelled",
};

/** A clone on its way in: git's stage and a progress bar, and a way to stop it. */
export function CloneCard({ clone, onDismiss }: { clone: Clone; onDismiss(): void }) {
  const pct = typeof clone.percent === "number" ? Math.max(0, Math.min(100, Math.round(clone.percent))) : null;
  const running = clone.phase === "started" || clone.phase === "progress";
  const cancel = () => projectsApi.cancelClone(clone.id).catch((err) => toastError("Couldn't stop the clone.", err));
  return (
    <article className={`card clone-card is-${clone.phase}`} aria-label={`Cloning ${clone.name}`} aria-busy={running}>
      <div className="card-head">
        <span className="card-icon" aria-hidden="true">
          <GitBranch size={15} />
        </span>
        <h3 className="card-title">{clone.name}</h3>
        {running ? (
          <button className="btn btn-small btn-ghost" onClick={() => void cancel()}>
            Stop
          </button>
        ) : (
          <button className="icon-btn is-sm" aria-label="Dismiss" onClick={onDismiss}>
            <X size={13} />
          </button>
        )}
      </div>
      <p className="card-meta">
        {PHASE[clone.phase]}
        {running && clone.stage ? ` · ${clone.stage}` : ""}
        {running && pct !== null ? ` · ${pct}%` : ""}
      </p>
      {clone.phase === "error" && clone.message && <p className="card-error">{clone.message}</p>}
      <div
        className="progress"
        role="progressbar"
        aria-label={`Cloning ${clone.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span className={`progress-fill${pct === null && running ? " is-indeterminate" : ""}`} style={{ width: `${clone.phase === "done" ? 100 : (pct ?? 0)}%` }} />
      </div>
      <p className="card-url" title={clone.url}>
        {clone.url}
      </p>
    </article>
  );
}
