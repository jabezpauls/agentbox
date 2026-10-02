import { describe, expect, it } from "vitest";
import { thumb, WheelLines } from "./wheel.ts";

const PX = 0;
const LINE = 1;
const PAGE = 2;

describe("WheelLines", () => {
  it("turns a mouse notch in pixels into whole lines by the row height", () => {
    const w = new WheelLines();
    expect(w.take({ deltaY: -100, deltaMode: PX }, 20, 24)).toEqual({ direction: "up", lines: 5 });
    expect(w.take({ deltaY: 60, deltaMode: PX }, 20, 24)).toEqual({ direction: "down", lines: 3 });
  });

  it("takes line and page deltas as they are", () => {
    const w = new WheelLines();
    expect(w.take({ deltaY: 3, deltaMode: LINE }, 20, 24)).toEqual({ direction: "down", lines: 3 });
    expect(w.take({ deltaY: -1, deltaMode: PAGE }, 20, 24)).toEqual({ direction: "up", lines: 24 });
  });

  it("adds up a trackpad's fractions instead of rounding each one", () => {
    const w = new WheelLines();
    const got = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4].map((d) => w.take({ deltaY: d, deltaMode: PX }, 20, 24));
    // 40px of 20px rows is two lines, sent as each one completes.
    expect(got.filter(Boolean)).toEqual([
      { direction: "down", lines: 1 },
      { direction: "down", lines: 1 },
    ]);
  });

  it("drops the carry when the direction changes", () => {
    const w = new WheelLines();
    expect(w.take({ deltaY: 15, deltaMode: PX }, 20, 24)).toBeNull();
    expect(w.take({ deltaY: -15, deltaMode: PX }, 20, 24)).toBeNull();
    expect(w.take({ deltaY: -5, deltaMode: PX }, 20, 24)).toEqual({ direction: "up", lines: 1 });
  });

  it("ignores a horizontal-only or empty event", () => {
    const w = new WheelLines();
    expect(w.take({ deltaY: 0, deltaMode: PX }, 20, 24)).toBeNull();
    expect(w.take({ deltaY: NaN, deltaMode: PX }, 20, 24)).toBeNull();
  });
});

describe("thumb", () => {
  it("sits at the bottom when live and at the top when scrolled all the way", () => {
    expect(thumb(0, 76, 24)).toEqual({ top: 0.76, height: 0.24 });
    expect(thumb(76, 76, 24)).toEqual({ top: 0, height: 0.24 });
  });

  it("is absent with no history", () => {
    expect(thumb(0, 0, 24)).toBeNull();
  });
});
