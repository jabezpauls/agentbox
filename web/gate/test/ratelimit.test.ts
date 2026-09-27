import { describe, expect, it } from "vitest";
import { LOGIN_LIMITS, LoginLimiter, WindowLimiter } from "../src/ratelimit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the sign-in limiter, with the production numbers", () => {
  it("allows five attempts a minute from one address, then refuses until the window moves", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    for (let i = 0; i < 5; i++) {
      expect(l.attempt("1.1.1.1")).toBeNull();
      l.success("1.1.1.1");
      c.advance(1_000);
    }
    const refused = l.attempt("1.1.1.1");
    expect(refused).toEqual({ reason: "rate", retryAfterMs: 55_000 });
    // Another address is unaffected.
    expect(l.attempt("2.2.2.2")).toBeNull();
    c.advance(55_000);
    expect(l.attempt("1.1.1.1")).toBeNull();
  });

  it("backs off exponentially from the fifth consecutive failure", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    for (let i = 0; i < 5; i++) {
      expect(l.attempt("ip")).toBeNull();
      l.failure("ip");
    }
    // Five failures inside a minute: the window is full as well, so move past it.
    c.advance(60_000);
    expect(l.attempt("ip")).toBeNull();
    l.failure("ip"); // sixth failure: the next attempt waits 2 s
    expect(l.attempt("ip")).toEqual({ reason: "rate", retryAfterMs: 2_000 });
    c.advance(2_000);
    expect(l.attempt("ip")).toBeNull();
    l.failure("ip"); // seventh: 4 s
    expect(l.attempt("ip")?.retryAfterMs).toBe(4_000);
  });

  it("locks an address out for 15 minutes after 10 consecutive failures, correct password or not", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    let failures = 0;
    while (failures < 10) {
      const r = l.attempt("ip");
      if (r) {
        c.advance(r.retryAfterMs);
        continue;
      }
      l.failure("ip");
      failures++;
    }
    const locked = l.attempt("ip");
    expect(locked?.reason).toBe("locked");
    expect(locked?.retryAfterMs).toBe(15 * 60_000);
    c.advance(15 * 60_000 - 1);
    expect(l.attempt("ip")?.reason).toBe("locked");
    c.advance(1);
    expect(l.attempt("ip")).toBeNull();
  });

  it("forgives failures on a success", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    for (let i = 0; i < 4; i++) {
      l.attempt("ip");
      l.failure("ip");
    }
    l.attempt("ip");
    l.success("ip");
    c.advance(60_000);
    for (let i = 0; i < 5; i++) {
      expect(l.attempt("ip")).toBeNull();
      l.failure("ip");
    }
    c.advance(60_000);
    expect(l.attempt("ip")).toBeNull();
    l.failure("ip");
    // Six failures since the success, not ten: backing off, not locked.
    expect(l.attempt("ip")).toEqual({ reason: "rate", retryAfterMs: 2_000 });
  });

  it("holds a global ceiling of 30 attempts a minute across addresses", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    for (let i = 0; i < 30; i++) expect(l.attempt(`10.0.0.${i}`)).toBeNull();
    const r = l.attempt("10.0.1.1");
    expect(r?.reason).toBe("busy");
    c.advance(60_000);
    expect(l.attempt("10.0.1.1")).toBeNull();
  });

  it("does not count a refused attempt against the global ceiling", () => {
    const c = clock();
    const l = new LoginLimiter(LOGIN_LIMITS, c.now);
    for (let i = 0; i < 100; i++) l.attempt("flood");
    expect(l.attempt("owner")).toBeNull();
  });
});

describe("the window limiter", () => {
  it("counts hits per key in a sliding window", () => {
    const c = clock();
    const w = new WindowLimiter(3, 10_000, c.now);
    expect(w.take("a")).toBeNull();
    expect(w.take("a")).toBeNull();
    expect(w.take("a")).toBeNull();
    expect(w.take("a")).toBe(10_000);
    expect(w.take("b")).toBeNull();
    c.advance(10_000);
    expect(w.take("a")).toBeNull();
  });
});
