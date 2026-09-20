import type { AgentInfo } from "@workbench/shared";
import { agentsSorted, type Session } from "../store/session.ts";
import { StatusBadge } from "./StatusBadge.tsx";

interface Props {
  session: Session;
  onFocusPane(paneId: string): void;
}

function displayName(a: AgentInfo): string {
  return a.name || a.display_agent || a.agent || "agent";
}

function basename(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function AgentList({ session, onFocusPane }: Props) {
  const agents = agentsSorted(session);
  const wsLabel = new Map(session.workspaces.map((w) => [w.workspace_id, w.label]));

  if (agents.length === 0) {
    return <p className="agents-empty">No agents detected yet.</p>;
  }

  return (
    <ul className="agent-list">
      {agents.map((a) => {
        const cwd = basename(a.foreground_cwd ?? a.cwd);
        return (
          <li key={a.pane_id}>
            <button
              className={`agent-row${a.pane_id === session.focusedPaneId ? " is-focused" : ""}`}
              onClick={() => onFocusPane(a.pane_id)}
            >
              <StatusBadge status={a.agent_status} />
              <span className="agent-name">{displayName(a)}</span>
              <span className="agent-meta">
                <span className="agent-ws">{wsLabel.get(a.workspace_id) ?? a.workspace_id}</span>
                {cwd && <span className="agent-sep" aria-hidden="true">·</span>}
                {cwd && <span className="agent-cwd">{cwd}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
