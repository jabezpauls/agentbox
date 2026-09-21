import { describe, expect, it } from "vitest";
import { searchItems, type PaletteItem } from "./search.ts";

function item(id: string, label: string): PaletteItem {
  return { id, kind: "action", label, run: () => {} };
}

describe("searchItems", () => {
  it("matches by subsequence, case-insensitively", () => {
    const items = [item("a", "workspace: api"), item("b", "close pane"), item("c", "new tab")];
    const out = searchItems("wsp", items);
    expect(out.map((i) => i.id)).toContain("a");
    expect(out.map((i) => i.id)).not.toContain("c");
  });

  it("ranks an exact prefix above a scattered match", () => {
    const items = [item("scattered", "w-o-r place"), item("prefix", "workspace")];
    const out = searchItems("wor", items);
    expect(out[0]?.id).toBe("prefix");
  });

  it("returns items in their given order for an empty query", () => {
    const items = [item("1", "beta"), item("2", "alpha"), item("3", "gamma")];
    expect(searchItems("", items).map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(searchItems("   ", items).map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("drops items that do not contain the subsequence", () => {
    const items = [item("a", "alpha"), item("b", "beta")];
    expect(searchItems("zzz", items)).toEqual([]);
  });
});
