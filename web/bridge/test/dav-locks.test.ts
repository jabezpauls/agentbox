import { describe, it, expect } from "vitest";
import { LockManager } from "../src/files/dav/locks.js";

const opts = (depth: "0" | "infinity", scope: "exclusive" | "shared" = "exclusive") => ({ depth, scope, owner: "", timeoutS: 60 });

describe("the lock table", () => {
  it("finds the locks covering a path by walking up it", () => {
    let t = 0;
    const locks = new LockManager(() => t);
    const deep = locks.acquire("/w/a", opts("infinity"));
    const shallow = locks.acquire("/w/b", opts("0"));
    const self = locks.acquire("/w/b/c", opts("0"));
    expect("lock" in deep && "lock" in shallow && "lock" in self).toBe(true);
    expect(locks.covering("/w/a/x/y").map((l) => l.path)).toEqual(["/w/a"]);
    // A depth-0 lock covers only its own path, not what is beneath it.
    expect(locks.covering("/w/b/c").map((l) => l.path)).toEqual(["/w/b/c"]);
    expect(locks.covering("/w/b/d")).toEqual([]);
    expect(locks.covering("/w/ab")).toEqual([]);
    expect(locks.beneath("/w/b").map((l) => l.path).sort()).toEqual(["/w/b", "/w/b/c"]);
    // Expiry is noticed on lookup.
    t = 61_000;
    expect(locks.covering("/w/a/x")).toEqual([]);
    expect(locks.size).toBeLessThan(3);
  });

  it("refuses conflicting locks and allows shared ones together", () => {
    const locks = new LockManager();
    expect("lock" in locks.acquire("/w/f", opts("0", "shared"))).toBe(true);
    expect("lock" in locks.acquire("/w/f", opts("0", "shared"))).toBe(true);
    expect("conflicts" in locks.acquire("/w/f", opts("0"))).toBe(true);
    // A depth-infinity lock above collides with one already held below.
    expect("conflicts" in locks.acquire("/w", opts("infinity"))).toBe(true);
  });

  it("stops at its ceiling, and frees room as locks expire or are released", () => {
    let t = 0;
    const locks = new LockManager(() => t, 3);
    const held = [locks.acquire("/w/1", opts("0")), locks.acquire("/w/2", opts("0")), locks.acquire("/w/3", opts("0"))];
    expect(locks.acquire("/w/4", opts("0"))).toEqual({ full: true });
    const first = held[0]!;
    if ("lock" in first) locks.release(first.lock.token);
    expect("lock" in locks.acquire("/w/4", opts("0"))).toBe(true);
    t = 61_000;
    expect("lock" in locks.acquire("/w/5", opts("0"))).toBe(true);
    expect(locks.size).toBe(1);
  });
});
