import { useRef } from "react";
import type { Resolved } from "../theme/useTheme.ts";
import { useApp } from "../store/app.ts";
import { call } from "../api/call.ts";
import { rectsToPercent, splitHandles, splitPath } from "../layout/scale.ts";
import { TerminalCell } from "../terminal/TerminalCell.tsx";
import { PaneHeader } from "./PaneHeader.tsx";
import { SplitHandle } from "./SplitHandle.tsx";

interface Props {
  resolved: Resolved;
}

/**
 * The main stage: herdr's split layout for the focused tab, scaled to the
 * container and rendered as absolutely-positioned terminal cells with
 * draggable split boundaries between them. Only the focused tab is mounted, so
 * exactly one live terminal exists per visible pane.
 */
export function PaneGrid({ resolved }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabId = useApp((s) => s.session.focusedTabId);
  const layout = useApp((s) => (tabId ? s.session.layouts[tabId] : undefined));
  const panes = useApp((s) => s.session.panes);
  const focusedPaneId = useApp((s) => s.session.focusedPaneId);
  const focusPane = useApp((s) => s.focusPane);
  const prefixArmed = useApp((s) => s.ui.prefixArmed);

  if (!layout || layout.panes.length === 0) {
    return (
      <div className="stage">
        <div className="empty-stage">
          <p className="empty-title">Select a pane</p>
          <p className="empty-sub">Choose a workspace, tab, or agent to begin.</p>
        </div>
      </div>
    );
  }

  const rects = rectsToPercent(layout);
  const visible = layout.zoomed
    ? layout.panes.filter((p) => rects[p.pane_id])
    : layout.panes;
  const handles = splitHandles(layout);

  const commitSplit = (splitId: string, ratio: number) => {
    const path = splitPath(layout, splitId);
    if (!path) return;
    void call("layout.set_split_ratio", { tab_id: layout.tab_id, path, ratio });
  };

  return (
    <div className="pane-grid" ref={containerRef}>
      {visible.map((lp) => {
        const pane = panes[lp.pane_id];
        const r = rects[lp.pane_id];
        if (!pane || !r) return null;
        const focused = lp.pane_id === focusedPaneId;
        return (
          <div
            key={lp.pane_id}
            className={`pane-cell${focused ? " is-focused" : ""}`}
            style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` }}
            onMouseDown={() => {
              if (!focused) focusPane(lp.pane_id);
            }}
          >
            <div className="pane-frame">
              <PaneHeader pane={pane} />
              <div className="pane-body">
                <TerminalCell paneId={lp.pane_id} resolved={resolved} />
              </div>
            </div>
          </div>
        );
      })}

      {handles.map((h) => {
        const split = layout.splits.find((s) => s.id === h.id);
        if (!split) return null;
        return (
          <SplitHandle
            key={h.id}
            handle={h}
            split={split}
            area={layout.area}
            containerRef={containerRef}
            onCommit={(ratio) => commitSplit(h.id, ratio)}
          />
        );
      })}

      {prefixArmed && (
        <div className="prefix-hud" role="status" aria-live="polite">
          ⌃B
        </div>
      )}
    </div>
  );
}
