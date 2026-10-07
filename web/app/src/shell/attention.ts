import { useMemo } from "react";
import { create } from "zustand";
import type { AgentStatus, ReviewSession } from "@workbench/shared";
import { getReviewSessions } from "../api/client.ts";
import { isCrashed, useApps, type AppView } from "../apps/model.ts";
import { paneTitle, type Session } from "../store/session.ts";
import { useApp } from "../store/app.ts";
import { anyLimited } from "../usage/model.ts";
import type { SurfaceId } from "./routes.ts";

/**
 * What needs you: the things Home leads with and the rail marks.
 *
 *  - an agent blocked on a question;
 *  - an agent that finished and you have not looked at since;
 *  - a review an agent is waiting on (open, nothing sent yet);
 *  - a pinned app that should be running but is not.
 */
export type NeedKind = "blocked" | "done" | "review" | "crashed";

export interface Need {
  id: string;
  kind: NeedKind;
  title: string;
  detail: string;
  paneId?: string;
  reviewKey?: string;
  appId?: string;
  /** Which agent or thing, for its status light. */
  status?: AgentStatus;
}

const ORDER: Record<NeedKind, number> = { blocked: 0, review: 1, crashed: 2, done: 3 };

function where(session: Session, paneId: string): string {
  const pane = session.panes[paneId];
  const ws = session.workspaces.find((w) => w.workspace_id === pane?.workspace_id);
  const cwd = pane?.foreground_cwd ?? pane?.cwd ?? "";
  const folder = cwd ? cwd.replace(/\/+$/, "").split("/").pop() : "";
  return [ws?.label, folder && folder !== ws?.label ? folder : ""].filter(Boolean).join(" · ");
}

export function needsYou(
  session: Session,
  seenDone: Record<string, number>,
  reviews: ReviewSession[],
  apps: AppView[] | null,
): Need[] {
  const out: Need[] = [];
  for (const agent of Object.values(session.agents)) {
    const title = paneTitle(session.panes[agent.pane_id], agent);
    const place = where(session, agent.pane_id);
    if (agent.agent_status === "blocked") {
      out.push({
        id: `blocked:${agent.pane_id}`,
        kind: "blocked",
        title,
        detail: place ? `Waiting for you in ${place}` : "Waiting for you",
        paneId: agent.pane_id,
        status: "blocked",
      });
    } else if (agent.agent_status === "done" && seenDone[agent.pane_id] !== (agent.state_change_seq ?? 0)) {
      out.push({
        id: `done:${agent.pane_id}`,
        kind: "done",
        title,
        detail: place ? `Finished in ${place}` : "Finished",
        paneId: agent.pane_id,
        status: "done",
      });
    }
  }
  for (const r of reviews) {
    if (r.status !== "open" || r.pending > 0) continue;
    out.push({ id: `review:${r.key}`, kind: "review", title: r.label, detail: "A review waiting for your comments", reviewKey: r.key });
  }
  for (const app of apps ?? []) {
    if (!isCrashed(app)) continue;
    out.push({ id: `crashed:${app.id}`, kind: "crashed", title: app.name, detail: `Pinned, but nothing is serving on port ${app.port}`, appId: app.id });
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

interface ReviewsState {
  sessions: ReviewSession[];
  refresh(): Promise<void>;
}

/** Review sessions, for Home, the palette and the rail. */
export const useReviews = create<ReviewsState>((set) => ({
  sessions: [],
  async refresh() {
    try {
      set({ sessions: await getReviewSessions() });
    } catch {
      // Keep what we had; the Review panel reports its own failures.
    }
  },
}));

export function useNeeds(): Need[] {
  const session = useApp((s) => s.session);
  const seenDone = useApp((s) => s.seenDone);
  const reviews = useReviews((s) => s.sessions);
  const apps = useApps((s) => s.apps);
  return useMemo(() => needsYou(session, seenDone, reviews, apps), [session, seenDone, reviews, apps]);
}

/**
 * Which rail entries carry a "needs you" dot. A plan limit reached marks Home
 * (which says so first) and the Workbench (whose agents are stalled on it).
 */
export function useAttention(): Partial<Record<SurfaceId, boolean>> {
  const needs = useNeeds();
  const limited = useApp((s) => anyLimited(s.usage));
  return useMemo(
    () => ({
      home: limited || needs.some((n) => n.kind !== "done"),
      workbench: limited || needs.some((n) => n.kind === "blocked"),
      apps: needs.some((n) => n.kind === "crashed"),
    }),
    [needs, limited],
  );
}
