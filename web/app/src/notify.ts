import type { AgentStatus } from "@workbench/shared";
import { paneTitle, type Session } from "./store/session.ts";

/** `error` carries an RPC failure; the others are agent state transitions. */
export type ToastKind = "blocked" | "done" | "error";

export interface Toast {
  kind: ToastKind;
  /** The pane a click should focus; empty for toasts with no pane. */
  paneId: string;
  title: string;
  /** Secondary line — the server's message on an error toast. */
  detail?: string;
}

export interface NotifyOpts {
  /** Which transitions to surface; defaults to both blocked and done. */
  kinds?: ToastKind[];
}

/**
 * Compare two sessions and emit a toast for each agent that transitioned into a
 * notable state (blocked or done) in a pane the user is not currently looking
 * at. Pure: the store turns these into on-screen toasts, a title badge and, if
 * permitted, system notifications. herdr's own rule — you clear your own Done
 * badges — is honoured by the store's seen tracking, not here.
 */
export function notifyTransitions(
  prev: Session,
  next: Session,
  focusedPaneId: string | null,
  opts: NotifyOpts = {},
): Toast[] {
  const kinds = opts.kinds ?? ["blocked", "done"];
  const toasts: Toast[] = [];
  for (const [paneId, agent] of Object.entries(next.agents)) {
    if (paneId === focusedPaneId) continue;
    const before: AgentStatus | undefined = prev.agents[paneId]?.agent_status;
    const after = agent.agent_status;
    if (before === after) continue;
    if ((after === "blocked" || after === "done") && kinds.includes(after)) {
      toasts.push({ kind: after, paneId, title: paneTitle(next.panes[paneId], agent) });
    }
  }
  return toasts;
}

/** How many agents are currently blocked — the number shown in the title badge. */
export function blockedCount(s: Session): number {
  let n = 0;
  for (const a of Object.values(s.agents)) if (a.agent_status === "blocked") n++;
  return n;
}
