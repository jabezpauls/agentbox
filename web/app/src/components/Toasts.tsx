import { useEffect } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { StoredToast } from "../store/app.ts";

const DISMISS_MS = 6000;

function ToastRow({ toast }: { toast: StoredToast }) {
  const dismiss = useApp((s) => s.dismissToast);
  const focusPane = useApp((s) => s.focusPane);

  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.id, dismiss]);

  const blocked = toast.kind === "blocked";
  return (
    <div className={`toast is-${toast.kind}`} role="status">
      <span className="toast-icon" aria-hidden="true">
        {blocked ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
      </span>
      <button
        className="toast-body"
        onClick={() => {
          focusPane(toast.paneId);
          dismiss(toast.id);
        }}
      >
        <span className="toast-title">{toast.title}</span>
        <span className="toast-sub">{blocked ? "needs your attention" : "finished"}</span>
      </button>
      <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Stacked toasts for blocked/done transitions in panes you are not watching. */
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
