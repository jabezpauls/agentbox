import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  onClose(): void;
  onSubmit?(): void;
  submitLabel?: string;
  submitDisabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'input,textarea,button,[href],select,[tabindex]:not([tabindex="-1"])';

/**
 * A modal sheet following the apple-design language: a dimming scrim, a
 * material surface, an initial focus, a focus trap, Escape to cancel and Enter
 * to confirm (except inside a textarea). Reused by every dialog for consistency.
 */
export function Dialog({ title, onClose, onSubmit, submitLabel, submitDisabled, danger, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Remember where focus came from and hand it back on close, so dismissing
    // a dialog returns the keyboard to the control that opened it.
    const invoker = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => invoker?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Enter submits — except in a textarea, and except on a button, which must
    // be allowed to activate itself (the directory picker is all buttons, and
    // stealing Enter here made it keyboard-inaccessible).
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && onSubmit && tag !== "TEXTAREA" && tag !== "BUTTON" && !submitDisabled) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "Tab") {
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => !n.hasAttribute("disabled"));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {onSubmit && (
            <button className={`btn btn-primary${danger ? " btn-danger" : ""}`} onClick={onSubmit} disabled={submitDisabled}>
              {submitLabel ?? "Confirm"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
