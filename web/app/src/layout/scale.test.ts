import { describe, expect, it } from "vitest";
import type { PaneLayoutSnapshot } from "@workbench/shared";
import { rectsToPercent, splitHandles, splitPath } from "./scale.ts";

// The recorded three-pane layout, taken verbatim from a live herdr (area
// 120x40; panes at x 0/30/60 with widths 30/30/60). herdr expresses the same
// geometry with 0.5/0.5 split ratios: the root splits the whole area in half
// (boundary at x60, p2 on the right) and the nested split halves the left half
// (boundary at x30, p1 | p3).
const threePane: PaneLayoutSnapshot = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  zoomed: false,
  focused_pane_id: "w1:p1",
  area: { x: 0, y: 0, width: 120, height: 40 },
  panes: [
    { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 30, height: 40 } },
    { pane_id: "w1:p3", focused: false, rect: { x: 30, y: 0, width: 30, height: 40 } },
    { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 60, height: 40 } },
  ],
  splits: [
    { id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 40 } },
    { id: "split_1_0", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 60, height: 40 } },
  ],
};

describe("rectsToPercent", () => {
  it("scales pane rects to percentages of the area", () => {
    const r = rectsToPercent(threePane);
    expect(r["w1:p1"]).toEqual({ left: 0, top: 0, width: 25, height: 100 });
    expect(r["w1:p3"]).toEqual({ left: 25, top: 0, width: 25, height: 100 });
    expect(r["w1:p2"]).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  });

  it("shows only the zoomed pane at full size", () => {
    const zoomed: PaneLayoutSnapshot = { ...threePane, zoomed: true, focused_pane_id: "w1:p2" };
    const r = rectsToPercent(zoomed);
    expect(Object.keys(r)).toEqual(["w1:p2"]);
    expect(r["w1:p2"]).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });
});

describe("splitHandles", () => {
  it("yields a handle at each split boundary in percent", () => {
    const h = splitHandles(threePane);
    const byId = Object.fromEntries(h.map((x) => [x.id, x]));
    expect(h).toHaveLength(2);
    // Root boundary sits at x60 -> 50%; nested boundary at x30 -> 25%.
    expect(byId["split_0_root"]).toMatchObject({ direction: "right", x: 50, y: 0, length: 100 });
    expect(byId["split_1_0"]).toMatchObject({ direction: "right", x: 25, y: 0, length: 100 });
  });

  it("produces no handles for a zoomed layout", () => {
    expect(splitHandles({ ...threePane, zoomed: true })).toEqual([]);
  });
});

describe("splitPath", () => {
  // Verified empirically against herdr 0.9.1: path [] targets the root split;
  // `false` descends into the first child (left for "right", top for "down"),
  // `true` into the second. [true] on this layout is "split path not found"
  // because the root's right child is the p2 leaf.
  it("routes from the root down the binary split tree", () => {
    expect(splitPath(threePane, "split_0_root")).toEqual([]);
    expect(splitPath(threePane, "split_1_0")).toEqual([false]);
  });

  it("returns null for an unknown split id", () => {
    expect(splitPath(threePane, "nope")).toBeNull();
  });
});
