import { useEffect } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { StoredToast } from "../store/app.ts";

const DISMISS_MS = 6000;
// An error is worth reading twice; give it longer before it slides away.
const ERROR_DISMISS_MS = 10000;

function ToastRow({ toast }: { toast: StoredToast }) {
  const dismiss = useApp((s) => s.dismissToast);
  const focusPane = useApp((s) => s.focusPane);

  const isError = toast.kind === "error";

  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), isError ? ERROR_DISMISS_MS : DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.id, dismiss, isError]);

  const icon = isError ? <AlertTriangle size={16} /> : toast.kind === "blocked" ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />;
  const sub = isError ? (toast.detail ?? "request failed") : toast.kind === "blocked" ? "needs your attention" : "finished";

  return (
    // The container carries aria-live; a role="status" here as well made
    // screen readers announce every toast twice.
    <div className={`toast is-${toast.kind}`}>
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
            focusPane(toast.paneId);
            dismiss(toast.id);
          }}
        >
          <span className="toast-title">{toast.title}</span>
          <span className="toast-sub">{sub}</span>
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Stacked toasts: agent transitions you are not watching, and failed calls. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
