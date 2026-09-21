import { describe, expect, it } from "vitest";
import { PrefixMachine } from "./prefix.ts";
import type { ActionId } from "./actions.ts";

const bindings: Record<string, ActionId> = {
  c: "tab.new",
  v: "pane.splitRight",
};

describe("PrefixMachine", () => {
  it("does not consume keys until the prefix arms it", () => {
    const m = new PrefixMachine("ctrl+b", bindings);
    expect(m.feed("x")).toEqual({ consumed: false });
    expect(m.armed).toBe(false);
  });

  it("arms on the prefix and resolves the next key to an action", () => {
    const m = new PrefixMachine("ctrl+b", bindings);
    expect(m.feed("ctrl+b")).toEqual({ consumed: true });
    expect(m.armed).toBe(true);
    expect(m.feed("c")).toEqual({ consumed: true, action: "tab.new" });
    expect(m.armed).toBe(false);
  });

  it("sends a literal control byte when the prefix is pressed twice", () => {
    const m = new PrefixMachine("ctrl+b", bindings);
    m.feed("ctrl+b");
    expect(m.feed("ctrl+b")).toEqual({ consumed: true, passthrough: "\x02" });
    expect(m.armed).toBe(false);
  });

  it("consumes an unknown key while armed but yields no action", () => {
    const m = new PrefixMachine("ctrl+b", bindings);
    m.feed("ctrl+b");
    expect(m.feed("y")).toEqual({ consumed: true });
    expect(m.armed).toBe(false);
  });

  it("disarms after the timeout elapses", () => {
    let now = 1000;
    const m = new PrefixMachine("ctrl+b", bindings, 3000, () => now);
    m.feed("ctrl+b");
    expect(m.armed).toBe(true);
    now += 3001;
    // The stale arming has expired: this key is processed as if unarmed.
    expect(m.feed("c")).toEqual({ consumed: false });
    expect(m.armed).toBe(false);
  });
});
