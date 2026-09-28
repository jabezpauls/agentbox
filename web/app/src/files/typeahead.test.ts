import { describe, expect, it } from "vitest";
import { GoSequence } from "../shell/keys.ts";
import { stepTypeAhead, type TypeAhead } from "./typeahead.ts";

/** The list and the shell side by side, the way a keystroke reaches both. */
function keyboard() {
  let now = 1000;
  const t: TypeAhead = { text: "", at: 0 };
  const go = new GoSequence(1500, () => now);
  const moved: string[] = [];
  const queries: string[] = [];
  const press = (key: string, gap = 100) => {
    now += gap;
    const step = stepTypeAhead(t, key, now, (k) => go.takes(k));
    let prevented = false;
    if (step.kind === "jump") {
      queries.push(step.query);
      if (!step.share) {
        prevented = true;
        go.reset();
      }
    }
    // The window's handler skips a key the list took.
    if (!prevented && key !== "?") {
      const r = go.feed(key);
      if (r.surface) moved.push(r.surface);
    }
  };
  return { press, moved, queries };
}

describe("type to jump beside the shell's keys", () => {
  it("leaves g then a surface letter to the shell", () => {
    const k = keyboard();
    k.press("g", 2000);
    k.press("h");
    expect(k.moved).toEqual(["home"]);
  });

  it("never takes ?", () => {
    const t: TypeAhead = { text: "", at: 0 };
    expect(stepTypeAhead(t, "?", 1, () => false)).toEqual({ kind: "pass" });
  });

  it("still finds names starting with g", () => {
    const k = keyboard();
    k.press("g", 2000);
    k.press("i");
    k.press("t");
    expect(k.queries).toEqual(["g", "gi", "git"]);
    expect(k.moved).toEqual([]);
    // And the shell is not left armed by the g.
    k.press("h", 800);
    expect(k.moved).toEqual([]);
  });

  it("treats g inside a run as a letter", () => {
    const k = keyboard();
    k.press("l", 2000);
    k.press("o");
    k.press("g");
    k.press("s");
    expect(k.queries).toEqual(["l", "lo", "log", "logs"]);
    expect(k.moved).toEqual([]);
  });
});
