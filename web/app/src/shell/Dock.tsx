import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { useApp, type InspectorTab } from "../store/app.ts";
import { PreviewPanel } from "../components/PreviewPanel.tsx";
import { ReviewPanel } from "../components/ReviewPanel.tsx";
import { useFocusTrap } from "../components/ui/focus.ts";
import { chordLabel } from "./keys.ts";
import { clampDockWidth, DOCK_MIN, dockMaxWidth } from "./dock.ts";

const TABS: InspectorTab[] = ["preview", "review"];
const TAB_LABEL: Record<InspectorTab, string> = { preview: "Preview", review: "Review" };

/** The phone layout's breakpoint: the rail becomes a bottom bar, the dock a full-screen sheet. */
export const NARROW_QUERY = "(max-width: 700px)";

function subscribeNarrow(cb: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1280,
  );
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => typeof matchMedia === "function" && matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/**
 * The dock: Preview and Review, on the right of every surface. It is one
 * panel for the whole app, driven by `ui.inspector` — so `openApp`, a review
 * link and the toggle all move the same thing — and each panel is built the
 * first time it is shown and kept after, closed or not, so a preview does not
 * reload because you looked at a review or at another surface.
 *
 * Beside a surface it is a resizable column; on a phone it is a full-screen
 * sheet, which traps focus and closes on Escape like any other.
 */
export function Dock() {
  const open = useApp((s) => s.ui.inspector.open);
  const tab = useApp((s) => s.ui.inspector.tab);
  const width = useApp((s) => s.ui.inspector.width);
  const setInspector = useApp((s) => s.setInspector);
  const narrow = useNarrow();
  const viewport = useViewportWidth();
  const ref = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const [resizing, setResizing] = useState(false);
  const [built, setBuilt] = useState<InspectorTab[]>(open ? [tab] : []);

  useEffect(() => {
    if (open && !built.includes(tab)) setBuilt((b) => [...b, tab]);
  }, [open, tab, built]);

  const close = () => setInspector({ open: false });
  useFocusTrap(ref, open && narrow, { onEscape: close });

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    setResizing(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Live feedback only; the release persists (one write per gesture).
    setInspector({ width: clampDockWidth(window.innerWidth - e.clientX, window.innerWidth) }, { persist: false });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const was = dragging.current;
    dragging.current = false;
    setResizing(false);
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (was) setInspector({});
  };
  // The window splitter's keys: arrows move the edge (with Shift, further),
  // Home and End take it to either end.
  const onResizeKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    let next: number;
    if (e.key === "ArrowLeft") next = width + step;
    else if (e.key === "ArrowRight") next = width - step;
    else if (e.key === "Home") next = DOCK_MIN;
    else if (e.key === "End") next = dockMaxWidth(window.innerWidth);
    else return;
    e.preventDefault();
    setInspector({ width: clampDockWidth(next, window.innerWidth) });
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
    document.getElementById(`dock-tab-${target}`)?.focus();
  };

  if (built.length === 0) return null;

  return (
    <aside
      ref={ref}
      className="dock inspector"
      aria-label="Dock"
      hidden={!open}
      role={narrow ? "dialog" : undefined}
      aria-modal={narrow && open ? true : undefined}
      style={{ ["--dock-w" as string]: `${width}px` }}
      data-resizing={resizing ? "" : undefined}
    >
      <div
        className={`dock-resize inspector-resize${resizing ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the dock"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={dockMaxWidth(viewport)}
        aria-valuenow={Math.min(width, dockMaxWidth(viewport))}
        aria-valuetext={`${Math.min(width, dockMaxWidth(viewport))} pixels wide`}
        tabIndex={0}
        onKeyDown={onResizeKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <header className="dock-head inspector-head">
        <div className="segmented" role="tablist" aria-label="Dock panel">
          {TABS.map((t, i) => (
            <button
              key={t}
              id={`dock-tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`dock-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              className={`segmented-btn${tab === t ? " is-active" : ""}`}
              onClick={() => setInspector({ tab: t })}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button
          className="icon-btn"
          data-close
          aria-label="Close the dock"
          title={`Close (${chordLabel("d")})`}
          onClick={close}
        >
          <X size={15} />
        </button>
      </header>
      {TABS.filter((t) => built.includes(t)).map((t) => (
        <div
          key={t}
          id={`dock-panel-${t}`}
          role="tabpanel"
          aria-labelledby={`dock-tab-${t}`}
          className="dock-body inspector-body"
          hidden={t !== tab}
        >
          {t === "preview" ? <PreviewPanel /> : <ReviewPanel />}
        </div>
      ))}
    </aside>
  );
}
