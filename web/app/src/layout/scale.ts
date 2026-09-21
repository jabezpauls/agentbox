import type { LayoutSplit, PaneLayoutSnapshot, Rect } from "@workbench/shared";

/** A pane's box as percentages of the layout area, ready for absolute CSS. */
export interface PercentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A draggable split boundary, positioned in percent of the layout area. */
export interface SplitHandleInfo {
  id: string;
  direction: "right" | "down";
  /** For "right": the boundary's x. For "down": the band's left edge. Percent. */
  x: number;
  /** For "down": the boundary's y. For "right": the band's top edge. Percent. */
  y: number;
  /** Length of the handle along its span, in percent (height for "right"). */
  length: number;
}

function pct(value: number, span: number): number {
  return span === 0 ? 0 : (value / span) * 100;
}

/**
 * herdr reports pane rects in terminal cells relative to `area`. Scale them to
 * percentages so the browser reproduces the TUI's split geometry at any size.
 * A zoomed tab collapses to its single focused pane.
 */
export function rectsToPercent(layout: PaneLayoutSnapshot): Record<string, PercentRect> {
  const { area } = layout;
  if (layout.zoomed) {
    const id = layout.focused_pane_id ?? layout.panes.find((p) => p.focused)?.pane_id;
    return id ? { [id]: { left: 0, top: 0, width: 100, height: 100 } } : {};
  }
  const out: Record<string, PercentRect> = {};
  for (const p of layout.panes) {
    out[p.pane_id] = {
      left: pct(p.rect.x - area.x, area.width),
      top: pct(p.rect.y - area.y, area.height),
      width: pct(p.rect.width, area.width),
      height: pct(p.rect.height, area.height),
    };
  }
  return out;
}

/** The boundary line (in cell units) a split divides its own rect along. */
function boundary(split: LayoutSplit): { x: number; y: number } {
  const { rect, ratio, direction } = split;
  return direction === "right"
    ? { x: rect.x + ratio * rect.width, y: rect.y }
    : { x: rect.x, y: rect.y + ratio * rect.height };
}

/**
 * One handle per split, at the boundary between its two children. A "right"
 * split is a vertical bar (constant x, spanning the rect's height); a "down"
 * split is a horizontal bar. A zoomed tab has no visible splits.
 */
export function splitHandles(layout: PaneLayoutSnapshot): SplitHandleInfo[] {
  if (layout.zoomed) return [];
  const { area } = layout;
  return layout.splits.map((s) => {
    const b = boundary(s);
    if (s.direction === "right") {
      return {
        id: s.id,
        direction: "right",
        x: pct(b.x - area.x, area.width),
        y: pct(s.rect.y - area.y, area.height),
        length: pct(s.rect.height, area.height),
      };
    }
    return {
      id: s.id,
      direction: "down",
      x: pct(s.rect.x - area.x, area.width),
      y: pct(b.y - area.y, area.height),
      length: pct(s.rect.width, area.width),
    };
  });
}

// Cell units are integers but ratios reintroduce fractions, so match rects with
// a small tolerance when reconstructing the tree.
const EPS = 0.5;

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.width - b.width) < EPS &&
    Math.abs(a.height - b.height) < EPS
  );
}

/** The two sub-regions a split carves its rect into, first child then second. */
function children(split: LayoutSplit): [Rect, Rect] {
  const { rect, ratio, direction } = split;
  if (direction === "right") {
    const w = rect.width * ratio;
    return [
      { x: rect.x, y: rect.y, width: w, height: rect.height },
      { x: rect.x + w, y: rect.y, width: rect.width - w, height: rect.height },
    ];
  }
  const h = rect.height * ratio;
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: h },
    { x: rect.x, y: rect.y + h, width: rect.width, height: rect.height - h },
  ];
}

/**
 * The route `layout.set_split_ratio` wants: a list of branch choices from the
 * root split down to `splitId`, or null if the split is not in the tree.
 *
 * Convention verified empirically against herdr 0.9.1: `path: []` targets the
 * root split, `false` descends into a split's FIRST child (left for a "right"
 * split, top for "down") and `true` into the SECOND. Addressing a leaf (a bare
 * pane) is rejected by herdr as "split path not found", so a path only ever
 * ends on an internal split node.
 */
export function splitPath(layout: PaneLayoutSnapshot, splitId: string): boolean[] | null {
  const splits = layout.splits;
  const splitAt = (region: Rect): LayoutSplit | undefined =>
    splits.find((s) => sameRect(s.rect, region));

  const walk = (region: Rect, path: boolean[]): boolean[] | null => {
    const here = splitAt(region);
    if (!here) return null; // a leaf pane
    if (here.id === splitId) return path;
    const [first, second] = children(here);
    return walk(first, [...path, false]) ?? walk(second, [...path, true]);
  };

  return walk(layout.area, []);
}
