import { useEffect, useRef, type RefObject } from "react";

export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && !el.closest("[inert]"),
  );
}

/**
 * Keep keyboard focus inside `ref` while `active`: Tab and Shift+Tab wrap,
 * Escape calls `onEscape`, and focus goes back to whatever had it before once
 * the trap is released — the contract every modal surface owes.
 *
 * `initial` picks what gets focus on open; by default the first control that
 * is not a close button.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts: { onEscape?: () => void; initial?: () => HTMLElement | null | undefined; restore?: boolean } = {},
): void {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const invoker = document.activeElement as HTMLElement | null;
    const first =
      latest.current.initial?.() ??
      focusables(root).find((el) => !el.matches("[data-close]")) ??
      focusables(root)[0] ??
      root;
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      const onEscape = latest.current.onEscape;
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusables(root);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const head = nodes[0]!;
      const tail = nodes[nodes.length - 1]!;
      if (e.shiftKey && (document.activeElement === head || !root.contains(document.activeElement))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (document.activeElement === tail || !root.contains(document.activeElement))) {
        e.preventDefault();
        head.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (latest.current.restore !== false && invoker && document.contains(invoker)) invoker.focus({ preventScroll: true });
    };
  }, [active, ref]);
}
