import { describe, it, expect } from "vitest";
import { Backoff } from "../src/herdr/supervisor.js";

describe("Backoff", () => {
  it("starts at the floor and doubles toward the cap", () => {
    const b = new Backoff(1000, 30_000);
    expect(b.value).toBe(1000);
    b.grow();
    expect(b.value).toBe(2000);
    b.grow();
    expect(b.value).toBe(4000);
  });

  it("never exceeds the cap however many crashes accumulate", () => {
    const b = new Backoff(1000, 30_000);
    for (let i = 0; i < 20; i++) b.grow();
    expect(b.value).toBe(30_000);
  });

  it("resets to the floor once a run is judged healthy", () => {
    const b = new Backoff(1000, 30_000);
    for (let i = 0; i < 10; i++) b.grow();
    expect(b.value).toBe(30_000);
    // This is what the supervisor's stability timer calls after a stable run, so
    // a later isolated crash restarts promptly instead of at the capped delay.
    b.reset();
    expect(b.value).toBe(1000);
  });
});
