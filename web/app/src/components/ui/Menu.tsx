import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export type MenuEntry =
  | {
      label: string;
      icon?: LucideIcon;
      /** A shortcut, shown right-aligned as it reads. */
      keys?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect(): void;
    }
  | { separator: true }
  | { heading: string };

export type MenuAnchor = HTMLElement | { x: number; y: number };

interface Props {
  anchor: MenuAnchor;
  items: MenuEntry[];
  label: string;
  onClose(): void;
  /** Line the menu's right edge up with the anchor's (for triggers at the right of a row). */
  align?: "start" | "end";
}

const GAP = 4;
const MARGIN = 8;

function isItem(e: MenuEntry): e is Extract<MenuEntry, { onSelect(): void }> {
  return "onSelect" in e;
}

/**
 * A menu: a floating list of actions, from a button or a right-click. It
 * opens below its trigger (above it, or to the left, when the viewport runs
 * out), scaling in from the corner nearest the trigger. Arrow keys, Home and
 * End walk it, a letter jumps to the next item starting with it, Enter
 * chooses; Escape, Tab, a click outside or choosing closes it, and focus goes
 * back to the trigger.
 */
export function Menu({ anchor, items, label, onClose, align = "start" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const invoker = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    invoker.current = anchor instanceof HTMLElement ? anchor : (document.activeElement as HTMLElement | null);
    const r =
      anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? r.right - w : r.left;
    let top = r.bottom + GAP;
    let originY = "top";
    let originX = align === "end" ? "right" : "left";
    if (top + h > vh - MARGIN && r.top - GAP - h >= MARGIN) {
      top = r.top - GAP - h;
      originY = "bottom";
    }
    if (left + w > vw - MARGIN) {
      left = Math.max(MARGIN, vw - MARGIN - w);
      originX = "right";
    }
    left = Math.max(MARGIN, left);
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - h));
    setPos({ left, top, origin: `${originY} ${originX}` });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    // Positioned once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (restore = true) => {
    onClose();
    if (restore) invoker.current?.focus?.({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focus(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focus(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focus(0);
        break;
      case "End":
        e.preventDefault();
        focus(buttons.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        e.preventDefault();
        close();
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          const order = [...buttons.slice(i + 1), ...buttons.slice(0, i + 1)];
          order.find((b) => (b.textContent ?? "").trim().toLowerCase().startsWith(k))?.focus();
        }
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: -9999, top: -9999 }}
      data-placed={pos ? "" : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, n) => {
        if ("separator" in item) return <div key={n} className="menu-sep" role="separator" />;
        if ("heading" in item)
          return (
            <div key={n} className="menu-heading section-label" role="presentation">
              {item.heading}
            </div>
          );
        if (!isItem(item)) return null;
        const Icon = item.icon;
        return (
          <button
            key={n}
            role="menuitem"
            className={`menu-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            tabIndex={-1}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            <span className="menu-icon" aria-hidden="true">
              {Icon ? <Icon size={14} /> : null}
            </span>
            <span className="menu-label">{item.label}</span>
            {item.keys && <kbd className="menu-keys">{item.keys}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** A trigger's open/closed state and the element it opens from. */
export function useMenu(): {
  anchor: MenuAnchor | null;
  open(anchor: MenuAnchor): void;
  close(): void;
  render(node: (anchor: MenuAnchor) => ReactNode): ReactNode;
} {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return {
    anchor,
    open: setAnchor,
    close: () => setAnchor(null),
    render: (node) => (anchor ? node(anchor) : null),
  };
}
