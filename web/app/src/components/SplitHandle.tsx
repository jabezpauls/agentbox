import { useRef, useState } from "react";
import type { LayoutSplit, Rect } from "@workbench/shared";
import type { SplitHandleInfo } from "../layout/scale.ts";

interface Props {
  handle: SplitHandleInfo;
  split: LayoutSplit;
  area: Rect;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCommit(ratio: number): void;
}

const MIN = 0.05;
const MAX = 0.95;

function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, v));
}

/**
 * A draggable split boundary. Tracks the pointer 1:1 during the drag for
 * immediate feedback, then commits the new ratio to herdr on release — herdr's
 * layout_updated event snaps every pane to the authoritative geometry, so we
 * never keep a divergent local layout.
 */
export function SplitHandle({ handle, split, area, containerRef, onCommit }: Props) {
  const vertical = handle.direction === "right";
  const [livePct, setLivePct] = useState<number | null>(null);
  const ratioRef = useRef<number>(split.ratio);
  const draggingRef = useRef(false);

  const boundaryPct = livePct ?? (vertical ? handle.x : handle.y);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Some pointer sources reject capture; the drag still tracks below.
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    // The split's own rect as a fraction of the area, then in container pixels.
    const leftFrac = (split.rect.x - area.x) / area.width;
    const topFrac = (split.rect.y - area.y) / area.height;
    const widthFrac = split.rect.width / area.width;
    const heightFrac = split.rect.height / area.height;

    let ratio: number;
    if (vertical) {
      const startPx = box.left + leftFrac * box.width;
      ratio = clamp((e.clientX - startPx) / (widthFrac * box.width));
      setLivePct((leftFrac + ratio * widthFrac) * 100);
    } else {
      const startPx = box.top + topFrac * box.height;
      ratio = clamp((e.clientY - startPx) / (heightFrac * box.height));
      setLivePct((topFrac + ratio * heightFrac) * 100);
    }
    ratioRef.current = ratio;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const el = e.target as HTMLElement;
    try {
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      // Capture was never granted; nothing to release.
    }
    if (livePct !== null) onCommit(ratioRef.current);
    setLivePct(null);
  };

  // A cancelled pointer (a touch turned into a scroll, a lost capture) never
  // sends pointerup, so without this the handle would stay "dragging" for good
  // and the live offset would never be cleared.
  const onPointerCancel = () => {
    draggingRef.current = false;
    setLivePct(null);
  };

  const style: React.CSSProperties = vertical
    ? { left: `${boundaryPct}%`, top: `${handle.y}%`, height: `${handle.length}%` }
    : { top: `${boundaryPct}%`, left: `${handle.x}%`, width: `${handle.length}%` };

  return (
    <div
      className={`split-handle is-${handle.direction}${livePct !== null ? " is-dragging" : ""}`}
      style={style}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={`Resize split ${split.id}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className="split-handle-grip" aria-hidden="true" />
    </div>
  );
}
