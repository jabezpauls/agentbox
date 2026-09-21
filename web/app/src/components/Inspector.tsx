import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { InspectorTab } from "../store/app.ts";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";

const MIN_WIDTH = 320;
const maxWidth = () => (typeof window === "undefined" ? 900 : window.innerWidth * 0.6);

const TABS: InspectorTab[] = ["preview", "review"];
const TAB_LABEL: Record<InspectorTab, string> = { preview: "Preview", review: "Review" };

/**
 * The right-hand inspector: a resizable layout column — not a drawer sliding
 * over the grid, which would fight a dense tool — with a Preview | Review
 * segmented control. Its open state, width and tab persist across reloads (see
 * the store). Dragging the left edge resizes it between a floor and 60 % of the
 * viewport.
 */
export function Inspector() {
  const open = useApp((s) => s.ui.inspector.open);
  const tab = useApp((s) => s.ui.inspector.tab);
  const setInspector = useApp((s) => s.setInspector);
  const dragging = useRef(false);
  const [resizing, setResizing] = useState(false);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    setResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
    // Live feedback only: writing localStorage on every pointermove would do
    // hundreds of synchronous writes per drag. The release below persists.
    setInspector({ width: next }, { persist: false });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDragging = dragging.current;
    dragging.current = false;
    setResizing(false);
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (wasDragging) setInspector({});
  };

  // A segmented control is one tab stop: arrows walk it, Home/End jump, and
  // the selection wraps — the roving-tabindex contract a tablist owes.
  const onTabKeyDown = (e: React.KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[next]!;
    setInspector({ tab: target });
    document.getElementById(`inspector-tab-${target}`)?.focus();
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      <div
        className={`inspector-resize${resizing ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <header className="inspector-head">
        <div className="segmented" role="tablist" aria-label="Inspector panel">
          {TABS.map((t, i) => (
            <button
              key={t}
              id={`inspector-tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              className={`segmented-btn${tab === t ? " is-active" : ""}`}
              onClick={() => setInspector({ tab: t })}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button className="icon-btn" aria-label="Close inspector" title="Close" onClick={() => setInspector({ open: false })}>
          <X size={15} />
        </button>
      </header>
      <div className="inspector-body">{tab === "preview" ? <PreviewPanel /> : <ReviewPanel />}</div>
    </aside>
  );
}
