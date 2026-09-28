import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, AppWindow, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { StoredToast } from "../store/app.ts";

const DISMISS_MS = 5000;
// An error is worth reading twice; give it longer before it slides away.
const ERROR_DISMISS_MS = 6000;

/** How many rows are on screen at once. The rest wait behind them. */
const VISIBLE = 3;
/** The collapsed stack's step, and the row height the expanded list uses. */
const COLLAPSED_STEP = 8;
const ROW_STEP = 64 + 8;
const OPACITY_BY_DEPTH = [1, 0.85, 0.55];

interface RowProps {
  toast: StoredToast;
  depth: number;
  expanded: boolean;
}

function ToastRow({ toast, depth, expanded }: RowProps) {
  const dismiss = useApp((s) => s.dismissToast);
  const focusPane = useApp((s) => s.focusPane);
  const openApp = useApp((s) => s.openApp);

  const isError = toast.kind === "error";

  // The stack's timers pause while it is open, so a toast cannot vanish from
  // under the pointer that came to read it.
  useEffect(() => {
    if (expanded) return;
    const id = setTimeout(() => dismiss(toast.id), isError ? ERROR_DISMISS_MS : DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.id, dismiss, isError, expanded]);

  const icon = isError ? (
    <AlertTriangle size={15} />
  ) : toast.kind === "app" ? (
    <AppWindow size={15} />
  ) : toast.kind === "blocked" ? (
    <AlertCircle size={15} />
  ) : (
    <CheckCircle2 size={15} />
  );
  const sub = isError
    ? (toast.detail ?? "The bridge refused the call.")
    : toast.kind === "app"
      ? "Showing in Preview."
      : toast.kind === "blocked"
        ? "Waiting on you."
        : "Finished.";

  // The newest row is nearest the viewer, so depth also drives the stacking
  // order — without it the rows behind print their text through the front one.
  const style: React.CSSProperties = expanded
    ? { translate: `0 ${depth * ROW_STEP}px`, scale: 1, opacity: 1, zIndex: VISIBLE - depth }
    : {
        translate: `0 ${depth * COLLAPSED_STEP}px`,
        scale: Math.max(0.88, 1 - depth * 0.04),
        opacity: OPACITY_BY_DEPTH[depth] ?? 0,
        zIndex: VISIBLE - depth,
      };

  return (
    // The list carries aria-live; a role="status" here as well made screen
    // readers announce every toast twice. Errors are the exception — they are
    // assertive, so they name their own role.
    <li
      className={`toast is-${toast.kind}${depth === 0 ? " is-front" : ""}`}
      style={style}
      role={isError ? "alert" : undefined}
    >
      <span className="toast-icon" aria-hidden="true">
        {icon}
      </span>
      {isError ? (
        // Nothing to jump to: an error toast is a message, not a target.
        <span className="toast-body is-static">
          <span className="toast-title">{toast.title}</span>
          <span className="toast-sub">{sub}</span>
        </span>
      ) : (
        <button
          className="toast-body"
          onClick={() => {
            if (toast.appId) openApp(toast.appId);
            else focusPane(toast.paneId);
            dismiss(toast.id);
          }}
        >
          <span className="toast-title">{toast.title}</span>
          <span className="toast-sub">{sub}</span>
        </button>
      )}
      {toast.retry && (
        <button
          className="btn btn-small toast-retry"
          onClick={() => {
            toast.retry?.();
            dismiss(toast.id);
          }}
        >
          Retry
        </button>
      )}
      <button className="icon-btn is-sm toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <X size={13} />
      </button>
    </li>
  );
}

/**
 * The toast deck: agent transitions you are not watching, and failed calls.
 *
 * Top-centre, sharing one anchor. The newest row is at depth 0 and the ones
 * behind it are pushed back, shrunk and dimmed; hovering or focusing the deck
 * fans them into a readable list and pauses every dismissal timer.
 */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const [expanded, setExpanded] = useState(false);

  // A deck that empties while open should not stay "open" for the next toast.
  useEffect(() => {
    if (toasts.length === 0) setExpanded(false);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  // Newest first: it owns depth 0, the front of the stack.
  const shown = [...toasts].reverse().slice(0, VISIBLE);

  return (
    <ol
      className={`toasts${expanded ? " is-expanded" : ""}`}
      aria-label="Notifications"
      aria-live="polite"
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false);
      }}
    >
      {shown.map((t, depth) => (
        <ToastRow key={t.id} toast={t} depth={depth} expanded={expanded} />
      ))}
    </ol>
  );
}
