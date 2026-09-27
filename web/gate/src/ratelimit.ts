/**
 * Rate limits and lockout for anything that costs a bcrypt comparison.
 *
 * Checked *before* the comparison, so a flood of guesses never becomes a flood
 * of bcrypt work: a refused attempt costs a map lookup. The limits, per client
 * address unless stated:
 *
 * - 5 attempts in any 60 seconds;
 * - from the 5th consecutive failure on, each further attempt waits 1 s, 2 s,
 *   4 s, … (doubling) after the previous failure;
 * - 10 consecutive failures lock the address out for 15 minutes;
 * - across all addresses, 30 attempts in any 60 seconds.
 *
 * A success clears the address's failures. State is in memory: a restart
 * forgives everyone, which only the operator can cause.
 */

export interface LoginLimits {
  windowMs: number;
  perWindow: number;
  backoffAfter: number;
  backoffBaseMs: number;
  lockAfter: number;
  lockMs: number;
  globalPerWindow: number;
}

export const LOGIN_LIMITS: LoginLimits = {
  windowMs: 60_000,
  perWindow: 5,
  backoffAfter: 5,
  backoffBaseMs: 1_000,
  lockAfter: 10,
  lockMs: 15 * 60_000,
  globalPerWindow: 30,
};

export type Refusal = { reason: "rate" | "locked" | "busy"; retryAfterMs: number };

interface Entry {
  attempts: number[];
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

/** Past this many tracked addresses, the quiet ones are forgotten first. */
const MAX_ENTRIES = 10_000;

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  private global: number[] = [];

  constructor(
    private readonly limits: LoginLimits = LOGIN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reserve an attempt for `ip`, or say why not and for how long. A reserved
   * attempt must be followed by `failure` or `success`.
   */
  attempt(ip: string): Refusal | null {
    const t = this.now();
    const { windowMs, perWindow, backoffAfter, backoffBaseMs, globalPerWindow } = this.limits;
    const e = this.entry(ip, t);

    if (e.lockedUntil > t) return { reason: "locked", retryAfterMs: e.lockedUntil - t };
    if (e.failures >= backoffAfter) {
      const wait = backoffBaseMs * 2 ** (e.failures - backoffAfter);
      const until = e.lastFailureAt + wait;
      if (until > t) return { reason: "rate", retryAfterMs: until - t };
    }
    if (e.attempts.length >= perWindow) {
      return { reason: "rate", retryAfterMs: (e.attempts[0] as number) + windowMs - t };
    }
    this.global = this.global.filter((a) => a > t - windowMs);
    if (this.global.length >= globalPerWindow) {
      return { reason: "busy", retryAfterMs: (this.global[0] as number) + windowMs - t };
    }
    e.attempts.push(t);
    this.global.push(t);
    return null;
  }

  failure(ip: string): void {
    const t = this.now();
    const e = this.entry(ip, t);
    e.failures += 1;
    e.lastFailureAt = t;
    if (e.failures >= this.limits.lockAfter) {
      e.lockedUntil = t + this.limits.lockMs;
      // The lock is the penalty; once served, the count starts over.
      e.failures = 0;
    }
  }

  success(ip: string): void {
    const e = this.entries.get(ip);
    if (!e) return;
    e.failures = 0;
    e.lastFailureAt = 0;
  }

  /** Forget every lock and count (the admin command, and tests). */
  reset(): void {
    this.entries.clear();
    this.global = [];
  }

  private entry(ip: string, t: number): Entry {
    let e = this.entries.get(ip);
    if (!e) {
      if (this.entries.size >= MAX_ENTRIES) this.prune(t);
      e = { attempts: [], failures: 0, lastFailureAt: 0, lockedUntil: 0 };
      this.entries.set(ip, e);
    }
    e.attempts = e.attempts.filter((a) => a > t - this.limits.windowMs);
    return e;
  }

  private prune(t: number): void {
    for (const [ip, e] of this.entries) {
      const idle = e.lockedUntil <= t && e.attempts.every((a) => a <= t - this.limits.windowMs);
      if (idle) this.entries.delete(ip);
    }
    // Still full: an address flood. Drop the oldest-inserted to stay bounded;
    // the global ceiling still holds while they are forgotten.
    for (const ip of this.entries.keys()) {
      if (this.entries.size < MAX_ENTRIES) break;
      this.entries.delete(ip);
    }
  }
}

/**
 * A plain sliding-window counter, for unauthenticated routes that cost no
 * bcrypt but must not be free (starting a device login, polling one, and in
 * Phase C unknown app ids).
 */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a hit for `key`; returns how long to wait when over the limit, else `null`. */
  take(key: string, cost = 1): number | null {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((h) => h > t - this.windowMs);
    if (list.length + cost > this.limit) {
      this.hits.set(key, list);
      return (list[0] ?? t) + this.windowMs - t;
    }
    for (let i = 0; i < cost; i++) list.push(t);
    if (!this.hits.has(key) && this.hits.size >= MAX_ENTRIES) this.prune(t);
    this.hits.set(key, list);
    return null;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((h) => h <= t - this.windowMs)) this.hits.delete(k);
    }
    for (const k of this.hits.keys()) {
      if (this.hits.size < MAX_ENTRIES) break;
      this.hits.delete(k);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
