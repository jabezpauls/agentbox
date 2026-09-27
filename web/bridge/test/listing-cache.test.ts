import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ListingCache } from "../src/files/entries.js";
import { tmpBase } from "./helpers/files.js";

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(tmpBase(), "wb-listing-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

/** A directory of `n` files whose timestamp has long settled. */
function dir(name: string, n: number): string {
  const d = path.join(base, name);
  fs.mkdirSync(d);
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(d, past, past);
  return d;
}

function counting() {
  const readdir = vi.spyOn(fsp, "readdir");
  return (d: string) => readdir.mock.calls.filter((c) => String(c[0]) === d).length;
}

describe("the listing cache", () => {
  it("keeps a settled directory's names for the next read", async () => {
    const cache = new ListingCache();
    const d = dir("settled", 3);
    const reads = counting();
    await cache.names(d, "/settled");
    expect((await cache.names(d, "/settled")).map((n) => n.name)).toEqual(["f0", "f1", "f2"]);
    expect(reads(d)).toBe(1);
  });

  it("never keeps a directory changed within the clock's tick, since a second change may leave its stamp alone", async () => {
    const cache = new ListingCache();
    const d = dir("fresh", 3);
    fs.writeFileSync(path.join(d, "new"), "");
    const reads = counting();
    await cache.names(d, "/fresh");
    await cache.names(d, "/fresh");
    expect(reads(d)).toBe(2);
    expect(cache.size).toEqual({ dirs: 0, names: 0 });
    // Nor one whose timestamp is in the future.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(d, future, future);
    await cache.names(d, "/fresh");
    expect(cache.size.dirs).toBe(0);
  });

  it("drops what has expired, whether or not it is asked for again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = new ListingCache({ ttlMs: 5000 });
    const a = dir("a", 2);
    const b = dir("b", 3);
    await cache.names(a, "/a");
    expect(cache.size).toEqual({ dirs: 1, names: 2 });
    vi.setSystemTime(Date.now() + 6000);
    // Reading another directory is enough to let the old listing go.
    await cache.names(b, "/b");
    expect(cache.size).toEqual({ dirs: 1, names: 3 });
    const reads = counting();
    await cache.names(a, "/a");
    expect(reads(a)).toBe(1);
  });

  it("holds at most so many names between all its directories, least recently used out first", async () => {
    const cache = new ListingCache({ maxNames: 10 });
    const a = dir("a", 4);
    const b = dir("b", 4);
    const c = dir("c", 4);
    await cache.names(a, "/a");
    await cache.names(b, "/b");
    await cache.names(a, "/a"); // a is now the more recently used
    await cache.names(c, "/c");
    expect(cache.size).toEqual({ dirs: 2, names: 8 });
    const reads = counting();
    await cache.names(a, "/a");
    await cache.names(c, "/c");
    expect(reads(a) + reads(c)).toBe(0);
    await cache.names(b, "/b");
    expect(reads(b)).toBe(1);
  });

  it("does not keep a directory bigger than its whole allowance", async () => {
    const cache = new ListingCache({ maxNames: 10 });
    const small = dir("small", 2);
    const huge = dir("huge", 11);
    await cache.names(small, "/small");
    expect((await cache.names(huge, "/huge")).length).toBe(11);
    expect(cache.size).toEqual({ dirs: 1, names: 2 });
  });

  it("holds at most so many directories", async () => {
    const cache = new ListingCache({ maxDirs: 2 });
    for (const n of ["a", "b", "c"]) await cache.names(dir(n, 1), `/${n}`);
    expect(cache.size).toEqual({ dirs: 2, names: 2 });
  });
});
