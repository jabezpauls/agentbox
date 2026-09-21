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

/**
 * The human sentence for a failed call. rubl's rule: a person never sees a
 * method name or an `Error: HTTP nnn`, so every failure reads
 * `Couldn't <verb> the <noun>.` and the server's own message becomes the
 * second line.
 */
const NOUNS: Record<string, string> = {
  pane: "pane",
  tab: "tab",
  workspace: "workspace",
  worktree: "worktree",
  agent: "agent",
  layout: "layout",
};

const VERBS: Record<string, string> = {
  close: "close",
  create: "create",
  rename: "rename",
  focus: "focus",
  split: "split",
  zoom: "zoom",
  prompt: "message",
  set_split_ratio: "resize",
};

/** Calls that are not herdr methods and carry their own sentence. */
const PHRASES: Record<string, string> = {
  session: "Couldn't refresh the session.",
  "review feedback": "Couldn't send your feedback.",
  "review end": "Couldn't end the review session.",
};

export function rpcErrorTitle(method: string): string {
  const phrase = PHRASES[method];
  if (phrase) return phrase;
  const [head, tail] = method.split(".");
  const noun = head ? NOUNS[head] : undefined;
  const verb = tail ? VERBS[tail] : undefined;
  if (noun && verb) return `Couldn't ${verb} the ${noun}.`;
  if (noun) return `Couldn't update the ${noun}.`;
  return "Couldn't complete that.";
}

/** How many agents are currently blocked — the number shown in the title badge. */
export function blockedCount(s: Session): number {
  let n = 0;
  for (const a of Object.values(s.agents)) if (a.agent_status === "blocked") n++;
  return n;
}
