import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, MAX_ATTEMPTS, ReconnectPolicy, backoffDelay } from "./stream.ts";

describe("backoffDelay", () => {
  it("doubles from the base on each successive attempt", () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(4)).toBe(4000);
  });

  it("caps the delay so a long outage still retries at a steady beat", () => {
    expect(backoffDelay(20)).toBe(BACKOFF_MAX_MS);
  });

  it("treats a zeroth attempt as the first rather than halving the base", () => {
    expect(backoffDelay(0)).toBe(500);
  });
});

describe("ReconnectPolicy", () => {
  it("hands out increasing delays while it keeps failing", () => {
    const p = new ReconnectPolicy();
    expect(p.next()).toBe(500);
    expect(p.next()).toBe(1000);
    expect(p.next()).toBe(2000);
  });

  it("gives up after the attempt budget so the cell can offer a manual retry", () => {
    const p = new ReconnectPolicy();
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(p.next()).not.toBeNull();
    expect(p.next()).toBeNull();
  });

  it("starts over after a successful open, so a later blip retries quickly", () => {
    const p = new ReconnectPolicy();
    p.next();
    p.next();
    p.reset();
    expect(p.next()).toBe(500);
  });

  it("recovers its full budget after a reset", () => {
    const p = new ReconnectPolicy();
    for (let i = 0; i <= MAX_ATTEMPTS; i++) p.next();
    expect(p.next()).toBeNull();
    p.reset();
    expect(p.next()).toBe(500);
  });
});
