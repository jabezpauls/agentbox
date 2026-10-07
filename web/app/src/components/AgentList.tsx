import type { AgentInfo, UsageSnapshot } from "@workbench/shared";
import { agentsSorted, type Session } from "../store/session.ts";
import { agentForPane, limitedWindow, modelShort, providerName, resetClock, severityClass, windowLong } from "../usage/model.ts";
import { StatusBadge } from "./StatusBadge.tsx";

interface Props {
  session: Session;
  usage?: UsageSnapshot | null;
  onFocusPane(paneId: string): void;
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

/**
 * What the agent in a pane last reported of itself: its model and how full
 * its context is — or, when its plan's limit is reached, that it is waiting
 * on that, which outranks everything else about it.
 */
function AgentUsageTag({ usage, paneId }: { usage: UsageSnapshot | null; paneId: string }) {
  const a = agentForPane(usage, paneId);
  if (!usage || !a) return null;
  const provider = usage.providers.find((p) => p.provider === a.provider);
  const capped = provider ? limitedWindow(provider) : null;
  if (provider && capped) {
    const w = provider[capped]!;
    const until = resetClock(w.resetsAt, Date.now() / 1000);
    return (
      <span className="agent-usage is-limit" title={`${providerName(a.provider)}'s ${windowLong(capped)} limit is reached; this agent waits until ${until}.`}>
        Limit
      </span>
    );
  }
  const model = modelShort(a.model);
  if (!model && a.contextPct === null) return null;
  const title = [a.model, a.contextPct !== null ? `context ${Math.round(a.contextPct)}%${a.contextSize ? ` of ${formatTokens(a.contextSize)} tokens` : ""}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="agent-usage" title={title}>
      {model && <span className="agent-model">{model}</span>}
      {a.contextPct !== null && (
        <span className={`agent-ctx ${severityClass(a.contextSeverity)}`}>
          <span className="sr-only">context </span>
          <span aria-hidden="true">ctx </span>
          {Math.round(a.contextPct)}%
        </span>
      )}
    </span>
  );
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

export function AgentList({ session, usage = null, onFocusPane }: Props) {
  const agents = agentsSorted(session);
  const wsLabel = new Map(session.workspaces.map((w) => [w.workspace_id, w.label]));

  if (agents.length === 0) {
    return <p className="sb-empty">No agents running. Start one in any pane and it shows up here.</p>;
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
              <AgentUsageTag usage={usage} paneId={a.pane_id} />
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
