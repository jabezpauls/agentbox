import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, AppWindow, Info, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { StoredToast } from "../store/app.ts";
import { navigate } from "../shell/router.ts";

const DISMISS_MS = 5000;
// An error is worth reading twice; give it longer before it slides away.
const ERROR_DISMISS_MS = 6000;
// Long enough to reach for an Undo.
const ACTION_DISMISS_MS = 8000;

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

const ICONS: Record<StoredToast["kind"], typeof Info> = {
  error: AlertTriangle,
  blocked: AlertCircle,
  done: CheckCircle2,
  success: CheckCircle2,
  info: Info,
  app: AppWindow,
};

/** The second line when the toast brings none of its own. */
const DEFAULT_SUB: Partial<Record<StoredToast["kind"], string>> = {
  error: "The bridge refused the call.",
  blocked: "Waiting on you.",
  done: "Finished.",
  app: "Showing in Preview.",
};

function ToastRow({ toast, depth, expanded }: RowProps) {
  const dismiss = useApp((s) => s.dismissToast);
  const focusPane = useApp((s) => s.focusPane);
  const openApp = useApp((s) => s.openApp);

  const isError = toast.kind === "error";
  const Icon = ICONS[toast.kind];
  const sub = toast.detail ?? DEFAULT_SUB[toast.kind];
  // An app toast shows the app, an agent toast jumps to its pane; another
  // may say where it leads.
  const open = toast.appId
    ? () => openApp(toast.appId!)
    : toast.paneId
      ? () => {
          navigate({ surface: "workbench" });
          focusPane(toast.paneId);
        }
      : toast.open;

  // The stack's timers pause while it is open, so a toast cannot vanish from
  // under the pointer that came to read it. One with an Undo gets longer.
  useEffect(() => {
    if (expanded) return;
    const ms = isError ? ERROR_DISMISS_MS : toast.action ? ACTION_DISMISS_MS : DISMISS_MS;
    const id = setTimeout(() => dismiss(toast.id), ms);
    return () => clearTimeout(id);
  }, [toast.id, toast.action, dismiss, isError, expanded]);

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

  const text = (
    <>
      <span className="toast-title">{toast.title}</span>
      {sub && <span className="toast-sub">{sub}</span>}
    </>
  );

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
        <Icon size={15} />
      </span>
      {open ? (
        <button
          className="toast-body"
          onClick={() => {
            open();
            dismiss(toast.id);
          }}
        >
          {text}
        </button>
      ) : (
        // Nothing to jump to: this toast is a message, not a target.
        <span className="toast-body is-static">{text}</span>
      )}
      {(toast.retry || toast.action) && (
        <button
          className="btn btn-small toast-retry"
          onClick={() => {
            if (toast.action) toast.action.run();
            else toast.retry?.();
            dismiss(toast.id);
          }}
        >
          {toast.action?.label ?? "Retry"}
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
