import { useRef } from "react";
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
 * The right-hand inspector drawer: a resizable panel with a Preview | Review
 * segmented control. Its open state, width and tab persist across reloads (see
 * the store). Dragging the left edge resizes it between a floor and 60 % of the
 * viewport.
 */
export function Inspector() {
  const open = useApp((s) => s.ui.inspector.open);
  const tab = useApp((s) => s.ui.inspector.tab);
  const setInspector = useApp((s) => s.setInspector);
  const dragging = useRef(false);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
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
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (wasDragging) setInspector({});
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      <div
        className="inspector-resize"
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
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`segmented-btn${tab === t ? " is-active" : ""}`}
              onClick={() => setInspector({ tab: t })}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button className="icon-btn" aria-label="Close inspector" onClick={() => setInspector({ open: false })}>
          <X size={16} />
        </button>
      </header>
      <div className="inspector-body">{tab === "preview" ? <PreviewPanel /> : <ReviewPanel />}</div>
    </aside>
  );
}
