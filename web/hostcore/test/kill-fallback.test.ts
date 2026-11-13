import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { killWithFallback, type Killable } from "../src/herdr/terminal.js";

/** A child that records the signals it was sent and never claims to exit. */
function fakeChild(): Killable & { signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    killed: false,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      this.killed = true;
      return true;
    },
  };
}

describe("killWithFallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends SIGTERM immediately and SIGKILL after the grace when the child ignores it", () => {
    const child = fakeChild();
    killWithFallback(child, () => false, 2000);
    expect(child.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(2000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not escalate to SIGKILL when the child has exited within the grace", () => {
    const child = fakeChild();
    let exited = false;
    killWithFallback(child, () => exited, 2000);
    expect(child.signals).toEqual(["SIGTERM"]);
    exited = true;
    vi.advanceTimersByTime(2000);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("does nothing at all when the child has already exited", () => {
    const child = fakeChild();
    const timer = killWithFallback(child, () => true, 2000);
    expect(child.signals).toEqual([]);
    expect(timer).toBeNull();
  });

  it("does not re-send SIGTERM to a child already signalled", () => {
    const child = fakeChild();
    child.killed = true;
    killWithFallback(child, () => false, 2000);
    // Already signalled: skip the redundant SIGTERM, but still arm the SIGKILL.
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(child.signals).toEqual(["SIGKILL"]);
  });
});
