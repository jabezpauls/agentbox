import { describe, expect, it } from "vitest";
import { click, edge, EMPTY, move, ordered, prune, selectAll } from "./selection.ts";

const order = ["a", "b", "c", "d", "e"];
const sel = (s: { selected: ReadonlySet<string> }) => [...s.selected].sort();

describe("selection", () => {
  it("selects one on a click", () => {
    const s = click(EMPTY, order, "b");
    expect(sel(s)).toEqual(["b"]);
    expect(s.cursor).toBe("b");
  });

  it("adds and removes with a toggle-click", () => {
    let s = click(EMPTY, order, "b");
    s = click(s, order, "d", { toggle: true });
    expect(sel(s)).toEqual(["b", "d"]);
    s = click(s, order, "b", { toggle: true });
    expect(sel(s)).toEqual(["d"]);
  });

  it("selects a range from the anchor with shift", () => {
    let s = click(EMPTY, order, "b");
    s = click(s, order, "d", { range: true });
    expect(sel(s)).toEqual(["b", "c", "d"]);
    // The anchor stays put: a second shift-click re-spans from it.
    s = click(s, order, "a", { range: true });
    expect(sel(s)).toEqual(["a", "b"]);
  });

  it("walks with the arrows, and extends with shift", () => {
    let s = move(EMPTY, order, 1);
    expect(s.cursor).toBe("a");
    s = move(s, order, 1);
    expect(sel(s)).toEqual(["b"]);
    s = move(s, order, 2, true);
    expect(sel(s)).toEqual(["b", "c", "d"]);
    s = move(s, order, 10);
    expect(s.cursor).toBe("e");
    s = edge(s, order, "start", true);
    expect(sel(s)).toEqual(order);
  });

  it("selects all, and keeps list order", () => {
    const s = selectAll(order);
    expect(ordered(click(click(EMPTY, order, "d"), order, "a", { toggle: true }), order)).toEqual(["a", "d"]);
    expect(s.selected.size).toBe(5);
  });

  it("forgets rows that went away", () => {
    const s = click(click(EMPTY, order, "b"), order, "c", { toggle: true });
    const p = prune(s, ["a", "c"]);
    expect(sel(p)).toEqual(["c"]);
    expect(p.anchor).toBe("c");
    expect(prune(p, ["a", "c"])).toBe(p);
  });
});
