import { AppWindow, ArrowRight, Check, MessageSquareText, X } from "lucide-react";
import { useApp } from "../../store/app.ts";
import { navigate } from "../../shell/router.ts";
import type { Need } from "../../shell/attention.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";

const ACTION: Record<Need["kind"], string> = {
  blocked: "Answer",
  review: "Review",
  crashed: "Open app",
  done: "Look",
};

/** Take the one step to the thing that needs you. */
export function goToNeed(need: Need): void {
  const s = useApp.getState();
  if (need.paneId) {
    navigate({ surface: "workbench" });
    s.focusPane(need.paneId);
  } else if (need.reviewKey) {
    s.setInspector({ open: true, tab: "review", reviewKey: need.reviewKey });
  } else if (need.appId) {
    navigate({ surface: "apps", appId: need.appId });
  }
}

function NeedIcon({ need }: { need: Need }) {
  if (need.kind === "blocked" || need.kind === "done") {
    return (
      <span className={`need-glyph is-${need.kind}`}>
        {need.kind === "done" ? <Check size={14} aria-hidden="true" /> : <StatusBadge status="blocked" />}
      </span>
    );
  }
  const Icon = need.kind === "review" ? MessageSquareText : AppWindow;
  return (
    <span className={`need-glyph is-${need.kind}`} aria-hidden="true">
      <Icon size={14} />
    </span>
  );
}

/**
 * What needs you, one row each, most urgent first: an agent's question
 * before a review, a review before a crashed app, a finished agent last. The
 * row is the way there; a finished agent can also just be dismissed.
 */
export function NeedsYou({ needs }: { needs: Need[] }) {
  const markSeen = useApp((s) => s.markSeen);
  return (
    <ul className="need-list">
      {needs.map((n) => (
        <li key={n.id} className={`need is-${n.kind}`}>
          <button className="need-row" onClick={() => goToNeed(n)}>
            <NeedIcon need={n} />
            <span className="need-text">
              <span className="need-title">{n.title}</span>
              <span className="need-detail">{n.detail}</span>
            </span>
            <span className="need-go">
              {ACTION[n.kind]}
              <ArrowRight size={13} aria-hidden="true" />
            </span>
          </button>
          {n.kind === "done" && n.paneId && (
            <button className="icon-btn is-sm need-dismiss" aria-label={`Dismiss ${n.title}`} title="Dismiss" onClick={() => markSeen(n.paneId!)}>
              <X size={13} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
