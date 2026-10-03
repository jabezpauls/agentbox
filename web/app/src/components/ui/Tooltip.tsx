import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "right" | "top" | "bottom";

interface Props {
  label: string;
  /** A shortcut shown after the label, as a key chip. */
  keys?: string | undefined;
  side?: Side;
  children: ReactNode;
}

const DELAY_MS = 450;
/** Once one tooltip has shown, a neighbour opens at once for this long. */
const WARM_MS = 600;
let warmUntil = 0;

/** A keyboard focus, not the focus a click leaves behind. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

interface Place {
  x: number;
  y: number;
  side: Side;
}

/**
 * A tooltip: an inverted ink-on-surface label, the one inverted
 * surface in the app. It waits a moment before the first one shows, so a
 * pointer passing over does not flicker labels; after that, the next one
 * along a toolbar opens straight away and without animation.
 *
 * Keyboard focus shows it too. Touch never does — a tap is a press, not a
 * hover — and the label is always the control's accessible name as well, so
 * nothing lives only in the tooltip.
 */
export function Tooltip({ label, keys, side = "top", children }: Props) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [instant, setInstant] = useState(false);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = (now: boolean) => {
    const el = anchor.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const open = () => {
      const r = el.getBoundingClientRect();
      if (side === "right") setPlace({ x: r.right + 8, y: r.top + r.height / 2, side });
      else if (side === "bottom") setPlace({ x: r.left + r.width / 2, y: r.bottom + 6, side });
      else setPlace({ x: r.left + r.width / 2, y: r.top - 6, side });
    };
    if (timer.current) clearTimeout(timer.current);
    const warm = Date.now() < warmUntil;
    setInstant(warm || now);
    if (warm || now) open();
    else timer.current = setTimeout(open, DELAY_MS);
  };

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    if (place) warmUntil = Date.now() + WARM_MS;
    setPlace(null);
  };

  return (
    <span
      ref={anchor}
      className="tip-anchor"
      onPointerEnter={(e) => e.pointerType !== "touch" && show(false)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => focusVisible(e.target) && show(true)}
      onBlur={hide}
    >
      {children}
      {place &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className={`tooltip is-${place.side}${instant ? " is-instant" : ""}`}
            style={{ left: place.x, top: place.y }}
          >
            {label}
            {keys && <kbd className="tooltip-keys">{keys}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
