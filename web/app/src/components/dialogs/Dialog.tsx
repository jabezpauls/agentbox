import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  onClose(): void;
  onSubmit?(): void;
  submitLabel?: string;
  cancelLabel?: string;
  submitDisabled?: boolean;
  danger?: boolean;
  /** 420px instead of 560px — the width a confirm wants. */
  narrow?: boolean;
  /** Focus the confirm button on open, so Enter confirms. */
  autoFocusSubmit?: boolean;
  children?: ReactNode;
}

const FOCUSABLE = 'input,textarea,button,[href],select,[tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog in three rigid bands — a 56px header with a bottom hairline,
 * a free body, a 64px footer with right-aligned actions — plus the ever-present
 * close button at the top right. A dimming scrim, an initial focus, a focus
 * trap, Escape to cancel and Enter to confirm (except inside a textarea).
 * Reused by every dialog so they are all dismissed the same way.
 */
export function Dialog({
  title,
  onClose,
  onSubmit,
  submitLabel,
  cancelLabel,
  submitDisabled,
  danger,
  narrow,
  autoFocusSubmit,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Remember where focus came from and hand it back on close, so dismissing
    // a dialog returns the keyboard to the control that opened it.
    const invoker = document.activeElement as HTMLElement | null;
    // A confirm focuses its verb so Enter confirms; a form focuses its first
    // field, not the close button that happens to come first in the DOM.
    const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (autoFocusSubmit && submitRef.current) submitRef.current.focus();
    else if (first) first.focus();
    else ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => invoker?.focus?.();
  }, [autoFocusSubmit]);

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
    <div className="scrim" onMouseDown={onClose}>
      <div
        className={`dialog pop-in${narrow ? " is-narrow" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
        </header>
        <button className="icon-btn is-sm dialog-close" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
        <div className="dialog-body" ref={bodyRef}>
          {children}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-small" onClick={onClose}>
            {cancelLabel ?? "Cancel"}
          </button>
          {onSubmit && (
            <button
              ref={submitRef}
              className={`btn btn-small ${danger ? "btn-danger" : "btn-primary"}`}
              onClick={onSubmit}
              disabled={submitDisabled}
            >
              {submitLabel ?? "Confirm"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
